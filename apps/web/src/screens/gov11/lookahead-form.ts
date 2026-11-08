/**
 * The rules of the form that creates a look-ahead plan and of the form that raises a constraint (G1-19). They are the same rules the server applies (kernel `assertWindow`, `assertItems` and the constraint checks of the
 * store), written here so that the person is told before sending; the server stays the authority and a refusal is still shown. All days are Vietnam calendar days `YYYY-MM-DD`; nothing here reads the clock.
 */

export const MAX_ITEMS = 500;
export const DESCRIPTION_MIN = 3;
export const DESCRIPTION_MAX = 500;
export const RESPONSIBLE_MAX = 200;

/** The part of the rule `LOOK_AHEAD_POLICY` the forms need, as the read of the plan writes it (`rule.params`). */
export interface LookAheadLimits {
  minWeeks: number;
  maxWeeks: number;
  defaultWeeks: number;
  constraintKinds: string[];
}

const FALLBACK_LIMITS: LookAheadLimits = { minWeeks: 2, maxWeeks: 6, defaultWeeks: 3, constraintKinds: ['OTHER'] };

const wholeNumber = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback);

/** The limits of the rule as the API shows them; a field that is missing or not sound falls back to the narrowest values, never to a wider window than the rule. */
export function limitsOf(params: unknown): LookAheadLimits {
  const record = typeof params === 'object' && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  const minWeeks = wholeNumber(record.min_weeks, FALLBACK_LIMITS.minWeeks);
  const maxWeeks = Math.max(minWeeks, wholeNumber(record.max_weeks, FALLBACK_LIMITS.maxWeeks));
  const defaultWeeks = Math.min(maxWeeks, Math.max(minWeeks, wholeNumber(record.default_weeks, FALLBACK_LIMITS.defaultWeeks)));
  const kinds = Array.isArray(record.constraint_kinds) ? record.constraint_kinds.filter((kind): kind is string => typeof kind === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(kind)) : [];
  return { minWeeks, maxWeeks, defaultWeeks, constraintKinds: kinds.includes('OTHER') ? kinds : [...kinds, 'OTHER'] };
}

// -- Days ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The milliseconds of a real calendar day, or undefined for a text that is not one (2026-02-30 is not). */
export function dayMs(day: string): number | undefined {
  const match = DAY.exec(day);
  if (match === null) return undefined;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(at).toISOString().slice(0, 10) === day ? at : undefined;
}

export const addDays = (day: string, days: number): string => new Date((dayMs(day) ?? 0) + days * 86_400_000).toISOString().slice(0, 10);

export const isMonday = (day: string): boolean => {
  const at = dayMs(day);
  return at !== undefined && new Date(at).getUTCDay() === 1;
};

/** The Vietnam calendar day of an instant (the server writes its time in UTC). */
export function vietnamDay(iso: unknown): string | undefined {
  if (typeof iso !== 'string') return undefined;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? undefined : new Date(at + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** The Monday where a new plan starts: the Monday of the week of the day, or the next free one when a plan already covers it (a second plan for a week is refused). */
export function defaultWeekStart(today: string, existing: readonly string[]): string {
  const at = dayMs(today);
  if (at === undefined) return '';
  let candidate = addDays(today, -((new Date(at).getUTCDay() + 6) % 7));
  while (existing.includes(candidate)) candidate = addDays(candidate, 7);
  return candidate;
}

/** The first day after the window, as the server writes it. */
export const windowEndOf = (weekStart: string, weeks: number): string => addDays(weekStart, weeks * 7);

// -- The plan ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ItemRow {
  /** A key that stays with the row while rows are added and removed. */
  key: number;
  description: string;
  plannedStart: string;
  plannedFinish: string;
  responsible: string;
}

export interface PlanForm {
  weekStart: string;
  horizonWeeks: string;
  items: ItemRow[];
}

export const blankRow = (key: number, day = ''): ItemRow => ({ key, description: '', plannedStart: day, plannedFinish: day, responsible: '' });

export type PlanFieldError = 'weekStartInvalid' | 'weekStartNotMonday' | 'horizonOutside' | 'itemsNone' | 'itemsTooMany';
export type ItemFieldError = 'descriptionShort' | 'descriptionLong' | 'startInvalid' | 'finishInvalid' | 'finishBeforeStart' | 'startOutsideWindow' | 'responsibleLong';

export interface PlanProblems {
  plan: Partial<Record<'weekStart' | 'horizon' | 'items', PlanFieldError>>;
  /** By row key. */
  items: Map<number, Partial<Record<'description' | 'plannedStart' | 'plannedFinish' | 'responsible', ItemFieldError>>>;
}

export const noProblems = (problems: PlanProblems): boolean => Object.keys(problems.plan).length === 0 && problems.items.size === 0;

/** What is wrong with the form, field by field: the window within the rule and a Monday, and each item with words, a start not after its finish, and a start inside the window. */
export function planProblems(form: PlanForm, limits: LookAheadLimits): PlanProblems {
  const problems: PlanProblems = { plan: {}, items: new Map() };
  const start = dayMs(form.weekStart);
  if (start === undefined) problems.plan.weekStart = 'weekStartInvalid';
  else if (!isMonday(form.weekStart)) problems.plan.weekStart = 'weekStartNotMonday';
  const weeks = Number(form.horizonWeeks);
  const weeksSound = form.horizonWeeks.trim() !== '' && Number.isInteger(weeks) && weeks >= limits.minWeeks && weeks <= limits.maxWeeks;
  if (!weeksSound) problems.plan.horizon = 'horizonOutside';
  if (form.items.length === 0) problems.plan.items = 'itemsNone';
  else if (form.items.length > MAX_ITEMS) problems.plan.items = 'itemsTooMany';
  const end = start !== undefined && weeksSound ? windowEndOf(form.weekStart, weeks) : undefined;
  for (const row of form.items) {
    const found: Partial<Record<'description' | 'plannedStart' | 'plannedFinish' | 'responsible', ItemFieldError>> = {};
    const words = row.description.trim().length;
    if (words < DESCRIPTION_MIN) found.description = 'descriptionShort';
    else if (row.description.length > DESCRIPTION_MAX) found.description = 'descriptionLong';
    const from = dayMs(row.plannedStart);
    const to = dayMs(row.plannedFinish);
    if (from === undefined) found.plannedStart = 'startInvalid';
    if (to === undefined) found.plannedFinish = 'finishInvalid';
    if (from !== undefined && to !== undefined && from > to) found.plannedFinish = 'finishBeforeStart';
    if (from !== undefined && end !== undefined && (row.plannedStart < form.weekStart || row.plannedStart >= end)) found.plannedStart = 'startOutsideWindow';
    if (row.responsible.length > RESPONSIBLE_MAX) found.responsible = 'responsibleLong';
    if (Object.keys(found).length > 0) problems.items.set(row.key, found);
  }
  return problems;
}

/** The body of the command, from a form that has no problem. A blank responsible is left out (the contract has no null there). */
export function planBody(form: PlanForm): { week_start: string; horizon_weeks: number; items: Array<Record<string, string>> } {
  return {
    week_start: form.weekStart,
    horizon_weeks: Number(form.horizonWeeks),
    items: form.items.map((row) => ({
      description: row.description.trim(),
      planned_start: row.plannedStart,
      planned_finish: row.plannedFinish,
      ...(row.responsible.trim() === '' ? {} : { responsible: row.responsible.trim() }),
    })),
  };
}

/** The rows pasted as lines (one item a line, the fields apart by a tab, a semicolon or a vertical bar: description, start, finish, responsible): the quick way to enter a week of work from a sheet. */
export function rowsFromText(textBlock: string, firstKey: number): ItemRow[] {
  return textBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => {
      const [description = '', plannedStart = '', plannedFinish = '', responsible = ''] = line.split(/\t|;|\|/).map((part) => part.trim());
      return { key: firstKey + index, description, plannedStart, plannedFinish: plannedFinish === '' ? plannedStart : plannedFinish, responsible };
    });
}

// -- The constraint -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ConstraintForm {
  kind: string;
  description: string;
  ownerMembershipId: string;
  dueOn: string;
}

export type ConstraintError = 'kindInvalid' | 'descriptionShort' | 'descriptionLong' | 'dueInvalid';

/** The kind is one of the rule, the words are 3 to 500 characters, and the day (if any) is a real day. */
export function constraintProblems(form: ConstraintForm, limits: LookAheadLimits): Partial<Record<'kind' | 'description' | 'dueOn', ConstraintError>> {
  const found: Partial<Record<'kind' | 'description' | 'dueOn', ConstraintError>> = {};
  if (!limits.constraintKinds.includes(form.kind)) found.kind = 'kindInvalid';
  if (form.description.trim().length < DESCRIPTION_MIN) found.description = 'descriptionShort';
  else if (form.description.length > DESCRIPTION_MAX) found.description = 'descriptionLong';
  if (form.dueOn !== '') {
    if (dayMs(form.dueOn) === undefined) found.dueOn = 'dueInvalid';
  }
  return found;
}

/** A constraint due after the day its item starts cannot make the item ready in time: said as a warning, never refused (the record of a late constraint is what the alert centre needs). */
export const dueAfterStart = (dueOn: string, itemStart: string): boolean => dayMs(dueOn) !== undefined && dayMs(itemStart) !== undefined && dueOn > itemStart;

export function constraintBody(form: ConstraintForm): Record<string, string> {
  return {
    kind: form.kind,
    description: form.description.trim(),
    ...(form.ownerMembershipId === '' ? {} : { owner_membership_id: form.ownerMembershipId }),
    ...(form.dueOn === '' ? {} : { due_on: form.dueOn }),
  };
}
