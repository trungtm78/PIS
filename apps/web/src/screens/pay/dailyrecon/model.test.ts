import { describe, expect, it } from 'vitest';
import { EMPTY_ASSIGN, EMPTY_RESOLVE, addDays, assignBody, dayRows, differingLines, isWaiting, resolveBody, toItem, toItemAnswer, toItemsPage, toLine, toRun, toRunAnswer, toRunDetail, toRunsPage, validateAssign, validateResolve, validateRunDay } from './model';
import { item, itemAnswer, line, run, runAnswer, runId } from './test-support';

describe('the readers of the daily reconciliation', () => {
  it('reads a pass with its thresholds, and drops one that is not whole', () => {
    expect(toRun(run(1))).toMatchObject({ reconDate: '2026-11-06', status: 'COMPLETE', partialReason: null, rule: { source: 'DEFAULT', unverified: true, thresholdVnd: '1000000', dueDays: 3 }, booksTotalVnd: '19000000', calendarBasis: 'WORK_CALENDAR', origin: 'JOB' });
    expect(toRun(run(1, { status: 'PARTIAL', partial_reason: 'SOURCE_UNREADABLE', books_total_vnd: null, calendar_basis: 'WEEKDAYS_ASSUMED', origin: 'MANUAL' }))).toMatchObject({ status: 'PARTIAL', partialReason: 'SOURCE_UNREADABLE', booksTotalVnd: null, calendarBasis: 'WEEKDAYS_ASSUMED', origin: 'MANUAL' });
    expect(toRun(run(1, { status: 'WHATEVER' }))).toBeUndefined();
    expect(toRun(run(1, { recon_date: '06/11/2026' }))).toBeUndefined();
    expect(toRun(run(1, { rule: { version: 0 } }))).toBeUndefined();
    expect(toRun(null)).toBeUndefined();
  });

  it('reads a line with signed figures and no kind when the sides are equal', () => {
    expect(toLine(line(1))).toMatchObject({ differenceVnd: '3000000', kind: 'AMOUNT', opensItem: true });
    expect(toLine(line(1, { books_vnd: '-5', treasury_vnd: '-4', difference_vnd: '1', kind: null, opens_item: false }))).toMatchObject({ booksVnd: '-5', kind: null });
    expect(toLine(line(1, { books_vnd: '1.5' }))).toBeUndefined();
    expect(differingLines([toLine(line(1)), toLine(line(2, { kind: 'TIMING' })), toLine(line(3, { kind: null }))].flatMap((entry) => entry ?? []))).toHaveLength(1);
  });

  it('reads the detail of a pass: its lines and how many the scope of the caller hides', () => {
    const detail = toRunDetail({ ...run(1), lines: [line(1), { broken: true }], hidden_lines: 4 });
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.hiddenLines).toBe(4);
    expect(toRunDetail({ lines: [] })).toBeUndefined();
  });

  it('reads an item with what its state allows, and an item that is a timing pair is not one', () => {
    expect(toItem(item(1))).toMatchObject({ kind: 'AMOUNT', status: 'OPEN', dueOn: '2026-11-11', latestDifferenceVnd: '3000000', actions: { assign: true, explain: true, resolve: true, writeOff: true } });
    expect(toItem(item(1, { kind: 'TIMING' }))).toBeUndefined();
    expect(toItem(item(1, { status: 'AUTO_CLEARED' }))?.status).toBe('AUTO_CLEARED');
    expect(toItem(item(1, { version: 'x' }))).toBeUndefined();
    expect(isWaiting({ status: 'EXPLAINED' })).toBe(true);
    expect(isWaiting({ status: 'AUTO_CLEARED' })).toBe(false);
    expect(toItemsPage({ items: [item(1), 5], summary: { waiting: 1, overdue: 2, waiting_difference_vnd: '-7' } })).toMatchObject({ items: [{ id: item(1).id }], summary: { waiting: 1, overdue: 2, waitingDifferenceVnd: '-7' } });
    expect(toItemsPage(undefined).summary).toEqual({ waiting: 0, overdue: 0, waitingDifferenceVnd: '0' });
  });

  it('reads the answers of the commands', () => {
    expect(toRunAnswer(runAnswer())).toMatchObject({ reconDate: '2026-11-06', runStatus: 'COMPLETE', reused: false, lineCount: 3, openedItems: 2 });
    expect(toRunAnswer({})).toBeUndefined();
    expect(toItemAnswer(itemAnswer())).toEqual({ id: item(1).id, status: 'EXPLAINED', version: 2 });
    expect(toItemAnswer({ resource_id: 'x' })).toBeUndefined();
  });
});

describe('the days: a day with no pass is never "no difference"', () => {
  const page = toRunsPage({
    items: [run(1)],
    today: '2026-11-09',
    rule: run(1).rule,
    days: [
      { recon_date: '2026-11-06', status: 'COMPLETE', partial_reason: null, run_no: 2, run_id: runId(1) },
      { recon_date: '2026-11-05', status: 'PARTIAL', partial_reason: 'STATEMENT_MISSING', run_no: 1, run_id: runId(2) },
      { recon_date: 'bad' },
    ],
  });

  it('adds days', () => {
    expect(addDays('2026-11-09', -1)).toBe('2026-11-08');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('lists the latest days today first, each with the state of its latest pass or NO_RUN', () => {
    const days = dayRows(page, 5);
    expect(days.map((day) => [day.reconDate, day.state])).toEqual([
      ['2026-11-09', 'NO_RUN'],
      ['2026-11-08', 'NO_RUN'],
      ['2026-11-07', 'NO_RUN'],
      ['2026-11-06', 'COMPLETE'],
      ['2026-11-05', 'PARTIAL'],
    ]);
    expect(days[4]).toMatchObject({ partialReason: 'STATEMENT_MISSING', runNo: 1, runId: runId(2) });
    expect(days[0]).toMatchObject({ runId: null, runNo: null });
  });

  it('shows no day while the server has not said what day it is', () => {
    expect(dayRows(toRunsPage({ items: [] }), 14)).toEqual([]);
  });
});

describe('the forms', () => {
  it('judges the day of a pass: a real day, not after today', () => {
    expect(validateRunDay('', '2026-11-09')).toBe('required');
    expect(validateRunDay('2026-02-30', '2026-11-09')).toBe('invalid');
    expect(validateRunDay('09/11/2026', '2026-11-09')).toBe('invalid');
    expect(validateRunDay('2026-11-10', '2026-11-09')).toBe('future');
    expect(validateRunDay('2026-11-09', '2026-11-09')).toBeUndefined();
  });

  it('judges the assignment: an owner that is a uuid and a day that is not before today', () => {
    expect(validateAssign(EMPTY_ASSIGN, '2026-11-09')).toEqual({ ownerId: 'required', dueOn: 'required' });
    expect(validateAssign({ ownerId: 'x', dueOn: '2026-11-08' }, '2026-11-09')).toEqual({ ownerId: 'uuid', dueOn: 'past' });
    expect(validateAssign({ ownerId: item(1).owner_membership_id, dueOn: '2026-11-09' }, '2026-11-09')).toEqual({});
    expect(validateAssign({ ownerId: item(1).owner_membership_id, dueOn: 'soon' }, '2026-11-09').dueOn).toBe('invalid');
    expect(assignBody({ ownerId: ` ${item(1).owner_membership_id} `, dueOn: ' 2026-11-12 ' })).toEqual({ owner_membership_id: item(1).owner_membership_id, due_on: '2026-11-12' });
  });

  it('judges the resolution: the words always, the document for a write-off', () => {
    expect(validateResolve(EMPTY_RESOLVE, 'EXPLAINED')).toEqual({ note: 'required' });
    expect(validateResolve({ note: 'x'.repeat(2001), approvalDocumentVersionId: '' }, 'RESOLVED')).toEqual({ note: 'tooLong' });
    expect(validateResolve({ note: 'ok', approvalDocumentVersionId: '' }, 'WRITTEN_OFF')).toEqual({ approvalDocumentVersionId: 'required' });
    expect(validateResolve({ note: 'ok', approvalDocumentVersionId: 'x' }, 'WRITTEN_OFF')).toEqual({ approvalDocumentVersionId: 'uuid' });
    expect(resolveBody({ note: ' ok ', approvalDocumentVersionId: item(1).id }, 'RESOLVED')).toEqual({ resolution: 'RESOLVED', note: 'ok' });
    expect(resolveBody({ note: ' ok ', approvalDocumentVersionId: item(1).id }, 'WRITTEN_OFF')).toEqual({ resolution: 'WRITTEN_OFF', note: 'ok', approval_document_version_id: item(1).id });
  });
});
