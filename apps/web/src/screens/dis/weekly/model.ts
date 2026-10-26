import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'disbursement.read';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const MONEY = /^-?[0-9]+$/;
const money = (value: unknown): string | undefined => (typeof value === 'string' && MONEY.test(value) ? value : undefined);

/** One week of one project: what was committed, what the Treasury paid in it, and the gap (ST-DIS-014, DIS-24). */
export interface WeeklyPlanView {
  projectId: string;
  projectCode: string;
  projectName: string;
  leader: { membershipId: string; displayName: string } | null;
  periodId: string;
  periodCode: string;
  startDate: string;
  endDate: string;
  commitmentVnd: string;
  /** Null while the week has no frozen close snapshot: nothing is known, which is not zero. */
  actualVnd: string | null;
  differenceVnd: string | null;
  fromYearStart: boolean;
}

export interface WeeklyPlanPage {
  planYear: number | undefined;
  items: WeeklyPlanView[];
  nextCursor: string | undefined;
}

function toRow(raw: unknown): WeeklyPlanView | undefined {
  const row = asRecord(raw);
  const project = asRecord(row?.project);
  const period = asRecord(row?.period);
  const leader = asRecord(row?.leader);
  const commitment = money(row?.commitment_vnd);
  const projectId = text(project?.id);
  const periodId = text(period?.id);
  if (row === undefined || projectId === undefined || periodId === undefined || commitment === undefined) return undefined;
  const leaderId = text(leader?.membership_id);
  const leaderName = text(leader?.display_name);
  return {
    projectId,
    projectCode: text(project?.code) ?? '',
    projectName: text(project?.name) ?? '',
    leader: leaderId === undefined || leaderName === undefined ? null : { membershipId: leaderId, displayName: leaderName },
    periodId,
    periodCode: text(period?.code) ?? '',
    startDate: text(period?.start_date) ?? '',
    endDate: text(period?.end_date) ?? '',
    commitmentVnd: commitment,
    actualVnd: money(row.actual_vnd) ?? null,
    differenceVnd: money(row.difference_vnd) ?? null,
    fromYearStart: row.actual_from_year_start === true,
  };
}

export function toWeeklyPlanPage(raw: unknown): WeeklyPlanPage {
  const row = asRecord(raw);
  const year = row?.plan_year;
  return {
    planYear: typeof year === 'number' && Number.isInteger(year) ? year : undefined,
    items: (Array.isArray(row?.items) ? row.items : []).flatMap((item) => toRow(item) ?? []),
    nextCursor: text(row?.next_cursor) ?? undefined,
  };
}

const YEAR = /^(20[0-9]{2}|2100)$/;
/** The year a person typed, or why it cannot be asked for: an empty box asks for the year of today. */
export function planYearOf(input: string): { year: string | undefined; valid: boolean } {
  const value = input.trim();
  if (value === '') return { year: undefined, valid: true };
  return YEAR.test(value) ? { year: value, valid: true } : { year: undefined, valid: false };
}

/** Whether the week fell short (negative), held (zero) or went over (positive) of its commitment; nothing is said of a week with no actual. */
export type Standing = 'short' | 'met' | 'over' | 'unknown';
export function standingOf(differenceVnd: string | null): Standing {
  if (differenceVnd === null) return 'unknown';
  if (differenceVnd.startsWith('-')) return 'short';
  return BigInt(differenceVnd) === 0n ? 'met' : 'over';
}

/** The query was refused as not valid: the screen says so next to the filter, and every other failure is one of the seven states. */
export const isValidationRefusal = (error: unknown): boolean => error instanceof ApiError && (error.code === 'VALIDATION_FAILED' || error.code === 'INVALID_REQUEST');
