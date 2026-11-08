import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';

/**
 * The AI assistant screens (LLM-22 to LLM-27, lane AI-2): the shapes of what the API returns, read with a check (a wrong shape is an error of the read, never an empty screen), the rules a form applies before it
 * sends (the same limits as the contract), the weighted total of a contract evaluation (the same integer formula as the server) and how a refusal is told apart. Pure functions only.
 */

type Schemas = components['schemas'];
export type CreateRunBody = Schemas['AiAssistRunCreate'];
export type DecisionBody = Schemas['AiAssistDecisionRequest'];
export type ChecklistBody = Schemas['AiReviewChecklistCreate'];
export type CriteriaBody = Schemas['AiEvalCriteriaSetCreate'];
export type AttestBody = Schemas['LlmProviderAttest'];
export type ExceptionRequestBody = Schemas['AiExternalExceptionRequest'];
export type ExceptionDecisionBody = Schemas['AiExternalExceptionDecision'];
export type ExceptionRevokeBody = Schemas['AiExternalExceptionRevoke'];

// ---- the permissions the screens ask for ------------------------------------------------------------------------------------------------------------------------------

export const ASSIST_USE = 'ai.assist.use';
export const ASSIST_REVIEW = 'ai.assist.review';
export const ASSIST_EVALUATE = 'ai.assist.evaluate';
export const ASSIST_DECIDE = 'ai.assist.decide';
export const CONFIG_READ = 'ai.config.read';
export const CONFIG_MANAGE = 'ai.config.manage';
export const CONFIG_APPROVE = 'ai.config.approve';
export const PROVIDER_READ = 'llm.provider.read';
export const PROVIDER_MANAGE = 'llm.provider.manage';
export const EXCEPTION_REQUEST = 'llm.exception.request';
export const EXCEPTION_APPROVE = 'llm.exception.approve';
export const EXCEPTION_READ = 'llm.exception.read';

/** The addresses the screens link to (the route table gives every screen the path `/<module>/<id>`). */
export const PATHS = { assistant: '/llm/llm-22', run: '/llm/llm-23' } as const;

// ---- the enumerations of the contract ------------------------------------------------------------------------------------------------------------------------------------

export const FREE_KINDS = ['QA', 'SUMMARY', 'DRAFT_NOTE', 'FEASIBILITY'] as const;
export const RUN_KINDS = [...FREE_KINDS, 'DOC_REVIEW', 'CONTRACT_EVAL'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const SOURCE_KINDS = ['PROJECT', 'CONTRACT', 'DOCUMENT_VERSION', 'APPRAISAL'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const ROUTE_CLASSES = ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];
export const RUN_STATUSES = ['COMPLETED', 'REFUSED', 'FAILED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const COMPLETENESS = ['FULL', 'PARTIAL', 'NONE'] as const;
export type Completeness = (typeof COMPLETENESS)[number];
export const PRESENTED_AS = ['SOURCE', 'ASSUMPTION', 'INFERENCE', 'UNSUPPORTED'] as const;
export type PresentedAs = (typeof PRESENTED_AS)[number];
export const VERIFICATIONS = ['VERIFIED', 'UNSUPPORTED', 'ASSUMPTION_OPEN'] as const;
export type Verification = (typeof VERIFICATIONS)[number];
export const DECISIONS = ['ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED'] as const;
export type Decision = (typeof DECISIONS)[number];
export const CHECK_KINDS = ['REQUIRED_TERMS', 'MIN_WORDS', 'PATTERN', 'AI_QUESTION'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export const SEVERITIES = ['BLOCKER', 'WARNING', 'INFO'] as const;
export type CheckSeverity = (typeof SEVERITIES)[number];
export const REVIEW_RESULTS = ['PASS', 'FAIL', 'UNKNOWN'] as const;
export type ReviewResult = (typeof REVIEW_RESULTS)[number];
export const REVIEW_BY = ['COMPUTED', 'ASSISTANT'] as const;
export type ReviewBy = (typeof REVIEW_BY)[number];
export const VERDICTS = ['READY', 'NEEDS_ATTENTION', 'NOT_READY'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const SCORE_STATUSES = ['PROPOSED', 'NEEDS_EVIDENCE', 'NOT_ASSESSED', 'OUT_OF_SCALE'] as const;
export type ScoreStatus = (typeof SCORE_STATUSES)[number];
export const FEASIBILITY_SECTIONS = ['MARKET', 'TECHNICAL', 'FINANCIAL', 'LEGAL', 'ENVIRONMENT', 'RISK', 'ALTERNATIVES'] as const;
export const CONFIG_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type ConfigStatus = (typeof CONFIG_STATUSES)[number];
export const EXCEPTION_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];
export const ROUTINGS = ['ALLOWED', 'EXCEPTION_REQUIRED'] as const;
export type ExternalRouting = (typeof ROUTINGS)[number];
export const MATCHES = ['ALL', 'ANY'] as const;
export type TermMatch = (typeof MATCHES)[number];

/** Every code of a refusal the screens name; a code outside the list is shown with the generic sentence. */
export const KNOWN_CODES = [
  'AI_ASSIST_SOURCE_NOT_READABLE',
  'CHECKLIST_NOT_PUBLISHED',
  'CRITERIA_NOT_PUBLISHED',
  'AI_ROUTE_NOT_ALLOWED',
  'AI_EXTERNAL_EXCEPTION_REQUIRED',
  'BUDGET_EXCEEDED',
  'AI_KILL_SWITCH_ENGAGED',
  'SCOPE_DENIED',
  'AI_ASSIST_ALREADY_DECIDED',
  'AI_STATEMENT_UNSUPPORTED',
  'AI_EVALUATION_INCOMPLETE',
  'CRITERIA_WEIGHTS_INVALID',
  'SELF_APPROVAL_DENIED',
  'VERSION_CONFLICT',
  'VALIDATION_FAILED',
  'CHECKLIST_DRAFT_EXISTS',
  'CRITERIA_DRAFT_EXISTS',
  'EXCEPTION_REQUEST_OPEN',
  'STAGE_TRANSITION_DENIED',
  'CLASSIFICATION_ABOVE_PROVIDER',
  'OUTPUT_INVALID',
  'RESOURCE_NOT_FOUND',
] as const;

/** The key part of an enumeration value: `ACCEPTED_WITH_CHANGE` becomes `acceptedWithChange` (the keys of the catalogue are lower camel case). */
export function camelKey(value: string): string {
  return value
    .toLowerCase()
    .split(/[_.-]/)
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`))
    .join('');
}

// ---- reading an answer -------------------------------------------------------------------------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const rec = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const int = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => (typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined);
const strings = (value: unknown): string[] => arr(value).filter((entry): entry is string => typeof entry === 'string');
const unexpected = (what: string): Error => new Error(`unexpected ${what}`);

export interface Citation {
  kind: string;
  id: string;
  locator: string;
  quote: string | null;
  excerpt: string;
  title: string;
}

function toCitation(raw: unknown): Citation | undefined {
  const row = rec(raw);
  const id = str(row?.id);
  if (row === undefined || id === undefined) return undefined;
  return { kind: str(row.kind) ?? '', id, locator: str(row.locator) ?? '', quote: strOrNull(row.quote), excerpt: str(row.excerpt) ?? '', title: str(row.title) ?? '' };
}

const citations = (value: unknown): Citation[] => arr(value).flatMap((entry) => toCitation(entry) ?? []);

export interface Statement {
  id: string;
  text: string;
  claimedBasis: string;
  /** What the statement is shown as; a label this screen does not know is shown as unsupported, never as a fact. */
  presentedAs: PresentedAs;
  verification: Verification;
  citations: Citation[];
  dependsOn: string[];
  problems: string[];
  section: string | null;
  itemCode: string | null;
  criterionCode: string | null;
  result: ReviewResult | null;
  score: number | null;
}

function toStatement(raw: unknown): Statement {
  const row = rec(raw);
  const id = str(row?.id);
  const text = str(row?.text);
  if (row === undefined || id === undefined || text === undefined) throw unexpected('statement');
  return {
    id,
    text,
    claimedBasis: str(row.claimed_basis) ?? '',
    presentedAs: oneOf(PRESENTED_AS, row.presented_as) ?? 'UNSUPPORTED',
    verification: oneOf(VERIFICATIONS, row.verification) ?? 'UNSUPPORTED',
    citations: citations(row.citations),
    dependsOn: strings(row.depends_on),
    problems: strings(row.problems),
    section: strOrNull(row.section),
    itemCode: strOrNull(row.item_code),
    criterionCode: strOrNull(row.criterion_code),
    result: oneOf(REVIEW_RESULTS, row.result) ?? null,
    score: int(row.score) ?? null,
  };
}

/** A statement without a verified basis: it is shown struck through and flagged, and it can never be kept. */
export const isUnsupported = (statement: Statement): boolean => statement.presentedAs === 'UNSUPPORTED' || statement.verification === 'UNSUPPORTED';

export interface StatementGroup {
  basis: PresentedAs;
  statements: Statement[];
}

/** The statements grouped by what they are shown as, in the order a reader trusts them: sources, then assumptions, then inferences, and the unsupported ones last. Empty groups are left out. */
export function groupStatements(statements: readonly Statement[]): StatementGroup[] {
  return PRESENTED_AS.map((basis) => ({ basis, statements: statements.filter((statement) => statement.presentedAs === basis) })).filter((group) => group.statements.length > 0);
}

export interface ReviewItem {
  itemCode: string;
  label: string;
  kind: CheckKind | null;
  severity: CheckSeverity;
  result: ReviewResult;
  by: ReviewBy;
  detail: string | null;
  citations: Citation[];
}

export interface ReviewView {
  items: ReviewItem[];
  verdict: Verdict;
  counts: { pass: number; fail: number; unknown: number; blockersOpen: number };
}

function toReview(raw: unknown): ReviewView | undefined {
  const row = rec(raw);
  if (row === undefined || !Array.isArray(row.items)) return undefined;
  const counts = rec(row.counts);
  return {
    items: row.items.flatMap((entry): ReviewItem[] => {
      const item = rec(entry);
      const code = str(item?.item_code);
      if (item === undefined || code === undefined) return [];
      return [
        {
          itemCode: code,
          label: str(item.label) ?? code,
          kind: oneOf(CHECK_KINDS, item.kind) ?? null,
          severity: oneOf(SEVERITIES, item.severity) ?? 'WARNING',
          // A result the screen does not know is "not proven": it is never read as a pass.
          result: oneOf(REVIEW_RESULTS, item.result) ?? 'UNKNOWN',
          by: oneOf(REVIEW_BY, item.by) ?? 'ASSISTANT',
          detail: strOrNull(item.detail),
          citations: citations(item.citations),
        },
      ];
    }),
    verdict: oneOf(VERDICTS, row.verdict) ?? 'NEEDS_ATTENTION',
    counts: { pass: int(counts?.pass) ?? 0, fail: int(counts?.fail) ?? 0, unknown: int(counts?.unknown) ?? 0, blockersOpen: int(counts?.blockers_open) ?? 0 },
  };
}

export interface CriterionProposal {
  code: string;
  label: string;
  weightBp: number;
  proposedScore: number | null;
  status: ScoreStatus;
  citations: Citation[];
}

export interface EvaluationView {
  scaleMax: number;
  setCode: string | null;
  criteria: CriterionProposal[];
}

function toEvaluation(raw: unknown): EvaluationView | undefined {
  const row = rec(raw);
  const scaleMax = int(row?.scale_max);
  if (row === undefined || scaleMax === undefined || !Array.isArray(row.criteria)) return undefined;
  return {
    scaleMax,
    setCode: str(rec(row.criteria_set)?.code) ?? null,
    criteria: row.criteria.flatMap((entry): CriterionProposal[] => {
      const item = rec(entry);
      const code = str(item?.criterion_code);
      const weight = int(item?.weight_bp);
      if (item === undefined || code === undefined || weight === undefined) return [];
      return [
        {
          code,
          label: str(item.label) ?? code,
          weightBp: weight,
          proposedScore: int(item.proposed_score) ?? null,
          status: oneOf(SCORE_STATUSES, item.status) ?? 'NOT_ASSESSED',
          citations: citations(item.citations),
        },
      ];
    }),
  };
}

export interface AcceptedResult {
  keptStatements: string[] | null;
  scores: Record<string, number> | null;
  total: string | null;
}

export interface DecisionView {
  id: string;
  decision: Decision;
  rationale: string;
  decidedBy: string;
  decidedAt: string;
  accepted: AcceptedResult;
}

function toDecision(raw: unknown): DecisionView | null {
  const row = rec(raw);
  const decision = oneOf(DECISIONS, row?.decision);
  if (row === undefined || decision === undefined) return null;
  const accepted = rec(row.accepted_result);
  const scores = rec(accepted?.scores);
  return {
    id: str(row.id) ?? '',
    decision,
    rationale: str(row.rationale) ?? '',
    decidedBy: str(row.decided_by) ?? '',
    decidedAt: str(row.decided_at) ?? '',
    accepted: {
      keptStatements: Array.isArray(accepted?.kept_statements) ? strings(accepted?.kept_statements) : null,
      scores: scores === undefined ? null : Object.fromEntries(Object.entries(scores).flatMap(([code, value]) => (typeof value === 'number' ? [[code, value]] : []))),
      total: str(accepted?.total) ?? null,
    },
  };
}

export interface RunSource {
  kind: string;
  id: string;
  title: string;
  classification: Classification | null;
}

export interface RunCounts {
  statements: number;
  verified: number;
  unsupported: number;
  assumptions: number;
  withheldCitations: number;
  injectionSignals: number;
}

export interface AssistRun {
  id: string;
  kind: RunKind;
  status: RunStatus;
  refusalCode: string | null;
  requestText: string;
  subjectId: string | null;
  checklistId: string | null;
  criteriaSetId: string | null;
  aiRequestId: string | null;
  classification: Classification | null;
  routeClass: RouteClass | null;
  sources: RunSource[];
  statements: Statement[];
  counts: RunCounts;
  completeness: Completeness;
  decision: DecisionView | null;
  /** The decision on record, also for a row of the list (which carries the status of the decision and not the decision itself). */
  decisionStatus: Decision | null;
  askedBy: string | null;
  createdAt: string;
  review: ReviewView | undefined;
  evaluation: EvaluationView | undefined;
  openQuestions: string[];
  missingSections: string[];
  truncated: boolean;
}

export function toRun(raw: unknown): AssistRun {
  const row = rec(raw);
  const id = str(row?.id);
  const kind = oneOf(RUN_KINDS, row?.kind);
  const status = oneOf(RUN_STATUSES, row?.status);
  const counts = rec(row?.counts);
  if (row === undefined || id === undefined || kind === undefined || status === undefined || !Array.isArray(row.statements) || counts === undefined) throw unexpected('run');
  const result = rec(row.result) ?? {};
  return {
    id,
    kind,
    status,
    refusalCode: strOrNull(row.refusal_code),
    requestText: str(row.request_text) ?? '',
    subjectId: strOrNull(row.subject_id),
    checklistId: strOrNull(row.checklist_id),
    criteriaSetId: strOrNull(row.criteria_set_id),
    aiRequestId: strOrNull(row.ai_request_id),
    classification: oneOf(CLASSIFICATIONS, row.data_classification) ?? null,
    routeClass: oneOf(ROUTE_CLASSES, row.route_class) ?? null,
    sources: arr(row.sources).flatMap((entry): RunSource[] => {
      const source = rec(entry);
      const sourceId = str(source?.id);
      return source === undefined || sourceId === undefined ? [] : [{ kind: str(source.kind) ?? '', id: sourceId, title: str(source.title) ?? '', classification: oneOf(CLASSIFICATIONS, source.classification) ?? null }];
    }),
    statements: row.statements.map(toStatement),
    counts: {
      statements: int(counts.statements) ?? 0,
      verified: int(counts.verified) ?? 0,
      unsupported: int(counts.unsupported) ?? 0,
      assumptions: int(counts.assumptions) ?? 0,
      withheldCitations: int(counts.withheld_citations) ?? 0,
      injectionSignals: int(counts.injection_signals) ?? 0,
    },
    completeness: oneOf(COMPLETENESS, row.completeness) ?? 'NONE',
    decision: toDecision(row.decision),
    decisionStatus: oneOf(DECISIONS, row.decision_status) ?? toDecision(row.decision)?.decision ?? null,
    askedBy: strOrNull(row.asked_by),
    createdAt: str(row.created_at) ?? '',
    review: toReview(result.review),
    evaluation: toEvaluation(result.evaluation),
    openQuestions: strings(result.open_questions),
    missingSections: strings(rec(result.coverage)?.missing),
    truncated: result.truncated === true,
  };
}

export interface RunPage {
  items: AssistRun[];
  next: string | undefined;
  asOf: string | undefined;
}

export function toRunPage(raw: unknown): RunPage {
  const row = rec(raw);
  if (row === undefined || !Array.isArray(row.items)) throw unexpected('page of runs');
  return { items: row.items.map(toRun), next: str(row.next_cursor), asOf: str(row.as_of) };
}

export interface RunFilter {
  kind: RunKind | '';
  status: RunStatus | '';
}

export const NO_FILTER: RunFilter = { kind: '', status: '' };
export const filterQuery = (filter: RunFilter): { kind?: RunKind; status?: RunStatus } => ({ ...(filter.kind === '' ? {} : { kind: filter.kind }), ...(filter.status === '' ? {} : { status: filter.status }) });

// ---- the checklists and the sets of criteria ------------------------------------------------------------------------------------------------------------------

export interface ChecklistItemView {
  code: string;
  label: string;
  kind: CheckKind;
  severity: CheckSeverity;
  params: Raw;
}

export interface Checklist {
  id: string;
  code: string;
  revision: number;
  title: string;
  appliesTo: string;
  status: ConfigStatus;
  items: ChecklistItemView[];
  createdBy: string;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  version: number;
}

export function toChecklist(raw: unknown): Checklist | undefined {
  const row = rec(raw);
  const id = str(row?.id);
  const code = str(row?.code);
  const status = oneOf(CONFIG_STATUSES, row?.status);
  const version = int(row?.version);
  if (row === undefined || id === undefined || code === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    code,
    revision: int(row.revision) ?? 1,
    title: str(row.title) ?? code,
    appliesTo: str(row.applies_to) ?? '',
    status,
    items: arr(row.items).flatMap((entry): ChecklistItemView[] => {
      const item = rec(entry);
      const itemCode = str(item?.code);
      const kind = oneOf(CHECK_KINDS, item?.kind);
      if (item === undefined || itemCode === undefined || kind === undefined) return [];
      return [{ code: itemCode, label: str(item.label) ?? itemCode, kind, severity: oneOf(SEVERITIES, item.severity) ?? 'WARNING', params: rec(item.params) ?? {} }];
    }),
    createdBy: str(row.created_by) ?? '',
    createdAt: str(row.created_at) ?? '',
    publishedBy: strOrNull(row.published_by),
    publishedAt: strOrNull(row.published_at),
    version,
  };
}

export interface CriterionView {
  code: string;
  label: string;
  guidance: string;
  weightBp: number;
  evidenceRequired: boolean;
}

export interface CriteriaSet {
  id: string;
  code: string;
  revision: number;
  title: string;
  scaleMax: number;
  status: ConfigStatus;
  criteria: CriterionView[];
  weightsTotalBp: number;
  createdBy: string;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  version: number;
}

export function toCriteriaSet(raw: unknown): CriteriaSet | undefined {
  const row = rec(raw);
  const id = str(row?.id);
  const code = str(row?.code);
  const status = oneOf(CONFIG_STATUSES, row?.status);
  const version = int(row?.version);
  if (row === undefined || id === undefined || code === undefined || status === undefined || version === undefined) return undefined;
  const criteria = arr(row.criteria).flatMap((entry): CriterionView[] => {
    const item = rec(entry);
    const itemCode = str(item?.code);
    const weight = int(item?.weight_bp);
    if (item === undefined || itemCode === undefined || weight === undefined) return [];
    return [{ code: itemCode, label: str(item.label) ?? itemCode, guidance: str(item.guidance) ?? '', weightBp: weight, evidenceRequired: item.evidence_required !== false }];
  });
  return {
    id,
    code,
    revision: int(row.revision) ?? 1,
    title: str(row.title) ?? code,
    scaleMax: int(row.scale_max) ?? 100,
    status,
    criteria,
    weightsTotalBp: int(row.weights_total_bp) ?? criteria.reduce((sum, criterion) => sum + criterion.weightBp, 0),
    createdBy: str(row.created_by) ?? '',
    createdAt: str(row.created_at) ?? '',
    publishedBy: strOrNull(row.published_by),
    publishedAt: strOrNull(row.published_at),
    version,
  };
}

// ---- providers, exceptions, edition policy -------------------------------------------------------------------------------------------------------------------------

export interface ProviderRow {
  id: string;
  code: string;
  name: string;
  route: RouteClass;
  maxClassification: Classification | null;
  status: string;
  country: string | null;
  locationDetail: string | null;
  noTrainingAttested: boolean | null;
  attestationRef: string | null;
  attestedBy: string | null;
  attestedAt: string | null;
  version: number;
}

export function toProviderRow(raw: unknown): ProviderRow | undefined {
  const row = rec(raw);
  const id = str(row?.id);
  const code = str(row?.provider_code);
  const route = oneOf(ROUTE_CLASSES, row?.route_class);
  const version = int(row?.version);
  if (row === undefined || id === undefined || code === undefined || route === undefined || version === undefined) return undefined;
  return {
    id,
    code,
    name: str(row.name) ?? code,
    route,
    maxClassification: oneOf(CLASSIFICATIONS, row.max_classification) ?? null,
    status: str(row.status) ?? '',
    country: strOrNull(row.data_location_country),
    locationDetail: strOrNull(row.data_location_detail),
    noTrainingAttested: typeof row.no_training_attested === 'boolean' ? row.no_training_attested : null,
    attestationRef: strOrNull(row.attestation_ref),
    attestedBy: strOrNull(row.attested_by),
    attestedAt: strOrNull(row.attested_at),
    version,
  };
}

/** An external provider is any provider whose route leaves the servers of the customer. */
export const isExternal = (provider: ProviderRow): boolean => provider.route !== 'SELF_HOSTED';
export const isAttested = (provider: ProviderRow): boolean => provider.attestedAt !== null;

export interface ExceptionUse {
  id: string;
  aiRequestId: string;
  taskType: string;
  classification: Classification | null;
  routeClass: RouteClass | null;
  usedAt: string;
}

export interface ExceptionRow {
  id: string;
  providerId: string;
  providerCode: string;
  routeClass: RouteClass | null;
  taskType: string | null;
  maxClassification: Classification | null;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  requestedDays: number;
  status: ExceptionStatus;
  inForce: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  approvalRef: string | null;
  validFrom: string | null;
  validUntil: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  useCount: number;
  uses: ExceptionUse[];
  version: number;
}

export function toException(raw: unknown): ExceptionRow | undefined {
  const row = rec(raw);
  const id = str(row?.id);
  const status = oneOf(EXCEPTION_STATUSES, row?.status);
  const version = int(row?.version);
  if (row === undefined || id === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    providerId: str(row.provider_id) ?? '',
    providerCode: str(row.provider_code) ?? '',
    routeClass: oneOf(ROUTE_CLASSES, row.route_class) ?? null,
    taskType: strOrNull(row.task_type),
    maxClassification: oneOf(CLASSIFICATIONS, row.max_classification) ?? null,
    reason: str(row.reason) ?? '',
    requestedBy: str(row.requested_by) ?? '',
    requestedAt: str(row.requested_at) ?? '',
    requestedDays: int(row.requested_valid_days) ?? 0,
    status,
    inForce: row.in_force === true,
    decidedBy: strOrNull(row.decided_by),
    decidedAt: strOrNull(row.decided_at),
    decisionNote: strOrNull(row.decision_note),
    approvalRef: strOrNull(row.approval_ref),
    validFrom: strOrNull(row.valid_from),
    validUntil: strOrNull(row.valid_until),
    revokedBy: strOrNull(row.revoked_by),
    revokedAt: strOrNull(row.revoked_at),
    revokeReason: strOrNull(row.revoke_reason),
    useCount: int(row.use_count) ?? 0,
    uses: arr(row.uses).flatMap((entry): ExceptionUse[] => {
      const use = rec(entry);
      const useId = str(use?.id);
      return use === undefined || useId === undefined
        ? []
        : [{ id: useId, aiRequestId: str(use.ai_request_id) ?? '', taskType: str(use.task_type) ?? '', classification: oneOf(CLASSIFICATIONS, use.data_classification) ?? null, routeClass: oneOf(ROUTE_CLASSES, use.route_class) ?? null, usedAt: str(use.used_at) ?? '' }];
    }),
    version,
  };
}

export interface EditionPolicy {
  name: string;
  externalRouting: ExternalRouting;
  attestationRequired: boolean;
}

export function toEditionPolicy(raw: unknown): EditionPolicy {
  const row = rec(raw);
  const routing = oneOf(ROUTINGS, row?.external_routing);
  if (row === undefined || routing === undefined) throw unexpected('edition policy');
  return { name: str(row.name) ?? '', externalRouting: routing, attestationRequired: row.attestation_required === true };
}

// ---- time, ids, numbers -------------------------------------------------------------------------------------------------------------------------------------------------------

const VIETNAM_OFFSET_MS = 7 * 3_600_000;

/** An instant as the people of the screen read it: the Vietnam day and minute ("08/11/2026 14:05"); an unreadable value is shown as it came, a missing one as an empty text. */
export function stamp(instant: string | null | undefined): string {
  if (instant === null || instant === undefined || instant === '') return '';
  const moment = Date.parse(instant);
  if (Number.isNaN(moment)) return instant;
  const text = new Date(moment + VIETNAM_OFFSET_MS).toISOString();
  return `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)} ${text.slice(11, 16)}`;
}

/** The beginning of an id, enough to tell two apart in a table. */
export const shortId = (id: string): string => id.slice(0, 8);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value.trim());

/** A weight in basis points as a percent with two places, from integers only: 2550 is "25.50%". */
export function bpPercent(bp: number): string {
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`;
}

export const WEIGHT_TOTAL_BP = 10_000;

export function weightsTotal(weights: readonly number[]): number {
  return weights.reduce((sum, weight) => sum + weight, 0);
}

/**
 * The weighted total of the scores a person accepted, in the units of the scale with two places ("78.50"), rounded half up. The same integer formula as the server, `sum(weight_bp * score) / 100` rounded half up:
 * a total is only given when every criterion has a whole score within the scale, otherwise it is null (never a guess).
 */
export function weightedTotal(weights: ReadonlyArray<{ code: string; weightBp: number }>, scores: ReadonlyMap<string, number>, scaleMax: number): string | null {
  let sum = 0;
  for (const criterion of weights) {
    const score = scores.get(criterion.code);
    if (score === undefined || !Number.isInteger(score) || score < 0 || score > scaleMax) return null;
    sum += criterion.weightBp * score;
  }
  const hundredths = Math.floor((sum + 50) / 100);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

// ---- the form of a question ----------------------------------------------------------------------------------------------------------------------------------------------------

export const MAX_SOURCES = 20;
export const MAX_REQUEST_CHARS = 4000;
export const MIN_RATIONALE = 20;
export const MIN_NOTE = 10;

export interface SourceRef {
  kind: SourceKind;
  id: string;
}

export type SourceProblem = 'INVALID_ID' | 'DUPLICATE' | 'TOO_MANY';

/** Adds a source to the list the question will read: a uuid of a kind, not twice, at most twenty. */
export function addSource(list: readonly SourceRef[], kind: SourceKind, id: string): { list: SourceRef[]; problem?: SourceProblem } {
  const clean = id.trim().toLowerCase();
  if (!isUuid(clean)) return { list: [...list], problem: 'INVALID_ID' };
  if (list.some((entry) => entry.kind === kind && entry.id === clean)) return { list: [...list], problem: 'DUPLICATE' };
  if (list.length >= MAX_SOURCES) return { list: [...list], problem: 'TOO_MANY' };
  return { list: [...list, { kind, id: clean }] };
}

export const removeSource = (list: readonly SourceRef[], position: number): SourceRef[] => list.filter((_, index) => index !== position);

export function subjectFromQuery(search: string): SourceRef | undefined {
  const params = new URLSearchParams(search);
  const kind = oneOf(SOURCE_KINDS, params.get('subject_kind'));
  const id = (params.get('subject_id') ?? '').trim().toLowerCase();
  return kind === undefined || !isUuid(id) ? undefined : { kind, id };
}

export type RunProblem = 'TEXT_REQUIRED' | 'TEXT_TOO_LONG' | 'SOURCES_REQUIRED' | 'CHECKLIST_REQUIRED' | 'CRITERIA_REQUIRED' | 'DOCUMENT_REQUIRED' | 'CONTRACT_REQUIRED' | 'COST_INVALID' | 'SUBJECT_INVALID';

export interface RunForm {
  kind: RunKind;
  text: string;
  sources: readonly SourceRef[];
  subject: SourceRef | undefined;
  /** The id typed in the subject field when it is not a valid reference yet. */
  subjectDraft?: string;
  checklistId: string;
  criteriaSetId: string;
  maxCost: string;
}

const COST = /^(0|[1-9][0-9]{0,17})$/;

/** What stops a question from being sent: the rules the contract keeps, told before the request leaves. */
export function validateRun(form: RunForm): RunProblem[] {
  const problems: RunProblem[] = [];
  const text = form.text.trim();
  if ((FREE_KINDS as readonly string[]).includes(form.kind) && text === '') problems.push('TEXT_REQUIRED');
  if ([...text].length > MAX_REQUEST_CHARS) problems.push('TEXT_TOO_LONG');
  if (form.sources.length === 0) problems.push('SOURCES_REQUIRED');
  if (form.kind === 'DOC_REVIEW') {
    if (form.checklistId === '') problems.push('CHECKLIST_REQUIRED');
    if (!form.sources.some((source) => source.kind === 'DOCUMENT_VERSION')) problems.push('DOCUMENT_REQUIRED');
  }
  if (form.kind === 'CONTRACT_EVAL') {
    if (form.criteriaSetId === '') problems.push('CRITERIA_REQUIRED');
    if (!form.sources.some((source) => source.kind === 'CONTRACT')) problems.push('CONTRACT_REQUIRED');
  }
  if (form.maxCost.trim() !== '' && !COST.test(form.maxCost.trim())) problems.push('COST_INVALID');
  return problems;
}

export function runBody(form: RunForm): CreateRunBody {
  const text = form.text.trim();
  const cost = form.maxCost.trim();
  return {
    kind: form.kind,
    ...(text === '' ? {} : { request_text: text }),
    sources: form.sources.map((source) => ({ kind: source.kind, id: source.id })),
    ...(form.subject === undefined ? {} : { subject: { kind: form.subject.kind, id: form.subject.id } }),
    ...(form.kind === 'DOC_REVIEW' ? { checklist_id: form.checklistId } : {}),
    ...(form.kind === 'CONTRACT_EVAL' ? { criteria_set_id: form.criteriaSetId } : {}),
    ...(cost === '' ? {} : { max_cost_vnd: cost }),
  };
}

// ---- the decision of a person --------------------------------------------------------------------------------------------------------------------------------------------

export const rationaleOk = (text: string): boolean => [...text.trim()].length >= MIN_RATIONALE;

export type DecisionItemBody = NonNullable<DecisionBody['items']>[number];

/** The statements a person drops: every supported statement that is not kept. An unsupported statement is never in the list (it is not kept whatever is asked: the server refuses to keep it). */
export function dropItems(statements: readonly Statement[], kept: ReadonlySet<string>): DecisionItemBody[] {
  return statements.filter((statement) => !isUnsupported(statement) && !kept.has(statement.id)).map((statement) => ({ item_key: statement.id, action: 'DROP' as const }));
}

export type StatementDecisionProblem = 'RATIONALE_SHORT' | 'NOTHING_DROPPED';

/** The body of a decision on a run with statements: accept, accept with the statements the person dropped, or reject. */
export function statementDecision(decision: Decision, statements: readonly Statement[], kept: ReadonlySet<string>, rationale: string): { body?: DecisionBody; problem?: StatementDecisionProblem } {
  if (!rationaleOk(rationale)) return { problem: 'RATIONALE_SHORT' };
  const text = rationale.trim();
  if (decision !== 'ACCEPTED_WITH_CHANGE') return { body: { decision, rationale: text } };
  const items = dropItems(statements, kept);
  return items.length === 0 ? { problem: 'NOTHING_DROPPED' } : { body: { decision, rationale: text, items } };
}

export type ScoreInput = { state: 'EMPTY' } | { state: 'INVALID' } | { state: 'OK'; score: number };

/** A score typed in a field: a whole number from 0 to the top of the scale. */
export function parseScore(text: string, scaleMax: number): ScoreInput {
  const clean = text.trim();
  if (clean === '') return { state: 'EMPTY' };
  if (!/^(0|[1-9][0-9]{0,3})$/.test(clean)) return { state: 'INVALID' };
  const score = Number(clean);
  return score > scaleMax ? { state: 'INVALID' } : { state: 'OK', score };
}

export interface ScoreSheet {
  /** READY: every criterion has a valid score. */
  state: 'READY' | 'INCOMPLETE' | 'INVALID';
  total: string | null;
  decision: 'ACCEPTED' | 'ACCEPTED_WITH_CHANGE';
  items: DecisionItemBody[];
  /** The code of each criterion whose field is not a valid score. */
  invalid: string[];
}

/**
 * The accepted scores of an evaluation, read from the fields: the weighted total only when every criterion has a score (the same formula as the server), and the decision that fits the scores: the proposals as they
 * are (ACCEPTED, no items) or with the scores the person set or changed (ACCEPTED_WITH_CHANGE, one SET_SCORE for each).
 */
export function scoreSheet(criteria: readonly CriterionProposal[], fields: Readonly<Record<string, string>>, scaleMax: number): ScoreSheet {
  const scores = new Map<string, number>();
  const items: DecisionItemBody[] = [];
  const invalid: string[] = [];
  let empty = false;
  for (const criterion of criteria) {
    const parsed = parseScore(fields[criterion.code] ?? '', scaleMax);
    if (parsed.state === 'EMPTY') empty = true;
    else if (parsed.state === 'INVALID') invalid.push(criterion.code);
    else {
      scores.set(criterion.code, parsed.score);
      if (criterion.proposedScore === null || criterion.proposedScore !== parsed.score) items.push({ item_key: criterion.code, action: 'SET_SCORE', score: parsed.score });
    }
  }
  const state = invalid.length > 0 ? 'INVALID' : empty ? 'INCOMPLETE' : 'READY';
  return {
    state,
    total: state === 'READY' ? weightedTotal(criteria.map((criterion) => ({ code: criterion.code, weightBp: criterion.weightBp })), scores, scaleMax) : null,
    decision: items.length === 0 ? 'ACCEPTED' : 'ACCEPTED_WITH_CHANGE',
    items,
    invalid,
  };
}

/** The fields an evaluation starts with: the proposed score of each criterion, empty for a score that was withheld. */
export function initialScores(criteria: readonly CriterionProposal[]): Record<string, string> {
  return Object.fromEntries(criteria.map((criterion) => [criterion.code, criterion.proposedScore === null ? '' : String(criterion.proposedScore)]));
}

/** The fields hold the proposals as they are: nothing was set or changed by the person. */
export const sameAsProposals = (criteria: readonly CriterionProposal[], fields: Readonly<Record<string, string>>): boolean => criteria.every((criterion) => (fields[criterion.code] ?? '') === (criterion.proposedScore === null ? '' : String(criterion.proposedScore)));

// ---- the details of a review item ----------------------------------------------------------------------------------------------------------------------------------------

export type ReviewDetail =
  | { kind: 'missing'; terms: string }
  | { kind: 'words'; words: string; min: string }
  | { kind: 'patternAbsent' }
  | { kind: 'patternPresent' }
  | { kind: 'notAnswered' }
  | { kind: 'passWithoutEvidence' }
  | { kind: 'notComputable' }
  | { kind: 'other'; text: string };

/** The detail code the server gives an item of a review (`MISSING:a|b`, `WORDS:5<10`, ...) as a value the screen words. */
export function parseReviewDetail(detail: string): ReviewDetail {
  if (detail.startsWith('MISSING:')) return { kind: 'missing', terms: detail.slice('MISSING:'.length).split('|').join(', ') };
  const words = /^WORDS:(\d+)<(\d+)$/.exec(detail);
  if (words !== null) return { kind: 'words', words: words[1] ?? '', min: words[2] ?? '' };
  if (detail === 'PATTERN_ABSENT') return { kind: 'patternAbsent' };
  if (detail === 'PATTERN_PRESENT') return { kind: 'patternPresent' };
  if (detail === 'NOT_ANSWERED') return { kind: 'notAnswered' };
  if (detail === 'PASS_WITHOUT_EVIDENCE') return { kind: 'passWithoutEvidence' };
  if (detail === 'NOT_COMPUTABLE') return { kind: 'notComputable' };
  return { kind: 'other', text: detail };
}

// ---- a failed command ----------------------------------------------------------------------------------------------------------------------------------------------------------

export const failureCode = (error: unknown): string | undefined => (error instanceof ApiError ? error.code : undefined);
export const failureStatus = (error: unknown): number | undefined => (error instanceof ApiError ? error.status : undefined);
export const failureDetail = (error: unknown): string | undefined => (error instanceof ApiError && typeof error.detail === 'string' && error.detail !== '' ? error.detail : undefined);
export const isVersionConflict = (error: unknown): boolean => failureCode(error) === 'VERSION_CONFLICT';
export const isKnownCode = (code: string): boolean => (KNOWN_CODES as readonly string[]).includes(code);

// ---- the form of a checklist -----------------------------------------------------------------------------------------------------------------------------------------------

export type FieldProblem = 'required' | 'pattern' | 'short' | 'long' | 'duplicate' | 'range' | 'regex' | 'nested' | 'count';

const ITEM_CODE = /^[A-Z][A-Z0-9_.-]{0,39}$/;
const SET_CODE = /^[A-Z][A-Z0-9_.-]{1,59}$/;
const APPLIES_TO = /^[A-Z][A-Z0-9_]{1,39}$/;
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*{]/;
export const MAX_CHECKLIST_ITEMS = 50;
export const MAX_CRITERIA = 30;

export interface ChecklistRowForm {
  key: number;
  code: string;
  label: string;
  kind: CheckKind;
  severity: CheckSeverity;
  terms: string;
  match: TermMatch;
  min: string;
  pattern: string;
  mustMatch: boolean;
  question: string;
}

export interface ChecklistForm {
  code: string;
  title: string;
  appliesTo: string;
  rows: ChecklistRowForm[];
}

export const newChecklistRow = (key: number): ChecklistRowForm => ({ key, code: '', label: '', kind: 'REQUIRED_TERMS', severity: 'WARNING', terms: '', match: 'ALL', min: '', pattern: '', mustMatch: true, question: '' });
export const emptyChecklist = (): ChecklistForm => ({ code: '', title: '', appliesTo: '', rows: [newChecklistRow(1)] });

export type RowErrors = Partial<Record<'code' | 'label' | 'terms' | 'min' | 'pattern' | 'question', FieldProblem>>;
export interface ChecklistErrors {
  code?: FieldProblem;
  title?: FieldProblem;
  appliesTo?: FieldProblem;
  rows?: FieldProblem;
  byRow: Record<number, RowErrors>;
}

/** The terms of a required-terms item, one per line or separated by semicolons or commas. */
export const termList = (text: string): string[] =>
  text
    .split(/[\n;,]/)
    .map((term) => term.trim())
    .filter((term) => term !== '');

export function validateChecklist(form: ChecklistForm): ChecklistErrors {
  const errors: ChecklistErrors = { byRow: {} };
  if (form.code.trim() === '') errors.code = 'required';
  else if (!SET_CODE.test(form.code.trim())) errors.code = 'pattern';
  const title = form.title.trim();
  if (title === '') errors.title = 'required';
  else if (title.length < 2) errors.title = 'short';
  else if (title.length > 300) errors.title = 'long';
  if (form.appliesTo.trim() === '') errors.appliesTo = 'required';
  else if (!APPLIES_TO.test(form.appliesTo.trim())) errors.appliesTo = 'pattern';
  if (form.rows.length < 1 || form.rows.length > MAX_CHECKLIST_ITEMS) errors.rows = 'count';
  const seen = new Set<string>();
  for (const row of form.rows) {
    const found: RowErrors = {};
    const code = row.code.trim();
    if (code === '') found.code = 'required';
    else if (!ITEM_CODE.test(code)) found.code = 'pattern';
    else if (seen.has(code)) found.code = 'duplicate';
    seen.add(code);
    const label = row.label.trim();
    if (label === '') found.label = 'required';
    else if (label.length < 2) found.label = 'short';
    else if (label.length > 500) found.label = 'long';
    if (row.kind === 'REQUIRED_TERMS') {
      const terms = termList(row.terms);
      if (terms.length === 0) found.terms = 'required';
      else if (terms.length > 20 || terms.some((term) => term.length > 100)) found.terms = 'range';
    } else if (row.kind === 'MIN_WORDS') {
      if (row.min.trim() === '') found.min = 'required';
      else if (!/^[0-9]+$/.test(row.min.trim()) || Number(row.min) < 1 || Number(row.min) > 100_000) found.min = 'range';
    } else if (row.kind === 'PATTERN') {
      if (row.pattern === '') found.pattern = 'required';
      else if (row.pattern.length > 200) found.pattern = 'long';
      else if (NESTED_QUANTIFIER.test(row.pattern)) found.pattern = 'nested';
      else if (!compiles(row.pattern)) found.pattern = 'regex';
    } else {
      const question = row.question.trim();
      if (question === '') found.question = 'required';
      else if (question.length < 5) found.question = 'short';
      else if (question.length > 500) found.question = 'long';
    }
    if (Object.keys(found).length > 0) errors.byRow[row.key] = found;
  }
  return errors;
}

function compiles(pattern: string): boolean {
  try {
    return typeof RegExp(pattern, 'u').source === 'string';
  } catch {
    return false;
  }
}

/** The contract types the parameters of an item as an object without members; the parameters are written per kind, so they cross that boundary here. */
const asParams = (value: Raw): Record<string, never> => value as Record<string, never>;

export const hasChecklistErrors = (errors: ChecklistErrors): boolean => errors.code !== undefined || errors.title !== undefined || errors.appliesTo !== undefined || errors.rows !== undefined || Object.keys(errors.byRow).length > 0;

export function checklistBody(form: ChecklistForm): ChecklistBody {
  return {
    code: form.code.trim(),
    title: form.title.trim(),
    applies_to: form.appliesTo.trim(),
    items: form.rows.map((row) => ({
      code: row.code.trim(),
      label: row.label.trim(),
      kind: row.kind,
      severity: row.severity,
      params: asParams(
        row.kind === 'REQUIRED_TERMS'
          ? { terms: termList(row.terms), match: row.match }
          : row.kind === 'MIN_WORDS'
            ? { min: Number(row.min.trim()) }
            : row.kind === 'PATTERN'
              ? { pattern: row.pattern, must_match: row.mustMatch }
              : { question: row.question.trim() },
      ),
    })),
  };
}

/** The parameters of a checklist item in one line a table cell can hold. */
export function paramsSummary(item: ChecklistItemView): string {
  if (item.kind === 'REQUIRED_TERMS') return strings(item.params.terms).join(', ');
  if (item.kind === 'MIN_WORDS') return String(int(item.params.min) ?? '');
  if (item.kind === 'PATTERN') return str(item.params.pattern) ?? '';
  return str(item.params.question) ?? '';
}

// ---- the form of a set of criteria -----------------------------------------------------------------------------------------------------------------------------------

export interface CriterionRowForm {
  key: number;
  code: string;
  label: string;
  guidance: string;
  weight: string;
  evidenceRequired: boolean;
}

export interface CriteriaForm {
  code: string;
  title: string;
  scaleMax: string;
  rows: CriterionRowForm[];
}

export const newCriterionRow = (key: number): CriterionRowForm => ({ key, code: '', label: '', guidance: '', weight: '', evidenceRequired: true });
export const emptyCriteria = (): CriteriaForm => ({ code: '', title: '', scaleMax: '100', rows: [newCriterionRow(1)] });

export type CriterionErrors = Partial<Record<'code' | 'label' | 'guidance' | 'weight', FieldProblem>>;
export interface CriteriaErrors {
  code?: FieldProblem;
  title?: FieldProblem;
  scaleMax?: FieldProblem;
  rows?: FieldProblem;
  byRow: Record<number, CriterionErrors>;
}

const wholeNumber = (text: string): number | undefined => (/^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : undefined);

export function validateCriteria(form: CriteriaForm): CriteriaErrors {
  const errors: CriteriaErrors = { byRow: {} };
  if (form.code.trim() === '') errors.code = 'required';
  else if (!SET_CODE.test(form.code.trim())) errors.code = 'pattern';
  const title = form.title.trim();
  if (title === '') errors.title = 'required';
  else if (title.length < 2) errors.title = 'short';
  else if (title.length > 300) errors.title = 'long';
  const scale = wholeNumber(form.scaleMax);
  if (scale === undefined || scale < 1 || scale > 1000) errors.scaleMax = 'range';
  if (form.rows.length < 1 || form.rows.length > MAX_CRITERIA) errors.rows = 'count';
  const seen = new Set<string>();
  for (const row of form.rows) {
    const found: CriterionErrors = {};
    const code = row.code.trim();
    if (code === '') found.code = 'required';
    else if (!ITEM_CODE.test(code)) found.code = 'pattern';
    else if (seen.has(code)) found.code = 'duplicate';
    seen.add(code);
    const label = row.label.trim();
    if (label === '') found.label = 'required';
    else if (label.length < 2) found.label = 'short';
    else if (label.length > 300) found.label = 'long';
    if (row.guidance.length > 2000) found.guidance = 'long';
    const weight = wholeNumber(row.weight);
    if (row.weight.trim() === '') found.weight = 'required';
    else if (weight === undefined || weight < 1 || weight > WEIGHT_TOTAL_BP) found.weight = 'range';
    if (Object.keys(found).length > 0) errors.byRow[row.key] = found;
  }
  return errors;
}

export const hasCriteriaErrors = (errors: CriteriaErrors): boolean => errors.code !== undefined || errors.title !== undefined || errors.scaleMax !== undefined || errors.rows !== undefined || Object.keys(errors.byRow).length > 0;

/** The weights typed so far, in basis points; a field that is not a whole number counts as nothing. */
export const typedWeights = (form: CriteriaForm): number[] => form.rows.map((row) => wholeNumber(row.weight) ?? 0);

export type WeightState = 'COMPLETE' | 'SHORT' | 'OVER';
export function weightState(total: number): WeightState {
  return total === WEIGHT_TOTAL_BP ? 'COMPLETE' : total < WEIGHT_TOTAL_BP ? 'SHORT' : 'OVER';
}

export function criteriaBody(form: CriteriaForm): CriteriaBody {
  return {
    code: form.code.trim(),
    title: form.title.trim(),
    scale_max: Number(form.scaleMax.trim()),
    criteria: form.rows.map((row) => ({
      code: row.code.trim(),
      label: row.label.trim(),
      ...(row.guidance.trim() === '' ? {} : { guidance: row.guidance.trim() }),
      weight_bp: Number(row.weight.trim()),
      evidence_required: row.evidenceRequired,
    })),
  };
}

// ---- the forms of the exceptions ---------------------------------------------------------------------------------------------------------------------------------------

export interface AttestForm {
  country: string;
  detail: string;
  noTraining: boolean;
  reference: string;
  documentId: string;
}

export const emptyAttest = (): AttestForm => ({ country: '', detail: '', noTraining: false, reference: '', documentId: '' });
export type AttestErrors = Partial<Record<'country' | 'detail' | 'reference' | 'documentId', FieldProblem>>;

export function validateAttest(form: AttestForm): AttestErrors {
  const errors: AttestErrors = {};
  if (form.country === '') errors.country = 'required';
  else if (!/^[A-Z]{2}$/.test(form.country)) errors.country = 'pattern';
  const detail = form.detail.trim();
  if (detail !== '' && (detail.length < 2 || detail.length > 300)) errors.detail = detail.length < 2 ? 'short' : 'long';
  const reference = form.reference.trim();
  if (reference === '') errors.reference = 'required';
  else if (reference.length < 3) errors.reference = 'short';
  else if (reference.length > 300) errors.reference = 'long';
  if (form.documentId.trim() !== '' && !isUuid(form.documentId)) errors.documentId = 'pattern';
  return errors;
}

export function attestBody(form: AttestForm): AttestBody {
  const detail = form.detail.trim();
  const document = form.documentId.trim();
  return {
    data_location_country: form.country,
    ...(detail === '' ? {} : { data_location_detail: detail }),
    no_training_attested: form.noTraining,
    attestation_ref: form.reference.trim(),
    ...(document === '' ? {} : { attestation_document_id: document.toLowerCase() }),
  };
}

export interface RequestForm {
  providerId: string;
  taskType: string;
  maxClassification: Classification;
  reason: string;
  days: string;
}

export const emptyRequest = (): RequestForm => ({ providerId: '', taskType: '', maxClassification: 'PUBLIC', reason: '', days: '30' });
export type RequestErrors = Partial<Record<'providerId' | 'taskType' | 'reason' | 'days', FieldProblem>>;
export const MIN_EXCEPTION_REASON = 20;
export const MAX_EXCEPTION_DAYS = 90;

export function validateRequest(form: RequestForm): RequestErrors {
  const errors: RequestErrors = {};
  if (form.providerId === '') errors.providerId = 'required';
  const task = form.taskType.trim();
  if (task !== '' && !/^[A-Z][A-Z0-9_]{1,59}$/.test(task)) errors.taskType = 'pattern';
  const reason = form.reason.trim();
  if (reason === '') errors.reason = 'required';
  else if (reason.length < MIN_EXCEPTION_REASON) errors.reason = 'short';
  else if (reason.length > 2000) errors.reason = 'long';
  const days = wholeNumber(form.days);
  if (days === undefined || days < 1 || days > MAX_EXCEPTION_DAYS) errors.days = 'range';
  return errors;
}

export function requestBody(form: RequestForm): ExceptionRequestBody {
  const task = form.taskType.trim();
  return { provider_id: form.providerId, ...(task === '' ? {} : { task_type: task }), max_classification: form.maxClassification, reason: form.reason.trim(), valid_days: Number(form.days.trim()) };
}

export type ApprovalProblem = 'REF_REQUIRED' | 'REF_SHORT' | 'NOTE_SHORT';

/** An approval needs the reference of the approval (three characters or more) and, when a note is written, a note of ten; a rejection needs a note of ten. */
export function approvalProblem(decision: 'APPROVE' | 'REJECT', reference: string, note: string): ApprovalProblem | undefined {
  const text = note.trim();
  if (decision === 'REJECT') return text.length < MIN_NOTE ? 'NOTE_SHORT' : undefined;
  const ref = reference.trim();
  if (ref === '') return 'REF_REQUIRED';
  if (ref.length < 3) return 'REF_SHORT';
  return text !== '' && text.length < MIN_NOTE ? 'NOTE_SHORT' : undefined;
}

export function exceptionDecisionBody(decision: 'APPROVE' | 'REJECT', reference: string, note: string): ExceptionDecisionBody {
  const text = note.trim();
  return { decision, ...(text === '' ? {} : { note: text }), ...(decision === 'APPROVE' ? { approval_ref: reference.trim() } : {}) };
}

export const revokeReasonOk = (reason: string): boolean => reason.trim().length >= MIN_NOTE;
