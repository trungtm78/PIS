import { ApiError } from '@machvon/api-client';
import { toContractView } from '../model';
import type { ContractView } from '../model';

/** The permissions of the commands of CTR-03 (x-permission of the operations in openapi.json); the server judges each command again, with the scope and the delegation limit. */
export const SUBMIT_PERMISSION = 'contract.review.submit';
export const RETURN_PERMISSION = 'contract.review.decide';
export const SIGN_PERMISSION = 'contract.sign';
export const ACTIVATE_PERMISSION = 'contract.activate';

export const MAX_TEXT = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const COMMANDS = ['submit', 'return', 'sign', 'activate', 'cancel'] as const;
export type Command = (typeof COMMANDS)[number];
export type Actions = Record<Command, boolean>;

export type GateStatus = 'NOT_REQUIRED' | 'PASSED' | 'PASSED_WITH_WAIVER' | 'BLOCKED';
const GATE_STATUSES: readonly GateStatus[] = ['NOT_REQUIRED', 'PASSED', 'PASSED_WITH_WAIVER', 'BLOCKED'];

/** What stands between the contract and its activation, as the server reads it now. */
export interface Readiness {
  boq: { totalVnd: string; balanced: boolean };
  guarantee: { required: boolean; held: boolean };
  permitGate: { required: boolean; status: GateStatus; blocking: string[] };
  capital: { allocationLineId: string | null };
  project: { status: string; inImplementation: boolean };
}

/** The summary of a contract (CTR-03): the contract, the people and the document behind its signature, what stands before its activation (staff only) and what the caller may do now. */
export interface Summary {
  contract: ContractView;
  createdBy: string | null;
  submittedBy: string | null;
  signedBy: string | null;
  signedOn: string | null;
  signedDocumentVersionId: string | null;
  conflictDecisionRef: string | null;
  activatedBy: string | null;
  effectiveFrom: string | null;
  readiness: Readiness | undefined;
  actions: Actions | undefined;
}

function toReadiness(raw: unknown): Readiness | undefined {
  const row = isRecord(raw) ? raw : undefined;
  const boq = isRecord(row?.boq) ? row.boq : undefined;
  const guarantee = isRecord(row?.guarantee) ? row.guarantee : undefined;
  const gate = isRecord(row?.permit_gate) ? row.permit_gate : undefined;
  const capital = isRecord(row?.capital) ? row.capital : undefined;
  const project = isRecord(row?.project) ? row.project : undefined;
  const total = text(boq?.total_vnd);
  const status = GATE_STATUSES.find((candidate) => candidate === gate?.status);
  if (row === undefined || total === undefined || status === undefined || guarantee === undefined || capital === undefined || project === undefined) return undefined;
  return {
    boq: { totalVnd: total, balanced: boq?.balanced === true },
    guarantee: { required: guarantee.required === true, held: guarantee.held === true },
    permitGate: { required: gate?.required === true, status, blocking: (Array.isArray(gate?.blocking) ? gate.blocking : []).filter((item): item is string => typeof item === 'string') },
    capital: { allocationLineId: text(capital.allocation_line_id) ?? null },
    project: { status: text(project.status) ?? '', inImplementation: project.in_implementation === true },
  };
}

function toActions(raw: unknown): Actions | undefined {
  const row = isRecord(raw) ? raw : undefined;
  if (row === undefined) return undefined;
  return { submit: row.submit === true, return: row.return === true, sign: row.sign === true, activate: row.activate === true, cancel: row.cancel === true };
}

export function toSummary(raw: unknown): Summary | undefined {
  const contract = toContractView(raw);
  const row = isRecord(raw) ? raw : undefined;
  if (contract === undefined || row === undefined) return undefined;
  return {
    contract,
    createdBy: text(row.created_by) ?? null,
    submittedBy: text(row.submitted_by) ?? null,
    signedBy: text(row.signed_by) ?? null,
    signedOn: text(row.signed_on) ?? null,
    signedDocumentVersionId: text(row.signed_document_version_id) ?? null,
    conflictDecisionRef: text(row.conflict_decision_ref) ?? null,
    activatedBy: text(row.activated_by) ?? null,
    effectiveFrom: text(row.effective_from) ?? null,
    readiness: toReadiness(row.readiness),
    actions: toActions(row.actions),
  };
}

/** The checks the workspace shows before the activation, in the order the activation judges them; ok is undefined for a check that does not apply. */
export interface Check {
  key: 'boq' | 'guarantee' | 'permitGate' | 'capital' | 'project';
  ok: boolean | undefined;
  detail: string[];
}

export function checksOf(readiness: Readiness): Check[] {
  return [
    { key: 'boq', ok: readiness.boq.balanced, detail: [readiness.boq.totalVnd] },
    { key: 'guarantee', ok: readiness.guarantee.required ? readiness.guarantee.held : undefined, detail: [] },
    { key: 'permitGate', ok: readiness.permitGate.required ? readiness.permitGate.status !== 'BLOCKED' : undefined, detail: readiness.permitGate.blocking },
    { key: 'capital', ok: readiness.capital.allocationLineId !== null, detail: [] },
    { key: 'project', ok: readiness.project.inImplementation, detail: [readiness.project.status] },
  ];
}

/** The statuses before the activation, in which the checks are shown. */
export const BEFORE_ACTIVATION: readonly string[] = ['DRAFT', 'IN_REVIEW', 'SIGNED'];

// ---- the forms -----------------------------------------------------------------------------------------------------------------

export const isDate = (value: string): boolean => {
  const match = DATE.exec(value.trim());
  if (match === null) return false;
  const moment = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return moment.toISOString().slice(0, 10) === value.trim();
};

export type FormProblem = 'required' | 'date' | 'future' | 'beforeSigning' | 'uuid' | 'tooLong' | 'evidence';

export interface NoteForm {
  text: string;
}
export const EMPTY_NOTE: NoteForm = { text: '' };

/** The note of a submission may be empty; the reason of a return may not. Both are at most 2000 characters. */
export function validateNote(form: NoteForm, required: boolean): Partial<Record<'text', FormProblem>> {
  const words = form.text.trim();
  if (required && words === '') return { text: 'required' };
  if (words.length > MAX_TEXT) return { text: 'tooLong' };
  return {};
}

export interface SignForm {
  signedOn: string;
  documentVersionId: string;
  decisionRef: string;
}
export const emptySign = (today: string): SignForm => ({ signedOn: today, documentVersionId: '', decisionRef: '' });

export function validateSign(form: SignForm, today: string): Partial<Record<keyof SignForm, FormProblem>> {
  const problems: Partial<Record<keyof SignForm, FormProblem>> = {};
  if (form.signedOn.trim() === '') problems.signedOn = 'required';
  else if (!isDate(form.signedOn)) problems.signedOn = 'date';
  else if (form.signedOn.trim() > today) problems.signedOn = 'future';
  if (form.documentVersionId.trim() === '') problems.documentVersionId = 'required';
  else if (!UUID.test(form.documentVersionId.trim())) problems.documentVersionId = 'uuid';
  if (form.decisionRef.trim().length > MAX_TEXT) problems.decisionRef = 'tooLong';
  return problems;
}

export interface SignBody {
  signed_on: string;
  signed_document_version_id: string;
  conflict_decision_ref?: string;
}

export function signBody(form: SignForm): SignBody {
  const ref = form.decisionRef.trim();
  return { signed_on: form.signedOn.trim(), signed_document_version_id: form.documentVersionId.trim().toLowerCase(), ...(ref === '' ? {} : { conflict_decision_ref: ref }) };
}

export interface ActivateForm {
  effectiveFrom: string;
  reason: string;
  /** One identifier of a document per line, or separated by commas. */
  evidence: string;
}
export const emptyActivate = (today: string): ActivateForm => ({ effectiveFrom: today, reason: '', evidence: '' });

export const evidenceIds = (form: ActivateForm): string[] =>
  form.evidence
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');

export function validateActivate(form: ActivateForm, signedOn: string | null): Partial<Record<keyof ActivateForm, FormProblem>> {
  const problems: Partial<Record<keyof ActivateForm, FormProblem>> = {};
  if (form.effectiveFrom.trim() === '') problems.effectiveFrom = 'required';
  else if (!isDate(form.effectiveFrom)) problems.effectiveFrom = 'date';
  else if (signedOn !== null && form.effectiveFrom.trim() < signedOn) problems.effectiveFrom = 'beforeSigning';
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length > MAX_TEXT) problems.reason = 'tooLong';
  if (evidenceIds(form).some((item) => !UUID.test(item))) problems.evidence = 'evidence';
  return problems;
}

export interface ActivateBody {
  decision: 'approve';
  reason: string;
  evidence_ids: string[];
  effective_from: string;
}

export const activateBody = (form: ActivateForm): ActivateBody => ({ decision: 'approve', reason: form.reason.trim(), evidence_ids: [...new Set(evidenceIds(form))], effective_from: form.effectiveFrom.trim() });

// ---- refusals ------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'conflictActor'
  | 'conflictReviewer'
  | 'selfApproval'
  | 'delegation'
  | 'noRule'
  | 'guaranteeMissing'
  | 'gateBlocked'
  | 'fundFailed'
  | 'projectStage'
  | 'boqMismatch'
  | 'jvShares'
  | 'capitalPlan'
  | 'ceiling'
  | 'contractor'
  | 'documentNotClean'
  | 'stateInvalid'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ProblemView {
  problem: Problem;
  /** The permit types that block the gate, or the cause the capital gave: what the sentence adds to the code. */
  detail: string[];
}

const causes = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((item) => (isRecord(item) && typeof item.permit_type_code === 'string' ? [item.permit_type_code] : [])) : []);

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { problem: 'general', detail: [] };
  const extensions = error.extensions;
  switch (error.code) {
    case 'CONFLICT_OF_INTEREST_BLOCKED':
      return { problem: extensions.conflict_of === 'REVIEWER' ? 'conflictReviewer' : 'conflictActor', detail: [] };
    case 'SELF_APPROVAL_DENIED':
      return { problem: 'selfApproval', detail: [] };
    case 'SCOPE_DENIED':
      return { problem: extensions.approver_role_id === undefined ? 'denied' : 'delegation', detail: [] };
    case 'DOA_RULE_NOT_FOUND':
      return { problem: 'noRule', detail: [] };
    case 'PERFORMANCE_GUARANTEE_MISSING':
      return { problem: 'guaranteeMissing', detail: [] };
    case 'PERMIT_GATE_BLOCKED':
      return { problem: 'gateBlocked', detail: causes(extensions.blocking) };
    case 'FUND_COMMIT_FAILED':
      return { problem: 'fundFailed', detail: typeof extensions.cause === 'string' ? [extensions.cause] : [] };
    case 'PROJECT_STAGE_INVALID':
      return { problem: 'projectStage', detail: [] };
    case 'BOQ_TOTAL_MISMATCH':
      return { problem: 'boqMismatch', detail: [] };
    case 'JV_SHARE_NOT_100':
      return { problem: 'jvShares', detail: [] };
    case 'CAPITAL_PLAN_NOT_APPROVED':
      return { problem: 'capitalPlan', detail: [] };
    case 'CONTRACT_VALUE_EXCEEDS_CEILING':
      return { problem: 'ceiling', detail: [] };
    case 'CONTRACTOR_NOT_VERIFIED':
    case 'CONTRACTOR_RESTRICTED':
      return { problem: 'contractor', detail: [] };
    case 'DOCUMENT_NOT_CLEAN':
      return { problem: 'documentNotClean', detail: [] };
    case 'CONTRACT_STATE_INVALID':
      return { problem: 'stateInvalid', detail: [] };
    case 'VERSION_CONFLICT':
      return { problem: 'versionConflict', detail: [] };
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return { problem: 'validation', detail: [] };
    case 'RESOURCE_NOT_FOUND':
      return { problem: 'notFound', detail: [] };
    case 'ENTITLEMENT_DENIED':
      return { problem: 'denied', detail: [] };
    case 'SESSION_EXPIRED':
      return { problem: 'session', detail: [] };
    default:
      return { problem: 'general', detail: [] };
  }
}

/** The Vietnam calendar day of a moment: the day a signature or an activation counts by. */
export const vietnamToday = (now: Date): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

