import { LUNAR_DAYS, LUNAR_HOLIDAYS, MAKE_UP_NAME, SOLAR_HOLIDAYS, SOURCE_NAME, VERIFIED } from './holiday-catalogue';
import type { CalendarValues, CalendarView, DayRules, HolidayValue } from './model';
import { MAX_YEAR, MIN_YEAR, daysInMonth, dayKindOf, isoWeekdayOfDate } from './model';

/**
 * The pure side of the yearly calendar (ADM-07): the days a person adds by range, the table of special days they see (grouped by month), the weekly rest days, the working days of each month, the year list with its state,
 * and the preset of the statutory holidays of a year. The shape sent to the server does not change: a holiday is a dated name, a compensated working day is a date.
 */

/** The code of the calendar every deadline of a project is counted on (the server reads only this one for a real deadline); the form starts from it. */
export const DEFAULT_CALENDAR_CODE = 'WORKDAY_VN';

/** A range of days is added in one go up to this many days (the longest break of a year is the Tết one of nine or ten days). */
export const MAX_RANGE_DAYS = 60;

const DAY_MS = 86_400_000;

export const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const moment = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(moment.getTime()) && moment.toISOString().slice(0, 10) === value;
};

export const addDays = (date: string, days: number): string => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);

/** Every date from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let date = from; date <= to && out.length <= MAX_RANGE_DAYS + 1; date = addDays(date, 1)) out.push(date);
  return out;
}

// ---- weekly rest days ------------------------------------------------------------------------------------------------------------------------------------------

/** The weekdays (ISO, 1 = Monday) the calendar does not work. */
export const restDaysOf = (workingDays: readonly number[]): number[] => [1, 2, 3, 4, 5, 6, 7].filter((weekday) => !workingDays.includes(weekday));

export const toggleRestDay = (values: CalendarValues, weekday: number): CalendarValues => ({
  ...values,
  workingDays: values.workingDays.includes(weekday) ? values.workingDays.filter((one) => one !== weekday) : [...values.workingDays, weekday].sort((a, b) => a - b),
});

// ---- the special days --------------------------------------------------------------------------------------------------------------------------------------------

export type SpecialKind = 'off' | 'work';

/** One row of the table of special days: a day or a run of days of one kind that carry the same note. */
export interface SpecialEntry {
  id: string;
  kind: SpecialKind;
  from: string;
  to: string;
  dates: string[];
  name: string;
  basis: string;
}

/** The special days of the form as rows: holidays with the same name and basis on consecutive days make one row, so does a run of compensated working days. */
export function specialEntries(values: Pick<CalendarValues, 'holidays' | 'compensated'>): SpecialEntry[] {
  const out: SpecialEntry[] = [];
  for (const holiday of [...values.holidays].sort((a, b) => a.date.localeCompare(b.date))) {
    const last = [...out].reverse().find((entry) => entry.kind === 'off');
    if (last !== undefined && last.name === holiday.name && last.basis === holiday.basis && addDays(last.to, 1) === holiday.date) {
      last.to = holiday.date;
      last.dates.push(holiday.date);
    } else out.push({ id: `off:${holiday.date}`, kind: 'off', from: holiday.date, to: holiday.date, dates: [holiday.date], name: holiday.name, basis: holiday.basis });
  }
  let run: SpecialEntry | undefined;
  for (const date of [...values.compensated].sort()) {
    if (run !== undefined && addDays(run.to, 1) === date) {
      run.to = date;
      run.dates.push(date);
    } else {
      run = { id: `work:${date}`, kind: 'work', from: date, to: date, dates: [date], name: '', basis: '' };
      out.push(run);
    }
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind));
}

export interface MonthGroup {
  /** 1 to 12. */
  month: number;
  entries: SpecialEntry[];
}

/** The rows grouped by the month their first day falls in. */
export function groupByMonth(entries: readonly SpecialEntry[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const entry of entries) {
    const month = Number(entry.from.slice(5, 7));
    const last = groups[groups.length - 1];
    if (last !== undefined && last.month === month) last.entries.push(entry);
    else groups.push({ month, entries: [entry] });
  }
  return groups;
}

export interface SpecialInput {
  kind: SpecialKind;
  from: string;
  /** Empty for a single day. */
  to: string;
  name: string;
  basis: string;
}

export type SpecialProblem = 'dateRequired' | 'dateInvalid' | 'rangeOrder' | 'outOfYear' | 'tooLong' | 'nameRequired';

/** What is wrong with the days a person asks to add, before anything is added; undefined when it can be added. */
export function specialProblem(year: number, input: SpecialInput): SpecialProblem | undefined {
  const to = input.to.trim() === '' ? input.from : input.to;
  if (input.from.trim() === '') return 'dateRequired';
  if (!isIsoDate(input.from) || !isIsoDate(to)) return 'dateInvalid';
  if (to < input.from) return 'rangeOrder';
  if (!input.from.startsWith(`${year}-`) || !to.startsWith(`${year}-`)) return 'outOfYear';
  if (datesBetween(input.from, to).length > MAX_RANGE_DAYS) return 'tooLong';
  if (input.kind === 'off' && input.name.trim() === '') return 'nameRequired';
  return undefined;
}

export interface AddResult {
  values: CalendarValues;
  added: number;
  /** Compensated days refused because the day is an ordinary working day. */
  skippedWorking: number;
  /** Compensated days refused because the day is a holiday of the calendar. */
  skippedHoliday: number;
}

/**
 * Adds the days of the input. A day off replaces whatever the day was (a day cannot be a holiday and a compensated working day); a compensated working day is only accepted on a day the week does not work and that is not a
 * holiday, because the server refuses the others (COMPENSATED_ALREADY_WORKING, COMPENSATED_ON_HOLIDAY).
 */
export function addSpecial(values: CalendarValues, input: SpecialInput): AddResult {
  const dates = datesBetween(input.from, input.to.trim() === '' ? input.from : input.to);
  let holidays = [...values.holidays];
  let compensated = [...values.compensated];
  let added = 0;
  let skippedWorking = 0;
  let skippedHoliday = 0;
  for (const date of dates) {
    if (input.kind === 'off') {
      holidays = [...holidays.filter((holiday) => holiday.date !== date), { date, name: input.name.trim(), basis: input.basis.trim() }];
      compensated = compensated.filter((one) => one !== date);
      added += 1;
    } else if (holidays.some((holiday) => holiday.date === date)) skippedHoliday += 1;
    else if (values.workingDays.includes(isoWeekdayOfDate(date))) skippedWorking += 1;
    else {
      if (!compensated.includes(date)) compensated = [...compensated, date];
      added += 1;
    }
  }
  return { values: { ...values, holidays, compensated }, added, skippedWorking, skippedHoliday };
}

export const removeEntry = (values: CalendarValues, entry: SpecialEntry): CalendarValues =>
  entry.kind === 'off' ? { ...values, holidays: values.holidays.filter((holiday) => !entry.dates.includes(holiday.date)) } : { ...values, compensated: values.compensated.filter((date) => !entry.dates.includes(date)) };

/** The note or the basis of a row of holidays, written onto every day of the row. */
export const setEntryText = (values: CalendarValues, entry: SpecialEntry, field: 'name' | 'basis', text: string): CalendarValues => ({
  ...values,
  holidays: values.holidays.map((holiday) => (entry.dates.includes(holiday.date) ? { ...holiday, [field]: text } : holiday)),
});

// ---- the working days of each month -----------------------------------------------------------------------------------------------------------------------

/** The working days (worked weekdays and compensated days) of each of the twelve months. */
export function workingDaysByMonth(rules: DayRules, year: number): number[] {
  return Array.from({ length: 12 }, (_, month) => {
    let worked = 0;
    for (let day = 1; day <= daysInMonth(year, month); day += 1) {
      const kind = dayKindOf(rules, year, month, day);
      if (kind === 'working' || kind === 'compensated') worked += 1;
    }
    return worked;
  });
}

// ---- the preset of the statutory holidays ----------------------------------------------------------------------------------------------------------------------

/** What the preset writes as the legal basis of the year: the source, and that nobody has compared it with the notice of the year. */
export const presetBasis = (year: number): string => `${SOURCE_NAME}; thông báo nghỉ lễ năm ${year} (danh mục nạp sẵn, chưa kiểm chứng)`;

export interface PresetResult {
  values: CalendarValues;
  /** Days put into the draft (new holidays and make-up days); a day that was already a holiday is left as it was. */
  added: number;
  /** Holidays of the Labour Code the catalogue has no day for in this year (the lunar ones of a year it does not list): the person adds them by hand. */
  missing: string[];
  verified: boolean;
}

/**
 * Fills the statutory holidays of the year into the draft without overwriting what the person already wrote, and makes up on the next working day each holiday that falls on a weekly rest day (Điều 112 khoản 2). The legal basis of
 * the year is filled in when it is empty. The result is still only a draft: it is edited, saved and confirmed like any other.
 */
export function applyPreset(values: CalendarValues): PresetResult {
  const year = Number(values.year);
    const wanted: HolidayValue[] = [];
  for (const rule of SOLAR_HOLIDAYS) {
    const anchor = `${year}-${String(rule.month).padStart(2, '0')}-${String(rule.day).padStart(2, '0')}`;
    for (const offset of rule.offsets) wanted.push({ date: addDays(anchor, offset), name: rule.name, basis: SOURCE_NAME });
  }
  const missing: string[] = [];
  for (const rule of LUNAR_HOLIDAYS) {
    const anchor = LUNAR_DAYS[year]?.[rule.anchor];
    if (anchor === undefined) missing.push(rule.name);
    else for (const offset of rule.offsets) wanted.push({ date: addDays(anchor, offset), name: rule.name, basis: SOURCE_NAME });
  }
  const holidays = [...values.holidays];
  const fresh = new Set<string>();
  let added = 0;
  for (const holiday of wanted.sort((a, b) => a.date.localeCompare(b.date))) {
    if (!holiday.date.startsWith(`${year}-`) || holidays.some((one) => one.date === holiday.date)) continue;
    holidays.push(holiday);
    fresh.add(holiday.date);
    added += 1;
  }
  // A holiday the preset has just added on a weekly rest day is made up on the next working day that is not a holiday already (a second run adds nothing, so it makes up nothing).
  const compensated = values.compensated.filter((date) => !holidays.some((holiday) => holiday.date === date));
  for (const holiday of [...holidays].sort((a, b) => a.date.localeCompare(b.date))) {
    if (holiday.name.startsWith(MAKE_UP_NAME) || values.workingDays.includes(isoWeekdayOfDate(holiday.date))) continue;
    if (!fresh.has(holiday.date)) continue;
    let day = addDays(holiday.date, 1);
    while (day.startsWith(`${year}-`) && (!values.workingDays.includes(isoWeekdayOfDate(day)) || holidays.some((one) => one.date === day))) day = addDays(day, 1);
    if (!day.startsWith(`${year}-`)) continue;
    holidays.push({ date: day, name: `${MAKE_UP_NAME} ${holiday.name}`, basis: `${SOURCE_NAME}, khoản 2` });
    added += 1;
  }
  return { values: { ...values, holidays, compensated, legalBasis: values.legalBasis.trim() === '' ? presetBasis(year) : values.legalBasis }, added, missing, verified: VERIFIED };
}

// ---- the year list -----------------------------------------------------------------------------------------------------------------------------------------------------

export interface YearRow {
  code: string;
  year: number;
  /** Every version of the year, newest revision first. */
  versions: CalendarView[];
  /** The version in force (confirmed). */
  confirmed: CalendarView | undefined;
  /** The draft that can still be confirmed: the newest draft, and only when no later revision was confirmed or replaced (the server refuses a stale draft). */
  draft: CalendarView | undefined;
}

/**
 * One row for every year of every calendar the tenant has, and an empty row for each of `extraYears` that has none under `code`. The newest year first; a year of several calendars lists the default calendar first.
 */
export function yearRows(versions: readonly CalendarView[], code: string, extraYears: readonly number[]): YearRow[] {
  const groups = new Map<string, CalendarView[]>();
  for (const version of versions) groups.set(`${version.calendarCode}|${version.year}`, [...(groups.get(`${version.calendarCode}|${version.year}`) ?? []), version]);
  for (const year of extraYears) if (!groups.has(`${code}|${year}`)) groups.set(`${code}|${year}`, []);
  const rows: YearRow[] = [...groups.entries()].map(([key, group]) => {
    const [calendarCode = code, yearText = '0'] = key.split('|');
    const all = [...group].sort((a, b) => b.revision - a.revision);
    const settled = Math.max(0, ...all.filter((one) => one.status !== 'Draft').map((one) => one.revision));
    return { code: calendarCode, year: Number(yearText), versions: all, confirmed: all.find((one) => one.status === 'Published'), draft: all.find((one) => one.status === 'Draft' && one.revision > settled) };
  });
  return rows.sort((a, b) => b.year - a.year || Number(b.code === code) - Number(a.code === code) || a.code.localeCompare(b.code));
}

/** The version a year opens on: its draft, else the version in force, else nothing (a blank calendar). */
export const openingVersion = (row: YearRow): CalendarView | undefined => row.draft ?? row.confirmed;

export const isYearInRange = (year: number): boolean => Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
