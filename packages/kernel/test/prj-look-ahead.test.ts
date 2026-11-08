import { builtInDefault, validateRuleParams } from '../src/governance-rules.ts';
import {
  assertConstraintKind,
  assertItems,
  assertLesson,
  assertOutcome,
  assertWindow,
  isMonday,
  itemState,
  lessonsDefaults,
  lessonsGate,
  lessonsPolicyOf,
  lookAheadDefaults,
  lookAheadPolicyOf,
  mondayOf,
  planOverdue,
  ppcOf,
  windowEnd,
} from '../src/prj-look-ahead.ts';

const policy = lookAheadPolicyOf(lookAheadDefaults());
const lessons = lessonsPolicyOf(lessonsDefaults());

describe('the look-ahead plan (G1-19)', () => {
  it('has a window of 2 to 6 weeks that starts on a Monday', () => {
    expect(policy).toMatchObject({ minWeeks: 2, maxWeeks: 6, defaultWeeks: 3 });
    expect(() => assertWindow('2026-11-09', 2, policy)).not.toThrow();
    expect(() => assertWindow('2026-11-09', 6, policy)).not.toThrow();
    expect(() => assertWindow('2026-11-09', 1, policy)).toThrow(expect.objectContaining({ code: 'LOOK_AHEAD_WINDOW_INVALID' }));
    expect(() => assertWindow('2026-11-09', 7, policy)).toThrow(expect.objectContaining({ code: 'LOOK_AHEAD_WINDOW_INVALID' }));
    expect(() => assertWindow('2026-11-10', 3, policy)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(windowEnd('2026-11-09', 3)).toBe('2026-11-30');
    expect(isMonday('2026-11-09')).toBe(true);
    expect(mondayOf('2026-11-15')).toBe('2026-11-09');
  });

  it('asks every item for words, an order of days and a start inside the window', () => {
    const good = { description: 'Pour the slab', plannedStart: '2026-11-10', plannedFinish: '2026-11-12', responsible: null };
    expect(() => assertItems([good], '2026-11-09', 3)).not.toThrow();
    expect(() => assertItems([], '2026-11-09', 3)).toThrow(expect.objectContaining({ detail: 'items' }));
    expect(() => assertItems([{ ...good, description: 'no' }], '2026-11-09', 3)).toThrow(expect.objectContaining({ detail: 'items[0].description' }));
    expect(() => assertItems([{ ...good, plannedFinish: '2026-11-09' }], '2026-11-09', 3)).toThrow(expect.objectContaining({ detail: 'items[0].planned_finish' }));
    expect(() => assertItems([{ ...good, plannedStart: '2026-11-30', plannedFinish: '2026-12-01' }], '2026-11-09', 3)).toThrow(expect.objectContaining({ detail: 'items[0].planned_start' }));
  });

  it('judges an item by its constraints and the lead days of the rule', () => {
    const open = (days: number, count: number) => itemState({ plannedStart: `2026-11-${String(9 + days).padStart(2, '0')}`, outcome: 'PLANNED', openConstraints: count }, '2026-11-09', policy);
    expect(open(2, 0)).toBe('READY');
    expect(open(7, 1)).toBe('NOT_READY');
    expect(open(8, 1)).toBe('CONSTRAINED');
    expect(open(-3, 1)).toBe('NOT_READY');
    expect(itemState({ plannedStart: '2026-11-10', outcome: 'DONE', openConstraints: 2 }, '2026-11-09', policy)).toBe('DONE');
    expect(itemState({ plannedStart: '2026-11-10', outcome: 'NOT_DONE', openConstraints: 0 }, '2026-11-09', policy)).toBe('NOT_DONE');
  });

  it('measures the percent plan complete of the items that were recorded, never of those still planned', () => {
    expect(ppcOf(['PLANNED', 'PLANNED'], policy)).toEqual({ committed: 0, done: 0, pct: null, band: 'NO_DATA' });
    expect(ppcOf(['DONE', 'DONE', 'DONE', 'DONE', 'NOT_DONE', 'PLANNED'], policy)).toEqual({ committed: 5, done: 4, pct: '80.0', band: 'ON_TARGET' });
    expect(ppcOf(['DONE', 'DONE', 'DONE', 'NOT_DONE', 'NOT_DONE'], policy)).toMatchObject({ pct: '60.0', band: 'BELOW_TARGET' });
    expect(ppcOf(['DONE', 'NOT_DONE', 'NOT_DONE'], policy)).toMatchObject({ pct: '33.3', band: 'ALERT' });
    expect(ppcOf(['DONE', 'DONE', 'NOT_DONE'], policy)).toMatchObject({ pct: '66.7' });
  });

  it('asks a not-done item for a reason of the list and a done one for none', () => {
    expect(assertOutcome('DONE', undefined, policy)).toBe('DONE');
    expect(assertOutcome('NOT_DONE', 'WEATHER', policy)).toBe('NOT_DONE');
    expect(() => assertOutcome('DONE', 'WEATHER', policy)).toThrow(expect.objectContaining({ detail: 'reason_code' }));
    expect(() => assertOutcome('NOT_DONE', undefined, policy)).toThrow(expect.objectContaining({ detail: 'reason_code' }));
    expect(() => assertOutcome('NOT_DONE', 'MADE_UP', policy)).toThrow(expect.objectContaining({ detail: 'reason_code' }));
    expect(() => assertOutcome('SKIPPED', undefined, policy)).toThrow(expect.objectContaining({ detail: 'outcome' }));
    expect(() => assertConstraintKind('MATERIAL', policy)).not.toThrow();
    expect(() => assertConstraintKind('MADE_UP', policy)).toThrow(expect.objectContaining({ detail: 'kind' }));
  });

  it('calls a plan overdue when the newest one began longer ago than the cadence, or none was ever made', () => {
    expect(planOverdue('2026-11-09', '2026-11-15', policy, null)).toBe(false);
    expect(planOverdue('2026-11-02', '2026-11-20', policy, null)).toBe(true);
    expect(planOverdue(null, '2026-11-20', policy, '2026-11-01')).toBe(true);
    expect(planOverdue(null, '2026-11-05', policy, '2026-11-01')).toBe(false);
    expect(planOverdue(null, '2026-11-20', policy, null)).toBe(false);
  });

  it('is a governance rule with defaults that pass the schema and are flagged not confirmed, and refuses a window that cannot be', () => {
    expect(validateRuleParams('LOOK_AHEAD_POLICY', lookAheadDefaults())).toEqual(lookAheadDefaults());
    expect(builtInDefault('LOOK_AHEAD_POLICY', 'DEFAULT')).toMatchObject({ unverified: true });
    expect(() => validateRuleParams('LOOK_AHEAD_POLICY', { ...lookAheadDefaults(), min_weeks: 5, max_weeks: 3 })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
    expect(() => validateRuleParams('LOOK_AHEAD_POLICY', { ...lookAheadDefaults(), constraint_kinds: ['MATERIAL'] })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
  });
});

describe('the lessons learned and the closing gate (G1-19)', () => {
  const draft = { category: 'PLANNING', title: 'Plan the site access earlier', situation: 'The access road was not ready when the crews arrived.', recommendation: 'Clear the site access before the contract starts.' };

  it('asks a lesson for a category of the list and enough words', () => {
    expect(() => assertLesson(draft, lessons)).not.toThrow();
    expect(() => assertLesson({ ...draft, category: 'NOPE' }, lessons)).toThrow(expect.objectContaining({ detail: 'category' }));
    expect(() => assertLesson({ ...draft, title: 'Hi' }, lessons)).toThrow(expect.objectContaining({ detail: 'title' }));
    expect(() => assertLesson({ ...draft, situation: 'Too short' }, lessons)).toThrow(expect.objectContaining({ detail: 'situation' }));
    expect(() => assertLesson({ ...draft, recommendation: 'Too short' }, lessons)).toThrow(expect.objectContaining({ detail: 'recommendation' }));
  });

  it('is met by approved lessons or an approved waiver, and says what is missing otherwise', () => {
    const facts = { gate: 'CLOSE', approved: 0, pending: 0, waiverApproved: false, waiverPending: false };
    expect(lessonsGate(facts, lessons)).toEqual({ met: false, reason: 'MISSING', required: 1, approved: 0 });
    expect(lessonsGate({ ...facts, pending: 2 }, lessons)).toMatchObject({ met: false, reason: 'PENDING_REVIEW' });
    expect(lessonsGate({ ...facts, waiverPending: true }, lessons)).toMatchObject({ met: false, reason: 'WAIVER_PENDING' });
    expect(lessonsGate({ ...facts, approved: 1 }, lessons)).toMatchObject({ met: true, reason: 'APPROVED_LESSONS' });
    expect(lessonsGate({ ...facts, waiverApproved: true }, lessons)).toMatchObject({ met: true, reason: 'WAIVER_APPROVED' });
    expect(lessonsGate({ ...facts, waiverApproved: true }, { ...lessons, allowWaiver: false })).toMatchObject({ met: false, reason: 'MISSING' });
    expect(lessonsGate({ ...facts, gate: 'OTHER' }, lessons)).toMatchObject({ met: true, reason: 'NOT_REQUIRED' });
    expect(lessonsGate(facts, { ...lessons, minApproved: 0 })).toMatchObject({ met: true, reason: 'NOT_REQUIRED' });
  });

  it('is a governance rule with defaults that pass the schema and are flagged not confirmed', () => {
    expect(validateRuleParams('LESSONS_LEARNED_POLICY', lessonsDefaults())).toEqual(lessonsDefaults());
    expect(builtInDefault('LESSONS_LEARNED_POLICY', 'DEFAULT')).toMatchObject({ unverified: true });
    expect(() => validateRuleParams('LESSONS_LEARNED_POLICY', { ...lessonsDefaults(), min_approved: 99 })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
  });
});
