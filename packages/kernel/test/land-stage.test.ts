import { EXECUTOR_KINDS, MAX_STAGE_PARCELS, STAGE_CODES, STAGE_MODES, STAGE_STATUSES, stageIssues, stageStatusOf } from '../src/land-stage';

const FACTS = { parcelsTotal: 10, parcelsDone: 0, plannedEnd: null, actualStart: null, actualEnd: null, blocked: false };
const REPORT = { parcelsTotal: 10, parcelsDone: 4, plannedStart: '2026-01-01', plannedEnd: '2026-06-30', actualStart: '2026-01-05', actualEnd: null, tracked: true, hasEvidence: true, today: '2026-03-01' };

describe('stages of land clearance (ST-LND-010)', () => {
  it('names the nine stages, the three executors, the two modes and the five statuses of the table', () => {
    expect(STAGE_CODES).toHaveLength(9);
    expect(EXECUTOR_KINDS).toEqual(['PROJECT_OWNER', 'LAND_FUND_CENTRE', 'DISTRICT_BOARD']);
    expect(STAGE_MODES).toEqual(['NATIVE', 'TRACKED_EXTERNAL']);
    expect(STAGE_STATUSES).toEqual(['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'LATE']);
  });

  it('says a stage with an end is done, whatever else is true', () => {
    expect(stageStatusOf({ ...FACTS, parcelsDone: 10, actualEnd: '2026-02-01', plannedEnd: '2026-01-01', blocked: true }, '2026-03-01')).toBe('DONE');
  });

  it('says a stage is late the day after its planned end, and not on the planned day', () => {
    expect(stageStatusOf({ ...FACTS, plannedEnd: '2026-03-01' }, '2026-03-01')).toBe('NOT_STARTED');
    expect(stageStatusOf({ ...FACTS, plannedEnd: '2026-02-28' }, '2026-03-01')).toBe('LATE');
    expect(stageStatusOf({ ...FACTS, parcelsDone: 3, plannedEnd: '2026-02-28', blocked: true }, '2026-03-01')).toBe('LATE');
  });

  it('says a blocked stage is blocked, and a stage that has begun is in progress', () => {
    expect(stageStatusOf({ ...FACTS, blocked: true, plannedEnd: '2026-12-31' }, '2026-03-01')).toBe('BLOCKED');
    expect(stageStatusOf({ ...FACTS, parcelsDone: 1 }, '2026-03-01')).toBe('IN_PROGRESS');
    expect(stageStatusOf({ ...FACTS, actualStart: '2026-02-01' }, '2026-03-01')).toBe('IN_PROGRESS');
    expect(stageStatusOf(FACTS, '2026-03-01')).toBe('NOT_STARTED');
  });

  it('accepts a report that is in order', () => {
    expect(stageIssues(REPORT)).toEqual([]);
    expect(stageIssues({ ...REPORT, tracked: false, hasEvidence: false })).toEqual([]);
    expect(stageIssues({ ...REPORT, parcelsDone: 0, hasEvidence: false })).toEqual([]);
    expect(stageIssues({ ...REPORT, parcelsDone: 10, actualEnd: '2026-03-01' })).toEqual([]);
  });

  it('refuses counts that are not whole numbers within the limit, and a done count above the total', () => {
    expect(stageIssues({ ...REPORT, parcelsTotal: -1 })).toContainEqual({ field: 'parcels_total', problem: 'PARCELS_NOT_COUNTS' });
    expect(stageIssues({ ...REPORT, parcelsTotal: 1.5 })).toContainEqual({ field: 'parcels_total', problem: 'PARCELS_NOT_COUNTS' });
    expect(stageIssues({ ...REPORT, parcelsDone: MAX_STAGE_PARCELS + 1 })).toContainEqual({ field: 'parcels_done', problem: 'PARCELS_NOT_COUNTS' });
    expect(stageIssues({ ...REPORT, parcelsDone: 11 })).toEqual([{ field: 'parcels_done', problem: 'PARCELS_DONE_EXCEEDS_TOTAL' }]);
  });

  it('refuses dates out of order, actual dates in the future and an end before every parcel is done', () => {
    expect(stageIssues({ ...REPORT, plannedStart: '2026-07-01' })).toEqual([{ field: 'planned_end', problem: 'DATES_OUT_OF_ORDER' }]);
    expect(stageIssues({ ...REPORT, parcelsDone: 10, actualStart: '2026-02-10', actualEnd: '2026-02-01' })).toEqual([{ field: 'actual_end', problem: 'DATES_OUT_OF_ORDER' }]);
    expect(stageIssues({ ...REPORT, actualStart: '2026-03-02' })).toEqual([{ field: 'actual_start', problem: 'DATE_IN_FUTURE' }]);
    expect(stageIssues({ ...REPORT, parcelsDone: 10, actualEnd: '2026-03-02' })).toEqual([{ field: 'actual_end', problem: 'DATE_IN_FUTURE' }]);
    expect(stageIssues({ ...REPORT, actualEnd: '2026-02-01' })).toEqual([{ field: 'actual_end', problem: 'END_BEFORE_ALL_DONE' }]);
  });

  it('asks the evidence of a tracked stage that reports progress or an end', () => {
    expect(stageIssues({ ...REPORT, hasEvidence: false })).toEqual([{ field: 'evidence_document_version_id', problem: 'EVIDENCE_REQUIRED' }]);
    expect(stageIssues({ ...REPORT, parcelsDone: 10, actualEnd: '2026-02-01', hasEvidence: false })).toEqual([{ field: 'evidence_document_version_id', problem: 'EVIDENCE_REQUIRED' }]);
    expect(stageIssues({ ...REPORT, parcelsDone: 0, hasEvidence: false })).toEqual([]);
  });
});
