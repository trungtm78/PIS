import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { toAttachment, toNarrative, toProgress, toReview } from './detail-parts';
import { describeReport, toReportDetail } from './model';
import type { ReportDetail } from './model';
import { FILE_ID, fileRecord, progressRecord, reportRecord } from './test-support';
import {
  attachmentsBody,
  cellOfFinding,
  keepBody,
  nextMonthOf,
  notesBody,
  notesFormOf,
  progressBody,
  progressFormOf,
  registrationBody,
  registrationFormOf,
  registrationTotals,
  remainingOf,
  stepLink,
  stepOfFinding,
  validateNotes,
  validateProgress,
  validateRegistration,
} from './step-model';

const detailOf = (overrides: Record<string, unknown> = {}): ReportDetail => toReportDetail(reportRecord(overrides)) as ReportDetail;
const ISSUE = '00000000-0000-4000-8000-0000000000a1';

describe('the parts of a report beyond its six cells', () => {
  it('reads the volumes, the notes, the files and the review as the server answers them, and nothing from what is not one', () => {
    expect(toProgress(progressRecord())).toEqual({ constructionVnd: '300000000', acceptanceVnd: '200000000', treasurySubmittedVnd: '150000000', preparingDossierVnd: '50000000', physicalProgressPct: '37.50', asOfDate: '2027-01-10' });
    expect(toProgress(progressRecord({ physical_progress_pct: null }))?.physicalProgressPct).toBeNull();
    for (const bad of [null, 'x', progressRecord({ construction_vnd: 5 }), progressRecord({ acceptance_vnd: '-1' }), progressRecord({ as_of_date: undefined })]) expect(toProgress(bad)).toBeNull();

    expect(toNarrative({ results: 'Done', causes: null, solutions: 'More', proposals: null, linked_issue_ids: ['a', 5, 'b'] })).toEqual({ results: 'Done', causes: null, solutions: 'More', proposals: null, linkedIssueIds: ['a', 'b'], enterprise: null });
    expect(toNarrative({})).toEqual({ results: null, causes: null, solutions: null, proposals: null, linkedIssueIds: [], enterprise: null });
    expect(toNarrative(null)).toBeNull();

    expect(toAttachment(fileRecord())).toEqual({ fileObjectId: FILE_ID, fileSha256: 'a'.repeat(64), fileName: 'voucher-1.pdf', contentType: 'application/pdf', sizeBytes: 2048 });
    expect(toAttachment({ ...fileRecord(), content_type: undefined })?.contentType).toBe('');
    for (const bad of [null, { ...fileRecord(), file_object_id: undefined }, { ...fileRecord(), size_bytes: '5' }, { ...fileRecord(), file_name: 5 }, { ...fileRecord(), file_sha256: undefined }]) expect(toAttachment(bad)).toBeUndefined();

    expect(toReview({ blocking: true, errors: [{ code: 'PERIOD_LOCKED', field: 'period', values: { a: 'x', b: 5, c: null } }, { code: 1 }], warnings: 'x' })).toEqual({
      blocking: true,
      errors: [{ code: 'PERIOD_LOCKED', field: 'period', values: { a: 'x', b: null, c: null } }],
      warnings: [],
    });
    expect(toReview({ errors: [{ code: 'A', field: 'f' }] })).toEqual({ blocking: false, errors: [{ code: 'A', field: 'f', values: {} }], warnings: [] });
    expect(toReview(undefined)).toBeNull();
  });

  it('puts them on the report, with the registration for next month added up, and tolerates a server that leaves them out', () => {
    const detail = detailOf({ progress: progressRecord(), narrative: { results: 'Done' }, attachments: [fileRecord(1), { nope: 1 }, fileRecord(2)], review: { blocking: false, errors: [], warnings: [] } });
    expect(detail.progress?.constructionVnd).toBe('300000000');
    expect(detail.narrative?.results).toBe('Done');
    expect(detail.attachments.map((file) => file.fileName)).toEqual(['voucher-1.pdf', 'voucher-2.pdf']);
    expect(detail.review).toEqual({ blocking: false, errors: [], warnings: [] });
    expect(detail.totals).toMatchObject({ nextMonthVnd: '5000000', nextMonthCtmtqgVnd: '0' });
    const bare = toReportDetail({ ...reportRecord(), progress: undefined, narrative: undefined, attachments: undefined, review: undefined, totals: { allocated_vnd: '1', cumulative_vnd: '1', ctmtqg_vnd: '0' } }) as ReportDetail;
    expect([bare.progress, bare.narrative, bare.attachments, bare.review]).toEqual([null, null, [], null]);
    expect(bare.totals).toMatchObject({ nextMonthVnd: '0', nextMonthCtmtqgVnd: '0' });
  });

  it('names the cell and the member the server refused, and the refusals of a file', () => {
    const refused = (detail: string) => describeReport(new ApiError({ status: 422, code: 'SUBSET_EXCEEDS_PARENT', correlationId: 'c', detail }));
    expect(refused('funding_lines[0].cumulative_vnd').field).toBe('CURRENT_YEAR:CENTRAL.cumulative');
    expect(refused('funding_lines[1].ctmtqg_subset_vnd').field).toBe('CURRENT_YEAR:LOCAL.ctmtqg');
    expect(refused('funding_lines[2].next_month_vnd').field).toBe('CARRYOVER:CENTRAL.nextMonth');
    expect(refused('funding_lines[3].next_month_ctmtqg_subset_vnd').field).toBe('CARRYOVER:LOCAL.nextCtmtqg');
    expect(refused('funding_lines[9].next_month_vnd').field).toBeUndefined();
    expect(refused('narrative.results').field).toBeUndefined();
    for (const [code, problem] of [
      ['FILE_NOT_CLEAN', 'fileInfected'],
      ['FILE_TYPE_NOT_ALLOWED', 'fileType'],
      ['PAYLOAD_TOO_LARGE', 'fileTooLarge'],
      ['SCAN_PENDING', 'scanPending'],
      ['HASH_MISMATCH', 'hashMismatch'],
    ] as const) {
      expect(describeReport(new ApiError({ status: 422, code, correlationId: 'c' })).problem).toBe(problem);
    }
  });
});

describe('the volumes of DIS-03 (AC-ST-DIS-004-1)', () => {
  it('starts empty for a draft with none, and shows what was kept for one that has them', () => {
    expect(progressFormOf(detailOf())).toEqual({ construction: '', acceptance: '', treasury: '', preparing: '', percent: '', basis: 'YTD' });
    expect(progressFormOf(detailOf({ progress: progressRecord(), measurement_basis: 'PERIOD' }))).toEqual({ construction: '300000000', acceptance: '200000000', treasury: '150000000', preparing: '50000000', percent: '37.50', basis: 'PERIOD' });
    expect(progressFormOf(detailOf({ progress: progressRecord({ physical_progress_pct: null }) })).percent).toBe('');
  });

  it('wants the four amounts as whole dong and the percent, when given, between 0 and 100 with up to two decimals', () => {
    const ok = { construction: '1.250.000.000', acceptance: '0', treasury: '5', preparing: '7', percent: '', basis: 'YTD' as const };
    expect(validateProgress(ok)).toEqual({});
    expect(validateProgress({ ...ok, percent: '37,5' })).toEqual({});
    expect(validateProgress({ ...ok, percent: '100' })).toEqual({});
    expect(validateProgress({ construction: '', acceptance: ' ', treasury: '', preparing: '', percent: '', basis: 'YTD' })).toEqual({ construction: 'required', acceptance: 'required', treasury: 'required', preparing: 'required' });
    expect(validateProgress({ ...ok, construction: '1,5x', acceptance: '-1', treasury: '1e3' })).toEqual({ construction: 'invalid', acceptance: 'invalid', treasury: 'invalid' });
    expect(validateProgress({ ...ok, percent: '100,5' })).toEqual({ percent: 'range' });
    expect(validateProgress({ ...ok, percent: '101' })).toEqual({ percent: 'range' });
    for (const bad of ['abc', '-3', '1.234']) expect(validateProgress({ ...ok, percent: bad }).percent).toBe('invalid');
  });

  it('saves the volumes and the basis with the cells, the registration and the explanation as they stand', () => {
    const detail = detailOf({ negative_delta_explanation: 'The Treasury returned a payment.' });
    const body = progressBody(detail, { construction: '300.000.000', acceptance: '200000000', treasury: '150.000.000', preparing: '50.000.000', percent: '37,5', basis: 'PERIOD' });
    expect(body).toMatchObject({
      project_id: detail.project.id,
      period_id: detail.period.id,
      plan_version_id: detail.planVersion.id,
      report_type: 'WEEKLY',
      measurement_basis: 'PERIOD',
      construction_vnd: '300000000',
      acceptance_vnd: '200000000',
      treasury_submitted_vnd: '150000000',
      preparing_dossier_vnd: '50000000',
      physical_progress_pct: '37.5',
      negative_delta_explanation: 'The Treasury returned a payment.',
    });
    expect(body.funding_lines).toEqual(keepBody(detail).funding_lines);
    expect(Object.keys(progressBody(detail, { construction: '1', acceptance: '2', treasury: '3', preparing: '4', percent: '  ', basis: 'YTD' }))).not.toContain('physical_progress_pct');
  });

  it('keeps every cell as the report holds it, the registration for next month included', () => {
    const body = keepBody(detailOf());
    expect(body.funding_lines).toHaveLength(6);
    expect(body.funding_lines[0]).toEqual({ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000', next_month_vnd: '0' });
    expect(body.funding_lines[1]).toMatchObject({ next_month_vnd: '5000000' });
    expect(Object.keys(body)).not.toContain('negative_delta_explanation');
    const lines = reportRecord().funding_lines as Array<Record<string, unknown>>;
    expect(keepBody(detailOf({ funding_lines: [{ ...lines[0], next_month_ctmtqg_subset_vnd: '1000' }] })).funding_lines[0]).toMatchObject({ next_month_ctmtqg_subset_vnd: '1000' });
  });
});

describe('the registration for next month of DIS-05 (AC-ST-DIS-004-3)', () => {
  it('starts from what the report holds, zero where nothing was registered and no CTMTQG', () => {
    const form = registrationFormOf(detailOf());
    expect(form.cells['CURRENT_YEAR:LOCAL']).toEqual({ nextMonth: '5000000', ctmtqg: '' });
    expect(form.cells['OTHER:LOCAL']).toEqual({ nextMonth: '0', ctmtqg: '' });
    expect(Object.keys(form.cells)).toHaveLength(6);
    const lines = reportRecord().funding_lines as Array<Record<string, unknown>>;
    expect(registrationFormOf(detailOf({ funding_lines: [lines[0]] })).cells['OTHER:LOCAL']).toEqual({ nextMonth: '0', ctmtqg: '' });
    expect(registrationFormOf(detailOf({ funding_lines: [{ ...lines[0], next_month_vnd: '300000000', next_month_ctmtqg_subset_vnd: '100000000' }] })).cells['CURRENT_YEAR:CENTRAL']).toEqual({ nextMonth: '300000000', ctmtqg: '100000000' });
  });

  it('wants whole amounts, a CTMTQG that is inside the registration and only in the year plan and the carried-over plan', () => {
    const form = registrationFormOf(detailOf());
    expect(validateRegistration(form)).toEqual({});
    const entered = (cells: Record<string, { nextMonth: string; ctmtqg: string }>) => ({ cells: { ...form.cells, ...cells } });
    expect(
      validateRegistration(
        entered({
          'CURRENT_YEAR:CENTRAL': { nextMonth: '', ctmtqg: '' },
          'CURRENT_YEAR:LOCAL': { nextMonth: '1x', ctmtqg: '5' },
          'CARRYOVER:CENTRAL': { nextMonth: '100', ctmtqg: '101' },
          'CARRYOVER:LOCAL': { nextMonth: '100', ctmtqg: 'abc' },
          'OTHER:CENTRAL': { nextMonth: '100', ctmtqg: '5' },
        }),
      ),
    ).toEqual({
      'CURRENT_YEAR:CENTRAL.nextMonth': 'required',
      'CURRENT_YEAR:LOCAL.nextMonth': 'invalid',
      'CARRYOVER:CENTRAL.ctmtqg': 'exceeds',
      'CARRYOVER:LOCAL.ctmtqg': 'invalid',
      'OTHER:CENTRAL.ctmtqg': 'notAllowed',
    });
    expect(validateRegistration(entered({ 'CARRYOVER:CENTRAL': { nextMonth: '100', ctmtqg: '100' } }))).toEqual({});
    expect(validateRegistration({ cells: {} })['CURRENT_YEAR:CENTRAL.nextMonth']).toBe('required');
  });

  it('adds up what is registered with the CTMTQG apart, and reads what is not an amount as zero', () => {
    const form = registrationFormOf(detailOf());
    expect(registrationTotals(form)).toEqual({ nextMonthVnd: '5000000', ctmtqgVnd: '0' });
    expect(registrationTotals({ cells: { ...form.cells, 'CURRENT_YEAR:CENTRAL': { nextMonth: '300.000.000', ctmtqg: '100.000.000' }, 'OTHER:LOCAL': { nextMonth: 'x', ctmtqg: 'y' } } })).toEqual({ nextMonthVnd: '305000000', ctmtqgVnd: '100000000' });
    expect(registrationTotals({ cells: {} })).toEqual({ nextMonthVnd: '0', ctmtqgVnd: '0' });
  });

  it('saves the registration of the six cells with the cumulative cells and their CTMTQG as they stand', () => {
    const detail = detailOf();
    const form = registrationFormOf(detail);
    const body = registrationBody(detail, { cells: { ...form.cells, 'CURRENT_YEAR:CENTRAL': { nextMonth: '300.000.000', ctmtqg: '100.000.000' }, 'CURRENT_YEAR:LOCAL': { nextMonth: '1', ctmtqg: '' } } });
    expect(body.funding_lines[0]).toEqual({ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000', next_month_vnd: '300000000', next_month_ctmtqg_subset_vnd: '100000000' });
    expect(body.funding_lines[1]).toEqual({ bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '200000000', next_month_vnd: '1' });
    expect(registrationBody(detail, { cells: {} }).funding_lines.every((line) => line.next_month_vnd === '0')).toBe(true);
  });

  it('says what is left of the capital allocated, below zero when more was reported than allocated, and the month the registration is for', () => {
    expect(remainingOf('500000000', '420000000')).toBe('80000000');
    expect(remainingOf('50000000', '70000000')).toBe('-20000000');
    expect(nextMonthOf('2027-01-10')).toEqual({ year: 2027, month: 2 });
    expect(nextMonthOf('2027-12-26')).toEqual({ year: 2028, month: 1 });
    expect(nextMonthOf('soon')).toBeUndefined();
  });
});

describe('the notes and the files of DIS-06 (AC-ST-DIS-004-4)', () => {
  it('starts from the narrative of the report, with empty sections where there is none', () => {
    expect(notesFormOf(detailOf())).toEqual({ results: '', causes: '', solutions: '', proposals: '' });
    expect(notesFormOf(detailOf({ narrative: { results: 'Done', proposals: 'More' } }))).toEqual({ results: 'Done', causes: '', solutions: '', proposals: 'More' });
  });

  it('refuses a section above 4000 characters', () => {
    expect(validateNotes({ results: 'x'.repeat(4000), causes: '', solutions: '', proposals: '' })).toEqual({});
    expect(validateNotes({ results: 'x'.repeat(4001), causes: '  ', solutions: 'y'.repeat(4002), proposals: '' })).toEqual({ results: 'tooLong', solutions: 'tooLong' });
  });

  it('saves the whole narrative: the sections written, trimmed, with the issues as they were named; and an empty one takes it away', () => {
    const detail = detailOf({ narrative: { results: 'Old', linked_issue_ids: [ISSUE] } });
    expect(notesBody(detail, { results: '  New  ', causes: '', solutions: 'S', proposals: ' ' }).narrative).toEqual({ results: 'New', solutions: 'S', linked_issue_ids: [ISSUE] });
    expect(notesBody(detailOf(), { results: 'R', causes: '', solutions: '', proposals: '' }).narrative).toEqual({ results: 'R' });
    expect(notesBody(detailOf(), { results: ' ', causes: '', solutions: '', proposals: '' }).narrative).toEqual({});
  });

  it('hands the structured narrative of the enterprise pack back as it was when the notes are saved, without the empty fields and the trace', () => {
    const detail = detailOf({ narrative: { results: 'Old', enterprise: { status: 'Works', schedule: null, cause_codes: ['SITE_HANDOVER'], directive_refs: [], inheritance: { from_report_id: ISSUE } } } });
    expect(notesBody(detail, { results: 'New', causes: '', solutions: '', proposals: '' }).narrative).toEqual({ results: 'New', enterprise: { status: 'Works', cause_codes: ['SITE_HANDOVER'], directive_refs: [] } });
    expect(notesBody(detail, { results: '', causes: '', solutions: '', proposals: '' }).narrative).toEqual({ linked_issue_ids: [ISSUE] });
  });

  it('saves the whole list of files in the order it is shown, with the cells as they stand', () => {
    const detail = detailOf();
    const files = [toAttachment(fileRecord(2)), toAttachment(fileRecord(1))].flatMap((file) => file ?? []);
    expect(attachmentsBody(detail, files).attachments).toEqual([
      { file_object_id: files[0]?.fileObjectId, file_sha256: 'a'.repeat(64), file_name: 'voucher-2.pdf' },
      { file_object_id: files[1]?.fileObjectId, file_sha256: 'a'.repeat(64), file_name: 'voucher-1.pdf' },
    ]);
    expect(attachmentsBody(detail, []).attachments).toEqual([]);
    expect(attachmentsBody(detail, files).funding_lines).toEqual(keepBody(detail).funding_lines);
  });
});

describe('where a finding of the review is put right', () => {
  const finding = (code: string, field: string) => ({ code, field, values: {} });

  it('leads the volumes to DIS-03, the cumulative cells and the explanation to DIS-04 and the registration to DIS-05, and nothing else anywhere', () => {
    expect(stepOfFinding(finding('VALIDATION_FAILED', 'progress'))).toBe('/dis/dis-03');
    expect(stepOfFinding(finding('VOLUME_EXCEEDS_ALLOCATION', 'progress.construction_vnd'))).toBe('/dis/dis-03');
    expect(stepOfFinding(finding('SUBSET_EXCEEDS_PARENT', 'funding_lines[0].ctmtqg_subset_vnd'))).toBe('/dis/dis-04');
    expect(stepOfFinding(finding('SUBSET_EXCEEDS_PARENT', 'funding_lines[2].next_month_ctmtqg_subset_vnd'))).toBe('/dis/dis-05');
    expect(stepOfFinding(finding('NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT', 'funding_lines'))).toBe('/dis/dis-05');
    expect(stepOfFinding(finding('TREASURY_GAP', 'funding_lines'))).toBe('/dis/dis-04');
    expect(stepOfFinding(finding('NEGATIVE_DELTA_EXPLANATION_REQUIRED', 'negative_delta_explanation'))).toBe('/dis/dis-04');
    for (const field of ['period', 'plan_version', 'status']) expect(stepOfFinding(finding('PERIOD_LOCKED', field))).toBeUndefined();
    expect(stepLink('/dis/dis-06', 'abc')).toBe('/dis/dis-06?report=abc');
  });

  it('names the cell a finding is about when its field names one', () => {
    expect(cellOfFinding(finding('SUBSET_EXCEEDS_PARENT', 'funding_lines[3].ctmtqg_subset_vnd'))).toEqual({ bucket: 'CARRYOVER', level: 'LOCAL' });
    expect(cellOfFinding(finding('SUBSET_EXCEEDS_PARENT', 'funding_lines[9].ctmtqg_subset_vnd'))).toBeUndefined();
    expect(cellOfFinding(finding('PERIOD_LOCKED', 'period'))).toBeUndefined();
  });
});
