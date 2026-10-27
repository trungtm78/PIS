import { DomainError } from './errors.ts';

/**
 * The monitoring report (ST-MNE-002, MNE 3.1 F3): a report is made on a form revision (the one in force on the last day of its period), its financial cells are filled from a frozen snapshot and are locked, and its
 * text cells are written by hand. What a form asks for is data (`schema_json.fields`); the rules of the states and of the fields are here, with no store or clock of their own.
 */
export const MNE_REPORT_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'ISSUING', 'ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL', 'RETURNED', 'SUPERSEDED'] as const;
export type MneReportStatus = (typeof MNE_REPORT_STATUSES)[number];

export const MNE_FIELD_KINDS = ['MONEY', 'PERCENT', 'INTEGER', 'TEXT'] as const;
export type MneFieldKind = (typeof MNE_FIELD_KINDS)[number];

/** The figures of a snapshot that a cell may be filled from: the sums and the two rates of DIS (the same numbers as DIS-19). */
export const MNE_SNAPSHOT_METRICS = ['plan_total_vnd', 'plan_pm_assigned_vnd', 'disbursed_treasury_vnd', 'rate_pm_pct', 'rate_total_pct', 'project_count'] as const;
export type MneSnapshotMetric = (typeof MNE_SNAPSHOT_METRICS)[number];

export type MneFieldSource =
  | { kind: 'SNAPSHOT_METRIC'; metric: MneSnapshotMetric }
  /** The projects of the unit counted by their stage (all of them when no stage is named). */
  | { kind: 'PROJECT_COUNT'; stage: string | null }
  /** The early warnings that are still open for the projects of the unit (of a severity when one is named). */
  | { kind: 'WARNING_COUNT'; severity: string | null }
  /** What the appropriations published for a plan year add up to. */
  | { kind: 'APPROPRIATION_TOTAL'; planYear: number };

export interface MneReportField {
  key: string;
  label: string;
  kind: MneFieldKind;
  required: boolean;
  /** A cell with a source is filled by the system and locked. */
  source: MneFieldSource | null;
}

export interface MneReportSchema {
  fields: MneReportField[];
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const KEY = /^[a-z][a-z0-9_]{0,59}$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function sourceOf(raw: unknown, where: string): MneFieldSource | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw invalid(`${where}.source`);
  switch (raw.kind) {
    case 'SNAPSHOT_METRIC':
      if (!(MNE_SNAPSHOT_METRICS as readonly string[]).includes(raw.metric as string)) throw invalid(`${where}.source.metric`);
      return { kind: 'SNAPSHOT_METRIC', metric: raw.metric as MneSnapshotMetric };
    case 'PROJECT_COUNT':
      if (raw.stage !== undefined && typeof raw.stage !== 'string') throw invalid(`${where}.source.stage`);
      return { kind: 'PROJECT_COUNT', stage: (raw.stage as string | undefined) ?? null };
    case 'WARNING_COUNT':
      if (raw.severity !== undefined && typeof raw.severity !== 'string') throw invalid(`${where}.source.severity`);
      return { kind: 'WARNING_COUNT', severity: (raw.severity as string | undefined) ?? null };
    case 'APPROPRIATION_TOTAL':
      if (!Number.isInteger(raw.plan_year) || (raw.plan_year as number) < 1990 || (raw.plan_year as number) > 2100) throw invalid(`${where}.source.plan_year`);
      return { kind: 'APPROPRIATION_TOTAL', planYear: raw.plan_year as number };
    default:
      throw invalid(`${where}.source.kind`);
  }
}

/**
 * The fields a form asks for, read from its `schema_json`. A form that lists none (a form that waits for the confirmation of its legal basis) has none: its report is an empty shell that takes no cell. A field with
 * a source is a figure, so it cannot be a text.
 */
export function parseReportSchema(json: unknown): MneReportSchema {
  const fields = isRecord(json) && Array.isArray(json.fields) ? json.fields : [];
  const seen = new Set<string>();
  return {
    fields: fields.map((entry, index) => {
      const where = `schema_json.fields[${index}]`;
      if (!isRecord(entry) || typeof entry.key !== 'string' || !KEY.test(entry.key) || seen.has(entry.key)) throw invalid(`${where}.key`);
      seen.add(entry.key);
      const kind = (MNE_FIELD_KINDS as readonly string[]).includes(entry.kind as string) ? (entry.kind as MneFieldKind) : undefined;
      if (kind === undefined) throw invalid(`${where}.kind`);
      const source = sourceOf(entry.source, where);
      if (source !== null && kind === 'TEXT') throw invalid(`${where}.source`);
      return { key: entry.key, label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.key, kind, required: entry.required === true, source };
    }),
  };
}

/** The last day of the period a label names (`H1-2027`, `H2-2027`, `YEAR-2027`); null for any other label (a weekly period is read from the calendar). */
export function periodEndOfLabel(label: string, year: number): string | null {
  const match = /^(H1|H2|YEAR)-(\d{4})$/.exec(label);
  if (match === null || Number(match[2]) !== year) return null;
  return match[1] === 'H1' ? `${year}-06-30` : `${year}-12-31`;
}

export interface NarrativeFault {
  locked: string[];
  unknown: string[];
}

/** The keys of a narrative that the form does not take: the cells that are filled from a source (locked) and the ones it does not have (unknown). */
export function narrativeFaults(schema: MneReportSchema, narrative: Raw): NarrativeFault {
  const byKey = new Map(schema.fields.map((field) => [field.key, field]));
  const locked: string[] = [];
  const unknown: string[] = [];
  for (const key of Object.keys(narrative)) {
    const field = byKey.get(key);
    if (field === undefined) unknown.push(key);
    else if (field.source !== null) locked.push(key);
  }
  return { locked, unknown };
}

/** Whether a value fits the kind of its cell: a text of the cell, a whole number, a decimal percent, whole dong. */
export function fitsKind(kind: MneFieldKind, value: unknown): boolean {
  switch (kind) {
    case 'TEXT':
      return typeof value === 'string' && value.length <= 4000;
    case 'INTEGER':
      return typeof value === 'number' ? Number.isSafeInteger(value) : typeof value === 'string' && /^-?[0-9]{1,15}$/.test(value);
    case 'MONEY':
      return typeof value === 'string' && /^-?[0-9]{1,24}$/.test(value);
    case 'PERCENT':
      return typeof value === 'string' && /^-?[0-9]{1,6}(\.[0-9]{1,4})?$/.test(value);
  }
}

/** The cells a form needs that have no value yet (a source that had nothing to say, such as a rate with nothing to divide by, is a value of null and is missing). */
export function missingFields(schema: MneReportSchema, values: Raw, narrative: Raw): string[] {
  return schema.fields
    .filter((field) => field.required)
    .filter((field) => {
      const value = field.source === null ? narrative[field.key] : values[field.key];
      return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    })
    .map((field) => field.key);
}

/** The states a report may move between (MNE 3.1 section 4): the database keeps the same table. */
export const MNE_REPORT_TRANSITIONS: ReadonlyArray<readonly [MneReportStatus, MneReportStatus]> = [
  ['DRAFT', 'IN_REVIEW'],
  ['IN_REVIEW', 'DRAFT'],
  ['IN_REVIEW', 'APPROVED'],
  ['APPROVED', 'ISSUING'],
  ['ISSUING', 'ISSUED'],
  ['ISSUING', 'APPROVED'],
  ['ISSUED', 'EXPORTED'],
  ['EXPORTED', 'SUBMITTED_EXTERNAL'],
  ['SUBMITTED_EXTERNAL', 'RETURNED'],
  ['ISSUED', 'SUPERSEDED'],
  ['EXPORTED', 'SUPERSEDED'],
  ['SUBMITTED_EXTERNAL', 'SUPERSEDED'],
  ['RETURNED', 'SUPERSEDED'],
];

/** 409 REPORT_STATE_INVALID naming the state when a report is not in one of the states an action needs. */
export function assertReportState(status: MneReportStatus, allowed: readonly MneReportStatus[]): void {
  if (!allowed.includes(status)) throw new DomainError('REPORT_STATE_INVALID', 409, 'status', { extensions: { report_status: status } });
}

// ---- review, approval and issue through the document engine (ST-MNE-003) ----

export const MNE_DECISIONS = ['approve', 'return'] as const;
export type MneDecision = (typeof MNE_DECISIONS)[number];

/**
 * What a decision gives a report that waits for it: approve makes it APPROVED, return sends it back to its preparer as a DRAFT to be changed and handed in again. A report that is not in review is 409
 * REPORT_STATE_INVALID naming the state.
 */
export function decidedMneReport(status: MneReportStatus, decision: MneDecision): MneReportStatus {
  assertReportState(status, ['IN_REVIEW']);
  return decision === 'approve' ? 'APPROVED' : 'DRAFT';
}

/** The module DOC knows the request by, and how it names a report in its events: the id and the revision, so that a correction is another request. */
export const MNE_SOURCE_MODULE = 'MNE';
const SOURCE_REF = /^MNE:mne_report:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):r([1-9][0-9]{0,5})$/;

export const mneReportSourceRef = (id: string, revision: number): string => `MNE:mne_report:${id.toLowerCase()}:r${revision}`;

export function parseMneReportSourceRef(ref: unknown): { id: string; revision: number } | undefined {
  if (typeof ref !== 'string') return undefined;
  const found = SOURCE_REF.exec(ref);
  return found === null ? undefined : { id: found[1] as string, revision: Number(found[2]) };
}

export interface MnePayloadCell {
  label: string;
  kind: MneFieldKind;
  /** What the cell holds as the report keeps it; null while it has nothing. */
  value: string | number | null;
}

export interface MnePayloadInput {
  title: string;
  periodLabel: string;
  unitCode: string;
  unitName: string;
  dueDate: string;
  asOfDate: string | null;
  cells: readonly MnePayloadCell[];
}

const GROUPS = /\B(?=(\d{3})+(?!\d))/g;

/** A cell the way a document prints it: whole dong with a dot between thousands, a percent with its sign, a count and a text as they are, and a dash for a cell with nothing. */
export function printedCell(cell: MnePayloadCell): string {
  if (cell.value === null) return '-';
  const text = String(cell.value);
  switch (cell.kind) {
    case 'MONEY':
      return `${text.startsWith('-') ? '-' : ''}${text.replace('-', '').replace(GROUPS, '.')} đồng`;
    case 'PERCENT':
      return `${text}%`;
    case 'INTEGER':
    case 'TEXT':
      return text;
  }
}

/**
 * What DOC prints (the placeholders `title`, `period` and `body` of the templates MNE-TT44-*): the title of the form, the period and the unit, and one line per cell of the report. The same report always gives
 * the same payload, which is what its hash is the hash of.
 */
export function mneReportPayload(input: MnePayloadInput): Record<string, string> {
  const lines = input.cells.map((cell) => `${cell.label}: ${printedCell(cell)}`);
  return {
    title: input.title,
    period: `Kỳ báo cáo ${input.periodLabel} - ${input.unitName} (${input.unitCode}); hạn nộp ${input.dueDate}${input.asOfDate === null ? '' : `; số liệu đến ngày ${input.asOfDate}`}`,
    body: lines.join('\n'),
    agency: input.unitName,
    // The place of issue is in no record of the tenant; DOC requires it, and its drafter completes a dash before the report goes out.
    place: '-',
  };
}

// ---- correction of an issued or filed report (ST-MNE-007) ----

/** The states a report is corrected from: it was issued by DOC (and may have been exported, filed or sent back by the recipient). A draft is edited, not corrected. */
export const MNE_CORRECTABLE_STATUSES: readonly MneReportStatus[] = ['ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL', 'RETURNED'];
/** The states a superseded revision is still read in: what was issued stays downloadable. */
export const MNE_ISSUED_STATUSES: readonly MneReportStatus[] = ['ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL', 'RETURNED', 'SUPERSEDED'];

/** A correction needs the reason, of ten characters at least once trimmed (422 CORRECTION_REASON_REQUIRED) and a report that was issued (409 REPORT_NOT_ISSUED naming the state). The text of the reason is returned trimmed. */
export function checkedCorrection(report: { status: MneReportStatus }, reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 10 || text.length > 2000) throw new DomainError('CORRECTION_REASON_REQUIRED', 422, 'correction_reason');
  if (!MNE_CORRECTABLE_STATUSES.includes(report.status)) throw new DomainError('REPORT_NOT_ISSUED', 409, 'status', { extensions: { report_status: report.status } });
  return text;
}
