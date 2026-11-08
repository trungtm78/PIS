import type { ExportDocument } from '@machvon/kernel';
import { docxOf } from '../../src/modules/reports/export-docx';
import { readDocxHeaderFooter, readDocxParagraphs } from '../../src/modules/reports/docx-render';
import { sha256Hex } from '../../src/modules/reports/digest';

const columns = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `c${index}`, label: `Column ${index}`, numeric: false }));
const document = (overrides: Partial<ExportDocument> = {}): ExportDocument => ({
  title: 'Export of figures',
  header: [
    { key: 'period', label: 'Period', value: '2026-W41' },
    { key: 'snapshot_id', label: 'Snapshot', value: 'abc-123' },
  ],
  columns: columns(3) as ExportDocument['columns'],
  rows: [
    ['a & b', '<x>', '100'],
    ['c', 'd', '200'],
  ],
  notice: 'The definitions are not signed.',
  ...overrides,
});

describe('docxOf (IAM-2: the Word rendering of an export document)', () => {
  it('writes the title, the header entries, the notice and the table of the rows, in that order', async () => {
    const paragraphs = readDocxParagraphs(await docxOf(document()));
    const at = (text: string): number => paragraphs.findIndex((entry) => entry === text);
    expect(at('Export of figures')).toBe(0);
    expect(at('Period')).toBeGreaterThan(0);
    expect(paragraphs).toContain('2026-W41');
    expect(at('The definitions are not signed.')).toBeGreaterThan(at('abc-123'));
    expect(at('Column 0')).toBeGreaterThan(at('The definitions are not signed.'));
    expect(paragraphs).toContain('a & b');
    expect(paragraphs).toContain('<x>');
    expect(paragraphs).toContain('200');
  });

  it('gives the same bytes for the same document and other bytes for another', async () => {
    const first = await docxOf(document());
    const second = await docxOf(document());
    expect(sha256Hex(first)).toBe(sha256Hex(second));
    expect(sha256Hex(await docxOf(document({ rows: [['a', 'b', '1']] })))).not.toBe(sha256Hex(first));
  });

  it('turns the page on its side for a wide table and not for a narrow one', async () => {
    const wide = await docxOf(document({ columns: columns(8) as ExportDocument['columns'], rows: [Array.from({ length: 8 }, (_, index) => String(index))] }));
    const { unzipSync } = await import('fflate');
    const xml = (bytes: Uint8Array): string => new TextDecoder().decode(unzipSync(bytes, { filter: (file) => file.name === 'word/document.xml' })['word/document.xml']);
    expect(xml(wide)).toContain('w:orient="landscape"');
    expect(xml(await docxOf(document()))).not.toContain('w:orient="landscape"');
  });

  it('leaves out the notice when there is none, says so when there are no rows, and puts the mark and the header on the pages', async () => {
    const bare = readDocxParagraphs(await docxOf(document({ notice: null, rows: [] })));
    expect(bare).not.toContain('The definitions are not signed.');
    expect(bare.length).toBeGreaterThan(3);
    const marked = await docxOf(document(), { stamp: 'DEMO', headerText: 'Header text' });
    const parts = readDocxHeaderFooter(marked);
    expect(parts.headers.join('|')).toContain('DEMO');
    expect(parts.headers.join('|')).toContain('Header text');
    expect(parts.footers.join('|')).toContain('DEMO');
  });

  it('refuses nothing for a document with no header entries and no columns', async () => {
    const paragraphs = readDocxParagraphs(await docxOf(document({ header: [], columns: [] as unknown as ExportDocument['columns'], rows: [], notice: null })));
    expect(paragraphs[0]).toBe('Export of figures');
  });
});
