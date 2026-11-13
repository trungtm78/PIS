import { DomainError } from '../src/errors.ts';
import { builtInCodes, builtInDefault, provenanceOf, validateRuleParams } from '../src/governance-rules.ts';
import {
  KPI_OPERATION_CODES,
  STAFF_SCORING_POLICY_RULE_TYPE,
  WORKFLOW_KPI_SET_RULE_TYPE,
  aggregateStaffPeriod,
  applyAdjustment,
  assertAdjustmentAllowed,
  assertAdjustmentRequestable,
  canOfficialize,
  convertScore,
  gamingSignals,
  itemApplies,
  kpiOperationOf,
  kpiSetReferences,
  parseKpiSet,
  parseStaffScoringPolicy,
  periodSnapshotHash,
  ratingOf,
  scoreTask,
  taskScoreOf,
} from '../src/workflow-kpi.ts';
import type { KpiSetItem, StaffPeriodTask, TaskFacts } from '../src/workflow-kpi.ts';
import type { WorkCalendarContent, WorkCalendarSource } from '../src/working-time.ts';

/** 2026: Monday to Friday, Wednesday 11 November a holiday (a made-up day for the fixture). 2027 is not published. */
const CALENDAR_2026: WorkCalendarContent = { calendar_code: 'WORKDAY_VN', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-11', name: 'Ngày nghỉ thử' }], legal_basis_ref: 'fixture' };
const CALENDARS: WorkCalendarSource = { forYear: (year) => (year === 2026 ? CALENDAR_2026 : undefined) };

const facts = (patch: Partial<TaskFacts> = {}): TaskFacts => ({
  taskCode: 'T1',
  baselineDueFirst: '2026-11-06',
  baselineDueCurrent: '2026-11-06',
  actualFinish: '2026-11-12',
  actualStart: '2026-11-02',
  status: 'DONE',
  cancelApproved: false,
  asOf: '2026-11-20',
  estimateVnd: 1_000_000,
  actualVnd: 1_100_000,
  returnCount: 0,
  requiredEvidence: 4,
  providedEvidence: 3,
  rescheduleCount: 0,
  excusals: [],
  priority: 'NORMAL',
  plannedWorkingDays: 5,
  ...patch,
});

const VERSIONS = [{ year: 2026, version: 1 }];
const compute = (code: (typeof KPI_OPERATION_CODES)[number], input: TaskFacts | TaskFacts[], params: Record<string, unknown> = {}, calendars: WorkCalendarSource | null = CALENDARS) =>
  kpiOperationOf(code).compute(Array.isArray(input) ? input : [input], params, { calendars: calendars ?? undefined });

describe('the catalogue of operations is closed and declared', () => {
  it('lists six operations with a unit, a direction and a level', () => {
    expect([...KPI_OPERATION_CODES].sort()).toEqual(['AMOUNT_VARIANCE_PCT', 'DAYS_DEVIATION', 'EVIDENCE_COMPLETENESS', 'ON_TIME_RATE', 'RESCHEDULE_COUNT', 'RETURN_COUNT']);
    for (const code of KPI_OPERATION_CODES) {
      const operation = kpiOperationOf(code);
      expect(['PERCENT', 'VND', 'COUNT', 'DAYS', 'RATIO']).toContain(operation.unit);
      expect(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER']).toContain(operation.direction);
      expect(['TASK', 'TASK_SET']).toContain(operation.level);
      expect(operation.reads.length).toBeGreaterThan(0);
    }
    expect(kpiOperationOf('ON_TIME_RATE').level).toBe('TASK_SET');
    expect(kpiOperationOf('DAYS_DEVIATION').direction).toBe('LOWER_IS_BETTER');
  });

  it('refuses an operation nobody registered', () => {
    expect(() => kpiOperationOf('EVAL_JS' as never)).toThrow(DomainError);
  });

  it('refuses to compute a per-task operation over several tasks', () => {
    expect(() => compute('RETURN_COUNT', [facts(), facts({ taskCode: 'T2' })])).toThrow(DomainError);
    expect(() => compute('RETURN_COUNT', [])).toThrow(DomainError);
  });
});

describe('DAYS_DEVIATION', () => {
  it('counts working days from the first baseline due to the actual finish', () => {
    // Fri 6 Nov to Thu 12 Nov: 9, 10, (11 is a holiday), 12.
    expect(compute('DAYS_DEVIATION', facts())).toMatchObject({ state: 'OK', value: 3 });
  });

  it('counts calendar days when asked', () => {
    expect(compute('DAYS_DEVIATION', facts(), { unit: 'CALENDAR' })).toMatchObject({ state: 'OK', value: 6 });
  });

  it('reads the current baseline only when asked, the first one otherwise', () => {
    const moved = facts({ baselineDueCurrent: '2026-11-10' });
    expect(compute('DAYS_DEVIATION', moved)).toMatchObject({ value: 3 });
    expect(compute('DAYS_DEVIATION', moved, { against: 'CURRENT_BASELINE' })).toMatchObject({ value: 1 });
  });

  it('is negative for a task that finished early', () => {
    expect(compute('DAYS_DEVIATION', facts({ actualFinish: '2026-11-04' }))).toMatchObject({ state: 'OK', value: -2 });
    expect(compute('DAYS_DEVIATION', facts({ actualFinish: '2026-11-06' }))).toMatchObject({ state: 'OK', value: 0 });
  });

  it('subtracts the days of an approved pause that fall in the late window, never below zero', () => {
    const paused = facts({ excusals: [{ kind: 'APPROVED_PAUSE', from: '2026-11-09', to: '2026-11-10' }] });
    expect(compute('DAYS_DEVIATION', paused)).toMatchObject({ value: 1 });
    expect(compute('DAYS_DEVIATION', paused, { unit: 'CALENDAR' })).toMatchObject({ value: 4 });
    const all = facts({ excusals: [{ kind: 'APPROVED_EXTERNAL_DELAY', from: '2026-11-01', to: '2026-11-30' }] });
    expect(compute('DAYS_DEVIATION', all)).toMatchObject({ state: 'OK', value: 0 });
  });

  it('clips an excusal to the late window and merges overlapping ones', () => {
    const overlapping = facts({
      excusals: [
        { kind: 'APPROVED_PAUSE', from: '2026-10-01', to: '2026-11-09' },
        { kind: 'APPROVED_EXTERNAL_DELAY', from: '2026-11-09', to: '2026-11-10' },
        { kind: 'APPROVED_PAUSE', from: '2026-12-01', to: '2026-12-05' },
      ],
    });
    // The window is 7 to 12 November; 9 and 10 are excused once, not twice.
    expect(compute('DAYS_DEVIATION', overlapping)).toMatchObject({ value: 1 });
  });

  it('does not touch an on-time task with an excusal', () => {
    const early = facts({ actualFinish: '2026-11-05', excusals: [{ kind: 'APPROVED_PAUSE', from: '2026-11-02', to: '2026-11-03' }] });
    expect(compute('DAYS_DEVIATION', early)).toMatchObject({ value: -1 });
  });

  it('measures an open overdue task up to the day it is looked at, and says nothing of one that is not due yet', () => {
    expect(compute('DAYS_DEVIATION', facts({ status: 'IN_PROGRESS', actualFinish: null, asOf: '2026-11-10' }))).toMatchObject({ state: 'OK', value: 2 });
    expect(compute('DAYS_DEVIATION', facts({ status: 'NOT_STARTED', actualFinish: null, asOf: '2026-11-05' }))).toMatchObject({ state: 'NOT_APPLICABLE', value: null });
  });

  it('leaves out a cancelled task and names what is missing', () => {
    expect(compute('DAYS_DEVIATION', facts({ status: 'CANCELLED' }))).toMatchObject({ state: 'EXCLUDED', value: null });
    expect(compute('DAYS_DEVIATION', facts({ baselineDueFirst: null }))).toMatchObject({ state: 'MISSING_FACT', value: null });
    expect(compute('DAYS_DEVIATION', facts({ actualFinish: null }))).toMatchObject({ state: 'MISSING_FACT' });
  });

  it('never guesses a year without a calendar', () => {
    const across = facts({ actualFinish: '2027-01-08', excusals: [] });
    expect(compute('DAYS_DEVIATION', across)).toMatchObject({ state: 'MISSING_FACT', detail: { reason: 'CALENDAR_UNAVAILABLE' } });
    expect(compute('DAYS_DEVIATION', facts(), {}, null)).toMatchObject({ state: 'MISSING_FACT', detail: { reason: 'CALENDAR_UNAVAILABLE' } });
    expect(compute('DAYS_DEVIATION', facts({ actualFinish: '2027-01-08', excusals: [{ kind: 'APPROVED_PAUSE', from: '2026-12-01', to: '2026-12-02' }] }), { unit: 'CALENDAR' })).toMatchObject({ state: 'OK', value: 63 - 2 });
  });

  it('refuses an excusal whose days run backwards', () => {
    expect(() => compute('DAYS_DEVIATION', facts({ excusals: [{ kind: 'APPROVED_PAUSE', from: '2026-11-10', to: '2026-11-09' }] }))).toThrow(DomainError);
  });

  it('counts an early finish in working days as negative and refuses a year without a calendar', () => {
    expect(compute('DAYS_DEVIATION', facts({ baselineDueFirst: '2027-01-05', actualFinish: '2026-12-30' }))).toMatchObject({ state: 'MISSING_FACT' });
  });
});

describe('ON_TIME_RATE', () => {
  const late = facts({ taskCode: 'LATE' });
  const onTime = facts({ taskCode: 'OK', actualFinish: '2026-11-06' });

  it('is the share of due tasks finished by the baseline due', () => {
    expect(compute('ON_TIME_RATE', [onTime, late])).toMatchObject({ state: 'OK', value: 50 });
    expect(compute('ON_TIME_RATE', [onTime, onTime])).toMatchObject({ value: 100 });
  });

  it('forgives the days of grace given by the item', () => {
    expect(compute('ON_TIME_RATE', [onTime, late], { graceDays: 3 })).toMatchObject({ value: 100 });
    expect(compute('ON_TIME_RATE', [onTime, late], { graceDays: 2 })).toMatchObject({ value: 50 });
  });

  it('lets a late task whose lateness is excused leave both numerator and denominator', () => {
    const excused = facts({ taskCode: 'EXC', excusals: [{ kind: 'APPROVED_EXTERNAL_DELAY', from: '2026-11-09', to: '2026-11-12' }] });
    expect(compute('ON_TIME_RATE', [onTime, late, excused])).toMatchObject({ value: 50, detail: { onTime: 1, due: 2, excused: 1 } });
    const partly = facts({ taskCode: 'PART', excusals: [{ kind: 'APPROVED_PAUSE', from: '2026-11-09', to: '2026-11-09' }] });
    expect(compute('ON_TIME_RATE', [onTime, partly])).toMatchObject({ value: 50 });
  });

  it('counts an open task that is overdue as late and ignores one that is not due yet', () => {
    const overdue = facts({ taskCode: 'OPEN', status: 'IN_PROGRESS', actualFinish: null, asOf: '2026-11-10' });
    const future = facts({ taskCode: 'FUT', status: 'NOT_STARTED', actualFinish: null, asOf: '2026-11-04' });
    expect(compute('ON_TIME_RATE', [onTime, overdue, future])).toMatchObject({ value: 50, detail: { due: 2 } });
  });

  it('is not applicable when nothing is due and missing when a done task has no finish', () => {
    expect(compute('ON_TIME_RATE', [facts({ status: 'CANCELLED' })])).toMatchObject({ state: 'NOT_APPLICABLE', value: null });
    expect(compute('ON_TIME_RATE', [facts({ status: 'NOT_STARTED', actualFinish: null, asOf: '2026-11-04' })])).toMatchObject({ state: 'NOT_APPLICABLE' });
    expect(compute('ON_TIME_RATE', [facts({ actualFinish: null })])).toMatchObject({ state: 'MISSING_FACT', value: null });
    expect(compute('ON_TIME_RATE', [facts({ baselineDueFirst: null })])).toMatchObject({ state: 'MISSING_FACT' });
    expect(compute('ON_TIME_RATE', [onTime, facts({ taskCode: 'GAP', actualFinish: null })])).toMatchObject({ state: 'OK', value: 100, detail: { missing: 1 } });
  });

  it('reads the current baseline when asked', () => {
    const moved = facts({ baselineDueCurrent: '2026-11-12' });
    expect(compute('ON_TIME_RATE', [moved])).toMatchObject({ value: 0 });
    expect(compute('ON_TIME_RATE', [moved], { against: 'CURRENT_BASELINE' })).toMatchObject({ value: 100 });
  });
});

describe('AMOUNT_VARIANCE_PCT', () => {
  it('is the percentage over (positive) or under (negative) the estimate', () => {
    expect(compute('AMOUNT_VARIANCE_PCT', facts())).toMatchObject({ state: 'OK', value: 10 });
    expect(compute('AMOUNT_VARIANCE_PCT', facts({ actualVnd: 900_000 }))).toMatchObject({ value: -10 });
    expect(compute('AMOUNT_VARIANCE_PCT', facts({ actualVnd: 1_000_333 }))).toMatchObject({ value: 0.03 });
  });

  it('is not applicable for a zero estimate, missing for an absent amount, excluded when cancelled', () => {
    expect(compute('AMOUNT_VARIANCE_PCT', facts({ estimateVnd: 0 }))).toMatchObject({ state: 'NOT_APPLICABLE', value: null });
    expect(compute('AMOUNT_VARIANCE_PCT', facts({ actualVnd: null }))).toMatchObject({ state: 'MISSING_FACT' });
    expect(compute('AMOUNT_VARIANCE_PCT', facts({ estimateVnd: null }))).toMatchObject({ state: 'MISSING_FACT' });
    expect(compute('AMOUNT_VARIANCE_PCT', facts({ status: 'CANCELLED' }))).toMatchObject({ state: 'EXCLUDED' });
  });

  it('refuses an amount that is not a whole number of dong', () => {
    expect(() => compute('AMOUNT_VARIANCE_PCT', facts({ actualVnd: 10.5 }))).toThrow(DomainError);
    expect(() => compute('AMOUNT_VARIANCE_PCT', facts({ estimateVnd: -1 }))).toThrow(DomainError);
  });
});

describe('RETURN_COUNT, EVIDENCE_COMPLETENESS and RESCHEDULE_COUNT', () => {
  it('counts the returns', () => {
    expect(compute('RETURN_COUNT', facts({ returnCount: 2 }))).toMatchObject({ state: 'OK', value: 2 });
    expect(compute('RETURN_COUNT', facts({ status: 'CANCELLED' }))).toMatchObject({ state: 'EXCLUDED' });
    expect(() => compute('RETURN_COUNT', facts({ returnCount: -1 }))).toThrow(DomainError);
  });

  it('is the share of required evidence that was provided, never above the requirement of one task', () => {
    expect(compute('EVIDENCE_COMPLETENESS', facts())).toMatchObject({ state: 'OK', value: 75 });
    const surplus = facts({ taskCode: 'S', requiredEvidence: 1, providedEvidence: 5 });
    expect(compute('EVIDENCE_COMPLETENESS', [facts(), surplus])).toMatchObject({ value: 80 });
    expect(compute('EVIDENCE_COMPLETENESS', facts({ requiredEvidence: 0, providedEvidence: 2 }))).toMatchObject({ state: 'NOT_APPLICABLE', value: null });
    expect(compute('EVIDENCE_COMPLETENESS', [facts({ status: 'CANCELLED' })])).toMatchObject({ state: 'NOT_APPLICABLE' });
    expect(() => compute('EVIDENCE_COMPLETENESS', facts({ providedEvidence: -1 }))).toThrow(DomainError);
  });

  it('counts the reschedules that no approved outside delay accounts for', () => {
    expect(compute('RESCHEDULE_COUNT', facts({ rescheduleCount: 3 }))).toMatchObject({ state: 'OK', value: 3 });
    const external = facts({ rescheduleCount: 3, excusals: [{ kind: 'APPROVED_EXTERNAL_DELAY', from: '2026-11-09', to: '2026-11-10' }, { kind: 'APPROVED_PAUSE', from: '2026-11-02', to: '2026-11-02' }] });
    expect(compute('RESCHEDULE_COUNT', external)).toMatchObject({ value: 2 });
    expect(compute('RESCHEDULE_COUNT', facts({ rescheduleCount: 0, excusals: external.excusals }))).toMatchObject({ value: 0 });
    expect(compute('RESCHEDULE_COUNT', facts({ status: 'CANCELLED' }))).toMatchObject({ state: 'EXCLUDED' });
  });
});

describe('convertScore', () => {
  it('maps linearly in either direction and clamps', () => {
    const lower = { kind: 'LINEAR', worst: 10, best: 0 } as const;
    expect(convertScore(0, lower)).toBe(100);
    expect(convertScore(10, lower)).toBe(0);
    expect(convertScore(2.5, lower)).toBe(75);
    expect(convertScore(-4, lower)).toBe(100);
    expect(convertScore(40, lower)).toBe(0);
    const higher = { kind: 'LINEAR', worst: 50, best: 100 } as const;
    expect(convertScore(75, higher)).toBe(50);
    expect(convertScore(100, higher)).toBe(100);
    expect(convertScore(1 / 3 + 50, higher)).toBe(0.67);
  });

  it('steps down for a figure that must stay low (AT_MOST) and up for one that must stay high (AT_LEAST)', () => {
    const atMost = { kind: 'STEPPED', mode: 'AT_MOST', steps: [{ bound: 0, score: 100 }, { bound: 1, score: 80 }, { bound: 2, score: 60 }], otherwiseScore: 30 } as const;
    expect([0, 1, 2, 3, -1].map((value) => convertScore(value, atMost))).toEqual([100, 80, 60, 30, 100]);
    const atLeast = { kind: 'STEPPED', mode: 'AT_LEAST', steps: [{ bound: 95, score: 100 }, { bound: 80, score: 70 }], otherwiseScore: 20 } as const;
    expect([100, 95, 94.99, 80, 79].map((value) => convertScore(value, atLeast))).toEqual([100, 100, 70, 70, 20]);
  });

  it('refuses a figure that is not a number and a scale that cannot be read', () => {
    expect(() => convertScore(Number.NaN, { kind: 'LINEAR', worst: 0, best: 1 })).toThrow(DomainError);
    expect(() => convertScore(1, { kind: 'LINEAR', worst: 1, best: 1 })).toThrow(DomainError);
  });
});

const item = (patch: Partial<KpiSetItem> = {}): KpiSetItem => ({
  kpiCode: 'PWF_TASK_DEVIATION_DAYS',
  operation: 'DAYS_DEVIATION',
  operationParams: {},
  appliesTo: {},
  weight: 40,
  scale: { kind: 'LINEAR', worst: 10, best: 0 },
  ragCode: null,
  ...patch,
});

describe('scoreTask and taskScoreOf', () => {
  it('turns a value into a score and records what it read', () => {
    const result = scoreTask(facts(), item(), { calendars: CALENDARS, calendarVersions: VERSIONS });
    expect(result).toMatchObject({ kpiCode: 'PWF_TASK_DEVIATION_DAYS', operation: 'DAYS_DEVIATION', state: 'OK', value: 3, score: 70, weight: 40 });
    expect(result.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(scoreTask(facts(), item(), { calendars: CALENDARS, calendarVersions: VERSIONS }).inputsHash).toBe(result.inputsHash);
    expect(scoreTask(facts({ actualFinish: '2026-11-13' }), item(), { calendars: CALENDARS, calendarVersions: VERSIONS }).inputsHash).not.toBe(result.inputsHash);
    // the calendar behind a working-day result is part of what was read
    expect(scoreTask(facts(), item(), { calendars: CALENDARS, calendarVersions: [{ year: 2026, version: 2 }] }).inputsHash).not.toBe(result.inputsHash);
    expect(() => scoreTask(facts(), item(), { calendars: CALENDARS })).toThrow(DomainError);
    // a fact the operation does not read does not move the hash
    expect(scoreTask(facts({ returnCount: 9 }), item(), { calendars: CALENDARS, calendarVersions: VERSIONS }).inputsHash).toBe(result.inputsHash);
  });

  it('has no score when the operation gave none', () => {
    expect(scoreTask(facts({ estimateVnd: 0 }), item({ operation: 'AMOUNT_VARIANCE_PCT' }), {})).toMatchObject({ state: 'NOT_APPLICABLE', value: null, score: null });
  });

  it('averages the scores by weight, re-normalised over the items that have one, and says what it left out', () => {
    const a = { ...scoreTask(facts(), item(), { calendars: CALENDARS, calendarVersions: VERSIONS }), weight: 40 };
    const b = { ...scoreTask(facts({ returnCount: 1 }), item({ kpiCode: 'PWF_RETURN_COUNT', operation: 'RETURN_COUNT', scale: { kind: 'STEPPED', mode: 'AT_MOST', steps: [{ bound: 0, score: 100 }, { bound: 1, score: 80 }], otherwiseScore: 30 }, weight: 10 }), {}), weight: 10 };
    const c = scoreTask(facts({ estimateVnd: 0 }), item({ kpiCode: 'PWF_AMOUNT_VARIANCE_PCT', operation: 'AMOUNT_VARIANCE_PCT', weight: 50 }), {});
    expect(taskScoreOf([a, b, c])).toEqual({ score: 72, leftOut: [{ kpiCode: 'PWF_AMOUNT_VARIANCE_PCT', reason: 'NOT_APPLICABLE' }] });
    expect(taskScoreOf([c])).toEqual({ score: null, leftOut: [{ kpiCode: 'PWF_AMOUNT_VARIANCE_PCT', reason: 'NOT_APPLICABLE' }] });
    expect(taskScoreOf([])).toEqual({ score: null, leftOut: [] });
  });

  it('applies an item to the tasks it names', () => {
    expect(itemApplies(item(), { taskCode: 'T1', taskKind: 'TASK', phase: 'PREP' })).toBe(true);
    expect(itemApplies(item({ appliesTo: { taskKinds: ['MILESTONE'] } }), { taskCode: 'T1', taskKind: 'TASK', phase: 'PREP' })).toBe(false);
    expect(itemApplies(item({ appliesTo: { phases: ['PREP'] } }), { taskCode: 'T1', taskKind: 'TASK', phase: 'PREP' })).toBe(true);
    expect(itemApplies(item({ appliesTo: { phases: ['IMPL'] } }), { taskCode: 'T1', taskKind: 'TASK', phase: 'PREP' })).toBe(false);
    expect(itemApplies(item({ appliesTo: { tasks: ['T2'] } }), { taskCode: 'T1', taskKind: 'TASK', phase: 'PREP' })).toBe(false);
    expect(itemApplies(item({ appliesTo: { tasks: ['T1'], taskKinds: ['TASK'], phases: ['PREP'] } }), { taskCode: 'T1', taskKind: 'TASK', phase: 'PREP' })).toBe(true);
  });
});

describe('the rule types', () => {
  it('registers WORKFLOW_KPI_SET and STAFF_SCORING_POLICY with a provenance', () => {
    for (const type of [WORKFLOW_KPI_SET_RULE_TYPE, STAFF_SCORING_POLICY_RULE_TYPE]) {
      const provenance = provenanceOf(type, 'DEFAULT_PROJECT_WORKFLOW');
      expect(provenance).toMatchObject({ legalStatus: 'UNVERIFIED', asOf: '2026-11-12' });
      expect(provenance?.formula.length).toBeGreaterThan(20);
      expect(provenance?.source.length).toBeGreaterThan(5);
    }
    expect(builtInCodes(WORKFLOW_KPI_SET_RULE_TYPE)).toEqual(['DEFAULT_PROJECT_WORKFLOW']);
    expect(builtInCodes(STAFF_SCORING_POLICY_RULE_TYPE)).toEqual(['DEFAULT']);
  });

  it('only references KPI_DEFINITION codes and RAG codes that exist (R37)', () => {
    const set = builtInDefault(WORKFLOW_KPI_SET_RULE_TYPE, 'DEFAULT_PROJECT_WORKFLOW');
    expect(set).toBeDefined();
    const references = kpiSetReferences(set?.params ?? {});
    expect(references.kpiCodes.length).toBe(6);
    for (const code of references.kpiCodes) expect(builtInCodes('KPI_DEFINITION')).toContain(code);
    expect(references.ragCodes).toEqual(['PWF_SCORE']);
    for (const code of references.ragCodes) expect(builtInCodes('RAG_THRESHOLDS')).toContain(code);
    expect(references.templateCode).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(builtInDefault('RAG_THRESHOLDS', 'PWF_SCORE')?.params).toMatchObject({ direction: 'HIGHER_IS_BETTER', green: 80, amber: 60 });
    expect(builtInDefault('KPI_DEFINITION', 'PWF_ON_TIME_RATE')?.params).toMatchObject({ unit: 'PERCENT' });
    expect(builtInDefault('KPI_DEFINITION', 'PWF_TASK_DEVIATION_DAYS')?.params).toMatchObject({ unit: 'DAYS' });
  });

  it('scores a task with the default set, weights summing to 100', () => {
    const set = parseKpiSet(builtInDefault(WORKFLOW_KPI_SET_RULE_TYPE, 'DEFAULT_PROJECT_WORKFLOW')?.params);
    expect(set.items.reduce((sum, one) => sum + one.weight, 0)).toBe(100);
    const results = set.items.map((one) => scoreTask(facts(), one, { calendars: CALENDARS, calendarVersions: VERSIONS }));
    const { score } = taskScoreOf(results);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(builtInDefault(WORKFLOW_KPI_SET_RULE_TYPE, 'DEFAULT_PROJECT_WORKFLOW')?.params)) as Record<string, unknown>;
  const itemsOf = (params: Record<string, unknown>): Array<Record<string, unknown>> => params.items as Array<Record<string, unknown>>;
  const failing = (params: unknown): string | undefined => {
    try {
      validateRuleParams(WORKFLOW_KPI_SET_RULE_TYPE, params);
      return undefined;
    } catch (failure) {
      return failure instanceof DomainError ? failure.detail : 'other';
    }
  };

  it('accepts the default and refuses what the schema or the refine cannot accept', () => {
    expect(failing(valid())).toBeUndefined();
    const duplicate = valid();
    itemsOf(duplicate)[1]!.kpi_code = itemsOf(duplicate)[0]!.kpi_code;
    expect(failing(duplicate)).toBe('items[1].kpi_code');
    const unknownOperation = valid();
    itemsOf(unknownOperation)[0]!.operation = 'RUN_SCRIPT';
    expect(failing(unknownOperation)).toBe('items[0].operation');
    const noFormula = valid();
    itemsOf(noFormula)[0]!.formula = 'x*2';
    expect(failing(noFormula)).toBe('items[0].formula');
    const flat = valid();
    itemsOf(flat)[0]!.scale = { kind: 'LINEAR', worst: 5, best: 5 };
    expect(failing(flat)).toBe('items[0].scale');
    const missingBound = valid();
    itemsOf(missingBound)[0]!.scale = { kind: 'LINEAR', worst: 5 };
    expect(failing(missingBound)).toBe('items[0].scale');
    const mixed = valid();
    itemsOf(mixed)[0]!.scale = { kind: 'LINEAR', worst: 5, best: 0, steps: [{ bound: 1, score: 1 }] };
    expect(failing(mixed)).toBe('items[0].scale');
    const stepsWithoutMode = valid();
    itemsOf(stepsWithoutMode)[0]!.scale = { kind: 'STEPPED', steps: [{ bound: 1, score: 1 }], otherwise_score: 0 };
    expect(failing(stepsWithoutMode)).toBe('items[0].scale');
    const noSteps = valid();
    itemsOf(noSteps)[0]!.scale = { kind: 'STEPPED', mode: 'AT_MOST', otherwise_score: 0 };
    expect(failing(noSteps)).toBe('items[0].scale');
    const noOtherwise = valid();
    itemsOf(noOtherwise)[0]!.scale = { kind: 'STEPPED', mode: 'AT_MOST', steps: [{ bound: 1, score: 1 }] };
    expect(failing(noOtherwise)).toBe('items[0].scale');
    const wrongOrder = valid();
    itemsOf(wrongOrder)[0]!.scale = { kind: 'STEPPED', mode: 'AT_MOST', steps: [{ bound: 2, score: 50 }, { bound: 1, score: 80 }], otherwise_score: 0 };
    expect(failing(wrongOrder)).toBe('items[0].scale');
    const wrongOrderAtLeast = valid();
    itemsOf(wrongOrderAtLeast)[0]!.scale = { kind: 'STEPPED', mode: 'AT_LEAST', steps: [{ bound: 1, score: 50 }, { bound: 2, score: 80 }], otherwise_score: 0 };
    expect(failing(wrongOrderAtLeast)).toBe('items[0].scale');
    const stepsOnLinear = valid();
    itemsOf(stepsOnLinear)[0]!.scale = { kind: 'LINEAR', worst: 5, best: 0, otherwise_score: 1 };
    expect(failing(stepsOnLinear)).toBe('items[0].scale');
    const modeOnLinear = valid();
    itemsOf(modeOnLinear)[0]!.scale = { kind: 'LINEAR', worst: 5, best: 0, mode: 'AT_MOST' };
    expect(failing(modeOnLinear)).toBe('items[0].scale');
    const badGrace = valid();
    itemsOf(badGrace)[0]!.operation_params = { grace_days: 99 };
    expect(failing(badGrace)).toBe('items[0].operation_params.grace_days');
    const badTemplate = valid();
    badTemplate.template_code = 'lower';
    expect(failing(badTemplate)).toBe('template_code');
    expect(failing({ ...valid(), items: [] })).toBe('items');
  });

  it('reads the optional members of an item', () => {
    const params = valid();
    Object.assign(itemsOf(params)[0]!, { applies_to: { task_kinds: ['TASK'], phases: ['PREPARATION'], tasks: ['T1'] }, operation_params: { unit: 'CALENDAR', against: 'CURRENT_BASELINE', grace_days: 2 } });
    expect(failing(params)).toBeUndefined();
    const parsed = parseKpiSet(params);
    expect(parsed.items[0]).toMatchObject({ appliesTo: { taskKinds: ['TASK'], phases: ['PREPARATION'], tasks: ['T1'] }, operationParams: { unit: 'CALENDAR', against: 'CURRENT_BASELINE', graceDays: 2 } });
    expect(parsed.items[1]?.appliesTo).toEqual({});
  });
});

describe('the staff scoring policy', () => {
  const validPolicy = (): Record<string, unknown> => JSON.parse(JSON.stringify(builtInDefault(STAFF_SCORING_POLICY_RULE_TYPE, 'DEFAULT')?.params)) as Record<string, unknown>;
  const failing = (params: unknown): string | undefined => {
    try {
      validateRuleParams(STAFF_SCORING_POLICY_RULE_TYPE, params);
      return undefined;
    } catch (failure) {
      return failure instanceof DomainError ? failure.detail : 'other';
    }
  };

  it('has the starting values of the review', () => {
    const policy = parseStaffScoringPolicy(validPolicy());
    expect(policy).toMatchObject({
      periodKind: 'QUARTER',
      roleFactors: { RESPONSIBLE: 1, ACCOUNTABLE: 0.5, CONSULTED: 0.2, INFORMED: 0 },
      priorityWeights: { LOW: 0.5, NORMAL: 1, HIGH: 1.5, CRITICAL: 2 },
      weightByPlannedDays: true,
      cancelledUnapproved: 'COUNT_AS_MISSED',
      minRatedTasks: 5,
      responseWindowDays: 10,
    });
    expect(policy.bands.map((band) => band.code)).toEqual(['EXCELLENT', 'GOOD', 'FAIR', 'WEAK']);
    expect(policy.calibration.requiresSecondApprover).toBe(true);
  });

  it('refuses bands that are not strictly descending, duplicated or do not end at zero', () => {
    const ascending = validPolicy();
    ascending.bands = [{ code: 'LOW', min_score: 10 }, { code: 'HIGH', min_score: 50 }, { code: 'ZERO', min_score: 0 }];
    expect(failing(ascending)).toBe('bands[1].min_score');
    const noZero = validPolicy();
    noZero.bands = [{ code: 'AA', min_score: 90 }, { code: 'BB', min_score: 50 }];
    expect(failing(noZero)).toBe('bands');
    const duplicate = validPolicy();
    duplicate.bands = [{ code: 'AA', min_score: 90 }, { code: 'AA', min_score: 0 }];
    expect(failing(duplicate)).toBe('bands[1].code');
    expect(failing({ ...validPolicy(), bands: [{ code: 'AA', min_score: 0 }] })).toBe('bands');
    expect(failing({ ...validPolicy(), min_rated_tasks: 0 })).toBe('min_rated_tasks');
    expect(failing({ ...validPolicy(), extra: 1 })).toBe('extra');
    expect(failing(validPolicy())).toBeUndefined();
  });

  it('gives a rating by the first band the score reaches', () => {
    const { bands } = parseStaffScoringPolicy(validPolicy());
    expect([100, 90, 89.99, 75, 60, 59.99, 0].map((score) => ratingOf(score, bands))).toEqual(['EXCELLENT', 'EXCELLENT', 'GOOD', 'GOOD', 'FAIR', 'WEAK', 'WEAK']);
    expect(() => ratingOf(Number.NaN, bands)).toThrow(DomainError);
  });
});

const policy = parseStaffScoringPolicy(JSON.parse(JSON.stringify(builtInDefault(STAFF_SCORING_POLICY_RULE_TYPE, 'DEFAULT')?.params)) as Record<string, unknown>);
const small = { ...policy, minRatedTasks: 1, minEffectiveWeight: 0 };

const task = (code: string, patch: Partial<StaffPeriodTask> = {}): StaffPeriodTask => ({
  taskCode: code,
  taskScore: 80,
  state: 'RATED',
  priority: 'NORMAL',
  plannedWorkingDays: 1,
  windowFrom: '2026-10-05',
  windowTo: '2026-10-09',
  assignments: [{ membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-10-01', to: null, sharePct: 100 }],
  ...patch,
});
const base = { periodFrom: '2026-10-01', periodTo: '2026-12-31', policy: small };
const of = (result: ReturnType<typeof aggregateStaffPeriod>, id: string) => result.find((entry) => entry.membershipId === id);

describe('aggregateStaffPeriod: the score of a person in a period', () => {
  it('is the weighted mean of the scores of the tasks, weighted by priority and planned days', () => {
    const result = aggregateStaffPeriod({
      ...base,
      tasks: [task('A', { taskScore: 100, priority: 'HIGH', plannedWorkingDays: 4 }), task('B', { taskScore: 50, priority: 'NORMAL', plannedWorkingDays: 4 })],
    });
    // weights 1.5*4 = 6 and 1*4 = 4: (6*100 + 4*50) / 10 = 80
    expect(of(result, 'ann')).toMatchObject({ score: 80, rating: 'GOOD', state: 'RATED', ratedTaskCount: 2, effectiveWeight: 10 });
    expect(of(result, 'ann')?.contributions).toEqual([
      { taskCode: 'A', fraction: 1, weight: 6, score: 100 },
      { taskCode: 'B', fraction: 1, weight: 4, score: 50 },
    ]);
  });

  it('can weight every task alike when the policy says so', () => {
    const result = aggregateStaffPeriod({ ...base, policy: { ...small, weightByPlannedDays: false }, tasks: [task('A', { taskScore: 100, plannedWorkingDays: 40 }), task('B', { taskScore: 0, plannedWorkingDays: 1 })] });
    expect(of(result, 'ann')?.score).toBe(50);
  });

  it('splits a task between two people by the interval each held it', () => {
    const result = aggregateStaffPeriod({
      ...base,
      tasks: [
        task('A', {
          taskScore: 90,
          assignments: [
            { membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-10-01', to: '2026-10-06', sharePct: 100 },
            { membershipId: 'bob', role: 'RESPONSIBLE', from: '2026-10-07', to: null, sharePct: 100 },
          ],
        }),
      ],
    });
    // the window is 5 to 9 October (5 calendar days): ann 2 days, bob 3 days
    expect(of(result, 'ann')?.contributions[0]).toMatchObject({ fraction: 0.4, weight: 0.4 });
    expect(of(result, 'bob')?.contributions[0]).toMatchObject({ fraction: 0.6, weight: 0.6 });
  });

  it('counts working days when calendars are given', () => {
    const result = aggregateStaffPeriod({
      ...base,
      calendars: CALENDARS,
      tasks: [
        task('A', {
          windowFrom: '2026-11-06',
          windowTo: '2026-11-13',
          assignments: [
            { membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-11-06', to: '2026-11-10', sharePct: 100 },
            { membershipId: 'bob', role: 'RESPONSIBLE', from: '2026-11-11', to: null, sharePct: 100 },
          ],
        }),
      ],
    });
    // working days 6, 9, 10, 12, 13: ann has 3 of 5
    expect(of(result, 'ann')?.contributions[0]?.fraction).toBe(0.6);
    expect(of(result, 'bob')?.contributions[0]?.fraction).toBe(0.4);
  });

  it('falls back to calendar days for a window with no working day or no calendar', () => {
    const weekend = aggregateStaffPeriod({ ...base, calendars: CALENDARS, tasks: [task('A', { windowFrom: '2026-11-07', windowTo: '2026-11-08' })] });
    expect(of(weekend, 'ann')?.contributions[0]?.fraction).toBe(1);
    const noYear = aggregateStaffPeriod({ ...base, calendars: CALENDARS, tasks: [task('A', { windowFrom: '2027-01-04', windowTo: '2027-01-08' })] });
    expect(of(noYear, 'ann')?.contributions[0]?.fraction).toBe(1);
  });

  it('shares a task by percentage, and the role factor scales the part', () => {
    const result = aggregateStaffPeriod({
      ...base,
      tasks: [
        task('A', {
          assignments: [
            { membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-10-01', to: null, sharePct: 60 },
            { membershipId: 'bob', role: 'RESPONSIBLE', from: '2026-10-01', to: null, sharePct: 40 },
            { membershipId: 'cat', role: 'ACCOUNTABLE', from: '2026-10-01', to: null, sharePct: 100 },
            { membershipId: 'dan', role: 'INFORMED', from: '2026-10-01', to: null, sharePct: 100 },
          ],
        }),
      ],
    });
    expect(of(result, 'ann')?.contributions[0]?.fraction).toBe(0.6);
    expect(of(result, 'bob')?.contributions[0]?.fraction).toBe(0.4);
    expect(of(result, 'cat')?.contributions[0]?.fraction).toBe(0.5);
    expect(of(result, 'dan')).toMatchObject({ score: null, state: 'NOT_RATED', excluded: [{ taskCode: 'A', reason: 'NO_SHARE' }] });
  });

  it('caps what one person holds on a task at the whole task', () => {
    const result = aggregateStaffPeriod({
      ...base,
      tasks: [task('A', { assignments: [{ membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-10-01', to: null, sharePct: 100 }, { membershipId: 'ann', role: 'ACCOUNTABLE', from: '2026-10-01', to: null, sharePct: 100 }] })],
    });
    expect(of(result, 'ann')?.contributions[0]?.fraction).toBe(1);
  });

  it('refuses shares of one role that add up to more than the whole at any moment', () => {
    const over = task('A', {
      assignments: [
        { membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-10-01', to: null, sharePct: 70 },
        { membershipId: 'bob', role: 'RESPONSIBLE', from: '2026-10-07', to: null, sharePct: 40 },
      ],
    });
    expect(() => aggregateStaffPeriod({ ...base, tasks: [over] })).toThrow(expect.objectContaining({ code: 'STAFF_SCORE_SHARE_INVALID', status: 422 }));
    const apart = task('A', {
      assignments: [
        { membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-10-01', to: '2026-10-06', sharePct: 100 },
        { membershipId: 'bob', role: 'RESPONSIBLE', from: '2026-10-07', to: null, sharePct: 100 },
      ],
    });
    expect(() => aggregateStaffPeriod({ ...base, tasks: [apart] })).not.toThrow();
    for (const bad of [0, 101, 12.5]) {
      expect(() => aggregateStaffPeriod({ ...base, tasks: [task('A', { assignments: [{ membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-10-01', to: null, sharePct: bad }] })] })).toThrow(DomainError);
    }
    expect(() => aggregateStaffPeriod({ ...base, tasks: [task('A', { assignments: [{ membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-10-09', to: '2026-10-01', sharePct: 100 }] })] })).toThrow(DomainError);
    expect(() => aggregateStaffPeriod({ ...base, tasks: [task('A', { windowFrom: '2026-10-09', windowTo: '2026-10-01' })] })).toThrow(DomainError);
  });

  it('counts an unapproved cancellation as a miss and leaves an approved one out', () => {
    const tasks = [task('DONE1', { taskScore: 100 }), task('GONE', { state: 'CANCELLED_UNAPPROVED', taskScore: null }), task('OK_GONE', { state: 'CANCELLED_APPROVED', taskScore: null })];
    const counted = aggregateStaffPeriod({ ...base, tasks });
    expect(of(counted, 'ann')).toMatchObject({ score: 50, ratedTaskCount: 2, flags: ['CANCELLED_UNAPPROVED_COUNTED'] });
    expect(of(counted, 'ann')?.excluded).toEqual([{ taskCode: 'OK_GONE', reason: 'CANCELLED_APPROVED' }]);
    expect(of(counted, 'ann')?.contributions.find((one) => one.taskCode === 'GONE')).toMatchObject({ score: 0 });
    const ignored = aggregateStaffPeriod({ ...base, policy: { ...small, cancelledUnapproved: 'IGNORE' }, tasks });
    expect(of(ignored, 'ann')).toMatchObject({ score: 100, ratedTaskCount: 1, flags: [] });
    expect(of(ignored, 'ann')?.excluded).toEqual(expect.arrayContaining([{ taskCode: 'GONE', reason: 'CANCELLED_IGNORED' }]));
  });

  it('leaves out tasks that are excused, not started, or have no score, and never divides by zero', () => {
    const result = aggregateStaffPeriod({ ...base, tasks: [task('X', { state: 'EXCLUDED', taskScore: null }), task('N', { state: 'NOT_STARTED', taskScore: null }), task('S', { taskScore: null })] });
    const ann = of(result, 'ann');
    expect(ann).toMatchObject({ score: null, rating: null, state: 'NOT_RATED', ratedTaskCount: 0, effectiveWeight: 0 });
    expect(ann?.excluded.map((one) => one.reason).sort()).toEqual(['EXCLUDED', 'NOT_STARTED', 'NO_SCORE']);
    expect(Number.isNaN(ann?.score)).toBe(false);
  });

  it('shows the score but withholds the rating below the small-sample thresholds', () => {
    const three = [task('A'), task('B'), task('C')];
    const result = aggregateStaffPeriod({ ...base, policy, tasks: three });
    expect(of(result, 'ann')).toMatchObject({ score: 80, rating: null, state: 'SMALL_SAMPLE', ratedTaskCount: 3 });
    const light = aggregateStaffPeriod({ ...base, policy: { ...small, minEffectiveWeight: 10 }, tasks: three });
    expect(of(light, 'ann')).toMatchObject({ rating: null, state: 'SMALL_SAMPLE' });
    const enough = aggregateStaffPeriod({ ...base, policy: { ...policy, minEffectiveWeight: 0 }, tasks: ['A', 'B', 'C', 'D', 'E'].map((code) => task(code)) });
    expect(of(enough, 'ann')).toMatchObject({ rating: 'GOOD', state: 'RATED' });
  });

  it('lists the people in a stable order whatever the order of the tasks', () => {
    const tasks = [task('A', { assignments: [{ membershipId: 'zed', role: 'RESPONSIBLE', from: '2026-10-01', to: null, sharePct: 100 }] }), task('B')];
    expect(aggregateStaffPeriod({ ...base, tasks }).map((entry) => entry.membershipId)).toEqual(['ann', 'zed']);
    expect(aggregateStaffPeriod({ ...base, tasks: [...tasks].reverse() })).toEqual(aggregateStaffPeriod({ ...base, tasks }));
  });

  it('leaves out a person whose assignment lies outside the window', () => {
    const result = aggregateStaffPeriod({ ...base, tasks: [task('A', { assignments: [{ membershipId: 'ann', role: 'RESPONSIBLE', from: '2026-10-20', to: '2026-10-25', sharePct: 100 }] })] });
    expect(of(result, 'ann')).toMatchObject({ state: 'NOT_RATED', excluded: [{ taskCode: 'A', reason: 'NO_SHARE' }] });
  });
});

describe('gamingSignals', () => {
  const t = (code: string, patch: Record<string, unknown> = {}) => ({
    taskCode: code,
    state: 'RATED' as const,
    parentCode: null as string | null,
    createdOn: '2026-09-01',
    plannedWorkingDays: 10,
    baselineDue: '2026-10-20' as string | null,
    finishedOn: '2026-10-20' as string | null,
    assignments: [{ membershipId: 'ann', role: 'RESPONSIBLE' as const, from: '2026-09-01', to: null as string | null }],
    ...patch,
  });
  const input = (tasks: ReturnType<typeof t>[], more: Record<string, unknown> = {}) => ({ periodFrom: '2026-10-01', periodTo: '2026-12-31', baselineLockedOn: '2026-09-15', baselineRevisions: [], tasks, ...more });
  const flagsOf = (result: ReturnType<typeof gamingSignals>, id: string) => result.find((entry) => entry.membershipId === id)?.flags ?? [];

  it('stays quiet for an ordinary person', () => {
    expect(gamingSignals(input([t('A'), t('B'), t('C')]))).toEqual([{ membershipId: 'ann', flags: [] }]);
  });

  it('flags a high share of cancelled tasks once there are enough tasks to say so', () => {
    const many = [t('A'), t('B', { state: 'CANCELLED_UNAPPROVED' }), t('C', { state: 'CANCELLED_APPROVED' }), t('D')];
    expect(flagsOf(gamingSignals(input(many)), 'ann')).toEqual([{ code: 'CANCELLED_SHARE_HIGH', taskCodes: ['B', 'C'] }]);
    expect(flagsOf(gamingSignals(input(many.slice(0, 2))), 'ann')).toEqual([]);
    expect(flagsOf(gamingSignals(input(many, { signalLimits: { cancelledShare: 0.6 } })), 'ann')).toEqual([]);
  });

  it('flags small tasks cut from one parent after the baseline was locked', () => {
    const split = [t('A1', { parentCode: 'P', createdOn: '2026-10-02', plannedWorkingDays: 1 }), t('A2', { parentCode: 'P', createdOn: '2026-10-02', plannedWorkingDays: 2 }), t('A3', { parentCode: 'P', createdOn: '2026-10-03', plannedWorkingDays: 1 }), t('B1', { parentCode: 'Q', createdOn: '2026-10-02', plannedWorkingDays: 1 })];
    expect(flagsOf(gamingSignals(input(split)), 'ann')).toEqual([{ code: 'TASKS_SPLIT_AFTER_BASELINE', taskCodes: ['A1', 'A2', 'A3'] }]);
    const before = split.map((one) => ({ ...one, createdOn: '2026-09-01' }));
    expect(flagsOf(gamingSignals(input(before)), 'ann')).toEqual([]);
    const noLock = gamingSignals(input(split, { baselineLockedOn: null }));
    expect(flagsOf(noLock, 'ann')).toEqual([]);
    expect(flagsOf(gamingSignals(input(split, { signalLimits: { splitMinCount: 4 } })), 'ann')).toEqual([]);
  });

  it('flags a baseline that was revised inside the period for everyone who holds a task', () => {
    const revised = input([t('A')], { baselineRevisions: [{ on: '2026-11-03' }, { on: '2026-08-01' }] });
    expect(flagsOf(gamingSignals(revised), 'ann')).toEqual([{ code: 'BASELINE_REVISED_IN_PERIOD', taskCodes: [] }]);
  });

  it('flags a person who handed a late task over just before its due day', () => {
    const handed = t('L', {
      baselineDue: '2026-10-20',
      finishedOn: '2026-10-30',
      assignments: [
        { membershipId: 'ann', role: 'RESPONSIBLE' as const, from: '2026-09-01', to: '2026-10-18' as string | null },
        { membershipId: 'bob', role: 'RESPONSIBLE' as const, from: '2026-10-19', to: null },
      ],
    });
    const result = gamingSignals(input([handed]));
    expect(flagsOf(result, 'ann')).toEqual([{ code: 'ASSIGNEE_CHANGED_NEAR_DUE', taskCodes: ['L'] }]);
    expect(flagsOf(result, 'bob')).toEqual([]);
    const onTime = { ...handed, finishedOn: '2026-10-19' };
    expect(flagsOf(gamingSignals(input([onTime])), 'ann')).toEqual([]);
    const early = { ...handed, assignments: [{ membershipId: 'ann', role: 'RESPONSIBLE' as const, from: '2026-09-01', to: '2026-09-20' as string | null }] };
    expect(flagsOf(gamingSignals(input([early])), 'ann')).toEqual([]);
    const open = { ...handed, finishedOn: null };
    expect(flagsOf(gamingSignals(input([open])), 'ann')).toEqual([{ code: 'ASSIGNEE_CHANGED_NEAR_DUE', taskCodes: ['L'] }]);
    const noDue = { ...handed, baselineDue: null };
    expect(flagsOf(gamingSignals(input([noDue])), 'ann')).toEqual([]);
  });

  it('never changes a score: the signals are a separate list for the reviewer', () => {
    const tasks = [t('A', { state: 'CANCELLED_UNAPPROVED' }), t('B'), t('C')];
    expect(gamingSignals(input(tasks))).toBeDefined();
  });
});

describe('calibration, the lock of a period and the window of response', () => {
  const adjustment = { points: 5, reason: 'Đã xem lại bằng chứng của kỳ, công việc bị trễ do chờ ý kiến bên ngoài.', requestedBy: 'manager', approvedBy: 'director', subjectMembershipId: 'ann' };
  const failsOn = (patch: Record<string, unknown>) => {
    try {
      assertAdjustmentAllowed(policy, { ...adjustment, ...patch } as typeof adjustment);
      return undefined;
    } catch (failure) {
      expect(failure).toMatchObject({ code: 'STAFF_SCORE_ADJUSTMENT_INVALID', status: 422 });
      return (failure as DomainError).detail;
    }
  };

  it('accepts a reasoned, bounded adjustment approved by a third person', () => {
    expect(failsOn({})).toBeUndefined();
    expect(failsOn({ points: -10 })).toBeUndefined();
  });

  it('refuses too many points, a short reason, no second approver, and an approver who is the maker or the subject', () => {
    expect(failsOn({ points: 11 })).toBe('points');
    expect(failsOn({ points: -11 })).toBe('points');
    expect(failsOn({ points: Number.NaN })).toBe('points');
    expect(failsOn({ reason: 'ngắn quá' })).toBe('reason');
    expect(failsOn({ reason: '   '.repeat(20) })).toBe('reason');
    expect(failsOn({ approvedBy: null })).toBe('approvedBy');
    expect(failsOn({ approvedBy: 'manager' })).toBe('approvedBy');
    expect(failsOn({ approvedBy: 'ann' })).toBe('approvedBy');
    expect(failsOn({ requestedBy: 'ann' })).toBe('requestedBy');
  });

  it('lets a policy without a second approver go on without one, but never lets the subject approve', () => {
    const relaxed = { ...policy, calibration: { ...policy.calibration, requiresSecondApprover: false } };
    expect(() => assertAdjustmentAllowed(relaxed, { ...adjustment, approvedBy: null })).not.toThrow();
    expect(() => assertAdjustmentAllowed(relaxed, { ...adjustment, approvedBy: 'ann' })).toThrow(DomainError);
  });

  it('judges a request before there is an approver: bounded, reasoned, not for oneself, and never of nothing', () => {
    const asked = { points: 5, reason: adjustment.reason, requestedBy: 'manager', subjectMembershipId: 'ann' };
    const failsRequest = (patch: Record<string, unknown>): string | undefined => {
      try {
        assertAdjustmentRequestable(policy, { ...asked, ...patch });
        return undefined;
      } catch (failure) {
        expect(failure).toMatchObject({ code: 'STAFF_SCORE_ADJUSTMENT_INVALID', status: 422 });
        return (failure as DomainError).detail;
      }
    };
    expect(failsRequest({})).toBeUndefined();
    expect(failsRequest({ points: 0 })).toBe('points');
    expect(failsRequest({ points: 12 })).toBe('points');
    expect(failsRequest({ reason: 'ngắn' })).toBe('reason');
    expect(failsRequest({ requestedBy: 'ann' })).toBe('requestedBy');
  });

  it('applies an adjustment inside 0 to 100', () => {
    expect(applyAdjustment(78.5, 5)).toBe(83.5);
    expect(applyAdjustment(98, 5)).toBe(100);
    expect(applyAdjustment(3, -5)).toBe(0);
  });

  it('hashes a snapshot the same however its keys are ordered, and differently when a figure changes', () => {
    const one = periodSnapshotHash({ period: '2026-Q4', scores: [{ id: 'ann', score: 80 }], policy: { v: 3 } });
    const two = periodSnapshotHash({ policy: { v: 3 }, scores: [{ score: 80, id: 'ann' }], period: '2026-Q4' });
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(periodSnapshotHash({ period: '2026-Q4', scores: [{ id: 'ann', score: 81 }], policy: { v: 3 } })).not.toBe(one);
  });

  it('makes a period official after the window, or once every response is handled, and never while one is open', () => {
    const lock = { lockedAt: '2026-10-01', responseWindowDays: 10 };
    expect(canOfficialize({ ...lock, responses: [], today: '2026-10-11' })).toEqual({ official: false, reason: 'WINDOW_OPEN' });
    expect(canOfficialize({ ...lock, responses: [], today: '2026-10-12' })).toEqual({ official: true, reason: 'WINDOW_ENDED' });
    expect(canOfficialize({ ...lock, responses: [{ status: 'HANDLED' }], today: '2026-10-05' })).toEqual({ official: true, reason: 'ALL_HANDLED' });
    expect(canOfficialize({ ...lock, responses: [{ status: 'HANDLED' }, { status: 'OPEN' }], today: '2026-10-05' })).toEqual({ official: false, reason: 'RESPONSES_OPEN' });
    expect(canOfficialize({ ...lock, responses: [{ status: 'OPEN' }], today: '2026-11-30' })).toEqual({ official: false, reason: 'RESPONSES_OPEN' });
    expect(canOfficialize({ ...lock, responses: [{ status: 'HANDLED' }], today: '2026-11-30' })).toEqual({ official: true, reason: 'WINDOW_ENDED' });
  });
});
