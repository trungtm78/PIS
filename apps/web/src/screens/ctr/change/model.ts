import { ApiError } from '@machvon/api-client';

export const CHAIN_PATH = '/ctr/ctr-19';
export const TIERS_PATH = '/ctr/ctr-20';
export const REQUEST_PATH = '/ctr/ctr-07';

export const MAX_TEXT = 2000;
/** The longest a change may move the schedule, in days either way (the server refuses more). */
export const MAX_DAYS = 36_500;

export const TIER_COUNTS = [1, 2, 3] as const;
export type TierCount = (typeof TIER_COUNTS)[number];

export const STAGES = ['EVENT', 'PCO', 'CO'] as const;
export type Stage = (typeof STAGES)[number];

export const STATUSES = ['DRAFT', 'SUBMITTED', 'EVALUATED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'PROMOTED'] as const;
export type ChangeStatus = (typeof STATUSES)[number];

export const EVENT_KINDS = ['OWNER_INSTRUCTION', 'DESIGN_CHANGE', 'SITE_CONDITION', 'FORCE_MAJEURE', 'LEGAL_CHANGE', 'QUANTITY_VARIANCE', 'OTHER'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The statuses of a contract in which a change can be raised (the server judges it again). */
export const CHANGEABLE_CONTRACT_STATUSES: readonly string[] = ['ACTIVE', 'SUSPENDED'];

/** The tiers a project with this many tiers goes through, in order: 3 is the event, the PCO and the CO; 2 is the PCO and the CO; 1 is the CO alone. */
export const stagesOf = (tierCount: TierCount): Stage[] => STAGES.slice(STAGES.length - tierCount);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_AMOUNT = /^-?\d{1,24}$/;
const SIGNED_DAYS = /^-?\d{1,5}$/;

export const isUuid = (value: string): boolean => UUID.test(value.trim());

const link = (path: string, params: Record<string, string | undefined>): string => {
  const query = new URLSearchParams(Object.entries(params).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as [string, string]]))).toString();
  return query === '' ? path : `${path}?${query}`;
};
/** The board of the chain of a project (CTR-19), narrowed to one contract when it is named. */
export const chainLink = (projectId: string, contractId?: string): string => link(CHAIN_PATH, { project: projectId, contract: contractId });
/** The policy of the tiers of a project (CTR-20). */
export const tiersLink = (projectId: string): string => link(TIERS_PATH, { project: projectId });
/** The form that raises a change on a contract (CTR-07). */
export const requestLink = (contractId?: string): string => link(REQUEST_PATH, { contract: contractId });

// ---- what the server answers ---------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const isOneOf = <T extends string>(values: readonly T[], value: string | undefined): value is T => value !== undefined && (values as readonly string[]).includes(value);

export interface ChainConfig {
  tierCount: TierCount;
  stages: Stage[];
  locked: boolean;
  lockedAt: string | null;
  /** The first request of the project, which fixed the number of tiers. */
  lockedBy: { id: string; code: string | null } | null;
  /** The membership of the person who set the tiers. */
  setBy: string | null;
  version: number;
}

export interface RequestActions {
  promote: boolean;
  evaluate: boolean;
  withdraw: boolean;
  decide: boolean;
  /** The retroactive adjustment of an assessed CO (CTR-14). */
  adjust: boolean;
}

/** What the staff of the owner read of a request beyond its place in the chain; a guest contractor does not have it. */
export interface RequestDetail {
  eventKind: EventKind | null;
  baselineRevisionId: string;
  reason: string;
  statusReason: string | null;
  /** Signed exact decimal strings in VND. */
  estimatedDeltaVnd: string | null;
  evaluatedDeltaVnd: string | null;
  approvedDeltaVnd: string | null;
  /** The first day of the revision an approved change order made; null before the decision. */
  effectiveOn: string | null;
  scheduleImpactDays: number;
  fundingImpactNote: string | null;
  scopeImpactNote: string | null;
  allocationLineId: string | null;
}

export interface ChangeRequest {
  id: string;
  code: string | null;
  stage: Stage;
  status: ChangeStatus;
  contract: { id: string; code: string; status: string };
  projectId: string;
  parentId: string | null;
  createdAt: string;
  version: number;
  detail: RequestDetail | undefined;
  actions: RequestActions | undefined;
  /** The revision of the contract that an approved change order made; null until it is approved. */
  resultingRevisionId: string | null;
  /** The change order was approved through the retroactive adjustment: it applies from a day before its approval. */
  retroactive: boolean;
}

export interface Chain {
  projectId: string;
  /** Undefined while the business owner has not set the tiers of the project (and for a guest contractor). */
  config: ChainConfig | undefined;
  requests: ChangeRequest[];
  canConfigure: boolean;
  canOpen: boolean;
}

function toConfig(raw: unknown): ChainConfig | undefined {
  const row = asRecord(raw);
  const count = TIER_COUNTS.find((candidate) => candidate === row?.tier_count);
  const version = whole(row?.version);
  if (row === undefined || count === undefined || version === undefined) return undefined;
  const lockedBy = asRecord(row.locked_by_change);
  const lockedId = text(lockedBy?.id);
  return {
    tierCount: count,
    stages: stagesOf(count),
    locked: row.locked === true,
    lockedAt: nullableText(row.locked_at),
    lockedBy: lockedId === undefined ? null : { id: lockedId, code: nullableText(lockedBy?.code) },
    setBy: nullableText(row.set_by),
    version,
  };
}

function toDetail(row: Raw): RequestDetail | undefined {
  const baseline = text(row.baseline_revision_id);
  const reason = text(row.reason);
  if (baseline === undefined || reason === undefined) return undefined;
  const kind = text(row.event_kind);
  return {
    eventKind: isOneOf(EVENT_KINDS, kind) ? kind : null,
    baselineRevisionId: baseline,
    reason,
    statusReason: nullableText(row.status_reason),
    estimatedDeltaVnd: nullableText(row.estimated_delta_vnd),
    evaluatedDeltaVnd: nullableText(row.evaluated_delta_vnd),
    approvedDeltaVnd: nullableText(row.approved_delta_vnd),
    effectiveOn: nullableText(row.effective_on),
    scheduleImpactDays: whole(row.schedule_impact_days) ?? 0,
    fundingImpactNote: nullableText(row.funding_impact_note),
    scopeImpactNote: nullableText(row.scope_impact_note),
    allocationLineId: nullableText(row.allocation_line_id),
  };
}

export function toRequest(raw: unknown): ChangeRequest[] {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const id = text(row?.id);
  const stage = text(row?.stage);
  const status = text(row?.status);
  const contractId = text(contract?.id);
  const contractCode = text(contract?.code);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || contractId === undefined || contractCode === undefined || version === undefined || !isOneOf(STAGES, stage) || !isOneOf(STATUSES, status)) return [];
  const actions = asRecord(row.actions);
  return [
    {
      id,
      code: nullableText(row.code),
      stage,
      status,
      contract: { id: contractId, code: contractCode, status: text(contract?.status) ?? '' },
      projectId: text(row.project_id) ?? '',
      parentId: nullableText(row.parent_id),
      createdAt: text(row.created_at) ?? '',
      version,
      detail: toDetail(row),
      actions: actions === undefined ? undefined : { promote: actions.promote === true, evaluate: actions.evaluate === true, withdraw: actions.withdraw === true, decide: actions.decide === true, adjust: actions.adjust === true },
      resultingRevisionId: nullableText(row.resulting_revision_id),
      retroactive: row.retroactive === true,
    },
  ];
}

export function toChain(raw: unknown): Chain | undefined {
  const row = asRecord(raw);
  const projectId = text(row?.project_id);
  if (row === undefined || projectId === undefined) return undefined;
  const actions = asRecord(row.actions);
  return {
    projectId,
    config: toConfig(row.config),
    requests: (Array.isArray(row.requests) ? row.requests : []).flatMap(toRequest),
    canConfigure: actions?.configure === true,
    canOpen: actions?.open === true,
  };
}

/** A signed amount in VND from its decimal string: the digits are grouped by the language of the screen and the string is never turned into a float. */
export function signedAmountText(amount: string | null, locale: string): string | null {
  if (amount === null) return null;
  return SIGNED_AMOUNT.test(amount) ? new Intl.NumberFormat(locale).format(BigInt(amount)) : amount;
}

/** The requests of one tier, in the order they were raised. */
export const inStage = (requests: readonly ChangeRequest[], stage: Stage): ChangeRequest[] => requests.filter((request) => request.stage === stage);

// ---- the forms ---------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooLong' | 'amount' | 'days' | 'uuid';

export const reasonProblem = (reason: string): FormProblem | undefined => {
  const words = reason.trim();
  if (words === '') return 'required';
  return words.length > MAX_TEXT ? 'tooLong' : undefined;
};

export interface TiersForm {
  tierCount: '' | `${TierCount}`;
}
export const emptyTiers = (current: TierCount | undefined): TiersForm => ({ tierCount: current === undefined ? '' : `${current}` });

export function validateTiers(form: TiersForm): Partial<Record<keyof TiersForm, FormProblem>> {
  return form.tierCount === '' ? { tierCount: 'required' } : {};
}

export const tiersBody = (form: TiersForm): { tier_count: TierCount } => ({ tier_count: TIER_COUNTS.find((count) => `${count}` === form.tierCount) ?? 1 });

export interface OpenForm {
  baselineRevisionId: string;
  eventKind: '' | EventKind;
  reason: string;
  estimatedDeltaVnd: string;
  scheduleImpactDays: string;
}
export const emptyOpen = (baselineRevisionId: string): OpenForm => ({ baselineRevisionId, eventKind: '', reason: '', estimatedDeltaVnd: '', scheduleImpactDays: '' });

const amountProblem = (value: string): FormProblem | undefined => (value.trim() === '' || SIGNED_AMOUNT.test(value.trim()) ? undefined : 'amount');
const daysProblem = (value: string): FormProblem | undefined => {
  const words = value.trim();
  if (words === '') return undefined;
  return SIGNED_DAYS.test(words) && Math.abs(Number(words)) <= MAX_DAYS ? undefined : 'days';
};

export function validateOpen(form: OpenForm): Partial<Record<keyof OpenForm, FormProblem>> {
  const problems: Partial<Record<keyof OpenForm, FormProblem>> = {};
  if (form.baselineRevisionId.trim() === '') problems.baselineRevisionId = 'required';
  else if (!isUuid(form.baselineRevisionId)) problems.baselineRevisionId = 'uuid';
  const reason = reasonProblem(form.reason);
  if (reason !== undefined) problems.reason = reason;
  const amount = amountProblem(form.estimatedDeltaVnd);
  if (amount !== undefined) problems.estimatedDeltaVnd = amount;
  const days = daysProblem(form.scheduleImpactDays);
  if (days !== undefined) problems.scheduleImpactDays = days;
  return problems;
}

/** The request is raised at the first tier of the chain of the project; the server refuses any other. */
export interface OpenBody {
  stage: Stage;
  baseline_revision_id: string;
  event_kind?: EventKind;
  reason: string;
  estimated_delta_vnd?: string;
  schedule_impact_days?: number;
}

const normalAmount = (value: string): string => BigInt(value.trim()).toString();

export function openBody(form: OpenForm, stage: Stage): OpenBody {
  const days = form.scheduleImpactDays.trim();
  return {
    stage,
    baseline_revision_id: form.baselineRevisionId.trim().toLowerCase(),
    ...(form.eventKind === '' ? {} : { event_kind: form.eventKind }),
    reason: form.reason.trim(),
    ...(form.estimatedDeltaVnd.trim() === '' ? {} : { estimated_delta_vnd: normalAmount(form.estimatedDeltaVnd) }),
    ...(days === '' ? {} : { schedule_impact_days: Number(days) }),
  };
}

export interface ReasonForm {
  reason: string;
}
export const EMPTY_REASON: ReasonForm = { reason: '' };
export const validateReason = (form: ReasonForm): Partial<Record<keyof ReasonForm, FormProblem>> => {
  const problem = reasonProblem(form.reason);
  return problem === undefined ? {} : { reason: problem };
};

export interface EvaluateForm {
  evaluatedDeltaVnd: string;
  scheduleImpactDays: string;
  fundingImpactNote: string;
  scopeImpactNote: string;
  allocationLineId: string;
}

/** Starts from what the last assessment said, when there is one. */
export const emptyEvaluate = (request: ChangeRequest): EvaluateForm => ({
  evaluatedDeltaVnd: request.detail?.evaluatedDeltaVnd ?? request.detail?.estimatedDeltaVnd ?? '',
  scheduleImpactDays: request.detail === undefined ? '' : `${request.detail.scheduleImpactDays}`,
  fundingImpactNote: request.detail?.fundingImpactNote ?? '',
  scopeImpactNote: request.detail?.scopeImpactNote ?? '',
  allocationLineId: request.detail?.allocationLineId ?? '',
});

/** Whether the assessment adds to the contract: only then does the capital of the line it is paid from have to take it. */
export const isIncrease = (value: string): boolean => SIGNED_AMOUNT.test(value.trim()) && BigInt(value.trim()) > 0n;

export function validateEvaluate(form: EvaluateForm): Partial<Record<keyof EvaluateForm, FormProblem>> {
  const problems: Partial<Record<keyof EvaluateForm, FormProblem>> = {};
  if (form.evaluatedDeltaVnd.trim() === '') problems.evaluatedDeltaVnd = 'required';
  else if (!SIGNED_AMOUNT.test(form.evaluatedDeltaVnd.trim())) problems.evaluatedDeltaVnd = 'amount';
  if (form.scheduleImpactDays.trim() === '') problems.scheduleImpactDays = 'required';
  else {
    const days = daysProblem(form.scheduleImpactDays);
    if (days !== undefined) problems.scheduleImpactDays = days;
  }
  const funding = reasonProblem(form.fundingImpactNote);
  if (funding !== undefined) problems.fundingImpactNote = funding;
  if (form.scopeImpactNote.trim().length > MAX_TEXT) problems.scopeImpactNote = 'tooLong';
  if (form.allocationLineId.trim() === '') {
    if (isIncrease(form.evaluatedDeltaVnd)) problems.allocationLineId = 'required';
  } else if (!isUuid(form.allocationLineId)) problems.allocationLineId = 'uuid';
  return problems;
}

export interface EvaluateBody {
  evaluated_delta_vnd: string;
  schedule_impact_days: number;
  funding_impact_note: string;
  scope_impact_note?: string;
  allocation_line_id?: string;
}

export function evaluateBody(form: EvaluateForm): EvaluateBody {
  const scope = form.scopeImpactNote.trim();
  const line = form.allocationLineId.trim();
  return {
    evaluated_delta_vnd: normalAmount(form.evaluatedDeltaVnd),
    schedule_impact_days: Number(form.scheduleImpactDays.trim()),
    funding_impact_note: form.fundingImpactNote.trim(),
    ...(scope === '' ? {} : { scope_impact_note: scope }),
    ...(line === '' ? {} : { allocation_line_id: line.toLowerCase() }),
  };
}

// ---- refusals ------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'selfApproval'
  | 'retroactive'
  | 'floor'
  | 'decisionDocument'
  | 'boqMismatch'
  | 'delegation'
  | 'tiersLocked'
  | 'notConfigured'
  | 'wrongStage'
  | 'lastTier'
  | 'notEvaluated'
  | 'onlyCo'
  | 'stateInvalid'
  | 'contractState'
  | 'lineRequired'
  | 'allocation'
  | 'settlementApproved'
  | 'valueExceeded'
  | 'notOnLedger'
  | 'notRetroactive'
  | 'beforeContract'
  | 'afterRevision'
  | 'affectedMismatch'
  | 'revisionPending'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ProblemView {
  problem: Problem;
  /** What the sentence adds to the code: the tier the chain starts at, when the server said it. */
  stage: Stage | undefined;
}

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { problem: 'general', stage: undefined };
  const extensions = error.extensions;
  const allowed = STAGES.find((candidate) => candidate === extensions.allowed_stage);
  const view = (problem: Problem): ProblemView => ({ problem, stage: allowed });
  switch (error.code) {
    case 'SELF_APPROVAL_DENIED':
      return view('selfApproval');
    case 'RETROACTIVE_NOT_ALLOWED':
      return view('retroactive');
    case 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT':
      return view('floor');
    case 'DECISION_DOCUMENT_REQUIRED':
      return view('decisionDocument');
    case 'BOQ_TOTAL_MISMATCH':
      return view('boqMismatch');
    case 'CHANGE_TIERS_LOCKED':
      return view('tiersLocked');
    case 'CHANGE_STAGE_NOT_ALLOWED':
      switch (extensions.reason) {
        case 'ONLY_CO_DECIDED':
          return view('onlyCo');
        case 'TIERS_NOT_CONFIGURED':
          return view('notConfigured');
        case 'LAST_TIER':
          return view('lastTier');
        case 'STAGE_NOT_EVALUATED':
          return view('notEvaluated');
        default:
          return view('wrongStage');
      }
    case 'CHANGE_STATE_INVALID':
      return view('stateInvalid');
    case 'CONTRACT_STATE_INVALID':
      return view(extensions.reason === 'REVISION_PENDING' ? 'revisionPending' : 'contractState');
    case 'SETTLEMENT_ALREADY_APPROVED':
      return view('settlementApproved');
    case 'VALUE_EXCEEDED':
      return view('valueExceeded');
    case 'ACCEPTANCE_STATE_INVALID':
      return view(extensions.reason === 'NOT_ON_LEDGER' ? 'notOnLedger' : 'general');
    case 'ALLOCATION_UNAVAILABLE':
      return view(extensions.reason === 'ALLOCATION_LINE_REQUIRED' ? 'lineRequired' : 'allocation');
    case 'VERSION_CONFLICT':
      return view('versionConflict');
    case 'VALIDATION_FAILED':
      switch (extensions.reason) {
        case 'NOT_RETROACTIVE':
          return view('notRetroactive');
        case 'BEFORE_CONTRACT':
          return view('beforeContract');
        case 'NOT_AFTER_REVISION':
          return view('afterRevision');
        case 'AFFECTED_MISMATCH':
          return view('affectedMismatch');
        default:
          return view('validation');
      }
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return view('validation');
    case 'RESOURCE_NOT_FOUND':
      return view('notFound');
    case 'SCOPE_DENIED':
      return view(extensions.approver_role_id === undefined ? 'denied' : 'delegation');
    case 'ENTITLEMENT_DENIED':
      return view('denied');
    case 'SESSION_EXPIRED':
      return view('session');
    default:
      return view('general');
  }
}
