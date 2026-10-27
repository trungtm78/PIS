import { PDFPage } from 'pdf-lib';
import { mneExportDocument } from '@machvon/kernel';
import { pdfOf } from '../../src/modules/dis/export-pdf';

jest.setTimeout(60_000);

const WORDS = Array.from({ length: 3000 }, (_, index) => `ý${index}`).join(' ');

const document = (narrative: string) =>
  mneExportDocument({
    formCode: 'TT44-M02',
    formRevision: 1,
    formTitle: 'Báo cáo giám sát',
    periodLabel: 'H1-2026',
    unitCode: 'CDT-1',
    unitName: 'Chủ đầu tư 1',
    dueDate: '2026-07-10',
    asOfDate: '2026-06-30',
    payloadSha256: 'a'.repeat(64),
    documentId: null,
    watermark: 'CHƯA XÁC NHẬN PHÁP LÝ',
    cells: [
      { label: 'Kế hoạch vốn', kind: 'MONEY', value: '1250000000000', source: 'SNAPSHOT_METRIC: plan_total_vnd' },
      { label: 'Đánh giá chung', kind: 'TEXT', value: narrative, source: '' },
    ],
  });

/** The PDF is drawn text by text; the fonts are embedded as subsets, so what was drawn is read from the calls to the page and not from the bytes. */
async function drawn(options: { wrap?: boolean; stamp?: Date }, narrative: string): Promise<{ texts: string[]; bytes: Uint8Array; pages: number }> {
  const texts: string[] = [];
  const original = PDFPage.prototype.drawText;
  const spy = jest.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, drawOptions) {
    texts.push(text);
    return original.call(this, text, drawOptions);
  });
  try {
    const bytes = await pdfOf(document(narrative), options);
    return { texts, bytes, pages: (Buffer.from(bytes).toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length };
  } finally {
    spy.mockRestore();
  }
}

describe('the PDF of a monitoring report (ST-MNE-004)', () => {
  it('writes a long narrative out in full over as many lines and pages as it needs, and does not cut it with an ellipsis', async () => {
    const { texts, pages } = await drawn({ wrap: true, stamp: new Date('2026-06-30T00:00:00Z') }, WORDS);
    const body = texts.join(' ');
    // Every word of the narrative is on some page, the first and the last included.
    for (const word of ['ý0', 'ý1', 'ý1499', 'ý2999']) expect(body).toContain(word);
    expect(body.match(/ý\d+/g)).toHaveLength(3000);
    expect(texts.some((text) => text.endsWith('…'))).toBe(false);
    expect(pages).toBeGreaterThan(1);
  });

  it('breaks a word that is longer than the column over lines, so that an address or a code is not cut off', async () => {
    const address = 'https://example.org/' + 'duong-dan-rat-dai-'.repeat(40) + 'het';
    const { texts } = await drawn({ wrap: true }, `Xem tại ${address} để biết thêm.`);
    const body = texts.join('');
    expect(body).toContain('het');
    expect(body.replace(/\s/g, '')).toContain(address);
    expect(texts.some((text) => text.endsWith('…'))).toBe(false);
  });

  it('keeps the line breaks of a paragraph, and the plain table cuts what does not fit (the table of the figures of DIS)', async () => {
    const wrapped = await drawn({ wrap: true }, 'Dòng một.\nDòng hai.');
    expect(wrapped.texts).toEqual(expect.arrayContaining(['Dòng một.', 'Dòng hai.']));
    const cut = await drawn({}, WORDS.split(' ').slice(0, 120).join(' '));
    expect(cut.texts.some((text) => text.endsWith('…'))).toBe(true);
  });

  it('gives the same bytes for the same content and the same day, so that the file is told apart by its hash', async () => {
    const stamp = new Date('2026-06-30T00:00:00Z');
    const first = await drawn({ wrap: true, stamp }, 'Đạt kế hoạch.');
    const second = await drawn({ wrap: true, stamp }, 'Đạt kế hoạch.');
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    const other = await drawn({ wrap: true, stamp }, 'Không đạt kế hoạch.');
    expect(Buffer.from(other.bytes).equals(Buffer.from(first.bytes))).toBe(false);
  });
});
