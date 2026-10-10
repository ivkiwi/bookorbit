import { createReadStream, type Stats } from 'fs';
import { open, readFile, stat } from 'fs/promises';
import { PassThrough, pipeline, Readable, Transform } from 'stream';
import * as unzipper from 'unzipper';
import { crc32, createInflateRaw } from 'zlib';

// A book kept inside a ZIP is addressed as "<archive>.zip/<entry>". That path can never exist on disk
// (its parent is a file), so any filesystem write aimed at it fails instead of touching the archive.
const ZIP_MEMBER_PATTERN = /\.zip\//i;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const DIRECTORY_CACHE_SIZE = 32;
// End-of-central-directory record plus the longest comment a ZIP may carry.
const MAX_EOCD_TAIL = 22 + 0xffff;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_BYTES = 30;

export interface ZipMemberPath {
  zipPath: string;
  entryName: string;
}

export interface ZipEntryInfo {
  size: number;
  mtime: Date;
}

export interface BookFileInfo extends ZipEntryInfo {
  inArchive: boolean;
}

interface CachedDirectory {
  version: string;
  entries: Map<string, unzipper.File>;
}

interface ArchiveEntry {
  zipPath: string;
  entry: unzipper.File;
}

const directories = new Map<string, CachedDirectory>();
interface DirectorySource {
  size(): Promise<number>;
  stream(offset: number, length?: number): Readable;
}
// The installed unzipper exposes Open.custom, which its type definitions leave out.
const openCustom = (
  unzipper.Open as unknown as { custom(this: void, source: DirectorySource, options?: { tailSize?: number }): Promise<unzipper.CentralDirectory> }
).custom;

export function parseZipMemberPath(path: string): ZipMemberPath | null {
  const match = ZIP_MEMBER_PATTERN.exec(path);
  if (!match) return null;
  const entryName = path.slice(match.index + 5);
  return entryName ? { zipPath: path.slice(0, match.index + 4), entryName } : null;
}

export function zipMemberPath(zipPath: string, entryName: string): string {
  return `${zipPath}/${entryName}`;
}

async function openDirectory(zipPath: string, archive: Stats): Promise<CachedDirectory> {
  const version = `${archive.size}:${archive.mtimeMs}`;
  const cached = directories.get(zipPath);
  if (cached?.version === version) {
    directories.delete(zipPath);
    directories.set(zipPath, cached);
    return cached;
  }
  const directory = await readDirectory(zipPath, archive.size);
  const entries = new Map(directory.files.filter((file) => file.type === 'File').map((file) => [file.path, file]));
  const fresh = { version, entries };
  directories.set(zipPath, fresh);
  if (directories.size > DIRECTORY_CACHE_SIZE) directories.delete(directories.keys().next().value!);
  return fresh;
}

// unzipper does not pass on read errors of the streams it opens for the directory, so a disk error
// would escape as an uncaught exception. These streams end early instead and the cause is rethrown.
async function readDirectory(zipPath: string, size: number): Promise<unzipper.CentralDirectory> {
  let failure: Error | undefined;
  const source: DirectorySource = {
    size: () => Promise.resolve(size),
    stream: (offset, length) => {
      const out = new PassThrough();
      const raw = createReadStream(zipPath, { start: offset, end: length ? offset + length - 1 : undefined });
      raw.once('error', (err) => {
        failure ??= err;
        out.end();
      });
      return raw.pipe(out);
    },
  };
  try {
    // The default tail only finds an end record without a comment; widen it for archives that carry one.
    return await openCustom(source).catch(() => openCustom(source, { tailSize: Math.min(MAX_EOCD_TAIL, size) }));
  } catch (err) {
    throw failure ?? err;
  }
}

export async function listZipEntries(zipPath: string): Promise<Map<string, ZipEntryInfo>> {
  const { entries } = await openDirectory(zipPath, await stat(zipPath));
  return new Map([...entries].map(([name, file]) => [name, { size: file.uncompressedSize, mtime: file.lastModifiedDateTime }]));
}

function missingEntry(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such archive entry, '${path}'`), { code: 'ENOENT' });
}

/** Resolves the ZIP entry behind a member path, or null when the path is an ordinary file. */
async function findEntry(path: string): Promise<ArchiveEntry | null> {
  const member = parseZipMemberPath(path);
  if (!member) return null;
  const archive = await stat(member.zipPath).catch(() => null);
  if (!archive?.isFile()) return null;
  const entry = (await openDirectory(member.zipPath, archive)).entries.get(member.entryName);
  if (!entry) throw missingEntry(path);
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`Archive entry is larger than ${MAX_ENTRY_BYTES} bytes: ${path}`);
  return { zipPath: member.zipPath, entry };
}

async function entryDataStart({ zipPath, entry }: ArchiveEntry): Promise<number> {
  const handle = await open(zipPath, 'r');
  try {
    const header = Buffer.alloc(LOCAL_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, LOCAL_HEADER_BYTES, entry.offsetToLocalFileHeader);
    if (bytesRead !== LOCAL_HEADER_BYTES || header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE)
      throw new Error('Archive entry has no valid local header');
    return entry.offsetToLocalFileHeader + LOCAL_HEADER_BYTES + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
}

// The directory's size and CRC are claims; inflated bytes that disagree with them are a damaged entry.
function verifyEntry(entry: unzipper.File): Transform {
  let size = 0;
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      crc = crc32(chunk, crc);
      callback(size > entry.uncompressedSize ? new Error('Archive entry inflated past its declared size') : null, chunk);
    },
    flush(callback) {
      callback(size !== entry.uncompressedSize || crc !== entry.crc32 ? new Error('Archive entry is damaged') : null);
    },
  });
}

async function streamEntry(source: ArchiveEntry): Promise<Readable> {
  const { zipPath, entry } = source;
  if (entry.flags & 0x1) throw new Error('Archive entry is encrypted');
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
    throw new Error(`Unsupported archive compression method ${entry.compressionMethod}`);
  const start = await entryDataStart(source);
  const raw = entry.compressedSize > 0 ? createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 }) : Readable.from([]);
  const verified = verifyEntry(entry);
  // One pipeline owns every stage, so a read error reaches the consumer and a cancelled read closes the file.
  if (entry.compressionMethod === 8) pipeline(raw, createInflateRaw(), verified, () => undefined);
  else pipeline(raw, verified, () => undefined);
  return verified;
}

export async function statBookFile(path: string): Promise<BookFileInfo> {
  const source = await findEntry(path);
  if (source) return { size: source.entry.uncompressedSize, mtime: source.entry.lastModifiedDateTime, inArchive: true };
  const { size, mtime } = await stat(path);
  return { size, mtime, inArchive: false };
}

export async function readBookFile(path: string): Promise<Buffer> {
  const source = await findEntry(path);
  if (!source) return readFile(path);
  const chunks: Buffer[] = [];
  for await (const chunk of await streamEntry(source)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function openBookFileStream(path: string): Promise<Readable> {
  const source = await findEntry(path);
  return source ? streamEntry(source) : createReadStream(path);
}

/** A book stream that opens its file only when first read, for queues that hold many entries at once. */
export function lazyBookFileStream(path: string): Readable {
  return Readable.from(
    (async function* () {
      yield* await openBookFileStream(path);
    })(),
  );
}
