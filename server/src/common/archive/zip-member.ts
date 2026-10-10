import { createReadStream, type Stats } from 'fs';
import { readFile, stat } from 'fs/promises';
import { pipeline, Transform, type Readable } from 'stream';
import * as unzipper from 'unzipper';

// A book kept inside a ZIP is addressed as "<archive>.zip/<entry>". That path can never exist on disk
// (its parent is a file), so any filesystem write aimed at it fails instead of touching the archive.
const ZIP_MEMBER_PATTERN = /\.zip\//i;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const DIRECTORY_CACHE_SIZE = 32;

export interface ZipMemberPath {
  zipPath: string;
  entryName: string;
}

export interface ZipEntryInfo {
  size: number;
  mtime: Date;
}

interface CachedDirectory {
  version: string;
  entries: Map<string, unzipper.File>;
}

const directories = new Map<string, CachedDirectory>();

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
  const directory = await unzipper.Open.file(zipPath);
  const entries = new Map(directory.files.filter((file) => file.type === 'File').map((file) => [file.path, file]));
  const fresh = { version, entries };
  directories.set(zipPath, fresh);
  if (directories.size > DIRECTORY_CACHE_SIZE) directories.delete(directories.keys().next().value!);
  return fresh;
}

export async function listZipEntries(zipPath: string): Promise<Map<string, ZipEntryInfo>> {
  const { entries } = await openDirectory(zipPath, await stat(zipPath));
  return new Map([...entries].map(([name, file]) => [name, { size: file.uncompressedSize, mtime: file.lastModifiedDateTime }]));
}

function missingEntry(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such archive entry, '${path}'`), { code: 'ENOENT' });
}

/** Resolves the ZIP entry behind a member path, or null when the path is an ordinary file. */
async function findEntry(path: string): Promise<unzipper.File | null> {
  const member = parseZipMemberPath(path);
  if (!member) return null;
  const archive = await stat(member.zipPath).catch(() => null);
  if (!archive?.isFile()) return null;
  const entry = (await openDirectory(member.zipPath, archive)).entries.get(member.entryName);
  if (!entry) throw missingEntry(path);
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`Archive entry is larger than ${MAX_ENTRY_BYTES} bytes: ${path}`);
  return entry;
}

// The directory's size is a claim; an entry that inflates past it is refused rather than streamed.
function capBytes(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      callback(seen > limit ? new Error('Archive entry inflated past its declared size') : null, chunk);
    },
  });
}

function streamEntry(entry: unzipper.File): Readable {
  const capped = capBytes(entry.uncompressedSize);
  pipeline(entry.stream(), capped, () => undefined);
  return capped;
}

export async function statBookFile(path: string): Promise<ZipEntryInfo> {
  const entry = await findEntry(path);
  if (entry) return { size: entry.uncompressedSize, mtime: entry.lastModifiedDateTime };
  const { size, mtime } = await stat(path);
  return { size, mtime };
}

export async function readBookFile(path: string): Promise<Buffer> {
  const entry = await findEntry(path);
  if (!entry) return readFile(path);
  const chunks: Buffer[] = [];
  for await (const chunk of streamEntry(entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function openBookFileStream(path: string): Promise<Readable> {
  const entry = await findEntry(path);
  return entry ? streamEntry(entry) : createReadStream(path);
}
