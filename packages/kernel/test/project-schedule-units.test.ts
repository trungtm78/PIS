import fc from 'fast-check';
import { bandOf, deadlineBand, officialThresholds, policyThresholds, resolveBand } from '../src/deadline-band.ts';
import type { BandPolicy, BandThresholds } from '../src/deadline-band.ts';
import { parseProjectWorkflowTemplate, stepSpans } from '../src/project-workflow.ts';
import { addMonths, bandZonesOf, overallDeadlineOf, scheduleProject, standardTimes, tasksFromTemplate } from '../src/project-schedule.ts';
import type { PinnedCalendar, ScheduleDuration, ScheduleInput, ScheduleTask, ScheduledTask } from '../src/project-schedule.ts';
import type { WorkCalendarContent, WorkCalendarSource } from '../src/working-time.ts';

/*
 * Time limits in their own unit (R58), the tier of the thresholds of a step (R59), the zones of the colours and the deadline of the whole file (R56).
 *
 * 2026: Monday to Friday, Wednesday 11 November a holiday (the fixture of project-schedule.test.ts). Working days from Monday 2 November (slot: date): 0 Nov 2, 1 Nov 3, 2 Nov 4, 3 Nov 5, 4 Nov 6, 5 Nov 9, 6 Nov 10,
 * 7 Nov 12, 8 Nov 13, 9 Nov 16, 10 Nov 17, 11 Nov 18, 12 Nov 19, 13 Nov 20.
 * 2027: the days of Tết in the fixture are Friday 5 February and Monday 8 to Thursday 11 February (made up for the test, not the official list).
 */
const content = (year: number, holidays: string[] = []): WorkCalendarContent => ({ calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: holidays.map((date) => ({ date, name: 'Ngày nghỉ thử' })), legal_basis_ref: 'fixture' });
const pinned = (year: number, holidays: string[] = []): PinnedCalendar => ({ year, version: 1, content: content(year, holidays) });
const Y2026 = pinned(2026, ['2026-11-11']);
const Y2027 = pinned(2027, ['2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11']);
const YEARS = [Y2026, Y2027, pinned(2028), pinned(2029), pinned(2030), pinned(2031)];

const limit = (value: number, unit: ScheduleDuration['unit'], rollToWorkingDay = true): ScheduleDuration => ({ value, unit, rollToWorkingDay });
const task = (code: string, durationWorkingDays: number, extra: Partial<ScheduleTask> = {}): ScheduleTask => ({ code, kind: 'TASK', durationWorkingDays, predecessors: [], ...extra });
const link = (taskCode: string, kind: 'FS' | 'SS' | 'FF' | 'SF' = 'FS', lagWorkingDays = 0) => ({ task: taskCode, kind, lagWorkingDays });
const run = (tasks: ScheduleTask[], extra: Partial<ScheduleInput> = {}) => scheduleProject({ tasks, plannedStart: '2026-11-02', calendars: YEARS, ...extra });
const find = (result: ReturnType<typeof run>, code: string): ScheduledTask => result.tasks.find((candidate) => candidate.code === code) as ScheduledTask;
const dates = (result: ReturnType<typeof run>, code: string): [string | null, string | null] => [find(result, code).start, find(result, code).finish];

describe('addMonths', () => {
  it.each([
    ['2026-11-02', 1, '2026-12-02'],
    ['2026-11-02', 3, '2027-02-02'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2029-01-31', 1, '2029-02-28'],
    ['2026-08-31', 1, '2026-09-30'],
    ['2026-12-31', 2, '2027-02-28'],
    ['2026-03-31', 12, '2027-03-31'],
    ['2028-02-29', 12, '2029-02-28'],
  ])('%s and %i month(s) is %s', (day, months, expected) => {
    expect(addMonths(day, months)).toBe(expected);
  });
});

describe('a limit in calendar days', () => {
  it('counts the start as day one, and rolls a last day nobody works to the next working day', () => {
    // Ten days from Monday 2 November end on Wednesday the 11th, the holiday of the fixture.
    const rolled = run([task('A', 8, { duration: limit(10, 'CALENDAR_DAY', true) }), task('B', 1, { predecessors: [link('A')] })]);
    expect(dates(rolled, 'A')).toEqual(['2026-11-02', '2026-11-12']);
    expect(dates(rolled, 'B')).toEqual(['2026-11-13', '2026-11-13']);
    expect(find(rolled, 'A')).toMatchObject({ durationValue: 10, durationUnit: 'CALENDAR_DAY', effectiveWorkingDays: 8, startSlot: 0, endSlot: 8 });
  });

  it('keeps the calendar day as the deadline when it does not roll; the next task starts on the first working day after it', () => {
    const kept = run([task('A', 8, { duration: limit(10, 'CALENDAR_DAY', false) }), task('B', 1, { predecessors: [link('A')] })]);
    expect(dates(kept, 'A')).toEqual(['2026-11-02', '2026-11-11']);
    expect(dates(kept, 'B')).toEqual(['2026-11-12', '2026-11-12']);
    expect(find(kept, 'A').effectiveWorkingDays).toBe(7);
    const weekend = run([task('A', 5, { duration: limit(6, 'CALENDAR_DAY', false) }), task('B', 1, { predecessors: [link('A')] })]);
    expect(dates(weekend, 'A')).toEqual(['2026-11-02', '2026-11-07']);
    expect(dates(weekend, 'B')).toEqual(['2026-11-09', '2026-11-09']);
  });

  it('is one day long when it is one day', () => {
    const result = run([task('A', 1, { duration: limit(1, 'CALENDAR_DAY') })]);
    expect(dates(result, 'A')).toEqual(['2026-11-02', '2026-11-02']);
    expect(find(result, 'A').effectiveWorkingDays).toBe(1);
  });

  it.each([
    // [what, start of the project, the limit, the finish]
    ['twenty days that end on the Saturday before Tết roll over the whole holiday', '2027-01-18', limit(20, 'CALENDAR_DAY', true), '2027-02-12'],
    ['twenty days that do not roll keep the Saturday', '2027-01-18', limit(20, 'CALENDAR_DAY', false), '2027-02-06'],
    ['one month that ends on a day of Tết rolls to the first working day after it', '2027-01-11', limit(1, 'MONTH', true), '2027-02-12'],
    ['one month that does not roll keeps the day of Tết', '2027-01-11', limit(1, 'MONTH', false), '2027-02-11'],
    ['five working days are counted over Tết as before', '2027-02-01', limit(5, 'WORKING_DAY', false), '2027-02-12'],
  ] as const)('through Tết: %s', (_what, plannedStart, duration, finish) => {
    const result = run([task('A', 5, { duration }), task('B', 1, { predecessors: [link('A')] })], { plannedStart });
    expect(find(result, 'A').finish).toBe(finish);
    // Whatever the limit, the next task starts on a working day after it: Friday 12 February when the limit ends inside the holiday, Monday the 15th when it ends on the 12th.
    expect(find(result, 'B').start).toBe(finish === '2027-02-12' ? '2027-02-15' : '2027-02-12');
  });
});

describe('a limit in months', () => {
  it.each([
    ['the same day of the next month', '2026-11-02', 1, '2026-12-02'],
    ['31 January of a leap year ends on 29 February', '2028-01-31', 1, '2028-02-29'],
    ['31 January of a common year ends on 28 February', '2029-01-31', 1, '2029-02-28'],
    ['31 August ends on 30 September', '2026-08-31', 1, '2026-09-30'],
    ['three months cross the year', '2026-11-02', 3, '2027-02-02'],
  ] as const)('%s', (_what, plannedStart, months, finish) => {
    const result = run([task('A', months * 22, { duration: limit(months, 'MONTH', true) })], { plannedStart });
    expect(dates(result, 'A')).toEqual([plannedStart, finish]);
  });

  it('fixes the effective length when the task is placed and uses it for the float and the critical path', () => {
    // A: one month from 2 November ends on Wednesday 2 December: 22 working days (the 11th is a holiday). B: 30 working days beside it; C follows both.
    const result = run([task('A', 22, { duration: limit(1, 'MONTH', true) }), task('B', 30), task('C', 2, { predecessors: [link('A'), link('B')] })]);
    const a = find(result, 'A');
    expect(a.effectiveWorkingDays).toBe(22);
    expect(a.endSlot - a.startSlot).toBe(22);
    expect(a.totalFloat).toBe(8);
    expect(a.critical).toBe(false);
    expect(find(result, 'B')).toMatchObject({ totalFloat: 0, critical: true });
    expect(result.criticalPath).toEqual(['B', 'C']);
    // The late dates of A are its early ones moved by its float, with the same effective length.
    expect(a.lateStart).toBe(find(run([task('X', 8), task('A', 22, { predecessors: [link('X')] })]), 'A').start);
  });
});

describe('links, constraints and progress on a limit in its own unit', () => {
  it('pushes the start until the END the calendar gives satisfies a finish-to-finish link', () => {
    // A ends after slot 11 (Wednesday 18 November). B lasts ten calendar days and must not end before A: the first start that gives that is Monday 9 November (it ends on the 18th).
    const result = run([task('A', 12), task('B', 8, { duration: limit(10, 'CALENDAR_DAY', false), predecessors: [link('A', 'FF')] })]);
    expect(dates(result, 'B')).toEqual(['2026-11-09', '2026-11-18']);
    expect(find(result, 'B').drivingPredecessor).toBe('A');
    expect(find(result, 'B').totalFloat).toBe(0);
  });

  it('honours start-no-earlier-than and must-finish-on', () => {
    const snet = run([task('A', 8, { duration: limit(10, 'CALENDAR_DAY', true), constraint: { kind: 'SNET', offsetWorkingDays: 5 } })]);
    expect(dates(snet, 'A')).toEqual(['2026-11-09', '2026-11-18']);
    const mfo = run([task('A', 8, { duration: limit(10, 'CALENDAR_DAY', true), constraint: { kind: 'MFO', date: '2026-11-18' } })]);
    expect(dates(mfo, 'A')).toEqual(['2026-11-09', '2026-11-18']);
    expect(find(mfo, 'A').findings).toEqual([]);
  });

  it('counts what is left of a task in progress in working days of its effective length', () => {
    // Started on Monday 2 November for ten calendar days (8 working days to Thursday the 12th); on the status day, Monday the 9th, five of them are gone.
    const result = run([task('A', 8, { duration: limit(10, 'CALENDAR_DAY', true), status: 'IN_PROGRESS', actualStart: '2026-11-02' })], { statusDate: '2026-11-09' });
    expect(dates(result, 'A')).toEqual(['2026-11-02', '2026-11-12']);
    expect(find(result, 'A').effectiveWorkingDays).toBe(8);
  });

  it('keeps the actual dates of a task that is done', () => {
    const result = run([task('A', 8, { duration: limit(10, 'CALENDAR_DAY', true), status: 'DONE', actualStart: '2026-11-02', actualFinish: '2026-11-05' }), task('B', 1, { predecessors: [link('A')] })]);
    expect(dates(result, 'A')).toEqual(['2026-11-02', '2026-11-05']);
    expect(find(result, 'B').start).toBe('2026-11-06');
  });
});

describe('a year without a calendar is never guessed', () => {
  it('says CALENDAR_UNAVAILABLE for a limit that ends in it, and for what follows', () => {
    const result = run([task('A', 66, { duration: limit(3, 'MONTH', true) }), task('B', 2, { predecessors: [link('A')] }), task('C', 3)], { calendars: [Y2026] });
    expect(find(result, 'A')).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', start: null, finish: null, missingYear: 2027, effectiveWorkingDays: null });
    expect(find(result, 'B')).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', finish: null });
    expect(dates(result, 'C')).toEqual(['2026-11-02', '2026-11-04']);
    expect(result.projectFinish).toBeNull();
    expect(result.findings).toEqual([{ code: 'CALENDAR_UNAVAILABLE', task: null, year: 2027 }]);
  });

  it('does not roll into a year that has no calendar', () => {
    // Saturday 2 January 2027 would roll to Monday the 4th: the calendar of 2027 is not there.
    const result = run([task('A', 5, { duration: limit(6, 'CALENDAR_DAY', true) })], { plannedStart: '2026-12-28', calendars: [Y2026] });
    expect(find(result, 'A')).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', finish: null, missingYear: 2027 });
  });

  it('dates a limit in calendar days that stays inside the year', () => {
    const result = run([task('A', 3, { duration: limit(4, 'CALENDAR_DAY', true) })], { plannedStart: '2026-12-28', calendars: [Y2026] });
    expect(dates(result, 'A')).toEqual(['2026-12-28', '2026-12-31']);
  });
});

describe('properties', () => {
  const UNITS = ['WORKING_DAY', 'CALENDAR_DAY', 'MONTH'] as const;
  const KINDS = ['FS', 'SS', 'FF', 'SF'] as const;
  const specs = fc.integer({ min: 1, max: 12 }).chain((count) =>
    fc.record({
      start: fc.integer({ min: 0, max: 400 }),
      limits: fc.array(fc.record({ value: fc.integer({ min: 1, max: 9 }), unit: fc.constantFrom(...UNITS), roll: fc.boolean(), plain: fc.boolean() }), { minLength: count, maxLength: count }),
      links: fc.array(fc.array(fc.record({ from: fc.nat(), kind: fc.constantFrom(...KINDS), lag: fc.integer({ min: 0, max: 3 }) }), { maxLength: 3 }), { minLength: count, maxLength: count }),
    }),
  );
  type Spec = typeof specs extends fc.Arbitrary<infer T> ? T : never;
  const tasksOf = (spec: Spec, plainWorkingDays = false): ScheduleTask[] =>
    spec.limits.map((one, index) => {
      const seen = new Set<string>();
      const predecessors = (spec.links[index] ?? []).flatMap((raw) => {
        if (index === 0) return [];
        const target = `T${raw.from % index}`;
        const key = `${target}:${raw.kind}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [link(target, raw.kind, raw.lag)];
      });
      const months = one.unit === 'MONTH' ? Math.min(one.value, 3) : one.value;
      const nominal = one.unit === 'MONTH' ? months * 22 : one.unit === 'CALENDAR_DAY' ? Math.max(1, Math.ceil((months * 5) / 7)) : months;
      if (one.plain || (plainWorkingDays && one.unit === 'WORKING_DAY')) return task(`T${index}`, one.unit === 'WORKING_DAY' ? months : nominal, { predecessors });
      return task(`T${index}`, nominal, { predecessors, duration: limit(months, one.unit, one.roll) });
    });
  const startOf = (offset: number): string => new Date(Date.UTC(2026, 10, 2) + offset * 86_400_000).toISOString().slice(0, 10);
  const workingDay = (day: string): boolean => {
    const year = YEARS.find((one) => one.year === Number(day.slice(0, 4))) as PinnedCalendar;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    return weekday >= 1 && weekday <= 5 && !year.content.holidays.some((holiday) => holiday.date === day);
  };

  it('the forward pass is deterministic; every task starts on a working day, covers its effective length, and has no negative float', () => {
    fc.assert(
      fc.property(specs, (spec) => {
        const input = { tasks: tasksOf(spec), plannedStart: startOf(spec.start), calendars: YEARS };
        const result = scheduleProject(input);
        expect(scheduleProject(input)).toEqual(result);
        for (const one of result.tasks) {
          expect(one.state).toBe('SCHEDULED');
          expect(workingDay(one.start as string)).toBe(true);
          expect((one.finish as string) >= (one.start as string)).toBe(true);
          expect(one.endSlot - one.startSlot).toBeGreaterThanOrEqual(1);
          if (one.durationUnit !== undefined) expect(one.effectiveWorkingDays).toBe(one.endSlot - one.startSlot);
          expect(one.totalFloat as number).toBeGreaterThanOrEqual(0);
          expect(one.freeFloat as number).toBeGreaterThanOrEqual(0);
          expect((one.lateFinish as string) >= (one.lateStart as string)).toBe(true);
        }
        const byCode = new Map(result.tasks.map((one) => [one.code, one] as const));
        for (const one of input.tasks) {
          for (const edge of one.predecessors) {
            const before = byCode.get(edge.task) as ScheduledTask;
            const after = byCode.get(one.code) as ScheduledTask;
            if (edge.kind === 'FS') expect(after.startSlot).toBeGreaterThanOrEqual(before.endSlot + edge.lagWorkingDays);
            if (edge.kind === 'SS') expect(after.startSlot).toBeGreaterThanOrEqual(before.startSlot + edge.lagWorkingDays);
            if (edge.kind === 'FF') expect(after.endSlot).toBeGreaterThanOrEqual(before.endSlot + edge.lagWorkingDays);
            if (edge.kind === 'SF') expect(after.endSlot).toBeGreaterThanOrEqual(before.startSlot + edge.lagWorkingDays);
          }
        }
        expect(result.criticalPath.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it('a limit written in working days is scheduled exactly like the plain working days it stands for', () => {
    fc.assert(
      fc.property(specs, (spec) => {
        const plannedStart = startOf(spec.start);
        const strip = (result: ReturnType<typeof scheduleProject>) => result.tasks.map((one) => Object.fromEntries(Object.entries(one).filter(([key]) => key !== 'durationValue' && key !== 'durationUnit' && key !== 'effectiveWorkingDays')));
        const withLimit = scheduleProject({ tasks: tasksOf(spec), plannedStart, calendars: YEARS });
        const plain = scheduleProject({ tasks: tasksOf(spec, true), plannedStart, calendars: YEARS });
        expect(strip(withLimit)).toEqual(strip(plain));
        expect(withLimit.criticalPath).toEqual(plain.criticalPath);
      }),
      { numRuns: 200 },
    );
  });
});

describe('from a template: steps, totals, the deadline of the whole file', () => {
  const params = {
    name: 'Sửa chữa đường',
    phases: [{ code: 'PREP', name: 'Chuẩn bị', gates: [] }],
    steps: [
      { code: 'S1', name: 'Khảo sát', phase: 'PREP' },
      { code: 'S2', name: 'Thẩm định', phase: 'PREP' },
    ],
    tasks: [
      { code: 'SURVEY', name: 'Khảo sát', phase: 'PREP', step: 'S1', kind: 'TASK', duration_working_days: 4, required: true, responsible_role: 'PMB_PLANNER', priority: 'NORMAL', predecessors: [] },
      { code: 'APPRAISE', name: 'Thẩm định', phase: 'PREP', step: 'S2', kind: 'TASK', duration_working_days: 15, duration: { value: 20, unit: 'CALENDAR_DAY', roll_to_working_day: true }, required: true, responsible_role: 'PMB_PLANNER', priority: 'NORMAL', predecessors: [{ task: 'SURVEY', kind: 'FS', lag_working_days: 0 }] },
      { code: 'EXTRA', name: 'Nhóm A', phase: 'PREP', step: 'S2', kind: 'TASK', duration_working_days: 2, required: true, responsible_role: 'PMB_PLANNER', priority: 'NORMAL', predecessors: [{ task: 'APPRAISE', kind: 'FS', lag_working_days: 0 }], when: [{ field: 'project_group', in: ['A'] }] },
    ],
    overall_deadline_task: 'APPRAISE',
  };
  const template = parseProjectWorkflowTemplate(params);

  it('carries the limit to the scheduler and rolls the steps up from the effective lengths', () => {
    const tasks = tasksFromTemplate(template, {});
    expect(tasks[1]?.duration).toEqual({ value: 20, unit: 'CALENDAR_DAY', rollToWorkingDay: true });
    expect('duration' in (tasks[0] as ScheduleTask)).toBe(false);
    const result = run(tasks);
    // SURVEY: 2 to 5 November. APPRAISE: twenty days from Friday the 6th end on Wednesday the 25th: 13 working days (the 11th is a holiday).
    expect(dates(result, 'APPRAISE')).toEqual(['2026-11-06', '2026-11-25']);
    const spans = stepSpans(template, result.tasks.map((one) => ({ code: one.code, start: one.start, finish: one.finish, startSlot: one.startSlot, endSlot: one.endSlot, passThrough: one.state === 'PASS_THROUGH' })));
    expect(spans).toEqual([
      { step: 'S1', phase: 'PREP', start: '2026-11-02', finish: '2026-11-05', durationWorkingDays: 4, taskCount: 1 },
      { step: 'S2', phase: 'PREP', start: '2026-11-06', finish: '2026-11-25', durationWorkingDays: 13, taskCount: 1 },
    ]);
    expect(result.projectFinish).toBe('2026-11-25');
    expect(overallDeadlineOf(template, result.tasks)).toEqual({ task: 'APPRAISE', finish: '2026-11-25', state: 'SCHEDULED' });
  });

  it('counts the standard time on plain weeks with the real unit, not with the nominal days', () => {
    // From Monday 1 January 2001: 4 working days, then twenty calendar days from Friday the 5th to Wednesday the 24th (14 working days).
    expect(standardTimes(template, {}).totalWorkingDays).toBe(18);
  });

  it('has no overall deadline when the template marks none or the project does not have that task', () => {
    expect(overallDeadlineOf({ overallDeadlineTask: null }, [])).toBeNull();
    const branch = parseProjectWorkflowTemplate({ ...params, overall_deadline_task: 'EXTRA' });
    expect(overallDeadlineOf(branch, run(tasksFromTemplate(branch, { project_group: 'C' })).tasks)).toBeNull();
    expect(overallDeadlineOf(branch, run(tasksFromTemplate(branch, { project_group: 'A' })).tasks)?.finish).toBe('2026-11-27');
  });
});

describe('the tier of the thresholds (R59)', () => {
  const SYSTEM: BandThresholds = { green_days: null, yellow_days: 7, red_days: -1 };
  const POLICY: BandPolicy = { unit: 'WORKING', green_days: 5, yellow_days: 2, red_days: 0, overrides: [{ match: { priority: 'CRITICAL' }, green_days: 10, yellow_days: 5, red_days: 2 }], reminder_days: [], escalate_after_overdue_days: null };
  const STEP: BandThresholds = { green_days: 3, yellow_days: 2, red_days: 1 };

  it.each([
    ['the step wins over an override that fits', { step: STEP, policy: POLICY, system: SYSTEM }, { priority: 'CRITICAL' as const }, 'STEP', STEP],
    ['the step wins over the policy', { step: STEP, policy: POLICY, system: SYSTEM }, {}, 'STEP', STEP],
    ['the step wins where there is no policy', { step: STEP, system: SYSTEM }, {}, 'STEP', STEP],
    ['an override that fits wins over the default of the policy', { policy: POLICY, system: SYSTEM }, { priority: 'CRITICAL' as const }, 'POLICY_OVERRIDE', { green_days: 10, yellow_days: 5, red_days: 2 }],
    ['the default of the policy when no override fits', { step: null, policy: POLICY, system: SYSTEM }, { priority: 'LOW' as const }, 'POLICY', { green_days: 5, yellow_days: 2, red_days: 0 }],
    ['the system default when the tenant has no policy', { system: SYSTEM }, { priority: 'CRITICAL' as const }, 'SYSTEM', SYSTEM],
  ])('%s', (_what, tiers, context, tier, thresholds) => {
    expect(officialThresholds(tiers, context)).toEqual({ thresholds, tier });
    const resolved = resolveBand(tiers, context, { dueOn: '2026-11-20', today: '2026-11-02', unit: 'CALENDAR' });
    expect(resolved.tier).toBe(tier);
    expect(resolved.thresholds).toEqual(thresholds);
    expect(resolved.official.band).toBe(bandOf(18, thresholds));
  });

  it('says whether an override of a policy gave the ladder', () => {
    expect(policyThresholds(POLICY, { priority: 'CRITICAL' }).tier).toBe('POLICY_OVERRIDE');
    expect(policyThresholds(POLICY, {}).tier).toBe('POLICY');
  });

  it('lets a person be warned earlier than the ladder of the step, never later (R40)', () => {
    const due = { dueOn: '2026-11-06', today: '2026-11-02', unit: 'CALENDAR' as const };
    const earlier = resolveBand({ step: STEP, policy: POLICY, system: SYSTEM, personal: { green_days: 6, yellow_days: 4 } }, {}, due);
    expect(earlier.official.band).toBe('NONE');
    expect(earlier.personal?.band).toBe('YELLOW');
    expect(earlier).toMatchObject({ tier: 'STEP', personalApplied: true, clamped: [] });
    const later = resolveBand({ step: STEP, system: SYSTEM, personal: { red_days: 0 } }, {}, { ...due, dueOn: '2026-11-03' });
    expect(later.official.band).toBe('RED');
    expect(later.personal?.band).toBe('RED');
    expect(later.clamped).toEqual(['red_days']);
  });
});

describe('the zones of the colours of a deadline', () => {
  const SOURCE: WorkCalendarSource = { forYear: (year) => YEARS.find((one) => one.year === year)?.content };

  it('names the first day of each colour, in working days up to the deadline', () => {
    // Friday 13 November: at most 5 working days are left from Thursday the 5th (6, 9, 10, 12, 13), at most 2 from Tuesday the 10th (12, 13), none on the day itself.
    expect(bandZonesOf('2026-11-13', { green_days: 5, yellow_days: 2, red_days: 0 }, YEARS)).toEqual({ greenFrom: '2026-11-05', yellowFrom: '2026-11-10', redFrom: '2026-11-13' });
    expect(bandZonesOf('2026-11-13', { green_days: null, yellow_days: 2, red_days: -1 }, YEARS)).toEqual({ greenFrom: null, yellowFrom: '2026-11-10', redFrom: '2026-11-14' });
  });

  it('is null when a year the count needs has no calendar', () => {
    expect(bandZonesOf('2026-01-06', { green_days: 10, yellow_days: 2, red_days: 0 }, YEARS)).toBeNull();
  });

  it('agrees with deadlineBand on every day around the deadline', () => {
    fc.assert(
      fc.property(fc.integer({ min: 60, max: 700 }), fc.integer({ min: -1, max: 4 }), fc.integer({ min: 1, max: 5 }), fc.option(fc.integer({ min: 1, max: 8 }), { nil: null }), fc.integer({ min: -30, max: 3 }), (offset, red, yellowGap, greenGap, back) => {
        const dueOn = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
        const thresholds: BandThresholds = { red_days: red, yellow_days: red + yellowGap, green_days: greenGap === null ? null : red + yellowGap + greenGap };
        const zones = bandZonesOf(dueOn, thresholds, YEARS);
        if (zones === null) return;
        const today = new Date(Date.parse(`${dueOn}T00:00:00Z`) + back * 86_400_000).toISOString().slice(0, 10);
        const expected = today >= zones.redFrom || today > dueOn ? 'RED' : today >= zones.yellowFrom ? 'YELLOW' : zones.greenFrom === null || today >= zones.greenFrom ? 'GREEN' : 'NONE';
        expect(deadlineBand({ dueOn, today, unit: 'WORKING', calendars: SOURCE, thresholds }).band).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });
});

describe('defects found by the independent review of the lane (scheduler)', () => {
  const ONLY_2026 = [pinned(2026)];

  it('1. a successor of a limit the calendars cannot place is not dated from the nominal days', () => {
    // Only 2026 is there. A starts on 1 December for one month: its real deadline is in January 2027, which nobody can count. B follows it for one working day: 22 nominal days after 1 December would be 31 December.
    const result = run([task('A', 22, { duration: limit(1, 'MONTH', true) }), task('B', 1, { predecessors: [link('A')] })], { plannedStart: '2026-12-01', calendars: ONLY_2026 });
    expect(find(result, 'A')).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', start: null, finish: null, missingYear: 2027 });
    expect(find(result, 'B')).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', start: null, finish: null, missingYear: 2027 });
    expect(find(result, 'B').findings).toEqual([{ code: 'CALENDAR_UNAVAILABLE', task: 'B', year: 2027 }]);
    expect(result.projectFinish).toBeNull();
  });

  it('1b. the same holds through a milestone, a task left out and a finish-to-finish link', () => {
    const result = run(
      [
        task('A', 22, { duration: limit(1, 'MONTH', true) }),
        { code: 'M', kind: 'MILESTONE', durationWorkingDays: 0, predecessors: [link('A')] },
        task('X', 2, { predecessors: [link('A')], excluded: true }),
        task('C', 1, { predecessors: [link('M')] }),
        task('D', 1, { predecessors: [link('X')] }),
        task('E', 2, { predecessors: [link('A', 'FF')] }),
        task('F', 3),
      ],
      { plannedStart: '2026-12-01', calendars: ONLY_2026 },
    );
    for (const code of ['A', 'M', 'C', 'D', 'E']) expect(find(result, code)).toMatchObject({ state: 'CALENDAR_UNAVAILABLE', finish: null });
    expect(find(result, 'X').state).toBe('PASS_THROUGH');
    expect(dates(result, 'F')).toEqual(['2026-12-01', '2026-12-03']);
  });

  it('no dated task has an undated predecessor anywhere in its chain', () => {
    const UNITS = ['WORKING_DAY', 'CALENDAR_DAY', 'MONTH'] as const;
    const KINDS = ['FS', 'SS', 'FF', 'SF'] as const;
    const specs = fc.integer({ min: 1, max: 12 }).chain((count) =>
      fc.record({
        start: fc.integer({ min: 0, max: 58 }),
        rows: fc.array(fc.record({ value: fc.integer({ min: 1, max: 30 }), unit: fc.constantFrom(...UNITS), roll: fc.boolean(), shape: fc.constantFrom('TASK', 'PLAIN', 'MILESTONE', 'EXCLUDED') }), { minLength: count, maxLength: count }),
        links: fc.array(fc.array(fc.record({ from: fc.nat(), kind: fc.constantFrom(...KINDS), lag: fc.integer({ min: -3, max: 3 }) }), { maxLength: 3 }), { minLength: count, maxLength: count }),
      }),
    );
    fc.assert(
      fc.property(specs, (spec) => {
        const tasks = spec.rows.map((row, index): ScheduleTask => {
          const seen = new Set<string>();
          const predecessors = (spec.links[index] ?? []).flatMap((raw) => {
            if (index === 0) return [];
            const target = `T${raw.from % index}`;
            if (seen.has(`${target}:${raw.kind}`)) return [];
            seen.add(`${target}:${raw.kind}`);
            return [link(target, raw.kind, raw.lag)];
          });
          if (row.shape === 'MILESTONE') return { code: `T${index}`, kind: 'MILESTONE', durationWorkingDays: 0, predecessors };
          const months = row.unit === 'MONTH' ? Math.min(row.value, 2) : row.value;
          const base = task(`T${index}`, row.unit === 'MONTH' ? months * 22 : months, { predecessors, ...(row.shape === 'EXCLUDED' ? { excluded: true } : {}) });
          return row.shape === 'PLAIN' ? base : { ...base, duration: limit(months, row.unit, row.roll) };
        });
        const result = scheduleProject({ tasks, plannedStart: new Date(Date.UTC(2026, 10, 2) + spec.start * 86_400_000).toISOString().slice(0, 10), calendars: ONLY_2026 });
        const byCode = new Map(result.tasks.map((one) => [one.code, one] as const));
        const undated = new Map<string, boolean>();
        // In the order of the list every predecessor comes first: a task is cut off from the calendar when it is undated itself, or when it is a pass-through point behind one that is.
        for (const one of tasks) {
          const mine = byCode.get(one.code) as ScheduledTask;
          const behind = one.predecessors.some((edge) => undated.get(edge.task) === true);
          if (mine.state === 'SCHEDULED') expect(behind).toBe(false);
          undated.set(one.code, mine.state === 'CALENDAR_UNAVAILABLE' || (mine.state === 'PASS_THROUGH' && behind));
          if (mine.state === 'CALENDAR_UNAVAILABLE') expect([mine.start, mine.finish, mine.missingYear]).toEqual([null, null, 2027]);
        }
      }),
      { numRuns: 400 },
    );
  });
});
