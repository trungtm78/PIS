/** The stages of land clearance that progress is tracked by, in the order of LND 3.1 (ST-LND-010). */
export const STAGE_CODES = ['SURVEY', 'NOTICE', 'INVENTORY', 'PLAN_DRAFT', 'PLAN_POSTING', 'PLAN_APPROVAL', 'PAYMENT', 'HANDOVER', 'ENFORCEMENT'] as const;
export type StageCode = (typeof STAGE_CODES)[number];

/** Who executes a stage: the project owner itself, the land fund centre or the board of the district. */
export const EXECUTOR_KINDS = ['PROJECT_OWNER', 'LAND_FUND_CENTRE', 'DISTRICT_BOARD'] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

/** NATIVE: the progress is counted from the data of LND. TRACKED_EXTERNAL: it is reported by the executing unit, with evidence. */
export const STAGE_MODES = ['NATIVE', 'TRACKED_EXTERNAL'] as const;
export type StageMode = (typeof STAGE_MODES)[number];

export const STAGE_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'LATE'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** The most parcels a stage counts: far above any project, and well inside the integer column. */
export const MAX_STAGE_PARCELS = 1_000_000;
export const MAX_BLOCKER_NOTE = 2000;

export interface StageFacts {
  parcelsTotal: number;
  parcelsDone: number;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  /** The executor reported something that holds the stage back. */
  blocked: boolean;
}

/**
 * The status a stage is in on `today` (a `YYYY-MM-DD` date): DONE when it has an end, LATE when its planned end is behind us and it is not done (the planned
 * day itself is not late), BLOCKED when the executor reports a blocker, IN_PROGRESS once a parcel is done or the work has begun, and NOT_STARTED otherwise.
 * A stage that is both late and blocked is LATE: the late stage is the one that asks for an issue.
 */
export function stageStatusOf(facts: StageFacts, today: string): StageStatus {
  if (facts.actualEnd !== null) return 'DONE';
  if (facts.plannedEnd !== null && facts.plannedEnd < today) return 'LATE';
  if (facts.blocked) return 'BLOCKED';
  return facts.parcelsDone > 0 || facts.actualStart !== null ? 'IN_PROGRESS' : 'NOT_STARTED';
}

export type StageProblem = 'PARCELS_NOT_COUNTS' | 'PARCELS_DONE_EXCEEDS_TOTAL' | 'DATES_OUT_OF_ORDER' | 'END_BEFORE_ALL_DONE' | 'DATE_IN_FUTURE' | 'EVIDENCE_REQUIRED';

export interface StageIssue {
  field: string;
  problem: StageProblem;
}

/**
 * What is wrong with a report of a stage, before the database is asked: the counts are whole numbers within the limit and the done count does not pass the total, the dates run
 * in order and the actual ones are not in the future, an end means every parcel is done, and progress that was made needs the evidence of the executing unit when it is
 * tracked from outside.
 */
export function stageIssues(report: {
  parcelsTotal: number;
  parcelsDone: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  tracked: boolean;
  hasEvidence: boolean;
  today: string;
}): StageIssue[] {
  const issues: StageIssue[] = [];
  const count = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= MAX_STAGE_PARCELS;
  if (!count(report.parcelsTotal)) issues.push({ field: 'parcels_total', problem: 'PARCELS_NOT_COUNTS' });
  if (!count(report.parcelsDone)) issues.push({ field: 'parcels_done', problem: 'PARCELS_NOT_COUNTS' });
  if (count(report.parcelsTotal) && count(report.parcelsDone) && report.parcelsDone > report.parcelsTotal) issues.push({ field: 'parcels_done', problem: 'PARCELS_DONE_EXCEEDS_TOTAL' });
  if (report.plannedStart !== null && report.plannedEnd !== null && report.plannedStart > report.plannedEnd) issues.push({ field: 'planned_end', problem: 'DATES_OUT_OF_ORDER' });
  if (report.actualStart !== null && report.actualEnd !== null && report.actualStart > report.actualEnd) issues.push({ field: 'actual_end', problem: 'DATES_OUT_OF_ORDER' });
  if (report.actualStart !== null && report.actualStart > report.today) issues.push({ field: 'actual_start', problem: 'DATE_IN_FUTURE' });
  if (report.actualEnd !== null && report.actualEnd > report.today) issues.push({ field: 'actual_end', problem: 'DATE_IN_FUTURE' });
  if (report.actualEnd !== null && report.parcelsDone !== report.parcelsTotal) issues.push({ field: 'actual_end', problem: 'END_BEFORE_ALL_DONE' });
  if (report.tracked && !report.hasEvidence && (report.parcelsDone > 0 || report.actualEnd !== null)) issues.push({ field: 'evidence_document_version_id', problem: 'EVIDENCE_REQUIRED' });
  return issues;
}
