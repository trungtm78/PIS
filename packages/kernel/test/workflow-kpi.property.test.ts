import fc from 'fast-check';
import { builtInDefault } from '../src/governance-rules.ts';
import { STAFF_SCORING_POLICY_RULE_TYPE, aggregateStaffPeriod, convertScore, kpiOperationOf, parseStaffScoringPolicy, periodSnapshotHash } from '../src/workflow-kpi.ts';
import type { AssignmentRole, KpiScale, StaffPeriodTask, TaskFacts, TaskPriority } from '../src/workflow-kpi.ts';

const policy = { ...parseStaffScoringPolicy(builtInDefault(STAFF_SCORING_POLICY_RULE_TYPE, 'DEFAULT')?.params), minRatedTasks: 1, minEffectiveWeight: 0 };

const scale: fc.Arbitrary<KpiScale> = fc.oneof(
  fc.record({ kind: fc.constant('LINEAR' as const), worst: fc.integer({ min: -1000, max: 1000 }), best: fc.integer({ min: -1000, max: 1000 }) }).filter((one) => one.worst !== one.best),
  fc.record({
    kind: fc.constant('STEPPED' as const),
    mode: fc.constantFrom('AT_MOST' as const, 'AT_LEAST' as const),
    steps: fc.uniqueArray(fc.integer({ min: -100, max: 100 }), { minLength: 1, maxLength: 5 }).chain((bounds) => fc.tuple(fc.constant(bounds), fc.array(fc.integer({ min: 0, max: 100 }), { minLength: bounds.length, maxLength: bounds.length }))).map(([bounds, scores]) => bounds.map((bound, index) => ({ bound, score: scores[index] as number }))),
    otherwiseScore: fc.integer({ min: 0, max: 100 }),
  }),
);

describe('property: a score is a number from 0 to 100', () => {
  it('convertScore never leaves 0..100 and never gives NaN, for any value on any scale', () => {
    fc.assert(
      fc.property(scale, fc.double({ min: -1e6, max: 1e6, noNaN: true }), (one, value) => {
        const score = convertScore(value, one);
        return Number.isFinite(score) && score >= 0 && score <= 100;
      }),
    );
  });

  it('a linear scale is monotone: a better value never scores lower', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 }), fc.double({ min: -2000, max: 2000, noNaN: true }), fc.double({ min: -2000, max: 2000, noNaN: true }), (worst, best, left, right) => {
        fc.pre(worst !== best);
        const toward = (value: number): number => (best > worst ? value : -value);
        const [lower, higher] = toward(left) <= toward(right) ? [left, right] : [right, left];
        return convertScore(lower, { kind: 'LINEAR', worst, best }) <= convertScore(higher, { kind: 'LINEAR', worst, best });
      }),
    );
  });
});

const facts = (patch: Partial<TaskFacts>): TaskFacts => ({
  taskCode: 'T',
  baselineDueFirst: '2026-11-06',
  baselineDueCurrent: '2026-11-06',
  actualFinish: '2026-11-12',
  actualStart: null,
  status: 'DONE',
  cancelApproved: false,
  asOf: '2026-12-01',
  estimateVnd: 1000,
  actualVnd: 1000,
  returnCount: 0,
  requiredEvidence: 1,
  providedEvidence: 1,
  rescheduleCount: 0,
  excusals: [],
  priority: 'NORMAL',
  plannedWorkingDays: 1,
  ...patch,
});

describe('property: the operations are monotone and total', () => {
  it('a later finish never gives fewer days of deviation, and an excusal never raises it', () => {
    const day = fc.integer({ min: 0, max: 60 }).map((offset) => new Date(Date.UTC(2026, 10, 1) + offset * 86_400_000).toISOString().slice(0, 10));
    fc.assert(
      fc.property(day, day, day, day, (first, second, from, to) => {
        const [early, late] = first <= second ? [first, second] : [second, first];
        const run = (finish: string, excusals: TaskFacts['excusals']) => kpiOperationOf('DAYS_DEVIATION').compute([facts({ actualFinish: finish, excusals })], { unit: 'CALENDAR' }, {}).value as number;
        const excusal = [{ kind: 'APPROVED_PAUSE' as const, from: from <= to ? from : to, to: from <= to ? to : from }];
        return run(early, []) <= run(late, []) && run(late, excusal) <= run(late, []) && run(late, excusal) >= Math.min(0, run(late, []));
      }),
    );
  });

  it('the amount variance is never NaN for whole amounts and a positive estimate', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000_000 }), fc.integer({ min: 0, max: 1_000_000_000_000 }), (estimate, actual) => Number.isFinite(kpiOperationOf('AMOUNT_VARIANCE_PCT').compute([facts({ estimateVnd: estimate, actualVnd: actual })], {}, {}).value)),
    );
  });
});

const taskArb = fc.record({
  state: fc.constantFrom('RATED' as const, 'EXCLUDED' as const, 'CANCELLED_APPROVED' as const, 'CANCELLED_UNAPPROVED' as const, 'NOT_STARTED' as const),
  taskScore: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 100 })),
  priority: fc.constantFrom<TaskPriority>('LOW', 'NORMAL', 'HIGH', 'CRITICAL'),
  plannedWorkingDays: fc.integer({ min: 1, max: 30 }),
  role: fc.constantFrom<AssignmentRole>('RESPONSIBLE', 'ACCOUNTABLE', 'CONSULTED', 'INFORMED'),
  split: fc.integer({ min: 1, max: 9 }),
});

type Row = typeof taskArb extends fc.Arbitrary<infer T> ? T : never;
const tasksOf = (rows: Row[]): StaffPeriodTask[] =>
  rows.map((row, index) => ({
    taskCode: `T${String(index).padStart(3, '0')}`,
    taskScore: row.taskScore,
    state: row.state,
    priority: row.priority,
    plannedWorkingDays: row.plannedWorkingDays,
    windowFrom: '2026-10-05',
    windowTo: '2026-10-14',
    assignments: [
      { membershipId: 'ann', role: row.role, from: '2026-10-01', to: `2026-10-${String(5 + row.split).padStart(2, '0')}`, sharePct: 100 },
      { membershipId: 'bob', role: 'RESPONSIBLE', from: `2026-10-${String(6 + row.split).padStart(2, '0')}`, to: null, sharePct: 100 },
    ],
  }));

const run = (tasks: StaffPeriodTask[]) => aggregateStaffPeriod({ periodFrom: '2026-10-01', periodTo: '2026-12-31', policy, tasks });

describe('property: the score of a person in a period', () => {
  it('is null or a number from 0 to 100, never NaN, with non-negative weights, whatever the tasks', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { maxLength: 12 }), (rows) => {
        for (const person of run(tasksOf(rows))) {
          if (person.score !== null && !(Number.isFinite(person.score) && person.score >= 0 && person.score <= 100)) return false;
          if (person.score === null && person.state !== 'NOT_RATED') return false;
          if (!(person.effectiveWeight >= 0) || person.contributions.some((one) => one.weight < 0 || one.fraction < 0 || one.fraction > 1)) return false;
        }
        return true;
      }),
    );
  });

  it('does not depend on the order in which the tasks are given', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { minLength: 1, maxLength: 10 }), fc.infiniteStream(fc.nat()), (rows, stream) => {
        const tasks = tasksOf(rows);
        const shuffled = [...tasks].sort(() => stream.next().value % 3 - 1);
        return JSON.stringify(run(shuffled)) === JSON.stringify(run(tasks));
      }),
    );
  });

  it('gives the shares of two holders that split the whole window the whole task (nothing is lost or counted twice)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), (split) => {
        const rows = [{ state: 'RATED' as const, taskScore: 70, priority: 'NORMAL' as const, plannedWorkingDays: 1, role: 'RESPONSIBLE' as const, split }];
        const [ann, bob] = run(tasksOf(rows));
        const total = (ann?.contributions[0]?.fraction ?? 0) + (bob?.contributions[0]?.fraction ?? 0);
        return Math.abs(total - 1) < 0.001;
      }),
    );
  });

  it('the hash of a snapshot does not depend on the order of its keys', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.integer()), (dictionary) => {
        const reversed = Object.fromEntries(Object.entries(dictionary).reverse());
        return periodSnapshotHash(dictionary) === periodSnapshotHash(reversed);
      }),
    );
  });
});
