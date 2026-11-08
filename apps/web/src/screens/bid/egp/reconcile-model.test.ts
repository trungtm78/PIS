import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { deltaText, valueText } from './reconcile-labels';
import {
  EMPTY_RESOLVE,
  MIN_REASON,
  appliedCount,
  describeProblem,
  fieldOfDetail,
  filtersOf,
  queryOf,
  resolveBody,
  searchOf,
  toItem,
  toPage,
  toRunResult,
  totalOf,
  validateResolve,
  vietnamToday,
} from './reconcile-model';
import { item, settled } from './test/reconcile-test-support';

const refusal = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions: {}, ...(detail === undefined ? {} : { detail }) });
const TODAY = '2026-11-12';
const identity = (key: string): string => key;

describe('reconcile-model: reading the answer', () => {
  it('reads an open item and a settled one and drops a row that is not an item', () => {
    const [open] = toItem(item(1));
    expect(open).toMatchObject({ subjectType: 'PACKAGE', field: 'estimated_price', ours: '1000000000', theirs: '1200000000', delta: '200000000', state: 'OPEN', resolution: null, version: 1, isMaker: false, canResolve: true, overdue: false });
    const [done] = toItem(settled(2));
    expect(done?.resolution).toMatchObject({ kind: 'DISPUTE', resolvedByName: 'Nguyễn Văn An', evidenceRef: 'CV-77/SKHDT', reviewOn: null, followUp: 'ESCALATE_TO_OPERATOR' });
    expect(done?.canResolve).toBe(false);
    for (const bad of [null, 'x', {}, item(1, { state: 'NOPE' }), item(1, { subject_type: 'PROJECT' }), item(1, { field: '' }), item(1, { id: 5 })]) expect(toItem(bad)).toEqual([]);
    expect(toItem(item(1, { resolution: { kind: 'NOPE' } }))[0]?.resolution).toBeNull();
    expect(toItem(item(1, { difference_kind: 'WEIRD' }))[0]?.differenceKind).toBe('VALUE_MISMATCH');
  });

  it('reads a page with its counts, its rule and what the caller may do, and refuses an answer that is not a page', () => {
    const page = toPage({
      items: [item(1), { broken: true }],
      next_cursor: 'c2',
      counts: { open: 3, resolved: 2, overdue: 1, waivers_due: 1, by_resolution: { DISPUTE: 2 } },
      due_rule: { days: 10, version: 0, source: 'DEFAULT', unverified: true, legal_status: 'UNVERIFIED', formula: 'f', source_text: 's', as_of: '2026-11-08' },
      formula: 'F',
      source: 'S',
      acceptance: 'PENDING_EXTERNAL',
      actions: { run: true, resolve: true },
      as_of: '2026-11-12T03:00:00.000Z',
    });
    expect(page.items).toHaveLength(1);
    expect(page).toMatchObject({ nextCursor: 'c2', canRun: true, formula: 'F', source: 'S', acceptance: 'PENDING_EXTERNAL' });
    expect(page.counts).toEqual({ open: 3, resolved: 2, overdue: 1, waiversDue: 1, byResolution: { ACCEPT_EXTERNAL: 0, CORRECT_OURS: 0, DISPUTE: 2, WAIVE: 0 } });
    expect(page.dueRule).toMatchObject({ days: 10, source: 'DEFAULT', unverified: true, legalStatus: 'UNVERIFIED' });
    expect(totalOf(page.counts)).toBe(5);
    expect(() => toPage({})).toThrow('reconciliation-page-invalid');
    // A rule the answer does not describe is never taken for a verified one.
    expect(toPage({ items: [] }).dueRule.unverified).toBe(true);
    expect(toPage({ items: [] }).canRun).toBe(false);
  });

  it('reads the result of a run', () => {
    expect(toRunResult({ examined: 4, differences: 3, opened: 2, unchanged: 1, settled_already: 0, no_owner: 1, items: [] })).toEqual({ examined: 4, differences: 3, opened: 2, unchanged: 1, settledAlready: 0, noOwner: 1 });
    expect(toRunResult(null)).toEqual({ examined: 0, differences: 0, opened: 0, unchanged: 0, settledAlready: 0, noOwner: 0 });
  });
});

describe('reconcile-model: the filters in the address', () => {
  it('reads and writes the state, the subject, mine and overdue, and ignores what it does not know', () => {
    const filters = filtersOf(new URLSearchParams('state=OPEN&subject_type=NOTICE&mine=true&overdue=true&x=1'));
    expect(filters).toEqual({ state: 'OPEN', subject_type: 'NOTICE', mine: true, overdue: true });
    expect(searchOf(filters).toString()).toBe('state=OPEN&subject_type=NOTICE&mine=true&overdue=true');
    expect(filtersOf(new URLSearchParams('state=NOPE&subject_type=PROJECT&mine=yes&overdue=1'))).toEqual({});
    expect(appliedCount(filters)).toBe(4);
    expect(appliedCount({})).toBe(0);
  });

  it('asks the server for the filters, the page size and the cursor', () => {
    expect(queryOf({})).toEqual({ limit: 50 });
    expect(queryOf({ state: 'RESOLVED', subject_type: 'RESULT', mine: true, overdue: true }, 'c')).toEqual({ limit: 50, state: 'RESOLVED', subject_type: 'RESULT', mine: 'true', overdue: 'true', cursor: 'c' });
  });
});

describe('reconcile-model: the rules of a resolution', () => {
  const valid = { ...EMPTY_RESOLVE, reason: 'Số trên mạng đúng theo thông báo' };

  it('takes ten characters for accepting and correcting, and twenty for disputing and waiving', () => {
    expect(MIN_REASON).toEqual({ ACCEPT_EXTERNAL: 10, CORRECT_OURS: 10, DISPUTE: 20, WAIVE: 20 });
    expect(validateResolve(valid, TODAY)).toEqual({});
    expect(validateResolve({ ...valid, reason: '' }, TODAY)).toEqual({ reason: 'required' });
    expect(validateResolve({ ...valid, reason: ' '.repeat(12) }, TODAY)).toEqual({ reason: 'required' });
    expect(validateResolve({ ...valid, reason: 'ngắn quá' }, TODAY)).toEqual({ reason: 'tooShort' });
    expect(validateResolve({ ...valid, kind: 'CORRECT_OURS', reason: '1234567890' }, TODAY)).toEqual({});
    expect(validateResolve({ ...valid, kind: 'DISPUTE', evidenceRef: 'CV-1', reason: '1234567890123456789' }, TODAY)).toEqual({ reason: 'tooShort' });
    expect(validateResolve({ ...valid, reason: 'x'.repeat(1001) }, TODAY)).toEqual({ reason: 'tooLong' });
  });

  it('wants the letter of a dispute and a day for a waiver after today and within a year', () => {
    const dispute = { ...valid, kind: 'DISPUTE' as const, reason: 'Số trên mạng sai so với quyết định' };
    expect(validateResolve(dispute, TODAY)).toEqual({ evidenceRef: 'required' });
    expect(validateResolve({ ...dispute, evidenceRef: '  ' }, TODAY)).toEqual({ evidenceRef: 'required' });
    expect(validateResolve({ ...dispute, evidenceRef: 'x'.repeat(201) }, TODAY)).toEqual({ evidenceRef: 'tooLong' });
    expect(validateResolve({ ...dispute, evidenceRef: 'x'.repeat(200) }, TODAY)).toEqual({});
    const waive = { ...valid, kind: 'WAIVE' as const, reason: 'Để lại đến khi có biên bản xác nhận' };
    expect(validateResolve(waive, TODAY)).toEqual({ reviewOn: 'required' });
    expect(validateResolve({ ...waive, reviewOn: '2026-02-30' }, TODAY)).toEqual({ reviewOn: 'day' });
    expect(validateResolve({ ...waive, reviewOn: 'ngày mai' }, TODAY)).toEqual({ reviewOn: 'day' });
    expect(validateResolve({ ...waive, reviewOn: TODAY }, TODAY)).toEqual({ reviewOn: 'notFuture' });
    expect(validateResolve({ ...waive, reviewOn: '2026-11-01' }, TODAY)).toEqual({ reviewOn: 'notFuture' });
    expect(validateResolve({ ...waive, reviewOn: '2026-11-13' }, TODAY)).toEqual({});
    expect(validateResolve({ ...waive, reviewOn: '2027-11-12' }, TODAY)).toEqual({});
    expect(validateResolve({ ...waive, reviewOn: '2027-11-13' }, TODAY)).toEqual({ reviewOn: 'tooFar' });
  });

  it('puts into the body only what the kind needs', () => {
    expect(resolveBody(valid, '  Số trên mạng đúng theo thông báo  ')).toEqual({ kind: 'ACCEPT_EXTERNAL', reason: 'Số trên mạng đúng theo thông báo' });
    expect(resolveBody({ ...valid, kind: 'DISPUTE', evidenceRef: ' CV-1 ', reviewOn: '2027-01-01' }, 'Số trên mạng sai so với quyết định')).toEqual({ kind: 'DISPUTE', reason: 'Số trên mạng sai so với quyết định', evidence_ref: 'CV-1' });
    expect(resolveBody({ ...valid, kind: 'WAIVE', evidenceRef: 'CV-1', reviewOn: '2027-01-01' }, 'Để lại đến khi có biên bản xác nhận')).toEqual({ kind: 'WAIVE', reason: 'Để lại đến khi có biên bản xác nhận', review_on: '2027-01-01' });
  });

  it('counts the day in Vietnam: a moment after 17:00 UTC is already the next day', () => {
    expect(vietnamToday(new Date('2026-11-12T16:59:00Z'))).toBe('2026-11-12');
    expect(vietnamToday(new Date('2026-11-12T17:00:00Z'))).toBe('2026-11-13');
  });
});

describe('reconcile-model: what a refusal means', () => {
  it('names each refusal of the server', () => {
    expect(describeProblem(refusal('SELF_APPROVAL_DENIED', 403))).toEqual({ kind: 'selfApproval', field: undefined });
    expect(describeProblem(refusal('VERSION_CONFLICT', 409)).kind).toBe('versionConflict');
    expect(describeProblem(refusal('EGP_RECONCILIATION_STATE_INVALID', 409)).kind).toBe('stateInvalid');
    expect(describeProblem(refusal('CALENDAR_NOT_EFFECTIVE')).kind).toBe('calendar');
    expect(describeProblem(refusal('RESOURCE_NOT_FOUND', 404)).kind).toBe('notFound');
    expect(describeProblem(refusal('SCOPE_DENIED', 403)).kind).toBe('forbidden');
    expect(describeProblem(refusal('BOOM', 500)).kind).toBe('general');
    expect(describeProblem(new Error('x')).kind).toBe('general');
  });

  it('takes the field a validation names, the first it names', () => {
    expect(describeProblem(refusal('VALIDATION_FAILED', 422, 'evidence_ref')).field).toBe('evidenceRef');
    expect(describeProblem(refusal('VALIDATION_FAILED', 422, 'review_on')).field).toBe('reviewOn');
    expect(describeProblem(refusal('VALIDATION_FAILED', 422, 'reason')).field).toBe('reason');
    expect(describeProblem(refusal('VALIDATION_FAILED', 422, 'kind')).field).toBe('kind');
    expect(describeProblem(refusal('VALIDATION_FAILED', 422, 'owner_id')).field).toBe('owner');
    expect(describeProblem(refusal('VALIDATION_FAILED', 422, 'something else')).field).toBeUndefined();
    expect(fieldOfDetail('review_on must follow reason')).toBe('reviewOn');
    expect(fieldOfDetail(undefined)).toBeUndefined();
  });
});

describe('reconcile-labels: the figures as a person reads them', () => {
  it('groups an amount, writes a day as dd/mm/yyyy in Vietnam, and says nothing as "none"', () => {
    expect(valueText(identity, 'vi', 'estimated_price', '1200000000')).toBe('1.200.000.000');
    expect(valueText(identity, 'vi', 'bid_closing_at', '2026-10-25T17:30:00.000Z')).toBe('26/10/2026');
    expect(valueText(identity, 'vi', 'approved_on', '2026-10-25')).toBe('25/10/2026');
    expect(valueText(identity, 'vi', 'selection_method', 'OPEN_BIDDING')).toBe('OPEN_BIDDING');
    expect(valueText(identity, 'vi', 'package_name', null)).toBe('egp.reconcile.cell.none');
  });

  it('signs a difference of an amount and leaves anything else as it is', () => {
    expect(deltaText('vi', 'award_price', '50000000')).toBe('+50.000.000');
    expect(deltaText('vi', 'award_price', '-5000')).toBe('-5.000');
    expect(deltaText('vi', 'award_price', '0')).toBe('0');
    expect(deltaText('vi', 'bid_closing_at', null)).toBeNull();
    expect(deltaText('vi', 'package_name', 'x')).toBe('x');
  });
});
