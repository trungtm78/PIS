import { ApiError } from '@machvon/api-client';
import type { TrackedPackage } from '../procurement/model';

/** The permissions of BID-18 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the project and the delegation limit. */
export const READ_PERMISSION = 'bid.read';
export const SUBMIT_PERMISSION = 'bid.result.submit';
export const APPROVE_PERMISSION = 'bid.result.approve';

export const OUTCOMES = ['AWARDED', 'NO_ACCEPTABLE_BID', 'CANCELLED'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const RESULT_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const MAX_COMMENT = 2000;
const PRICE = /^[0-9]{1,24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface Person {
  membershipId: string;
  displayName: string;
}

function toPerson(raw: unknown): Person | null {
  const row = asRecord(raw);
  const membershipId = text(row?.membership_id);
  return row === undefined || membershipId === undefined ? null : { membershipId, displayName: text(row.display_name) ?? '' };
}

/** One result of the selection of a contractor as BID-18 shows it. */
export interface ResultLine {
  id: string;
  package: { id: string; code: string; budgetVnd: string };
  outcome: Outcome;
  winner: { id: string; legalName: string } | null;
  awardPriceVnd: string | null;
  evaluationMinutes: { documentId: string; title: string } | null;
  decisionDocumentId: string | null;
  status: ResultStatus;
  submittedBy: Person | null;
  submittedAt: string | null;
  decidedBy: Person | null;
  decidedAt: string | null;
  comment: string | null;
  version: number;
}

export function toResultLine(raw: unknown): ResultLine | undefined {
  const row = asRecord(raw);
  const pack = asRecord(row?.package);
  const id = text(row?.id);
  const packageId = text(pack?.id);
  const code = text(pack?.code);
  const budget = text(pack?.budget_vnd);
  const outcome = OUTCOMES.find((candidate) => candidate === row?.outcome);
  const status = RESULT_STATUSES.find((candidate) => candidate === row?.status);
  const version = typeof row?.version === 'number' && Number.isInteger(row.version) ? row.version : undefined;
  if (row === undefined || id === undefined || packageId === undefined || code === undefined || budget === undefined || outcome === undefined || status === undefined || version === undefined) return undefined;
  const winner = asRecord(row.winner);
  const minutes = asRecord(row.evaluation_minutes);
  const winnerId = text(winner?.id);
  const minutesId = text(minutes?.document_id);
  return {
    id,
    package: { id: packageId, code, budgetVnd: budget },
    outcome,
    winner: winnerId === undefined ? null : { id: winnerId, legalName: text(winner?.legal_name) ?? '' },
    awardPriceVnd: nullableText(row.award_price_vnd),
    evaluationMinutes: minutesId === undefined ? null : { documentId: minutesId, title: text(minutes?.title) ?? '' },
    decisionDocumentId: nullableText(row.decision_document_id),
    status,
    submittedBy: toPerson(row.submitted_by),
    submittedAt: nullableText(row.submitted_at),
    decidedBy: toPerson(row.decided_by),
    decidedAt: nullableText(row.decided_at),
    comment: nullableText(row.comment),
    version,
  };
}

export function toResultList(raw: unknown): ResultLine[] {
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toResultLine(item) ?? []) : [];
}

// ---- who may do what ----------------------------------------------------------------------------------------------------------

const writes = (mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY';

export const canSubmit = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => writes(mode) && (permissions === undefined || permissions.includes(SUBMIT_PERMISSION));
export const canApprove = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => writes(mode) && (permissions === undefined || permissions.includes(APPROVE_PERMISSION));

/** The plan of the package is in force (APPROVED) and no result of it is waiting for a decision: a result can be submitted. */
export const canSubmitFor = (pack: TrackedPackage, results: readonly ResultLine[]): boolean => pack.status === 'APPROVED' && !results.some((line) => line.status === 'SUBMITTED' || line.status === 'DRAFT');

/** A result waiting for a decision may be decided by someone who holds the permission and did not submit it (the server refuses the proposer too; the screen does not offer it). */
export const canDecide = (line: ResultLine, membershipId: string | undefined, permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean =>
  line.status === 'SUBMITTED' && canApprove(permissions, mode) && (line.submittedBy === null || line.submittedBy.membershipId !== membershipId);

/** The packages that BID-18 is about: the ones whose plan is in force and the ones the selection has ended. */
export const RESULT_PACKAGE_STATUSES: readonly string[] = ['APPROVED', 'AWARDED', 'NO_ACCEPTABLE_BID', 'CANCELLED'];
export const resultPackages = (packages: readonly TrackedPackage[]): TrackedPackage[] => packages.filter((pack) => RESULT_PACKAGE_STATUSES.includes(pack.status));

// ---- the submission ---------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'price' | 'uuid' | 'tooLong' | 'notAllowed';

export interface SubmitForm {
  outcome: Outcome | '';
  winnerId: string;
  awardPriceVnd: string;
  minutesId: string;
}

export const EMPTY_SUBMIT: SubmitForm = { outcome: '', winnerId: '', awardPriceVnd: '', minutesId: '' };

/** What is wrong with the submission before it is sent: an award names its winner and its price, the other outcomes name neither, and the evaluation is a document. */
export function validateSubmit(form: SubmitForm): Partial<Record<keyof SubmitForm, FormProblem>> {
  const problems: Partial<Record<keyof SubmitForm, FormProblem>> = {};
  if (form.outcome === '') {
    problems.outcome = 'required';
  } else if (form.outcome === 'AWARDED') {
    if (form.winnerId === '') problems.winnerId = 'required';
    const price = form.awardPriceVnd.trim();
    if (price === '') problems.awardPriceVnd = 'required';
    else if (!PRICE.test(price) || /^0+$/.test(price)) problems.awardPriceVnd = 'price';
  } else {
    if (form.winnerId !== '') problems.winnerId = 'notAllowed';
    if (form.awardPriceVnd.trim() !== '') problems.awardPriceVnd = 'notAllowed';
  }
  const minutes = form.minutesId.trim();
  if (minutes === '') problems.minutesId = 'required';
  else if (!UUID.test(minutes)) problems.minutesId = 'uuid';
  return problems;
}

export interface SubmitBody {
  package_id: string;
  outcome: Outcome;
  evaluation_report_id: string;
  winner_contractor_id?: string;
  award_price_vnd?: string;
}

export function submitBody(packageId: string, form: SubmitForm): SubmitBody {
  const outcome = form.outcome === '' ? 'CANCELLED' : form.outcome;
  const body: SubmitBody = { package_id: packageId, outcome, evaluation_report_id: form.minutesId.trim().toLowerCase() };
  if (outcome === 'AWARDED') {
    body.winner_contractor_id = form.winnerId;
    body.award_price_vnd = form.awardPriceVnd.trim();
  }
  return body;
}

// ---- the decision -----------------------------------------------------------------------------------------------------------------

export type DecisionKind = 'APPROVE' | 'REJECT';

export interface DecideForm {
  decision: DecisionKind | '';
  documentId: string;
  comment: string;
}

export const EMPTY_DECIDE: DecideForm = { decision: '', documentId: '', comment: '' };

/** An approval rests on a decision document and may carry a note; a rejection says why in words and rests on no document. */
export function validateDecide(form: DecideForm): Partial<Record<keyof DecideForm, FormProblem>> {
  const problems: Partial<Record<keyof DecideForm, FormProblem>> = {};
  const comment = form.comment.trim();
  if (comment.length > MAX_COMMENT) problems.comment = 'tooLong';
  if (form.decision === '') {
    problems.decision = 'required';
  } else if (form.decision === 'APPROVE') {
    const document = form.documentId.trim();
    if (document === '') problems.documentId = 'required';
    else if (!UUID.test(document)) problems.documentId = 'uuid';
  } else {
    if (comment === '') problems.comment = 'required';
    if (form.documentId.trim() !== '') problems.documentId = 'notAllowed';
  }
  return problems;
}

export interface DecideBody {
  decision: DecisionKind;
  decision_document_id?: string;
  comment?: string;
}

export function decideBody(form: DecideForm): DecideBody {
  const decision = form.decision === '' ? 'REJECT' : form.decision;
  const comment = form.comment.trim();
  const body: DecideBody = { decision };
  if (decision === 'APPROVE') body.decision_document_id = form.documentId.trim().toLowerCase();
  if (comment !== '') body.comment = comment;
  return body;
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'priceExceeds'
  | 'planNotApproved'
  | 'restricted'
  | 'notVerified'
  | 'reportNotIssued'
  | 'openResult'
  | 'resultState'
  | 'selfApproval'
  | 'delegation'
  | 'noRule'
  | 'decisionDocument'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'PRICE_EXCEEDS_PACKAGE_BUDGET':
      return 'priceExceeds';
    case 'PLAN_NOT_APPROVED':
      return 'planNotApproved';
    case 'CONTRACTOR_RESTRICTED':
      return 'restricted';
    case 'CONTRACTOR_NOT_VERIFIED':
      return 'notVerified';
    case 'REPORT_NOT_ISSUED':
      return 'reportNotIssued';
    case 'RESULT_STATE_INVALID':
      return error.extensions.reason === 'OPEN_RESULT' ? 'openResult' : 'resultState';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'SCOPE_DENIED':
      return error.extensions.approver_role_id === undefined ? 'denied' : 'delegation';
    case 'DOA_RULE_NOT_FOUND':
      return 'noRule';
    case 'DECISION_DOCUMENT_NOT_EFFECTIVE':
      return 'decisionDocument';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}
