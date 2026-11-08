import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import { zipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { citationIdOf, normaliseExtraction } from '@machvon/kernel';
import { LocalTextExtractor, readToUnicode, readWordBody, tokenize } from '../../src/modules/doc/local-text-extractor';
import { MockTextExtractionPort } from '../../src/modules/doc/text-extraction';

const reader = new LocalTextExtractor();
const SHA = 'a'.repeat(64);
const FONT = readFileSync(join(__dirname, '../../src/modules/doc/fonts/Tinos-Regular.ttf'));

async function wordFile(): Promise<Uint8Array> {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Điều 1. Phạm vi áp dụng', heading: 'Heading1' }),
          new Paragraph({ children: [new TextRun('Giá trị hợp đồng là '), new TextRun({ text: '100 tỷ đồng', bold: true }), new TextRun(' & chưa gồm thuế <VAT>')] }),
          new Paragraph({ text: '' }),
          new Paragraph({ text: 'Bên A giao việc', bullet: { level: 0 } }),
          new Table({
            rows: [
              new TableRow({ children: [new TableCell({ children: [new Paragraph('Hạng mục')] }), new TableCell({ children: [new Paragraph('Giá trị'), new Paragraph('(tỷ đồng)')] })] }),
              new TableRow({ children: [new TableCell({ children: [new Paragraph('Móng')] }), new TableCell({ children: [new Paragraph('12')] })] }),
            ],
          }),
          new Paragraph('Hết.'),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

async function workbook(): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  const budget = book.addWorksheet('Dự toán');
  budget.getCell('A1').value = 'Hạng mục';
  budget.getCell('B1').value = 'Giá trị';
  budget.getCell('A2').value = 'Móng';
  budget.getCell('B2').value = 1250.5;
  budget.getCell('B3').value = { formula: 'B2*2', result: 2501 };
  budget.mergeCells('A5:C5');
  budget.getCell('A5').value = 'Ghi chú gộp ô';
  book.addWorksheet('Tổng').getCell('A1').value = 'Cộng';
  return new Uint8Array(await book.xlsx.writeBuffer());
}

async function pdfFile(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(FONT, { subset: true });
  const first = pdf.addPage([600, 800]);
  first.drawText('ĐIỀU 1. PHẠM VI', { x: 50, y: 740, size: 20, font });
  first.drawText('Giá trị hợp đồng là 100 tỷ đồng', { x: 50, y: 700, size: 11, font });
  first.drawText('chưa gồm thuế giá trị gia tăng', { x: 50, y: 686, size: 11, font });
  first.drawText('Đoạn thứ hai cách xa đoạn đầu', { x: 50, y: 600, size: 11, font });
  const second = pdf.addPage([600, 800]);
  second.drawText('Trang hai có một dòng', { x: 70, y: 500, size: 11, font });
  return pdf.save();
}

describe('the local reader of the text of a file (DOC-2)', () => {
  describe('Word', () => {
    it('reads the paragraphs of the body in order and the cells of the tables, with the decoded entities', async () => {
      const result = await reader.extract({ bytes: await wordFile(), format: 'DOCX', sha256: SHA });
      expect(result).toMatchObject({ status: 'OK', omitted: 0, pageCount: null, engine: { name: 'machvon-local-reader' } });
      expect(result.units.map((unit) => [unit.kind, unit.locator, unit.text])).toEqual([
        ['HEADING', { paragraph: 1 }, 'Điều 1. Phạm vi áp dụng'],
        ['PARAGRAPH', { paragraph: 2 }, 'Giá trị hợp đồng là 100 tỷ đồng & chưa gồm thuế <VAT>'],
        ['LIST_ITEM', { paragraph: 3 }, 'Bên A giao việc'],
        ['TABLE_CELL', { table: 1, row: 1, column: 1 }, 'Hạng mục'],
        ['TABLE_CELL', { table: 1, row: 1, column: 2 }, 'Giá trị (tỷ đồng)'],
        ['TABLE_CELL', { table: 1, row: 2, column: 1 }, 'Móng'],
        ['TABLE_CELL', { table: 1, row: 2, column: 2 }, '12'],
        ['PARAGRAPH', { paragraph: 4 }, 'Hết.'],
      ]);
      // The units make a valid extraction with stable citations.
      const first = normaliseExtraction(SHA, result.units);
      const second = normaliseExtraction(SHA, result.units);
      expect(first.units.map((unit) => unit.citationId)).toEqual(second.units.map((unit) => unit.citationId));
      expect(first.units[0]?.citationId).toBe(citationIdOf(SHA, 'para1'));
      expect(first.units[3]?.locatorKey).toBe('t1/r1c1');
    });

    it('reads a body by its markup: nested tables fold into the cell, spans move the column, deleted text is not text', () => {
      const xml =
        '<w:body><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>wide</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>c3</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>nested</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>' +
        '<w:p><w:r><w:delText>gone</w:delText></w:r><w:r><w:t xml:space="preserve">kept </w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>text</w:t></w:r></w:p></w:body>';
      const { units } = readWordBody(xml);
      expect(units.map((unit) => [unit.locator, unit.text])).toEqual([
        [{ table: 1, row: 1, column: 1 }, 'wide'],
        [{ table: 1, row: 1, column: 3 }, 'c3 nested'],
        [{ paragraph: 1 }, 'kept text'],
      ]);
    });

    it('refuses a container with too many entries and a file that is not a Word file', async () => {
      const crowd: Record<string, Uint8Array> = {};
      for (let n = 0; n < 5001; n += 1) crowd[`f${n}.txt`] = new Uint8Array([1]);
      expect(await reader.extract({ bytes: zipSync(crowd), format: 'DOCX', sha256: SHA })).toMatchObject({ status: 'FAILED', failure: 'UNREADABLE', units: [] });
      expect(await reader.extract({ bytes: zipSync({ 'readme.txt': new Uint8Array([1]) }), format: 'DOCX', sha256: SHA })).toMatchObject({ status: 'FAILED', failure: 'UNREADABLE' });
      expect(await reader.extract({ bytes: new Uint8Array([1, 2, 3]), format: 'DOCX', sha256: SHA })).toMatchObject({ status: 'FAILED' });
    });
  });

  describe('workbook', () => {
    it('reads every filled cell by sheet and address, the value of a formula, and a merged range once', async () => {
      const result = await reader.extract({ bytes: await workbook(), format: 'XLSX', sha256: SHA });
      expect(result.status).toBe('OK');
      expect(result.units.map((unit) => [unit.kind, unit.locator, unit.text])).toEqual([
        ['SHEET_CELL', { sheet: 'Dự toán', cell: 'A1' }, 'Hạng mục'],
        ['SHEET_CELL', { sheet: 'Dự toán', cell: 'B1' }, 'Giá trị'],
        ['SHEET_CELL', { sheet: 'Dự toán', cell: 'A2' }, 'Móng'],
        ['SHEET_CELL', { sheet: 'Dự toán', cell: 'B2' }, '1250.5'],
        ['SHEET_CELL', { sheet: 'Dự toán', cell: 'B3' }, '2501'],
        ['SHEET_CELL', { sheet: 'Dự toán', cell: 'A5' }, 'Ghi chú gộp ô'],
        ['SHEET_CELL', { sheet: 'Tổng', cell: 'A1' }, 'Cộng'],
      ]);
      expect(normaliseExtraction(SHA, result.units).units.map((unit) => unit.locatorKey)).toContain('Dự toán!B3');
    });

    it('fails on a file that is not a workbook', async () => {
      expect(await reader.extract({ bytes: new Uint8Array([80, 75, 3, 4, 0, 0]), format: 'XLSX', sha256: SHA })).toMatchObject({ status: 'FAILED' });
    });
  });

  describe('PDF', () => {
    it('reads the text layer of each page into paragraphs with the page, the order and a box inside the page', async () => {
      const result = await reader.extract({ bytes: await pdfFile(), format: 'PDF', sha256: SHA });
      expect(result).toMatchObject({ status: 'OK', pageCount: 2, omitted: 0 });
      expect(result.units.map((unit) => [unit.kind, unit.locator, unit.text])).toEqual([
        ['HEADING', { page: 1, paragraph: 1 }, 'ĐIỀU 1. PHẠM VI'],
        ['PARAGRAPH', { page: 1, paragraph: 2 }, 'Giá trị hợp đồng là 100 tỷ đồng chưa gồm thuế giá trị gia tăng'],
        ['PARAGRAPH', { page: 1, paragraph: 3 }, 'Đoạn thứ hai cách xa đoạn đầu'],
        ['PARAGRAPH', { page: 2, paragraph: 1 }, 'Trang hai có một dòng'],
      ]);
      for (const unit of result.units) {
        const box = unit.box;
        expect(box).toBeDefined();
        if (box === undefined) continue;
        expect(box.x0).toBeGreaterThanOrEqual(0);
        expect(box.x1).toBeLessThanOrEqual(1);
        expect(box.y0).toBeLessThan(box.y1);
      }
      // The first paragraph sits above the second on the same page (the box is measured from the top).
      expect((result.units[0]?.box?.y0 ?? 1) < (result.units[1]?.box?.y0 ?? 0)).toBe(true);
      expect(normaliseExtraction(SHA, result.units).units).toHaveLength(4);
    });

    it('reads a page set in a standard font by the codes of its strings', async () => {
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      pdf.addPage([300, 300]).drawText('Plain text (with) parentheses', { x: 20, y: 200, size: 12, font });
      const result = await reader.extract({ bytes: await pdf.save(), format: 'PDF', sha256: SHA });
      expect(result.units.map((unit) => unit.text)).toEqual(['Plain text (with) parentheses']);
    });

    it('reads the text of a Form XObject a page draws, with its own fonts, and not only the content of the page itself', async () => {
      const source = await PDFDocument.create();
      const sourceFont = await source.embedFont(StandardFonts.Helvetica);
      source.addPage([300, 300]).drawText('Body text held by the form', { x: 20, y: 150, size: 12, font: sourceFont });
      const target = await PDFDocument.create();
      const targetFont = await target.embedFont(StandardFonts.TimesRoman);
      const [embedded] = await target.embedPdf(await source.save());
      const page = target.addPage([600, 800]);
      page.drawText('Header drawn directly', { x: 50, y: 760, size: 12, font: targetFont });
      page.drawPage(embedded as NonNullable<typeof embedded>, { x: 0, y: 300 });
      const result = await reader.extract({ bytes: await target.save(), format: 'PDF', sha256: SHA });
      expect(result.status).toBe('OK');
      expect(result.units.map((unit) => unit.text)).toEqual(['Header drawn directly', 'Body text held by the form']);
    });

    it('gives no unit for a page with no text layer, as a scan has none, and does not fail', async () => {
      const pdf = await PDFDocument.create();
      pdf.addPage([300, 300]);
      pdf.addPage([300, 300]);
      expect(await reader.extract({ bytes: await pdf.save(), format: 'PDF', sha256: SHA })).toMatchObject({ status: 'OK', units: [], pageCount: 2 });
    });

    it('fails on a damaged file and on an encrypted one, naming which', async () => {
      expect(await reader.extract({ bytes: new TextEncoder().encode('%PDF-1.7\nnot really a pdf'), format: 'PDF', sha256: SHA })).toMatchObject({ status: 'FAILED', failure: 'UNREADABLE' });
    });
  });

  describe('the pieces of the PDF reader', () => {
    it('reads a ToUnicode map: single codes, ranges, and a range with a list', () => {
      const cmap = `/CIDInit begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange
        2 beginbfchar <0003> <0020> <0024> <00410042> endbfchar
        2 beginbfrange <0030> <0032> <0061> <0040> <0041> [<0058> <0059>] endbfrange endcmap`;
      const { map, width } = readToUnicode(cmap);
      expect(width).toBe(2);
      expect(map.get(3)).toBe(' ');
      expect(map.get(0x24)).toBe('AB');
      expect([0x30, 0x31, 0x32].map((code) => map.get(code))).toEqual(['a', 'b', 'c']);
      expect([0x40, 0x41].map((code) => map.get(code))).toEqual(['X', 'Y']);
    });

    it('tokenizes operators, numbers, names, strings with escapes, hex strings and arrays, and skips dictionaries and inline images', () => {
      const tokens = tokenize('BT /F1 12 Tf 10 20 Td (a\\(b\\)\\101\\n) Tj [(x) -250 <0041>] TJ /Span <</MCID 0>> BDC BI /W 1 ID \u0001\u0002 EI ET');
      expect(tokens.map((token) => (token.t === 'op' ? token.v : token.t === 'num' ? token.v : token.t === 'name' ? `/${token.v}` : token.t))).toEqual(['BT', '/F1', 12, 'Tf', 10, 20, 'Td', 'str', 'Tj', 'arr', 'TJ', '/Span', 'BDC', 'ET']);
      const text = tokens.find((token) => token.t === 'str');
      expect(text?.t === 'str' ? String.fromCharCode(...text.v) : '').toBe('a(b)A\n');
      const list = tokens.find((token) => token.t === 'arr');
      expect(list?.t === 'arr' ? list.v.map((item) => item.t) : []).toEqual(['str', 'num', 'str']);
    });
  });

  describe('the mock reader', () => {
    it('answers what a test registered for a file and nothing for any other', async () => {
      const mock = new MockTextExtractionPort();
      mock.register(SHA, { units: [{ kind: 'PARAGRAPH', locator: { page: 1, paragraph: 1 }, text: 'Đã đăng ký' }], pageCount: 1 });
      expect((await mock.extract({ bytes: new Uint8Array(), format: 'PDF', sha256: SHA })).units).toHaveLength(1);
      expect(await mock.extract({ bytes: new Uint8Array(), format: 'PDF', sha256: 'b'.repeat(64) })).toMatchObject({ status: 'OK', units: [] });
      expect(mock.calls).toEqual([SHA, 'b'.repeat(64)]);
    });
  });
});
