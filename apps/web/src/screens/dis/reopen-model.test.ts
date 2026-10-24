import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_REOPEN_FORM,
  MAX_REOPEN_PROJECTS,
  decisionBody,
  decisionOffer,
  describeProblem,
  effectiveStatus,
  isWindowOpen,
  lockedPeriods,
  matchingProjects,
  queueOf,
  reopenBody,
  toPeriod,
  toProjectOption,
  validateDecision,
  validateHours,
  validateReopenForm,
  validateRequestReason,
} from './model';
import type { PeriodView, ReopenForm, ReopenRequestView } from './model';
import { ME, PROJECT_ONE, PROJECT_TWO, SOMEONE_ELSE, period, reopen } from './test-support';

const view = (n: number, overrides: Record<string, unknown> = {}): PeriodView => toPeriod(period(n, overrides)) as PeriodView;
const NOW = Date.parse('2026-10-24T00:00:00Z');
const request = (n: number, overrides: Record<string, unknown> = {}): ReopenRequestView => {
  const locked = view(3, { status: 'LOCKED', soft_closed_at: '2026-10-02T03:05:00.000Z', locked_at: '2026-10-02T03:10:00.000Z', locked_by: SOMEONE_ELSE, version: 3, reopens: [reopen(n, overrides)] });
  return { period: locked, reopen: locked.reopens[0] as ReopenRequestView['reopen'] };
};
const form = (overrides: Partial<ReopenForm> = {}): ReopenForm => ({ ...EMPTY_REOPEN_FORM, periodId: 'p', projectIds: [PROJECT_ONE], reason: 'The Treasury returned the vouchers', ...overrides });

describe('the detail of a request', () => {
  it('is read for the requester and the approvers, and absent for the others', () => {
    const detailed = view(3, { reopens: [reopen(1, { status: 'APPROVED', window_until: '2026-10-05T03:00:00.000Z', approved_by: SOMEONE_ELSE, decided_by: SOMEONE_ELSE, decided_at: '2026-10-04T01:00:00.000Z', decision_reason: 'Granted', projects: [{ id: PROJECT_ONE, code: 'P-A-001' }, { id: 7, code: 'bad' }, null] })] });
    expect(detailed.reopens[0]?.detail).toEqual({
      version: 1,
      reason: 'The Treasury returned the vouchers for a wrong source code',
      requestedBy: SOMEONE_ELSE,
      requestedWindowHours: 72,
      approvedBy: SOMEONE_ELSE,
      decidedBy: SOMEONE_ELSE,
      decidedAt: '2026-10-04T01:00:00.000Z',
      decisionReason: 'Granted',
      projects: [{ id: PROJECT_ONE, code: 'P-A-001' }],
    });
    const coarse = view(3, { reopens: [{ id: 'r1', scope_kind: 'PERIOD', status: 'REQUESTED', window_until: null, requested_at: '2026-10-03T01:00:00.000Z' }] });
    expect(coarse.reopens[0]?.detail).toBeNull();
    const partial = view(3, { reopens: [{ ...reopen(1), version: 'one' }, { ...reopen(2), projects: 'none' }] });
    expect(partial.reopens[0]?.detail).toBeNull();
    expect(partial.reopens[1]?.detail?.projects).toEqual([]);
  });
});

describe('effectiveStatus and isWindowOpen', () => {
  it('turns an approved window into EXPIRED from its last instant, and leaves every other status as the server said', () => {
    const approved = { status: 'APPROVED' as const, windowUntil: '2026-10-24T00:00:00.000Z' };
    expect(effectiveStatus(approved, NOW - 1)).toBe('APPROVED');
    expect(effectiveStatus(approved, NOW)).toBe('EXPIRED');
    expect(isWindowOpen(approved, NOW - 1)).toBe(true);
    expect(isWindowOpen(approved, NOW)).toBe(false);
    expect(effectiveStatus({ status: 'APPROVED', windowUntil: null }, NOW)).toBe('APPROVED');
    for (const status of ['REQUESTED', 'REJECTED', 'EXPIRED', 'CLOSED'] as const) expect(effectiveStatus({ status, windowUntil: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(status);
    expect(isWindowOpen({ status: 'REQUESTED', windowUntil: null }, NOW)).toBe(false);
  });
});

describe('queueOf and lockedPeriods', () => {
  it('puts the requests that wait first, oldest first, and then the decided ones, newest first', () => {
    const a = view(1, { status: 'LOCKED', reopens: [reopen(5), reopen(3, { status: 'REJECTED' })] });
    const b = view(2, { status: 'LOCKED', reopens: [reopen(4), reopen(6, { status: 'APPROVED' })] });
    expect(queueOf([a, b, view(4)]).map((item) => item.reopen.id.slice(-1))).toEqual(['4', '5', '6', '3']);
    expect(queueOf([])).toEqual([]);
  });

  it('keeps the locked periods only, the latest first', () => {
    const periods = [view(1, { status: 'OPEN' }), view(2, { status: 'LOCKED' }), view(3, { status: 'SOFT_CLOSED' }), view(4, { status: 'LOCKED' })];
    expect(lockedPeriods(periods).map((item) => item.id)).toEqual([periods[3]?.id, periods[1]?.id]);
  });
});

describe('decisionOffer (AC-ST-DIS-002-2)', () => {
  it('offers the decision on the request of somebody else, disables it on one the caller made, and offers nothing without the right or once decided', () => {
    expect(decisionOffer(request(1, { requested_by: SOMEONE_ELSE }), { approve: true, me: ME })).toEqual({ kind: 'allowed' });
    expect(decisionOffer(request(1, { requested_by: ME }), { approve: true, me: ME })).toEqual({ kind: 'own' });
    expect(decisionOffer(request(1, { requested_by: ME }), { approve: false, me: ME })).toEqual({ kind: 'none' });
    expect(decisionOffer(request(1, { status: 'APPROVED' }), { approve: true, me: ME })).toEqual({ kind: 'none' });
    expect(decisionOffer(request(1, { status: 'REJECTED' }), { approve: true, me: ME })).toEqual({ kind: 'none' });
    // Without the detail the version is unknown, so the decision cannot be made from this screen.
    const coarse = request(1);
    expect(decisionOffer({ ...coarse, reopen: { ...coarse.reopen, detail: null } }, { approve: true, me: ME })).toEqual({ kind: 'none' });
    expect(decisionOffer(request(1, { requested_by: ME }), { approve: true, me: undefined })).toEqual({ kind: 'allowed' });
  });
});

describe('the request form', () => {
  it('is complete with a period, projects, a reason of 20 characters and 1 to 168 whole hours', () => {
    expect(validateReopenForm(form())).toEqual({});
    expect(validateReopenForm(form({ scope: 'PERIOD', projectIds: [] }))).toEqual({});
    expect(validateReopenForm(EMPTY_REOPEN_FORM)).toEqual({ periodId: 'required', projects: 'required', reason: 'required' });
    expect(validateReopenForm(form({ periodId: '' })).periodId).toBe('required');
    expect(validateReopenForm(form({ scope: 'PERIOD', projectIds: [PROJECT_ONE] }))).toEqual({});
    expect(validateReopenForm(form({ projectIds: Array.from({ length: MAX_REOPEN_PROJECTS + 1 }, (_, n) => String(n)) })).projects).toBe('tooMany');
  });

  it('counts the reason after trimming: 20 characters pass, 19 do not, and the contract maximum is 2000', () => {
    expect(validateRequestReason('x'.repeat(20))).toBeUndefined();
    expect(validateRequestReason(`  ${'x'.repeat(19)}  `)).toBe('tooShort');
    expect(validateRequestReason('      ')).toBe('required');
    expect(validateRequestReason('x'.repeat(2000))).toBeUndefined();
    expect(validateRequestReason('x'.repeat(2001))).toBe('tooLong');
  });

  it('takes whole hours from 1 to 168', () => {
    for (const ok of ['1', '24', '168', ' 48 ']) expect(validateHours(ok)).toBeUndefined();
    for (const bad of ['0', '169', '1.5', '-3', 'abc', '12h']) expect(validateHours(bad)).toBe('invalidHours');
    expect(validateHours('  ')).toBe('required');
  });

  it('builds the body of the contract: the projects for a request for projects, none for the whole period, the reason trimmed', () => {
    expect(reopenBody(form({ reason: '  The Treasury returned the vouchers  ', windowHours: ' 48 ' }))).toEqual({ scope_kind: 'PROJECTS', project_ids: [PROJECT_ONE], reason: 'The Treasury returned the vouchers', window_hours: 48 });
    expect(reopenBody(form({ scope: 'PERIOD', projectIds: [PROJECT_ONE, PROJECT_TWO] }))).toEqual({ scope_kind: 'PERIOD', reason: 'The Treasury returned the vouchers', window_hours: 24 });
  });
});

describe('the decision form', () => {
  it('asks for a reason of 5 characters, and for hours only when approving', () => {
    expect(validateDecision({ decision: 'approve', reason: 'Granted', windowHours: '48' })).toEqual({});
    expect(validateDecision({ decision: 'reject', reason: 'Granted', windowHours: 'not asked' })).toEqual({});
    expect(validateDecision({ decision: 'approve', reason: '', windowHours: '0' })).toEqual({ reason: 'required', windowHours: 'invalidHours' });
    expect(validateDecision({ decision: 'reject', reason: 'ok', windowHours: '' }).reason).toBe('tooShort');
    expect(validateDecision({ decision: 'reject', reason: 'x'.repeat(2001), windowHours: '' }).reason).toBe('tooLong');
  });

  it('builds the body: an approval grants the hours typed, a rejection none', () => {
    expect(decisionBody({ decision: 'approve', reason: '  Granted  ', windowHours: ' 48 ' })).toEqual({ decision: 'approve', reason: 'Granted', window_hours: 48 });
    expect(decisionBody({ decision: 'reject', reason: 'Not documented', windowHours: '48' })).toEqual({ decision: 'reject', reason: 'Not documented' });
  });
});

describe('the projects a request can name', () => {
  it('reads a project of the register, drops a row without the shape, and searches by code or name', () => {
    expect(toProjectOption({ id: PROJECT_ONE, code: 'P-A-001', name: 'Road to the district', status: 'IMPLEMENTATION' })).toEqual({ id: PROJECT_ONE, code: 'P-A-001', name: 'Road to the district' });
    expect(toProjectOption(null)).toBeUndefined();
    expect(toProjectOption({ id: PROJECT_ONE, code: 'P-A-001' })).toBeUndefined();
    const options = [
      { id: PROJECT_ONE, code: 'P-A-001', name: 'Road to the district' },
      { id: PROJECT_TWO, code: 'P-A-002', name: 'School of the commune' },
    ];
    expect(matchingProjects(options, '  ')).toEqual(options);
    expect(matchingProjects(options, 'ROAD').map((option) => option.code)).toEqual(['P-A-001']);
    expect(matchingProjects(options, 'a-002').map((option) => option.code)).toEqual(['P-A-002']);
    expect(matchingProjects(options, 'nothing')).toEqual([]);
  });
});

describe('describeProblem for the reopening', () => {
  it('tells a short reason and a self-approval from the other refusals', () => {
    const problem = (code: string): ApiError => new ApiError({ status: 403, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
    expect(describeProblem(problem('REOPEN_REASON_REQUIRED'))).toBe('reasonRequired');
    expect(describeProblem(problem('SELF_APPROVAL_DENIED'))).toBe('selfApproval');
  });
});
