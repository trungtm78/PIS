import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  appliedCount,
  describeProblem,
  fieldOfDetail,
  filtersOf,
  instantDay,
  instantOfLocal,
  openBody,
  prepareBody,
  queryOf,
  rateText,
  reasonProblem,
  receiptBody,
  searchOf,
  timeLeft,
  toDetail,
  toPage,
  toRow,
  validateOpen,
  validatePrepare,
  validateReceipt,
  validateSweep,
  vietnamToday,
} from './posting-model';
import { detail, dueSoon, posting, prepared } from './test/posting-test-support';

const problem = (code: string, status = 422, detailText?: string) => new ApiError({ status, code, correlationId: 'c', extensions: {}, ...(detailText === undefined ? {} : { detail: detailText }) });

describe('reading the answer of the API', () => {
  it('reads a duty with its clock, its people, its receipt and what the caller may do, and ignores a row that is not one', () => {
    const [row] = toRow(dueSoon(1));
    expect(row).toMatchObject({ kind: 'NOTICE', state: 'DUE', clock: 'DUE_SOON', alert: 'EGP_POSTING_DUE', severity: 'ACTION', legalStatus: 'UNVERIFIED', ruleSource: 'DEFAULT', actions: { prepare: true, cancel: true, submit: false } });
    expect(toRow({ id: 'x', kind: 'NOPE', state: 'DUE', due_at: '2026-01-01T00:00:00.000Z' })).toEqual([]);
    expect(toRow(null)).toEqual([]);
    expect(toRow({ ...posting(1), state: 'UNKNOWN' })).toEqual([]);
  });

  it('reads a page and refuses an answer that is not one', () => {
    const page = toPage({ items: [posting(1), { bad: true }], next_cursor: 'c', counts: { total: 1, by_state: { DUE: 1 }, overdue: 0, due_soon: 0, met: 0, met_late: 0 }, on_time: { rate_bp: null }, severity_rule: { urgent_within_hours: 24 }, actions: { sweep: true } });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('c');
    expect(page.counts.byState).toEqual({ DUE: 1, PREPARED: 0, SUBMITTED: 0, RECEIPTED: 0, REJECTED: 0, CANCELLED: 0 });
    expect(page.onTime.rateBp).toBeNull();
    expect(page.severityRule).toMatchObject({ urgentWithinHours: 24, unverified: true, source: 'DEFAULT' });
    expect(page.actions).toEqual({ sweep: true, open: false, prepare: false, submit: false });
    expect(() => toPage({})).toThrow('posting-page-invalid');
  });

  it('reads a detail with its history, its fields and the rule of its deadline', () => {
    const read = toDetail(detail(prepared(2)));
    expect(read.requiredFields).toEqual(['package_code', 'published_at', 'bid_closing_at']);
    expect(read.suggestedFields).toEqual({ package_code: 'GT-1' });
    expect(read.deadlineRule).toMatchObject({ dueIn: 5, dueUnit: 'WORKING_DAYS', unverified: true, version: 0 });
    expect(read.history).toHaveLength(1);
    expect(() => toDetail({ obligation: {} })).toThrow('posting-detail-invalid');
  });
});

describe('the filters in the address', () => {
  it('goes to the address and back, and drops what it does not know', () => {
    const filters = filtersOf(new URLSearchParams('group=OPEN&kind=VIOLATION&clock=OVERDUE&mine=true&junk=1&state=x'));
    expect(filters).toEqual({ group: 'OPEN', kind: 'VIOLATION', clock: 'OVERDUE', mine: true });
    expect(searchOf(filters).toString()).toBe('group=OPEN&kind=VIOLATION&clock=OVERDUE&mine=true');
    expect(appliedCount(filters)).toBe(4);
    expect(filtersOf(new URLSearchParams('group=NOPE&kind=NOPE&clock=NOPE&mine=false'))).toEqual({});
  });

  it('asks the server for a page of fifty with the filters and the cursor', () => {
    expect(queryOf({ group: 'OPEN', mine: true }, 'abc')).toEqual({ limit: 50, group: 'OPEN', mine: 'true', cursor: 'abc' });
    expect(queryOf({})).toEqual({ limit: 50 });
  });
});

describe('days, times and numbers', () => {
  it('writes the day in Vietnam, the time left in the unit that reads best, and the rate with its two decimals', () => {
    expect(instantDay('2026-11-09T10:00:00.000Z')).toBe('09/11/2026');
    expect(instantDay('2026-11-09T18:00:00.000Z')).toBe('10/11/2026');
    expect(vietnamToday(new Date('2026-11-08T18:00:00Z'))).toBe('2026-11-09');
    expect(timeLeft(3 * 86_400_000 + 5)).toEqual({ unit: 'days', value: 3 });
    expect(timeLeft(-5 * 3_600_000)).toEqual({ unit: 'hours', value: 5 });
    expect(timeLeft(30_000)).toEqual({ unit: 'minutes', value: 1 });
    expect(rateText(null, 'vi')).toBeNull();
    expect(rateText(6666, 'vi')).toBe('66,66%');
    expect(rateText(10_000, 'en')).toBe('100.00%');
  });

  it('turns a local time in Vietnam into the instant, and refuses what is not a time', () => {
    expect(instantOfLocal('2026-11-08T10:30')?.toISOString()).toBe('2026-11-08T03:30:00.000Z');
    for (const bad of ['', '2026-02-30T10:00', '2026-11-08', '2026-11-08T25:00', 'tomorrow']) expect(instantOfLocal(bad)).toBeUndefined();
  });
});

describe('the rules a command is checked against before the server', () => {
  const required = ['package_code', 'published_at', 'bid_closing_at'];

  it('a packet is every field the kind needs, filled, without a control character; or the id of a batch of the export', () => {
    expect(validatePrepare('NOTICE', required, { fields: { package_code: 'GT-1' }, exportBatchId: '' }, false)).toEqual({ published_at: 'required', bid_closing_at: 'required' });
    expect(validatePrepare('NOTICE', required, { fields: { package_code: 'a\u0007b', published_at: 'x'.repeat(2001), bid_closing_at: '2026-11-20' }, exportBatchId: '' }, false)).toEqual({ package_code: 'control', published_at: 'tooLong' });
    expect(validatePrepare('NOTICE', required, { fields: { package_code: 'GT-1', published_at: 'a', bid_closing_at: 'b' }, exportBatchId: '' }, false)).toEqual({});
    expect(validatePrepare('VIOLATION', [], { fields: {}, exportBatchId: '' }, true)).toEqual({ export_batch_id: 'required' });
    expect(validatePrepare('VIOLATION', [], { fields: {}, exportBatchId: 'not-an-id' }, true)).toEqual({ export_batch_id: 'tooShort' });
    expect(validatePrepare('VIOLATION', [], { fields: {}, exportBatchId: '00000000-0000-4000-8000-0000000000aa' }, true)).toEqual({});
    expect(prepareBody(required, { fields: { package_code: ' GT-1 ', published_at: 'a', bid_closing_at: 'b', extra: 'c' }, exportBatchId: '' }, false)).toEqual({ fields: { package_code: 'GT-1', published_at: 'a', bid_closing_at: 'b' } });
    expect(prepareBody([], { fields: {}, exportBatchId: ' 00000000-0000-4000-8000-0000000000AA ' }, true)).toEqual({ export_batch_id: '00000000-0000-4000-8000-0000000000aa' });
  });

  it('a receipt has a reference of at most a hundred characters, and a time that is real, not in the future and not before the posting', () => {
    const now = new Date('2026-11-08T05:00:00Z');
    const submittedAt = '2026-11-07T03:00:00.000Z';
    expect(validateReceipt({ receiptRef: '', receiptedAt: '' }, now, submittedAt)).toEqual({ receiptRef: 'required' });
    expect(validateReceipt({ receiptRef: 'x'.repeat(101), receiptedAt: '' }, now, submittedAt)).toEqual({ receiptRef: 'tooLong' });
    expect(validateReceipt({ receiptRef: 'BN-1', receiptedAt: 'soon' }, now, submittedAt)).toEqual({ receiptedAt: 'time' });
    expect(validateReceipt({ receiptRef: 'BN-1', receiptedAt: '2026-11-08T13:00' }, now, submittedAt)).toEqual({ receiptedAt: 'future' });
    expect(validateReceipt({ receiptRef: 'BN-1', receiptedAt: '2026-11-07T09:00' }, now, submittedAt)).toEqual({ receiptedAt: 'day' });
    expect(validateReceipt({ receiptRef: 'BN-1', receiptedAt: '2026-11-08T10:00' }, now, submittedAt)).toEqual({});
    expect(receiptBody({ receiptRef: ' BN-1 ', receiptedAt: '' })).toEqual({ receipt_ref: 'BN-1' });
    expect(receiptBody({ receiptRef: 'BN-1', receiptedAt: '2026-11-08T10:00' })).toEqual({ receipt_ref: 'BN-1', receipted_at: '2026-11-08T03:00:00.000Z' });
  });

  it('opening by hand needs the code of the subject and a real day that is not in the future; the project code goes only with a package', () => {
    const today = '2026-11-08';
    expect(validateOpen({ kind: 'NOTICE', ourCode: '', projectCode: '', triggeredOn: '' }, today)).toEqual({ ourCode: 'required', triggeredOn: 'required' });
    expect(validateOpen({ kind: 'NOTICE', ourCode: 'GT-1', projectCode: 'x'.repeat(51), triggeredOn: '2026-02-30' }, today)).toEqual({ projectCode: 'tooLong', triggeredOn: 'day' });
    expect(validateOpen({ kind: 'NOTICE', ourCode: 'GT-1', projectCode: '', triggeredOn: '2026-11-09' }, today)).toEqual({ triggeredOn: 'future' });
    expect(validateOpen({ kind: 'NOTICE', ourCode: 'GT-1', projectCode: 'PRJ-1', triggeredOn: today }, today)).toEqual({});
    expect(openBody({ kind: 'NOTICE', ourCode: ' GT-1 ', projectCode: ' PRJ-1 ', triggeredOn: today })).toEqual({ kind: 'NOTICE', our_code: 'GT-1', our_project_code: 'PRJ-1', triggered_on: today });
    expect(openBody({ kind: 'VIOLATION', ourCode: '0101234567', projectCode: 'PRJ-1', triggeredOn: today })).toEqual({ kind: 'VIOLATION', our_code: '0101234567', triggered_on: today });
  });

  it('a sweep may name no day; a day must be real and not in the future; a reason has the length the move needs', () => {
    expect(validateSweep('', '2026-11-08')).toEqual({});
    expect(validateSweep('2026-02-30', '2026-11-08')).toEqual({ sinceOn: 'day' });
    expect(validateSweep('2026-11-09', '2026-11-08')).toEqual({ sinceOn: 'future' });
    expect(validateSweep('2026-10-01', '2026-11-08')).toEqual({});
    expect(reasonProblem('', 10)).toBe('required');
    expect(reasonProblem('ngắn', 10)).toBe('tooShort');
    expect(reasonProblem('x'.repeat(1001), 10)).toBe('tooLong');
    expect(reasonProblem('đủ mười ký tự', 10)).toBeUndefined();
  });
});

describe('what a refusal of the server means', () => {
  it('names the kind of the refusal and the field it points at', () => {
    expect(describeProblem(problem('SELF_APPROVAL_DENIED', 403))).toEqual({ kind: 'selfApproval', field: undefined });
    expect(describeProblem(problem('VERSION_CONFLICT', 409))).toEqual({ kind: 'versionConflict', field: undefined });
    expect(describeProblem(problem('EGP_OBLIGATION_STATE_INVALID', 409))).toEqual({ kind: 'stateInvalid', field: undefined });
    expect(describeProblem(problem('EGP_RECEIPT_DUPLICATE', 409))).toEqual({ kind: 'receiptDuplicate', field: 'receiptRef' });
    expect(describeProblem(problem('CALENDAR_NOT_EFFECTIVE'))).toEqual({ kind: 'calendar', field: undefined });
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', 404))).toEqual({ kind: 'notFound', field: undefined });
    expect(describeProblem(problem('VALIDATION_FAILED', 422, 'receipted_at'))).toEqual({ kind: 'validation', field: 'receiptedAt' });
    expect(describeProblem(problem('SCOPE_DENIED', 403)).kind).toBe('forbidden');
    expect(describeProblem(problem('INTERNAL_ERROR', 500)).kind).toBe('general');
    expect(describeProblem(new Error('x'))).toEqual({ kind: 'general', field: undefined });
  });

  it('reads the field out of the detail of a refusal, a field of the packet by its own name', () => {
    expect(fieldOfDetail('fields.bid_closing_at')).toBe('bid_closing_at');
    expect(fieldOfDetail('our_project_code')).toBe('projectCode');
    expect(fieldOfDetail('our_code')).toBe('ourCode');
    expect(fieldOfDetail('triggered_on')).toBe('triggeredOn');
    expect(fieldOfDetail('since_on')).toBe('sinceOn');
    expect(fieldOfDetail('export_batch_id')).toBe('export_batch_id');
    expect(fieldOfDetail('nothing known')).toBeUndefined();
    expect(fieldOfDetail(undefined)).toBeUndefined();
  });
});
