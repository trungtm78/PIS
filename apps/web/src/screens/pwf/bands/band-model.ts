import type { BandUnit, Priority, TaskKind } from '../model';

/** The pure side of the three-colour policy editor (PWF-08): the form as text, the checks, and the sentence the owner reads ("5 days left: green, 2 days: yellow, under 1 day: red"). */

type Params = Record<string, unknown>;

/** The sources of alerts a policy can be written for; the code of the rule is the code of the source. */
export const SOURCES = ['HOME_WORK', 'REPORT_SCHEDULE', 'PROJECT_TASK'] as const;
export type Source = (typeof SOURCES)[number];

/** The unit each source counts in: calendar days for the work centre and the report schedule, working days for a project task (BR-PWF-21). */
export const SOURCE_UNIT: Readonly<Record<Source, BandUnit>> = { HOME_WORK: 'CALENDAR', REPORT_SCHEDULE: 'CALENDAR', PROJECT_TASK: 'WORKING' };

/** The example of the owner: green from 5 days, yellow from 2, red below 1 (that is, 0 or less). */
export const OWNER_EXAMPLE: Thresholds = { green_days: 5, yellow_days: 2, red_days: 0 };

export const TASK_KINDS: readonly TaskKind[] = ['TASK', 'MILESTONE'];
export const PRIORITIES: readonly Priority[] = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
export const UNITS: readonly BandUnit[] = ['CALENDAR', 'WORKING'];
export const MAX_OVERRIDES = 20;
export const MAX_REMINDERS = 6;
export const MAX_DAYS = 3650;
const PHASE = /^[A-Z][A-Z0-9_]{1,39}$/;

export interface Thresholds {
  green_days: number | null;
  yellow_days: number;
  red_days: number;
}

export interface Ladder {
  green: string;
  yellow: string;
  red: string;
}

export interface OverrideForm {
  task_kind: '' | TaskKind;
  priority: '' | Priority;
  phase: string;
  ladder: Ladder;
}

export interface BandForm {
  unit: BandUnit;
  ladder: Ladder;
  overrides: OverrideForm[];
  /** The reminder days as typed: "5, 2, 0, -1". */
  reminders: string;
  escalate: string;
}

const blankLadder = (): Ladder => ({ green: '', yellow: '', red: '' });
export const blankForm = (unit: BandUnit): BandForm => ({ unit, ladder: blankLadder(), overrides: [], reminders: '', escalate: '' });

// ---- reading and writing the params ----------------------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const numberText = (value: unknown): string => (typeof value === 'number' ? String(value) : '');
const oneOf = <T extends string>(options: readonly T[], value: unknown): T | '' => options.find((option) => option === value) ?? '';

const ladderOfParams = (raw: Record<string, unknown>): Ladder => ({ green: numberText(raw.green_days), yellow: numberText(raw.yellow_days), red: numberText(raw.red_days) });

/** Reads the params of a `DEADLINE_BAND_POLICY` rule into the text a form holds; what is not there is left empty. */
export function formOf(params: unknown): BandForm {
  if (!isRecord(params)) return blankForm('CALENDAR');
  const overrides = (Array.isArray(params.overrides) ? params.overrides : []).filter(isRecord).map((raw): OverrideForm => {
    const match = isRecord(raw.match) ? raw.match : {};
    return { task_kind: oneOf(TASK_KINDS, match.task_kind), priority: oneOf(PRIORITIES, match.priority), phase: typeof match.phase === 'string' ? match.phase : '', ladder: ladderOfParams(raw) };
  });
  return {
    unit: params.unit === 'WORKING' ? 'WORKING' : 'CALENDAR',
    ladder: ladderOfParams(params),
    overrides,
    reminders: (Array.isArray(params.reminder_days) ? params.reminder_days.filter((value): value is number => typeof value === 'number') : []).join(', '),
    escalate: numberText(params.escalate_after_overdue_days),
  };
}

const ladderParams = (ladder: Ladder): Params => ({ ...(ladder.green.trim() === '' ? {} : { green_days: Number(ladder.green) }), yellow_days: Number(ladder.yellow), red_days: Number(ladder.red) });

const reminderList = (text: string): string[] => text.split(/[\s,;]+/).filter((item) => item !== '');

/** The params the rule store keeps; call it only for a form with no problem. */
export function paramsOf(form: BandForm): Params {
  return {
    unit: form.unit,
    ...ladderParams(form.ladder),
    overrides: form.overrides.map((override) => ({
      match: { ...(override.task_kind === '' ? {} : { task_kind: override.task_kind }), ...(override.priority === '' ? {} : { priority: override.priority }), ...(override.phase.trim() === '' ? {} : { phase: override.phase.trim() }) },
      ...ladderParams(override.ladder),
    })),
    reminder_days: reminderList(form.reminders).map(Number),
    ...(form.escalate.trim() === '' ? {} : { escalate_after_overdue_days: Number(form.escalate) }),
  };
}

export function addOverride(form: BandForm): BandForm {
  if (form.overrides.length >= MAX_OVERRIDES) return form;
  return { ...form, overrides: [...form.overrides, { task_kind: '', priority: '', phase: '', ladder: blankLadder() }] };
}

export const updateOverride = (form: BandForm, index: number, patch: Partial<OverrideForm>): BandForm => ({ ...form, overrides: form.overrides.map((override, at) => (at === index ? { ...override, ...patch } : override)) });
export const removeOverride = (form: BandForm, index: number): BandForm => ({ ...form, overrides: form.overrides.filter((_, at) => at !== index) });

// ---- the checks --------------------------------------------------------------------------------------------------------------------------------------------------------------

export type BandProblemKind = 'required' | 'integer' | 'range' | 'order' | 'unitMismatch' | 'phase' | 'listSize' | 'reminderOrder';
export interface BandProblem {
  path: string;
  kind: BandProblemKind;
  min?: number;
  max?: number;
}

const WHOLE = /^-?\d{1,6}$/;

/** A whole number in a range; the empty text is `required` when the field is, and nothing when it is optional. */
function wholeProblem(path: string, text: string, min: number, max: number, optional = false): BandProblem | undefined {
  const value = text.trim();
  if (value === '') return optional ? undefined : { path, kind: 'required' };
  if (!WHOLE.test(value)) return { path, kind: 'integer' };
  return Number(value) < min || Number(value) > max ? { path, kind: 'range', min, max } : undefined;
}

/** The ladder: green (optional) above yellow above red, red at least -1 (-1 is red only once overdue). */
function ladderProblems(prefix: string, ladder: Ladder): BandProblem[] {
  const green = wholeProblem(`${prefix}green_days`, ladder.green, 1, MAX_DAYS, true);
  const yellow = wholeProblem(`${prefix}yellow_days`, ladder.yellow, 0, MAX_DAYS);
  const red = wholeProblem(`${prefix}red_days`, ladder.red, -1, MAX_DAYS);
  const found = [green, yellow, red].flatMap((problem) => (problem === undefined ? [] : [problem]));
  const order: BandProblem[] = [];
  if (yellow === undefined && red === undefined && Number(ladder.yellow) <= Number(ladder.red)) order.push({ path: `${prefix}yellow_days`, kind: 'order' });
  if (green === undefined && yellow === undefined && ladder.green.trim() !== '' && Number(ladder.green) <= Number(ladder.yellow)) order.push({ path: `${prefix}green_days`, kind: 'order' });
  return [...found, ...order];
}

function reminderProblem(text: string): BandProblem | undefined {
  const items = reminderList(text);
  if (items.some((item) => !WHOLE.test(item))) return { path: 'reminder_days', kind: 'integer' };
  if (items.length > MAX_REMINDERS) return { path: 'reminder_days', kind: 'listSize', max: MAX_REMINDERS };
  const numbers = items.map(Number);
  if (numbers.some((value) => value < -30 || value > 365)) return { path: 'reminder_days', kind: 'range', min: -30, max: 365 };
  return numbers.some((value, index) => index > 0 && value >= (numbers[index - 1] as number)) ? { path: 'reminder_days', kind: 'reminderOrder' } : undefined;
}

/** What is wrong with the form, by the path of the field in the params. */
export function problemsOf(form: BandForm, source: Source): BandProblem[] {
  const out: BandProblem[] = [];
  if (form.unit !== SOURCE_UNIT[source]) out.push({ path: 'unit', kind: 'unitMismatch' });
  out.push(...ladderProblems('', form.ladder));
  form.overrides.forEach((override, index) => {
    if (override.phase.trim() !== '' && !PHASE.test(override.phase.trim())) out.push({ path: `overrides[${index}].phase`, kind: 'phase' });
    out.push(...ladderProblems(`overrides[${index}].`, override.ladder));
  });
  const reminder = reminderProblem(form.reminders);
  if (reminder !== undefined) out.push(reminder);
  const escalate = wholeProblem('escalate_after_overdue_days', form.escalate, 1, 365, true);
  if (escalate !== undefined) out.push(escalate);
  return out;
}

// ---- the preview --------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The ladder of the policy when it is good, else nothing (the preview is not asked for a ladder that cannot be). */
export function thresholdsOf(form: BandForm): Thresholds | undefined {
  if (ladderProblems('', form.ladder).length > 0) return undefined;
  return { green_days: form.ladder.green.trim() === '' ? null : Number(form.ladder.green), yellow_days: Number(form.ladder.yellow), red_days: Number(form.ladder.red) };
}

export interface Sentence {
  green: { kind: 'upTo'; days: number } | { kind: 'moreThan'; days: number };
  yellow: { days: number };
  red: { kind: 'under'; days: number } | { kind: 'overdue' };
}

/** The ladder in the owner's words: green from `green_days` (or from more than the yellow line when there is none), yellow from `yellow_days`, red below one day more than the red line. */
export function sentenceOf(thresholds: Thresholds): Sentence {
  return {
    green: thresholds.green_days === null ? { kind: 'moreThan', days: thresholds.yellow_days } : { kind: 'upTo', days: thresholds.green_days },
    yellow: { days: thresholds.yellow_days },
    red: thresholds.red_days + 1 <= 0 ? { kind: 'overdue' } : { kind: 'under', days: thresholds.red_days + 1 },
  };
}
