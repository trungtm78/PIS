import { DomainError } from '../src/errors.ts';
import { assertPersonalPreference, bandOf, bandPolicyOf, clampedLevels, previewBandExamples, resolveBand } from '../src/deadline-band.ts';
import type { BandPolicy, BandThresholds, DeadlineUnit, PersonalPreference } from '../src/deadline-band.ts';
import { builtInDefault, registerAllGovernanceRules } from '../src/governance-rules.ts';
import { workBucket } from '../src/home-work.ts';
import type { WorkCalendarContent, WorkCalendarSource } from '../src/working-time.ts';

beforeAll(() => registerAllGovernanceRules());

const OFFICIAL: BandThresholds = { green_days: 5, yellow_days: 2, red_days: 0 };
const NOTHING: PersonalPreference = { green_days: null, yellow_days: null, red_days: null, reminder_days: [] };

const failure = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};
const refusal = (run: () => unknown): [string, string | undefined] => {
  const error = failure(run);
  return [error.code, error.detail];
};

/** 2026: Monday to Friday, Wednesday 11 November a holiday (a made-up day); 2027 is not published. */
const CALENDAR_2026: WorkCalendarContent = { calendar_code: 'WORKDAY_VN', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-11', name: 'Ngày nghỉ thử' }], legal_basis_ref: 'fixture' };
const CALENDARS: WorkCalendarSource = { forYear: (year) => (year === 2026 ? CALENDAR_2026 : undefined) };
const TODAY = '2026-11-09';

describe('assertPersonalPreference: a person may be warned earlier, never later (R40)', () => {
  it('accepts nothing at all (the official ladder), and a ladder that is the same or earlier at every level', () => {
    expect(assertPersonalPreference(OFFICIAL, NOTHING)).toEqual(OFFICIAL);
    expect(assertPersonalPreference(OFFICIAL, { ...NOTHING, green_days: 5, yellow_days: 2, red_days: 0 })).toEqual(OFFICIAL);
    expect(assertPersonalPreference(OFFICIAL, { ...NOTHING, green_days: 7, yellow_days: 3, red_days: 1 })).toEqual({ green_days: 7, yellow_days: 3, red_days: 1 });
    expect(assertPersonalPreference(OFFICIAL, { ...NOTHING, yellow_days: 4 })).toEqual({ green_days: 5, yellow_days: 4, red_days: 0 });
  });

  it('refuses a level that starts later than the official one, naming the level', () => {
    const table: Array<[PersonalPreference, string]> = [
      [{ ...NOTHING, green_days: 4 }, 'green_days'],
      [{ ...NOTHING, yellow_days: 1 }, 'yellow_days'],
      [{ ...NOTHING, red_days: -1 }, 'red_days'],
      [{ ...NOTHING, green_days: 3, yellow_days: 1, red_days: -1 }, 'green_days'],
    ];
    for (const [input, field] of table) expect([input, refusal(() => assertPersonalPreference(OFFICIAL, input))]).toEqual([input, ['DEADLINE_PERSONAL_NOT_EARLIER', field]]);
  });

  it('refuses a ladder that is not strictly ordered once merged, and numbers that are not whole days or out of range', () => {
    const table: Array<[PersonalPreference, string]> = [
      [{ ...NOTHING, yellow_days: 5 }, 'green_days'],
      [{ ...NOTHING, red_days: 2 }, 'yellow_days'],
      [{ ...NOTHING, green_days: 3650, yellow_days: 3651 }, 'yellow_days'],
      [{ ...NOTHING, yellow_days: 2.5 }, 'yellow_days'],
      [{ ...NOTHING, green_days: 0 }, 'green_days'],
      [{ ...NOTHING, red_days: -2 }, 'red_days'],
    ];
    for (const [input, field] of table) expect([input, refusal(() => assertPersonalPreference(OFFICIAL, input))]).toEqual([input, ['DEADLINE_BAND_THRESHOLDS_INVALID', field]]);
  });

  it('takes no personal green line where the official green line is open (that would start green later)', () => {
    const legacy: BandThresholds = { green_days: null, yellow_days: 7, red_days: -1 };
    expect(refusal(() => assertPersonalPreference(legacy, { ...NOTHING, green_days: 20 }))).toEqual(['DEADLINE_PERSONAL_NOT_EARLIER', 'green_days']);
    expect(assertPersonalPreference(legacy, { ...NOTHING, yellow_days: 10 })).toEqual({ green_days: null, yellow_days: 10, red_days: -1 });
  });

  it('keeps the extra reminder days strictly decreasing, at most six, in range and none below the official red line', () => {
    expect(assertPersonalPreference(OFFICIAL, { ...NOTHING, reminder_days: [10, 7, 3, 1, 0] })).toEqual(OFFICIAL);
    expect(refusal(() => assertPersonalPreference(OFFICIAL, { ...NOTHING, reminder_days: [3, 3] }))).toEqual(['DEADLINE_BAND_THRESHOLDS_INVALID', 'reminder_days']);
    expect(refusal(() => assertPersonalPreference(OFFICIAL, { ...NOTHING, reminder_days: [1, 2] }))).toEqual(['DEADLINE_BAND_THRESHOLDS_INVALID', 'reminder_days']);
    expect(refusal(() => assertPersonalPreference(OFFICIAL, { ...NOTHING, reminder_days: [9, 8, 7, 6, 5, 4, 3] }))).toEqual(['DEADLINE_BAND_THRESHOLDS_INVALID', 'reminder_days']);
    expect(refusal(() => assertPersonalPreference(OFFICIAL, { ...NOTHING, reminder_days: [400] }))).toEqual(['DEADLINE_BAND_THRESHOLDS_INVALID', 'reminder_days']);
    expect(refusal(() => assertPersonalPreference(OFFICIAL, { ...NOTHING, reminder_days: [2, 1, -1] }))).toEqual(['DEADLINE_PERSONAL_NOT_EARLIER', 'reminder_days']);
  });

  it('names the levels of a stored preference that the official rule has since passed', () => {
    expect(clampedLevels(OFFICIAL, { green_days: 3, yellow_days: 4 })).toEqual(['green_days']);
    expect(clampedLevels({ green_days: 8, yellow_days: 3, red_days: 1 }, { green_days: 7, yellow_days: 2, red_days: 1 })).toEqual(['green_days', 'yellow_days']);
    expect(clampedLevels(OFFICIAL, {})).toEqual([]);
  });
});

/**
 * The decision table of the colour across the three tiers and the two units: for each number of days left, what the system default, the rule of the tenant (and of a unit) and the person's own ladder say, and what the official colour is.
 * Whatever the person sets, the official colour is the one of tiers 1 and 2.
 */
describe('the colour across the three tiers and the units', () => {
  const policyOf = (unit: DeadlineUnit, ladder: BandThresholds, overrides: BandPolicy['overrides'] = []): BandPolicy => ({ unit, ...ladder, overrides, reminder_days: [], escalate_after_overdue_days: null });
  const TENANT_RULE: BandThresholds = { green_days: 10, yellow_days: 4, red_days: 1 };

  it('system default 5/2/0 working days, tenant rule 10/4/1, person 12/6/2: the official colour never follows the person', () => {
    const rows: Array<[number, string, string, string]> = [
      // days left, system default, tenant rule (official when there is one), person
      [13, 'NONE', 'NONE', 'NONE'],
      [12, 'NONE', 'NONE', 'GREEN'],
      [10, 'NONE', 'GREEN', 'GREEN'],
      [6, 'NONE', 'GREEN', 'YELLOW'],
      [5, 'GREEN', 'GREEN', 'YELLOW'],
      [4, 'GREEN', 'YELLOW', 'YELLOW'],
      [2, 'YELLOW', 'YELLOW', 'RED'],
      [1, 'YELLOW', 'RED', 'RED'],
      [0, 'RED', 'RED', 'RED'],
      [-3, 'RED', 'RED', 'RED'],
    ];
    const personal = { green_days: 12, yellow_days: 6, red_days: 2 };
    const policy = policyOf('WORKING', TENANT_RULE);
    for (const [remaining, system, tenant, person] of rows) {
      expect([remaining, 'system', bandOf(remaining, OFFICIAL)]).toEqual([remaining, 'system', system]);
      expect([remaining, 'tenant', bandOf(remaining, TENANT_RULE)]).toEqual([remaining, 'tenant', tenant]);
      const due = { dueOn: dayPlusCalendar(remaining), today: TODAY, unit: 'CALENDAR' as const };
      const resolved = resolveBand({ system: OFFICIAL, policy: { ...policy, unit: 'CALENDAR' }, personal }, {}, due);
      expect([remaining, 'official', resolved.official.band]).toEqual([remaining, 'official', tenant]);
      expect([remaining, 'person', resolved.personal?.band]).toEqual([remaining, 'person', person]);
      // The official result is the same whether or not the person has a ladder.
      expect(resolveBand({ system: OFFICIAL, policy: { ...policy, unit: 'CALENDAR' } }, {}, due).official).toEqual(resolved.official);
    }
  });

  it('a person who asks for a later ladder is shown the official one, and the levels are named', () => {
    const resolved = resolveBand({ system: OFFICIAL, personal: { green_days: 3, yellow_days: 1, red_days: -1 } }, {}, { dueOn: dayPlusCalendar(2), today: TODAY, unit: 'CALENDAR' });
    expect(resolved.official.band).toBe('YELLOW');
    expect(resolved.personal?.band).toBe('YELLOW');
    expect(resolved.personalApplied).toBe(false);
    expect(resolved.clamped).toEqual(['green_days', 'yellow_days', 'red_days']);
  });

  it('counts the same ladder in working days for a task and in calendar days for the work centre', () => {
    // Monday 9 November 2026; Wednesday 11 is a holiday, so Friday 13 is 3 working days but 4 calendar days away.
    const working = resolveBand({ system: OFFICIAL, personal: { yellow_days: 3 } }, {}, { dueOn: '2026-11-13', today: TODAY, unit: 'WORKING', calendars: CALENDARS });
    expect([working.official.remainingDays, working.official.band, working.personal?.band]).toEqual([3, 'GREEN', 'YELLOW']);
    const calendar = resolveBand({ system: OFFICIAL, personal: { yellow_days: 3 } }, {}, { dueOn: '2026-11-13', today: TODAY, unit: 'CALENDAR' });
    expect([calendar.official.remainingDays, calendar.official.band, calendar.personal?.band]).toEqual([4, 'GREEN', 'GREEN']);
  });

  it('a unit rule that is not in the unit of the source is refused; the same numbers in the right unit read', () => {
    const rule = builtInDefault('DEADLINE_BAND_POLICY', 'PROJECT_TASK');
    expect(rule).toBeDefined();
    const resolved = { params: { ...(rule?.params ?? {}), unit: 'CALENDAR' } };
    expect(failure(() => bandPolicyOf(resolved, 'PROJECT_TASK')).code).toBe('DEADLINE_BAND_UNIT_MISMATCH');
    expect(bandPolicyOf({ params: rule?.params ?? {} }, 'PROJECT_TASK')).toMatchObject({ unit: 'WORKING', green_days: 5, yellow_days: 2, red_days: 0 });
  });

  it('a calendar that is not published says UNKNOWN for both colours, never a guess', () => {
    const resolved = resolveBand({ system: OFFICIAL, personal: { yellow_days: 3 } }, {}, { dueOn: '2027-01-05', today: '2026-12-30', unit: 'WORKING', calendars: CALENDARS });
    expect([resolved.official.band, resolved.personal?.band]).toEqual(['UNKNOWN', 'UNKNOWN']);
  });
});

function dayPlusCalendar(days: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

describe('previewBandExamples', () => {
  it('lists the colour at the days that matter, nearest the deadline last, the example of the owner included', () => {
    expect(previewBandExamples(OFFICIAL)).toEqual([
      { remaining_days: 6, band: 'NONE' },
      { remaining_days: 5, band: 'GREEN' },
      { remaining_days: 3, band: 'GREEN' },
      { remaining_days: 2, band: 'YELLOW' },
      { remaining_days: 1, band: 'YELLOW' },
      { remaining_days: 0, band: 'RED' },
      { remaining_days: -1, band: 'RED' },
    ]);
  });

  it('adds the days that are asked for, once, and has no line above yellow for an open green line', () => {
    expect(previewBandExamples(OFFICIAL, [9, 3]).map((one) => one.remaining_days)).toEqual([9, 6, 5, 3, 2, 1, 0, -1]);
    expect(previewBandExamples({ green_days: null, yellow_days: 7, red_days: -1 }).map((one) => [one.remaining_days, one.band])).toEqual([
      [8, 'GREEN'],
      [7, 'YELLOW'],
      [0, 'YELLOW'],
      [-1, 'RED'],
      [-2, 'RED'],
    ]);
  });

  it('refuses a ladder that is not ordered', () => {
    expect(refusal(() => previewBandExamples({ green_days: 2, yellow_days: 2, red_days: 0 }))).toEqual(['DEADLINE_BAND_THRESHOLDS_INVALID', 'green_days']);
  });
});

/** The cases of the UAT plan that the pure decision table settles (docs/uat/pwf/uat.json): the same table at the layer where the boundary lives. */
describe('the decision table of the colours, case by case', () => {
  const OLD_HOME_WORK_NEAR_DAYS = 7;
  const OLD_SCHEDULE_DUE_SOON_DAYS = 3;
  const dayText = (offset: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

  it('UAT-PWF-BND-01, UAT-PWF-BND-02 and UAT-PWF-BND-03: with 5/2/0, 6 days is no colour, 5 and 3 green, 2 and 1 yellow, 0 and overdue red', () => {
    const table: Array<[number, string]> = [[6, 'NONE'], [5, 'GREEN'], [3, 'GREEN'], [2, 'YELLOW'], [1, 'YELLOW'], [0, 'RED'], [-1, 'RED']];
    for (const [remaining, band] of table) expect([remaining, bandOf(remaining, OFFICIAL)]).toEqual([remaining, band]);
  });

  it('UAT-PWF-BND-04: overdue is red, and the days are counted in working days (from a Friday to the Monday after is 1 day, not 3)', () => {
    const friday = '2026-11-06';
    const monday = '2026-11-09';
    const result = resolveBand({ system: OFFICIAL }, {}, { dueOn: monday, today: friday, unit: 'WORKING', calendars: CALENDARS });
    expect([result.official.remainingDays, result.official.band]).toEqual([1, 'YELLOW']);
    expect(resolveBand({ system: OFFICIAL }, {}, { dueOn: friday, today: monday, unit: 'WORKING', calendars: CALENDARS }).official).toMatchObject({ remainingDays: -1, band: 'RED', overdue: true });
  });

  it('UAT-PWF-BND-05: with no green line every number of days above yellow is green and there is no "far"', () => {
    const open: BandThresholds = { green_days: null, yellow_days: 2, red_days: 0 };
    for (const remaining of [3, 30, 400]) expect(bandOf(remaining, open)).toBe('GREEN');
    expect(resolveBand({ system: open }, {}, { dueOn: dayText(300), today: TODAY, unit: 'CALENDAR' }).official).toMatchObject({ band: 'GREEN' });
  });

  it('UAT-PWF-BND-06: a ladder that is out of order, or whose red line is below -1, is refused naming the field', () => {
    const cases: Array<[BandThresholds, string]> = [
      [{ green_days: 2, yellow_days: 2, red_days: 0 }, 'green_days'],
      [{ green_days: 5, yellow_days: 1, red_days: 1 }, 'yellow_days'],
      [{ green_days: null, yellow_days: 2, red_days: -2 }, 'red_days'],
    ];
    for (const [ladder, field] of cases) expect(refusal(() => assertPersonalPreference(ladder, NOTHING))).toEqual(['DEADLINE_BAND_THRESHOLDS_INVALID', field]);
    expect(refusal(() => previewBandExamples({ green_days: 5, yellow_days: 2, red_days: -2 }))).toEqual(['DEADLINE_BAND_THRESHOLDS_INVALID', 'red_days']);
  });

  it('UAT-PWF-BND-07: a task with no day has no colour (NO_DUE), and a rule counted in another unit than its source declares is refused', () => {
    expect(resolveBand({ system: OFFICIAL }, {}, { dueOn: null, today: TODAY, unit: 'WORKING', calendars: CALENDARS }).official).toMatchObject({ band: 'NONE', reason: 'NO_DUE', remainingDays: null });
    const rule = builtInDefault('DEADLINE_BAND_POLICY', 'PROJECT_TASK');
    expect(failure(() => bandPolicyOf({ params: { ...(rule?.params ?? {}), unit: 'CALENDAR' } }, 'PROJECT_TASK')).code).toBe('DEADLINE_BAND_UNIT_MISMATCH');
  });

  it('UAT-PWF-REG-01: the defaults of the work centre (7, then -1) and of the report schedule (3, then -1) are the constants they replace, for every day from -400 to 400', () => {
    for (const [source, soon] of [['HOME_WORK', OLD_HOME_WORK_NEAR_DAYS], ['REPORT_SCHEDULE', OLD_SCHEDULE_DUE_SOON_DAYS]] as const) {
      const policy = bandPolicyOf({ params: builtInDefault('DEADLINE_BAND_POLICY', source)?.params ?? {} }, source);
      expect(policy).toMatchObject({ unit: 'CALENDAR', green_days: null, yellow_days: soon, red_days: -1 });
      for (let remaining = -400; remaining <= 400; remaining += 1) {
        // The old rule: past is late (red), within the days is near (yellow), the rest is later (green).
        const old = remaining < 0 ? 'RED' : remaining <= soon ? 'YELLOW' : 'GREEN';
        expect([source, remaining, bandOf(remaining, policy)]).toEqual([source, remaining, old]);
        // And the function of the work centre that the policy replaces gives the same bucket, the very code that was there before.
        if (source === 'HOME_WORK') expect([remaining, workBucket({ dueOn: dayText(remaining), originalDueOn: dayText(remaining) }, TODAY)]).toEqual([remaining, { RED: 'OVERDUE', YELLOW: 'NEAR', GREEN: 'LATER' }[old]]);
      }
    }
  });
});
