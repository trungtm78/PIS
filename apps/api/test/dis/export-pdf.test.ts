import { PDFPage } from 'pdf-lib';
import { buildExportDocument } from '@machvon/kernel';
import type { ExportInput, ExportLine } from '@machvon/kernel';
import { pdfOf } from '../../src/modules/dis/export-pdf';

const LINE: ExportLine = {
  projectCode: 'P-A-001',
  projectName: 'Cầu qua sông',
  unitCode: 'U-BQL1',
  unitName: 'Ban quản lý 1',
  bucket: 'CURRENT_YEAR',
  budgetLevel: 'CENTRAL',
  planPmVnd: '1000000000',
  planLocalVnd: '250000000',
  planTotalVnd: '1250000000',
  disbursedTreasuryVnd: '600000000',
  disbursedReportedVnd: '420000000',
  ctmtqgVnd: '40000000',
  ratePmPct: '60.0000',
  rateTotalPct: '48.0000',
  rateNullReason: null,
  coverage: 'COMPLETE',
};
const input = (over: Partial<ExportInput> = {}): ExportInput => ({
  snapshotId: '00000000-0000-4000-8000-0000000000a1',
  periodCode: 'W2027-40',
  snapshotKind: 'PERIOD_CLOSE',
  asOfDate: '2027-10-10',
  treasuryCutoffDate: '2027-10-10',
  definitionStatus: 'PROPOSED_PENDING_SIGNOFF',
  createdAt: new Date('2027-10-15T03:00:00Z'),
  unitCodes: ['U-BQL1'],
  lines: [LINE],
  ...over,
});

/** The PDF is drawn text by text; the fonts are embedded as subsets, so what was drawn is read from the calls to the page and not from the bytes. */
async function drawn(document: ReturnType<typeof buildExportDocument>): Promise<{ texts: string[]; bytes: Uint8Array }> {
  const texts: string[] = [];
  const original = PDFPage.prototype.drawText;
  const spy = jest.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, options) {
    texts.push(text);
    return original.call(this, text, options);
  });
  try {
    return { texts, bytes: await pdfOf(document) };
  } finally {
    spy.mockRestore();
  }
}

describe('the PDF of an export (ST-DIS-016)', () => {
  it('AC-ST-DIS-016-3 / UAT-AC257: carries in its footer that the definitions await the D03 sign-off, with the header of the file and the rows', async () => {
    const { texts, bytes } = await drawn(buildExportDocument(input()));
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(texts.some((text) => text.includes('D03'))).toBe(true);
    expect(texts.some((text) => text.includes('PROPOSED_PENDING_SIGNOFF'))).toBe(true);
    expect(texts.some((text) => text.includes('00000000-0000-4000-8000-0000000000a1'))).toBe(true);
    expect(texts.some((text) => text.includes('W2027-40'))).toBe(true);
    expect(texts).toContain('P-A-001');
    expect(texts).toContain('1250000000');
  });

  it('repeats the notice and the heading of the table on every page when the rows need more than one, and numbers the pages', async () => {
    const lines = Array.from({ length: 150 }, (_, n) => ({ ...LINE, projectCode: `P-${String(n).padStart(4, '0')}` }));
    const { texts } = await drawn(buildExportDocument(input({ lines })));
    const notices = texts.filter((text) => text.includes('D03'));
    const pageNumbers = texts.filter((text) => /· \d+\/\d+$/.test(text));
    expect(pageNumbers.length).toBeGreaterThan(1);
    expect(notices).toHaveLength(pageNumbers.length * Math.max(1, notices.length / pageNumbers.length));
    expect(texts.filter((text) => text === 'Mã dự án')).toHaveLength(pageNumbers.length);
    expect(pageNumbers[pageNumbers.length - 1]).toMatch(new RegExp(`· ${pageNumbers.length}/${pageNumbers.length}$`));
  }, 60_000);

  it('says nothing of a sign-off once the definitions are signed, and cuts a long name with an ellipsis instead of running into the next column', async () => {
    const signed = await drawn(buildExportDocument(input({ definitionStatus: 'SIGNED', lines: [{ ...LINE, projectName: 'Rất dài '.repeat(40) }] })));
    expect(signed.texts.some((text) => text.includes('D03'))).toBe(false);
    expect(signed.texts.some((text) => text.endsWith('…'))).toBe(true);
  });
});
