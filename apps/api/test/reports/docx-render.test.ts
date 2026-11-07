import { unzipSync } from 'fflate';
import { DEMO_MARK, DomainError, fillNarrative } from '@machvon/kernel';
import type { NarrativeBlock } from '@machvon/kernel';
import { readDocxHeaderFooter, readDocxParagraphs, renderDocx } from '../../src/modules/reports/docx-render';
import { sha256Hex } from '../../src/modules/reports/digest';
import { data } from './template-fixture';

const failure = async (action: () => Promise<unknown> | unknown): Promise<string | undefined> => {
  try {
    await action();
  } catch (error) {
    return error instanceof DomainError ? `${error.code}:${error.detail ?? ''}` : String(error);
  }
  return undefined;
};

const ISSUED_AT = new Date(Date.UTC(2026, 10, 8, 3, 0, 0));
const OPTIONS = { title: 'Báo cáo tháng 10', creator: 'MACHVON', issuedAt: ISSUED_AT, headerText: 'PVFCCo', footerText: 'Báo cáo tháng' };

const BLOCKS: NarrativeBlock[] = [
  { type: 'HEADING', level: 1, text: 'I. TÌNH HÌNH THỰC HIỆN {{meta:PERIOD_LABEL}}' },
  { type: 'PARAGRAPH', text: 'Giải ngân lũy kế đạt {{indicator:HOME-01}}% kế hoạch năm. Ký hiệu đặc biệt: & < > " \'.', align: 'JUSTIFY' },
  { type: 'HEADING', level: 2, text: '1. Các việc đã làm' },
  { type: 'LIST', ordered: true, items: ['Hoàn thành hồ sơ A', 'Hoàn thành hồ sơ B'] },
  { type: 'LIST', ordered: true, items: ['Việc khác'] },
  { type: 'LIST', ordered: false, items: ['Ý thứ nhất', 'Ý thứ hai'] },
  { type: 'TABLE', header: ['Dự án', 'Kế hoạch', 'Giải ngân'], rows: [['Dự án A', '1.500', '1.234,6'], ['Dự án B', '500', '1.000']], widths: [50, 25, 25] },
  { type: 'PARAGRAPH', text: 'Ghi chú đậm', bold: true, italic: true, align: 'RIGHT' },
  { type: 'PAGE_BREAK' },
  { type: 'HEADING', level: 3, text: 'Phụ lục' },
  { type: 'SIGNATURES', slots: [{ role: 'Người lập', name: 'Nguyễn Văn A' }, { role: 'Người kiểm', name: null }, { role: 'Người duyệt', name: 'Trần Thị C' }] },
];

describe('renderDocx', () => {
  const filled = fillNarrative(BLOCKS, data(), 'MILLION_VND').blocks;

  it('writes a Word document whose text reads back in order, with the figures of the register in it', async () => {
    const bytes = await renderDocx(filled, OPTIONS);
    const paragraphs = readDocxParagraphs(bytes);
    expect(paragraphs).toContain('I. TÌNH HÌNH THỰC HIỆN Tháng 10 năm 2026');
    expect(paragraphs).toContain('Giải ngân lũy kế đạt 61,23% kế hoạch năm. Ký hiệu đặc biệt: & < > " \'.');
    expect(paragraphs).toContain('1. Các việc đã làm');
    expect(paragraphs).toEqual(expect.arrayContaining(['Hoàn thành hồ sơ A', 'Hoàn thành hồ sơ B', 'Việc khác', 'Ý thứ nhất', 'Ý thứ hai']));
    // The table: header, then each row, cell by cell.
    const start = paragraphs.indexOf('Dự án');
    expect(paragraphs.slice(start, start + 9)).toEqual(['Dự án', 'Kế hoạch', 'Giải ngân', 'Dự án A', '1.500', '1.234,6', 'Dự án B', '500', '1.000']);
    expect(paragraphs).toContain('Ghi chú đậm');
    expect(paragraphs.some((entry) => entry.includes('\f'))).toBe(true);
    expect(paragraphs).toEqual(expect.arrayContaining(['Người lập', 'Người kiểm', 'Người duyệt', 'Nguyễn Văn A', 'Trần Thị C', '(Ký, ghi rõ họ tên)']));
    // The order of the blocks is the order of the document.
    const at = (text: string): number => paragraphs.indexOf(text);
    expect(at('I. TÌNH HÌNH THỰC HIỆN Tháng 10 năm 2026')).toBeLessThan(at('1. Các việc đã làm'));
    expect(at('Việc khác')).toBeLessThan(at('Ý thứ nhất'));
    expect(at('Ghi chú đậm')).toBeLessThan(at('Phụ lục'));
    expect(at('Phụ lục')).toBeLessThan(at('Nguyễn Văn A'));
  });

  it('is a valid package with the properties, the header and the footer of the page', async () => {
    const entries = unzipSync(await renderDocx(filled, OPTIONS));
    const names = Object.keys(entries);
    expect(names[0]).toBe('[Content_Types].xml');
    expect(names).toEqual(expect.arrayContaining(['_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml']));
    const text = (name: string): string => new TextDecoder().decode(entries[name]);
    const core = text('docProps/core.xml');
    expect(core).toContain('Báo cáo tháng 10');
    expect(core).toContain('MACHVON');
    expect(core).toContain('2026-11-08T03:00:00Z');
    const part = (pattern: RegExp): string => text(names.find((name) => pattern.test(name)) as string);
    expect(part(/^word\/header\d*\.xml$/)).toContain('PVFCCo');
    expect(part(/^word\/footer\d*\.xml$/)).toContain('Báo cáo tháng');
    const document = text('word/document.xml');
    // A4 portrait with the margins of an administrative document: 20 mm top and bottom, 30 mm left, 15 mm right.
    expect(document).toMatch(/<w:pgSz [^>]*w:w="11906"[^>]*w:h="16838"/);
    expect(document).toMatch(/<w:pgMar [^>]*w:top="1134"/);
    expect(document).toMatch(/w:left="1701"/);
    expect(document).toMatch(/w:right="850"|w:right="851"/);
    expect(text('word/styles.xml')).toContain('Times New Roman');
  });

  it('writes a landscape page with other margins and another font when asked', async () => {
    const entries = unzipSync(await renderDocx(filled, { ...OPTIONS, font: 'Arial', fontSizePt: 11, page: { orientation: 'LANDSCAPE', marginMm: { top: 10, bottom: 10, left: 10, right: 10 } } }));
    const document = new TextDecoder().decode(entries['word/document.xml']);
    expect(document).toMatch(/w:orient="landscape"/);
    expect(document).toMatch(/<w:pgMar [^>]*w:top="567"/);
    expect(new TextDecoder().decode(entries['word/styles.xml'])).toContain('Arial');
  });

  it('gives the same bytes and the same sha256 for the same blocks, and other bytes for other text or another issue time', async () => {
    const first = await renderDocx(filled, OPTIONS);
    const second = await renderDocx(filled, OPTIONS);
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
    expect(sha256Hex(first)).toBe(sha256Hex(second));
    const edited = await renderDocx([...filled, { type: 'PARAGRAPH', text: 'Thêm' }], OPTIONS);
    expect(sha256Hex(edited)).not.toBe(sha256Hex(first));
    const later = await renderDocx(filled, { ...OPTIONS, issuedAt: new Date(ISSUED_AT.getTime() + 86_400_000) });
    expect(sha256Hex(later)).not.toBe(sha256Hex(first));
  });

  it('omits the header when none is given', async () => {
    const entries = unzipSync(await renderDocx([{ type: 'PARAGRAPH', text: 'x' }], { title: 't', creator: 'c' }));
    expect(Object.keys(entries).some((name) => /^word\/header\d*\.xml$/.test(name))).toBe(false);
    expect(Object.keys(entries).some((name) => /^word\/footer\d*\.xml$/.test(name))).toBe(true);
  });

  it('refuses a table whose rows do not match the header, a block of signatures with no slots, and options out of range', async () => {
    expect(await failure(() => renderDocx([{ type: 'TABLE', header: ['a', 'b'], rows: [['1']] }], OPTIONS))).toBe('VALIDATION_FAILED:table');
    expect(await failure(() => renderDocx([{ type: 'TABLE', header: [], rows: [] }], OPTIONS))).toBe('VALIDATION_FAILED:table');
    expect(await failure(() => renderDocx([{ type: 'TABLE', header: ['a', 'b'], rows: [], widths: [1] }], OPTIONS))).toBe('VALIDATION_FAILED:table');
    expect(await failure(() => renderDocx([{ type: 'TABLE', header: ['a', 'b'], rows: [], widths: [1, 0] }], OPTIONS))).toBe('VALIDATION_FAILED:table');
    expect(await failure(() => renderDocx([{ type: 'SIGNATURES', slots: [] }], OPTIONS))).toBe('VALIDATION_FAILED:signatures');
    expect(await failure(() => renderDocx([], { ...OPTIONS, title: ' ' }))).toBe('VALIDATION_FAILED:docx_options');
    expect(await failure(() => renderDocx([], { ...OPTIONS, fontSizePt: 99 }))).toBe('VALIDATION_FAILED:docx_options');
    expect(await failure(() => renderDocx([], { ...OPTIONS, page: { marginMm: { top: 1, bottom: 10, left: 10, right: 10 } } }))).toBe('VALIDATION_FAILED:docx_options');
  });

  it('renders an empty document and equal-width tables by default', async () => {
    const empty = readDocxParagraphs(await renderDocx([], { title: 't', creator: 'c' }));
    expect(empty.join('')).toBe('');
    const paragraphs = readDocxParagraphs(await renderDocx([{ type: 'TABLE', header: ['a', 'b'], rows: [['1', '2\n3']] }], { title: 't', creator: 'c' }));
    expect(paragraphs.slice(0, 5)).toEqual(['a', 'b', '1', '2', '3']);
  });

  it('refuses bytes that are not a Word document', () => {
    expect(() => readDocxParagraphs(new Uint8Array([1, 2, 3]))).toThrow(DomainError);
    expect(() => readDocxParagraphs(new Uint8Array(0))).toThrow(DomainError);
  });
});

describe('the mark of a DEMO form (R18)', () => {
  it('is printed in the header and the footer of every page and written into the properties, and is absent without a stamp', async () => {
    const plain = await renderDocx(BLOCKS, OPTIONS);
    expect(readDocxHeaderFooter(plain).headers.join('')).toBe('PVFCCo');
    expect(readDocxHeaderFooter(plain).footers.join('')).not.toContain(DEMO_MARK);
    expect(new TextDecoder().decode(unzipSync(plain)['docProps/core.xml'])).not.toContain(DEMO_MARK);

    const stamped = await renderDocx(BLOCKS, { ...OPTIONS, stamp: DEMO_MARK });
    const { headers, footers } = readDocxHeaderFooter(stamped);
    expect(headers).toEqual([DEMO_MARK, 'PVFCCo']);
    expect(footers.join('')).toContain(`${DEMO_MARK} — Báo cáo tháng — `);
    const core = new TextDecoder().decode(unzipSync(stamped)['docProps/core.xml']);
    expect(core).toContain(DEMO_MARK);
    expect(sha256Hex(stamped)).toBe(sha256Hex(await renderDocx(BLOCKS, { ...OPTIONS, stamp: DEMO_MARK })));
  });

  it('prints the mark alone when the document has no header text, and keeps an explicit subject', async () => {
    const rest = { title: OPTIONS.title, creator: OPTIONS.creator, issuedAt: OPTIONS.issuedAt, footerText: OPTIONS.footerText };
    const only = await renderDocx(BLOCKS, { ...rest, stamp: DEMO_MARK, subject: 'Thuyết minh' });
    expect(readDocxHeaderFooter(only).headers).toEqual([DEMO_MARK]);
    expect(new TextDecoder().decode(unzipSync(only)['docProps/core.xml'])).toContain('Thuyết minh');
    expect(readDocxHeaderFooter(await renderDocx(BLOCKS, { ...rest, stamp: null })).headers).toEqual([]);
  });

  it('refuses bytes that are not a docx when reading headers', () => {
    expect(() => readDocxHeaderFooter(new Uint8Array([1, 2, 3]))).toThrow(DomainError);
  });
});
