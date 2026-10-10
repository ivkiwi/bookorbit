import { ZipArchive } from 'archiver';
import { createWriteStream } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as unzipper from 'unzipper';

import { lazyBookFileStream, listZipEntries, openBookFileStream, parseZipMemberPath, readBookFile, statBookFile, zipMemberPath } from './zip-member';

const cp1251Book = Buffer.concat([
  Buffer.from('<?xml version="1.0" encoding="windows-1251"?><FictionBook>'),
  Buffer.from([0xc0, 0xe1, 0xe2]),
  Buffer.from('</FictionBook>'),
]);
const utf8Book = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><FictionBook>Книга</FictionBook>'.repeat(200));

async function writeZip(path: string, entries: Record<string, Buffer>, options: { comment?: string; store?: boolean } = {}): Promise<void> {
  const archive = new ZipArchive({ comment: options.comment });
  const done = new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path);
    out.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(out);
  });
  for (const [name, bytes] of Object.entries(entries)) archive.append(bytes, { name, store: options.store });
  await archive.finalize();
  await done;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('zip-member', () => {
  let dir: string;
  let zipA: string;
  let zipB: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zip-member-'));
    zipA = join(dir, 'f.fb2-000001-000002.zip');
    zipB = join(dir, 'f.fb2-000003-000004.zip');
    await writeZip(zipA, { '1.fb2': cp1251Book, '2.fb2': utf8Book });
    await writeZip(zipB, { '1.fb2': utf8Book });
    await mkdir(join(dir, 'real.zip'));
    await writeFile(join(dir, 'real.zip', 'loose.fb2'), 'loose');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('splits a member path at the first .zip segment', () => {
    expect(parseZipMemberPath('/a/b.ZIP/c/1.fb2')).toEqual({ zipPath: '/a/b.ZIP', entryName: 'c/1.fb2' });
    expect(parseZipMemberPath('/a/b.zip')).toBeNull();
    expect(parseZipMemberPath('/a/b.zip/')).toBeNull();
    expect(parseZipMemberPath('/a/zipped/1.fb2')).toBeNull();
  });

  it('reads exact entry bytes, keeping same-named entries of different archives apart', async () => {
    expect(await readBookFile(zipMemberPath(zipA, '1.fb2'))).toEqual(cp1251Book);
    expect(await readBookFile(zipMemberPath(zipB, '1.fb2'))).toEqual(utf8Book);
    expect(await collect(await openBookFileStream(zipMemberPath(zipA, '2.fb2')))).toEqual(utf8Book);
  });

  it('reports the uncompressed entry size', async () => {
    expect((await statBookFile(zipMemberPath(zipA, '2.fb2'))).size).toBe(utf8Book.length);
    expect([...(await listZipEntries(zipA)).keys()].sort()).toEqual(['1.fb2', '2.fb2']);
  });

  it('fails a missing entry as ENOENT', async () => {
    await expect(statBookFile(zipMemberPath(zipA, '9.fb2'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readBookFile(zipMemberPath(join(dir, 'gone.zip'), '1.fb2'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a real directory named like an archive as ordinary files', async () => {
    const path = join(dir, 'real.zip', 'loose.fb2');
    expect((await readBookFile(path)).toString()).toBe('loose');
    expect((await statBookFile(path)).inArchive).toBe(false);
    expect((await statBookFile(zipMemberPath(zipA, '1.fb2'))).inArchive).toBe(true);
  });

  it('opens archives that carry a long comment and stored entries', async () => {
    const commented = join(dir, 'commented.zip');
    await writeZip(commented, { '5.fb2': utf8Book }, { comment: 'c'.repeat(300) });
    expect(await readBookFile(zipMemberPath(commented, '5.fb2'))).toEqual(utf8Book);

    const stored = join(dir, 'stored.zip');
    await writeZip(stored, { '6.fb2': cp1251Book }, { store: true });
    expect(await readBookFile(zipMemberPath(stored, '6.fb2'))).toEqual(cp1251Book);
  });

  it('fails a damaged entry through the stream instead of returning wrong bytes', async () => {
    const damaged = join(dir, 'damaged.zip');
    const bytes = await readFile(zipA);
    const entry = (await unzipper.Open.file(zipA)).files.find((file) => file.path === '2.fb2')!;
    const dataStart =
      entry.offsetToLocalFileHeader +
      30 +
      bytes.readUInt16LE(entry.offsetToLocalFileHeader + 26) +
      bytes.readUInt16LE(entry.offsetToLocalFileHeader + 28);
    bytes[dataStart + Math.floor(entry.compressedSize / 2)] ^= 0xff;
    await writeFile(damaged, bytes);

    await expect(readBookFile(zipMemberPath(damaged, '2.fb2'))).rejects.toThrow();
    await expect(collect(await openBookFileStream(zipMemberPath(damaged, '2.fb2')))).rejects.toThrow();
  });

  it('releases a stream cancelled halfway and opens lazy streams on first read', async () => {
    const stream = await openBookFileStream(zipMemberPath(zipA, '2.fb2'));
    await new Promise<void>((resolve) => stream.once('data', () => resolve()));
    stream.destroy();
    await new Promise((resolve) => stream.once('close', resolve));

    expect(await collect(lazyBookFileStream(zipMemberPath(zipB, '1.fb2')))).toEqual(utf8Book);
  });
});
