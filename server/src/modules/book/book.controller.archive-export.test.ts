import { ZipArchive } from 'archiver';
import { createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import * as unzipper from 'unzipper';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { zipMemberPath } from '../../common/archive/zip-member';
import type { RequestUser } from '../../common/types/request-user';
import { BookController } from './book.controller';

const book = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><FictionBook>Архив</FictionBook>'.repeat(500));

function exportReply() {
  const raw = Object.assign(new PassThrough(), { setHeader: vi.fn() });
  const chunks: Buffer[] = [];
  raw.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { reply: { raw } as never, body: () => Buffer.concat(chunks) };
}

function controllerExporting(files: { absolutePath: string; zipPath: string }[]) {
  const bookService = {
    acquireExportSlot: vi.fn().mockReturnValue(vi.fn()),
    getExportFiles: vi
      .fn()
      .mockResolvedValue({ files: files.map((file) => ({ ...file, sizeBytes: 1 })), projectedBytes: 1, bookCount: 1, scope: 'primary' }),
  };
  return new BookController(bookService as never, {} as never);
}

describe('BookController export of archive books', () => {
  let dir: string;
  let zipPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archive-export-'));
    zipPath = join(dir, 'f.fb2-000001-000002.zip');
    const archive = new ZipArchive();
    const done = new Promise<void>((resolve) => {
      const out = createWriteStream(zipPath);
      out.on('close', () => resolve());
      archive.pipe(out);
    });
    archive.append(book, { name: '1.fb2' });
    await archive.finalize();
    await done;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams the archive entry bytes into the export', async () => {
    const { reply, body } = exportReply();
    await controllerExporting([{ absolutePath: zipMemberPath(zipPath, '1.fb2'), zipPath: 'Book.fb2' }]).exportBooks(
      { bookIds: [1], allFormats: false } as never,
      { id: 1 } as RequestUser,
      reply,
    );

    const exported = await unzipper.Open.buffer(body());
    expect(await exported.files.find((file) => file.path === 'Book.fb2')!.buffer()).toEqual(book);
  });

  it('fails the export on an unreadable archive entry without taking the process down', async () => {
    const { reply } = exportReply();
    await expect(
      controllerExporting([{ absolutePath: zipMemberPath(zipPath, '9.fb2'), zipPath: 'Gone.fb2' }]).exportBooks(
        { bookIds: [1], allFormats: false } as never,
        { id: 1 } as RequestUser,
        reply,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
