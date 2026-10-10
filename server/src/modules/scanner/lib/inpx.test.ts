import { describe, expect, it } from 'vitest';

import { archiveNameForInp, parseInpLine, parseInpxStructure } from './inpx';

const fields = parseInpxStructure(null);
// Real Flibusta rows (fields joined by 0x04).
const row = (values: string[]) => values.join('\x04');

describe('inpx', () => {
  it('maps a Flibusta row onto parsed book metadata', () => {
    const record = parseInpLine(
      row([
        'Риш,Мартиша,:Казиник,Михаил,Семенович:',
        'sf_humor:love_sf:',
        'Мне его подарили. Дом-портал 3 (СИ)',
        'Эльтем Диинаэ',
        '3',
        '832483',
        '1396790',
        '832483',
        '0',
        'fb2',
        '2025-07-01',
        'ru',
        '3',
        'юмор, рабство,  бытовое Фэнтези',
        '',
      ]),
      fields,
    );

    expect(record).toEqual({
      entryName: '832483.fb2',
      deleted: false,
      addedDate: new Date('2025-07-01T00:00:00Z'),
      data: {
        title: 'Мне его подарили. Дом-портал 3 (СИ)',
        authors: [
          { name: 'Мартиша Риш', sortName: 'Риш, Мартиша' },
          { name: 'Михаил Семенович Казиник', sortName: 'Казиник, Михаил' },
        ],
        genres: ['sf_humor', 'love_sf'],
        tags: ['юмор', 'рабство', 'бытовое Фэнтези'],
        seriesName: 'Эльтем Диинаэ',
        seriesIndex: '3',
        language: 'ru',
        cover: null,
      },
    });
  });

  it('flags deleted rows and drops a zero series number', () => {
    const record = parseInpLine(row(['Автор,Один,:', 'prose:', 'Книга', 'Серия', '0', '10', '5', '10', '1', 'fb2', '', 'ru', '', '', '']), fields);
    expect(record?.deleted).toBe(true);
    expect(record?.data.seriesIndex).toBeNull();
    expect(record?.addedDate).toBeUndefined();
  });

  it('falls back to the file name for a missing title and skips rows without a file', () => {
    expect(parseInpLine(row(['', '', '', '', '', '77', '1', '77', '0', 'fb2']), fields)?.data.title).toBe('77');
    expect(parseInpLine(row(['A,B,:', 'prose:', 'T']), fields)).toBeNull();
  });

  it('honours structure.info field order', () => {
    const custom = parseInpxStructure('TITLE;FILE;EXT;DEL;\r\n');
    expect(parseInpLine(row(['Заголовок', '5', 'fb2', '0']), custom)).toMatchObject({ entryName: '5.fb2', data: { title: 'Заголовок' } });
  });

  it('names the archive after its inp member', () => {
    expect(archiveNameForInp('f.fb2-832482-838586.inp')).toBe('f.fb2-832482-838586.zip');
  });
});
