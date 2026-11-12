import type { operations } from '@machvon/contracts';
import { isDay, monthOf } from '../model';
import type { Band, DeadlineBoard, DeadlineCalendar, MilestoneList, Workload } from '../model';

export type BoardRow = DeadlineBoard['items'][number];
export type CalendarDay = DeadlineCalendar['days'][number];
export type CalendarTask = CalendarDay['tasks'][number];
export type Milestone = MilestoneList['items'][number];
export type Person = Workload['people'][number];

type BoardQuery = NonNullable<operations['getDeadlineBoard']['parameters']['query']>;
type CalendarQuery = NonNullable<operations['getDeadlineCalendar']['parameters']['query']>;

export const VIEWS = ['list', 'calendar', 'milestones', 'workload'] as const;
export type View = (typeof VIEWS)[number];

/** The colours a person can filter by; the two that carry no deadline (none) or no countable deadline (unknown) are not colours of the three-colour ladder. */
export const BAND_FILTERS: readonly Band[] = ['RED', 'YELLOW', 'GREEN', 'UNKNOWN'];
export const STATUS_FILTERS = ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD', 'DONE', 'CANCELLED'] as const;

export const PAGE_SIZE = 50;
export const MILESTONE_DAYS = 30;
export const WORKLOAD_WEEKS = 8;
/** A board read longer ago than this is said to be old (the figures may have moved). */
export const STALE_MINUTES = 30;

export interface Filters {
  band: string;
  phase: string;
  assignee: string;
  unit: string;
  status: string;
  dueFrom: string;
  dueTo: string;
}

export const NO_FILTERS: Filters = { band: '', phase: '', assignee: '', unit: '', status: '', dueFrom: '', dueTo: '' };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (value: string): boolean => MONTH.test(value);

const oneOf = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined => allowed.find((item) => item === value);

/** The filters kept in the address, so a reload or a shared link shows the same board; a value the screen does not know is dropped. */
export function filtersOf(params: URLSearchParams): Filters {
  const day = (name: string): string => {
    const value = params.get(name) ?? '';
    return isDay(value) ? value : '';
  };
  return {
    band: oneOf(params.get('band'), BAND_FILTERS) ?? '',
    phase: params.get('phase') ?? '',
    assignee: params.get('assignee') ?? '',
    unit: params.get('unit') ?? '',
    status: oneOf(params.get('status'), STATUS_FILTERS) ?? '',
    dueFrom: day('from'),
    dueTo: day('to'),
  };
}

const PARAM_OF: Readonly<Record<keyof Filters, string>> = { band: 'band', phase: 'phase', assignee: 'assignee', unit: 'unit', status: 'status', dueFrom: 'from', dueTo: 'to' };

/** The address of a board: the filters that are set, the view when it is not the list and the month when it is not the current one. */
export function paramsOf(filters: Filters, view: View, month: string | undefined): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of Object.keys(PARAM_OF) as (keyof Filters)[]) if (filters[name] !== '') params.set(PARAM_OF[name], filters[name]);
  if (view !== 'list') params.set('view', view);
  if (month !== undefined && isMonth(month)) params.set('month', month);
  return params;
}

export const viewOf = (params: URLSearchParams): View => oneOf(params.get('view'), VIEWS) ?? 'list';

export function appliedCount(filters: Filters): number {
  return Object.values(filters).filter((value) => value !== '').length;
}

const set = <K extends string>(query: Partial<Record<K, string | number>>, name: K, value: string): void => {
  if (value !== '') query[name] = value;
};

/** The query of one page of the board: the filters that are set, the page size and the cursor. */
export function boardQuery(filters: Filters, cursor: string | undefined): BoardQuery {
  const query: BoardQuery = { limit: PAGE_SIZE };
  set(query, 'band', filters.band);
  set(query, 'phase', filters.phase);
  set(query, 'assignee_id', filters.assignee);
  set(query, 'unit_id', filters.unit);
  set(query, 'status', filters.status);
  set(query, 'due_from', filters.dueFrom);
  set(query, 'due_to', filters.dueTo);
  if (cursor !== undefined) query.cursor = cursor;
  return query;
}

/** The calendar answers for one month and for the people and units the filters name (the colour, phase and status filters do not narrow it: the calendar shows every colour of a day). */
export function calendarQuery(month: string, filters: Filters): CalendarQuery {
  const query: CalendarQuery = { month };
  set(query, 'assignee_id', filters.assignee);
  set(query, 'unit_id', filters.unit);
  return query;
}

// ---- the month grid ----------------------------------------------------------------------------------------------------------------------------------------------------

export interface GridCell {
  date: string;
  inMonth: boolean;
  day: CalendarDay | undefined;
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const dayText = (value: number): string => new Date(value * DAY_MS).toISOString().slice(0, 10);
/** Monday is 0. */
const weekdayOf = (value: number): number => (new Date(value * DAY_MS).getUTCDay() + 6) % 7;

/** The month `YYYY-MM` moved by whole months. */
export function shiftMonth(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The weeks (Monday first) that cover a month; a cell holds what the server said for its day. */
export function calendarGrid(month: string, days: readonly CalendarDay[]): GridCell[][] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = dayNumber(`${month}-01`);
  const last = dayNumber(`${shiftMonth(month, 1)}-01`) - 1;
  const weeks: GridCell[][] = [];
  for (let start = first - weekdayOf(first); start <= last; start += 7) {
    weeks.push(
      Array.from({ length: 7 }, (_, offset): GridCell => {
        const date = dayText(start + offset);
        return { date, inMonth: monthOf(date) === month, day: byDate.get(date) };
      }),
    );
  }
  return weeks;
}

// ---- workload (display only) -----------------------------------------------------------------------------------------------------------------------------------------

export interface WorkloadRow {
  id: string;
  name: string;
  open: number;
  weekly: readonly number[];
  total: number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The people of the workload, the heaviest first; the total of a person is the sum of the weeks. Nothing here balances anything. */
export function workloadRows(workload: Workload): WorkloadRow[] {
  return workload.people
    .map((person) => ({ id: person.membership_id, name: person.display_name, open: person.open_tasks, weekly: person.weekly_planned_working_days.map(round1), total: round1(person.weekly_planned_working_days.reduce((sum, value) => sum + value, 0)) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

// ---- reading ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Whether a read is older than the limit; a time that does not read is old (it cannot be vouched for). */
export function isStale(asOf: string, now: number, minutes: number = STALE_MINUTES): boolean {
  const at = Date.parse(asOf);
  return Number.isNaN(at) || now - at > minutes * 60_000;
}

export interface Option {
  id: string;
  label: string;
}

/** The choices of a filter read from a register: the id and the first of the named fields that holds a text; a row without an id is left out. */
export function optionsOf(rows: readonly unknown[], fields: readonly string[]): Option[] {
  return rows.flatMap((raw): Option[] => {
    const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const id = typeof row.id === 'string' ? row.id : undefined;
    const label = fields.map((field) => row[field]).find((value): value is string => typeof value === 'string' && value !== '');
    return id === undefined ? [] : [{ id, label: label ?? id }];
  });
}

/** The phases the rows hold, each once, in the order first seen. */
export function phasesOf(rows: readonly Pick<BoardRow, 'phase_code'>[]): string[] {
  return [...new Set(rows.map((row) => row.phase_code))];
}

/** The people the rows are given to, each once, by name: the choices of the person filter when the membership register cannot be read. */
export function assigneesOf(rows: readonly Pick<BoardRow, 'assignee'>[]): Option[] {
  const seen = new Map<string, string>();
  for (const row of rows) if (row.assignee !== null && !seen.has(row.assignee.membership_id)) seen.set(row.assignee.membership_id, row.assignee.display_name);
  return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** A band with no day count: what the calendar and the milestone lists say of a task or a day (the colour, never the days). */
export const bareBand = (band: Band): { band: Band; remaining_days: null; unit: 'WORKING'; overdue: false } => ({ band, remaining_days: null, unit: 'WORKING', overdue: false });
