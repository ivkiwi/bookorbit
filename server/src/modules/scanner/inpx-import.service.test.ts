import { ZipArchive } from 'archiver';
import { createWriteStream } from 'fs';
import { chmod, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ParsedBookData } from '../metadata/extractors/format-extractor.interface';
import { InpxImportService, type InpxImportInput } from './inpx-import.service';

async function writeZip(path: string, entries: Record<string, string>): Promise<void> {
  const archive = new ZipArchive();
  const done = new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path);
    out.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(out);
  });
  for (const [name, text] of Object.entries(entries)) archive.append(Buffer.from(text), { name });
  await archive.finalize();
  await done;
}

const inp = (rows: string[][]) => rows.map((row) => row.join('\x04')).join('\r\n') + '\r\n';
const row = (file: string, title: string, del = '0') => [
  'Толстой,Лев,Николаевич:',
  'prose_classic:',
  title,
  '',
  '0',
  file,
  '10',
  file,
  del,
  'fb2',
  '2024-01-02',
  'ru',
  '',
  '',
];

type Status = 'present' | 'missing' | 'processing';

class FakeScannerRepo {
  books = new Map<number, { status: Status; folderPath: string }>();
  files: { bookId: number; absolutePath: string; libraryFolderId: number }[] = [];
  private nextId = 1;

  createBook(data: { folderPath: string; status: Status }) {
    const id = this.nextId++;
    this.books.set(id, { status: data.status, folderPath: data.folderPath });
    return Promise.resolve({ id });
  }
  createBookFile(data: { bookId: number; absolutePath: string; libraryFolderId: number }) {
    this.files.push(data);
    return Promise.resolve({ id: this.files.length });
  }
  updateBookPrimaryFile() {
    return Promise.resolve();
  }
  promoteProcessingBookToPresent(bookId: number) {
    const book = this.books.get(bookId)!;
    if (book.status === 'processing') book.status = 'present';
    return Promise.resolve(true);
  }
  findArchiveBookFiles(libraryFolderId: number, zipPath: string) {
    return Promise.resolve(
      this.files
        .filter((file) => file.libraryFolderId === libraryFolderId && file.absolutePath.startsWith(`${zipPath}/`))
        .map((file) => ({ bookId: file.bookId, absolutePath: file.absolutePath, status: this.books.get(file.bookId)!.status })),
    );
  }
  markBooksAsPresent(ids: number[]) {
    for (const id of ids) this.books.get(id)!.status = 'present';
    return Promise.resolve();
  }
  markBooksAsMissing(ids: number[]) {
    for (const id of ids) this.books.get(id)!.status = 'missing';
    return Promise.resolve();
  }
  statusOf(path: string): Status | undefined {
    const file = this.files.find((candidate) => candidate.absolutePath === path);
    return file ? this.books.get(file.bookId)!.status : undefined;
  }
}

describe('InpxImportService', () => {
  let dir: string;
  let zipA: string;
  let zipB: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inpx-import-'));
    zipA = join(dir, 'f.fb2-000001-000009.zip');
    zipB = join(dir, 'f.fb2-000010-000020.zip');
    await writeZip(zipA, { '1.fb2': 'a1', '2.fb2': 'a2' });
    await writeZip(zipB, { '1.fb2': 'b1', '3.fb2': 'b3' });
    const index = new ZipArchive();
    const indexDone = new Promise<void>((resolve) => {
      const out = createWriteStream(join(dir, 'library.inpx'));
      out.on('close', () => resolve());
      index.pipe(out);
    });
    index.append(inp([row('1', 'Война и мир'), row('2', 'Удалённая', '1'), row('9', 'Нет в архиве')]), { name: 'f.fb2-000001-000009.inp' });
    index.append(inp([row('1', 'Анна Каренина'), row('3', 'Воскресение')]), { name: 'f.fb2-000010-000020.inp' });
    index.append('Collection\n', { name: 'collection.info' });
    await index.finalize();
    await indexDone;
  });

  afterAll(async () => {
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  });

  function setup() {
    const repo = new FakeScannerRepo();
    const saved = new Map<number, ParsedBookData>();
    const metadata = { saveParsedMetadata: (bookId: number, data: ParsedBookData) => Promise.resolve(void saved.set(bookId, data)) };
    const service = new InpxImportService(repo as never, metadata as never);
    let progress = 0;
    let total = 0;
    const input: InpxImportInput = {
      libraryId: 1,
      libraryFolderId: 7,
      folderPath: dir,
      indexPath: join(dir, 'library.inpx'),
      useIndexDates: false,
      onTotal: (rows) => (total = rows),
      onProgress: () => progress++,
    };
    return { repo, saved, service, input, progress: () => ({ progress, total }) };
  }

  it('refuses a writable archive folder', async () => {
    await chmod(dir, 0o755);
    const { service, input } = setup();
    await expect(service.importFolder(input)).rejects.toThrow(/read-only/);
  });

  it('imports live index rows as books pointing into their archives', async () => {
    await chmod(dir, 0o555);
    const { repo, saved, service, input, progress } = setup();

    expect(await service.findIndex(dir)).toBe(join(dir, 'library.inpx'));
    const counts = await service.importFolder(input);

    expect(counts).toEqual({ addedCount: 3, updatedCount: 0, missingCount: 0 });
    expect(repo.files.map((file) => file.absolutePath).sort()).toEqual([`${zipA}/1.fb2`, `${zipB}/1.fb2`, `${zipB}/3.fb2`]);
    expect([...repo.books.values()].every((book) => book.status === 'present')).toBe(true);
    expect([...saved.values()].map((data) => data.title).sort()).toEqual(['Анна Каренина', 'Война и мир', 'Воскресение']);
    expect(progress()).toEqual({ progress: 5, total: 5 });

    expect(await service.importFolder(input)).toEqual({ addedCount: 0, updatedCount: 0, missingCount: 0 });
    expect(repo.files).toHaveLength(3);
  });

  it('restores returning books and marks books gone from the index missing', async () => {
    await chmod(dir, 0o555);
    const { repo, service, input } = setup();
    await service.importFolder(input);
    await repo.markBooksAsMissing([repo.files.find((file) => file.absolutePath === `${zipA}/1.fb2`)!.bookId]);
    const stale = await repo.createBook({ folderPath: `${zipB}/7.fb2`, status: 'present' });
    await repo.createBookFile({ bookId: stale.id, absolutePath: `${zipB}/7.fb2`, libraryFolderId: 7 });

    expect(await service.importFolder(input)).toEqual({ addedCount: 0, updatedCount: 1, missingCount: 1 });
    expect(repo.statusOf(`${zipA}/1.fb2`)).toBe('present');
    expect(repo.statusOf(`${zipB}/7.fb2`)).toBe('missing');
  });
});
