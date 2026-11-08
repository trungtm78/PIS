import {
  BOTTLENECK_DEFAULTS,
  ageDays,
  allStepsClosed,
  analyseBottlenecks,
  assertPlanApprover,
  bottleneckModelOf,
  bucketOf,
  checkHalt,
  checkHaltClose,
  checkPlanDecision,
  checkRestartPlan,
  checkStepUpdate,
  haltCan,
  planState,
} from '../src/ana-bottleneck';
import type { BottleneckItem } from '../src/ana-bottleneck';

const model = bottleneckModelOf(BOTTLENECK_DEFAULTS as Record<string, unknown>);
const TODAY = '2027-10-20';
const P = '00000000-0000-4000-8000-0000000000a1';
const U = '00000000-0000-4000-8000-0000000000b1';
const M = 1_000_000;

const item = (key: string, over: Partial<BottleneckItem>): BottleneckItem => ({
  key,
  source: 'PAYMENT',
  sourceId: key,
  projectId: P,
  projectCode: 'P-1',
  unitId: U,
  causeCode: 'PAYMENT_PENDING_TREASURY',
  amountVnd: String(500 * M),
  amountNullReason: null,
  since: '2027-10-10',
  holder: { kind: 'EXTERNAL', id: null, name: null, code: 'TREASURY' },
  dedupeKey: null,
  ...over,
});
const noAmount: Partial<BottleneckItem> = { amountVnd: null, amountNullReason: 'NO_AMOUNT' };

describe('the policy of the bottlenecks (G3-9)', () => {
  it('reads the default model and refuses one that is not whole', () => {
    expect(model.causes.map((cause) => cause.code)).toContain('LAND_CLEARANCE');
    expect(model.ageBucketsDays).toEqual([7, 30, 90]);
    expect(() => bottleneckModelOf({ ...BOTTLENECK_DEFAULTS, causes: [{ code: 'OTHER', owner_module: 'PRJ' }] })).toThrow();
    expect(() => bottleneckModelOf({ ...BOTTLENECK_DEFAULTS, age_buckets_days: [30, 7] })).toThrow();
    expect(() => bottleneckModelOf({ ...BOTTLENECK_DEFAULTS, age_buckets_days: [] })).toThrow();
    expect(() => bottleneckModelOf({ ...BOTTLENECK_DEFAULTS, issue_min_severity: 'NONE' })).toThrow();
    expect(() => bottleneckModelOf({ ...BOTTLENECK_DEFAULTS, plan_min_steps: 0 })).toThrow();
  });

  it('measures age in whole days and puts it in the first bucket it does not pass', () => {
    expect(ageDays('2027-10-10', TODAY)).toBe(10);
    expect(ageDays('2027-10-25', TODAY)).toBe(0);
    expect([0, 7, 8, 30, 31, 90, 91].map((age) => bucketOf(model, age))).toEqual(['LE_7', 'LE_7', 'LE_30', 'LE_30', 'LE_90', 'LE_90', 'GT_90']);
  });
});

describe('the analysis of what holds money up (G3-9)', () => {
  const items = [
    item('PAYMENT:p1', {}),
    item('PAYMENT:p2', { amountVnd: String(300 * M), since: '2027-07-20' }),
    item('LAND:l1', { source: 'LAND', causeCode: 'LAND_CLEARANCE', amountVnd: String(1000 * M), since: '2027-10-18', holder: { kind: 'UNIT', id: U, name: 'Unit', code: null }, dedupeKey: 'LAND:plan1' }),
    item('ISSUE:i1', { ...noAmount, source: 'ISSUE', causeCode: 'ISSUE_UNRESOLVED', since: '2027-09-01', holder: { kind: 'PERSON', id: 'x', name: 'Clerk', code: null }, dedupeKey: 'LAND:plan1' }),
    item('ISSUE:i2', { ...noAmount, source: 'ISSUE', causeCode: 'ISSUE_UNRESOLVED', since: '2027-08-01', holder: { kind: 'PERSON', id: 'x', name: 'Clerk', code: null } }),
    item('HALT:h1', { ...noAmount, source: 'HALT', causeCode: 'DESIGN_APPROVAL', since: '2027-05-01', holder: { kind: 'UNIT', id: U, name: 'Unit', code: null } }),
  ];

  it('golden: counts one amount once, ranks by amount times age, and says how many have no amount', () => {
    const analysis = analyseBottlenecks(model, items, TODAY);
    // p2: 300M * 92 days = 27,600M; p1: 500M * 10 = 5,000M; l1: 1,000M * 2 = 2,000M; then the ones with no amount, the oldest first (h1 172 days, i2 80 days). i1 is the issue of the same plan as l1: folded into it.
    expect(analysis.items.map((one) => one.key)).toEqual(['PAYMENT:p2', 'PAYMENT:p1', 'LAND:l1', 'HALT:h1', 'ISSUE:i2']);
    expect(analysis.items.find((one) => one.key === 'LAND:l1')?.mergedKeys).toEqual(['ISSUE:i1']);
    expect(analysis).toMatchObject({ heldVnd: String(1800 * M), noAmount: 2, merged: 1 });
    expect(analysis.items.map((one) => [one.key, one.ageDays, one.bucket])).toEqual([['PAYMENT:p2', 92, 'GT_90'], ['PAYMENT:p1', 10, 'LE_30'], ['LAND:l1', 2, 'LE_7'], ['HALT:h1', 172, 'GT_90'], ['ISSUE:i2', 80, 'LE_90']]);
  });

  it('golden: totals by cause, bucket, holder and unit, with the items that have no amount named', () => {
    const analysis = analyseBottlenecks(model, items, TODAY);
    expect(analysis.byCause.map((total) => [total.key, total.count, total.amountVnd, total.noAmount])).toEqual([
      ['LAND_CLEARANCE', 1, String(1000 * M), 0],
      ['PAYMENT_PENDING_TREASURY', 2, String(800 * M), 0],
      ['DESIGN_APPROVAL', 1, '0', 1],
      ['ISSUE_UNRESOLVED', 1, '0', 1],
    ]);
    expect(analysis.byBucket.map((total) => [total.key, total.count])).toEqual([['LE_7', 1], ['LE_30', 1], ['LE_90', 1], ['GT_90', 2]]);
    expect(analysis.byHolder.find((total) => total.holder.kind === 'EXTERNAL')).toMatchObject({ count: 2, amountVnd: String(800 * M) });
    expect(analysis.byUnit).toHaveLength(1);
    expect(analysis.byUnit[0]).toMatchObject({ count: 5, amountVnd: String(1800 * M), noAmount: 2 });
  });

  it('keeps the one that has an amount when two sources describe one thing, whatever the order', () => {
    const forward = analyseBottlenecks(model, items, TODAY);
    const reversed = analyseBottlenecks(model, [...items].reverse(), TODAY);
    expect(reversed).toEqual(forward);
  });

  it('puts a cause the rule does not know under OTHER and says so, and gives an empty analysis for no item', () => {
    const analysis = analyseBottlenecks(model, [item('PAYMENT:x', { causeCode: 'NEW_CAUSE' })], TODAY);
    expect(analysis.items[0]).toMatchObject({ causeCode: 'OTHER', causeKnown: false });
    expect(analyseBottlenecks(model, [], TODAY)).toMatchObject({ items: [], heldVnd: '0', noAmount: 0, merged: 0, byCause: [] });
  });

  it('an invariant over seeded items: the sum of the causes is the held amount and the order never depends on the input order', () => {
    let seed = 5;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 40; round += 1) {
      const many = Array.from({ length: 12 }, (_, index) => item(`PAYMENT:${index}`, { amountVnd: next() % 4 === 0 ? null : String((next() % 900) * M), amountNullReason: null, since: `2027-0${1 + (next() % 9)}-1${next() % 9}`, dedupeKey: next() % 5 === 0 ? `K${next() % 3}` : null }));
      const fixed = many.map((one) => (one.amountVnd === null ? { ...one, amountNullReason: 'NO_AMOUNT' as const } : one));
      const analysis = analyseBottlenecks(model, fixed, TODAY);
      expect(analysis.byCause.reduce((sum, total) => sum + BigInt(total.amountVnd), 0n).toString()).toBe(analysis.heldVnd);
      expect(analyseBottlenecks(model, [...fixed].reverse(), TODAY)).toEqual(analysis);
    }
  });
});

describe('the dossier of a halted project (G3-9)', () => {
  const halt = { project_id: P, reason_code: 'LAND_CLEARANCE', reason_text: 'Twelve households have not accepted the compensation.', halted_on: '2027-09-01', order_ref: 'Decision 15/QD', expected_restart_on: '2027-12-01' };

  it('checks a halt: the project, the cause from the closed list, the reason in words, the day it began and the day a restart is expected', () => {
    expect(checkHalt(halt, model, TODAY)).toEqual({ projectId: P, reasonCode: 'LAND_CLEARANCE', reasonText: 'Twelve households have not accepted the compensation.', haltedOn: '2027-09-01', orderRef: 'Decision 15/QD', expectedRestartOn: '2027-12-01' });
    expect(checkHalt({ ...halt, order_ref: undefined, expected_restart_on: undefined }, model, TODAY)).toMatchObject({ orderRef: null, expectedRestartOn: null });
    for (const bad of [{ ...halt, project_id: 'x' }, { ...halt, reason_code: 'WHATEVER' }, { ...halt, reason_text: 'short' }, { ...halt, halted_on: '2027-11-01' }, { ...halt, halted_on: '2027-02-30' }, { ...halt, expected_restart_on: '2027-08-01' }, { ...halt, order_ref: '' }]) {
      expect(() => checkHalt(bad, model, TODAY)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
  });

  const step = { title: 'Pay the twelve households', owner_unit_id: U, due_on: '2027-11-15' };
  it('checks a restart plan: enough steps, each with words, an owner and a day that is not past', () => {
    const plan = checkRestartPlan({ steps: [step, { title: 'Hand over the site', owner_id: '00000000-0000-4000-8000-0000000000c1', due_on: '2027-11-30' }], expected_restart_on: '2027-12-01' }, model, TODAY, '2027-09-01');
    expect(plan.steps).toEqual([
      { title: 'Pay the twelve households', ownerId: null, ownerUnitId: U, dueOn: '2027-11-15' },
      { title: 'Hand over the site', ownerId: '00000000-0000-4000-8000-0000000000c1', ownerUnitId: null, dueOn: '2027-11-30' },
    ]);
    expect(plan.expectedRestartOn).toBe('2027-12-01');
    for (const bad of [{ steps: [] }, { steps: [{ ...step, title: 'no' }] }, { steps: [{ title: 'No owner at all', due_on: '2027-11-15' }] }, { steps: [{ ...step, due_on: '2027-10-19' }] }, { steps: [{ ...step, owner_unit_id: 'x' }] }, { steps: [step], expected_restart_on: '2027-08-01' }]) {
      expect(() => checkRestartPlan(bad, model, TODAY, '2027-09-01')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
  });

  it('keeps maker apart from checker, asks for words on every decision and every step', () => {
    expect(() => assertPlanApprover('me', 'me')).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
    expect(() => assertPlanApprover('me', 'you')).not.toThrow();
    expect(checkPlanDecision({ decision: 'APPROVE', note: ' Plan is realistic. ' })).toEqual({ decision: 'APPROVE', note: 'Plan is realistic.' });
    expect(() => checkPlanDecision({ decision: 'RETURN', note: 'no' })).toThrow();
    expect(() => checkPlanDecision({ decision: 'MAYBE', note: 'Plan is realistic.' })).toThrow();
    expect(checkStepUpdate({ status: 'DONE', note: 'All paid on 5 November.' })).toEqual({ status: 'DONE', note: 'All paid on 5 November.' });
    expect(() => checkStepUpdate({ status: 'OPEN', note: 'All paid on 5 November.' })).toThrow();
  });

  it('closes a halt as restarted with the day, or as cancelled with words', () => {
    expect(checkHaltClose({ outcome: 'RESTARTED', note: 'Work is back on site.', restarted_on: '2027-10-18' }, TODAY, '2027-09-01')).toEqual({ outcome: 'RESTARTED', note: 'Work is back on site.', restartedOn: '2027-10-18' });
    expect(checkHaltClose({ outcome: 'CANCELLED', note: 'The project was dropped.' }, TODAY, '2027-09-01')).toMatchObject({ outcome: 'CANCELLED', restartedOn: null });
    for (const bad of [{ outcome: 'RESTARTED', note: 'Work is back on site.' }, { outcome: 'RESTARTED', note: 'Work is back on site.', restarted_on: '2027-10-21' }, { outcome: 'RESTARTED', note: 'Work is back on site.', restarted_on: '2027-08-01' }, { outcome: 'CANCELLED', note: 'The project was dropped.', restarted_on: '2027-10-18' }, { outcome: 'OTHER', note: 'xxxxxx' }]) {
      expect(() => checkHaltClose(bad, TODAY, '2027-09-01')).toThrow();
    }
  });

  it('allows each action only in the state it belongs to, and a restart only when every step is closed', () => {
    expect([haltCan('HALTED', 'PLAN'), haltCan('RESTART_PLANNED', 'PLAN'), haltCan('HALTED', 'DECIDE'), haltCan('RESTART_PLANNED', 'DECIDE')]).toEqual([true, false, true, false]);
    expect([haltCan('RESTART_PLANNED', 'UPDATE_STEP'), haltCan('HALTED', 'UPDATE_STEP'), haltCan('RESTART_PLANNED', 'RESTARTED'), haltCan('HALTED', 'RESTARTED')]).toEqual([true, false, true, false]);
    expect([haltCan('HALTED', 'CANCELLED'), haltCan('RESTART_PLANNED', 'CANCELLED'), haltCan('RESTARTED', 'CANCELLED'), haltCan('CANCELLED', 'CANCELLED')]).toEqual([true, true, false, false]);
    expect(allStepsClosed([])).toBe(false);
    expect(allStepsClosed([{ status: 'DONE', dueOn: '2027-11-01' }, { status: 'DROPPED', dueOn: '2027-11-01' }])).toBe(true);
    expect(allStepsClosed([{ status: 'DONE', dueOn: '2027-11-01' }, { status: 'OPEN', dueOn: '2027-11-01' }])).toBe(false);
  });

  it('tells where the plan stands: none, waiting, on track, overdue or done', () => {
    expect(planState('HALTED', false, [], TODAY)).toBe('NO_PLAN');
    expect(planState('HALTED', true, [{ status: 'OPEN', dueOn: '2027-11-01' }], TODAY)).toBe('AWAITING_APPROVAL');
    expect(planState('RESTART_PLANNED', true, [{ status: 'OPEN', dueOn: '2027-11-01' }], TODAY)).toBe('ON_TRACK');
    expect(planState('RESTART_PLANNED', true, [{ status: 'OPEN', dueOn: '2027-10-19' }, { status: 'DONE', dueOn: '2027-10-01' }], TODAY)).toBe('OVERDUE');
    expect(planState('RESTART_PLANNED', true, [{ status: 'DONE', dueOn: '2027-10-01' }], TODAY)).toBe('ON_TRACK');
    expect(planState('RESTARTED', true, [], TODAY)).toBe('DONE');
    expect(planState('CANCELLED', false, [], TODAY)).toBe('DONE');
  });
});
