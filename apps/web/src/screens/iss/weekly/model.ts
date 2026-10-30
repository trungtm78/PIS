import { ISSUE_STATUSES } from '../issue-model';
import type { IssueStatus } from '../issue-model';

/** The permission of ISS-06 and ISS-08 (x-permission of `getIssueWeeklyMatrix` in openapi.json). */
export const READ_PERMISSION = 'issue.read';

const DAY_MS = 86_400_000;
const WEEK = /^(\d{4})-W(\d{2})$/;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export type StatusCounts = Readonly<Record<IssueStatus, number>>;

export interface Totals {
  opening: number;
  opened: number;
  resolved: number;
  closing: number;
  overdue: number;
  byStatus: StatusCounts;
}

export interface UnitRef {
  id: string;
  code: string;
  name: string;
}

export interface MatrixRow extends Totals {
  unit: UnitRef;
  categoryVersionId: string;
  categoryLabel: string;
}

export interface MatrixUnit extends Totals {
  unit: UnitRef;
}

export interface Matrix {
  week: string;
  from: string;
  to: string;
  rows: MatrixRow[];
  units: MatrixUnit[];
  totals: Totals;
}

function toTotals(raw: Raw): Totals {
  const statuses = isRecord(raw.by_status) ? raw.by_status : {};
  return {
    opening: count(raw.opening),
    opened: count(raw.opened),
    resolved: count(raw.resolved),
    closing: count(raw.closing),
    overdue: count(raw.overdue),
    byStatus: Object.fromEntries(ISSUE_STATUSES.map((status) => [status, count(statuses[status])])) as Record<IssueStatus, number>,
  };
}

function toUnit(raw: unknown): UnitRef | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return { id: raw.id, code: text(raw.code) ?? '', name: text(raw.name) ?? raw.id };
}

export function toMatrix(raw: unknown): Matrix | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.rows) || !Array.isArray(raw.units) || !isRecord(raw.totals)) return undefined;
  const week = text(raw.week);
  if (week === undefined) return undefined;
  return {
    week,
    from: text(raw.from) ?? '',
    to: text(raw.to) ?? '',
    rows: raw.rows.flatMap((row) => {
      const unit = isRecord(row) ? toUnit(row.unit) : undefined;
      const category = isRecord(row) && isRecord(row.category) ? row.category : undefined;
      return isRecord(row) && unit !== undefined && category !== undefined ? [{ ...toTotals(row), unit, categoryVersionId: text(category.version_id) ?? '', categoryLabel: text(category.label) ?? '' }] : [];
    }),
    units: raw.units.flatMap((row) => {
      const unit = isRecord(row) ? toUnit(row.unit) : undefined;
      return isRecord(row) && unit !== undefined ? [{ ...toTotals(row), unit }] : [];
    }),
    totals: toTotals(raw.totals),
  };
}

// ---- the weeks ---------------------------------------------------------------------------------------------------------------------

function firstMonday(year: number): number {
  const fourth = Date.UTC(year, 0, 4);
  return fourth - ((new Date(fourth).getUTCDay() + 6) % 7) * DAY_MS;
}

/** The ISO week a Vietnam calendar day lies in (`2026-W42`); the year of a week is the year of its Thursday. */
export function isoWeekOf(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  const thursday = ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS + 3 * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  return `${year}-W${String(Math.floor((thursday - firstMonday(year)) / (7 * DAY_MS)) + 1).padStart(2, '0')}`;
}

/** The Monday of a week named `YYYY-Www`, or undefined for a name that is not one or a week the year does not have. */
export function mondayOf(week: string): string | undefined {
  const matched = WEEK.exec(week);
  if (matched === null) return undefined;
  const year = Number(matched[1]);
  const number = Number(matched[2]);
  if (year < 2000 || year > 2100 || number < 1 || number > 53) return undefined;
  const monday = new Date(firstMonday(year) + (number - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
  return isoWeekOf(monday) === week ? monday : undefined;
}

export const isWeek = (value: string): boolean => mondayOf(value) !== undefined;

/** The week `by` weeks after (or before, when negative) the one named. */
export function shiftWeek(week: string, by: number): string {
  const monday = mondayOf(week);
  if (monday === undefined) return week;
  return isoWeekOf(new Date(Date.parse(`${monday}T00:00:00Z`) + by * 7 * DAY_MS).toISOString().slice(0, 10));
}

/** The Vietnam calendar day of an instant. */
export const vietnamDay = (now: Date): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

// ---- the cells ----------------------------------------------------------------------------------------------------------------------

/** The list of the issues that a cell counts (ISS-01 with the unit, the status and the week of the cell). */
export function drillLink(cell: { unitId: string; week: string; status?: IssueStatus; open?: boolean; categoryVersionId?: string }): string {
  const params = new URLSearchParams({ owner_unit_id: cell.unitId, week: cell.week });
  if (cell.status !== undefined) params.set('status', cell.status);
  if (cell.open === true) params.set('open', 'true');
  if (cell.categoryVersionId !== undefined) params.set('category_version_id', cell.categoryVersionId);
  return `/iss/iss-01?${params.toString()}`;
}

/** The share of what was open during the week that was closed in it, in whole percents; none when nothing was open. */
export function progressPercent(totals: Pick<Totals, 'opening' | 'opened' | 'resolved'>): number | undefined {
  const base = totals.opening + totals.opened;
  return base === 0 ? undefined : Math.min(100, Math.round((totals.resolved * 100) / base));
}
