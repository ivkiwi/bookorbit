import { Injectable, Logger } from '@nestjs/common';
import { constants } from 'fs';
import { access, readdir } from 'fs/promises';
import { basename, join, relative } from 'path';
import * as unzipper from 'unzipper';

import { listZipEntries, zipMemberPath, type ZipEntryInfo } from '../../common/archive/zip-member';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { MetadataService } from '../metadata/metadata.service';
import { classifyFile } from './lib/classify';
import { archiveNameForInp, parseInpLine, parseInpxStructure, type InpRecord } from './lib/inpx';
import { ScannerRepository } from './scanner.repository';

export interface InpxImportInput {
  libraryId: number;
  libraryFolderId: number;
  folderPath: string;
  indexPath: string;
  useIndexDates: boolean;
  onTotal: (rows: number) => void;
  onProgress: () => void;
}

export interface InpxImportCounts {
  addedCount: number;
  updatedCount: number;
  missingCount: number;
}

function inpLines(bytes: Buffer): string[] {
  return bytes
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

/**
 * Imports a library folder laid out like a Flibusta/MyHomeLib collection: ZIP archives of FB2 books
 * plus one .inpx index. Books stay inside their archives; the catalog points at "<zip>/<entry>" and
 * takes its metadata from the index, so nothing is unpacked and no book is read during import.
 */
@Injectable()
export class InpxImportService {
  private readonly logger = new Logger(InpxImportService.name);

  constructor(
    private readonly scannerRepo: ScannerRepository,
    private readonly metadataService: MetadataService,
  ) {}

  async findIndex(folderPath: string): Promise<string | null> {
    const names = await readdir(folderPath).catch(() => [] as string[]);
    const indexes = names.filter((name) => name.toLowerCase().endsWith('.inpx'));
    if (indexes.length > 1) throw new Error(`Library folder holds more than one .inpx index: ${indexes.join(', ')}`);
    return indexes.length === 1 ? join(folderPath, indexes[0]) : null;
  }

  async importFolder(input: InpxImportInput): Promise<InpxImportCounts> {
    const event = 'scanner.inpx_import';
    const startedAt = Date.now();
    const { libraryId, libraryFolderId, folderPath, indexPath } = input;
    this.logger.log(
      `[${event}] [start] libraryId=${libraryId} libraryFolderId=${libraryFolderId} index="${sanitizeLogValue(indexPath)}" - inpx import started`,
    );

    // The archives are the only copy of the books. Refusing a writable mount keeps every rename,
    // delete or cleanup path in the app from ever reaching them.
    if (
      await access(folderPath, constants.W_OK).then(
        () => true,
        () => false,
      )
    ) {
      throw new Error(`Archive library folder must be mounted read-only: ${folderPath}`);
    }

    const index = await unzipper.Open.file(indexPath);
    const structure = index.files.find((file) => file.path.toLowerCase() === 'structure.info');
    const fields = parseInpxStructure(structure ? (await structure.buffer()).toString('utf8') : null);
    const inps = index.files
      .filter((file) => file.type === 'File' && file.path.toLowerCase().endsWith('.inp'))
      .sort((a, b) => a.path.localeCompare(b.path));

    let total = 0;
    for (const inp of inps) total += inpLines(await inp.buffer()).length;
    input.onTotal(total);

    const counts: InpxImportCounts = { addedCount: 0, updatedCount: 0, missingCount: 0 };
    for (const inp of inps) {
      const zipPath = join(folderPath, archiveNameForInp(basename(inp.path)));
      const lines = inpLines(await inp.buffer());
      const entries = await listZipEntries(zipPath).catch((err: Error) => {
        this.logger.warn(
          `[${event}] [fail] libraryId=${libraryId} archive="${sanitizeLogValue(zipPath)}" errorClass=${err.name} error="${sanitizeLogValue(err.message)}" - archive skipped`,
        );
        return null;
      });
      if (!entries) {
        for (let i = 0; i < lines.length; i++) input.onProgress();
        continue;
      }
      await this.importArchive(input, zipPath, lines, fields, entries, counts);
    }

    // shortcut: books of an archive that vanished from the index entirely are left as they are; add a sweep if indexes ever drop archives.
    this.logger.log(
      `[${event}] [end] libraryId=${libraryId} libraryFolderId=${libraryFolderId} durationMs=${Date.now() - startedAt} archives=${inps.length} rows=${total} addedCount=${counts.addedCount} updatedCount=${counts.updatedCount} missingCount=${counts.missingCount} - inpx import completed`,
    );
    return counts;
  }

  private async importArchive(
    input: InpxImportInput,
    zipPath: string,
    lines: string[],
    fields: string[],
    entries: Map<string, ZipEntryInfo>,
    counts: InpxImportCounts,
  ): Promise<void> {
    const known = new Map((await this.scannerRepo.findArchiveBookFiles(input.libraryFolderId, zipPath)).map((file) => [file.absolutePath, file]));
    const seen = new Set<string>();
    const restored: number[] = [];

    for (const line of lines) {
      input.onProgress();
      const record = parseInpLine(line, fields);
      // Rows the library marked deleted stay out of the catalog, and the index never invents a book its archive lacks.
      if (!record || record.deleted) continue;
      const entry = entries.get(record.entryName);
      if (!entry) continue;

      const path = zipMemberPath(zipPath, record.entryName);
      seen.add(path);
      const existing = known.get(path);
      if (existing?.status === 'missing') restored.push(existing.bookId);
      if (existing && existing.status !== 'processing') continue;

      try {
        await this.saveBook(input, path, record, entry, existing?.bookId);
        if (!existing) counts.addedCount++;
      } catch (err) {
        this.logger.warn(
          `[scanner.inpx_import_book] [fail] libraryId=${input.libraryId} path="${sanitizeLogValue(path)}" errorClass=${err instanceof Error ? err.name : 'Error'} error="${sanitizeLogValue(err instanceof Error ? err.message : String(err))}" - archive book import failed`,
        );
      }
    }

    await this.scannerRepo.markBooksAsPresent(restored);
    counts.updatedCount += restored.length;

    const gone = [...known.values()].filter((file) => !seen.has(file.absolutePath) && file.status !== 'missing').map((file) => file.bookId);
    await this.scannerRepo.markBooksAsMissing(gone);
    counts.missingCount += gone.length;
  }

  /** Creates the book, or finishes one an interrupted import left in processing. */
  private async saveBook(input: InpxImportInput, path: string, record: InpRecord, entry: ZipEntryInfo, unfinishedBookId?: number): Promise<void> {
    const { format } = classifyFile(path);
    let bookId: number;
    if (unfinishedBookId !== undefined) {
      bookId = unfinishedBookId;
    } else {
      const book = await this.scannerRepo.createBook({
        libraryId: input.libraryId,
        libraryFolderId: input.libraryFolderId,
        folderPath: path,
        status: 'processing',
        addedAt: input.useIndexDates ? record.addedDate : undefined,
      });
      const file = await this.scannerRepo.createBookFile({
        bookId: book.id,
        libraryFolderId: input.libraryFolderId,
        absolutePath: path,
        relPath: relative(input.folderPath, path),
        ino: 0n,
        sizeBytes: entry.size,
        mtime: entry.mtime,
        fileHash: null,
        format,
        role: 'content',
        sortOrder: 0,
      });
      await this.scannerRepo.updateBookPrimaryFile(book.id, file.id);
      bookId = book.id;
    }
    await this.metadataService.saveParsedMetadata(bookId, record.data, format ?? 'fb2');
    await this.scannerRepo.promoteProcessingBookToPresent(bookId);
  }
}
