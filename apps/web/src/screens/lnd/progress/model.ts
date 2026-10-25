import { ApiError } from '@machvon/api-client';

/** The permissions of LND-01 and LND-11 (x-permission of the operations in openapi.json). */
export const READ_PERMISSION = 'land.read';
export const REPORT_PERMISSION = 'land.progress.report';
export const OVERVIEW_PATH = '/lnd/lnd-01';
export const PROGRESS_PATH = '/lnd/lnd-11';

export const STAGE_CODES = ['SURVEY', 'NOTICE', 'INVENTORY', 'PLAN_DRAFT', 'PLAN_POSTING', 'PLAN_APPROVAL', 'PAYMENT', 'HANDOVER', 'ENFORCEMENT'] as const;
export type StageCode = (typeof STAGE_CODES)[number];
export const EXECUTOR_KINDS = ['PROJECT_OWNER', 'LAND_FUND_CENTRE', 'DISTRICT_BOARD'] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];
export const STAGE_MODES = ['NATIVE', 'TRACKED_EXTERNAL'] as const;
export type StageMode = (typeof STAGE_MODES)[number];
export const STAGE_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'LATE'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const MAX_PARCELS = 1_000_000;
export const MAX_NOTE = 2000;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const optionalText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

export interface StageLine {
  id: string;
  sectionId: string;
  planId: string | null;
  stageCode: StageCode;
  executorKind: ExecutorKind;
  executorUnitId: string;
  executorUnitName: string;
  mode: StageMode;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  parcelsTotal: number;
  parcelsDone: number;
  progressPct: string;
  lastReportedAt: string | null;
  evidenceDocumentVersionId: string | null;
  status: StageStatus;
  blockerIssueId: string | null;
  blockerNote: string | null;
  version: number;
}

/** A stage of the overview; a row with a stage, a kind of executor, a mode or a status that the screen does not know is dropped. */
export function toStage(raw: unknown): StageLine | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  const stageCode = oneOf(STAGE_CODES, row.stage_code);
  const executorKind = oneOf(EXECUTOR_KINDS, row.executor_kind);
  const mode = oneOf(STAGE_MODES, row.mode);
  const status = oneOf(STAGE_STATUSES, row.status);
  if (typeof row.id !== 'string' || typeof row.section_id !== 'string' || stageCode === undefined || executorKind === undefined || mode === undefined || status === undefined) return undefined;
  return {
    id: row.id,
    sectionId: row.section_id,
    planId: optionalText(row.plan_id),
    stageCode,
    executorKind,
    executorUnitId: optionalText(row.executor_unit_id) ?? '',
    executorUnitName: optionalText(row.executor_unit_name) ?? '',
    mode,
    plannedStart: optionalText(row.planned_start),
    plannedEnd: optionalText(row.planned_end),
    actualStart: optionalText(row.actual_start),
    actualEnd: optionalText(row.actual_end),
    parcelsTotal: count(row.parcels_total),
    parcelsDone: count(row.parcels_done),
    progressPct: optionalText(row.progress_pct) ?? '0.00',
    lastReportedAt: optionalText(row.last_reported_at),
    evidenceDocumentVersionId: optionalText(row.evidence_document_version_id),
    status,
    blockerIssueId: optionalText(row.blocker_issue_id),
    blockerNote: optionalText(row.blocker_note),
    version: count(row.version),
  };
}

export interface SectionLine {
  id: string;
  code: string;
  name: string;
  status: string;
  requiredAreaM2: string;
  handedAreaM2: string;
  targetDate: string | null;
  parcels: number;
  parcelsNoticed: number;
  parcelsPaid: number;
  parcelsHandedOver: number;
}

function toSection(raw: unknown): SectionLine[] {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string' || typeof row.code !== 'string') return [];
  return [
    {
      id: row.id,
      code: row.code,
      name: optionalText(row.name) ?? '',
      status: optionalText(row.status) ?? '',
      requiredAreaM2: optionalText(row.required_area_m2) ?? '0',
      handedAreaM2: optionalText(row.handed_area_m2) ?? '0',
      targetDate: optionalText(row.target_date),
      parcels: count(row.parcels),
      parcelsNoticed: count(row.parcels_noticed),
      parcelsPaid: count(row.parcels_paid),
      parcelsHandedOver: count(row.parcels_handed_over),
    },
  ];
}

export interface Totals {
  sections: number;
  sectionsHandedOver: number;
  requiredAreaM2: string;
  handedAreaM2: string;
  parcels: number;
  parcelsNoticed: number;
  parcelsPaid: number;
  parcelsHandedOver: number;
  households: number;
  plansPosted: number;
  paymentsPaid: number;
  paymentsTotal: number;
  lateStages: number;
}

export interface Overview {
  projectId: string;
  asOf: string | null;
  totals: Totals;
  parcelsByStatus: Array<{ status: string; count: number }>;
  sections: SectionLine[];
  stages: StageLine[];
}

/** The overview of a project as the server counted it (`getLandProgress`); anything missing counts as nothing. */
export function toOverview(raw: unknown): Overview {
  const body: Raw = isRecord(raw) ? raw : {};
  const totals: Raw = isRecord(body.totals) ? body.totals : {};
  const byStatus: Raw = isRecord(body.parcels_by_status) ? body.parcels_by_status : {};
  return {
    projectId: optionalText(body.project_id) ?? '',
    asOf: optionalText(body.as_of),
    totals: {
      sections: count(totals.sections),
      sectionsHandedOver: count(totals.sections_handed_over),
      requiredAreaM2: optionalText(totals.required_area_m2) ?? '0',
      handedAreaM2: optionalText(totals.handed_area_m2) ?? '0',
      parcels: count(totals.parcels),
      parcelsNoticed: count(totals.parcels_noticed),
      parcelsPaid: count(totals.parcels_paid),
      parcelsHandedOver: count(totals.parcels_handed_over),
      households: count(totals.households),
      plansPosted: count(totals.plans_posted),
      paymentsPaid: count(totals.payments_paid),
      paymentsTotal: count(totals.payments_total),
      lateStages: count(totals.late_stages),
    },
    parcelsByStatus: Object.entries(byStatus).map(([status, n]) => ({ status, count: count(n) })),
    sections: (Array.isArray(body.sections) ? body.sections : []).flatMap(toSection),
    stages: (Array.isArray(body.stages) ? body.stages : []).flatMap((stage) => toStage(stage) ?? []),
  };
}

/** The stages that are behind their planned end, the ones the dashboard puts first. */
export const lateStages = (stages: readonly StageLine[]): StageLine[] => stages.filter((stage) => stage.status === 'LATE');

/** Whether the person may send a report: the permission, and a session that is not read-only. */
export const canReport = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions ?? []).includes(REPORT_PERMISSION);

/** A stage of mode NATIVE is counted from the data of LND and cannot be reported by hand. */
export const reportable = (stage: StageLine): boolean => stage.mode === 'TRACKED_EXTERNAL';

// ---- the form ---------------------------------------------------------------------------------------------------------------------------

export interface ReportForm {
  sectionId: string;
  stageCode: StageCode | '';
  executorKind: ExecutorKind | '';
  executorUnitId: string;
  parcelsTotal: string;
  parcelsDone: string;
  plannedStart: string;
  plannedEnd: string;
  actualStart: string;
  actualEnd: string;
  evidenceId: string;
  blockerNote: string;
}

export const EMPTY_FORM: ReportForm = {
  sectionId: '',
  stageCode: '',
  executorKind: '',
  executorUnitId: '',
  parcelsTotal: '',
  parcelsDone: '0',
  plannedStart: '',
  plannedEnd: '',
  actualStart: '',
  actualEnd: '',
  evidenceId: '',
  blockerNote: '',
};

/** The form of a stage that is already reported: the fields as they are, to be corrected. */
export const formOf = (stage: StageLine): ReportForm => ({
  sectionId: stage.sectionId,
  stageCode: stage.stageCode,
  executorKind: stage.executorKind,
  executorUnitId: stage.executorUnitId,
  parcelsTotal: String(stage.parcelsTotal),
  parcelsDone: String(stage.parcelsDone),
  plannedStart: stage.plannedStart ?? '',
  plannedEnd: stage.plannedEnd ?? '',
  actualStart: stage.actualStart ?? '',
  actualEnd: stage.actualEnd ?? '',
  evidenceId: stage.evidenceDocumentVersionId ?? '',
  blockerNote: stage.blockerNote ?? '',
});

export type FieldProblem = 'required' | 'count' | 'exceeds' | 'date' | 'order' | 'future' | 'endNeedsAll' | 'evidenceRequired' | 'evidenceInvalid' | 'tooLong';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (value: string): boolean => DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const wholeCount = (value: string): number | undefined => {
  const text = value.trim();
  const n = Number(text);
  return /^\d+$/.test(text) && Number.isInteger(n) && n <= MAX_PARCELS ? n : undefined;
};

/** What is wrong with a report, with the same rules the server judges it by; `today` is the Vietnam date. */
export function validateReport(form: ReportForm, today: string): Partial<Record<keyof ReportForm, FieldProblem>> {
  const problems: Partial<Record<keyof ReportForm, FieldProblem>> = {};
  if (form.sectionId === '') problems.sectionId = 'required';
  if (form.stageCode === '') problems.stageCode = 'required';
  if (form.executorKind === '') problems.executorKind = 'required';
  if (form.executorUnitId === '') problems.executorUnitId = 'required';
  const total = wholeCount(form.parcelsTotal);
  const done = wholeCount(form.parcelsDone);
  if (total === undefined) problems.parcelsTotal = 'count';
  if (done === undefined) problems.parcelsDone = 'count';
  if (total !== undefined && done !== undefined && done > total) problems.parcelsDone = 'exceeds';
  for (const field of ['plannedStart', 'plannedEnd', 'actualStart', 'actualEnd'] as const) {
    if (form[field] !== '' && !realDate(form[field])) problems[field] = 'date';
  }
  if (problems.plannedEnd === undefined && form.plannedStart !== '' && form.plannedEnd !== '' && form.plannedStart > form.plannedEnd) problems.plannedEnd = 'order';
  if (problems.actualStart === undefined && form.actualStart > today && form.actualStart !== '') problems.actualStart = 'future';
  if (problems.actualEnd === undefined && form.actualEnd !== '') {
    if (form.actualEnd > today) problems.actualEnd = 'future';
    else if (form.actualStart !== '' && form.actualStart > form.actualEnd) problems.actualEnd = 'order';
    else if (total !== undefined && done !== undefined && total !== done) problems.actualEnd = 'endNeedsAll';
  }
  const evidence = form.evidenceId.trim();
  if (evidence !== '' && !UUID.test(evidence)) problems.evidenceId = 'evidenceInvalid';
  else if (evidence === '' && ((done ?? 0) > 0 || form.actualEnd !== '')) problems.evidenceId = 'evidenceRequired';
  if (form.blockerNote.trim().length > MAX_NOTE) problems.blockerNote = 'tooLong';
  return problems;
}

export interface ReportBody {
  project_id: string;
  section_id: string;
  stage_code: StageCode;
  executor_kind: ExecutorKind;
  executor_unit_id: string;
  mode: 'TRACKED_EXTERNAL';
  parcels_total: number;
  parcels_done: number;
  planned_start?: string;
  planned_end?: string;
  actual_start?: string;
  actual_end?: string;
  evidence_document_version_id?: string;
  blocker_note?: string;
}

/** The body of the report of a stage tracked from outside: what is empty is left out, so the server does not read an empty text as a value. */
export function reportBody(projectId: string, form: ReportForm): ReportBody {
  const note = form.blockerNote.trim();
  const evidence = form.evidenceId.trim().toLowerCase();
  return {
    project_id: projectId,
    section_id: form.sectionId,
    stage_code: form.stageCode as StageCode,
    executor_kind: form.executorKind as ExecutorKind,
    executor_unit_id: form.executorUnitId,
    mode: 'TRACKED_EXTERNAL',
    parcels_total: Number(form.parcelsTotal.trim()),
    parcels_done: Number(form.parcelsDone.trim()),
    ...(form.plannedStart === '' ? {} : { planned_start: form.plannedStart }),
    ...(form.plannedEnd === '' ? {} : { planned_end: form.plannedEnd }),
    ...(form.actualStart === '' ? {} : { actual_start: form.actualStart }),
    ...(form.actualEnd === '' ? {} : { actual_end: form.actualEnd }),
    ...(evidence === '' ? {} : { evidence_document_version_id: evidence }),
    ...(note === '' ? {} : { blocker_note: note }),
  };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------

export type Problem = 'exceeds' | 'nativeReadonly' | 'documentNotClean' | 'validation' | 'denied' | 'notFound' | 'session' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, Problem>> = {
  PARCELS_DONE_EXCEEDS_TOTAL: 'exceeds',
  NATIVE_STAGE_READONLY: 'nativeReadonly',
  DOCUMENT_NOT_CLEAN: 'documentNotClean',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

/** What a dialog says of a refusal of the server; an unknown failure is the general message. */
export function describeProblem(error: unknown): Problem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}
