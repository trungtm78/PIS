import { DomainError } from './errors.ts';
import type { FieldSpec, RuleRegistry } from './governance-rules.ts';
import { PWF_BAND_TEXT as T } from './messages/pwf-band-texts.ts';
import { MAX_SCAN_DAYS, dayNumber, dayText, isWorkflowDay, workingDaysBetween } from './process-core.ts';
import { isWorkingDay } from './working-time.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * The three colours of a deadline (PWF, owner request (b); R30 and R40 of the review): how many days before its deadline a task turns green, yellow and red. It is pure and has three tiers, the last of which can only make a person see
 * a warning EARLIER, never later:
 *
 *  1. the system default of a source (the built-in `DEADLINE_BAND_POLICY` code of that source, whose numbers equal the constants the code used before: NEAR_DAYS 7 of the work centre, SCHEDULE_DUE_SOON_DAYS 3 of the report schedule);
 *  2. the rule `DEADLINE_BAND_POLICY` the tenant (or a unit) approved, with overrides by kind of task, priority and phase;
 *  3. the person's own thresholds (`alert_notification_profile`), which move only the colour that person sees in their own list, never the official colour, the escalation or a KPI.
 *
 * A level STARTS when the days remaining are at most its threshold: 5 / 2 / 0 reads "green from 5 days before, yellow from 2, red from the day of the deadline". Overdue is fewer than 0 days remaining, so a red line of -1 means "red only
 * once overdue" (the legacy meaning). A green line of `null` means every time above yellow is green (the legacy "later"); with a number, a deadline farther than it has no colour (`NONE`).
 *
 * The unit (calendar days or working days) is declared by the SOURCE of the deadline, not by the tenant, so that a policy cannot change what a "day" means for a source. Working days are counted on the published calendars and a day
 * without one is `UNKNOWN`, never a guessed colour (the rule of `process-core.ts`).
 */

export const DEADLINE_BAND_RULE_TYPE = 'DEADLINE_BAND_POLICY';

export const BAND_COLORS = ['GREEN', 'YELLOW', 'RED'] as const;
export type BandColor = (typeof BAND_COLORS)[number];
/** `NONE`: no deadline, or farther than the green line. `UNKNOWN`: the working calendar needed to count the days is not published. */
export type Band = BandColor | 'NONE' | 'UNKNOWN';
/** The order of severity of the colours; `UNKNOWN` is outside it and has no rank. */
export const BAND_RANK: Readonly<Record<Exclude<Band, 'UNKNOWN'>, number>> = { NONE: 0, GREEN: 1, YELLOW: 2, RED: 3 };

export const DEADLINE_UNITS = ['CALENDAR', 'WORKING'] as const;
export type DeadlineUnit = (typeof DEADLINE_UNITS)[number];
export const TASK_KINDS = ['TASK', 'MILESTONE'] as const;
export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;

/** Days remaining at which each level starts. Strictly ordered: `green_days` (when not null) > `yellow_days` > `red_days` >= -1. */
export interface BandThresholds {
  green_days: number | null;
  yellow_days: number;
  red_days: number;
}

/** What a person may set: any of the three numbers; what is not set stays as the official one. */
export interface PersonalThresholds {
  green_days?: number | null;
  yellow_days?: number;
  red_days?: number;
}

export interface BandContext {
  taskKind?: (typeof TASK_KINDS)[number];
  priority?: (typeof TASK_PRIORITIES)[number];
  phase?: string;
}

export interface BandOverride extends BandThresholds {
  match: { task_kind?: (typeof TASK_KINDS)[number]; priority?: (typeof TASK_PRIORITIES)[number]; phase?: string };
}

export interface BandPolicy extends BandThresholds {
  unit: DeadlineUnit;
  overrides: readonly BandOverride[];
  /** The days remaining at which a reminder is due, strictly decreasing (5, 2, 0, -1: five and two days before, on the day, the day after). */
  reminder_days: readonly number[];
  escalate_after_overdue_days: number | null;
}

export interface DeadlineBandResult {
  band: Band;
  /** Null when there is no deadline or the days cannot be counted. */
  remainingDays: number | null;
  /** The day of the deadline has passed: true from the calendar day after it, whether or not that day is worked (a deadline of Friday is overdue on the Saturday, with 0 working days of lateness counted yet). */
  overdue: boolean;
  /** The deadline is today, by the calendar: the only day a screen may say "due today". */
  dueToday: boolean;
  unit: DeadlineUnit;
  reason?: 'NO_DUE' | 'FAR' | 'CALENDAR_UNAVAILABLE';
}

const bad = (code: string, field: string): DomainError => new DomainError(code, 422, field);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The sources of deadlines and the unit each declares.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DeadlineSource {
  code: string;
  unit: DeadlineUnit;
  label: string;
}

const SOURCES = new Map<string, DeadlineSource>();
const SOURCE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/** Registers a source of deadlines with the unit its days are counted in; a code is registered once. */
export function registerDeadlineSource(source: DeadlineSource): void {
  if (!SOURCE_CODE.test(source.code)) throw new Error(`deadline source: ${String(source.code)} is not a code`);
  if (!(DEADLINE_UNITS as readonly string[]).includes(source.unit)) throw new Error(`deadline source ${source.code}: unknown unit`);
  if (source.label.trim().length < 3) throw new Error(`deadline source ${source.code}: no label`);
  if (SOURCES.has(source.code)) throw new Error(`deadline source ${source.code} is already registered`);
  SOURCES.set(source.code, { ...source });
}
export const deadlineSourceOf = (code: string): DeadlineSource | undefined => SOURCES.get(code);
export const deadlineSources = (): DeadlineSource[] => [...SOURCES.values()];

registerDeadlineSource({ code: 'HOME_WORK', unit: 'CALENDAR', label: T.source_home_work });
registerDeadlineSource({ code: 'REPORT_SCHEDULE', unit: 'CALENDAR', label: T.source_report_schedule });
registerDeadlineSource({ code: 'PROJECT_TASK', unit: 'WORKING', label: T.source_project_task });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Thresholds and the band of a number of days.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The field that breaks the strict order, or undefined when the ladder is valid. */
function thresholdDefect(thresholds: BandThresholds): string | undefined {
  const { green_days: green, yellow_days: yellow, red_days: red } = thresholds;
  if (!Number.isInteger(red) || red < -1) return 'red_days';
  if (!Number.isInteger(yellow) || yellow <= red) return 'yellow_days';
  if (green !== null && (!Number.isInteger(green) || green <= yellow)) return 'green_days';
  return undefined;
}

/** Refuses a ladder that is not strictly ordered or not made of whole days: 422 DEADLINE_BAND_THRESHOLDS_INVALID naming the field. */
export function validateThresholds(thresholds: BandThresholds): void {
  const field = thresholdDefect(thresholds);
  if (field !== undefined) throw bad('DEADLINE_BAND_THRESHOLDS_INVALID', field);
}

/** The band of a number of days remaining: red from the red line, yellow from the yellow line, green from the green line (always, when it has none), else no colour. */
export function bandOf(remaining: number, thresholds: BandThresholds): Band {
  if (remaining <= thresholds.red_days) return 'RED';
  if (remaining <= thresholds.yellow_days) return 'YELLOW';
  if (thresholds.green_days === null || remaining <= thresholds.green_days) return 'GREEN';
  return 'NONE';
}

export interface RemainingInput {
  dueOn: string;
  today: string;
  unit: DeadlineUnit;
  calendars?: WorkCalendarSource | undefined;
}

const dayField = (value: string, field: string): void => {
  if (!isWorkflowDay(value)) throw bad('VALIDATION_FAILED', field);
};

/**
 * Days from `today` to `dueOn`: negative once overdue, 0 on the day of the deadline. In working days they are the working days after `today` up to and including `dueOn` (negated when the deadline is past); null when a year in between
 * has no published calendar, or no calendar was given.
 */
export function remainingDays(input: RemainingInput): number | null {
  dayField(input.dueOn, 'due_on');
  dayField(input.today, 'today');
  if (input.unit === 'CALENDAR') return dayNumber(input.dueOn) - dayNumber(input.today);
  if (dayNumber(input.dueOn) >= dayNumber(input.today)) return workingDaysBetween(input.calendars, input.today, input.dueOn) ?? null;
  const past = workingDaysBetween(input.calendars, input.dueOn, input.today);
  // Never -0: over the days nobody works after the deadline the count is a plain 0.
  return past === undefined ? null : past === 0 ? 0 : -past;
}

export interface DeadlineBandInput extends Omit<RemainingInput, 'dueOn'> {
  dueOn: string | null;
  thresholds: BandThresholds;
}

export function deadlineBand(input: DeadlineBandInput): DeadlineBandResult {
  const { unit } = input;
  if (input.dueOn === null) return { band: 'NONE', remainingDays: null, overdue: false, dueToday: false, unit, reason: 'NO_DUE' };
  const remaining = remainingDays({ dueOn: input.dueOn, today: input.today, unit, calendars: input.calendars });
  if (remaining === null) return { band: 'UNKNOWN', remainingDays: null, overdue: false, dueToday: false, unit, reason: 'CALENDAR_UNAVAILABLE' };
  // Overdue is a fact of the calendar, not of the count (R49): in working days the count stays 0 over the days nobody works after the deadline, and the deadline has passed all the same. An overdue deadline is red on every
  // ladder ("red only once overdue" is the latest a red line can be), so the weekend after a missed Friday is never yellow and never "due today".
  const overdue = dayNumber(input.dueOn) < dayNumber(input.today);
  const band = overdue ? 'RED' : bandOf(remaining, input.thresholds);
  const result: DeadlineBandResult = { band, remainingDays: remaining, overdue, dueToday: input.dueOn === input.today, unit };
  return band === 'NONE' ? { ...result, reason: 'FAR' } : result;
}

export type DeadlineWordingKind = 'NO_DUE' | 'FAR' | 'UNKNOWN' | 'OVERDUE_DAYS' | 'OVERDUE' | 'DUE_TODAY' | 'NO_DAY_LEFT' | 'DAYS_LEFT';

export interface DeadlineWording {
  kind: DeadlineWordingKind;
  /** The days the words carry: the days of lateness (OVERDUE_DAYS), the days left (DAYS_LEFT), 0 for the three states of the day itself, null when nothing is counted. */
  days: number | null;
  unit: DeadlineUnit;
}

/**
 * What a screen says of a deadline, from the result of `deadlineBand` alone (R49: one source for the web and the phone, so the words and the colour never disagree): how many days late; overdue with no working day of lateness
 * counted yet (the weekend after the deadline); due today (the day of the deadline, and no other); no working day left before a deadline that is still ahead (it falls on a day nobody works); or how many days are left.
 */
export function deadlineWording(result: Pick<DeadlineBandResult, 'band' | 'remainingDays' | 'overdue' | 'dueToday' | 'unit'>): DeadlineWording {
  const { unit } = result;
  if (result.remainingDays === null) return { kind: result.band === 'UNKNOWN' ? 'UNKNOWN' : 'NO_DUE', days: null, unit };
  if (result.band === 'NONE') return { kind: 'FAR', days: null, unit };
  if (result.overdue) return result.remainingDays < 0 ? { kind: 'OVERDUE_DAYS', days: -result.remainingDays, unit } : { kind: 'OVERDUE', days: 0, unit };
  if (result.remainingDays > 0) return { kind: 'DAYS_LEFT', days: result.remainingDays, unit };
  return { kind: result.dueToday ? 'DUE_TODAY' : 'NO_DAY_LEFT', days: 0, unit };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The rule DEADLINE_BAND_POLICY.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const intField = (min: number, max: number, optional = false): FieldSpec => ({ kind: 'int', min, max, optional });
const ladderFields = (): Record<string, FieldSpec> => ({ green_days: intField(1, 3650, true), yellow_days: intField(0, 3650), red_days: intField(-1, 3650) });

const POLICY_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  unit: { kind: 'enum', values: DEADLINE_UNITS },
  ...ladderFields(),
  overrides: {
    kind: 'list',
    max: 20,
    of: {
      kind: 'object',
      fields: {
        match: {
          kind: 'object',
          fields: {
            task_kind: { kind: 'enum', values: TASK_KINDS, optional: true },
            priority: { kind: 'enum', values: TASK_PRIORITIES, optional: true },
            phase: { kind: 'text', max: 40, optional: true, pattern: '^[A-Z][A-Z0-9_]{1,39}$' },
          },
        },
        ...ladderFields(),
      },
    },
  },
  reminder_days: { kind: 'list', max: 6, of: intField(-30, 365) },
  escalate_after_overdue_days: intField(1, 365, true),
};

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const ladderOf = (value: Record<string, unknown>): BandThresholds => ({ green_days: (value.green_days ?? null) as number | null, yellow_days: value.yellow_days as number, red_days: value.red_days as number });

/** The field of the params that breaks the rules the closed schema cannot say (the ladder of the rule and of every override, the order of the reminders), or undefined. */
function policyDefect(params: Record<string, unknown>): string | undefined {
  const own = thresholdDefect(ladderOf(params));
  if (own !== undefined) return own;
  const overrides = Array.isArray(params.overrides) ? params.overrides : [];
  for (let index = 0; index < overrides.length; index += 1) {
    const field = thresholdDefect(ladderOf(asRecord(overrides[index])));
    if (field !== undefined) return `overrides[${index}].${field}`;
  }
  const reminders = Array.isArray(params.reminder_days) ? (params.reminder_days as number[]) : [];
  if (reminders.some((value, index) => index > 0 && value >= (reminders[index - 1] as number))) return 'reminder_days';
  return undefined;
}

/**
 * Reads the params of a rule `DEADLINE_BAND_POLICY` of the source `sourceCode` into a policy. The unit of the rule must be the unit the source declares (422 DEADLINE_BAND_UNIT_MISMATCH); the ladder must be valid
 * (422 DEADLINE_BAND_THRESHOLDS_INVALID).
 */
export function bandPolicyOf(resolved: { params: Readonly<Record<string, unknown>> }, sourceCode: string): BandPolicy {
  const source = deadlineSourceOf(sourceCode);
  if (source === undefined) throw bad('VALIDATION_FAILED', 'source');
  const params = resolved.params as Record<string, unknown>;
  if (params.unit !== source.unit) throw bad('DEADLINE_BAND_UNIT_MISMATCH', 'unit');
  const defect = policyDefect(params);
  if (defect !== undefined) throw bad('DEADLINE_BAND_THRESHOLDS_INVALID', defect);
  const overrides = (Array.isArray(params.overrides) ? params.overrides : []).map((raw): BandOverride => {
    const item = asRecord(raw);
    return { match: asRecord(item.match) as BandOverride['match'], ...ladderOf(item) };
  });
  return {
    unit: source.unit,
    ...ladderOf(params),
    overrides,
    reminder_days: Array.isArray(params.reminder_days) ? [...(params.reminder_days as number[])] : [],
    escalate_after_overdue_days: typeof params.escalate_after_overdue_days === 'number' ? params.escalate_after_overdue_days : null,
  };
}

const matches = (override: BandOverride, context: BandContext): boolean => {
  const { task_kind: kind, priority, phase } = override.match;
  return (kind === undefined || kind === context.taskKind) && (priority === undefined || priority === context.priority) && (phase === undefined || phase === context.phase);
};

/** The thresholds that apply to one task: the first override whose `match` fits it, else the thresholds of the rule. */
export function thresholdsFor(policy: BandPolicy, context: BandContext): BandThresholds {
  const found = policy.overrides.find((override) => matches(override, context));
  const source = found ?? policy;
  return { green_days: source.green_days, yellow_days: source.yellow_days, red_days: source.red_days };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The three tiers.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface BandTiers {
  /** Tier 1: the system default of the source. */
  system: BandThresholds;
  /** Tier 2: the rule the tenant approved, when there is one. */
  policy?: BandPolicy | undefined;
  /** Tier 3: the person's own thresholds. */
  personal?: PersonalThresholds | null | undefined;
}

export type DueInfo = Omit<DeadlineBandInput, 'thresholds'>;

export interface ResolvedBand {
  /** The colour every shared screen, escalation and KPI uses: tiers 1 and 2 only. */
  official: DeadlineBandResult;
  /** The colour in the person's own list ("by your settings"); null when the person set nothing. */
  personal: DeadlineBandResult | null;
  /** Whether the person's thresholds differ from the official ones after clamping. */
  personalApplied: boolean;
  /** The thresholds the person asked to be later than the official ones and that were raised to them. */
  clamped: string[];
}

/** Merges the person's thresholds into the official ones so that no level starts later; `null` for a green line is the earliest of all (everything is green). */
function mergePersonal(official: BandThresholds, personal: PersonalThresholds): { merged: BandThresholds; clamped: string[] } {
  const clamped: string[] = [];
  let green = official.green_days;
  if (personal.green_days !== undefined) {
    if (personal.green_days === null) green = null;
    else if (official.green_days === null || personal.green_days < official.green_days) clamped.push('green_days');
    else green = personal.green_days;
  }
  const raise = (field: 'yellow_days' | 'red_days'): number => {
    const asked = personal[field];
    if (asked === undefined) return official[field];
    if (asked < official[field]) clamped.push(field);
    return Math.max(asked, official[field]);
  };
  return { merged: { green_days: green, yellow_days: raise('yellow_days'), red_days: raise('red_days') }, clamped };
}

/**
 * The band of a deadline in the three tiers. The official result never depends on the personal tier (R40); the personal one is for the person's own list only and may only warn earlier. A personal ladder that is not strictly ordered
 * once merged is refused (422 DEADLINE_BAND_THRESHOLDS_INVALID).
 */
export function resolveBand(tiers: BandTiers, context: BandContext, due: DueInfo): ResolvedBand {
  const official = tiers.policy === undefined ? tiers.system : thresholdsFor(tiers.policy, context);
  const officialResult = deadlineBand({ ...due, thresholds: official });
  if (tiers.personal === undefined || tiers.personal === null) return { official: officialResult, personal: null, personalApplied: false, clamped: [] };
  const { merged, clamped } = mergePersonal(official, tiers.personal);
  validateThresholds(merged);
  const applied = merged.green_days !== official.green_days || merged.yellow_days !== official.yellow_days || merged.red_days !== official.red_days;
  return { official: officialResult, personal: deadlineBand({ ...due, thresholds: merged }), personalApplied: applied, clamped };
}

export interface BandExample {
  remaining_days: number;
  band: Band;
}

/**
 * What a ladder does at the days that matter, for the preview a person reads before saving ("5 days left: green, 2 days: yellow, under 1 day: red"): one line above the green line, each line itself, the day after each line and the first day
 * overdue, nearest the deadline last; and the days the caller asks for. The ladder must be valid (422 DEADLINE_BAND_THRESHOLDS_INVALID).
 */
export function previewBandExamples(thresholds: BandThresholds, extraDays: readonly number[] = []): BandExample[] {
  validateThresholds(thresholds);
  const { green_days: green, yellow_days: yellow, red_days: red } = thresholds;
  const days = new Set<number>([yellow + 1, yellow, red + 1, red, red - 1, ...extraDays]);
  if (green !== null) {
    days.add(green + 1);
    days.add(green);
  }
  return [...days].sort((left, right) => right - left).map((remaining) => ({ remaining_days: remaining, band: bandOf(remaining, thresholds) }));
}

/** What a person saves as their own preference: a level left null follows the official one; the reminder days are extra points of their own. */
export interface PersonalPreference {
  green_days: number | null;
  yellow_days: number | null;
  red_days: number | null;
  reminder_days: readonly number[];
}

/** The most extra reminder days one person can keep (the same as a rule). */
export const MAX_PERSONAL_REMINDERS = 6;
const LEVEL_RANGE: Readonly<Record<keyof BandThresholds, readonly [number, number]>> = { green_days: [1, 3650], yellow_days: [0, 3650], red_days: [-1, 3650] };
const REMINDER_RANGE = [-30, 365] as const;

/**
 * Checks what a person asked for against the official ladder of the source and gives the ladder they will see. Each level they set is whole days in its range and starts no later than the official one (422 DEADLINE_PERSONAL_NOT_EARLIER,
 * naming the level: nobody loosens their own deadline, R40); the ladder that results from merging is strictly ordered (422 DEADLINE_BAND_THRESHOLDS_INVALID, naming the level). The extra reminder days are strictly decreasing, at most
 * six, and none below the official red line (a reminder that comes after the deadline's last official point is a later warning). A source whose official green line is open (null) takes no personal green line: that would start green later.
 */
export function assertPersonalPreference(official: BandThresholds, input: PersonalPreference): BandThresholds {
  const levels: Array<keyof BandThresholds> = ['green_days', 'yellow_days', 'red_days'];
  for (const level of levels) {
    const value = input[level];
    if (value === null) continue;
    const [min, max] = LEVEL_RANGE[level];
    if (!Number.isInteger(value) || value < min || value > max) throw bad('DEADLINE_BAND_THRESHOLDS_INVALID', level);
  }
  for (const level of levels) {
    const value = input[level];
    if (value === null) continue;
    const line = official[level];
    if (line === null || value < line) throw bad('DEADLINE_PERSONAL_NOT_EARLIER', level);
  }
  const merged: BandThresholds = { green_days: input.green_days ?? official.green_days, yellow_days: input.yellow_days ?? official.yellow_days, red_days: input.red_days ?? official.red_days };
  validateThresholds(merged);
  const reminders = input.reminder_days;
  if (reminders.length > MAX_PERSONAL_REMINDERS) throw bad('DEADLINE_BAND_THRESHOLDS_INVALID', 'reminder_days');
  for (let index = 0; index < reminders.length; index += 1) {
    const value = reminders[index] as number;
    if (!Number.isInteger(value) || value < REMINDER_RANGE[0] || value > REMINDER_RANGE[1] || (index > 0 && value >= (reminders[index - 1] as number))) throw bad('DEADLINE_BAND_THRESHOLDS_INVALID', 'reminder_days');
    if (value < official.red_days) throw bad('DEADLINE_PERSONAL_NOT_EARLIER', 'reminder_days');
  }
  return merged;
}

/** The levels of a stored preference that are later than the official ones now (the official rule moved after the person saved): they are raised to the official line when read and named, never silently dropped. */
export function clampedLevels(official: BandThresholds, stored: PersonalThresholds): Array<keyof BandThresholds> {
  return mergePersonal(official, stored).clamped as Array<keyof BandThresholds>;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Reminders and escalation.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ReminderPointsInput {
  dueOn: string;
  unit: DeadlineUnit;
  calendars?: WorkCalendarSource | undefined;
  reminderDays: readonly number[];
}

const workedOn = (calendars: WorkCalendarSource, day: number): boolean | undefined => {
  const text = dayText(day);
  const calendar = calendars.forYear(Number(text.slice(0, 4)));
  return calendar === undefined ? undefined : isWorkingDay(calendar, text);
};

/** The working day that is `count` working days before `due` (0: the deadline or, when it is not worked, the last working day before it); null when a year on the way has no calendar. */
function workingDayBefore(calendars: WorkCalendarSource, due: number, count: number): string | null {
  let remaining = 0;
  for (let cursor = due, steps = 0; steps <= MAX_SCAN_DAYS; cursor -= 1, steps += 1) {
    const worked = workedOn(calendars, cursor);
    if (worked === undefined) return null;
    if (remaining === count && worked) return dayText(cursor);
    if (worked) remaining += 1;
  }
  return null;
}

/** The working day that is `count` working days after `due`; null when a year on the way has no calendar. */
function workingDayAfter(calendars: WorkCalendarSource, due: number, count: number): string | null {
  let counted = 0;
  for (let cursor = due + 1; cursor <= due + MAX_SCAN_DAYS; cursor += 1) {
    const worked = workedOn(calendars, cursor);
    if (worked === undefined) return null;
    if (!worked) continue;
    counted += 1;
    if (counted === count) return dayText(cursor);
  }
  return null;
}

/**
 * The day of each reminder, in the order of `reminderDays`: `dueOn` minus N days for calendar days; for working days the working day N working days before the deadline (after it for a negative N), null when it cannot be placed because
 * a year on the way has no published calendar. A reminder is placed on a worked day so that nobody is reminded on a holiday.
 */
export function reminderPoints(input: ReminderPointsInput): Array<string | null> {
  dayField(input.dueOn, 'due_on');
  const due = dayNumber(input.dueOn);
  return input.reminderDays.map((count) => {
    if (input.unit === 'CALENDAR') return dayText(due - count);
    if (input.calendars === undefined) return null;
    return count >= 0 ? workingDayBefore(input.calendars, due, count) : workingDayAfter(input.calendars, due, -count);
  });
}

export interface DueRemindersInput {
  /** The days remaining at the last evaluation, null when the task was never evaluated. */
  previousRemaining: number | null;
  remaining: number;
  reminderDays: readonly number[];
}

/** The reminders crossed since the last evaluation, each named by its value (the idempotency key of the reminder: a value is sent once per task and version of the schedule). */
export function dueReminders(input: DueRemindersInput): number[] {
  return input.reminderDays.filter((value) => input.remaining <= value && (input.previousRemaining === null || input.previousRemaining > value));
}

/** Whether a task that is overdue has been overdue for the days the rule names, so that its manager is told. */
export function shouldEscalate(input: { remaining: number | null; escalateAfterOverdueDays: number | null }): boolean {
  if (input.remaining === null || input.escalateAfterOverdueDays === null) return false;
  return input.remaining < 0 && -input.remaining >= input.escalateAfterOverdueDays;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const AS_OF = '2026-11-12';
/** The first review day of the built-in alert types (the same day as ALERT_TYPE_FIRST_REVIEW_ON of governance-rules.ts, which this module cannot import). */
const ALERT_FIRST_REVIEW_ON = '2027-05-08';

const alertParams = (owner: string, action: string, consequence: string, why: string, hours: number, severity: 'WATCH' | 'ACTION'): Record<string, unknown> => ({
  source: 'PROJECT_TASK',
  owner,
  expected_action: action,
  consequence,
  response_hours: hours,
  default_severity: severity,
  reason_to_exist: why,
  review_on: ALERT_FIRST_REVIEW_ON,
  enabled: true,
});

const defaultParams = (unit: DeadlineUnit, ladder: { green?: number; yellow: number; red: number }, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  unit,
  ...(ladder.green === undefined ? {} : { green_days: ladder.green }),
  yellow_days: ladder.yellow,
  red_days: ladder.red,
  overrides: [],
  reminder_days: [],
  ...extra,
});

/** Registers the rule type `DEADLINE_BAND_POLICY` with the three built-in codes, and the three alert types of the project tasks under `ALERT_TYPE`. Called by the registry of governance-rules.ts. */
export function registerDeadlineBandRules(registry: RuleRegistry): void {
  registry.registerRuleType({
    type: DEADLINE_BAND_RULE_TYPE,
    ownerModule: 'PWF',
    modules: ['PWF', 'HOME', 'ADM'],
    formula: T.rule_formula,
    source: T.rule_source,
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: POLICY_SCHEMA,
    refine: policyDefect,
    defaults: {
      HOME_WORK: { params: defaultParams('CALENDAR', { yellow: 7, red: -1 }), formula: T.home_work_formula, source: T.default_source_legacy },
      REPORT_SCHEDULE: { params: defaultParams('CALENDAR', { yellow: 3, red: -1 }), formula: T.report_schedule_formula, source: T.default_source_legacy },
      PROJECT_TASK: {
        params: defaultParams('WORKING', { green: 5, yellow: 2, red: 0 }, { reminder_days: [5, 2, 0, -1], escalate_after_overdue_days: 3 }),
        formula: T.project_task_formula,
        source: T.default_source_project_task,
      },
    },
  });
  registry.registerRuleDefaults('ALERT_TYPE', {
    PWF_TASK_DUE_SOON: { params: alertParams('TASK_ASSIGNEE', T.due_soon_action, T.due_soon_consequence, T.due_soon_why, 24, 'WATCH'), source: T.alert_source, asOf: AS_OF, legalStatus: 'VERIFIED' },
    PWF_TASK_OVERDUE: { params: alertParams('TASK_ASSIGNEE', T.overdue_action, T.overdue_consequence, T.overdue_why, 24, 'ACTION'), source: T.alert_source, asOf: AS_OF, legalStatus: 'VERIFIED' },
    PWF_MILESTONE_AT_RISK: { params: alertParams('PROJECT_MANAGER', T.milestone_action, T.milestone_consequence, T.milestone_why, 48, 'ACTION'), source: T.alert_source, asOf: AS_OF, legalStatus: 'VERIFIED' },
  });
}
