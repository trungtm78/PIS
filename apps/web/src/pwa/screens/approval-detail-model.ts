/**
 * The model of the approval detail on the phone (PWA-05): what a leader reads before deciding a task of the period data. It follows MOB-24 of the phone
 * application (the record, the comparison, the evidence) and adds what the report already carries: the plan the cells rest on and the period before.
 * Pure functions over the answers of the API; nothing here reads a clock or a server.
 */
type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const dong = (value: unknown): string | undefined => (typeof value === 'string' && /^\d+$/.test(value) ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.flatMap((item) => record(item) ?? []) : []);

/** The business type whose tasks carry a report revision; the others have no figures to compare. */
export const REPORT_ACCEPT = 'report.accept';

/** The three buckets and two budget levels of the funding form, in the order of the paper form. */
export const BUCKETS = ['CURRENT_YEAR', 'CARRYOVER', 'OTHER'] as const;
export const LEVELS = ['CENTRAL', 'LOCAL'] as const;
export type Bucket = (typeof BUCKETS)[number];
export type Level = (typeof LEVELS)[number];

export const cellKey = (bucket: string, level: string): string => `${bucket}:${level}`;

export interface Cell {
  bucket: Bucket;
  level: Level;
  /** What the plan allocated to the cell. */
  allocatedVnd: string;
  /** The cumulative amount this report gives for the cell. */
  cumulativeVnd: string;
  /** The cumulative amount the period before reached, or null when there was none. */
  previousVnd: string | null;
}

export interface Evidence {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** The first characters of the SHA-256 of the file: enough to match it with what was sent, never the whole digest on a small screen. */
  hashHead: string;
}

/** A revision of a report with the figures a reviewer compares. */
export interface ReportFigures {
  id: string;
  revision: number;
  status: string;
  projectCode: string;
  projectName: string;
  periodCode: string;
  planYear: number | null;
  planRevision: number | null;
  /** The plan allocation of the whole report (the sum of the cells), as the server totals it. */
  allocatedVnd: string | null;
  cumulativeVnd: string;
  /** The part of the total that is CTMTQG: inside the cells, never added. */
  ctmtqgVnd: string;
  cells: Cell[];
  evidence: Evidence[];
  supersedesId: string | null;
  amendmentReason: string | null;
  submittedAt: string | null;
  isLate: boolean;
}

const bucketOf = (value: unknown): Bucket | undefined => BUCKETS.find((bucket) => bucket === value);
const levelOf = (value: unknown): Level | undefined => LEVELS.find((level) => level === value);

/** A revision from `getReportRevision`, or undefined when the answer is not one (the screen then says the figures could not be read, never half of them). */
export function toReportFigures(raw: unknown): ReportFigures | undefined {
  const row = record(raw);
  const project = record(row?.project);
  const period = record(row?.period);
  const totals = record(row?.totals);
  const id = text(row?.id);
  const revision = whole(row?.revision);
  const cumulative = dong(totals?.cumulative_vnd);
  const ctmtqg = dong(totals?.ctmtqg_vnd);
  if (row === undefined || id === undefined || revision === undefined || cumulative === undefined || ctmtqg === undefined || project === undefined || period === undefined) return undefined;
  const cells: Cell[] = [];
  for (const line of list(row.funding_lines)) {
    const bucket = bucketOf(line.bucket);
    const level = levelOf(line.budget_level);
    const amount = dong(line.cumulative_vnd);
    if (bucket === undefined || level === undefined || amount === undefined) continue;
    cells.push({ bucket, level, allocatedVnd: dong(line.allocated_vnd) ?? '0', cumulativeVnd: amount, previousVnd: dong(line.previous_cumulative_vnd) ?? null });
  }
  const plan = record(row.plan_version);
  return {
    id,
    revision,
    status: text(row.status) ?? '',
    projectCode: text(project.code) ?? '',
    projectName: text(project.name) ?? '',
    periodCode: text(period.code) ?? '',
    planYear: whole(plan?.fiscal_year) ?? null,
    planRevision: whole(plan?.revision) ?? null,
    allocatedVnd: dong(totals?.allocated_vnd) ?? null,
    cumulativeVnd: cumulative,
    ctmtqgVnd: ctmtqg,
    cells,
    evidence: list(row.attachments).flatMap((file): Evidence[] => {
      const fileId = text(file.id);
      return fileId === undefined ? [] : [{ id: fileId, fileName: text(file.file_name) ?? '', contentType: text(file.content_type) ?? '', sizeBytes: whole(file.size_bytes) ?? 0, hashHead: (text(file.file_sha256) ?? '').slice(0, 16) }];
    }),
    supersedesId: text(row.supersedes_id) ?? null,
    amendmentReason: text(row.amendment_reason) ?? null,
    submittedAt: text(row.submitted_at) ?? null,
    isLate: row.is_late === true,
  };
}

/** The difference of two whole amounts of dong as a signed decimal string (exact, any size). */
export function differenceDong(later: string, earlier: string): string {
  return (BigInt(later) - BigInt(earlier)).toString();
}

export const isNegative = (signed: string): boolean => signed.startsWith('-');

/** The share of the plan the report has reached, in tenths of a percent, or null when the plan allocated nothing (a rate over zero is not given). */
export function planShareTenths(cumulativeVnd: string, allocatedVnd: string | null): number | null {
  if (allocatedVnd === null || BigInt(allocatedVnd) === 0n) return null;
  const plan = BigInt(allocatedVnd);
  return Number((BigInt(cumulativeVnd) * 1000n + plan / 2n) / plan);
}

export interface CellChange {
  bucket: Bucket;
  level: Level;
  previousVnd: string;
  currentVnd: string;
  changeVnd: string;
  changed: boolean;
}

/** The six cells of a revision against the six of the revision it corrects; a cell a revision does not hold reads zero. */
export function compareRevisions(previous: ReportFigures, current: ReportFigures): CellChange[] {
  const amount = (report: ReportFigures, bucket: Bucket, level: Level): string => report.cells.find((cell) => cellKey(cell.bucket, cell.level) === cellKey(bucket, level))?.cumulativeVnd ?? '0';
  return BUCKETS.flatMap((bucket) =>
    LEVELS.map((level): CellChange => {
      const before = amount(previous, bucket, level);
      const after = amount(current, bucket, level);
      const change = differenceDong(after, before);
      return { bucket, level, previousVnd: before, currentVnd: after, changeVnd: change, changed: change !== '0' };
    }),
  );
}

/** The cells in the order of the paper form, the six of them even when the report holds fewer (a cell not reported is zero, which the plan comparison shows too). */
export function orderedCells(report: ReportFigures): Cell[] {
  return BUCKETS.flatMap((bucket) =>
    LEVELS.map((level): Cell => report.cells.find((cell) => cell.bucket === bucket && cell.level === level) ?? { bucket, level, allocatedVnd: '0', cumulativeVnd: '0', previousVnd: null }),
  );
}

/** One step of the approval of the record, as the tasks of the instance tell it. */
export interface StepEntry {
  id: string;
  stepIndex: number;
  stepName: string;
  status: string;
  decision: string | null;
  reason: string | null;
  decidedAt: string | null;
  assigneeName: string | null;
}

export function toStepEntry(raw: unknown): StepEntry | undefined {
  const row = record(raw);
  const id = text(row?.id);
  const status = text(row?.status);
  if (row === undefined || id === undefined || status === undefined) return undefined;
  return {
    id,
    stepIndex: whole(row.step_index) ?? 0,
    stepName: text(row.step_name) ?? text(row.step_id) ?? '',
    status,
    decision: text(row.decision) ?? null,
    reason: text(row.reason) ?? null,
    decidedAt: text(row.decided_at) ?? null,
    assigneeName: text(record(row.assignee)?.name) ?? null,
  };
}

/** The steps in the order of the workflow, the earliest decision first inside a step. */
export function stepHistory(rows: readonly unknown[]): StepEntry[] {
  return rows
    .flatMap((raw) => toStepEntry(raw) ?? [])
    .sort((a, b) => a.stepIndex - b.stepIndex || Date.parse(a.decidedAt ?? '') - Date.parse(b.decidedAt ?? '') || a.id.localeCompare(b.id));
}

/** The kilobytes of a file, rounded up, at least 1 for a file that is not empty. */
export const kilobytes = (bytes: number): number => (bytes <= 0 ? 0 : Math.ceil(bytes / 1024));
