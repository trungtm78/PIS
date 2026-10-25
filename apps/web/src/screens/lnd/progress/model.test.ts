import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, canReport, describeProblem, formOf, lateStages, reportBody, reportable, toOverview, toStage, validateReport } from './model';
import type { ReportForm, StageLine } from './model';

const TODAY = '2026-10-24';
const DOCUMENT = '00000000-0000-4000-8000-000000000044';
const UNIT = '00000000-0000-4000-8000-000000000055';
const SECTION = '00000000-0000-4000-8000-000000000066';

const raw = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000077',
  section_id: SECTION,
  plan_id: null,
  stage_code: 'INVENTORY',
  executor_kind: 'LAND_FUND_CENTRE',
  executor_unit_id: UNIT,
  executor_unit_name: 'Trung tâm phát triển quỹ đất',
  mode: 'TRACKED_EXTERNAL',
  planned_start: '2026-06-01',
  planned_end: '2026-08-31',
  actual_start: '2026-06-05',
  actual_end: null,
  parcels_total: 120,
  parcels_done: 45,
  progress_pct: '37.50',
  last_reported_at: '2026-09-01T03:00:00.000Z',
  evidence_document_version_id: DOCUMENT,
  status: 'LATE',
  blocker_issue_id: null,
  blocker_note: null,
  version: 3,
  ...overrides,
});

const form = (overrides: Partial<ReportForm> = {}): ReportForm => ({
  ...EMPTY_FORM,
  sectionId: SECTION,
  stageCode: 'INVENTORY',
  executorKind: 'LAND_FUND_CENTRE',
  executorUnitId: UNIT,
  parcelsTotal: '120',
  parcelsDone: '45',
  evidenceId: DOCUMENT,
  ...overrides,
});

const refusal = (code: string) => describeProblem(new ApiError({ status: 422, code, correlationId: 'c' }));

describe('the model of LND-01 and LND-11 (ST-LND-010)', () => {
  it('reads a stage and drops a row the screen cannot place', () => {
    expect(toStage(raw())).toMatchObject({ stageCode: 'INVENTORY', executorKind: 'LAND_FUND_CENTRE', mode: 'TRACKED_EXTERNAL', parcelsTotal: 120, parcelsDone: 45, progressPct: '37.50', status: 'LATE', executorUnitName: 'Trung tâm phát triển quỹ đất' });
    for (const bad of [{ stage_code: 'DEMOLITION' }, { executor_kind: 'CONTRACTOR' }, { mode: 'MANUAL' }, { status: 'WEIRD' }, { id: 7 }, { section_id: null }]) expect(toStage(raw(bad))).toBeUndefined();
    expect(toStage(undefined)).toBeUndefined();
    expect(toStage(raw({ parcels_total: 'x', progress_pct: undefined, executor_unit_name: undefined }))).toMatchObject({ parcelsTotal: 0, progressPct: '0.00', executorUnitName: '' });
  });

  it('reads the overview as the server counted it, and anything missing as nothing', () => {
    const overview = toOverview({
      project_id: 'p',
      as_of: '2026-10-24T03:00:00.000Z',
      totals: { sections: 2, sections_handed_over: 1, required_area_m2: '60000.00', handed_area_m2: '18000.00', parcels: 10, parcels_noticed: 4, parcels_paid: 2, parcels_handed_over: 1, households: 7, plans_posted: 1, payments_paid: 3, payments_total: 5, late_stages: 1 },
      parcels_by_status: { SURVEYED: 6, PAID: 2 },
      sections: [{ id: SECTION, code: 'KM-0-3', name: 'Km 0 to km 3', status: 'PARTIAL', required_area_m2: '30000.00', handed_area_m2: '18000.00', target_date: '2027-03-01', parcels: 6, parcels_noticed: 3, parcels_paid: 1, parcels_handed_over: 1 }, { code: 'no id' }],
      stages: [raw(), raw({ stage_code: 'WEIRD' })],
    });
    expect(overview.totals).toMatchObject({ sections: 2, parcels: 10, households: 7, paymentsPaid: 3, lateStages: 1, handedAreaM2: '18000.00' });
    expect(overview.parcelsByStatus).toEqual([
      { status: 'SURVEYED', count: 6 },
      { status: 'PAID', count: 2 },
    ]);
    expect(overview.sections).toHaveLength(1);
    expect(overview.stages).toHaveLength(1);
    expect(toOverview(undefined)).toMatchObject({ projectId: '', asOf: null, totals: { parcels: 0, lateStages: 0, requiredAreaM2: '0' }, parcelsByStatus: [], sections: [], stages: [] });
  });

  it('picks the late stages out, and lets a session report only with the permission and not in read-only mode', () => {
    const stages = [toStage(raw()), toStage(raw({ status: 'DONE' }))] as StageLine[];
    expect(lateStages(stages)).toHaveLength(1);
    expect(canReport(['land.progress.report'], 'FULL')).toBe(true);
    expect(canReport(['land.progress.report'], undefined)).toBe(true);
    expect(canReport(['land.progress.report'], 'READ_ONLY')).toBe(false);
    expect(canReport(['land.read'], 'FULL')).toBe(false);
    expect(canReport(undefined, 'FULL')).toBe(false);
    expect(reportable(stages[0] as StageLine)).toBe(true);
    expect(reportable({ ...(stages[0] as StageLine), mode: 'NATIVE' })).toBe(false);
  });

  it('starts the form of a reported stage from what was reported', () => {
    expect(formOf(toStage(raw()) as StageLine)).toEqual({
      sectionId: SECTION,
      stageCode: 'INVENTORY',
      executorKind: 'LAND_FUND_CENTRE',
      executorUnitId: UNIT,
      parcelsTotal: '120',
      parcelsDone: '45',
      plannedStart: '2026-06-01',
      plannedEnd: '2026-08-31',
      actualStart: '2026-06-05',
      actualEnd: '',
      evidenceId: DOCUMENT,
      blockerNote: '',
    });
  });

  it('accepts a report that is in order', () => {
    expect(validateReport(form(), TODAY)).toEqual({});
    expect(validateReport(form({ parcelsDone: '0', evidenceId: '' }), TODAY)).toEqual({});
    expect(validateReport(form({ parcelsDone: '120', actualEnd: '2026-10-20', actualStart: '2026-06-05' }), TODAY)).toEqual({});
  });

  it('asks for the section, the stage and the executor', () => {
    expect(validateReport({ ...EMPTY_FORM }, TODAY)).toEqual({
      sectionId: 'required',
      stageCode: 'required',
      executorKind: 'required',
      executorUnitId: 'required',
      parcelsTotal: 'count',
    });
  });

  it('refuses counts that are not whole numbers within the limit, and more parcels done than the total', () => {
    for (const parcelsTotal of ['', '-1', '1.5', 'abc', '1000001']) expect(validateReport(form({ parcelsTotal }), TODAY).parcelsTotal).toBe('count');
    expect(validateReport(form({ parcelsDone: '-1' }), TODAY).parcelsDone).toBe('count');
    expect(validateReport(form({ parcelsDone: '121' }), TODAY).parcelsDone).toBe('exceeds');
  });

  it('refuses dates that are not dates, out of order or in the future, and an end before every parcel is done', () => {
    expect(validateReport(form({ plannedEnd: '2026-02-30' }), TODAY).plannedEnd).toBe('date');
    expect(validateReport(form({ plannedStart: '2026-09-01', plannedEnd: '2026-08-01' }), TODAY).plannedEnd).toBe('order');
    expect(validateReport(form({ actualStart: '2026-10-25' }), TODAY).actualStart).toBe('future');
    expect(validateReport(form({ parcelsDone: '120', actualEnd: '2026-10-25' }), TODAY).actualEnd).toBe('future');
    expect(validateReport(form({ parcelsDone: '120', actualStart: '2026-10-02', actualEnd: '2026-10-01' }), TODAY).actualEnd).toBe('order');
    expect(validateReport(form({ actualEnd: '2026-10-01' }), TODAY).actualEnd).toBe('endNeedsAll');
  });

  it('asks the evidence of a report that has parcels done or an end, and a document id that is one', () => {
    expect(validateReport(form({ evidenceId: '' }), TODAY).evidenceId).toBe('evidenceRequired');
    expect(validateReport(form({ parcelsDone: '120', actualEnd: '2026-10-01', evidenceId: '  ' }), TODAY).evidenceId).toBe('evidenceRequired');
    expect(validateReport(form({ evidenceId: 'not-an-id' }), TODAY).evidenceId).toBe('evidenceInvalid');
    expect(validateReport(form({ blockerNote: 'x'.repeat(2001) }), TODAY).blockerNote).toBe('tooLong');
  });

  it('builds the body of a tracked report and leaves out what is empty', () => {
    expect(reportBody('p', form())).toEqual({
      project_id: 'p',
      section_id: SECTION,
      stage_code: 'INVENTORY',
      executor_kind: 'LAND_FUND_CENTRE',
      executor_unit_id: UNIT,
      mode: 'TRACKED_EXTERNAL',
      parcels_total: 120,
      parcels_done: 45,
      evidence_document_version_id: DOCUMENT,
    });
    expect(reportBody('p', form({ plannedStart: '2026-06-01', plannedEnd: '2026-08-31', actualStart: '2026-06-05', actualEnd: '2026-10-01', parcelsDone: '120', blockerNote: '  Waiting  ', evidenceId: DOCUMENT.toUpperCase() }))).toMatchObject({
      planned_start: '2026-06-01',
      planned_end: '2026-08-31',
      actual_start: '2026-06-05',
      actual_end: '2026-10-01',
      blocker_note: 'Waiting',
      evidence_document_version_id: DOCUMENT,
    });
  });

  it('sorts a refusal of the server by its code', () => {
    expect(refusal('PARCELS_DONE_EXCEEDS_TOTAL')).toBe('exceeds');
    expect(refusal('NATIVE_STAGE_READONLY')).toBe('nativeReadonly');
    expect(refusal('DOCUMENT_NOT_CLEAN')).toBe('documentNotClean');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(refusal(code)).toBe('validation');
    for (const code of ['SCOPE_DENIED', 'ENTITLEMENT_DENIED']) expect(refusal(code)).toBe('denied');
    expect(refusal('RESOURCE_NOT_FOUND')).toBe('notFound');
    expect(refusal('SESSION_EXPIRED')).toBe('session');
    expect(refusal('SOMETHING_ELSE')).toBe('general');
    expect(describeProblem(new Error('x'))).toBe('general');
  });
});
