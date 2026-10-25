import { ApiError } from '@machvon/api-client';
import { isUuid } from '../../ctr/change/model';

export const READ_PERMISSION = 'settlement_revision.read';
export const OPEN_PERMISSION = 'settlement.open';
export const FINDINGS_PERMISSION = 'aud.read';
export const PROJECT_READ_PERMISSION = 'project.read';

export const SETTLEMENT_PATH = '/pay/pay-15';

/** The settlement workspace (PAY-15), with one settlement picked when an id is given. */
export const settlementLink = (id?: string): string => (id === undefined ? SETTLEMENT_PATH : `${SETTLEMENT_PATH}?${new URLSearchParams({ settlement: id }).toString()}`);

export const STATUSES = ['DRAFT', 'SUBMITTED', 'VERIFYING', 'VERIFIED', 'CLOSED', 'RETURNED', 'SUPERSEDED'] as const;
export type Status = (typeof STATUSES)[number];
export const SCOPES = ['ANNUAL', 'PROJECT', 'CONTRACT'] as const;
export type Scope = (typeof SCOPES)[number];
export const GROUPS = ['QTQG', 'A', 'B', 'C'] as const;
export type Group = (typeof GROUPS)[number];
export const OUTCOMES = ['VERIFYING', 'VERIFIED', 'RETURNED'] as const;
export type Outcome = (typeof OUTCOMES)[number];

const MAX_TEXT = 2000;
const MAX_REFS = 50;
const AMOUNT = /^(0|[1-9][0-9]{0,23})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const nullableWhole = (value: unknown): number | null => whole(value) ?? null;
const amount = (value: unknown): string | undefined => (typeof value === 'string' && AMOUNT.test(value) ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

// ---- what the server answers --------------------------------------------------------------------------------------------------

/** What the caller may do with the settlement as it stands (the server judges each command again). */
export interface Actions {
  refresh: boolean;
  submit: boolean;
  takeUp: boolean;
  verify: boolean;
  returnBack: boolean;
  approveException: boolean;
  close: boolean;
}

export interface Settlement {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  contractId: string | null;
  contractCode: string | null;
  scope: Scope;
  fiscalYear: number | null;
  revision: number;
  status: Status;
  settledVnd: string;
  outstandingVnd: string;
  unrecoveredAdvanceVnd: string;
  figuresRefreshedAt: string;
  figuresNote: string | null;
  projectGroup: Group | null;
  submittedOn: string | null;
  submittedBy: string | null;
  verificationDueOn: string | null;
  deadlineDays: number | null;
  ruleAwaitingConfirmation: boolean | null;
  verifiedOn: string | null;
  verificationFindings: string | null;
  /** Null for who may not read the conclusions of AUD. */
  auditFindingRefs: string[] | null;
  exceptionReason: string | null;
  exceptionApprovedBy: string | null;
  exceptionApprovedAt: string | null;
  decisionDocumentVersionId: string | null;
  closedAt: string | null;
  closeReason: string | null;
  supersedesId: string | null;
  createdAt: string;
  version: number;
  actions: Actions;
}

export function toSettlement(raw: unknown): Settlement | undefined {
  const row = asRecord(raw);
  const project = asRecord(row?.project);
  const contract = asRecord(row?.contract);
  const id = text(row?.id);
  const projectId = text(project?.id);
  const scope = SCOPES.find((candidate) => candidate === row?.settlement_scope);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const revision = whole(row?.revision);
  const version = whole(row?.version);
  const settled = amount(row?.settled_amount_vnd);
  const outstanding = amount(row?.outstanding_vnd);
  const unrecovered = amount(row?.unrecovered_advance_vnd);
  const actions = asRecord(row?.actions);
  const created = text(row?.created_at);
  if (
    row === undefined ||
    id === undefined ||
    projectId === undefined ||
    scope === undefined ||
    status === undefined ||
    revision === undefined ||
    version === undefined ||
    settled === undefined ||
    outstanding === undefined ||
    unrecovered === undefined ||
    actions === undefined ||
    created === undefined
  ) {
    return undefined;
  }
  return {
    id,
    projectId,
    projectCode: text(project?.code) ?? '',
    projectName: text(project?.name) ?? '',
    contractId: text(contract?.id) ?? null,
    contractCode: nullableText(contract?.code),
    scope,
    fiscalYear: nullableWhole(row.fiscal_year),
    revision,
    status,
    settledVnd: settled,
    outstandingVnd: outstanding,
    unrecoveredAdvanceVnd: unrecovered,
    figuresRefreshedAt: text(row.figures_refreshed_at) ?? created,
    figuresNote: nullableText(row.figures_note),
    projectGroup: GROUPS.find((candidate) => candidate === row.project_group) ?? null,
    submittedOn: nullableText(row.submitted_on),
    submittedBy: nullableText(row.submitted_by),
    verificationDueOn: nullableText(row.verification_due_on),
    deadlineDays: nullableWhole(row.deadline_days),
    ruleAwaitingConfirmation: typeof row.deadline_rule_awaiting_confirmation === 'boolean' ? row.deadline_rule_awaiting_confirmation : null,
    verifiedOn: nullableText(row.verified_on),
    verificationFindings: nullableText(row.verification_findings),
    auditFindingRefs: Array.isArray(row.audit_finding_refs) ? strings(row.audit_finding_refs) : null,
    exceptionReason: nullableText(row.exception_reason),
    exceptionApprovedBy: nullableText(row.exception_approved_by),
    exceptionApprovedAt: nullableText(row.exception_approved_at),
    decisionDocumentVersionId: nullableText(row.decision_document_version_id),
    closedAt: nullableText(row.closed_at),
    closeReason: nullableText(row.close_reason),
    supersedesId: nullableText(row.supersedes_id),
    createdAt: created,
    version,
    actions: {
      refresh: actions.refresh === true,
      submit: actions.submit === true,
      takeUp: actions.take_up === true,
      verify: actions.verify === true,
      returnBack: actions.return === true,
      approveException: actions.approve_exception === true,
      close: actions.close === true,
    },
  };
}

/** The answer of a command: the settlement it concerns and the version it stands at. */
export interface Answer {
  id: string;
  status: string;
  version: number;
}

export function toAnswer(value: unknown): Answer | undefined {
  const row = asRecord(value);
  const id = text(row?.resource_id);
  const version = whole(row?.resource_version);
  if (row === undefined || id === undefined || version === undefined) return undefined;
  return { id, status: text(row.status) ?? '', version };
}

// ---- reading a settlement -----------------------------------------------------------------------------------------------------

/** Whether something is still owed: only an exception that someone else approved lets such a settlement close. */
export const owes = (settlement: Pick<Settlement, 'outstandingVnd' | 'unrecoveredAdvanceVnd'>): boolean => BigInt(settlement.outstandingVnd) > 0n || BigInt(settlement.unrecoveredAdvanceVnd) > 0n;

const DAY_MS = 86_400_000;

/** The days from `today` to the last day of the verification: negative when it has passed. */
export function daysLeft(dueOn: string, today: string): number | undefined {
  if (!DAY.test(dueOn) || !DAY.test(today)) return undefined;
  const due = Date.parse(`${dueOn}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Number.isNaN(due) || Number.isNaN(now) ? undefined : Math.round((due - now) / DAY_MS);
}

export type Urgency = 'late' | 'near' | 'later';

/** How pressing the deadline is: late once its last day has passed, near within 30 days (the first reminder), later otherwise. Only a settlement that waits for its verification has one. */
export function urgencyOf(settlement: Pick<Settlement, 'status' | 'verificationDueOn'>, today: string): Urgency | undefined {
  if ((settlement.status !== 'SUBMITTED' && settlement.status !== 'VERIFYING') || settlement.verificationDueOn === null) return undefined;
  const left = daysLeft(settlement.verificationDueOn, today);
  if (left === undefined) return undefined;
  return left < 0 ? 'late' : left <= 30 ? 'near' : 'later';
}

/** The Vietnam calendar day of an instant: the day the deadlines are counted in. */
export function vietnamDay(now: Date): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

export const vndText = (value: string, locale: string): string => (AMOUNT.test(value) ? new Intl.NumberFormat(locale).format(BigInt(value)) : value);

// ---- the commands -------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooLong' | 'uuid' | 'uuids' | 'day' | 'future' | 'year' | 'tooMany';

export interface OpenForm {
  projectId: string;
  scope: Scope;
  contractId: string;
  fiscalYear: string;
}

export const EMPTY_OPEN: OpenForm = { projectId: '', scope: 'PROJECT', contractId: '', fiscalYear: '' };

export function validateOpen(form: OpenForm): Partial<Record<keyof OpenForm, FormProblem>> {
  const problems: Partial<Record<keyof OpenForm, FormProblem>> = {};
  if (form.projectId.trim() === '') problems.projectId = 'required';
  else if (!isUuid(form.projectId.trim())) problems.projectId = 'uuid';
  if (form.scope === 'CONTRACT') {
    if (form.contractId.trim() === '') problems.contractId = 'required';
    else if (!isUuid(form.contractId.trim())) problems.contractId = 'uuid';
  }
  if (form.scope === 'ANNUAL') {
    const year = Number(form.fiscalYear.trim());
    if (form.fiscalYear.trim() === '') problems.fiscalYear = 'required';
    else if (!Number.isInteger(year) || year < 2000 || year > 2100) problems.fiscalYear = 'year';
  }
  return problems;
}

export const openBody = (form: OpenForm): { project_id: string; settlement_scope: Scope; contract_id?: string; fiscal_year?: number } => ({
  project_id: form.projectId.trim(),
  settlement_scope: form.scope,
  ...(form.scope === 'CONTRACT' ? { contract_id: form.contractId.trim() } : {}),
  ...(form.scope === 'ANNUAL' ? { fiscal_year: Number(form.fiscalYear.trim()) } : {}),
});

export interface RefreshForm {
  note: string;
}

export function validateRefresh(form: RefreshForm): Partial<Record<keyof RefreshForm, FormProblem>> {
  return form.note.trim().length > MAX_TEXT ? { note: 'tooLong' } : {};
}

export const refreshBody = (form: RefreshForm): { note?: string } => (form.note.trim() === '' ? {} : { note: form.note.trim() });

export interface SubmitForm {
  submittedOn: string;
}

/** The day of the submission: a real day, not in the future of today in Vietnam. */
export function validateSubmit(form: SubmitForm, today: string): Partial<Record<keyof SubmitForm, FormProblem>> {
  const day = form.submittedOn.trim();
  if (day === '') return { submittedOn: 'required' };
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return { submittedOn: 'day' };
  return day > today ? { submittedOn: 'future' } : {};
}

export const submitBody = (form: SubmitForm): { submitted_on: string } => ({ submitted_on: form.submittedOn.trim() });

export interface VerifyForm {
  findings: string;
  refs: string;
}

export const EMPTY_VERIFY: VerifyForm = { findings: '', refs: '' };

const refList = (value: string): string[] =>
  value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');

export function validateVerify(form: VerifyForm): Partial<Record<keyof VerifyForm, FormProblem>> {
  const problems: Partial<Record<keyof VerifyForm, FormProblem>> = {};
  const findings = form.findings.trim();
  if (findings === '') problems.findings = 'required';
  else if (findings.length > MAX_TEXT) problems.findings = 'tooLong';
  const refs = refList(form.refs);
  if (refs.length > MAX_REFS) problems.refs = 'tooMany';
  else if (!refs.every(isUuid)) problems.refs = 'uuids';
  return problems;
}

export const verifyBody = (form: VerifyForm, outcome: Outcome): { outcome: Outcome; findings: string; audit_finding_refs?: string[] } => {
  const refs = refList(form.refs);
  return { outcome, findings: form.findings.trim(), ...(refs.length > 0 ? { audit_finding_refs: refs } : {}) };
};

export interface ExceptionForm {
  reason: string;
  approvalDocumentVersionId: string;
}

export const EMPTY_EXCEPTION: ExceptionForm = { reason: '', approvalDocumentVersionId: '' };

export function validateException(form: ExceptionForm): Partial<Record<keyof ExceptionForm, FormProblem>> {
  const problems: Partial<Record<keyof ExceptionForm, FormProblem>> = {};
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length > MAX_TEXT) problems.reason = 'tooLong';
  const document = form.approvalDocumentVersionId.trim();
  if (document === '') problems.approvalDocumentVersionId = 'required';
  else if (!isUuid(document)) problems.approvalDocumentVersionId = 'uuid';
  return problems;
}

export const exceptionBody = (form: ExceptionForm): { reason: string; approval_document_version_id: string } => ({
  reason: form.reason.trim(),
  approval_document_version_id: form.approvalDocumentVersionId.trim(),
});

export interface CloseForm {
  reason: string;
  decisionDocumentVersionId: string;
  evidence: string;
}

export const EMPTY_CLOSE: CloseForm = { reason: '', decisionDocumentVersionId: '', evidence: '' };

export function validateClose(form: CloseForm): Partial<Record<keyof CloseForm, FormProblem>> {
  const problems: Partial<Record<keyof CloseForm, FormProblem>> = {};
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length > MAX_TEXT) problems.reason = 'tooLong';
  const document = form.decisionDocumentVersionId.trim();
  if (document === '') problems.decisionDocumentVersionId = 'required';
  else if (!isUuid(document)) problems.decisionDocumentVersionId = 'uuid';
  const evidence = refList(form.evidence);
  if (evidence.length > MAX_REFS) problems.evidence = 'tooMany';
  else if (!evidence.every(isUuid)) problems.evidence = 'uuids';
  return problems;
}

export const closeBody = (form: CloseForm): { decision: 'approve'; reason: string; evidence_ids: string[]; decision_document_version_id: string } => ({
  decision: 'approve',
  reason: form.reason.trim(),
  evidence_ids: refList(form.evidence),
  decision_document_version_id: form.decisionDocumentVersionId.trim(),
});

// ---- refusals -----------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'openExists'
  | 'stageInvalid'
  | 'groupMissing'
  | 'ruleUnconfirmed'
  | 'stateInvalid'
  | 'noOutstanding'
  | 'hasOutstanding'
  | 'decisionRequired'
  | 'approvalRequired'
  | 'notClean'
  | 'selfApproval'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'SETTLEMENT_OPEN_EXISTS':
      return 'openExists';
    case 'PROJECT_STAGE_INVALID':
      return 'stageInvalid';
    case 'PROJECT_GROUP_MISSING':
      return 'groupMissing';
    case 'DEADLINE_RULE_UNCONFIRMED':
      return 'ruleUnconfirmed';
    case 'SETTLEMENT_STATE_INVALID':
      return 'stateInvalid';
    case 'NO_OUTSTANDING_TO_EXCEPT':
      return 'noOutstanding';
    case 'SETTLEMENT_HAS_OUTSTANDING':
      return 'hasOutstanding';
    case 'DECISION_DOCUMENT_REQUIRED':
      return 'decisionRequired';
    case 'APPROVAL_REQUIRED':
      return 'approvalRequired';
    case 'DOCUMENT_NOT_CLEAN':
      return 'notClean';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}
