import { ApiError } from '@machvon/api-client';
import { RECOMMENDATION_STATUSES, RECOMMENDATION_TYPES } from '../conclusion/model';
import type { RecommendationStatus, RecommendationType } from '../conclusion/model';
import { isDay, isUuid } from '../model';
import type { FormProblem } from '../model';

/** AUD-06 and AUD-07: the recommendations given to owners and followed to their end (ST-AUD-003, AUD 3.3 to 3.5). */
export const RECOMMENDATIONS_PATH = '/aud/aud-06';
export const BOARD_PATH = '/aud/aud-07';

/** The permissions that gate the buttons; the server decides again on every request, and the owner of a recommendation is the one it was given to. */
export const ASSIGN_PERMISSION = 'aud.recommendation.assign';
export const EXECUTE_PERMISSION = 'aud.recommendation.execute';
export const VERIFY_PERMISSION = 'aud.recommendation.verify';

export const ACTION_STATUSES = ['PLANNED', 'DONE', 'CANCELLED'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const DISPUTE_OUTCOMES = ['ACCEPTED_BY_AUTHORITY', 'REJECTED_BY_AUTHORITY'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

/** The columns of the board, in the order the work goes: what has been given out, what is being done, what is explained, what waits for the verifier, what is finished. */
export const BOARD_COLUMNS = ['ASSIGNED', 'IN_PROGRESS', 'DISPUTED', 'PENDING_VERIFICATION', 'CLOSED'] as const satisfies readonly RecommendationStatus[];
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

const COMMENT_MIN = 10;
const REASON_MIN = 20;
const ACTION_DESCRIPTION_MIN = 5;
const TEXT_MAX = 4000;
const CODE_MAX = 40;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);
const dong = (value: unknown): string | undefined => (typeof value === 'string' && /^[0-9]{1,24}$/.test(value) ? value : undefined);

export interface ActionItem {
  id: string;
  code: string;
  description: string;
  plannedOn: string;
  completedOn: string | null;
  status: ActionStatus;
  evidenceDocumentId: string | null;
  version: number;
}

/** A recommendation as AUD-06 and AUD-07 read it. */
export interface BoardItem {
  id: string;
  engagement: { id: string; code: string };
  code: string;
  type: RecommendationType;
  description: string;
  amountVnd: string | null;
  recoveredVnd: string;
  ownerUnit: { id: string; code: string; name: string } | null;
  ownerUser: { id: string; name: string } | null;
  dueOn: string | null;
  implementationDueOn: string | null;
  status: RecommendationStatus;
  disputeReason: string | null;
  disputeOutcome: DisputeOutcome | null;
  verificationNote: string | null;
  submittedBy: string | null;
  disputedBy: string | null;
  actions: ActionItem[];
  evidenceCount: number;
  version: number;
}

function toAction(raw: unknown): ActionItem | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.action_code);
  const description = text(row?.description);
  const plannedOn = text(row?.planned_on);
  const status = oneOf(ACTION_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || code === undefined || description === undefined || plannedOn === undefined || status === undefined || version === undefined) return undefined;
  return { id, code, description, plannedOn, completedOn: nullableText(row.completed_on), status, evidenceDocumentId: nullableText(row.evidence_document_id), version };
}

/** A recommendation the screen cannot read is dropped rather than shown half. */
export function toBoardItem(raw: unknown): BoardItem | undefined {
  const row = asRecord(raw);
  const engagement = asRecord(row?.engagement);
  const unit = asRecord(row?.owner_unit);
  const user = asRecord(row?.owner_user);
  const id = text(row?.id);
  const engagementId = text(engagement?.id);
  const code = text(row?.rec_code);
  const type = oneOf(RECOMMENDATION_TYPES, row?.rec_type);
  const description = text(row?.description);
  const status = oneOf(RECOMMENDATION_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || engagementId === undefined || code === undefined || type === undefined || description === undefined || status === undefined || version === undefined) return undefined;
  const unitId = text(unit?.id);
  const userId = text(user?.id);
  return {
    id,
    engagement: { id: engagementId, code: text(engagement?.engagement_code) ?? '' },
    code,
    type,
    description,
    amountVnd: dong(row.amount_vnd) ?? null,
    recoveredVnd: dong(row.recovered_vnd) ?? '0',
    ownerUnit: unitId === undefined ? null : { id: unitId, code: text(unit?.code) ?? '', name: text(unit?.name) ?? '' },
    ownerUser: userId === undefined ? null : { id: userId, name: text(user?.display_name) ?? '' },
    dueOn: nullableText(row.due_on),
    implementationDueOn: nullableText(row.implementation_due_on),
    status,
    disputeReason: nullableText(row.dispute_reason),
    disputeOutcome: oneOf(DISPUTE_OUTCOMES, row.dispute_outcome) ?? null,
    verificationNote: nullableText(row.verification_note),
    submittedBy: nullableText(row.submitted_by),
    disputedBy: nullableText(row.disputed_by),
    actions: (Array.isArray(row.actions) ? row.actions : []).flatMap((item) => toAction(item) ?? []),
    evidenceCount: whole(row.evidence_count) ?? 0,
    version,
  };
}

/** The recommendations that match the words typed: the code, the description and the owner. */
export function matching(items: readonly BoardItem[], words: string): BoardItem[] {
  const needle = words.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter((item) => `${item.code} ${item.description} ${item.ownerUnit?.name ?? ''} ${item.ownerUser?.name ?? ''}`.toLowerCase().includes(needle));
}

/** The items of one column of the board, in the order they came (by code). */
export const inColumn = (items: readonly BoardItem[], column: BoardColumn): BoardItem[] => items.filter((item) => item.status === column);

const DAY = 24 * 60 * 60 * 1000;

/** BR-AUD-06: the days a recommendation is late; none while it is closed, cancelled or disputed (the day stops counting), and none before the day has passed. */
export function lateDays(item: Pick<BoardItem, 'dueOn' | 'status'>, today: string): number {
  if (item.dueOn === null || item.status === 'CLOSED' || item.status === 'CANCELLED' || item.status === 'DISPUTED' || today <= item.dueOn) return 0;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${item.dueOn}T00:00:00Z`)) / DAY);
}

export interface Caller {
  userId: string | undefined;
  permissions: readonly string[] | undefined;
  mode: 'FULL' | 'READ_ONLY' | undefined;
}

const holds = (caller: Caller, permission: string): boolean => (caller.permissions === undefined || caller.permissions.includes(permission)) && caller.mode !== 'READ_ONLY';

/** Whether the work was given to the caller: to them by name, or to their unit when no person was named (the server judges which unit it reaches). */
export const isMine = (item: BoardItem, caller: Caller): boolean => (item.ownerUser === null ? item.ownerUnit !== null : item.ownerUser.id === caller.userId);

/** Whether the caller had a hand in the work: the owner, the one who reported it, the one who raised the dispute (BR-AUD-08). */
export const hadAHand = (item: BoardItem, caller: Caller): boolean => caller.userId !== undefined && [item.ownerUser?.id, item.submittedBy, item.disputedBy].includes(caller.userId);

export const canAssign = (item: BoardItem, caller: Caller): boolean => holds(caller, ASSIGN_PERMISSION) && (item.status === 'OPEN' || item.status === 'ASSIGNED');
export const canPlan = (item: BoardItem, caller: Caller): boolean => holds(caller, EXECUTE_PERMISSION) && (item.status === 'ASSIGNED' || item.status === 'IN_PROGRESS') && isMine(item, caller);
export const canComplete = (item: BoardItem, action: ActionItem, caller: Caller): boolean => holds(caller, EXECUTE_PERMISSION) && item.status === 'IN_PROGRESS' && action.status === 'PLANNED' && isMine(item, caller);
export const canSubmit = (item: BoardItem, caller: Caller): boolean => holds(caller, EXECUTE_PERMISSION) && item.status === 'IN_PROGRESS' && isMine(item, caller);
export const canDispute = (item: BoardItem, caller: Caller): boolean => holds(caller, EXECUTE_PERMISSION) && (item.status === 'ASSIGNED' || item.status === 'IN_PROGRESS') && isMine(item, caller);
export const canAttach = (item: BoardItem, caller: Caller): boolean =>
  holds(caller, EXECUTE_PERMISSION) && isMine(item, caller) && ['ASSIGNED', 'IN_PROGRESS', 'DISPUTED', 'PENDING_VERIFICATION'].includes(item.status);
export const canVerify = (item: BoardItem, caller: Caller): boolean => holds(caller, VERIFY_PERMISSION) && item.status === 'PENDING_VERIFICATION' && !hadAHand(item, caller);
export const canDecide = (item: BoardItem, caller: Caller): boolean => holds(caller, VERIFY_PERMISSION) && item.status === 'DISPUTED' && !hadAHand(item, caller);

export type RemediationFormProblem = FormProblem | 'afterDeadline';

type Problems<F> = Partial<Record<keyof F, RemediationFormProblem>>;

const wordsProblem = (value: string, max: number, min = 1): FormProblem | undefined => {
  const words = value.trim();
  if (words === '') return 'required';
  if (words.length < min) return 'tooShort';
  if (words.length > max) return 'tooLong';
  return CONTROL.test(words) ? 'invalid' : undefined;
};

const dayProblem = (value: string): FormProblem | undefined => {
  const day = value.trim();
  if (day === '') return 'required';
  return isDay(day) ? undefined : 'invalid';
};

const documentProblem = (value: string, required: boolean): FormProblem | undefined => {
  const document = value.trim();
  if (document === '') return required ? 'required' : undefined;
  return isUuid(document) ? undefined : 'invalid';
};

export interface AssignForm {
  ownerUnitId: string;
  ownerUserId: string;
  dueOn: string;
}

export const EMPTY_ASSIGN_FORM: AssignForm = { ownerUnitId: '', ownerUserId: '', dueOn: '' };

/** The owner unit and a day that is today or later and not after the implementation deadline of the conclusion, which is the deadline the server reads (BR-AUD-06). */
export function validateAssign(form: AssignForm, today: string, deadline: string | null): Problems<AssignForm> {
  const problems: Problems<AssignForm> = {};
  if (form.ownerUnitId === '') problems.ownerUnitId = 'required';
  const day = dayProblem(form.dueOn);
  if (day !== undefined) problems.dueOn = day;
  else if (form.dueOn.trim() < today) problems.dueOn = 'early';
  else if (deadline !== null && form.dueOn.trim() > deadline) problems.dueOn = 'afterDeadline';
  return problems;
}

export interface AssignBody {
  owner_unit_id: string;
  owner_user_id?: string;
  due_on: string;
}

export const assignBody = (form: AssignForm): AssignBody => ({ owner_unit_id: form.ownerUnitId, ...(form.ownerUserId === '' ? {} : { owner_user_id: form.ownerUserId }), due_on: form.dueOn.trim() });

export interface PlanForm {
  code: string;
  description: string;
  plannedOn: string;
}

export const EMPTY_PLAN_FORM: PlanForm = { code: '', description: '', plannedOn: '' };

export function validatePlan(form: PlanForm): Problems<PlanForm> {
  const problems: Problems<PlanForm> = {};
  const code = wordsProblem(form.code, CODE_MAX);
  if (code !== undefined) problems.code = code;
  const description = wordsProblem(form.description, TEXT_MAX, ACTION_DESCRIPTION_MIN);
  if (description !== undefined) problems.description = description;
  const day = dayProblem(form.plannedOn);
  if (day !== undefined) problems.plannedOn = day;
  return problems;
}

export interface PlanBody {
  action_code: string;
  description: string;
  planned_on: string;
}

export const planBody = (form: PlanForm): PlanBody => ({ action_code: form.code.trim(), description: form.description.trim(), planned_on: form.plannedOn.trim() });

export interface CompleteForm {
  completedOn: string;
  evidenceDocumentId: string;
}

export const EMPTY_COMPLETE_FORM: CompleteForm = { completedOn: '', evidenceDocumentId: '' };

/** The day the action was done, a day that has come, and the evidence of it: a document that is in force (the server checks that it is). */
export function validateComplete(form: CompleteForm, today: string): Problems<CompleteForm> {
  const problems: Problems<CompleteForm> = {};
  const day = dayProblem(form.completedOn);
  if (day !== undefined) problems.completedOn = day;
  else if (form.completedOn.trim() > today) problems.completedOn = 'future';
  const evidence = documentProblem(form.evidenceDocumentId, true);
  if (evidence !== undefined) problems.evidenceDocumentId = evidence;
  return problems;
}

export interface CompleteBody {
  completed_on: string;
  evidence_document_id: string;
}

export const completeBody = (form: CompleteForm): CompleteBody => ({ completed_on: form.completedOn.trim(), evidence_document_id: form.evidenceDocumentId.trim().toLowerCase() });

export interface DisputeForm {
  reason: string;
  documentId: string;
}

export const EMPTY_DISPUTE_FORM: DisputeForm = { reason: '', documentId: '' };

export function validateDispute(form: DisputeForm): Problems<DisputeForm> {
  const problems: Problems<DisputeForm> = {};
  const reason = wordsProblem(form.reason, TEXT_MAX, REASON_MIN);
  if (reason !== undefined) problems.reason = reason;
  const document = documentProblem(form.documentId, true);
  if (document !== undefined) problems.documentId = document;
  return problems;
}

export interface DisputeBody {
  dispute_reason: string;
  dispute_document_id: string;
}

export const disputeBody = (form: DisputeForm): DisputeBody => ({ dispute_reason: form.reason.trim(), dispute_document_id: form.documentId.trim().toLowerCase() });

export interface DecisionForm {
  outcome: '' | DisputeOutcome;
  authorityDocumentId: string;
}

export const EMPTY_DECISION_FORM: DecisionForm = { outcome: '', authorityDocumentId: '' };

export function validateDecision(form: DecisionForm): Problems<DecisionForm> {
  const problems: Problems<DecisionForm> = {};
  if (form.outcome === '') problems.outcome = 'required';
  const document = documentProblem(form.authorityDocumentId, true);
  if (document !== undefined) problems.authorityDocumentId = document;
  return problems;
}

export interface DecisionBody {
  outcome: DisputeOutcome;
  authority_document_id: string;
}

export const decisionBody = (form: DecisionForm): DecisionBody => ({ outcome: form.outcome as DisputeOutcome, authority_document_id: form.authorityDocumentId.trim().toLowerCase() });

export type VerifyDecision = 'CLOSE' | 'RETURN';

export interface VerifyForm {
  decision: '' | VerifyDecision;
  closureBasisDocumentId: string;
  comment: string;
}

export const EMPTY_VERIFY_FORM: VerifyForm = { decision: '', closureBasisDocumentId: '', comment: '' };

/** A closure may name the document it rests on; a return says in words what is left to do. */
export function validateVerify(form: VerifyForm): Problems<VerifyForm> {
  const problems: Problems<VerifyForm> = {};
  if (form.decision === '') problems.decision = 'required';
  if (form.decision === 'CLOSE') {
    const basis = documentProblem(form.closureBasisDocumentId, false);
    if (basis !== undefined) problems.closureBasisDocumentId = basis;
  }
  if (form.decision === 'RETURN') {
    const comment = wordsProblem(form.comment, 2000, COMMENT_MIN);
    if (comment !== undefined) problems.comment = comment;
  } else if (form.comment.trim().length > 2000) {
    problems.comment = 'tooLong';
  }
  return problems;
}

export interface VerifyBody {
  decision: VerifyDecision;
  closure_basis_document_id?: string;
  comment?: string;
}

export function verifyBody(form: VerifyForm): VerifyBody {
  const comment = form.comment.trim();
  return {
    decision: form.decision as VerifyDecision,
    ...(form.decision === 'CLOSE' && form.closureBasisDocumentId.trim() !== '' ? { closure_basis_document_id: form.closureBasisDocumentId.trim().toLowerCase() } : {}),
    ...(comment === '' ? {} : { comment }),
  };
}

/** The evidence is put on the recommendation or on one of its actions, chosen as "RECOMMENDATION" or "ACTION:id". */
export type EvidenceTarget = 'RECOMMENDATION' | `ACTION:${string}`;

export interface EvidenceForm {
  target: EvidenceTarget;
  documentId: string;
  note: string;
}

export const EMPTY_EVIDENCE_FORM: EvidenceForm = { target: 'RECOMMENDATION', documentId: '', note: '' };

export function validateEvidence(form: EvidenceForm): Problems<EvidenceForm> {
  const problems: Problems<EvidenceForm> = {};
  const document = documentProblem(form.documentId, true);
  if (document !== undefined) problems.documentId = document;
  if (form.note.trim().length > 1000) problems.note = 'tooLong';
  return problems;
}

export interface EvidenceBody {
  owner_kind: 'RECOMMENDATION' | 'ACTION';
  owner_id: string;
  document_id: string;
  note?: string;
}

export function evidenceBody(form: EvidenceForm, recommendationId: string): EvidenceBody {
  const action = form.target === 'RECOMMENDATION' ? undefined : form.target.slice('ACTION:'.length);
  const note = form.note.trim();
  return {
    owner_kind: action === undefined ? 'RECOMMENDATION' : 'ACTION',
    owner_id: action ?? recommendationId,
    document_id: form.documentId.trim().toLowerCase(),
    ...(note === '' ? {} : { note }),
  };
}

export type RemediationProblem =
  | 'notOwner'
  | 'ownerOutOfScope'
  | 'dueAfterDeadline'
  | 'recommendationState'
  | 'actionState'
  | 'actionDuplicate'
  | 'evidenceRequired'
  | 'openActions'
  | 'recoveryIncomplete'
  | 'selfApproval'
  | 'documentNotEffective'
  | 'decisionNotEffective'
  | 'engagementState'
  | 'versionConflict'
  | 'scopeDenied'
  | 'validation'
  | 'notFound'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, RemediationProblem>> = {
  NOT_OWNER: 'notOwner',
  OWNER_OUT_OF_SCOPE: 'ownerOutOfScope',
  DUE_AFTER_CONCLUSION_DEADLINE: 'dueAfterDeadline',
  RECOMMENDATION_STATE_INVALID: 'recommendationState',
  ACTION_STATE_INVALID: 'actionState',
  ACTION_CODE_DUPLICATE: 'actionDuplicate',
  EVIDENCE_REQUIRED: 'evidenceRequired',
  OPEN_ACTIONS_REMAIN: 'openActions',
  RECOVERY_INCOMPLETE: 'recoveryIncomplete',
  SELF_APPROVAL_DENIED: 'selfApproval',
  DOCUMENT_NOT_EFFECTIVE: 'documentNotEffective',
  DECISION_DOCUMENT_NOT_EFFECTIVE: 'decisionNotEffective',
  ENGAGEMENT_STATE_INVALID: 'engagementState',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export interface DescribedRemediation {
  problem: RemediationProblem;
  /** The deadline of the conclusion, when the server refused a day after it; what was left to recover, when it refused the report or the closure. */
  deadline: string | undefined;
  remainingVnd: string | undefined;
}

/** Maps the error of a command to what a dialog shows; an unknown failure is the general message, and a refusal that carries a figure carries it. */
export function describeRemediation(error: unknown): DescribedRemediation {
  if (!(error instanceof ApiError)) return { problem: 'general', deadline: undefined, remainingVnd: undefined };
  return {
    problem: PROBLEM_BY_CODE[error.code] ?? 'general',
    deadline: error.code === 'DUE_AFTER_CONCLUSION_DEADLINE' ? text(error.extensions.implementation_due_on) : undefined,
    remainingVnd: error.code === 'RECOVERY_INCOMPLETE' ? dong(error.extensions.remaining_vnd) : undefined,
  };
}
