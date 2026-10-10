import { parseSeriesIndex } from '@bookorbit/types';

import type { ParsedBookData } from '../../metadata/extractors/format-extractor.interface';

// Field order MyHomeLib/Flibusta indexes use when the INPX carries no structure.info.
const DEFAULT_FIELDS = ['AUTHOR', 'GENRE', 'TITLE', 'SERIES', 'SERNO', 'FILE', 'SIZE', 'LIBID', 'DEL', 'EXT', 'DATE', 'LANG', 'LIBRATE', 'KEYWORDS'];

export interface InpRecord {
  entryName: string;
  deleted: boolean;
  addedDate: Date | undefined;
  data: ParsedBookData;
}

export function parseInpxStructure(structureInfo: string | null): string[] {
  const fields = structureInfo
    ?.trim()
    .split(';')
    .map((field) => field.trim().toUpperCase())
    .filter(Boolean);
  return fields && fields.length > 0 ? fields : DEFAULT_FIELDS;
}

/** The .inp member listing one archive is named after that archive. */
export function archiveNameForInp(inpName: string): string {
  return `${inpName.replace(/\.inp$/i, '')}.zip`;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAuthor(raw: string): { name: string; sortName: string | null } | null {
  const [last = '', first = '', middle = ''] = raw.split(',').map((part) => part.trim());
  const name = [first, middle, last].filter(Boolean).join(' ');
  if (!name) return null;
  return { name, sortName: last && first ? `${last}, ${first}` : null };
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseInpLine(line: string, fields: string[]): InpRecord | null {
  const values = line.split('\x04');
  const field = (name: string) => values[fields.indexOf(name)]?.trim() || undefined;

  const file = field('FILE');
  const ext = field('EXT');
  if (!file || !ext) return null;

  const del = field('DEL');
  const serno = field('SERNO');
  const keywords = field('KEYWORDS');
  return {
    entryName: `${file}.${ext}`,
    deleted: del !== undefined && del !== '0',
    addedDate: parseDate(field('DATE')),
    data: {
      title: field('TITLE') ?? file,
      authors: list(field('AUTHOR'))
        .map(parseAuthor)
        .filter((author) => author !== null),
      genres: list(field('GENRE')),
      tags: keywords
        ? keywords
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [],
      seriesName: field('SERIES') ?? null,
      seriesIndex: serno && serno !== '0' ? parseSeriesIndex(serno) : null,
      language: field('LANG') ?? null,
      cover: null,
    },
  };
}
