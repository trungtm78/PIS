import { MNE_GENERATED_FORMATS, UNCONFIRMED_WATERMARK, assertExportable, checkedFormats, exportWatermark, exportedCell, filedLate, mneExportDocument } from '../src/mne-export.ts';

describe('the export package of a monitoring report (ST-MNE-004)', () => {
  it('exports a report only once DOC issued it, and not after DOC recalled it', () => {
    for (const status of ['ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL'] as const) expect(() => assertExportable({ status, recalledAt: null })).not.toThrow();
    for (const status of ['DRAFT', 'IN_REVIEW', 'APPROVED', 'ISSUING', 'RETURNED', 'SUPERSEDED'] as const) {
      expect(() => assertExportable({ status, recalledAt: null })).toThrow(expect.objectContaining({ code: 'REPORT_NOT_ISSUED', status: 409 }));
    }
    expect(() => assertExportable({ status: 'ISSUED', recalledAt: '2026-10-01T00:00:00Z' })).toThrow(expect.objectContaining({ code: 'REPORT_NOT_ISSUED' }));
  });

  it('accepts the formats this release makes and the form allows, and refuses the others by name', () => {
    expect(MNE_GENERATED_FORMATS).toEqual(['XLSX', 'PDF', 'CSV']);
    expect(checkedFormats(['XLSX', 'PDF'], ['XLSX', 'PDF', 'XML'])).toEqual(['XLSX', 'PDF']);
    expect(() => checkedFormats(['XML'], ['XML'])).toThrow(expect.objectContaining({ code: 'EXPORT_FORMAT_UNSUPPORTED', status: 422, detail: 'formats[0]' }));
    expect(() => checkedFormats(['XLSX', 'CSV'], ['XLSX'])).toThrow(expect.objectContaining({ code: 'EXPORT_FORMAT_UNSUPPORTED', detail: 'formats[1]' }));
    expect(() => checkedFormats(['XLSX', 'XLSX'], ['XLSX'])).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'formats[1]' }));
    expect(() => checkedFormats(['DOCX'], ['XLSX'])).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('writes money in million dong without a float, a rate with its sign, and an empty cell as nothing', () => {
    expect(exportedCell({ label: 'Plan', kind: 'MONEY', value: '1250000000000', source: '' })).toEqual({ value: '1250000.000000', unit: 'triệu đồng' });
    expect(exportedCell({ label: 'Refund', kind: 'MONEY', value: '-5000', source: '' })).toEqual({ value: '-0.005000', unit: 'triệu đồng' });
    expect(exportedCell({ label: 'Rate', kind: 'PERCENT', value: '48.0000', source: '' })).toEqual({ value: '48.0000', unit: '%' });
    expect(exportedCell({ label: 'Projects', kind: 'INTEGER', value: 4, source: '' })).toEqual({ value: '4', unit: '' });
    expect(exportedCell({ label: 'Note', kind: 'TEXT', value: null, source: '' })).toEqual({ value: '', unit: '' });
  });

  it('makes a document with the head of the report, one row per cell, and the watermark as its notice', () => {
    const input = {
      formCode: 'TT44-M02',
      formRevision: 1,
      formTitle: 'Báo cáo giám sát',
      periodLabel: 'H1-2026',
      unitCode: 'CDT-1',
      unitName: 'Chủ đầu tư 1',
      dueDate: '2026-07-10',
      asOfDate: '2026-06-30',
      payloadSha256: 'a'.repeat(64),
      documentId: '00000000-0000-4000-8000-0000000000d1',
      watermark: 'CHƯA XÁC NHẬN PHÁP LÝ [CXN-10]',
      cells: [
        { label: 'Kế hoạch', kind: 'MONEY', value: '1250000000000', source: 'SNAPSHOT_METRIC: plan_total_vnd' },
        { label: 'Đánh giá', kind: 'TEXT', value: 'Đạt.', source: '' },
      ],
    } as const;
    const document = mneExportDocument(input);
    expect(document.title).toBe('Báo cáo giám sát');
    expect(document.header.map((entry) => entry.key)).toEqual(['form', 'period', 'unit', 'due_date', 'as_of_date', 'payload_sha256', 'document_id']);
    expect(document.rows).toEqual([
      ['Kế hoạch', '1250000.000000', 'triệu đồng', 'SNAPSHOT_METRIC: plan_total_vnd'],
      ['Đánh giá', 'Đạt.', '', ''],
    ]);
    expect(document.notice).toBe('CHƯA XÁC NHẬN PHÁP LÝ [CXN-10]');
    expect(mneExportDocument({ ...input, watermark: null, asOfDate: null, payloadSha256: null, documentId: null }).header.map((entry) => entry.key)).toEqual(['form', 'period', 'unit', 'due_date']);
    expect(mneExportDocument({ ...input, watermark: null }).notice).toBeNull();
  });

  it('marks a file while the legal basis of its form is not confirmed: with the text of the form, or with plain words when it names none, and with nothing once it is confirmed', () => {
    expect(exportWatermark({ legalConfirmationRef: null, watermarkText: 'CHƯA XÁC NHẬN [CXN-10]' })).toBe('CHƯA XÁC NHẬN [CXN-10]');
    expect(exportWatermark({ legalConfirmationRef: null, watermarkText: null })).toBe(UNCONFIRMED_WATERMARK);
    expect(exportWatermark({ legalConfirmationRef: null, watermarkText: '  ' })).toBe(UNCONFIRMED_WATERMARK);
    expect(exportWatermark({ legalConfirmationRef: 'CXN-10/OK', watermarkText: 'CHƯA XÁC NHẬN' })).toBeNull();
  });

  it('judges a filing late by the Vietnam day it was made against the due date', () => {
    expect(filedLate('2026-07-10', '2026-07-10T16:59:59Z')).toBe(false);
    // 17:00 UTC is midnight the next day in Vietnam.
    expect(filedLate('2026-07-10', '2026-07-10T17:00:00Z')).toBe(true);
    expect(filedLate('2026-07-10', '2026-07-09T01:00:00Z')).toBe(false);
  });
});
