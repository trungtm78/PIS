import { DomainError } from '../src/errors';
import type { EffectiveAccess, GrantView } from '../src/effective-access';
import {
  ACTING_MAX_HOURS,
  ACTING_REQUEST_TTL_HOURS,
  actingAllowsPermission,
  actingPhase,
  actingWindow,
  assertActingApprover,
  assertActingParties,
  assertValidActingRequest,
  restrictAccessForActing,
  validateActingRequest,
} from '../src/iam-acting';
import { assertPeriodAllowed, assertPeriodAllowedForDays, intersectPeriodCodes, isReportPeriodCode, isScopePeriodCode, normalisePeriodCodes, periodAllowed, periodAllowedForDays, periodCovered, periodCoveredByDays, validatePeriodCodes } from '../src/iam-period-scope';
import {
  STANDING_END_MAX_DAYS,
  STANDING_REVIEW_MAX_DAYS,
  assertNoDelegationCycle,
  assertValidReview,
  assertValidStandingDelegation,
  findDelegationCycle,
  reviewDueSoon,
  standingEndReason,
  validateReview,
  validateStandingDelegation,
} from '../src/iam-standing-delegation';
import type { StandingDelegationRequest } from '../src/iam-standing-delegation';

const NOW = new Date('2026-11-09T03:00:00Z');
const UNIT = '00000000-0000-4000-8000-000000000001';
const days = (from: Date, count: number): Date => new Date(from.getTime() + count * 86_400_000);
const hours = (from: Date, count: number): Date => new Date(from.getTime() + count * 3_600_000);

const standing = (overrides: Partial<StandingDelegationRequest> = {}): StandingDelegationRequest => ({
  permissions: ['approval.decide'],
  scopeKind: 'UNIT_SUBTREE',
  scopeRefIds: [UNIT],
  validFrom: NOW,
  reviewDueAt: days(NOW, 180),
  endConditionKind: 'UNTIL_EVENT',
  endConditionText: 'Until the deputy director is appointed.',
  endOn: null,
  ...overrides,
});
const standingFields = (request: StandingDelegationRequest): string[] => validateStandingDelegation(request, NOW).map((defect) => `${defect.field}:${defect.code}`);

describe('validateStandingDelegation (IAM-2 permanent delegation)', () => {
  it('accepts an ongoing delegation with an end condition and a review within a year', () => {
    expect(standingFields(standing())).toEqual([]);
    expect(standingFields(standing({ reviewDueAt: days(NOW, STANDING_REVIEW_MAX_DAYS) }))).toEqual([]);
  });

  it('refuses a review date that is not ahead, or more than a year away, by a millisecond too', () => {
    expect(standingFields(standing({ reviewDueAt: NOW }))).toEqual(['review_due_at:BEFORE_START']);
    expect(standingFields(standing({ reviewDueAt: new Date(days(NOW, STANDING_REVIEW_MAX_DAYS).getTime() + 1) }))).toEqual(['review_due_at:TOO_LONG']);
    expect(standingFields(standing({ validFrom: days(NOW, -9), reviewDueAt: days(NOW, -2) }))).toEqual(['valid_from:IN_THE_PAST', 'review_due_at:ALREADY_ENDED']);
  });

  it('judges what is handed over by the rules of the time-boxed delegation', () => {
    expect(standingFields(standing({ permissions: ['iam.role.grant'] }))).toEqual(['permissions[0]:ADMINISTRATIVE']);
    expect(standingFields(standing({ permissions: ['*'] }))).toEqual(['permissions[0]:WILDCARD']);
    expect(standingFields(standing({ scopeKind: 'TENANT' }))).toEqual(['scope_kind:UNSUPPORTED']);
    expect(standingFields(standing({ scopeRefIds: [] }))).toEqual(['scope_ref_ids:REQUIRED']);
  });

  it('needs an end condition in words, and a fixed end for the kind that has one', () => {
    expect(standingFields(standing({ endConditionText: 'soon' }))).toEqual(['end_condition_text:REQUIRED']);
    expect(standingFields(standing({ endConditionKind: 'WHENEVER' }))).toEqual(['end_condition_kind:UNSUPPORTED']);
    expect(standingFields(standing({ endConditionKind: 'UNTIL_DATE' }))).toEqual(['end_on:REQUIRED']);
    expect(standingFields(standing({ endConditionKind: 'UNTIL_DATE', endOn: days(NOW, 400) }))).toEqual([]);
    expect(standingFields(standing({ endConditionKind: 'UNTIL_DATE', endOn: days(NOW, 100) }))).toEqual(['review_due_at:REVIEW_AFTER_END']);
    expect(standingFields(standing({ endConditionKind: 'UNTIL_DATE', endOn: days(NOW, STANDING_END_MAX_DAYS + 1) }))).toEqual(['end_on:TOO_LONG']);
    expect(standingFields(standing({ endConditionKind: 'UNTIL_DATE', endOn: NOW }))).toEqual(['end_on:BEFORE_START']);
    expect(standingFields(standing({ endConditionKind: 'SOURCE_HOLDS', endOn: days(NOW, 400) }))).toEqual(['end_on:NOT_ALLOWED']);
  });

  it('judges the period limit by the period rules', () => {
    expect(standingFields(standing({ periodCodes: ['2026-Q4', '2027'] }))).toEqual([]);
    expect(standingFields(standing({ periodCodes: [] }))).toEqual(['period_codes:REQUIRED']);
    expect(standingFields(standing({ periodCodes: ['Q4-2026'] }))).toEqual(['period_codes[0]:MALFORMED']);
  });

  it('answers 422 DELEGATION_INVALID with every defect', () => {
    expect(() => assertValidStandingDelegation(standing({ permissions: [] }), NOW)).toThrow(expect.objectContaining({ code: 'DELEGATION_INVALID', status: 422, detail: 'permissions' }));
    expect(() => assertValidStandingDelegation(standing(), NOW)).not.toThrow();
  });
});

describe('the review of a standing delegation', () => {
  const current = { validUntil: days(NOW, 20), endOn: null };

  it('moves the date forward, within a year of now', () => {
    expect(validateReview(current, days(NOW, 200), NOW)).toEqual([]);
    expect(validateReview(current, days(NOW, 20), NOW)).toEqual([{ field: 'review_due_at', code: 'BEFORE_START' }]);
    expect(validateReview(current, days(NOW, STANDING_REVIEW_MAX_DAYS + 1), NOW)).toEqual([{ field: 'review_due_at', code: 'TOO_LONG' }]);
  });

  it('does not revive a delegation that has stopped, and does not pass a fixed end', () => {
    expect(validateReview({ validUntil: NOW, endOn: null }, days(NOW, 30), NOW)).toEqual([{ field: 'review_due_at', code: 'ALREADY_ENDED' }]);
    expect(validateReview({ validUntil: days(NOW, 20), endOn: days(NOW, 100) }, days(NOW, 101), NOW)).toEqual([{ field: 'review_due_at', code: 'REVIEW_AFTER_END' }]);
    expect(() => assertValidReview(current, days(NOW, 5), NOW)).toThrow(DomainError);
  });

  it('says why a delegation is over: a fixed end that came is the end condition, a passed review date a lapsed review', () => {
    expect(standingEndReason({ validUntil: days(NOW, 1), endOn: null }, NOW)).toBeNull();
    expect(standingEndReason({ validUntil: NOW, endOn: null }, NOW)).toBe('REVIEW_LAPSED');
    expect(standingEndReason({ validUntil: NOW, endOn: NOW }, NOW)).toBe('END_CONDITION_MET');
    expect(standingEndReason({ validUntil: days(NOW, 5), endOn: days(NOW, -1) }, NOW)).toBe('END_CONDITION_MET');
  });

  it('announces a review that falls due within the window and only while the delegation works', () => {
    expect(reviewDueSoon(days(NOW, 10), NOW)).toBe(true);
    expect(reviewDueSoon(days(NOW, 14), NOW)).toBe(true);
    expect(reviewDueSoon(days(NOW, 15), NOW)).toBe(false);
    expect(reviewDueSoon(NOW, NOW)).toBe(false);
  });
});

describe('findDelegationCycle (no loop of authority)', () => {
  const edge = (delegatorUser: string, delegateUser: string, permissions: string[] = ['approval.decide']) => ({ delegatorUser, delegateUser, permissions });

  it('refuses a delegation to oneself as the shortest loop', () => {
    expect(findDelegationCycle([], edge('a', 'a'))).toEqual(['a', 'a']);
  });

  it('finds the direct loop and the loop through others, and gives the same path every time', () => {
    expect(findDelegationCycle([edge('b', 'a')], edge('a', 'b'))).toEqual(['a', 'b', 'a']);
    const chain = [edge('c', 'a'), edge('b', 'c'), edge('x', 'y')];
    expect(findDelegationCycle(chain, edge('a', 'b'))).toEqual(['a', 'b', 'c', 'a']);
    expect(findDelegationCycle([...chain].reverse(), edge('a', 'b'))).toEqual(['a', 'b', 'c', 'a']);
  });

  it('allows what closes no loop, and a loop of other permissions', () => {
    expect(findDelegationCycle([edge('b', 'c')], edge('a', 'b'))).toBeNull();
    expect(findDelegationCycle([edge('b', 'a', ['doc.outgoing.sign'])], edge('a', 'b'))).toBeNull();
  });

  it('counts a loop only when the permissions overlap, patterns included', () => {
    expect(findDelegationCycle([edge('b', 'a', ['approval.*'])], edge('a', 'b'))).toEqual(['a', 'b', 'a']);
  });

  it('terminates on a graph that already has a loop elsewhere', () => {
    const edges = [edge('x', 'y'), edge('y', 'x'), edge('b', 'a')];
    expect(findDelegationCycle(edges, edge('a', 'b'))).toEqual(['a', 'b', 'a']);
    expect(findDelegationCycle([edge('x', 'y'), edge('y', 'x')], edge('a', 'b'))).toBeNull();
  });

  it('answers 403 DELEGATION_CYCLE_DENIED naming the length of the loop only', () => {
    expect(() => assertNoDelegationCycle([edge('b', 'a')], edge('a', 'b'))).toThrow(expect.objectContaining({ code: 'DELEGATION_CYCLE_DENIED', status: 403, extensions: { cycle_length: 2 } }));
  });
});

describe('period codes and the period scope (IAM-2)', () => {
  it('reads months, quarters, half years and years, and a day only as the thing asked about', () => {
    for (const code of ['2026-M03', '2026-Q3', '2026-H1', '2026']) expect(isScopePeriodCode(code)).toBe(true);
    for (const code of ['2026-M13', '2026-Q5', '2026-H3', '26', '2026-07-15', '', 'Q3-2026']) expect(isScopePeriodCode(code)).toBe(false);
    expect(isReportPeriodCode('2026-07-15')).toBe(true);
    expect(isReportPeriodCode('2026-02-30')).toBe(false);
  });

  it('covers its own period and what is inside it, and nothing outside', () => {
    expect(periodCovered(['2026-Q3'], '2026-M07')).toBe(true);
    expect(periodCovered(['2026-Q3'], '2026-Q3')).toBe(true);
    expect(periodCovered(['2026-Q3'], '2026-Q4')).toBe(false);
    expect(periodCovered(['2026-Q3'], '2026-H2')).toBe(false);
    expect(periodCovered(['2026'], '2026-H2')).toBe(true);
    expect(periodCovered(['2026-H2'], '2026-Q4')).toBe(true);
    expect(periodCovered(['2026-Q3'], '2026-09-30')).toBe(true);
    expect(periodCovered(['2026-Q3'], '2026-10-01')).toBe(false);
    expect(periodCovered(['2026'], '2027')).toBe(false);
    expect(periodCovered(['2026'], 'garbage')).toBe(false);
  });

  it('validates a list: not empty, well formed, no repeat, no entry inside another, at most 24', () => {
    expect(validatePeriodCodes(['2026-Q3', '2026-Q4'])).toEqual([]);
    expect(validatePeriodCodes([])).toEqual([{ field: 'period_codes', code: 'REQUIRED' }]);
    expect(validatePeriodCodes(['2026-Q3', '2026-Q3'])).toEqual([{ field: 'period_codes[1]', code: 'DUPLICATE' }]);
    expect(validatePeriodCodes(['2026', '2026-M03'])).toEqual([{ field: 'period_codes[1]', code: 'OVERLAP' }]);
    expect(validatePeriodCodes(['bad'])).toEqual([{ field: 'period_codes[0]', code: 'MALFORMED' }]);
    const many = Array.from({ length: 25 }, (_, index) => `${1990 + index}`);
    expect(validatePeriodCodes(many)[0]).toEqual({ field: 'period_codes', code: 'TOO_MANY' });
  });

  it('sorts and de-duplicates for storage, and intersects two limits', () => {
    expect(normalisePeriodCodes(['2026-Q4', '2026-Q3', '2026-Q4'])).toEqual(['2026-Q3', '2026-Q4']);
    expect(intersectPeriodCodes(undefined, undefined)).toBeUndefined();
    expect(intersectPeriodCodes(undefined, ['2026-Q3'])).toEqual(['2026-Q3']);
    expect(intersectPeriodCodes(['2026'], ['2026-Q3'])).toEqual(['2026-Q3']);
    expect(intersectPeriodCodes(['2026-Q3'], ['2026-Q4'])).toEqual([]);
    expect(intersectPeriodCodes(['2026-H2'], ['2026-Q3', '2027'])).toEqual(['2026-Q3']);
  });
});

describe('periods given by their days (the calendar of the reports: weeks and months)', () => {
  it('covers a week only when every month it touches is inside one scope entry', () => {
    expect(periodCoveredByDays(['2026-Q3'], '2026-08-03', '2026-08-09')).toBe(true);
    expect(periodCoveredByDays(['2026-Q3'], '2026-09-28', '2026-10-04')).toBe(false);
    expect(periodCoveredByDays(['2026'], '2026-09-28', '2026-10-04')).toBe(true);
    expect(periodCoveredByDays(['2026-M09', '2026-M10'], '2026-09-28', '2026-10-04')).toBe(false);
    expect(periodCoveredByDays(['2026-M08'], '2026-08-01', '2026-08-31')).toBe(true);
  });

  it('is false for days that are not days or run backwards', () => {
    expect(periodCoveredByDays(['2026'], '2026-02-30', '2026-03-01')).toBe(false);
    expect(periodCoveredByDays(['2026'], '2026-05-10', '2026-05-01')).toBe(false);
    expect(periodCoveredByDays(['2026'], 'x', 'y')).toBe(false);
  });
});

const grant = (overrides: Partial<GrantView> = {}): GrantView => ({ roleCode: 'REPORTER', rank: 10, permissions: ['dis.report.submit'], scope: { kind: 'TENANT' }, status: 'Active', effectiveFrom: new Date(0), effectiveUntil: null, ...overrides });
const accessOf = (...grants: GrantView[]): EffectiveAccess => ({ membershipId: 'm1', scopeVersion: 1, membershipActive: true, grants });

describe('periodAllowed (a role limited to report periods)', () => {
  it('does not limit a grant that has no period scope', () => {
    expect(periodAllowed(accessOf(grant()), NOW, 'dis.report.submit', '2026-Q3')).toBe(true);
    expect(periodAllowed(accessOf(grant({ periodCodes: null })), NOW, 'dis.report.submit', '2026-Q3')).toBe(true);
  });

  it('limits a grant that has one, for the permissions that grant holds', () => {
    const limited = accessOf(grant({ periodCodes: ['2026-Q3'] }));
    expect(periodAllowed(limited, NOW, 'dis.report.submit', '2026-M08')).toBe(true);
    expect(periodAllowed(limited, NOW, 'dis.report.submit', '2026-Q4')).toBe(false);
    expect(() => assertPeriodAllowed(limited, NOW, 'dis.report.submit', '2026-Q4')).toThrow(expect.objectContaining({ code: 'PERIOD_SCOPE_DENIED', status: 403 }));
  });

  it('lets another grant that holds the permission without a limit carry it', () => {
    expect(periodAllowed(accessOf(grant({ periodCodes: ['2026-Q3'] }), grant({ roleCode: 'OTHER' })), NOW, 'dis.report.submit', '2026-Q4')).toBe(true);
  });

  it('judges a period given by its days the same way', () => {
    const limited = accessOf(grant({ periodCodes: ['2026-Q3'] }));
    expect(periodAllowedForDays(limited, NOW, 'dis.report.submit', '2026-08-03', '2026-08-09')).toBe(true);
    expect(periodAllowedForDays(limited, NOW, 'dis.report.submit', '2026-10-05', '2026-10-11')).toBe(false);
    expect(periodAllowedForDays(accessOf(grant()), NOW, 'dis.report.submit', '2026-10-05', '2026-10-11')).toBe(true);
    expect(() => assertPeriodAllowedForDays(limited, NOW, 'dis.report.submit', '2026-10-05', '2026-10-11')).toThrow(expect.objectContaining({ code: 'PERIOD_SCOPE_DENIED', status: 403 }));
  });

  it('leaves a permission nobody holds to the other checks, and ignores a grant that is over', () => {
    expect(periodAllowed(accessOf(grant({ periodCodes: ['2026-Q3'] })), NOW, 'dis.report.export', '2026-Q4')).toBe(true);
    expect(periodAllowed(accessOf(grant({ periodCodes: ['2026-Q3'] }), grant({ roleCode: 'OLD', status: 'Revoked' })), NOW, 'dis.report.submit', '2026-Q4')).toBe(false);
  });
});

describe('validateActingRequest (an administrator acting on behalf of a person)', () => {
  const request = { permissions: ['dis.report.submit'], hours: 4, reason: 'The reporter is in hospital and the weekly report is due today.' };
  const fields = (value: Parameters<typeof validateActingRequest>[0]): string[] => validateActingRequest(value).map((defect) => `${defect.field}:${defect.code}`);

  it('accepts data entry for a few hours with a reason', () => {
    expect(fields(request)).toEqual([]);
    expect(fields({ ...request, hours: ACTING_MAX_HOURS })).toEqual([]);
  });

  it('refuses more than the longest window and a missing or short reason', () => {
    expect(fields({ ...request, hours: ACTING_MAX_HOURS + 1 })).toEqual(['hours:TOO_LONG']);
    expect(fields({ ...request, hours: 0 })).toEqual(['hours:REQUIRED']);
    expect(fields({ ...request, reason: 'short' })).toEqual(['reason:TOO_SHORT']);
  });

  it('never acts for administration, for a wildcard, or for a decision', () => {
    expect(fields({ ...request, permissions: ['iam.role.grant'] })).toEqual(['permissions[0]:ADMINISTRATIVE']);
    expect(fields({ ...request, permissions: ['dis.*'] })).toEqual(['permissions[0]:WILDCARD']);
    expect(fields({ ...request, permissions: ['approval.decide'] })).toEqual(['permissions[0]:DECISION']);
    expect(fields({ ...request, permissions: ['doc.outgoing.sign'] })).toEqual(['permissions[0]:DECISION']);
    expect(fields({ ...request, permissions: ['dis.report.submit', 'dis.report.submit'] })).toEqual(['permissions[1]:DUPLICATE']);
    expect(fields({ ...request, permissions: [] })).toEqual(['permissions:REQUIRED']);
    expect(actingAllowsPermission('Bad Permission')).toBe('MALFORMED');
    expect(actingAllowsPermission('system.tenant.read')).toBe('ADMINISTRATIVE');
  });

  it('judges the period limit and answers 422 ACTING_INVALID', () => {
    expect(fields({ ...request, periodCodes: ['nope'] })).toEqual(['period_codes[0]:MALFORMED']);
    expect(() => assertValidActingRequest({ ...request, hours: 99 })).toThrow(expect.objectContaining({ code: 'ACTING_INVALID', status: 422, detail: 'hours' }));
  });
});

describe('the parties of an acting grant', () => {
  it('refuses acting for oneself, by the person', () => {
    expect(() => assertActingParties({ requesterUser: 'u1', subjectUser: 'u1' })).toThrow(expect.objectContaining({ code: 'ACTING_SELF_DENIED', status: 403 }));
    expect(() => assertActingParties({ requesterUser: 'u1', subjectUser: 'u2' })).not.toThrow();
  });

  it('keeps the approver apart from both: maker is not checker', () => {
    expect(() => assertActingApprover({ requesterUser: 'u1', subjectUser: 'u2', approverUser: 'u1' })).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
    expect(() => assertActingApprover({ requesterUser: 'u1', subjectUser: 'u2', approverUser: 'u2' })).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
    expect(() => assertActingApprover({ requesterUser: 'u1', subjectUser: 'u2', approverUser: 'u3' })).not.toThrow();
  });
});

describe('the phase of an acting grant by the clock', () => {
  const window = actingWindow(NOW, 4);

  it('counts the window from the approval', () => {
    expect(window.validFrom).toEqual(NOW);
    expect(window.validUntil).toEqual(hours(NOW, 4));
  });

  it('is in force inside the window only, and a revoked one never is', () => {
    const approved = { status: 'Approved' as const, requestedAt: hours(NOW, -1), ...window };
    expect(actingPhase(approved, NOW)).toBe('ACTIVE');
    expect(actingPhase(approved, new Date(hours(NOW, 4).getTime() - 1))).toBe('ACTIVE');
    expect(actingPhase(approved, hours(NOW, 4))).toBe('ENDED');
    expect(actingPhase(approved, new Date(NOW.getTime() - 1))).toBe('ENDED');
    expect(actingPhase({ ...approved, status: 'Revoked' }, NOW)).toBe('REVOKED');
  });

  it('lets a request wait a day and no longer, and keeps the final states', () => {
    const pending = { status: 'Pending' as const, requestedAt: NOW, validFrom: null, validUntil: null };
    expect(actingPhase(pending, hours(NOW, ACTING_REQUEST_TTL_HOURS - 1))).toBe('PENDING');
    expect(actingPhase(pending, hours(NOW, ACTING_REQUEST_TTL_HOURS))).toBe('REQUEST_LAPSED');
    expect(actingPhase({ ...pending, status: 'Rejected' }, NOW)).toBe('REJECTED');
    expect(actingPhase({ ...pending, status: 'Cancelled' }, NOW)).toBe('CANCELLED');
    expect(actingPhase({ status: 'Approved', requestedAt: NOW, validFrom: null, validUntil: null }, NOW)).toBe('ENDED');
  });
});

describe('restrictAccessForActing (what the administrator has while acting)', () => {
  const person = accessOf(
    grant({ permissions: ['dis.report.*', 'approval.decide'], scope: { kind: 'UNIT_SUBTREE', refIds: [UNIT], paths: ['/1/'] } }),
    grant({ roleCode: 'VIEWER', permissions: ['bi.dashboard.read'] }),
  );

  it('keeps only the listed permissions of the person, with the scope of the grant that holds them', () => {
    const restricted = restrictAccessForActing(person, ['dis.report.submit'], undefined);
    expect(restricted.grants).toHaveLength(1);
    expect(restricted.grants[0]).toMatchObject({ roleCode: 'REPORTER', permissions: ['dis.report.submit'], scope: { kind: 'UNIT_SUBTREE' } });
    expect(restricted.membershipId).toBe('m1');
  });

  it('gives nothing the person does not hold, and a listed pattern grant is narrowed to the name', () => {
    expect(restrictAccessForActing(person, ['dis.report.export', 'pay.payment.create'], undefined).grants).toHaveLength(1);
    expect(restrictAccessForActing(person, ['pay.payment.create'], undefined).grants).toEqual([]);
  });

  it('narrows to the periods listed, and to what both limits allow', () => {
    expect(restrictAccessForActing(person, ['dis.report.submit'], ['2026-Q3']).grants[0]?.periodCodes).toEqual(['2026-Q3']);
    const limited = accessOf(grant({ periodCodes: ['2026-Q4'] }));
    expect(restrictAccessForActing(limited, ['dis.report.submit'], ['2026-Q3']).grants).toEqual([]);
    expect(restrictAccessForActing(limited, ['dis.report.submit'], ['2026']).grants[0]?.periodCodes).toEqual(['2026-Q4']);
  });
});
