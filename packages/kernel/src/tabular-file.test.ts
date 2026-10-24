import { crc32, deflateRawSync } from 'node:zlib';
import { DEFAULT_TABULAR_LIMITS, readTabularFile } from './tabular-file.ts';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const failure = (work: () => unknown): { code: string; status: number; detail: string | undefined } | undefined => {
  try {
    work();
  } catch (error) {
    const { code, status, detail } = error as { code: string; status: number; detail?: string };
    return { code, status, detail };
  }
  return undefined;
};
const unreadable = { code: 'VALIDATION_FAILED', status: 422, detail: 'file' };

describe('reading a CSV file', () => {
  it('reads a header and the rows below it, whatever the line ending, and drops the byte order mark and blank lines', () => {
    const file = readTabularFile(text('﻿code,name\r\nA,Alpha\n\nB,Beta\r\n'));
    expect(file).toEqual({ format: 'CSV', headers: ['code', 'name'], rows: [['A', 'Alpha'], ['B', 'Beta']] });
  });

  it('finds the delimiter in the first line: comma, semicolon or tab', () => {
    expect(readTabularFile(text('a;b;c\n1;2;3')).rows).toEqual([['1', '2', '3']]);
    expect(readTabularFile(text('a\tb\tc\n1\t2\t3')).rows).toEqual([['1', '2', '3']]);
    expect(readTabularFile(text('only\nvalue')).rows).toEqual([['value']]);
    // A delimiter inside quotes in the first line does not count.
    expect(readTabularFile(text('"a;b;c;d",e\n1,2')).headers).toEqual(['a;b;c;d', 'e']);
  });

  it('reads quoted cells that hold the delimiter, line breaks and doubled quotes', () => {
    const file = readTabularFile(text('code,name\n"A,1","say ""hi"""\n"B","two\nlines"\n'));
    expect(file.rows).toEqual([['A,1', 'say "hi"'], ['B', 'two\nlines']]);
  });

  it('pads a short row, ignores a cell beyond the header, trims the names of the columns, and keeps an empty quoted cell as a row', () => {
    const file = readTabularFile(text(' code , name \nA\nB,Beta,extra\n""\n'));
    expect(file.headers).toEqual(['code', 'name']);
    expect(file.rows).toEqual([['A', ''], ['B', 'Beta'], ['', '']]);
  });

  it('reads Vietnamese text and a last row without a line break', () => {
    expect(readTabularFile(text('mã,tên\nGT,Giao thông')).rows).toEqual([['GT', 'Giao thông']]);
    expect(readTabularFile(text('a,b\n1,')).rows).toEqual([['1', '']]);
  });

  it('refuses what is not a table: empty, not UTF-8, an open quote, repeated column names, no header at all', () => {
    expect(failure(() => readTabularFile(new Uint8Array()))).toEqual(unreadable);
    expect(failure(() => readTabularFile(new Uint8Array([0xff, 0xfe, 0x41])))).toEqual(unreadable);
    expect(failure(() => readTabularFile(text('a,b\n"open,1')))).toEqual(unreadable);
    expect(failure(() => readTabularFile(text('a,a\n1,2')))).toEqual(unreadable);
    expect(failure(() => readTabularFile(text('\n\n')))).toEqual(unreadable);
    expect(failure(() => readTabularFile(text(',\n1,2')))).toEqual(unreadable);
  });

  it('refuses a file beyond its limits instead of reading it', () => {
    const limits = { ...DEFAULT_TABULAR_LIMITS, maxRows: 3, maxColumns: 3, maxCellLength: 5, maxBytes: 200 };
    expect(readTabularFile(text('a,b\n1,2\n3,4\n5,6'), limits).rows).toHaveLength(3);
    expect(failure(() => readTabularFile(text('a,b\n1,2\n3,4\n5,6\n7,8'), limits))).toEqual(unreadable);
    expect(failure(() => readTabularFile(text('a,b,c,d\n1,2,3,4'), limits))).toEqual(unreadable);
    expect(failure(() => readTabularFile(text('a,b\n123456,2'), limits))).toEqual(unreadable);
    expect(failure(() => readTabularFile(text(`a,b\n${'x'.repeat(250)},2`), limits))).toEqual(unreadable);
  });
});

// ---- a workbook for the tests: the parts that a reader needs, in a zip made here -----------------------------------------------

interface Part {
  name: string;
  data: string;
}

function zip(parts: readonly Part[], options: { deflate: boolean; flags?: number; declaredSize?: number } = { deflate: true }): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const raw = Buffer.from(part.data, 'utf8');
    const body = options.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(part.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.flags ?? 0, 6);
    local.writeUInt16LE(options.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(options.flags ?? 0, 8);
    entry.writeUInt16LE(options.deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(options.declaredSize ?? raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

const escapeXml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const letters = (index: number): string => (index < 26 ? String.fromCharCode(65 + index) : `${letters(Math.floor(index / 26) - 1)}${letters(index % 26)}`);

interface Workbook {
  rows: Array<Array<string | number | undefined>>;
  inline?: boolean;
  deflate?: boolean;
  second?: Array<Array<string>>;
}

function xlsx({ rows, inline = false, deflate = true, second }: Workbook): Uint8Array {
  const strings: string[] = [];
  const sheet = (data: Array<Array<string | number | undefined>>): string =>
    `<?xml version="1.0"?><worksheet><sheetData>${data
      .map(
        (row, rowIndex) =>
          `<row r="${rowIndex + 1}">${row
            .map((cell, columnIndex) => {
              if (cell === undefined) return '';
              const reference = `${letters(columnIndex)}${rowIndex + 1}`;
              if (typeof cell === 'number') return `<c r="${reference}"><v>${cell}</v></c>`;
              if (inline) return `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
              strings.push(cell);
              return `<c r="${reference}" t="s"><v>${strings.length - 1}</v></c>`;
            })
            .join('')}</row>`,
      )
      .join('')}</sheetData></worksheet>`;
  const first = sheet(rows);
  const other = second === undefined ? undefined : sheet(second);
  const parts: Part[] = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId2"/>${other === undefined ? '' : '<sheet name="Other" sheetId="2" r:id="rId3"/>'}</sheets></workbook>` },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<Relationships><Relationship Id="rId1" Type="styles" Target="styles.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet1.xml"/>${
        other === undefined ? '' : '<Relationship Id="rId3" Type="worksheet" Target="worksheets/sheet2.xml"/>'
      }</Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: first },
    ...(other === undefined ? [] : [{ name: 'xl/worksheets/sheet2.xml', data: other }]),
    ...(inline ? [] : [{ name: 'xl/sharedStrings.xml', data: `<sst>${strings.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join('')}</sst>` }]),
  ];
  return zip(parts, { deflate });
}

describe('reading an XLSX file', () => {
  const rows = [
    ['code', 'name', 'order'],
    ['GT', 'Giao thông', 10],
    ['NN', 'Nông nghiệp & nông thôn', 20],
  ];

  it('reads the first sheet through its shared strings, deflated or stored, and writes the numbers as text', () => {
    for (const deflate of [true, false]) {
      expect(readTabularFile(xlsx({ rows, deflate }))).toEqual({
        format: 'XLSX',
        headers: ['code', 'name', 'order'],
        rows: [['GT', 'Giao thông', '10'], ['NN', 'Nông nghiệp & nông thôn', '20']],
      });
    }
  });

  it('reads inline strings, rich text runs, escaped characters and the cells that a sparse row leaves out', () => {
    expect(readTabularFile(xlsx({ rows: [['a', 'b', 'c'], ['x', undefined, 'z']], inline: true })).rows).toEqual([['x', '', 'z']]);
    const runs = zip([
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row><c r="A2" t="s"><v>2</v></c><c r="B2"><v>7</v></c></row><row/></sheetData></worksheet>' },
      { name: 'xl/sharedStrings.xml', data: '<sst><si><t xml:space="preserve">Mã</t></si><si><r><t>Tên </t></r><r><t>&#272;&#7847;y &lt;đủ&gt;</t></r></si><si><t>&quot;q&quot;</t></si></sst>' },
    ]);
    const file = readTabularFile(runs);
    expect(file.headers).toEqual(['Mã', '', 'Tên Đầy <đủ>']);
    expect(file.rows).toEqual([['"q"', '7', '']]);
  });

  it('reads the first sheet of the workbook, not the second', () => {
    expect(readTabularFile(xlsx({ rows, second: [['other'], ['sheet']] })).headers).toEqual(['code', 'name', 'order']);
  });

  it('refuses a workbook that cannot be read: damaged, without its parts, encrypted, or declared far larger than any sheet', () => {
    const good = Buffer.from(xlsx({ rows }));
    expect(failure(() => readTabularFile(good.subarray(0, good.length - 30)))).toEqual(unreadable);
    expect(failure(() => readTabularFile(zip([{ name: 'xl/other.xml', data: '<x/>' }])))).toEqual(unreadable);
    expect(failure(() => readTabularFile(zip([{ name: 'xl/workbook.xml', data: '<workbook><sheets><sheet r:id="rId9"/></sheets></workbook>' }, { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships/>' }])))).toEqual(unreadable);
    expect(failure(() => readTabularFile(zip([{ name: 'xl/workbook.xml', data: '<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>' }, { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/none.xml"/></Relationships>' }])))).toEqual(unreadable);
    expect(failure(() => readTabularFile(zip([{ name: 'xl/workbook.xml', data: '<workbook/>' }], { deflate: false, flags: 1 })))).toEqual(unreadable);
    expect(failure(() => readTabularFile(zip([{ name: 'xl/workbook.xml', data: '<workbook/>' }], { deflate: true, declaredSize: 80 * 1024 * 1024 })))).toEqual(unreadable);
  });

  it('does not inflate a part beyond what its header says (a zip bomb stays small)', () => {
    const bomb = 'A'.repeat(5 * 1024 * 1024);
    const tight = { ...DEFAULT_TABULAR_LIMITS, maxInflatedBytes: 1024 * 1024 };
    expect(failure(() => readTabularFile(zip([{ name: 'xl/workbook.xml', data: bomb }]), tight))).toEqual(unreadable);
    // A header that understates the size does not let the part through either: the inflation stops at the declared size.
    const lying = zip([{ name: 'xl/workbook.xml', data: bomb }], { deflate: true, declaredSize: 10 });
    expect(failure(() => readTabularFile(lying))).toEqual(unreadable);
  });

  it('refuses a sheet beyond its limits and a cell outside the columns that are allowed', () => {
    const limits = { ...DEFAULT_TABULAR_LIMITS, maxRows: 2, maxColumns: 3, maxCellLength: 8 };
    expect(readTabularFile(xlsx({ rows: [['a', 'b'], ['1', '2'], ['3', '4']] }), limits).rows).toHaveLength(2);
    expect(failure(() => readTabularFile(xlsx({ rows: [['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']] }), limits))).toEqual(unreadable);
    expect(failure(() => readTabularFile(xlsx({ rows: [['a', 'b', 'c', 'd'], ['1', '2', '3', '4']] }), limits))).toEqual(unreadable);
    expect(failure(() => readTabularFile(xlsx({ rows: [['a'], ['123456789']] }), limits))).toEqual(unreadable);
  });
});
