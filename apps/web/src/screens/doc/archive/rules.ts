import { ApiError } from '@machvon/api-client';
import type { Dossier, RetentionClass, RetentionRule, RuleSet, StartBasis } from './types';

export type FieldProblem = 'required' | 'invalid' | 'tooShort' | 'tooLong';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY = /^[A-Z][A-Z0-9_]{1,59}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WHOLE = /^\d+$/;

/** The years a class stands for: the years of a rule are those of its class (a permanent class has none). */
export const CLASS_YEARS: Readonly<Record<RetentionClass, number | null>> = { PERMANENT: null, Y70: 70, Y20: 20, Y10: 10, Y5: 5 };

export const LIMITS = { archiveRef: { min: 3, max: 200 }, reason: { min: 10, max: 2000 }, comment: { max: 1000 }, confirmationRef: { min: 3, max: 50 }, legalBasis: { min: 3, max: 2000 }, note: { max: 1000 }, handoverMonths: { max: 240 }, precedence: { max: 1000 } } as const;

function lengthProblem(value: string, min: number, max: number): FieldProblem | undefined {
  const length = value.trim().length;
  if (length === 0) return 'required';
  if (length < min) return 'tooShort';
  if (length > max) return 'tooLong';
  return undefined;
}

function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

const hasProblem = (problems: Record<string, FieldProblem | undefined>): boolean => Object.values(problems).some((problem) => problem !== undefined);

// ---- handover ----------------------------------------------------------------------------------------------------------------

export interface HandoverForm {
  archiveRef: string;
  /** A `datetime-local` value (`2026-10-29T10:00`), in the time of the browser. */
  handedOverAt: string;
}
export const EMPTY_HANDOVER: HandoverForm = { archiveRef: '', handedOverAt: '' };
export type HandoverProblems = Partial<Record<keyof HandoverForm, FieldProblem>>;

export function validateHandover(form: HandoverForm): HandoverProblems {
  return {
    archiveRef: lengthProblem(form.archiveRef, LIMITS.archiveRef.min, LIMITS.archiveRef.max),
    handedOverAt: form.handedOverAt === '' ? 'required' : Number.isNaN(new Date(form.handedOverAt).getTime()) ? 'invalid' : undefined,
  };
}
export const handoverBody = (form: HandoverForm): Record<string, unknown> => ({ archive_ref: form.archiveRef.trim(), handed_over_at: new Date(form.handedOverAt).toISOString() });
export const handoverHasProblems = (problems: HandoverProblems): boolean => hasProblem(problems);

// ---- proposal ----------------------------------------------------------------------------------------------------------------

export type ProposalProblems = { reason?: FieldProblem | undefined };
export const validateProposal = (reason: string): ProposalProblems => ({ reason: lengthProblem(reason, LIMITS.reason.min, LIMITS.reason.max) });
export const proposalBody = (reason: string): Record<string, unknown> => ({ reason: reason.trim() });

// ---- decision ----------------------------------------------------------------------------------------------------------------

export interface DecisionForm {
  decision: 'APPROVE' | 'REJECT';
  councilDecisionDocumentId: string;
  comment: string;
}
export const EMPTY_DECISION: DecisionForm = { decision: 'APPROVE', councilDecisionDocumentId: '', comment: '' };
export type DecisionProblems = Partial<Record<'councilDecisionDocumentId' | 'comment', FieldProblem>>;

/** An approval names the document of the decision of the council; a rejection does not take one, and what is left in the field after the decision was switched is not looked at (nor sent). */
export function validateDecision(form: DecisionForm): DecisionProblems {
  const id = form.councilDecisionDocumentId.trim();
  return {
    councilDecisionDocumentId: form.decision === 'REJECT' ? undefined : id === '' ? 'required' : UUID.test(id) ? undefined : 'invalid',
    comment: form.comment.trim().length > LIMITS.comment.max ? 'tooLong' : undefined,
  };
}
export function decisionBody(form: DecisionForm): Record<string, unknown> {
  const comment = form.comment.trim();
  return {
    decision: form.decision,
    ...(form.decision === 'APPROVE' ? { council_decision_document_id: form.councilDecisionDocumentId.trim().toLowerCase() } : {}),
    ...(comment === '' ? {} : { comment }),
  };
}
export const decisionHasProblems = (problems: DecisionProblems): boolean => hasProblem(problems);

// ---- rules -------------------------------------------------------------------------------------------------------------------

export interface RuleForm {
  ruleSet: RuleSet;
  categoryCode: string;
  classCode: RetentionClass;
  startBasis: StartBasis;
  handoverMonths: string;
  precedence: string;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string;
}
export const EMPTY_RULE: RuleForm = { ruleSet: 'TENANT_CUSTOM', categoryCode: '', classCode: 'Y10', startBasis: 'FROM_CLOSED', handoverMonths: '12', precedence: '100', legalBasis: '', effectiveFrom: '', effectiveUntil: '' };
export type RuleProblems = Partial<Record<keyof RuleForm, FieldProblem>>;

function wholeProblem(value: string, max: number, min: number): FieldProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  return WHOLE.test(trimmed) && Number(trimmed) >= min && Number(trimmed) <= max ? undefined : 'invalid';
}

export function validateRule(form: RuleForm): RuleProblems {
  const from = form.effectiveFrom.trim();
  const until = form.effectiveUntil.trim();
  return {
    categoryCode: form.categoryCode.trim() === '' ? 'required' : CATEGORY.test(form.categoryCode.trim()) ? undefined : 'invalid',
    handoverMonths: wholeProblem(form.handoverMonths, LIMITS.handoverMonths.max, 0),
    precedence: wholeProblem(form.precedence, LIMITS.precedence.max, 1),
    legalBasis: lengthProblem(form.legalBasis, LIMITS.legalBasis.min, LIMITS.legalBasis.max),
    effectiveFrom: from === '' ? 'required' : isDay(from) ? undefined : 'invalid',
    effectiveUntil: until === '' ? undefined : !isDay(until) || (isDay(from) && until <= from) ? 'invalid' : undefined,
  };
}
export const ruleHasProblems = (problems: RuleProblems): boolean => hasProblem(problems);

export function ruleBody(form: RuleForm): Record<string, unknown> {
  const years = CLASS_YEARS[form.classCode];
  const until = form.effectiveUntil.trim();
  return {
    rule_set: form.ruleSet,
    category_code: form.categoryCode.trim(),
    class_code: form.classCode,
    ...(years === null ? {} : { retention_years: years }),
    start_basis: form.startBasis,
    handover_months: Number(form.handoverMonths.trim()),
    precedence: Number(form.precedence.trim()),
    legal_basis: form.legalBasis.trim(),
    effective_from: form.effectiveFrom.trim(),
    ...(until === '' ? {} : { effective_until: until }),
  };
}

// ---- confirmation ------------------------------------------------------------------------------------------------------------

export interface ConfirmForm {
  reference: string;
  evidenceDocumentId: string;
  note: string;
}
export const EMPTY_CONFIRM: ConfirmForm = { reference: '', evidenceDocumentId: '', note: '' };
export type ConfirmProblems = Partial<Record<keyof ConfirmForm, FieldProblem>>;

export function validateConfirm(form: ConfirmForm): ConfirmProblems {
  const evidence = form.evidenceDocumentId.trim();
  return {
    reference: lengthProblem(form.reference, LIMITS.confirmationRef.min, LIMITS.confirmationRef.max),
    evidenceDocumentId: evidence === '' ? 'required' : UUID.test(evidence) ? undefined : 'invalid',
    note: form.note.trim().length > LIMITS.note.max ? 'tooLong' : undefined,
  };
}
export const confirmBody = (form: ConfirmForm): Record<string, unknown> => {
  const note = form.note.trim();
  return { legal_confirmation_ref: form.reference.trim(), evidence_document_id: form.evidenceDocumentId.trim().toLowerCase(), ...(note === '' ? {} : { note }) };
};
export const confirmHasProblems = (problems: ConfirmProblems): boolean => hasProblem(problems);

// ---- who may do what ---------------------------------------------------------------------------------------------------------

/** A draft waits for a publisher who is not its drafter. */
export const canPublishRule = (rule: Pick<RetentionRule, 'status' | 'createdBy'>, membershipId: string | undefined): boolean =>
  rule.status === 'DRAFT' && (membershipId === undefined || rule.createdBy?.id !== membershipId);

/** A published rule waits for a confirmer who neither drafted nor published it. */
export const canConfirmRule = (rule: Pick<RetentionRule, 'status' | 'confirmationStatus' | 'createdBy' | 'approvedBy'>, membershipId: string | undefined): boolean =>
  rule.status === 'PUBLISHED' && rule.confirmationStatus === 'PENDING_CONFIRMATION' && (membershipId === undefined || (rule.createdBy?.id !== membershipId && rule.approvedBy?.id !== membershipId));

/** Dossiers whose retention is over and are in a state a disposal can be proposed from: what the server also checks, shown as a hint. */
export const retentionIsOver = (dossier: Pick<Dossier, 'retentionEndsOn' | 'provisional'>, today: string): boolean => !dossier.provisional && dossier.retentionEndsOn !== null && dossier.retentionEndsOn <= today;

// ---- what the server refuses -------------------------------------------------------------------------------------------------

export type ArchiveProblem =
  | 'notClosed'
  | 'provisional'
  | 'notExpired'
  | 'hold'
  | 'decisionDocument'
  | 'transition'
  | 'overlap'
  | 'state'
  | 'confirmationRef'
  | 'legalBasis'
  | 'selfApproval'
  | 'conflict'
  | 'notOpen'
  | 'empty'
  | 'duplicateCode'
  | 'notFileable'
  | 'alreadyIn'
  | 'letterState'
  | 'invalid'
  | 'scope'
  | 'notFound'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ArchiveProblem>> = {
  DOSSIER_NOT_CLOSED: 'notClosed',
  RETENTION_PROVISIONAL: 'provisional',
  RETENTION_NOT_EXPIRED: 'notExpired',
  LEGAL_HOLD_ACTIVE: 'hold',
  DECISION_DOCUMENT_REQUIRED: 'decisionDocument',
  STAGE_TRANSITION_DENIED: 'transition',
  RETENTION_RANGE_OVERLAP: 'overlap',
  RETENTION_STATE_INVALID: 'state',
  CONFIRMATION_REF_REQUIRED: 'confirmationRef',
  LEGAL_BASIS_REQUIRED: 'legalBasis',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'conflict',
  DOSSIER_NOT_OPEN: 'notOpen',
  DOSSIER_EMPTY: 'empty',
  DOSSIER_CODE_DUPLICATE: 'duplicateCode',
  DOCUMENT_NOT_FILEABLE: 'notFileable',
  DOCUMENT_ALREADY_IN_DOSSIER: 'alreadyIn',
  DOCUMENT_STATE_INVALID: 'letterState',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'scope',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeProblem = (error: unknown): ArchiveProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
