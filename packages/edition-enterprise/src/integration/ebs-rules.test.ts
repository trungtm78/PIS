import { DomainError, planFileImport } from '@machvon/kernel';
import {
  EBS_FORMAT,
  EBS_LAYOUT_VERSION,
  assertEbsApplyAllowed,
  assertEbsLayoutKnown,
  assertEbsReassign,
  diffEbs,
  ebsAcceptance,
  ebsConnectionMove,
  ebsFingerprint,
  ebsHealthOf,
  ebsKeyOf,
  ebsPeriodEnd,
  ebsReasonOf,
  ebsReconcileParamsOf,
  isEbsPeriod,
  normalisedAmount,
  openEbsItems,
  pickEbsOwner,
  resolveEbsItem,
  sumAmounts,
} from './ebs-rules.ts';
import type { EbsFigures, EbsItem } from './ebs-rules.ts';

const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const HEADER = 'project_code,period,extract_date,disbursed_vnd,committed_vnd';

const failure = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('the layout of the Oracle EBS file (a working assumption, PENDING-EXTERNAL)', () => {
  it('says so: the version is a working assumption and cannot be accepted', () => {
    expect(EBS_LAYOUT_VERSION).toBe('WORKING-ASSUMPTION-2026.1');
    expect(ebsAcceptance(EBS_LAYOUT_VERSION)).toBe('PENDING_EXTERNAL');
    expect(ebsAcceptance('EBS-2027.1')).toBe('ACCEPTABLE');
    expect(assertEbsLayoutKnown(undefined)).toBe(EBS_LAYOUT_VERSION);
    const error = failure(() => assertEbsLayoutKnown('EBS-2027.1'));
    expect(error).toMatchObject({ code: 'EBS_LAYOUT_VERSION_UNKNOWN', status: 422 });
    expect(error.extensions).toEqual({ layout_version: 'EBS-2027.1', supported: [EBS_LAYOUT_VERSION] });
  });

  it('accepts a good row and keeps the amounts as exact decimals', () => {
    const plan = planFileImport(EBS_FORMAT, csv(HEADER, 'PRJ-001,2026-10,2026-11-02,1500000.00,9000000.50'));
    const row = plan.rows[0];
    expect(row?.accepted).toBe(true);
    if (row?.accepted !== true) return;
    expect(row.row.businessKey).toBe('PRJ-001|2026-10|2026-11-02');
    expect(row.row.record).toEqual({ projectCode: 'PRJ-001', period: '2026-10', extractDate: '2026-11-02', disbursedVnd: '1500000', committedVnd: '9000000.5' });
    expect(row.row.measure).toBe('1500000');
  });

  it('compares the header without case, spaces or hyphens, and leaves an empty amount empty', () => {
    const plan = planFileImport(EBS_FORMAT, csv('Project Code,PERIOD,Extract-Date,Disbursed VND,committed_vnd', 'PRJ-1,2026-09,2026-10-01,,500'));
    const row = plan.rows[0];
    expect(row?.accepted).toBe(true);
    if (row?.accepted !== true) return;
    expect(row.row.record.disbursedVnd).toBeNull();
    expect(row.row.record.committedVnd).toBe('500');
    expect(row.row.measure).toBeUndefined();
  });

  it.each([
    ['REQUIRED', 'project_code', ',2026-10,2026-11-02,1,1'],
    ['CODE_INVALID', 'project_code', '!bad,2026-10,2026-11-02,1,1'],
    ['REQUIRED', 'period', 'P1,,2026-11-02,1,1'],
    ['PERIOD_INVALID', 'period', 'P1,2026-13,2026-11-02,1,1'],
    ['REQUIRED', 'extract_date', 'P1,2026-10,,1,1'],
    ['DATE_INVALID', 'extract_date', 'P1,2026-10,2026-02-30,1,1'],
    ['AMOUNT_INVALID', 'disbursed_vnd', 'P1,2026-10,2026-11-02,1.234.567,1'],
    ['AMOUNT_INVALID', 'committed_vnd', 'P1,2026-10,2026-11-02,1,12abc'],
    ['REQUIRED', 'disbursed_vnd', 'P1,2026-10,2026-11-02,,'],
  ])('rejects %s on %s with the line of the fault', (code, field, line) => {
    const plan = planFileImport(EBS_FORMAT, csv(HEADER, line));
    const row = plan.rows[0];
    expect(row?.accepted).toBe(false);
    if (row === undefined || row.accepted) return;
    expect(row.rejection).toEqual({ code, field });
    expect(row.line).toBe(2);
  });

  it('refuses a file with a missing or repeated column as unreadable, naming the columns', () => {
    const missing = failure(() => planFileImport(EBS_FORMAT, csv('project_code,period', 'P1,2026-10')));
    expect(missing).toMatchObject({ code: 'IMPORT_SCHEMA_INVALID', status: 422 });
    expect(missing.extensions).toEqual({ missing_columns: ['extract_date', 'disbursed_vnd', 'committed_vnd'] });
    const repeated = failure(() => planFileImport(EBS_FORMAT, csv(`${HEADER},Period`, 'P1,2026-10,2026-11-02,1,1,2026-10')));
    expect(repeated.extensions).toEqual({ duplicate_columns: true });
  });

  it('takes a repeat of the same row inside a file as a harmless duplicate and the same key with other figures as a conflict', () => {
    const plan = planFileImport(EBS_FORMAT, csv(HEADER, 'P1,2026-10,2026-11-02,10,20', 'P1,2026-10,2026-11-02,10.00,20', 'P1,2026-10,2026-11-02,11,20', 'P2,2026-10,2026-11-02,5,5'));
    const outcomes = plan.rows.map((row) => (row.accepted ? 'ok' : row.rejection.code));
    expect(outcomes).toEqual(['ok', 'ROW_DUPLICATE', 'ROW_CONFLICT', 'ok']);
  });

  it('treats another extract of the same period as another fact', () => {
    const plan = planFileImport(EBS_FORMAT, csv(HEADER, 'P1,2026-10,2026-11-02,10,20', 'P1,2026-10,2026-11-09,11,20'));
    expect(plan.rows.every((row) => row.accepted)).toBe(true);
    expect(ebsKeyOf({ projectCode: 'P1', period: '2026-10', extractDate: '2026-11-09' })).toBe('P1|2026-10|2026-11-09');
  });

  it('masks nothing it should not: every column may be shown beside an error', () => {
    const shown = EBS_FORMAT.mask?.({ project_code: ' P1 ', period: '2026-10', extract_date: '2026-11-02', disbursed_vnd: '1', committed_vnd: '2', other: 'x' });
    expect(shown).toEqual({ project_code: 'P1', period: '2026-10', extract_date: '2026-11-02', disbursed_vnd: '1', committed_vnd: '2' });
  });

  it('normalises amounts', () => {
    expect(normalisedAmount('12.00')).toBe('12');
    expect(normalisedAmount('12.50')).toBe('12.5');
    expect(normalisedAmount('007')).toBe('7');
    expect(normalisedAmount('-0.00')).toBe('0');
    expect(normalisedAmount('-3.10')).toBe('-3.1');
    expect(sumAmounts(['1.5', '2.25', '-1'])).toBe('2.75');
  });

  it('knows the end of a period', () => {
    expect(ebsPeriodEnd('2026-02')).toBe('2026-02-28');
    expect(ebsPeriodEnd('2028-02')).toBe('2028-02-29');
    expect(ebsPeriodEnd('2026-12')).toBe('2026-12-31');
    expect(failure(() => ebsPeriodEnd('2026-1')).detail).toBe('period');
    expect(isEbsPeriod('2026-10')).toBe(true);
    expect(isEbsPeriod('2026-M10')).toBe(false);
  });
});

describe('the connection', () => {
  it('moves with a reason and refuses a move to the state it is in', () => {
    expect(ebsConnectionMove({ enabled: true }, { enabled: false, reason: 'the extract is being redesigned' })).toEqual({ enabled: false, reason: 'the extract is being redesigned' });
    expect(failure(() => ebsConnectionMove({ enabled: false }, { enabled: false, reason: 'the extract is being redesigned' })).detail).toBe('enabled');
    expect(failure(() => ebsConnectionMove({ enabled: true }, { enabled: 1, reason: 'the extract is being redesigned' })).detail).toBe('enabled');
  });

  it('refuses an apply while it is off', () => {
    expect(failure(() => assertEbsApplyAllowed({ enabled: false })).code).toBe('EBS_CONNECTION_DISABLED');
    expect(() => assertEbsApplyAllowed({ enabled: true })).not.toThrow();
  });

  it('judges the age of the last file, and never calls a connector with no file stale', () => {
    const params = { max_age_hours: 168, warn_after_hours: 120, stale_severity: 'WATCH' as const, figures_blocked_when_stale: false };
    const now = new Date('2026-11-08T00:00:00Z');
    const old = new Date(now.getTime() - 200 * 3_600_000);
    expect(ebsHealthOf({ lastImportAt: old, now, params })).toMatchObject({ status: 'STALE', adapterStatus: 'PROPOSED', acceptance: 'PENDING_EXTERNAL', alert: { code: 'CONNECTOR_STALE', severity: 'WATCH' } });
    expect(ebsHealthOf({ lastImportAt: null, now, params })).toMatchObject({ status: 'NEVER_IMPORTED', alert: null });
  });

  it('reads the number of the rule', () => {
    expect(ebsReconcileParamsOf({ due_in_working_days: 5 })).toEqual({ due_in_working_days: 5 });
    expect(() => ebsReconcileParamsOf({ due_in_working_days: 0 })).toThrow('due_in_working_days');
  });
});

describe('the comparison of our figures with the statement of EBS', () => {
  const figures = (disbursed: string | null, committed: string | null): EbsFigures => ({ DISBURSED_VND: disbursed, COMMITTED_VND: committed });

  it('finds nothing when the figures are equal to the last decimal', () => {
    expect(diffEbs(figures('1000', '5000.5'), figures('1000', '5000.5'))).toEqual([]);
  });

  it('gives each differing measure with the signed difference theirs minus ours', () => {
    expect(diffEbs(figures('1000', '5000'), figures('1200', '4900.5'))).toEqual([
      { measure: 'DISBURSED_VND', kind: 'AMOUNT_MISMATCH', ours: '1000', theirs: '1200', delta: '200' },
      { measure: 'COMMITTED_VND', kind: 'AMOUNT_MISMATCH', ours: '5000', theirs: '4900.5', delta: '-99.5' },
    ]);
  });

  it('says MISSING_OURS when EBS states a figure and we hold nothing, and compares nothing EBS does not state', () => {
    expect(diffEbs(figures(null, '5000'), figures('700', null))).toEqual([{ measure: 'DISBURSED_VND', kind: 'MISSING_OURS', ours: null, theirs: '700', delta: null }]);
    expect(diffEbs(figures('1', '2'), figures(null, null))).toEqual([]);
  });

  it('fingerprints both sides: the same figures give the same print and a moved figure another', () => {
    const one = ebsFingerprint({ projectCode: 'P1', period: '2026-10', measure: 'DISBURSED_VND', ours: '1', theirs: '2' });
    expect(one).toBe(ebsFingerprint({ projectCode: 'P1', period: '2026-10', measure: 'DISBURSED_VND', ours: '1', theirs: '2' }));
    expect(one).not.toBe(ebsFingerprint({ projectCode: 'P1', period: '2026-10', measure: 'DISBURSED_VND', ours: '1', theirs: '3' }));
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the item of a difference: owner, makers, explanation', () => {
  const NOW = new Date('2026-11-08T03:00:00Z');
  const DUE = new Date('2026-11-13T16:59:59.999Z');
  const mismatch = { measure: 'DISBURSED_VND' as const, kind: 'AMOUNT_MISMATCH' as const, ours: '1000', theirs: '1200', delta: '200' };
  const open = (): EbsItem => openEbsItems({ projectCode: 'P1', period: '2026-10', differences: [mismatch], ownerId: 'owner', makerIds: ['loader', 'runner'], openedAt: NOW, dueAt: DUE })[0] as EbsItem;

  it('picks the person asked for if they are a candidate and not a maker, then the first candidate who is not, else nobody', () => {
    expect(pickEbsOwner(['a', 'asked'], ['x'], 'asked')).toBe('asked');
    expect(pickEbsOwner(['a', 'asked'], ['x', 'asked'], 'asked')).toBe('a');
    // A person who is not a candidate (not an active holder of the right) is never taken, however they were named.
    expect(pickEbsOwner(['a', 'b'], ['x'], 'stranger')).toBe('a');
    expect(pickEbsOwner(['x'], ['x'], 'stranger')).toBeUndefined();
    expect(pickEbsOwner(['x', 'b'], ['x'])).toBe('b');
    expect(pickEbsOwner(['x'], ['x'])).toBeUndefined();
  });

  it('opens an item with its owner, makers and due time, and never gives it to a maker', () => {
    const item = open();
    expect(item).toMatchObject({ projectCode: 'P1', measure: 'DISBURSED_VND', state: 'OPEN', ownerId: 'owner', makerIds: ['loader', 'runner'], dueAt: DUE.toISOString(), resolution: null });
    expect(failure(() => openEbsItems({ projectCode: 'P1', period: '2026-10', differences: [mismatch], ownerId: 'loader', makerIds: ['loader'], openedAt: NOW, dueAt: DUE })).code).toBe('SELF_APPROVAL_DENIED');
  });

  const settle = (patch: Record<string, unknown> = {}, actorId = 'owner', item: EbsItem = open()) =>
    resolveEbsItem(item, { kind: 'OURS_WRONG', actorId, at: NOW, reason: 'the payment of 200 was booked in the wrong month', evidenceRef: 'TICKET-77', ...patch }, '2026-11-08');

  it('is settled by its owner with an explanation and the evidence the kind needs', () => {
    const done = settle();
    expect(done.state).toBe('RESOLVED');
    expect(done.resolution).toEqual({ kind: 'OURS_WRONG', resolvedById: 'owner', resolvedAt: NOW.toISOString(), reason: 'the payment of 200 was booked in the wrong month', evidenceRef: 'TICKET-77', reviewOn: null });
    expect(settle({ kind: 'EBS_WRONG' }).resolution?.kind).toBe('EBS_WRONG');
  });

  it('needs the day it is looked at again for a timing difference and a waiver, from tomorrow to a year ahead', () => {
    expect(settle({ kind: 'TIMING', evidenceRef: undefined, reviewOn: '2026-11-20' }).resolution).toMatchObject({ kind: 'TIMING', reviewOn: '2026-11-20', evidenceRef: null });
    expect(settle({ kind: 'WAIVED', evidenceRef: undefined, reviewOn: '2027-11-08' }).resolution?.kind).toBe('WAIVED');
    for (const reviewOn of [undefined, '2026-11-08', '2026-11-07', '2027-11-09', 'soon', 7]) expect(failure(() => settle({ kind: 'TIMING', evidenceRef: undefined, reviewOn })).detail).toBe('review_on');
  });

  it('needs the evidence for a correction and ignores a day nobody asked for', () => {
    expect(failure(() => settle({ evidenceRef: undefined })).detail).toBe('evidence_ref');
    expect(failure(() => settle({ evidenceRef: '' })).detail).toBe('evidence_ref');
    expect(failure(() => settle({ evidenceRef: 'two\nlines' })).detail).toBe('evidence_ref');
    expect(failure(() => settle({ evidenceRef: 7 })).detail).toBe('evidence_ref');
    expect(settle({ reviewOn: '2026-12-01' }).resolution?.reviewOn).toBeNull();
  });

  it('is settled only while open, by its owner and never by a maker, with an explanation, and tells a stale screen first', () => {
    const closed = settle();
    expect(failure(() => settle({}, 'owner', closed)).code).toBe('EBS_ITEM_STATE_INVALID');
    expect(failure(() => settle({}, 'somebody')).code).toBe('SCOPE_DENIED');
    const owned = { ...open(), ownerId: 'loader' };
    expect(failure(() => settle({}, 'loader', owned)).code).toBe('SELF_APPROVAL_DENIED');
    expect(failure(() => settle({ reason: 'short' })).detail).toBe('reason');
    expect(failure(() => settle({ kind: 'NOT_A_KIND' })).detail).toBe('kind');
    expect(ebsReasonOf('  ten chars!  ')).toBe('ten chars!');
    expect(failure(() => ebsReasonOf(5)).detail).toBe('reason');
  });

  it('is handed only while open and never to a maker', () => {
    expect(() => assertEbsReassign(open(), 'new-owner')).not.toThrow();
    expect(failure(() => assertEbsReassign(open(), 'runner')).code).toBe('SELF_APPROVAL_DENIED');
    expect(failure(() => assertEbsReassign(settle(), 'new-owner')).code).toBe('EBS_ITEM_STATE_INVALID');
  });
});
