import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import { MAX_DAYS, OWNER_EXAMPLE, reminderList, reminderProblem } from '../bands/band-model';
import type { Thresholds } from '../bands/band-model';
import type { Band, TaskBand } from '../model';

/** The pure side of the personal reminders (PWF-15): the form as text, the checks that mirror the server, the colour of a number of days left, and the days the preview shows (BR-PWF-20, BR-PWF-23, R40). */

type Schemas = components['schemas'];

export type PreferenceBody = Schemas['PwfDeadlinePreference'];
export type MyTaskPage = Schemas['PwfMyTaskPage'];
export type MyTask = MyTaskPage['items'][number];

/** The three levels of the ladder, by the name the contract gives them. */
export type Level = 'green_days' | 'yellow_days' | 'red_days';
export const LEVELS: readonly Level[] = ['green_days', 'yellow_days', 'red_days'];

/** The personal reminders are counted in the unit of a project task (BR-PWF-21). */
export const PREFERENCE_UNIT = 'WORKING';

/** What the person set, with the official ladder in force beside it; a level that is `null` follows the official one. */
export interface PreferenceView {
  green_days: number | null;
  yellow_days: number | null;
  red_days: number | null;
  reminder_days: readonly number[];
  official: Thresholds;
  clamped: readonly Level[];
  /** 0 when nothing was ever saved: the `If-Match` of the first save. */
  version: number;
  as_of: string | null;
}

const isLevel = (value: unknown): value is Level => LEVELS.some((level) => level === value);

/** Reads the answer of the server into one shape; what it leaves out is "nothing set" and the default official ladder (5/2/0). */
export function viewOf(raw: PreferenceBody): PreferenceView {
  return {
    green_days: raw.green_days ?? null,
    yellow_days: raw.yellow_days ?? null,
    red_days: raw.red_days ?? null,
    reminder_days: raw.reminder_days ?? [],
    official: raw.official === undefined ? OWNER_EXAMPLE : { green_days: raw.official.green_days, yellow_days: raw.official.yellow_days, red_days: raw.official.red_days },
    clamped: (raw.clamped ?? []).filter(isLevel),
    version: raw.version ?? 0,
    as_of: raw.as_of ?? null,
  };
}

/** The person follows the official ladder in everything: no level and no reminder of their own. */
export const followsOfficial = (view: Pick<PreferenceView, 'green_days' | 'yellow_days' | 'red_days' | 'reminder_days'>): boolean =>
  view.green_days === null && view.yellow_days === null && view.red_days === null && view.reminder_days.length === 0;

// ---- the form --------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The form as typed: an empty level follows the official one. */
export interface PreferenceForm {
  green: string;
  yellow: string;
  red: string;
  /** The reminder days as typed: "7, 3, 1". */
  reminders: string;
}

export const BLANK_FORM: PreferenceForm = { green: '', yellow: '', red: '', reminders: '' };

const numberText = (value: number | null): string => (value === null ? '' : String(value));

export const formOf = (view: PreferenceView): PreferenceForm => ({ green: numberText(view.green_days), yellow: numberText(view.yellow_days), red: numberText(view.red_days), reminders: view.reminder_days.join(', ') });

export const textOfLevel = (form: PreferenceForm, level: Level): string => (level === 'green_days' ? form.green : level === 'yellow_days' ? form.yellow : form.red);

export function withLevel(form: PreferenceForm, level: Level, text: string): PreferenceForm {
  return level === 'green_days' ? { ...form, green: text } : level === 'yellow_days' ? { ...form, yellow: text } : { ...form, red: text };
}

const same = (a: PreferenceForm, b: PreferenceForm): boolean => a.green.trim() === b.green.trim() && a.yellow.trim() === b.yellow.trim() && a.red.trim() === b.red.trim() && reminderList(a.reminders).join(',') === reminderList(b.reminders).join(',');

/** The form differs from what the server holds (the numbers, not the spaces). */
export const isDirty = (form: PreferenceForm, view: PreferenceView): boolean => !same(form, formOf(view));

const levelNumber = (text: string): number | null => (text.trim() === '' ? null : Number(text));

/** The body the server takes; call it only for a form with no problem. An empty level and an empty list are sent as `null` and `[]` (all of them: the personal setting is cleared). */
export function bodyOf(form: PreferenceForm): PreferenceBody {
  return { green_days: levelNumber(form.green), yellow_days: levelNumber(form.yellow), red_days: levelNumber(form.red), reminder_days: reminderList(form.reminders).map(Number) };
}

// ---- the checks ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type PreferenceProblemKind = 'integer' | 'range' | 'order' | 'notEarlier' | 'listSize' | 'reminderOrder' | 'reminderNotEarlier';
export interface PreferenceProblem {
  path: Level | 'reminder_days';
  kind: PreferenceProblemKind;
  min?: number;
  max?: number;
  /** The official level a "not earlier" refusal compares with. */
  official?: number;
}

const WHOLE = /^-?\d{1,6}$/;
const RANGE: Readonly<Record<Level, readonly [number, number]>> = { green_days: [1, MAX_DAYS], yellow_days: [0, MAX_DAYS], red_days: [-1, MAX_DAYS] };

/** A level the person typed: nothing when it is empty (it follows the official one), else a whole number in the range of the level. */
function levelProblem(level: Level, text: string): PreferenceProblem | undefined {
  const value = text.trim();
  if (value === '') return undefined;
  if (!WHOLE.test(value)) return { path: level, kind: 'integer' };
  const [min, max] = RANGE[level];
  return Number(value) < min || Number(value) > max ? { path: level, kind: 'range', min, max } : undefined;
}

/** The ladder the person gets once their levels are laid over the official one; a level they left empty is the official one. */
export function mergedLadder(form: PreferenceForm, official: Thresholds): Thresholds {
  return { green_days: levelNumber(form.green) ?? official.green_days, yellow_days: levelNumber(form.yellow) ?? official.yellow_days, red_days: levelNumber(form.red) ?? official.red_days };
}

/**
 * What is wrong with the form, as the server will find it: every number whole and in range, the merged ladder in strict order (green above yellow above red, red at least -1, the order is named on the level that breaks it),
 * no personal level later than the official one (BR-PWF-23: warn earlier, never later) and the reminder days strictly decreasing and none below the official red level.
 * When the official green line is not set (everything above yellow is green), any personal green line is accepted here and the server has the last word.
 */
export function problemsOf(form: PreferenceForm, official: Thresholds): PreferenceProblem[] {
  const own = LEVELS.map((level) => levelProblem(level, textOfLevel(form, level)));
  const out: PreferenceProblem[] = own.flatMap((problem) => (problem === undefined ? [] : [problem]));
  const [green, yellow, red] = own;
  const earlier = (level: Level, found: PreferenceProblem | undefined, typed: string, line: number | null): void => {
    if (found === undefined && typed.trim() !== '' && line !== null && Number(typed) < line) out.push({ path: level, kind: 'notEarlier', official: line });
  };
  earlier('green_days', green, form.green, official.green_days);
  earlier('yellow_days', yellow, form.yellow, official.yellow_days);
  earlier('red_days', red, form.red, official.red_days);
  const merged = mergedLadder(form, official);
  if (yellow === undefined && red === undefined && merged.yellow_days <= merged.red_days) out.push({ path: 'yellow_days', kind: 'order' });
  if (green === undefined && yellow === undefined && merged.green_days !== null && merged.green_days <= merged.yellow_days) out.push({ path: 'green_days', kind: 'order' });
  const reminder = reminderProblem(form.reminders);
  if (reminder !== undefined) {
    out.push({ path: 'reminder_days', kind: reminder.kind === 'listSize' ? 'listSize' : reminder.kind === 'reminderOrder' ? 'reminderOrder' : reminder.kind === 'range' ? 'range' : 'integer', ...(reminder.min === undefined ? {} : { min: reminder.min }), ...(reminder.max === undefined ? {} : { max: reminder.max }) });
  } else if (reminderList(form.reminders).some((item) => Number(item) < official.red_days)) {
    out.push({ path: 'reminder_days', kind: 'reminderNotEarlier', official: official.red_days });
  }
  return out;
}

/** The ladder to say, preview and confirm with the server: the merged ladder when the form has no problem with a level, else nothing. */
export function ladderOf(form: PreferenceForm, official: Thresholds): Thresholds | undefined {
  return problemsOf(form, official).some((problem) => problem.path !== 'reminder_days') ? undefined : mergedLadder(form, official);
}

/** Whether the form sets any level of its own (a form that sets none has nothing to preview against the official ladder). */
export const setsLevel = (form: PreferenceForm): boolean => form.green.trim() !== '' || form.yellow.trim() !== '' || form.red.trim() !== '';

// ---- the colour of a number of days left ----------------------------------------------------------------------------------------------------------------------------

/** BR-PWF-20: red at `red_days` and below, yellow up to `yellow_days`, green up to `green_days` (every number above yellow when there is no green line), and "not yet in range" above it. */
export function bandAt(remaining: number, ladder: Thresholds): Band {
  if (remaining <= ladder.red_days) return 'RED';
  if (remaining <= ladder.yellow_days) return 'YELLOW';
  if (ladder.green_days === null || remaining <= ladder.green_days) return 'GREEN';
  return 'NONE';
}

/** The numbers of days left that show where a ladder changes colour: one either side of each line and the first day overdue, so each colour of the ladder appears. */
export function edgeDays(ladder: Thresholds): number[] {
  const days = [ladder.yellow_days + 1, ladder.yellow_days, ladder.red_days + 1, ladder.red_days, ladder.red_days - 1];
  if (ladder.green_days !== null) days.push(ladder.green_days + 1, ladder.green_days);
  return days;
}

export interface PreviewRow {
  days: number;
  official: Band;
  personal: Band;
}

/** The rows of the preview: the days the two ladders change colour at, from the most days left to the most overdue, with the colour each ladder gives. */
export function previewRows(official: Thresholds, personal: Thresholds): PreviewRow[] {
  const days = [...new Set([...edgeDays(official), ...edgeDays(personal)])].sort((a, b) => b - a);
  return days.map((day) => ({ days: day, official: bandAt(day, official), personal: bandAt(day, personal) }));
}

/** The numbers of days left at which the colour the server confirmed is not the colour computed here (none when the two agree). */
export const disagreements = (ladder: Thresholds, examples: readonly { remaining_days: number; band: Band }[]): number[] => examples.filter((example) => bandAt(example.remaining_days, ladder) !== example.band).map((example) => example.remaining_days);

/** The band of a row as the badge takes it (days are in the first column of the table, not in the badge). */
export const rowBand = (band: Band, days: number): TaskBand => ({ band, remaining_days: days, unit: PREFERENCE_UNIT, overdue: days < 0 });

// ---- refusals --------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type PreferenceRefusalKind = 'conflict' | 'order' | 'notEarlier' | 'denied' | 'validation' | 'general';

export interface PreferenceRefusal {
  kind: PreferenceRefusalKind;
  /** The level (or `reminder_days`) the server named. */
  field: Level | 'reminder_days' | undefined;
}

const FIELDS: readonly (Level | 'reminder_days')[] = [...LEVELS, 'reminder_days'];

/** What a refused save was refused for, in the words of this screen. */
export function describeRefusal(error: unknown): PreferenceRefusal {
  if (!(error instanceof ApiError)) return { kind: 'general', field: undefined };
  const field = FIELDS.find((name) => name === error.detail);
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return { kind: 'conflict', field };
    case 'DEADLINE_BAND_THRESHOLDS_INVALID':
      return { kind: 'order', field };
    case 'DEADLINE_PERSONAL_NOT_EARLIER':
      return { kind: 'notEarlier', field };
    case 'SCOPE_DENIED':
      return { kind: 'denied', field };
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
      return { kind: 'validation', field };
    default:
      return { kind: 'general', field };
  }
}

// ---- the tasks of the person ---------------------------------------------------------------------------------------------------------------------------------------------

/** The task has a colour of its own for the person that differs from the official one: only then is the personal colour shown (R40), under the official one. */
export const showsPersonal = (task: Pick<MyTask, 'official_band' | 'personal_band'>): boolean => task.personal_band !== null && task.personal_band.band !== task.official_band.band;

/** How many tasks the first page asks for. */
export const MY_TASKS_PAGE = 20;
