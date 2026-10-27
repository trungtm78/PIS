import { ApiError } from '@machvon/api-client';

export const BOARD_PATH = '/dis/dis-15';
export const MONTHLY_NARRATIVE_PATH = '/dis/dis-13';
export const DETAIL_PATH = '/dis/dis-07';
export const READ_PERMISSION = 'report.read';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

/** The numbers of the board that lead to a list of projects, and the one that is all of them. */
export const DRILL_STATES = ['MUST_REPORT', 'SUBMITTED', 'LATE_SUBMITTED', 'DRAFT', 'NOT_STARTED', 'OVERDUE'] as const;
export type DrillState = (typeof DRILL_STATES)[number];
export const asDrillState = (value: string | null): DrillState | undefined => DRILL_STATES.find((state) => state === value);

export interface Counts {
  mustReport: number;
  submitted: number;
  submittedLate: number;
  draft: number;
  notStarted: number;
  overdue: number;
}

export interface UnitCounts extends Counts {
  unit: { id: string; code: string; name: string };
}

export interface BoardProject {
  projectId: string;
  projectCode: string;
  projectName: string;
  unit: { id: string; code: string; name: string };
  state: 'SUBMITTED' | 'DRAFT' | 'NOT_STARTED';
  isLate: boolean;
  overdue: boolean;
  report: { id: string; status: string; submittedAt: string | null } | null;
  narrative: { results: string | null; causes: string | null; solutions: string | null; proposals: string | null } | null;
}

export interface Board {
  periodId: string;
  periodCode: string;
  periodType: string;
  deadlineAt: string;
  deadlinePassed: boolean;
  total: Counts;
  units: UnitCounts[];
  projects: BoardProject[];
  nextCursor: string | undefined;
}

function countsOf(raw: unknown): Counts | undefined {
  const row = asRecord(raw);
  const mustReport = count(row?.must_report);
  const submitted = count(row?.submitted);
  const submittedLate = count(row?.submitted_late);
  const draft = count(row?.draft);
  const notStarted = count(row?.not_started);
  const overdue = count(row?.overdue);
  if (mustReport === undefined || submitted === undefined || submittedLate === undefined || draft === undefined || notStarted === undefined || overdue === undefined) return undefined;
  return { mustReport, submitted, submittedLate, draft, notStarted, overdue };
}

function refOf(raw: unknown): { id: string; code: string; name: string } | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  const name = text(row?.name);
  return id === undefined || code === undefined || name === undefined ? undefined : { id, code, name };
}

function projectOf(raw: unknown): BoardProject | undefined {
  const row = asRecord(raw);
  const project = refOf(row?.project);
  const unit = refOf(row?.unit);
  const state = (['SUBMITTED', 'DRAFT', 'NOT_STARTED'] as const).find((candidate) => candidate === row?.state);
  if (row === undefined || project === undefined || unit === undefined || state === undefined) return undefined;
  const report = asRecord(row.report);
  const reportId = text(report?.id);
  const narrative = asRecord(row.narrative);
  return {
    projectId: project.id,
    projectCode: project.code,
    projectName: project.name,
    unit,
    state,
    isLate: row.is_late === true,
    overdue: row.overdue === true,
    report: reportId === undefined ? null : { id: reportId, status: text(report?.status) ?? '', submittedAt: nullableText(report?.submitted_at) },
    narrative: narrative === undefined ? null : { results: nullableText(narrative.results), causes: nullableText(narrative.causes), solutions: nullableText(narrative.solutions), proposals: nullableText(narrative.proposals) },
  };
}

export function toBoard(raw: unknown): Board | undefined {
  const row = asRecord(raw);
  const period = asRecord(row?.period);
  const total = countsOf(row?.total);
  const periodId = text(period?.id);
  if (row === undefined || period === undefined || total === undefined || periodId === undefined) return undefined;
  const units = (Array.isArray(row.units) ? row.units : []).flatMap((item): UnitCounts[] => {
    const parts = countsOf(item);
    const unit = refOf(asRecord(item)?.unit);
    return parts === undefined || unit === undefined ? [] : [{ ...parts, unit }];
  });
  return {
    periodId,
    periodCode: text(period.code) ?? '',
    periodType: text(period.period_type) ?? '',
    deadlineAt: text(period.deadline_at) ?? '',
    deadlinePassed: row.deadline_passed === true,
    total,
    units,
    projects: (Array.isArray(row.projects) ? row.projects : []).flatMap((item) => projectOf(item) ?? []),
    nextCursor: text(row.next_cursor),
  };
}

/** The number of a unit row that a drill state is, so that a link and the list it opens agree. */
export function countOf(counts: Counts, state: DrillState): number {
  switch (state) {
    case 'MUST_REPORT':
      return counts.mustReport;
    case 'SUBMITTED':
      return counts.submitted;
    case 'LATE_SUBMITTED':
      return counts.submittedLate;
    case 'DRAFT':
      return counts.draft;
    case 'NOT_STARTED':
      return counts.notStarted;
    case 'OVERDUE':
      return counts.overdue;
  }
}

export interface DrillQuery {
  unitId: string | undefined;
  state: DrillState;
  withNarrative: boolean;
}

/** The query of the read, in the words of the contract; what is not asked for is not sent. */
export function drillQueryOf(query: DrillQuery, cursor: string | undefined, limit: number): Record<string, unknown> {
  return { limit, state: query.state, ...(query.unitId === undefined ? {} : { unit_id: query.unitId }), ...(query.withNarrative ? { with_narrative: 'true' } : {}), ...(cursor === undefined ? {} : { cursor }) };
}

/** The link of a number of the board: the period, the unit (none for the total) and the state it counts. */
export function drillLink(periodId: string, unitId: string | undefined, state: DrillState): string {
  const params = new URLSearchParams({ period: periodId, state });
  if (unitId !== undefined) params.set('unit', unitId);
  return `${BOARD_PATH}?${params.toString()}`;
}

/** The period a board opens on when none is chosen: the latest one that has started, else the first one. */
export function defaultPeriod<T extends { id: string; startDate: string }>(periods: readonly T[], today: string): T | undefined {
  const sorted = [...periods].sort((left, right) => (left.startDate < right.startDate ? 1 : left.startDate > right.startDate ? -1 : 0));
  return sorted.find((period) => period.startDate <= today) ?? sorted[sorted.length - 1];
}

export type BoardProblem = 'notFound' | 'validation' | 'general';
const PROBLEM_BY_CODE: Readonly<Record<string, BoardProblem>> = { RESOURCE_NOT_FOUND: 'notFound', VALIDATION_FAILED: 'validation', INVALID_REQUEST: 'validation' };
export const describeBoard = (error: unknown): BoardProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
