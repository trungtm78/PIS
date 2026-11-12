import fc from 'fast-check';
import { dependencyDepth, findDependencyCycle, topologicalOrder } from '../src/project-workflow.ts';
import { scheduleProject } from '../src/project-schedule.ts';
import type { PinnedCalendar, ScheduleLink, ScheduleTask } from '../src/project-schedule.ts';

const CALENDARS: PinnedCalendar[] = [2026, 2027, 2028].map((year) => ({
  year,
  version: 1,
  content: { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [{ date: `${year}-09-02`, name: 'Ngày nghỉ thử' }], legal_basis_ref: 'fixture' },
}));

const KINDS = ['FS', 'SS', 'FF', 'SF'] as const;

interface Spec {
  durations: number[];
  milestone: boolean[];
  links: Array<Array<{ from: number; kind: (typeof KINDS)[number]; lag: number }>>;
}

/** A random acyclic project: a task only follows tasks that come before it in the list. */
const specs = fc.integer({ min: 1, max: 14 }).chain((count) =>
  fc.record({
    durations: fc.array(fc.integer({ min: 1, max: 9 }), { minLength: count, maxLength: count }),
    milestone: fc.array(fc.boolean(), { minLength: count, maxLength: count }),
    links: fc.array(fc.array(fc.record({ from: fc.nat(), kind: fc.constantFrom(...KINDS), lag: fc.integer({ min: -2, max: 4 }) }), { maxLength: 3 }), { minLength: count, maxLength: count }),
  }),
);

const tasksOf = (spec: Spec): ScheduleTask[] =>
  spec.durations.map((duration, index) => {
    const seen = new Set<string>();
    const predecessors: ScheduleLink[] = [];
    if (index > 0) {
      for (const link of spec.links[index] ?? []) {
        const target = `T${link.from % index}`;
        if (seen.has(`${target}:${link.kind}`)) continue;
        seen.add(`${target}:${link.kind}`);
        predecessors.push({ task: target, kind: link.kind, lagWorkingDays: link.lag });
      }
    }
    const isMilestone = spec.milestone[index] === true;
    return { code: `T${index}`, kind: isMilestone ? 'MILESTONE' : 'TASK', durationWorkingDays: isMilestone ? 0 : duration, predecessors };
  });

const run = (tasks: ScheduleTask[]) => scheduleProject({ tasks, plannedStart: '2026-08-31', calendars: CALENDARS });

describe('scheduleProject: properties over random acyclic projects', () => {
  it('honours every link of every kind and never starts before the planned start', () => {
    fc.assert(
      fc.property(specs, (spec) => {
        const tasks = tasksOf(spec);
        const result = run(tasks);
        const slot = new Map(result.tasks.map((one) => [one.code, one] as const));
        for (const task of tasks) {
          const me = slot.get(task.code);
          if (me === undefined || me.startSlot < 0) return false;
          if (me.endSlot - me.startSlot !== task.durationWorkingDays) return false;
          for (const link of task.predecessors) {
            const before = slot.get(link.task);
            if (before === undefined) return false;
            const holds =
              link.kind === 'FS' ? me.startSlot >= before.endSlot + link.lagWorkingDays : link.kind === 'SS' ? me.startSlot >= before.startSlot + link.lagWorkingDays : link.kind === 'FF' ? me.endSlot >= before.endSlot + link.lagWorkingDays : me.endSlot >= before.startSlot + link.lagWorkingDays;
            if (!holds) return false;
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('is monotonic: a longer task never makes any task end earlier (links that read the end of a task by its own length, FF and SF, can move its start and are left out)', () => {
    fc.assert(
      fc.property(specs, fc.nat(), fc.integer({ min: 1, max: 6 }), (spec, pick, extra) => {
        const tasks = tasksOf(spec).map((one) => ({ ...one, predecessors: one.predecessors.filter((link) => link.kind === 'FS' || link.kind === 'SS') }));
        const real = tasks.filter((one) => one.kind === 'TASK');
        if (real.length === 0) return true;
        const chosen = real[pick % real.length] as ScheduleTask;
        const longer = tasks.map((one) => (one.code === chosen.code ? { ...one, durationWorkingDays: one.durationWorkingDays + extra } : one));
        const before = run(tasks);
        const after = run(longer);
        return before.tasks.every((one, index) => (after.tasks[index] as { endSlot: number }).endSlot >= one.endSlot);
      }),
      { numRuns: 200 },
    );
  });

  it('is monotonic: a link that is added never moves a task earlier', () => {
    fc.assert(
      fc.property(specs, fc.nat(), fc.nat(), fc.constantFrom(...KINDS), fc.integer({ min: -2, max: 4 }), (spec, left, right, kind, lag) => {
        const tasks = tasksOf(spec);
        if (tasks.length < 2) return true;
        const to = 1 + (right % (tasks.length - 1));
        const from = left % to;
        const target = tasks[to] as ScheduleTask;
        if (target.predecessors.some((one) => one.task === `T${from}` && one.kind === kind)) return true;
        const tied = tasks.map((one, index) => (index === to ? { ...one, predecessors: [...one.predecessors, { task: `T${from}`, kind, lagWorkingDays: lag }] } : one));
        const before = run(tasks);
        const after = run(tied);
        return before.tasks.every((one, index) => (after.tasks[index] as { endSlot: number; startSlot: number }).endSlot >= one.endSlot && (after.tasks[index] as { startSlot: number }).startSlot >= one.startSlot);
      }),
      { numRuns: 200 },
    );
  });

  it('gives no negative float without a deadline, at least one critical task, and a longest path made of critical tasks', () => {
    fc.assert(
      fc.property(specs, (spec) => {
        const result = run(tasksOf(spec));
        if (result.tasks.some((one) => (one.totalFloat ?? 0) < 0)) return false;
        if (result.tasks.some((one) => one.freeFloat !== null && one.totalFloat !== null && one.freeFloat > one.totalFloat)) return false;
        if (result.criticalPath.length === 0 || result.longestPath.length === 0) return false;
        const byCode = new Map(result.tasks.map((one) => [one.code, one] as const));
        return result.longestPath.every((code) => byCode.get(code)?.totalFloat === 0);
      }),
      { numRuns: 200 },
    );
  });

  it('does not depend on the order the tasks are listed in', () => {
    fc.assert(
      fc.property(specs, fc.integer(), (spec, seed) => {
        const tasks = tasksOf(spec);
        const shuffled = [...tasks].sort((left, right) => ((left.code.length * 31 + seed) % 7) - ((right.code.length * 17 + seed) % 7) || right.code.localeCompare(left.code));
        return run(tasks).hash === run(shuffled).hash;
      }),
      { numRuns: 100 },
    );
  });
});

describe('the dependency graph: properties', () => {
  it('finds no loop in a graph that only follows earlier tasks, orders it, and measures a depth within the number of tasks', () => {
    fc.assert(
      fc.property(specs, (spec) => {
        const tasks = tasksOf(spec);
        const order = topologicalOrder(tasks);
        const position = new Map(order.map((code, index) => [code, index] as const));
        const ordered = tasks.every((one) => one.predecessors.every((link) => (position.get(link.task) as number) < (position.get(one.code) as number)));
        return findDependencyCycle(tasks) === null && ordered && dependencyDepth(tasks) <= tasks.length;
      }),
      { numRuns: 200 },
    );
  });

  it('always finds a loop once a task is made to follow one of its own successors', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), (count) => {
        const chain = Array.from({ length: count }, (_value, index) => ({ code: `T${index}`, predecessors: index === 0 ? [{ task: `T${count - 1}` }] : [{ task: `T${index - 1}` }] }));
        const loop = findDependencyCycle(chain);
        return loop !== null && loop.length === count;
      }),
      { numRuns: 50 },
    );
  });
});
