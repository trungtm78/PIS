import { ApiError } from '@machvon/api-client';

/** Permission of both commands of ADM-07 (x-permission in openapi.json): a draft and its publication. */
export const MANAGE_CALENDAR_PERMISSION = 'adm.calendar.manage';

export const MIN_YEAR = 2020;
export const MAX_YEAR = 2100;
export const CODE_MAX_LENGTH = 40;
export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 2000;
/** ISO weekdays, 1 = Monday to 7 = Sunday, as `working_days` of the contract numbers them. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const WEEK_LENGTH = 7;

export type CalendarStatus = 'Draft' | 'Published' | 'Superseded';
const STATUSES: readonly string[] = ['Draft', 'Published', 'Superseded'];

export interface HolidayView {
  date: string;
  name: string;
  legalBasis: string | null;
}

/** One working calendar version as the version reads of ADM-07 return it: one year of one calendar. */
export interface CalendarView {
  id: string;
  calendarCode: string;
  year: number;
  revision: number;
  workingDays: number[];
  holidays: HolidayView[];
  compensatedWorkdays: string[];
  legalBasis: string;
  status: CalendarStatus;
  createdBy: string;
  publishedBy: string | null;
  publishedAt: string | null;
  version: number;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
const numbers = (value: unknown): number[] => (Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : []);

function toHoliday(raw: unknown): HolidayView[] {
  if (!isRecord(raw) || typeof raw.date !== 'string') return [];
  return [{ date: raw.date, name: text(raw.name), legalBasis: textOrNull(raw.legal_basis_ref) }];
}

/** Reads one row of a version read; a row without an id is not a version. */
export function toCalendar(raw: unknown): CalendarView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    calendarCode: text(raw.calendar_code),
    year: count(raw.year),
    revision: count(raw.revision),
    workingDays: numbers(raw.working_days),
    holidays: Array.isArray(raw.holidays) ? raw.holidays.flatMap(toHoliday) : [],
    compensatedWorkdays: strings(raw.compensated_workdays),
    legalBasis: text(raw.legal_basis_ref),
    status: STATUSES.includes(text(raw.status)) ? (raw.status as CalendarStatus) : 'Draft',
    createdBy: text(raw.created_by),
    publishedBy: textOrNull(raw.published_by),
    publishedAt: textOrNull(raw.published_at),
    version: count(raw.version),
  };
}

export interface HolidayValue {
  date: string;
  name: string;
  basis: string;
}

/** What the form holds: the year as typed, the days marked on the month grids. */
export interface CalendarValues {
  calendarCode: string;
  year: string;
  workingDays: number[];
  legalBasis: string;
  holidays: HolidayValue[];
  compensated: string[];
}

export function emptyValues(year: number): CalendarValues {
  return { calendarCode: '', year: String(year), workingDays: [...DEFAULT_WORKING_DAYS], legalBasis: '', holidays: [], compensated: [] };
}

/** The form filled from a version, to write the next revision of it. */
export function valuesOfCalendar(view: CalendarView): CalendarValues {
  return {
    calendarCode: view.calendarCode,
    year: String(view.year),
    workingDays: [...view.workingDays],
    legalBasis: view.legalBasis,
    holidays: view.holidays.map((holiday) => ({ date: holiday.date, name: holiday.name, basis: holiday.legalBasis ?? '' })),
    compensated: [...view.compensatedWorkdays],
  };
}

export type CalendarField = 'calendarCode' | 'year' | 'workingDays' | 'legalBasis' | 'holidays';
export type FieldProblem = 'required' | 'tooLong' | 'range' | 'pattern' | 'nameRequired';
export type CalendarErrors = Partial<Record<CalendarField, FieldProblem>>;

/** The rules the server also states in `validateWorkCalendar` that the form can check before anything is sent. */
export function validateCalendar(values: CalendarValues): CalendarErrors {
  const errors: CalendarErrors = {};
  const code = values.calendarCode.trim();
  if (code === '') errors.calendarCode = 'required';
  else if (code.length > CODE_MAX_LENGTH) errors.calendarCode = 'tooLong';
  else if (!CODE_PATTERN.test(code)) errors.calendarCode = 'pattern';
  const year = Number(values.year);
  if (values.year.trim() === '') errors.year = 'required';
  else if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) errors.year = 'range';
  if (values.workingDays.length === 0) errors.workingDays = 'required';
  if (values.legalBasis.trim() === '') errors.legalBasis = 'required';
  if (values.holidays.some((holiday) => holiday.name.trim() === '')) errors.holidays = 'nameRequired';
  return errors;
}

/** The request body of `createWorkCalendarVersion`; holidays in date order, so the same marks always give the same body. */
export function calendarBody(values: CalendarValues) {
  return {
    calendar_code: values.calendarCode.trim(),
    year: Number(values.year),
    working_days: [...values.workingDays].sort((a, b) => a - b),
    holidays: [...values.holidays]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((holiday) => ({ date: holiday.date, name: holiday.name.trim(), ...(holiday.basis.trim() === '' ? {} : { legal_basis_ref: holiday.basis.trim() }) })),
    compensated_workdays: [...values.compensated].sort(),
    legal_basis_ref: values.legalBasis.trim(),
  };
}

export type DayKind = 'working' | 'off' | 'holiday' | 'compensated';

export interface DayRules {
  workingDays: readonly number[];
  holidays: readonly string[];
  compensated: readonly string[];
}

export interface DayCell {
  date: string;
  day: number;
  kind: DayKind;
}

const pad = (value: number): string => String(value).padStart(2, '0');
const dateOf = (year: number, month: number, day: number): string => `${String(year).padStart(4, '0')}-${pad(month + 1)}-${pad(day)}`;
/** The ISO weekday (1 = Monday to 7 = Sunday) of a month position. */
const isoWeekdayOf = (year: number, month: number, day: number): number => ((new Date(Date.UTC(year, month, day)).getUTCDay() + 6) % WEEK_LENGTH) + 1;
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** The kind of a day: a holiday never works, a compensated day always does, any other day follows the weekdays. */
export function dayKindOf(rules: DayRules, year: number, month: number, day: number): DayKind {
  const date = dateOf(year, month, day);
  if (rules.holidays.includes(date)) return 'holiday';
  if (rules.compensated.includes(date)) return 'compensated';
  return rules.workingDays.includes(isoWeekdayOf(year, month, day)) ? 'working' : 'off';
}

/** A month as weeks of seven cells, Monday first; a cell outside the month is null. */
export function monthWeeks(rules: DayRules, year: number, month: number): Array<Array<DayCell | null>> {
  const lead = isoWeekdayOf(year, month, 1) - 1;
  const cells: Array<DayCell | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= daysInMonth(year, month); day += 1) cells.push({ date: dateOf(year, month, day), day, kind: dayKindOf(rules, year, month, day) });
  while (cells.length % WEEK_LENGTH !== 0) cells.push(null);
  return Array.from({ length: cells.length / WEEK_LENGTH }, (_, week) => cells.slice(week * WEEK_LENGTH, (week + 1) * WEEK_LENGTH));
}

/** How many days of the year are worked under the rules. */
export function countWorkingDays(rules: DayRules, year: number): number {
  let worked = 0;
  for (let month = 0; month < 12; month += 1) {
    for (let day = 1; day <= daysInMonth(year, month); day += 1) {
      const kind = dayKindOf(rules, year, month, day);
      if (kind === 'working' || kind === 'compensated') worked += 1;
    }
  }
  return worked;
}

export const rulesOf = (values: Pick<CalendarValues, 'workingDays' | 'holidays' | 'compensated'>): DayRules => ({
  workingDays: values.workingDays,
  holidays: values.holidays.map((holiday) => holiday.date),
  compensated: values.compensated,
});

export const rulesOfCalendar = (view: CalendarView): DayRules => ({
  workingDays: view.workingDays,
  holidays: view.holidays.map((holiday) => holiday.date),
  compensated: view.compensatedWorkdays,
});

/**
 * What a click on a day does: a worked day becomes a holiday, a day off becomes a compensated working day, and a marked day is
 * cleared. Only a day of the year of the form can be marked.
 */
export function toggleDay(values: CalendarValues, date: string): CalendarValues {
  if (!date.startsWith(`${values.year.trim()}-`)) return values;
  if (values.holidays.some((holiday) => holiday.date === date)) return { ...values, holidays: values.holidays.filter((holiday) => holiday.date !== date) };
  if (values.compensated.includes(date)) return { ...values, compensated: values.compensated.filter((entry) => entry !== date) };
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const worked = values.workingDays.includes(isoWeekdayOf(year, month - 1, day));
  return worked ? { ...values, holidays: [...values.holidays, { date, name: '', basis: '' }] } : { ...values, compensated: [...values.compensated, date] };
}

/** A new year starts without the marks of the old one: a holiday of 2026 is not one of 2027. */
export function withYear(values: CalendarValues, year: string): CalendarValues {
  const prefix = `${year.trim()}-`;
  return {
    ...values,
    year,
    holidays: values.holidays.filter((holiday) => holiday.date.startsWith(prefix)),
    compensated: values.compensated.filter((date) => date.startsWith(prefix)),
  };
}

export function setHolidayField(values: CalendarValues, date: string, field: 'name' | 'basis', value: string): CalendarValues {
  return { ...values, holidays: values.holidays.map((holiday) => (holiday.date === date ? { ...holiday, [field]: value } : holiday)) };
}

export type ProblemReason = 'calendarInvalid' | 'conflict' | 'stage' | 'invalid' | 'notFound' | 'denied' | 'session' | 'general';

/** One finding of a refused calendar: where, and the code the screen has a sentence for. */
export interface Finding {
  field: string;
  code: string;
}

export interface ProblemView {
  reason: ProblemReason;
  /** The findings the server listed for CALENDAR_INVALID (`errors`), in its order. */
  findings: Finding[];
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  CALENDAR_INVALID: 'calendarInvalid',
  VERSION_CONFLICT: 'conflict',
  STAGE_TRANSITION_DENIED: 'stage',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

function findingsOf(error: ApiError): Finding[] {
  const listed = error.extensions.errors;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.field !== 'string' || typeof entry.code !== 'string') return [];
    return [{ field: entry.field, code: entry.code }];
  });
}

/** Maps the error of a command of ADM-07 to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', findings: [] };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', findings: findingsOf(error) };
}
