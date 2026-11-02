import { ApiError } from '@machvon/api-client';

/** The permissions of BID-07, BID-08 and BID-09 (x-permission of the operations in openapi.json); the server judges each call again, with the scope of the project and the full view of the proposal. */
export const START_PERMISSION = 'ai.analyze';
export const CANCEL_PERMISSION = 'ai.cancel';
export const RUN_READ_PERMISSION = 'analysis_run.read';
export const FINDINGS_PERMISSION = 'bid.evaluate';
export const OCR_READ_PERMISSION = 'bid.ocr.read';
export const CRITERIA_READ_PERMISSION = 'criteria_version.read';

export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'AWAITING_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED_BY_POLICY'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const FINDING_STATUSES = ['SUPPORTED', 'CONTRADICTED', 'MISSING', 'NEEDS_REVIEW'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const STEPS = ['EXTRACT', 'MATCH', 'VERIFY', 'COMPLETE'] as const;
export type Step = (typeof STEPS)[number];
export const STEP_STATES = ['DONE', 'FAILED', 'PENDING', 'SKIPPED'] as const;
export type StepState = (typeof STEP_STATES)[number];
export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const ROUTES = ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'] as const;
export type RouteClass = (typeof ROUTES)[number];
export const CONFIDENCE_TYPES = ['CALIBRATED', 'HEURISTIC', 'NONE'] as const;
export type ConfidenceType = (typeof CONFIDENCE_TYPES)[number];
export const EVIDENCE_KINDS = ['DOCUMENT', 'SCORECARD', 'DETERMINISTIC_CALC'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** The reason of a cancellation is short but not empty; the server holds the same limits. */
export const MIN_REASON = 3;
export const MAX_REASON = 1000;
/** A cost limit is a whole number of VND of at most 18 digits, as the server keeps it. */
const COST = /^(0|[1-9][0-9]{0,17})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

/** Whether the permission is held, or the permissions are not known yet (the server judges every call again). */
export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/** Whether the caller may ask for a run: the right is held and the session is not read-only. */
export const canStart = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && holds(permissions, START_PERMISSION);

/** Whether the caller is offered the cancellation: the right is held and the session is not read-only. */
export const canCancel = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && holds(permissions, CANCEL_PERMISSION);

// ---- the runs -----------------------------------------------------------------------------------------------------------------------------

export interface TimelineStep {
  step: Step;
  state: StepState;
}

export interface Run {
  id: string;
  proposalId: string;
  packageId: string;
  packageCode: string;
  contractorName: string;
  criteriaVersionId: string;
  profileVersionId: string;
  status: RunStatus;
  dataClassification: Classification;
  routeClass: RouteClass | null;
  policyVersionId: string | null;
  failureCode: string | null;
  failedStep: Step | null;
  timeline: TimelineStep[];
  supersedesRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
  cancelReason: string | null;
  /** Whole VND settled at the gateway, as the server wrote it. */
  costVnd: string | null;
  findingCount: number;
  missingSourceCount: number;
  reviewedCount: number;
  version: number;
}

function toStep(raw: unknown): TimelineStep | undefined {
  const row = asRecord(raw);
  const step = oneOf(STEPS, row?.step);
  const state = oneOf(STEP_STATES, row?.state);
  return step === undefined || state === undefined ? undefined : { step, state };
}

export function toRun(raw: unknown): Run | undefined {
  const row = asRecord(raw);
  const pack = asRecord(row?.package);
  const contractor = asRecord(row?.contractor);
  const id = text(row?.id);
  const proposalId = text(row?.proposal_id);
  const packageId = text(pack?.id);
  const status = oneOf(RUN_STATUSES, row?.status);
  const dataClassification = oneOf(CLASSIFICATIONS, row?.data_classification);
  const version = whole(row?.version);
  const startedAt = text(row?.started_at);
  if (row === undefined || id === undefined || proposalId === undefined || packageId === undefined || status === undefined || dataClassification === undefined || version === undefined || startedAt === undefined) return undefined;
  return {
    id,
    proposalId,
    packageId,
    packageCode: text(pack?.code) ?? '',
    contractorName: text(contractor?.legal_name) ?? '',
    criteriaVersionId: text(row.criteria_version_id) ?? '',
    profileVersionId: text(row.profile_version_id) ?? '',
    status,
    dataClassification,
    routeClass: oneOf(ROUTES, row.route_class) ?? null,
    policyVersionId: nullableText(row.policy_version_id),
    failureCode: nullableText(row.failure_code),
    failedStep: oneOf(STEPS, row.failed_step) ?? null,
    timeline: Array.isArray(row.timeline) ? row.timeline.flatMap((item) => toStep(item) ?? []) : [],
    supersedesRunId: nullableText(row.supersedes_run_id),
    startedAt,
    finishedAt: nullableText(row.finished_at),
    cancelReason: nullableText(row.cancel_reason),
    costVnd: nullableText(row.cost_vnd),
    findingCount: whole(row.finding_count) ?? 0,
    missingSourceCount: whole(row.missing_source_count) ?? 0,
    reviewedCount: whole(row.reviewed_count) ?? 0,
    version,
  };
}

export interface RunList {
  runs: Run[];
  nextCursor: string | undefined;
}

export function toRunList(raw: unknown): RunList {
  const body = asRecord(raw);
  return { runs: Array.isArray(body?.items) ? body.items.flatMap((item) => toRun(item) ?? []) : [], nextCursor: text(body?.next_cursor) };
}

/** The whole VND of a cost as a person reads it, by the digits of the text: no float is made of it. */
export function formatVnd(cost: string | null, locale: string): string {
  return cost === null || !/^[0-9]+$/.test(cost) ? '' : new Intl.NumberFormat(locale).format(BigInt(cost));
}

export const hasFindings = (run: Run): boolean => run.findingCount > 0;

/** A run is cancelled while it waits for the experts and none of its findings was reviewed; the server judges it again. */
export const isCancellable = (run: Run, allowed: boolean): boolean => allowed && run.status === 'AWAITING_REVIEW' && run.reviewedCount === 0;

export type ReasonProblem = 'tooShort' | 'tooLong';

/** What is wrong with the reason of a cancellation before it is sent. */
export function validateReason(reason: string): ReasonProblem | undefined {
  const length = reason.trim().length;
  if (length < MIN_REASON) return 'tooShort';
  return length > MAX_REASON ? 'tooLong' : undefined;
}

// ---- the findings -------------------------------------------------------------------------------------------------------------------------

/** The figure the pipeline computed in code, as far as the screen shows it. */
export interface Figure {
  id: string;
  kind: string;
  total: string | null;
}

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  documentVersionId: string | null;
  /** From 0; the screen shows the page as `pageIndex + 1`. */
  pageIndex: number | null;
  quote: string | null;
  figure: Figure | null;
  /** The words quoted were found on the page they name (BR-BID-07). */
  verified: boolean;
}

export interface Finding {
  id: string;
  criterionId: string;
  status: FindingStatus;
  finding: string;
  confidenceType: ConfidenceType;
  evidenceCount: number;
  missingSource: boolean;
  finalStatus: FindingStatus | null;
  evidence: Evidence[];
}

function toFigure(raw: unknown): Figure | null {
  const row = asRecord(raw);
  const id = text(row?.id);
  if (row === undefined || id === undefined) return null;
  return { id, kind: text(row.kind) ?? '', total: text(row.total) ?? text(row.bid_price_vnd) ?? null };
}

export function toEvidence(raw: unknown): Evidence | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const kind = oneOf(EVIDENCE_KINDS, row?.kind);
  if (row === undefined || id === undefined || kind === undefined) return undefined;
  return {
    id,
    kind,
    documentVersionId: nullableText(row.document_version_id),
    pageIndex: whole(row.page_index) ?? null,
    quote: nullableText(row.quote_excerpt),
    figure: toFigure(row.calc_ref),
    // Without the word of the server a citation is not shown as found: a screen that cannot tell must not vouch for a quotation.
    verified: row.verified_present === true,
  };
}

export function toFinding(raw: unknown): Finding | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const criterionId = text(row?.criterion_id);
  const status = oneOf(FINDING_STATUSES, row?.status);
  const finding = text(row?.finding);
  if (row === undefined || id === undefined || criterionId === undefined || status === undefined || finding === undefined) return undefined;
  return {
    id,
    criterionId,
    status,
    finding,
    confidenceType: oneOf(CONFIDENCE_TYPES, row.confidence_type) ?? 'NONE',
    evidenceCount: whole(row.evidence_count) ?? 0,
    missingSource: row.missing_source === true,
    finalStatus: oneOf(FINDING_STATUSES, row.final_status) ?? null,
    evidence: Array.isArray(row.evidence) ? row.evidence.flatMap((item) => toEvidence(item) ?? []) : [],
  };
}

export interface FindingList {
  run: Run | undefined;
  findings: Finding[];
  nextCursor: string | undefined;
}

export function toFindingList(raw: unknown): FindingList {
  const body = asRecord(raw);
  return { run: toRun(body?.run), findings: Array.isArray(body?.items) ? body.items.flatMap((item) => toFinding(item) ?? []) : [], nextCursor: text(body?.next_cursor) };
}

// ---- the filters --------------------------------------------------------------------------------------------------------------------------

export interface FindingFilter {
  status: FindingStatus | '';
  /** 'true' only the findings that lack a source, 'false' only the ones that do not. */
  missingSource: '' | 'true' | 'false';
}

export const NO_FINDING_FILTER: FindingFilter = { status: '', missingSource: '' };

export const hasFindingFilter = (filter: FindingFilter): boolean => filter.status !== '' || filter.missingSource !== '';

export const findingStatusFromParam = (value: string | null): FindingStatus | '' => oneOf(FINDING_STATUSES, value) ?? '';
export const missingFromParam = (value: string | null): FindingFilter['missingSource'] => (value === 'true' || value === 'false' ? value : '');
export const runStatusFromParam = (value: string | null): RunStatus | '' => oneOf(RUN_STATUSES, value) ?? '';

/** The query of the read of the findings for a filter: only what is chosen. */
export function findingQuery(filter: FindingFilter): Record<string, string> {
  return { ...(filter.status === '' ? {} : { status: filter.status }), ...(filter.missingSource === '' ? {} : { missing_source: filter.missingSource }) };
}

// ---- the configuration of a run -----------------------------------------------------------------------------------------------------------

export interface RunForm {
  proposalId: string;
  criteriaVersionId: string;
  profileVersionId: string;
  maxCostVnd: string;
}

export const EMPTY_FORM: RunForm = { proposalId: '', criteriaVersionId: '', profileVersionId: '', maxCostVnd: '' };

export type FormProblem = 'proposal' | 'criteria' | 'profile' | 'cost';

/** What is wrong with the form before it is sent. */
export function validateForm(form: RunForm): FormProblem | undefined {
  if (!UUID.test(form.proposalId)) return 'proposal';
  if (!UUID.test(form.criteriaVersionId)) return 'criteria';
  if (!UUID.test(form.profileVersionId.trim())) return 'profile';
  return form.maxCostVnd.trim() === '' || COST.test(form.maxCostVnd.trim()) ? undefined : 'cost';
}

export interface StartBody {
  proposal_id: string;
  criteria_version_id: string;
  profile_version_id: string;
  max_cost_vnd?: string;
}

/** The body of the request: the cost limit only when there is one. The class of the data and the route are the server's and are not asked. */
export function startBody(form: RunForm): StartBody {
  const cost = form.maxCostVnd.trim();
  return {
    proposal_id: form.proposalId,
    criteria_version_id: form.criteriaVersionId,
    profile_version_id: form.profileVersionId.trim().toLowerCase(),
    ...(cost === '' ? {} : { max_cost_vnd: cost }),
  };
}

export interface Started {
  runId: string;
  status: string;
  /** The same input was run before: this is that run. */
  reused: boolean;
  failureCode: string | null;
}

export function toStarted(raw: unknown): Started | undefined {
  const row = asRecord(raw);
  const runId = text(row?.resource_id);
  const status = text(row?.status);
  return row === undefined || runId === undefined || status === undefined ? undefined : { runId, status, reused: row.reused === true, failureCode: nullableText(row.failure_code) };
}

/** A run whose request the gateway refused or whose answer was not used ended without findings. */
export const endedWithoutAnswer = (status: string): boolean => status === 'FAILED' || status === 'REJECTED_BY_POLICY';

export type FailureKind = 'routeExhausted' | 'noCitation' | 'outputInvalid' | 'routeNotAllowed' | 'costAboveLimit' | 'budget' | 'killSwitch' | 'invalidJson' | 'other';

/** Why a run ended without an answer, from the code the pipeline recorded. */
export function failureKind(code: string | null): FailureKind | undefined {
  switch (code) {
    case null:
      return undefined;
    case 'AI_ROUTE_EXHAUSTED':
      return 'routeExhausted';
    case 'REJECTED_NO_CITATION':
      return 'noCitation';
    case 'OUTPUT_INVALID':
      return 'outputInvalid';
    case 'AI_ROUTE_NOT_ALLOWED':
      return 'routeNotAllowed';
    case 'COST_ABOVE_LIMIT':
      return 'costAboveLimit';
    case 'BUDGET_EXCEEDED':
    case 'BUDGET_APPROVAL_REQUIRED':
      return 'budget';
    case 'AI_KILL_SWITCH_ENGAGED':
      return 'killSwitch';
    case 'INVALID_JSON':
      return 'invalidJson';
    default:
      return 'other';
  }
}

// ---- refusals -----------------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'undeclared'
  | 'ocrPending'
  | 'ocrNotRecorded'
  | 'criteriaState'
  | 'profile'
  | 'tools'
  | 'routeNotAllowed'
  | 'budget'
  | 'killSwitch'
  | 'validation'
  | 'notFound'
  | 'state'
  | 'conflict'
  | 'denied'
  | 'session'
  | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'CONFLICT_UNDECLARED':
      return 'undeclared';
    case 'OCR_REVIEW_PENDING':
      return 'ocrPending';
    case 'OCR_NOT_RECORDED':
      return 'ocrNotRecorded';
    case 'CRITERIA_STATE_INVALID':
      return 'criteriaState';
    case 'PROFILE_NOT_PUBLISHED':
      return 'profile';
    case 'TOOL_NOT_READ_ONLY':
      return 'tools';
    case 'AI_ROUTE_NOT_ALLOWED':
      return 'routeNotAllowed';
    case 'BUDGET_EXCEEDED':
      return 'budget';
    case 'AI_KILL_SWITCH_ENGAGED':
      return 'killSwitch';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'ANALYSIS_STATE_INVALID':
      return 'state';
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}

/**
 * Whether the server kept the refusal as the run it ended (the budget is spent, or the switch of the task is engaged): the same request is answered with the same refusal, so a request asked again once the budget
 * or the switch has changed is a new one.
 */
export function isCommittedRefusal(error: unknown): boolean {
  return error instanceof ApiError && ((error.status === 429 && error.code === 'BUDGET_EXCEEDED') || (error.status === 503 && error.code === 'AI_KILL_SWITCH_ENGAGED'));
}

/** How a failed read of a run is told to the person: a run that does not exist for the caller, or one they owe the declaration of conflict for; anything else is for the standard states. */
export function readFailure(error: unknown): 'notFound' | 'undeclared' | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === 'CONFLICT_UNDECLARED') return 'undeclared';
  return error.status === 404 ? 'notFound' : undefined;
}

// ---- the addresses -------------------------------------------------------------------------------------------------------------------------

export const progressPath = (runId: string): string => `/bid/bid-08?run=${encodeURIComponent(runId)}`;
export const workbenchPath = (runId: string): string => `/bid/bid-09?run=${encodeURIComponent(runId)}`;
export const configPath = (packageId: string, proposalId: string): string => `/bid/bid-07?package=${encodeURIComponent(packageId)}&proposal=${encodeURIComponent(proposalId)}`;
