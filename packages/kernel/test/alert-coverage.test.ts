import { DomainError } from '../src/errors';
import {
  absencePhaseAt,
  absencePolicyDefaults,
  absencePolicyOf,
  assertValidAbsence,
  assertValidCover,
  coverInForce,
  detectCoverageGaps,
  gapKey,
  nextCoverStatus,
  positionCoverage,
  routeAlert,
  validateAbsence,
  validateCover,
} from '../src/alert-coverage';
import type { AbsenceFacts, CoverContext, CoverEdge, CoverRequest } from '../src/alert-coverage';
import { builtInDefault, validateRuleParams } from '../src/governance-rules';
import type { WorkCalendarSource } from '../src/working-time';

const CALENDAR: WorkCalendarSource = {
  forYear: (year) => (year === 2027 ? { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code 2019' } : undefined),
};
const policy = absencePolicyDefaults();
// Friday 2027-10-15, 10:00 in Vietnam.
const NOW = new Date('2027-10-15T03:00:00Z');
const at = (iso: string): Date => new Date(iso);
const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const cover = (over: Partial<CoverEdge> = {}): CoverEdge => ({
  id: 'c1',
  absentId: 'a',
  deputyId: 'b',
  from: at('2027-10-15T00:00:00Z'),
  until: at('2027-10-25T00:00:00Z'),
  status: 'APPROVED',
  scopeKind: 'ALL',
  sources: [],
  ...over,
});

describe('the absence policy (G2-7)', () => {
  it('is the built-in default of the rule type and passes its own schema and parser', () => {
    const found = builtInDefault('ABSENCE_POLICY', 'DEFAULT');
    expect(found?.unverified).toBe(true);
    expect(absencePolicyOf(found?.params)).toEqual(policy);
    expect(validateRuleParams('ABSENCE_POLICY', found?.params)).toEqual(found?.params);
  });

  it('refuses a policy that is not whole or does not agree with itself', () => {
    expect(refusal(() => absencePolicyOf({ ...policy, deputy_rank_rule: 'ALWAYS' })).detail).toBe('deputy_rank_rule');
    expect(refusal(() => absencePolicyOf({ ...policy, max_cover_days: 400, max_absence_days: 100 })).detail).toBe('max_cover_days');
    expect(refusal(() => absencePolicyOf({ ...policy, max_chain_depth: 0 })).detail).toBe('max_chain_depth');
    expect(refusal(() => absencePolicyOf(null)).detail).toBe('params');
  });
});

describe('declaring an absence (G2-7)', () => {
  const request = { kind: 'LEAVE', from: at('2027-10-18T00:00:00Z'), until: at('2027-10-22T00:00:00Z') };

  it('accepts a window in the future with a known kind and gives the phase by the clock', () => {
    expect(validateAbsence(request, NOW, policy)).toEqual([]);
    expect(absencePhaseAt(request, NOW)).toBe('SCHEDULED');
    expect(absencePhaseAt(request, at('2027-10-19T00:00:00Z'))).toBe('ACTIVE');
    expect(absencePhaseAt(request, at('2027-10-22T00:00:00Z'))).toBe('OVER');
  });

  it('names every defect in the order of the fields', () => {
    expect(validateAbsence({ ...request, kind: 'HOLIDAY' }, NOW, policy)).toEqual([{ field: 'kind', code: 'UNSUPPORTED' }]);
    expect(validateAbsence({ ...request, from: at('2027-10-10T00:00:00Z') }, NOW, policy).map((defect) => defect.code)).toEqual(['IN_THE_PAST']);
    expect(validateAbsence({ ...request, until: at('2027-10-17T00:00:00Z') }, NOW, policy).map((defect) => defect.code)).toEqual(['BEFORE_START']);
    expect(validateAbsence({ ...request, until: at('2028-10-18T00:00:00Z') }, NOW, policy).map((defect) => defect.code)).toEqual(['TOO_LONG']);
    expect(validateAbsence({ ...request, from: new Date('x') }, NOW, policy).map((defect) => defect.code)).toEqual(['MALFORMED']);
    expect(refusal(() => assertValidAbsence({ ...request, kind: 'X' }, NOW, policy))).toMatchObject({ code: 'ALERT_ABSENCE_INVALID', status: 422 });
  });
});

describe('proposing a cover (G2-7)', () => {
  const context = (over: Partial<CoverContext> = {}): CoverContext => ({
    policy,
    now: NOW,
    absent: { id: 'a', rank: 60, active: true },
    deputy: { id: 'b', rank: 60, active: true },
    absence: { from: at('2027-10-18T00:00:00Z'), until: at('2027-10-29T00:00:00Z') },
    existing: [],
    knownSources: ['APPROVAL', 'ISSUE', 'PERMIT'],
    ...over,
  });
  const request = (over: Partial<CoverRequest> = {}): CoverRequest => ({ deputyId: 'b', from: at('2027-10-18T00:00:00Z'), until: at('2027-10-25T00:00:00Z'), scopeKind: 'ALL', sources: [], ...over });
  const codes = (defects: ReturnType<typeof validateCover>): string[] => defects.map((defect) => `${defect.field}:${defect.code}`);

  it('accepts a deputy of the rank of the absent person, inside the absence, for all sources or for some', () => {
    expect(validateCover(request(), context())).toEqual([]);
    expect(validateCover(request({ scopeKind: 'SOURCES', sources: ['ISSUE'] }), context())).toEqual([]);
    expect(validateCover(request(), context({ deputy: { id: 'b', rank: 70, active: true } }))).toEqual([]);
  });

  it('refuses oneself, a person who has left, a lower rank, a window outside the absence and one that is too long', () => {
    expect(codes(validateCover(request({ deputyId: 'a' }), context()))).toEqual(['deputy_id:SELF']);
    expect(codes(validateCover(request(), context({ deputy: { id: 'b', rank: 60, active: false } })))).toEqual(['deputy_id:DEPUTY_INACTIVE']);
    expect(codes(validateCover(request(), context({ deputy: { id: 'b', rank: 40, active: true } })))).toEqual(['deputy_id:RANK_BELOW']);
    expect(validateCover(request(), context({ deputy: { id: 'b', rank: 40, active: true }, policy: { ...policy, deputy_rank_rule: 'ANY' } }))).toEqual([]);
    expect(codes(validateCover(request({ from: at('2027-10-16T00:00:00Z') }), context()))).toEqual(['valid_until:OUTSIDE_ABSENCE']);
    expect(codes(validateCover(request({ until: at('2027-10-30T00:00:00Z') }), context()))).toEqual(['valid_until:OUTSIDE_ABSENCE']);
    const long = context({ absence: { from: at('2027-10-18T00:00:00Z'), until: at('2028-03-01T00:00:00Z') } });
    expect(codes(validateCover(request({ until: at('2028-02-01T00:00:00Z') }), long))).toEqual(['valid_until:TOO_LONG']);
    expect(codes(validateCover(request({ until: at('2027-10-18T00:00:00Z') }), context()))).toEqual(['valid_until:BEFORE_START']);
  });

  it('refuses a scope that is not known and sources that are not sources of the alert centre', () => {
    expect(codes(validateCover(request({ scopeKind: 'UNIT' }), context()))).toEqual(['scope_kind:UNSUPPORTED']);
    expect(codes(validateCover(request({ scopeKind: 'SOURCES' }), context()))).toEqual(['sources:REQUIRED']);
    expect(codes(validateCover(request({ scopeKind: 'SOURCES', sources: ['ISSUE', 'ISSUE'] }), context()))).toEqual(['sources:DUPLICATE']);
    expect(codes(validateCover(request({ scopeKind: 'SOURCES', sources: ['LUNCH'] }), context()))).toEqual(['sources:UNSUPPORTED']);
    expect(codes(validateCover(request({ scopeKind: 'ALL', sources: ['ISSUE'] }), context()))).toEqual(['sources:UNSUPPORTED']);
  });

  it('refuses a loop (A covers B while B covers A) and a chain deeper than the policy allows', () => {
    const back = cover({ id: 'x', absentId: 'b', deputyId: 'a', status: 'PENDING', from: at('2027-10-18T00:00:00Z'), until: at('2027-10-25T00:00:00Z') });
    expect(codes(validateCover(request(), context({ existing: [back] })))).toEqual(['deputy_id:LOOP']);
    const three = [cover({ id: 'x', absentId: 'b', deputyId: 'c', from: at('2027-10-18T00:00:00Z') }), cover({ id: 'y', absentId: 'c', deputyId: 'd', from: at('2027-10-18T00:00:00Z') })];
    expect(codes(validateCover(request(), context({ existing: three })))).toEqual(['deputy_id:CHAIN_TOO_DEEP']);
    expect(validateCover(request(), context({ existing: three, policy: { ...policy, max_chain_depth: 3 } }))).toEqual([]);
    // A cover that ended before the window does not count.
    expect(validateCover(request(), context({ existing: [cover({ ...back, until: at('2027-10-17T00:00:00Z'), from: at('2027-10-01T00:00:00Z') })] }))).toEqual([]);
  });

  it('refuses the same cover said twice, but not a different deputy or a revoked one', () => {
    const same = cover({ id: 'x', absentId: 'a', deputyId: 'b', status: 'PENDING', from: at('2027-10-20T00:00:00Z') });
    expect(codes(validateCover(request(), context({ existing: [same] })))).toEqual(['deputy_id:OVERLAP']);
    expect(validateCover(request(), context({ existing: [{ ...same, status: 'REVOKED' }] }))).toEqual([]);
    expect(codes(validateCover(request({ scopeKind: 'SOURCES', sources: ['ISSUE'] }), context({ existing: [{ ...same, scopeKind: 'SOURCES', sources: ['PERMIT'] }] })))).toEqual([]);
    expect(refusal(() => assertValidCover(request({ deputyId: 'a' }), context()))).toMatchObject({ code: 'ALERT_COVER_INVALID', detail: 'deputy_id' });
  });
});

describe('the life of a cover (G2-7)', () => {
  const who = { actor: 'boss', requester: 'a', absent: 'a', deputy: 'b' };

  it('is allowed or rejected by a third person and ends by a revocation', () => {
    expect(nextCoverStatus('PENDING', 'APPROVE', who)).toBe('APPROVED');
    expect(nextCoverStatus('PENDING', 'REJECT', who)).toBe('REJECTED');
    expect(nextCoverStatus('APPROVED', 'REVOKE', who)).toBe('REVOKED');
    expect(nextCoverStatus('PENDING', 'REVOKE', who)).toBe('REVOKED');
  });

  it('is never allowed by the absent person, the deputy or the person who proposed it', () => {
    for (const actor of ['a', 'b', 'c']) {
      expect(refusal(() => nextCoverStatus('PENDING', 'APPROVE', { actor, requester: 'c', absent: 'a', deputy: 'b' }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    }
    expect(refusal(() => nextCoverStatus('PENDING', 'REJECT', { ...who, actor: 'B' }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    // The absent person is back, or the deputy hands it over: either may revoke.
    expect(nextCoverStatus('APPROVED', 'REVOKE', { ...who, actor: 'a' })).toBe('REVOKED');
    expect(nextCoverStatus('APPROVED', 'REVOKE', { ...who, actor: 'b' })).toBe('REVOKED');
  });

  it('moves only from where the move starts', () => {
    expect(refusal(() => nextCoverStatus('APPROVED', 'APPROVE', who))).toMatchObject({ code: 'ALERT_COVER_STATE_INVALID', status: 409 });
    expect(refusal(() => nextCoverStatus('REJECTED', 'REVOKE', who))).toMatchObject({ code: 'ALERT_COVER_STATE_INVALID' });
    expect(refusal(() => nextCoverStatus('REVOKED', 'REVOKE', who))).toMatchObject({ code: 'ALERT_COVER_STATE_INVALID' });
  });

  it('is in force only when allowed and inside its window', () => {
    expect(coverInForce(cover(), NOW)).toBe(true);
    expect(coverInForce(cover({ status: 'PENDING' }), NOW)).toBe(false);
    expect(coverInForce(cover({ from: at('2027-10-16T00:00:00Z') }), NOW)).toBe(false);
    expect(coverInForce(cover({ until: at('2027-10-15T03:00:00Z') }), NOW)).toBe(false);
  });
});

describe('where an alert goes (G2-7)', () => {
  const absence = (membershipId: string): { membershipId: string; from: Date; until: Date } => ({ membershipId, from: at('2027-10-15T00:00:00Z'), until: at('2027-10-25T00:00:00Z') });
  const route = (over: Record<string, unknown> = {}): ReturnType<typeof routeAlert> => routeAlert({ owner: 'a', source: 'ISSUE', now: NOW, policy, absences: [], covers: [], ...over });

  it('goes to the owner when they are present, and to the deputy when they are away and a cover that is in force names the source', () => {
    expect(route()).toMatchObject({ recipient: 'a', via: 'OWNER' });
    expect(route({ absences: [absence('a')], covers: [cover()] })).toMatchObject({ recipient: 'b', via: 'DEPUTY', coverId: 'c1', chain: ['a', 'b'] });
    expect(route({ absences: [absence('a')], covers: [cover({ scopeKind: 'SOURCES', sources: ['ISSUE'] })] })).toMatchObject({ recipient: 'b', via: 'DEPUTY' });
  });

  it('is an orphan when the owner is away and nobody covers the source, with the reason', () => {
    expect(route({ absences: [absence('a')] })).toMatchObject({ recipient: null, via: 'ORPHAN', reason: 'ABSENT_NO_COVER' });
    expect(route({ absences: [absence('a')], covers: [cover({ scopeKind: 'SOURCES', sources: ['PERMIT'] })] })).toMatchObject({ via: 'ORPHAN', reason: 'ABSENT_NO_COVER' });
    expect(route({ absences: [absence('a')], covers: [cover({ status: 'PENDING' })] })).toMatchObject({ via: 'ORPHAN', reason: 'ABSENT_NO_COVER' });
    expect(route({ absences: [absence('a')], covers: [cover({ status: 'REVOKED' })] })).toMatchObject({ via: 'ORPHAN' });
    expect(route({ inactive: new Set(['a']) })).toMatchObject({ recipient: null, via: 'ORPHAN', reason: 'OWNER_INACTIVE' });
  });

  it('follows the chain within the depth of the policy, and an absent deputy hands it on or leaves it an orphan', () => {
    const covers = [cover(), cover({ id: 'c2', absentId: 'b', deputyId: 'c' })];
    expect(route({ absences: [absence('a'), absence('b')], covers })).toMatchObject({ recipient: 'c', via: 'DEPUTY', chain: ['a', 'b', 'c'] });
    expect(route({ absences: [absence('a'), absence('b')], covers, policy: { ...policy, max_chain_depth: 1 } })).toMatchObject({ via: 'ORPHAN', reason: 'TOO_DEEP' });
    expect(route({ absences: [absence('a'), absence('b')], covers: [cover()] })).toMatchObject({ via: 'ORPHAN', reason: 'CHAIN_ABSENT' });
  });

  it('prefers a deputy who is present, and never goes round a loop', () => {
    const covers = [cover({ id: 'c1', deputyId: 'b' }), cover({ id: 'c2', deputyId: 'c' })];
    expect(route({ absences: [absence('a'), absence('b')], covers })).toMatchObject({ recipient: 'c' });
    const loop = [cover(), cover({ id: 'c2', absentId: 'b', deputyId: 'a' })];
    expect(route({ absences: [absence('a'), absence('b')], covers: loop })).toMatchObject({ via: 'ORPHAN', reason: 'LOOP' });
  });

  it('does not route to a deputy who has left', () => {
    expect(route({ absences: [absence('a')], covers: [cover()], inactive: new Set(['b']) })).toMatchObject({ via: 'ORPHAN', reason: 'ABSENT_NO_COVER' });
  });
});

describe('the gaps in coverage (G2-7)', () => {
  const absence = (over: Partial<AbsenceFacts> = {}): AbsenceFacts => ({ id: 'ab1', membershipId: 'a', from: at('2027-10-14T01:00:00Z'), until: at('2027-10-25T00:00:00Z'), declaredAt: at('2027-10-13T03:00:00Z'), ...over });
  const gaps = (over: Record<string, unknown> = {}): ReturnType<typeof detectCoverageGaps> => detectCoverageGaps({ now: NOW, policy, absences: [absence()], covers: [], calendars: CALENDAR, ...over });

  it('is a gap once an absence with no cover for all sources has lasted a working day', () => {
    // It began Thursday 08:00 and eight working hours later is Thursday 17:00 (10:00 UTC): by Friday 10:00 it is a gap that began then.
    expect(gaps()).toEqual([{ kind: 'ABSENT_NO_COVER', membershipId: 'a', absenceId: 'ab1', since: '2027-10-14T10:00:00.000Z' }]);
    expect(gaps({ now: at('2027-10-14T07:00:00Z') })).toEqual([]);
  });

  it('is not a gap with a cover for all sources in force, but a cover for some sources or one that waits is not cover', () => {
    expect(gaps({ covers: [cover()] })).toEqual([]);
    expect(gaps({ covers: [cover({ scopeKind: 'SOURCES', sources: ['ISSUE'] })] })).toHaveLength(1);
    expect(gaps({ covers: [cover({ status: 'PENDING' })] })).toHaveLength(1);
  });

  it('counts an absence from the day it was declared, not from a day before it was known', () => {
    expect(gaps({ absences: [absence({ declaredAt: at('2027-10-15T02:30:00Z') })] })).toEqual([]);
    expect(gaps({ absences: [absence({ declaredAt: at('2027-10-15T02:30:00Z') })], now: at('2027-10-18T03:00:00Z') })).toHaveLength(1);
  });

  it('does not guess the allowance without a published calendar: the absence is a gap at once', () => {
    expect(gaps({ calendars: undefined, now: at('2027-10-14T02:00:00Z') })).toHaveLength(1);
  });

  it('warns ahead of an absence that starts soon and has no cover proposed, and leaves one that is over', () => {
    const soon = absence({ from: at('2027-10-18T00:00:00Z'), until: at('2027-10-22T00:00:00Z') });
    expect(gaps({ absences: [soon] })).toEqual([{ kind: 'ABSENCE_STARTING_UNCOVERED', membershipId: 'a', absenceId: 'ab1', since: '2027-10-13T03:00:00.000Z' }]);
    expect(gaps({ absences: [soon], covers: [cover({ status: 'PENDING', from: at('2027-10-18T00:00:00Z'), until: at('2027-10-22T00:00:00Z') })] })).toEqual([]);
    expect(gaps({ absences: [absence({ from: at('2027-10-01T00:00:00Z'), until: at('2027-10-10T00:00:00Z') })] })).toEqual([]);
    expect(gaps({ absences: [absence({ from: at('2027-12-01T00:00:00Z'), until: at('2027-12-05T00:00:00Z') })] })).toEqual([]);
  });

  it('has the one series of a gap', () => {
    expect(gapKey('ABSENT_NO_COVER', 'ab1')).toBe('GAP:ABSENT_NO_COVER:ab1');
  });
});

describe('the coverage of positions (G2-7)', () => {
  const holder = (membershipId: string, over: Record<string, unknown> = {}): Parameters<typeof positionCoverage>[0][number] => ({ roleCode: 'LEADER', roleRank: 60, unitId: 'u1', membershipId, present: true, coveredNow: false, ...over });

  it('backs a position up with enough people present or a cover in force, and calls the rest a single point or uncovered', () => {
    const summary = positionCoverage(
      [
        holder('p1'),
        holder('p2'),
        holder('q1', { unitId: 'u2' }),
        holder('r1', { unitId: 'u3', present: false, coveredNow: true }),
        holder('s1', { unitId: 'u4', present: false }),
        holder('t1', { roleCode: 'SPECIALIST', roleRank: 40, unitId: 'u1' }),
      ],
      policy,
    );
    expect(summary.positions.map((position) => `${position.key}:${position.state}`)).toEqual(['LEADER@u1:PEER_BACKED', 'LEADER@u2:SINGLE_POINT', 'LEADER@u3:COVERED', 'LEADER@u4:UNCOVERED']);
    expect(summary).toMatchObject({ backedUp: 2, total: 4, percent: 50 });
  });

  it('is not a hundred percent of nothing', () => {
    expect(positionCoverage([], policy)).toEqual({ positions: [], backedUp: 0, total: 0, percent: null });
    expect(positionCoverage([holder('x', { roleRank: 30 })], policy).percent).toBeNull();
  });
});
