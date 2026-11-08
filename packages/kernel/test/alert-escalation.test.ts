import { DomainError } from '../src/errors';
import {
  PROMOTION_REASON,
  escalationChainLabels,
  escalationPolicyDefaults,
  escalationPolicyOf,
  escalationSeriesKey,
  evaluateEscalation,
  evaluatePromotion,
  levelsToRecord,
  promotionSeriesKey,
  resolveEscalationRecipients,
} from '../src/alert-escalation';
import type { EscalationCandidate, EscalationInput } from '../src/alert-escalation';
import { builtInDefault, validateRuleParams } from '../src/governance-rules';
import type { ItemClocks } from '../src/work-clock';
import type { WorkCalendarSource } from '../src/working-time';

const CALENDAR: WorkCalendarSource = {
  forYear: (year) => (year === 2027 ? { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code 2019' } : undefined),
};
// 2027-10-15 is a Friday. 09:00 in Vietnam is 02:00 UTC; the working hours are 08:00-12:00 and 13:00-17:00.
const FRI_09 = '2027-10-15T02:00:00.000Z';
const FRI_10 = new Date('2027-10-15T03:00:00Z');
const MON_15 = new Date('2027-10-18T08:00:00Z');
const policy = escalationPolicyDefaults();

const breachedClaim = (since: string): Pick<ItemClocks, 'claim' | 'resolve' | 'needsReclaim'> => ({
  claim: { state: 'BREACHED', started_at: '2027-10-15T01:00:00.000Z', due_at: since, met_at: null },
  resolve: null,
  needsReclaim: null,
});

const input = (over: Partial<EscalationInput> = {}): EscalationInput => ({
  severity: 'URGENT',
  now: FRI_10,
  lifecycle: 'NEW',
  clocks: breachedClaim(FRI_09),
  paused: false,
  snoozedUntil: null,
  orphaned: null,
  acknowledged: [],
  policy,
  calendars: CALENDAR,
  ...over,
});

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('the escalation policy (G2-3)', () => {
  it('is the built-in default of the rule type and passes its own schema and parser', () => {
    const found = builtInDefault('ESCALATION_POLICY', 'DEFAULT');
    expect(found?.unverified).toBe(true);
    expect(found?.legalStatus).toBe('UNVERIFIED');
    expect(escalationPolicyOf(found?.params)).toEqual(policy);
    expect(validateRuleParams('ESCALATION_POLICY', found?.params)).toEqual(found?.params);
  });

  it('marks each level functional or hierarchical and never gives a level to an item to be watched', () => {
    expect(policy.steps.URGENT.map((step) => step.kind)).toEqual(['HIERARCHICAL', 'FUNCTIONAL', 'HIERARCHICAL']);
    expect(policy.steps.WATCH).toEqual([]);
    const withWatch = { ...policy, steps: { ...policy.steps, WATCH: [{ kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1 }] } };
    expect(refusal(() => escalationPolicyOf(withWatch)).detail).toBe('steps.WATCH');
  });

  it('refuses a level that does not say what its kind needs', () => {
    const level = (step: Record<string, unknown>): unknown => ({ ...policy, steps: { ...policy.steps, ACTION: [step] } });
    expect(refusal(() => escalationPolicyOf(level({ kind: 'HIERARCHICAL', after_working_hours: 0 }))).detail).toBe('steps.ACTION[0].levels_up');
    expect(refusal(() => escalationPolicyOf(level({ kind: 'FUNCTIONAL', after_working_hours: 0 }))).detail).toBe('steps.ACTION[0].function_role');
    expect(refusal(() => escalationPolicyOf(level({ kind: 'FUNCTIONAL', after_working_hours: 0, function_role: 'auditor' }))).detail).toBe('steps.ACTION[0].function_role');
    expect(refusal(() => escalationPolicyOf(level({ kind: 'HIERARCHICAL', after_working_hours: -1, levels_up: 1 }))).detail).toBe('steps.ACTION[0].after_working_hours');
    expect(refusal(() => escalationPolicyOf(level({ kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1, function_role: 'AUDITOR' }))).detail).toBe('steps.ACTION[0].function_role');
    expect(refusal(() => escalationPolicyOf({ ...policy, triggers: ['OVERDUE', 'OVERDUE'] })).detail).toBe('triggers');
    expect(refusal(() => escalationPolicyOf({ ...policy, admin_fallback_min_rank: 10 })).detail).toBe('admin_fallback_min_rank');
  });

  it('names the levels of the chain for the card of an item', () => {
    const labels = escalationChainLabels(policy, 'URGENT');
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain('1');
    expect(labels[1]).toContain('AUDITOR');
    expect(escalationChainLabels(policy, 'WATCH')).toEqual([]);
  });
});

describe('when the levels are reached (G2-3)', () => {
  it('reaches the first level when the claim time is past and the later ones after their waiting time in working hours', () => {
    const early = evaluateEscalation(input());
    expect(early.basis).toBe('WORKING_TIME');
    expect(early.triggers).toEqual([{ trigger: 'NOT_CLAIMED', since: FRI_09 }]);
    expect(early.reached).toBe(1);
    // 09:00 plus 4 working hours: 3 hours to the noon break, one after it, so 14:00 (07:00 UTC).
    expect(early.levels.map((level) => level.reachedAt)).toEqual([FRI_09, '2027-10-15T07:00:00.000Z', '2027-10-18T07:00:00.000Z']);
    expect(early.nextAt).toBe('2027-10-15T07:00:00.000Z');
    const later = evaluateEscalation(input({ now: MON_15 }));
    expect(later.reached).toBe(3);
    expect(later.nextAt).toBeNull();
    expect(levelsToRecord(later, new Set([1])).map((level) => level.level)).toEqual([2, 3]);
    expect(levelsToRecord(early, new Set())).toHaveLength(1);
  });

  it('holds the later levels for the hold of the severity after a level is acknowledged', () => {
    const acked = evaluateEscalation(input({ now: MON_15, acknowledged: [{ level: 1, ackedAt: new Date('2027-10-15T02:30:00Z') }] }));
    // 09:30 plus 8 working hours is 09:30 of Monday; the next level counts from there.
    expect(acked.levels[1]?.reachedAt).toBe('2027-10-18T02:30:00.000Z');
    expect(acked.levels[2]?.reachedAt).toBe('2027-10-19T02:30:00.000Z');
    expect(acked.reached).toBe(2);
  });

  it('starts from the earliest trigger: not taken up, silent after a claim, past its time', () => {
    const clocks: Pick<ItemClocks, 'claim' | 'resolve' | 'needsReclaim'> = {
      claim: null,
      resolve: { state: 'BREACHED', started_at: null, due_at: '2027-10-14T10:00:00.000Z', met_at: null },
      needsReclaim: { since: '2027-10-15T01:00:00.000Z' },
    };
    const both = evaluateEscalation(input({ lifecycle: 'CLAIMED', clocks }));
    expect(both.triggers.map((one) => one.trigger)).toEqual(['NO_PROGRESS', 'OVERDUE']);
    expect(both.anchor).toBe('2027-10-14T10:00:00.000Z');
    // A claim in progress that is silent is not "not taken up".
    expect(evaluateEscalation(input({ lifecycle: 'CLAIMED' })).basis).toBe('NO_TRIGGER');
  });

  it('does not climb while the item is paused or put off, when it is resolved or only to be watched', () => {
    expect(evaluateEscalation(input({ paused: true })).basis).toBe('NO_TRIGGER');
    expect(evaluateEscalation(input({ snoozedUntil: new Date('2027-10-16T03:00:00Z') })).basis).toBe('NO_TRIGGER');
    expect(evaluateEscalation(input({ snoozedUntil: new Date('2027-10-14T03:00:00Z') })).reached).toBe(1);
    expect(evaluateEscalation(input({ lifecycle: 'RESOLVED' })).basis).toBe('NOT_APPLICABLE');
    expect(evaluateEscalation(input({ severity: 'WATCH' })).basis).toBe('NOT_APPLICABLE');
    expect(evaluateEscalation(input({ clocks: null })).basis).toBe('NO_TRIGGER');
    const noClaimTrigger = evaluateEscalation(input({ policy: { ...policy, triggers: ['OVERDUE'] } }));
    expect(noClaimTrigger.basis).toBe('NO_TRIGGER');
  });

  it('does not guess a level time without a published calendar: the levels that wait are absent and say so', () => {
    const noCalendar = evaluateEscalation(input({ calendars: undefined }));
    expect(noCalendar.basis).toBe('CALENDAR_UNAVAILABLE');
    expect(noCalendar.levels.map((level) => level.reachedAt)).toEqual([FRI_09, null, null]);
    expect(noCalendar.reached).toBe(1);
    const otherYear = evaluateEscalation(input({ calendars: { forYear: (year) => (year === 2027 ? CALENDAR.forYear(2027) : undefined) }, now: new Date('2027-12-31T10:00:00Z'), clocks: breachedClaim('2027-12-31T02:00:00.000Z') }));
    expect(otherYear.basis).toBe('CALENDAR_UNAVAILABLE');
  });

  it('sends an orphaned item up at once by the orphan step, even when it is paused', () => {
    const orphan = evaluateEscalation(input({ clocks: null, paused: true, orphaned: { since: new Date('2027-10-15T01:00:00Z') } }));
    expect(orphan.triggers).toEqual([{ trigger: 'ORPHANED', since: '2027-10-15T01:00:00.000Z' }]);
    expect(orphan.levels).toHaveLength(1);
    expect(orphan.reached).toBe(1);
    expect(orphan.steps).toBe(1);
  });

  it('has the one series of a level and of a promotion', () => {
    expect(escalationSeriesKey('ISSUE', 'abc', 2, 'AAAA')).toBe('ESCALATION:ISSUE:abc:2:aaaa');
    expect(promotionSeriesKey('PERMIT', 'abc')).toBe('PROMOTION:PERMIT:abc');
  });
});

describe('raising an item that is only to be watched (G2-3)', () => {
  const since = new Date('2027-09-20T01:00:00Z');
  const base = { severity: 'WATCH' as const, since, lifecycle: 'NEW' as const, snoozedUntil: null, paused: false, policy, calendars: CALENDAR };

  it('raises it one step when it stayed untouched for the working days of the rule, and says why', () => {
    expect(evaluatePromotion({ ...base, now: FRI_10 })).toEqual({ promote: false, reason: 'NOT_YET' });
    // Twenty working days from Monday 20 September 08:00 end on Friday 15 October at 17:00 (10:00 UTC).
    expect(evaluatePromotion({ ...base, now: new Date('2027-10-15T10:00:00Z') })).toEqual({ promote: true, from: 'WATCH', to: 'ACTION', reasonCode: PROMOTION_REASON, since: '2027-10-15T10:00:00.000Z' });
  });

  it('leaves an item that somebody touched, or that is not to be watched, or when the rule is off', () => {
    const late = new Date('2027-10-18T10:00:00Z');
    expect(evaluatePromotion({ ...base, now: late, lifecycle: 'CLAIMED' })).toEqual({ promote: false, reason: 'TOUCHED' });
    expect(evaluatePromotion({ ...base, now: late, paused: true })).toEqual({ promote: false, reason: 'TOUCHED' });
    expect(evaluatePromotion({ ...base, now: late, snoozedUntil: new Date('2027-10-20T10:00:00Z') })).toEqual({ promote: false, reason: 'TOUCHED' });
    expect(evaluatePromotion({ ...base, now: late, severity: 'ACTION' })).toEqual({ promote: false, reason: 'NOT_WATCH' });
    expect(evaluatePromotion({ ...base, now: late, policy: { ...policy, watch_promotion: { enabled: false, after_working_days: 20 } } })).toEqual({ promote: false, reason: 'DISABLED' });
    expect(evaluatePromotion({ ...base, now: late, calendars: undefined })).toEqual({ promote: false, reason: 'CALENDAR_UNAVAILABLE' });
  });
});

describe('who receives a level (G2-3)', () => {
  const owner = { membershipId: 'owner', rank: 40 };
  const people: EscalationCandidate[] = [
    { membershipId: 'l1', rank: 60, unitDepth: 3, roleCodes: ['LEADER'] },
    { membershipId: 'l1b', rank: 60, unitDepth: 3, roleCodes: ['LEADER'] },
    { membershipId: 'l2', rank: 60, unitDepth: 2, roleCodes: ['LEADER'] },
    { membershipId: 'l3', rank: 70, unitDepth: 1, roleCodes: ['UNIT_ADMIN'] },
    { membershipId: 'aud', rank: 25, unitDepth: 1, roleCodes: ['AUDITOR'] },
    { membershipId: 'admin', rank: 90, unitDepth: 1, roleCodes: ['TENANT_ADMIN'] },
    { membershipId: 'owner', rank: 40, unitDepth: 3, roleCodes: ['SPECIALIST'] },
  ];

  it('picks the leadership tiers above the owner, nearest unit first, a team when two share a tier, and the top tier when asked for more', () => {
    const tier = (levelsUp: number): string[] => resolveEscalationRecipients({ kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: levelsUp }, owner, people, policy).recipients;
    expect(tier(1)).toEqual(['l1', 'l1b']);
    expect(tier(2)).toEqual(['l2']);
    expect(tier(3)).toEqual(['l3']);
    expect(tier(5)).toEqual(['l3']);
    expect(resolveEscalationRecipients({ kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1 }, owner, people, policy).via).toBe('PRIMARY');
  });

  it('never gives a level to the owner, to a person who was excluded, or to someone below the rank the item needs', () => {
    const step = { kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1 } as const;
    expect(resolveEscalationRecipients(step, { membershipId: 'l1', rank: 60 }, people, policy).recipients).toEqual(['l3']);
    expect(resolveEscalationRecipients(step, owner, people, policy, { exclude: ['l1', 'l1b'] }).recipients).toEqual(['l2']);
    // An approval that the matrix of authority gives to rank 65 and above goes to the first tier that can decide it.
    expect(resolveEscalationRecipients(step, owner, people, policy, { minRank: 65 }).recipients).toEqual(['l3']);
  });

  it('gives a function to everybody who holds its role, and falls back and says so when nobody does', () => {
    const functional = resolveEscalationRecipients({ kind: 'FUNCTIONAL', after_working_hours: 4, function_role: 'AUDITOR' }, owner, people, policy);
    expect(functional).toEqual({ recipients: ['aud'], via: 'PRIMARY', gap: null });
    const vacant = resolveEscalationRecipients({ kind: 'FUNCTIONAL', after_working_hours: 4, function_role: 'PLANNER' }, owner, people, policy);
    expect(vacant).toEqual({ recipients: ['l1', 'l1b'], via: 'FALLBACK_HIERARCHY', gap: 'FUNCTION_VACANT' });
  });

  it('falls to the administrators when there is no leadership, and to nobody (an orphan) when there is nothing at all', () => {
    const step = { kind: 'HIERARCHICAL', after_working_hours: 0, levels_up: 1 } as const;
    const onlyAdmin = people.filter((person) => person.rank >= 90 || person.membershipId === 'owner');
    expect(resolveEscalationRecipients(step, owner, onlyAdmin, policy)).toEqual({ recipients: ['admin'], via: 'FALLBACK_ADMIN', gap: 'NO_LEADER' });
    expect(resolveEscalationRecipients(step, owner, [], policy)).toEqual({ recipients: [], via: 'FALLBACK_ADMIN', gap: 'NO_LEADER' });
  });
});
