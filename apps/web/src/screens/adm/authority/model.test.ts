import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  actingProblems,
  actingRefusal,
  daysBetween,
  describeProblem,
  emptyActingForm,
  emptyScopeForm,
  emptyStandingForm,
  minutesLeft,
  offeredPermissions,
  parsePeriods,
  parsePermissions,
  readDefects,
  reviewProblems,
  scopeProblems,
  standingProblems,
  toActing,
  toActingBody,
  toGrantOption,
  toLocalInput,
  toPeriodScope,
  toPermanent,
  toStandingBody,
  toStandingRequest,
} from './model';
import type { ActingForm, ScopeForm, StandingForm } from './model';

const DAY = 86_400_000;
const NOW = new Date('2026-11-09T03:00:00Z');
const local = (offsetDays: number): string => toLocalInput(new Date(NOW.getTime() + offsetDays * DAY));
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const error = (code: string, status = 422, extensions: Record<string, unknown> = {}): ApiError => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions });

const standing = (patch: Partial<StandingForm> = {}): StandingForm => ({
  ...emptyStandingForm(NOW),
  delegateId: id(2),
  permissions: ['approval.decide'],
  unitId: id(9),
  endText: 'Until the deputy director is appointed.',
  reason: 'Standing handover of the approval of reports.',
  validFrom: local(0),
  reviewDueAt: local(180),
  ...patch,
});

describe('parsePeriods', () => {
  it('reads the periods of a field, sorted and without repeats, and tells apart what is not a period and what lies inside another', () => {
    expect(parsePeriods('2026-Q4, 2026-Q3 2026-Q3;2027')).toEqual({ codes: ['2026-Q3', '2026-Q4', '2027'], bad: [], overlapping: [] });
    expect(parsePeriods('Q3-2026 2026-M13 2026-07-15')).toMatchObject({ codes: [], bad: ['Q3-2026', '2026-M13', '2026-07-15'] });
    expect(parsePeriods('2026 2026-M03 2026-H2 2027-Q1').overlapping).toEqual(['2026-H2', '2026-M03']);
    expect(parsePeriods('').codes).toEqual([]);
  });
});

describe('standingProblems', () => {
  it('accepts a whole request: a review date within a year, an end condition in words', () => {
    expect(standingProblems(standing(), NOW)).toEqual([]);
  });

  it('names what is missing without the server', () => {
    const problems = standingProblems(standing({ delegateId: '', permissions: [], unitId: '', endText: 'soon', reason: 'short' }), NOW);
    expect(problems).toEqual(['delegateRequired', 'permissionsRequired', 'unitRequired', 'endTextShort', 'reasonShort']);
  });

  it('judges the review date: forward, within a year, not past, not after a fixed end', () => {
    expect(standingProblems(standing({ reviewDueAt: local(0) }), NOW)).toContain('reviewInvalid');
    expect(standingProblems(standing({ reviewDueAt: local(366) }), NOW)).toContain('reviewTooFar');
    expect(standingProblems(standing({ validFrom: local(-30), reviewDueAt: local(-1) }), NOW)).toEqual(expect.arrayContaining(['startPast', 'reviewPast']));
    expect(standingProblems(standing({ endKind: 'UNTIL_DATE', endOn: local(100) }), NOW)).toContain('reviewAfterEnd');
    expect(standingProblems(standing({ endKind: 'UNTIL_DATE', endOn: local(400) }), NOW)).toEqual([]);
    expect(standingProblems(standing({ endKind: 'UNTIL_DATE', endOn: '' }), NOW)).toContain('endOnRequired');
    expect(standingProblems(standing({ endKind: 'UNTIL_DATE', endOn: local(2000) }), NOW)).toContain('endOnInvalid');
  });

  it('judges the periods typed', () => {
    expect(standingProblems(standing({ periods: '2026-Q3' }), NOW)).toEqual([]);
    expect(standingProblems(standing({ periods: 'nonsense' }), NOW)).toEqual(['periodMalformed']);
    expect(standingProblems(standing({ periods: '2026 2026-Q3' }), NOW)).toEqual(['periodOverlap']);
  });

  it('builds the body of the request: the periods and the fixed end only when there are some', () => {
    const body = toStandingBody(standing({ periods: '2026-Q4 2026-Q3', legalBasis: ' QD 12 ' }));
    expect(body).toMatchObject({ delegate_membership_id: id(2), permissions: ['approval.decide'], scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [id(9)], period_codes: ['2026-Q3', '2026-Q4'], end_condition_kind: 'UNTIL_EVENT', legal_basis_ref: 'QD 12' });
    expect(body).not.toHaveProperty('end_on');
    expect(toStandingBody(standing())).not.toHaveProperty('period_codes');
    expect(toStandingBody(standing({ endKind: 'UNTIL_DATE', endOn: local(400) }))).toHaveProperty('end_on');
  });
});

describe('reviewProblems', () => {
  const current = { reviewDueAt: new Date(NOW.getTime() + 20 * DAY).toISOString(), endOn: null };
  it('wants the new date forward, within a year of now, and not after a fixed end', () => {
    expect(reviewProblems(current, local(200), NOW)).toEqual([]);
    expect(reviewProblems(current, local(10), NOW)).toEqual(['reviewNotForward']);
    expect(reviewProblems(current, local(400), NOW)).toEqual(['reviewTooFar']);
    expect(reviewProblems(current, '', NOW)).toEqual(['reviewInvalid']);
    expect(reviewProblems({ ...current, endOn: new Date(NOW.getTime() + 100 * DAY).toISOString() }, local(150), NOW)).toEqual(['reviewAfterEnd']);
  });
});

describe('acting', () => {
  const form = (patch: Partial<ActingForm> = {}): ActingForm => ({ ...emptyActingForm(), subjectId: id(3), permissions: 'dis.report.submit', hours: '4', reason: 'The reporter is in hospital and the report is due today.', ...patch });

  it('refuses what the server refuses: wildcards, administration, decisions, a malformed name', () => {
    expect(actingRefusal('dis.report.submit')).toBeUndefined();
    expect(actingRefusal('dis.*')).toBe('wildcard');
    expect(actingRefusal('iam.role.grant')).toBe('administrative');
    expect(actingRefusal('system.tenant.read')).toBe('administrative');
    expect(actingRefusal('approval.decide')).toBe('decision');
    expect(actingRefusal('doc.outgoing.sign')).toBe('decision');
    expect(actingRefusal('Bad Name')).toBe('malformed');
  });

  it('judges the form: person, permissions, hours up to 8, a reason of 20 characters', () => {
    expect(actingProblems(form()).problems).toEqual([]);
    expect(actingProblems(form({ subjectId: '', permissions: '', hours: '9', reason: 'short' })).problems).toEqual(['subjectRequired', 'permissionsRequired', 'hoursInvalid', 'reasonShort']);
    const refused = actingProblems(form({ permissions: 'dis.report.submit, approval.decide\niam.role.grant' }));
    expect(refused.problems).toEqual(['permissionRefused']);
    expect(refused.refused.map((entry) => [entry.permission, entry.why])).toEqual([
      ['approval.decide', 'decision'],
      ['iam.role.grant', 'administrative'],
    ]);
    expect(actingProblems(form({ hours: '0' })).problems).toEqual(['hoursInvalid']);
    expect(actingProblems(form({ periods: 'bad' })).problems).toEqual(['periodMalformed']);
  });

  it('builds the body with the permissions as a list and the hours as a number', () => {
    expect(toActingBody(form({ permissions: 'a.b.c, d.e.f d.e.f', periods: '2026-Q3' }))).toEqual({ subject_membership_id: id(3), permissions: ['a.b.c', 'd.e.f'], hours: 4, reason: 'The reporter is in hospital and the report is due today.', period_codes: ['2026-Q3'] });
    expect(parsePermissions('')).toEqual([]);
  });

  it('counts the minutes left in a window, never below zero', () => {
    expect(minutesLeft(new Date(NOW.getTime() + 90 * 60_000).toISOString(), NOW)).toBe(90);
    expect(minutesLeft(new Date(NOW.getTime() - 1000).toISOString(), NOW)).toBe(0);
    expect(minutesLeft(null, NOW)).toBe(0);
  });
});

describe('scopeProblems', () => {
  const form = (patch: Partial<ScopeForm> = {}): ScopeForm => ({ ...emptyScopeForm(), grantId: id(5), periods: '2026-Q3', reason: 'The reporter covers one quarter only.', ...patch });
  it('wants a grant, at least one period, well formed, and a reason', () => {
    expect(scopeProblems(form())).toEqual([]);
    expect(scopeProblems(form({ grantId: '', periods: '', reason: 'short' }))).toEqual(['grantRequired', 'periodsRequired', 'reasonShort']);
    expect(scopeProblems(form({ periods: 'Q3-2026' }))).toEqual(['periodMalformed']);
    expect(scopeProblems(form({ periods: '2026 2026-M03' }))).toEqual(['periodOverlap']);
  });
});

describe('the rows of the server', () => {
  const party = (n: number, name: string) => ({ id: id(n), name });

  it('reads a request and drops a row that has not the shape', () => {
    const row = { id: id(1), delegator: party(2, 'A'), delegate: party(3, 'B'), permissions: ['approval.decide'], scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [id(9)], period_codes: null, starts_at: 'x', review_due_at: 'y', end_condition_kind: 'UNTIL_EVENT', end_condition_text: 'text', end_on: null, reason: 'r', status: 'Pending', expires_at: 'z', decided_by: null, decided_at: null, decision_reason: null, delegation_id: null, version: 2, actions: { decide: true, cancel: false } };
    expect(toStandingRequest(row)).toMatchObject({ id: id(1), delegatorName: 'A', delegateName: 'B', status: 'Pending', endKind: 'UNTIL_EVENT', mayDecide: true, mayCancel: false, periodCodes: null, version: 2 });
    expect(toStandingRequest({ ...row, status: 'Weird' })).toBeUndefined();
    expect(toStandingRequest({ ...row, end_condition_kind: 'WHENEVER' })).toBeUndefined();
    expect(toStandingRequest(null)).toBeUndefined();
  });

  it('reads a permanent delegation only when it is one', () => {
    const row = { id: id(1), kind: 'PERMANENT', delegator: party(2, 'A'), delegate: party(3, 'B'), permissions: [], scope_kind: 'UNIT_ONLY', scope_ref_ids: [], period_codes: ['2026'], valid_from: 'a', review_due_at: 'b', review_due_soon: true, review_count: 3, end_condition_kind: 'SOURCE_HOLDS', end_condition_text: 'text', end_on: null, status: 'Active', end_reason: null, version: 4, actions: { review: true, revoke: true } };
    expect(toPermanent(row)).toMatchObject({ reviewDueSoon: true, reviewCount: 3, periodCodes: ['2026'], mayReview: true, mayRevoke: true });
    expect(toPermanent({ ...row, kind: 'TIMEBOXED' })).toBeUndefined();
  });

  it('reads an acting grant, a period scope and a role grant', () => {
    const acting = { id: id(1), requester: party(2, 'A'), subject: party(3, 'B'), permissions: ['a.b.c'], period_codes: null, hours: 4, reason: 'r', phase: 'ACTIVE', requested_at: 'x', decided_by: party(4, 'C'), window_start: 's', window_end: 'e', version: 2, actions: { revoke: true } };
    expect(toActing(acting)).toMatchObject({ phase: 'ACTIVE', hours: 4, decidedByName: 'C', mayRevoke: true, mayDecide: false });
    expect(toActing({ ...acting, phase: 'WEIRD' })).toBeUndefined();
    const scope = { id: id(1), role_grant_id: id(2), member: party(3, 'B'), role_code: 'REPORTER', period_codes: ['2026-Q3'], reason: 'r', status: 'Active', set_at: 'x', version: 1, actions: { lift: true } };
    expect(toPeriodScope(scope)).toMatchObject({ roleCode: 'REPORTER', periodCodes: ['2026-Q3'], mayLift: true });
    expect(toPeriodScope({ ...scope, status: 'Gone' })).toBeUndefined();
    expect(toGrantOption({ id: id(1), membership_id: id(2), role_code: 'R', status: 'Active' })).toEqual({ id: id(1), membershipId: id(2), roleCode: 'R' });
    expect(toGrantOption({ id: id(1), membership_id: id(2), role_code: 'R', status: 'Revoked' })).toBeUndefined();
  });
});

describe('describeProblem and readDefects', () => {
  it('maps the codes of the server to what the screen says', () => {
    const expected: Record<string, string> = {
      DELEGATION_CYCLE_DENIED: 'cycle',
      SELF_APPROVAL_DENIED: 'selfApproval',
      ACTING_SELF_DENIED: 'actingSelf',
      ACTING_INVALID: 'actingInvalid',
      PERIOD_SCOPE_DENIED: 'periodDenied',
      PERIOD_SCOPE_INVALID: 'periodInvalid',
      PERIOD_SCOPE_STATE_INVALID: 'periodState',
      DELEGATION_STATE_INVALID: 'stateInvalid',
      ACTING_STATE_INVALID: 'stateInvalid',
      DELEGATION_CHAIN_DENIED: 'chain',
      ROLE_ESCALATION_DENIED: 'escalation',
      SELF_GRANT_DENIED: 'self',
      VERSION_CONFLICT: 'versionConflict',
      SCOPE_DENIED: 'denied',
      SOMETHING_ELSE: 'general',
    };
    for (const [code, problem] of Object.entries(expected)) expect(describeProblem(error(code))).toBe(problem);
    expect(describeProblem(new Error('x'))).toBe('general');
  });

  it('reads the defects of a refused request, from any of the three codes', () => {
    const defects = [{ field: 'hours', code: 'TOO_LONG' }, { field: 'x' }, 'text'];
    expect(readDefects(error('ACTING_INVALID', 422, { defects }))).toEqual([{ field: 'hours', code: 'TOO_LONG' }]);
    expect(readDefects(error('DELEGATION_INVALID', 422, { defects }))).toHaveLength(1);
    expect(readDefects(error('PERIOD_SCOPE_INVALID', 422, { defects }))).toHaveLength(1);
    expect(readDefects(error('VALIDATION_FAILED', 422, { defects }))).toEqual([]);
    expect(readDefects(new Error('x'))).toEqual([]);
  });
});

describe('small helpers', () => {
  it('offers the delegable business permissions the person holds, never the administration', () => {
    expect(offeredPermissions(['iam.role.grant', 'approval.decide', 'approval_task.read'])).toEqual(['approval.decide']);
    expect(offeredPermissions(undefined)).toEqual(['approval.decide', 'doc.outgoing.sign']);
    expect(offeredPermissions([])).toEqual([]);
  });

  it('counts whole days, never negative', () => {
    expect(daysBetween('2026-11-01T00:00:00Z', '2026-11-04T12:00:00Z')).toBe(3);
    expect(daysBetween('2026-11-04T00:00:00Z', '2026-11-01T00:00:00Z')).toBe(0);
    expect(daysBetween('x', 'y')).toBe(0);
  });
});
