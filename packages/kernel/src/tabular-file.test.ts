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
    expect(file).toEqual({ format: 'CSV', headers: ['code', 'name'], rows: [['A', 'Alpha'], ['B', 'Beta']], lines: [2, 4] });
  });

  it('numbers the rows by the lines of the source: blank lines and line breaks inside a quoted cell count, whatever the line ending', () => {
    expect(readTabularFile(text('code,name\nA,1\n\n\nB,2\n')).lines).toEqual([2, 5]);
    expect(readTabularFile(text('\ncode,name\nA,1')).lines).toEqual([3]);
    // A cell that runs over three lines (LF, CRLF and a lone CR) moves the next row down by three.
    expect(readTabularFile(text('code,name\r\nA,"one\ntwo\r\nthree\rfour"\r\nB,2\r\n\r\nC,3')).lines).toEqual([2, 6, 8]);
    expect(readTabularFile(text('code,name\rA,1\r\rB,2')).lines).toEqual([2, 4]);
    expect(readTabularFile(text('code,name\nA,"x\r\ny"\nB,2')).rows).toEqual([['A', 'x\r\ny'], ['B', '2']]);
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

/** A workbook with one sheet written by hand (its rows as XML), optionally with a style sheet and the properties of the workbook. */
function book(rowsXml: string, options: { styles?: string | undefined; workbookPr?: string | undefined } = {}): Uint8Array {
  return zip([
    { name: 'xl/workbook.xml', data: `<workbook>${options.workbookPr ?? ''}<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${rowsXml}</sheetData></worksheet>` },
    ...(options.styles === undefined ? [] : [{ name: 'xl/styles.xml', data: options.styles }]),
  ]);
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
        lines: [2, 3],
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

  it('numbers the rows by the rows of the worksheet: an empty row and a row left out count', () => {
    const file = readTabularFile(book('<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c></row><row r="2"/><row r="4"><c r="A4" t="inlineStr"><is><t>A</t></is></c></row><row><c r="A5" t="inlineStr"><is><t>B</t></is></c></row><row r="9"><c r="A9" t="inlineStr"><is><t>C</t></is></c></row>'));
    expect(file.rows).toEqual([['A'], ['B'], ['C']]);
    expect(file.lines).toEqual([4, 5, 9]);
    // A row number that goes back (a damaged sheet) never makes two rows the same line.
    const back = readTabularFile(book('<row r="3"><c r="A3" t="inlineStr"><is><t>code</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>A</t></is></c></row>'));
    expect(back.lines).toEqual([4]);
  });

  describe('dates', () => {
    const cell = (reference: string, style: number | undefined, value: string, type?: string): string =>
      `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`}${type === undefined ? '' : ` t="${type}"`}><v>${value}</v></c>`;
    const header = '<row r="1"><c r="A1" t="inlineStr"><is><t>when</t></is></c></row>';
    const dates = (serials: ReadonlyArray<[number | undefined, string]>, options?: { styles?: string; workbookPr?: string }): string[] =>
      readTabularFile(book(`${header}${serials.map(([style, value], index) => `<row r="${index + 2}">${cell(`A${index + 2}`, style, value)}</row>`).join('')}`, options)).rows.map((row) => row[0] ?? '');
    // 0: General, 1: d/m/yyyy (built in 14), 2: yyyy-mm-dd (custom), 3: text before a number, 4: brackets and escapes only, 5: 0.00, 6: built in 22, 7: h:mm AM/PM, 8: built in 3 (#,##0).
    const styles =
      '<styleSheet><numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="&quot;Day &quot;#,##0.00"/><numFmt numFmtId="166" formatCode="[Red]0.0;[$-409]0\\ \\d"/><numFmt numFmtId="167" formatCode="h:mm AM/PM"/></numFmts>' +
      '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
      '<cellXfs count="9"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"><alignment/></xf><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="2"/><xf numFmtId="22"/><xf numFmtId="167"/><xf numFmtId="3"/></cellXfs></styleSheet>';

    it('turns a number with a date style into an ISO date, in the built in formats and the custom ones', () => {
      expect(dates([[1, '45292'], [2, '45658'], [6, '45292']], { styles })).toEqual(['2024-01-01', '2025-01-01', '2024-01-01']);
    });

    it('keeps the time of day: a date and a time, a time alone, and a time that rounds up to the next day', () => {
      expect(dates([[1, '45292.5'], [6, '45292.75'], [7, '0.5'], [1, '45292.999999'], [1, '45292.000001']], { styles })).toEqual(['2024-01-01T12:00:00', '2024-01-01T18:00:00', '12:00:00', '2024-01-02', '2024-01-01']);
    });

    it('leaves a number alone when its style is not a date: general, text around a number, brackets and escapes, a decimal format', () => {
      expect(dates([[undefined, '45292'], [0, '45292'], [3, '45292'], [4, '45292'], [5, '45292'], [8, '45292'], [99, '45292']], { styles })).toEqual(['45292', '45292', '45292', '45292', '45292', '45292', '45292']);
      // Without a style sheet there is no date at all.
      expect(dates([[1, '45292']])).toEqual(['45292']);
    });

    it('counts the days of the 1900 system the way the spreadsheets do, with the 29 February 1900 that never was', () => {
      expect(dates([[1, '1'], [1, '59'], [1, '60'], [1, '61'], [1, '36526'], [1, '2958465']], { styles })).toEqual(['1900-01-01', '1900-02-28', '60', '1900-03-01', '2000-01-01', '9999-12-31']);
    });

    it('counts from 1904 when the workbook says so', () => {
      expect(dates([[1, '43830'], [1, '0']], { styles, workbookPr: '<workbookPr date1904="1"/>' })).toEqual(['2024-01-01', '1904-01-01']);
      expect(dates([[1, '43830']], { styles, workbookPr: '<workbookPr date1904="true" defaultThemeVersion="1"/>' })).toEqual(['2024-01-01']);
      expect(dates([[1, '43830']], { styles, workbookPr: '<workbookPr date1904="0"/>' })).toEqual(['2019-12-31']);
    });

    it('leaves what is not a day of the calendar as it is, for the module that reads the file to refuse', () => {
      expect(dates([[1, '0'], [1, '-5'], [1, 'abc'], [1, ' '], [1, '2958466'], [1, '1E+400']], { styles })).toEqual(['0', '-5', 'abc', ' ', '2958466', '1E+400']);
    });

    it('does not touch a cell that is text, a formula result, a boolean or an error, whatever its style', () => {
      const sheet = `${header}<row r="2">${cell('A2', 1, '45292', 'str')}</row><row r="3">${cell('A3', 1, '1', 'b')}</row><row r="4">${cell('A4', 1, '#N/A', 'e')}</row><row r="5">${cell('A5', 1, '45292', 'n')}</row><row r="6">${cell('A6', 1, '2024-01-02', 'd')}</row>`;
      expect(readTabularFile(book(sheet, { styles })).rows.map((row) => row[0])).toEqual(['45292', '1', '#N/A', '2024-01-01', '2024-01-02']);
    });

    it('keeps the guards of the reader: a style sheet is a part like any other', () => {
      const tight = { ...DEFAULT_TABULAR_LIMITS, maxInflatedBytes: 1024 * 1024 };
      expect(failure(() => readTabularFile(book(`${header}<row r="2">${cell('A2', 1, '45292')}</row>`, { styles: `<styleSheet>${'A'.repeat(5 * 1024 * 1024)}</styleSheet>` }), tight))).toEqual(unreadable);
    });
  });

  it('refuses a character reference that is not a character as an unreadable file, never as a server fault', () => {
    for (const reference of ['&#x110000;', '&#1114112;', '&#99999999999999999999;', '&#xFFFFFFFFFFFF;']) {
      const inline = `<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>${reference}</t></is></c></row>`;
      const number = `<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c></row><row r="2"><c r="A2"><v>${reference}</v></c></row>`;
      expect(failure(() => readTabularFile(book(inline)))).toEqual(unreadable);
      expect(failure(() => readTabularFile(book(number)))).toEqual(unreadable);
    }
    // A reference to a real character is still read.
    expect(readTabularFile(book('<row r="1"><c r="A1" t="inlineStr"><is><t>code</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>&#x1F600;&#65;</t></is></c></row>')).rows).toEqual([['\u{1F600}A']]);
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
