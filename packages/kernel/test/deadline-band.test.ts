import { DomainError } from '../src/errors.ts';
import {
  BAND_COLORS,
  BAND_RANK,
  DEADLINE_BAND_RULE_TYPE,
  bandOf,
  bandPolicyOf,
  deadlineBand,
  deadlineSourceOf,
  deadlineSources,
  dueReminders,
  registerDeadlineSource,
  reminderPoints,
  remainingDays,
  resolveBand,
  shouldEscalate,
  thresholdsFor,
  validateThresholds,
} from '../src/deadline-band.ts';
import type { BandThresholds } from '../src/deadline-band.ts';
import { builtInCodes, builtInDefault, isGovernanceRuleType, provenanceOf, ruleTypeOf, validateRuleParams } from '../src/governance-rules.ts';
import { workBucket } from '../src/home-work.ts';
import { scheduleStepState } from '../src/reporting-schedule.ts';
import type { WorkCalendarContent, WorkCalendarSource } from '../src/working-time.ts';

/** 2026: Monday to Friday, Wednesday 11 November a holiday (a made-up day for the fixture). 2027 is not published. */
const CALENDAR_2026: WorkCalendarContent = { calendar_code: 'WORKDAY_VN', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-11', name: 'Ngày nghỉ thử' }], legal_basis_ref: 'fixture' };
const SOURCE: WorkCalendarSource = { forYear: (year) => (year === 2026 ? CALENDAR_2026 : undefined) };

const EXAMPLE: BandThresholds = { green_days: 5, yellow_days: 2, red_days: 0 };
const dayPlus = (base: string, days: number): string => new Date(Date.parse(`${base}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const TODAY = '2026-11-09';

const failure = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('the three-colour band of a deadline', () => {
  it('starts each colour when the days remaining are at most its threshold (the owner example: 5 green, 2 yellow, under 1 red)', () => {
    const table: Array<[number, string]> = [
      [6, 'NONE'],
      [5, 'GREEN'],
      [3, 'GREEN'],
      [2, 'YELLOW'],
      [1, 'YELLOW'],
      [0, 'RED'],
      [-1, 'RED'],
      [-30, 'RED'],
    ];
    for (const [remaining, band] of table) expect([remaining, bandOf(remaining, EXAMPLE)]).toEqual([remaining, band]);
  });

  it('has no far state when the green line is null: everything above yellow is green (the legacy "later")', () => {
    const legacy: BandThresholds = { green_days: null, yellow_days: 7, red_days: -1 };
    expect(bandOf(400, legacy)).toBe('GREEN');
    expect(bandOf(8, legacy)).toBe('GREEN');
    expect(bandOf(7, legacy)).toBe('YELLOW');
    expect(bandOf(0, legacy)).toBe('YELLOW');
    expect(bandOf(-1, legacy)).toBe('RED');
  });

  it('ranks the bands and keeps the colours apart from the neutral ones', () => {
    expect(BAND_COLORS).toEqual(['GREEN', 'YELLOW', 'RED']);
    expect(BAND_RANK.NONE).toBeLessThan(BAND_RANK.GREEN);
    expect(BAND_RANK.GREEN).toBeLessThan(BAND_RANK.YELLOW);
    expect(BAND_RANK.YELLOW).toBeLessThan(BAND_RANK.RED);
  });
});

describe('validateThresholds', () => {
  it('accepts a strictly ordered ladder and names the field of a wrong one', () => {
    expect(() => validateThresholds(EXAMPLE)).not.toThrow();
    expect(() => validateThresholds({ green_days: null, yellow_days: 1, red_days: -1 })).not.toThrow();
    const cases: Array<[BandThresholds, string]> = [
      [{ green_days: 5, yellow_days: 5, red_days: 0 }, 'green_days'],
      [{ green_days: 5, yellow_days: 2, red_days: 2 }, 'yellow_days'],
      [{ green_days: null, yellow_days: 2, red_days: -2 }, 'red_days'],
      [{ green_days: null, yellow_days: 2.5, red_days: 0 }, 'yellow_days'],
      [{ green_days: 5.5, yellow_days: 2, red_days: 0 }, 'green_days'],
      [{ green_days: null, yellow_days: 2, red_days: 0.5 }, 'red_days'],
    ];
    for (const [thresholds, field] of cases) {
      const error = failure(() => validateThresholds(thresholds));
      expect([error.code, error.status, error.detail]).toEqual(['DEADLINE_BAND_THRESHOLDS_INVALID', 422, field]);
    }
  });
});

describe('remainingDays', () => {
  it('counts calendar days, negative when overdue, and the day of the deadline is 0', () => {
    expect(remainingDays({ dueOn: '2026-11-14', today: TODAY, unit: 'CALENDAR' })).toBe(5);
    expect(remainingDays({ dueOn: TODAY, today: TODAY, unit: 'CALENDAR' })).toBe(0);
    expect(remainingDays({ dueOn: '2026-11-06', today: TODAY, unit: 'CALENDAR' })).toBe(-3);
  });

  it('counts working days across a holiday and a weekend, and negates them when overdue', () => {
    // Monday 9 November to Thursday 12: Tuesday 10 and Thursday 12 (Wednesday 11 is a holiday).
    expect(remainingDays({ dueOn: '2026-11-12', today: TODAY, unit: 'WORKING', calendars: SOURCE })).toBe(2);
    expect(remainingDays({ dueOn: '2026-11-14', today: TODAY, unit: 'WORKING', calendars: SOURCE })).toBe(3);
    expect(remainingDays({ dueOn: '2026-11-09', today: '2026-11-06', unit: 'WORKING', calendars: SOURCE })).toBe(1);
    expect(remainingDays({ dueOn: '2026-11-13', today: '2026-11-16', unit: 'WORKING', calendars: SOURCE })).toBe(-1);
    expect(remainingDays({ dueOn: TODAY, today: TODAY, unit: 'WORKING', calendars: SOURCE })).toBe(0);
  });

  it('never guesses a day without a published calendar', () => {
    expect(remainingDays({ dueOn: '2027-01-05', today: '2026-12-30', unit: 'WORKING', calendars: SOURCE })).toBeNull();
    expect(remainingDays({ dueOn: '2026-12-01', today: '2026-12-30', unit: 'WORKING', calendars: SOURCE })).not.toBeNull();
    expect(remainingDays({ dueOn: '2026-11-12', today: TODAY, unit: 'WORKING' })).toBeNull();
  });
});

describe('deadlineBand', () => {
  it('gives the colour, the days left and whether it is overdue', () => {
    expect(deadlineBand({ dueOn: '2026-11-12', today: TODAY, unit: 'WORKING', calendars: SOURCE, thresholds: EXAMPLE })).toEqual({ band: 'YELLOW', remainingDays: 2, overdue: false, unit: 'WORKING' });
    expect(deadlineBand({ dueOn: '2026-11-06', today: TODAY, unit: 'CALENDAR', thresholds: EXAMPLE })).toEqual({ band: 'RED', remainingDays: -3, overdue: true, unit: 'CALENDAR' });
  });

  it('says why a task has no colour: no due day, or still far', () => {
    expect(deadlineBand({ dueOn: null, today: TODAY, unit: 'CALENDAR', thresholds: EXAMPLE })).toEqual({ band: 'NONE', remainingDays: null, overdue: false, unit: 'CALENDAR', reason: 'NO_DUE' });
    expect(deadlineBand({ dueOn: '2026-12-31', today: TODAY, unit: 'CALENDAR', thresholds: EXAMPLE })).toMatchObject({ band: 'NONE', reason: 'FAR' });
  });

  it('is UNKNOWN, with its reason, when the working calendar is missing', () => {
    expect(deadlineBand({ dueOn: '2027-01-05', today: '2026-12-30', unit: 'WORKING', calendars: SOURCE, thresholds: EXAMPLE })).toEqual({ band: 'UNKNOWN', remainingDays: null, overdue: false, unit: 'WORKING', reason: 'CALENDAR_UNAVAILABLE' });
  });

  it('refuses a day that is not a day', () => {
    expect(failure(() => deadlineBand({ dueOn: '2026-02-30', today: TODAY, unit: 'CALENDAR', thresholds: EXAMPLE })).code).toBe('VALIDATION_FAILED');
  });
});

describe('the sources of deadlines declare their unit', () => {
  it('knows the three built-in sources and refuses a second registration of a code', () => {
    expect(deadlineSourceOf('HOME_WORK')?.unit).toBe('CALENDAR');
    expect(deadlineSourceOf('REPORT_SCHEDULE')?.unit).toBe('CALENDAR');
    expect(deadlineSourceOf('PROJECT_TASK')?.unit).toBe('WORKING');
    expect(deadlineSourceOf('NOPE')).toBeUndefined();
    expect(deadlineSources().map((source) => source.code)).toEqual(expect.arrayContaining(['HOME_WORK', 'REPORT_SCHEDULE', 'PROJECT_TASK']));
    expect(() => registerDeadlineSource({ code: 'PROJECT_TASK', unit: 'WORKING', label: 'Công việc' })).toThrow(/already registered/);
  });

  it('lets another lane register a source of its own, with a code and a label', () => {
    registerDeadlineSource({ code: 'TEST_SOURCE_ONE', unit: 'CALENDAR', label: 'Nguồn thử' });
    expect(deadlineSourceOf('TEST_SOURCE_ONE')).toEqual({ code: 'TEST_SOURCE_ONE', unit: 'CALENDAR', label: 'Nguồn thử' });
    expect(() => registerDeadlineSource({ code: 'bad code', unit: 'CALENDAR', label: 'Nguồn thử' })).toThrow(/not a code/);
    expect(() => registerDeadlineSource({ code: 'TEST_SOURCE_TWO', unit: 'HOURS' as never, label: 'Nguồn thử' })).toThrow(/unit/);
    expect(() => registerDeadlineSource({ code: 'TEST_SOURCE_TWO', unit: 'CALENDAR', label: ' ' })).toThrow(/label/);
  });
});

describe('the rule type DEADLINE_BAND_POLICY', () => {
  it('is registered, owned by PWF, unverified, and every default passes its own schema', () => {
    expect(isGovernanceRuleType(DEADLINE_BAND_RULE_TYPE)).toBe(true);
    const definition = ruleTypeOf(DEADLINE_BAND_RULE_TYPE);
    expect(definition.ownerModule).toBe('PWF');
    expect(definition.legalStatus).toBe('UNVERIFIED');
    expect(builtInCodes(DEADLINE_BAND_RULE_TYPE)).toEqual(['HOME_WORK', 'REPORT_SCHEDULE', 'PROJECT_TASK']);
    for (const code of builtInCodes(DEADLINE_BAND_RULE_TYPE)) {
      const found = builtInDefault(DEADLINE_BAND_RULE_TYPE, code);
      expect(found?.unverified).toBe(true);
      expect(() => validateRuleParams(DEADLINE_BAND_RULE_TYPE, found?.params)).not.toThrow();
      expect(provenanceOf(DEADLINE_BAND_RULE_TYPE, code)?.formula.length).toBeGreaterThan(8);
    }
  });

  it('adds the three alert types of the project tasks, with owner, action and consequence', () => {
    for (const code of ['PWF_TASK_DUE_SOON', 'PWF_TASK_OVERDUE', 'PWF_MILESTONE_AT_RISK']) {
      const found = builtInDefault('ALERT_TYPE', code);
      expect(found).toBeDefined();
      expect(found?.params.source).toBe('PROJECT_TASK');
      expect(String(found?.params.expected_action).length).toBeGreaterThan(5);
      expect(String(found?.params.consequence).length).toBeGreaterThan(5);
      expect(() => validateRuleParams('ALERT_TYPE', found?.params)).not.toThrow();
    }
    expect(builtInDefault('ALERT_TYPE', 'PWF_TASK_DUE_SOON')?.params).toMatchObject({ default_severity: 'WATCH', owner: 'TASK_ASSIGNEE', response_hours: 24 });
    expect(builtInDefault('ALERT_TYPE', 'PWF_TASK_OVERDUE')?.params).toMatchObject({ default_severity: 'ACTION', owner: 'TASK_ASSIGNEE', response_hours: 24 });
    expect(builtInDefault('ALERT_TYPE', 'PWF_MILESTONE_AT_RISK')?.params).toMatchObject({ default_severity: 'ACTION', owner: 'PROJECT_MANAGER', response_hours: 48 });
  });

  it('refuses a ladder out of order, in the rule and in every override, and reminders that do not strictly decrease', () => {
    const base = { unit: 'WORKING', green_days: 5, yellow_days: 2, red_days: 0, overrides: [], reminder_days: [5, 2, 0] };
    expect(() => validateRuleParams(DEADLINE_BAND_RULE_TYPE, base)).not.toThrow();
    const wrong = (patch: Record<string, unknown>): void => {
      expect(() => validateRuleParams(DEADLINE_BAND_RULE_TYPE, { ...base, ...patch })).toThrow(DomainError);
    };
    wrong({ yellow_days: 6 });
    wrong({ red_days: 3 });
    wrong({ reminder_days: [2, 5] });
    wrong({ reminder_days: [2, 2] });
    wrong({ overrides: [{ match: { priority: 'HIGH' }, yellow_days: 1, red_days: 1 }] });
    wrong({ overrides: [{ match: { priority: 'HIGH' }, green_days: 1, yellow_days: 2, red_days: 0 }] });
    wrong({ unknown_key: 1 });
    wrong({ unit: 'HOURS' });
    expect(() => validateRuleParams(DEADLINE_BAND_RULE_TYPE, { ...base, overrides: [{ match: { task_kind: 'MILESTONE', priority: 'HIGH', phase: 'EXECUTION' }, yellow_days: 4, red_days: 1 }] })).not.toThrow();
  });
});

describe('bandPolicyOf and thresholdsFor', () => {
  const rule = (extra: Record<string, unknown> = {}): { params: Record<string, unknown> } => ({
    params: {
      unit: 'WORKING',
      green_days: 5,
      yellow_days: 2,
      red_days: 0,
      overrides: [
        { match: { task_kind: 'MILESTONE' }, green_days: 10, yellow_days: 5, red_days: 1 },
        { match: { priority: 'CRITICAL' }, yellow_days: 4, red_days: 1 },
      ],
      reminder_days: [5, 2, 0],
      ...extra,
    },
  });

  it('reads a rule of a source into a policy', () => {
    const policy = bandPolicyOf(rule(), 'PROJECT_TASK');
    expect(policy).toMatchObject({ unit: 'WORKING', green_days: 5, yellow_days: 2, red_days: 0, reminder_days: [5, 2, 0], escalate_after_overdue_days: null });
    expect(policy.overrides).toHaveLength(2);
    expect(policy.overrides[1]).toMatchObject({ green_days: null, yellow_days: 4 });
    expect(bandPolicyOf(rule({ green_days: undefined, escalate_after_overdue_days: 3 }), 'PROJECT_TASK')).toMatchObject({ green_days: null, escalate_after_overdue_days: 3 });
  });

  it('refuses a rule whose unit is not the unit its source declares (the tenant does not choose the unit)', () => {
    const error = failure(() => bandPolicyOf(rule({ unit: 'CALENDAR' }), 'PROJECT_TASK'));
    expect([error.code, error.status, error.detail]).toEqual(['DEADLINE_BAND_UNIT_MISMATCH', 422, 'unit']);
    expect(failure(() => bandPolicyOf(rule(), 'NO_SUCH_SOURCE')).code).toBe('VALIDATION_FAILED');
  });

  it('refuses params that are not a valid ladder', () => {
    expect(failure(() => bandPolicyOf(rule({ yellow_days: 9 }), 'PROJECT_TASK')).code).toBe('DEADLINE_BAND_THRESHOLDS_INVALID');
    expect(failure(() => bandPolicyOf({ params: { unit: 'WORKING' } }, 'PROJECT_TASK')).code).toBe('DEADLINE_BAND_THRESHOLDS_INVALID');
  });

  it('takes the first override that matches, else the thresholds of the rule', () => {
    const policy = bandPolicyOf(rule(), 'PROJECT_TASK');
    expect(thresholdsFor(policy, {})).toEqual({ green_days: 5, yellow_days: 2, red_days: 0 });
    expect(thresholdsFor(policy, { taskKind: 'TASK', priority: 'NORMAL' })).toEqual({ green_days: 5, yellow_days: 2, red_days: 0 });
    expect(thresholdsFor(policy, { taskKind: 'MILESTONE', priority: 'CRITICAL' })).toEqual({ green_days: 10, yellow_days: 5, red_days: 1 });
    expect(thresholdsFor(policy, { taskKind: 'TASK', priority: 'CRITICAL' })).toEqual({ green_days: null, yellow_days: 4, red_days: 1 });
  });

  it('matches an override on the phase too, and a match with no key matches every task', () => {
    const policy = bandPolicyOf(rule({ overrides: [{ match: { phase: 'ACCEPTANCE' }, yellow_days: 6, red_days: 2 }, { match: {}, yellow_days: 3, red_days: 0 }] }), 'PROJECT_TASK');
    expect(thresholdsFor(policy, { phase: 'ACCEPTANCE' })).toEqual({ green_days: null, yellow_days: 6, red_days: 2 });
    expect(thresholdsFor(policy, { phase: 'PREPARATION' })).toEqual({ green_days: null, yellow_days: 3, red_days: 0 });
  });
});

describe('resolveBand: system default, then the rule, then the person, and the person only earlier', () => {
  const due = { dueOn: '2026-11-12', today: TODAY, unit: 'WORKING' as const, calendars: SOURCE };
  const policy = bandPolicyOf({ params: { unit: 'WORKING', green_days: 5, yellow_days: 2, red_days: 0, overrides: [{ match: { task_kind: 'MILESTONE' }, yellow_days: 4, red_days: 1 }], reminder_days: [] } }, 'PROJECT_TASK');

  it('uses the system thresholds when no rule is approved', () => {
    const result = resolveBand({ system: EXAMPLE }, {}, due);
    expect(result.official).toMatchObject({ band: 'YELLOW', remainingDays: 2 });
    expect(result.personal).toBeNull();
    expect(result.personalApplied).toBe(false);
    expect(result.clamped).toEqual([]);
  });

  it('prefers the rule, and its override for the kind of task', () => {
    expect(resolveBand({ system: EXAMPLE, policy }, {}, due).official.band).toBe('YELLOW');
    expect(resolveBand({ system: EXAMPLE, policy }, { taskKind: 'MILESTONE' }, due).official.band).toBe('YELLOW');
    expect(resolveBand({ system: { green_days: 5, yellow_days: 1, red_days: 0 }, policy }, { taskKind: 'MILESTONE' }, { ...due, dueOn: '2026-11-13' }).official).toMatchObject({ band: 'YELLOW', remainingDays: 3 });
  });

  it('lets a person be warned earlier, without touching the official band', () => {
    const result = resolveBand({ system: EXAMPLE, personal: { yellow_days: 4, red_days: 1 } }, {}, { ...due, dueOn: '2026-11-13' });
    expect(result.official).toMatchObject({ band: 'GREEN', remainingDays: 3 });
    expect(result.personal).toMatchObject({ band: 'YELLOW', remainingDays: 3 });
    expect(result.personalApplied).toBe(true);
    expect(result.clamped).toEqual([]);
  });

  it('clamps a person who asks to be warned later, and says which fields it clamped', () => {
    const result = resolveBand({ system: EXAMPLE, personal: { green_days: 3, yellow_days: 1, red_days: 0 } }, {}, due);
    expect(result.clamped).toEqual(['green_days', 'yellow_days']);
    expect(result.personal?.band).toBe('YELLOW');
    expect(result.personalApplied).toBe(false);
  });

  it('treats a null green line of the person as earlier than a number, and a number as later than a null line', () => {
    const open: BandThresholds = { green_days: null, yellow_days: 2, red_days: 0 };
    expect(resolveBand({ system: EXAMPLE, personal: { green_days: null } }, {}, { ...due, dueOn: '2026-12-31' }).personal?.band).toBe('GREEN');
    const later = resolveBand({ system: open, personal: { green_days: 9 } }, {}, due);
    expect(later.clamped).toEqual(['green_days']);
  });

  it('refuses a personal ladder that is not in order once it is merged', () => {
    const error = failure(() => resolveBand({ system: EXAMPLE, personal: { red_days: 3 } }, {}, due));
    expect(error.code).toBe('DEADLINE_BAND_THRESHOLDS_INVALID');
  });

  it('carries the reason through when the calendar is missing, for both results', () => {
    const result = resolveBand({ system: EXAMPLE, personal: { yellow_days: 3 } }, {}, { dueOn: '2027-01-05', today: '2026-12-30', unit: 'WORKING', calendars: SOURCE });
    expect(result.official.band).toBe('UNKNOWN');
    expect(result.personal?.band).toBe('UNKNOWN');
  });
});

describe('legacy equivalence: the defaults give the old constants', () => {
  const HOME = bandPolicyOf(builtInDefault(DEADLINE_BAND_RULE_TYPE, 'HOME_WORK') as { params: Record<string, unknown> }, 'HOME_WORK');
  const SCHEDULE = bandPolicyOf(builtInDefault(DEADLINE_BAND_RULE_TYPE, 'REPORT_SCHEDULE') as { params: Record<string, unknown> }, 'REPORT_SCHEDULE');
  const colorOfBucket = { OVERDUE: 'RED', NEAR: 'YELLOW', LATER: 'GREEN' } as const;

  it('HOME_WORK gives the band of workBucket for every distance from -400 to 400 days', () => {
    for (let remaining = -400; remaining <= 400; remaining += 1) {
      const dueOn = dayPlus(TODAY, remaining);
      const bucket = workBucket({ dueOn, originalDueOn: dueOn }, TODAY);
      const band = deadlineBand({ dueOn, today: TODAY, unit: 'CALENDAR', thresholds: thresholdsFor(HOME, {}) }).band;
      expect([remaining, band]).toEqual([remaining, colorOfBucket[bucket]]);
    }
  });

  it('REPORT_SCHEDULE gives the split of scheduleStepState (overdue, due soon, open) for every distance', () => {
    const colorOfState = { OVERDUE: 'RED', DUE_SOON: 'YELLOW', OPEN: 'GREEN' } as const;
    for (let remaining = -400; remaining <= 400; remaining += 1) {
      const dueOn = dayPlus(TODAY, remaining);
      const state = scheduleStepState(`${dueOn}T00:00:00Z`, null, new Date(`${TODAY}T00:00:00Z`));
      const band = deadlineBand({ dueOn, today: TODAY, unit: 'CALENDAR', thresholds: thresholdsFor(SCHEDULE, {}) }).band;
      expect([remaining, band]).toEqual([remaining, colorOfState[state as 'OVERDUE' | 'DUE_SOON' | 'OPEN']]);
    }
  });

  it('PROJECT_TASK defaults to the owner example, 5 / 2 / 0 working days', () => {
    const task = bandPolicyOf(builtInDefault(DEADLINE_BAND_RULE_TYPE, 'PROJECT_TASK') as { params: Record<string, unknown> }, 'PROJECT_TASK');
    expect(thresholdsFor(task, {})).toEqual(EXAMPLE);
    expect(task.reminder_days).toEqual([5, 2, 0, -1]);
    expect(task.escalate_after_overdue_days).toBe(3);
  });
});

describe('reminders and escalation', () => {
  it('places a reminder on a calendar day by subtracting the days, and after the deadline for a negative number', () => {
    expect(reminderPoints({ dueOn: '2026-11-20', unit: 'CALENDAR', reminderDays: [5, 2, 0, -1] })).toEqual(['2026-11-15', '2026-11-18', '2026-11-20', '2026-11-21']);
  });

  it('places a reminder on a working day, across the holiday and the weekend', () => {
    // Monday 16 November is the deadline: 1 working day before is Friday 13, 2 is Thursday 12, 3 is Tuesday 10 (Wednesday 11 is a holiday).
    expect(reminderPoints({ dueOn: '2026-11-16', unit: 'WORKING', calendars: SOURCE, reminderDays: [3, 2, 1, 0, -1] })).toEqual(['2026-11-10', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17']);
  });

  it('lands on the last working day when the deadline itself is not worked', () => {
    expect(reminderPoints({ dueOn: '2026-11-14', unit: 'WORKING', calendars: SOURCE, reminderDays: [0, 1] })).toEqual(['2026-11-13', '2026-11-12']);
  });

  it('gives null for a reminder it cannot place: no calendar, or a year without one', () => {
    expect(reminderPoints({ dueOn: '2026-11-16', unit: 'WORKING', reminderDays: [1] })).toEqual([null]);
    expect(reminderPoints({ dueOn: '2027-01-04', unit: 'WORKING', calendars: SOURCE, reminderDays: [1, -2] })).toEqual([null, null]);
    expect(reminderPoints({ dueOn: '2026-12-31', unit: 'WORKING', calendars: SOURCE, reminderDays: [-1] })).toEqual([null]);
  });

  it('names the reminders crossed since the last evaluation, each once', () => {
    const days = [5, 2, 0, -1];
    expect(dueReminders({ previousRemaining: 6, remaining: 4, reminderDays: days })).toEqual([5]);
    expect(dueReminders({ previousRemaining: 4, remaining: 4, reminderDays: days })).toEqual([]);
    expect(dueReminders({ previousRemaining: 6, remaining: 1, reminderDays: days })).toEqual([5, 2]);
    expect(dueReminders({ previousRemaining: 1, remaining: -3, reminderDays: days })).toEqual([0, -1]);
    expect(dueReminders({ previousRemaining: null, remaining: 1, reminderDays: days })).toEqual([5, 2]);
    expect(dueReminders({ previousRemaining: null, remaining: 9, reminderDays: days })).toEqual([]);
    expect(dueReminders({ previousRemaining: 3, remaining: 4, reminderDays: days })).toEqual([]);
  });

  it('escalates once a task has been overdue for the days the rule names', () => {
    expect(shouldEscalate({ remaining: -3, escalateAfterOverdueDays: 3 })).toBe(true);
    expect(shouldEscalate({ remaining: -2, escalateAfterOverdueDays: 3 })).toBe(false);
    expect(shouldEscalate({ remaining: 2, escalateAfterOverdueDays: 3 })).toBe(false);
    expect(shouldEscalate({ remaining: -30, escalateAfterOverdueDays: null })).toBe(false);
    expect(shouldEscalate({ remaining: null, escalateAfterOverdueDays: 3 })).toBe(false);
  });
});
