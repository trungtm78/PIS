import { ApiError } from '@machvon/api-client';
import type { Proposal } from '../proposal/model';

/** The permissions of BID-11 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the project and of the contractor. */
export const READ_PERMISSION = 'bid.clarification.read';
export const ANSWER_PERMISSION = 'bid.clarification.answer';
export const SEND_PERMISSION = 'bid.evaluate';

export const CLARIFICATION_STATUSES = ['DRAFT', 'SENT', 'ANSWERED', 'EXPIRED', 'WITHDRAWN'] as const;
export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];

/** A question says what is unclear in at least ten characters once trimmed and fits a letter; the server holds the same limits. */
export const MIN_QUESTION = 10;
export const MAX_QUESTION = 4000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/** Whether the caller is offered the question form: the right to evaluate is held and the session is not read-only. */
export const canSend = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && holds(permissions, SEND_PERMISSION);

export interface Person {
  membershipId: string;
  displayName: string;
}

/** One request as BID-11 shows it. A contractor's view has no `askedBy` and no `basis`: the evaluators stay anonymous and the findings of the evaluation are not theirs. */
export interface Clarification {
  id: string;
  package: { id: string; code: string };
  proposalId: string;
  contractor: { id: string; legalName: string };
  question: string;
  basis: { id: string; criterionCode: string } | null;
  dueAt: string;
  status: ClarificationStatus;
  sentDocumentId: string | null;
  answerDocumentId: string | null;
  answeredAt: string | null;
  answeredBy: Person | null;
  answeredAsGuest: boolean | null;
  askedBy: Person | null;
  createdAt: string;
  /** The server says the caller may record the answer now; the screen adds the session and the permission. */
  canAnswer: boolean;
  version: number;
}

function toPerson(raw: unknown): Person | null {
  const row = asRecord(raw);
  const membershipId = text(row?.membership_id);
  return row === undefined || membershipId === undefined ? null : { membershipId, displayName: text(row.display_name) ?? '' };
}

export function toClarification(raw: unknown): Clarification | undefined {
  const row = asRecord(raw);
  const pack = asRecord(row?.package);
  const contractor = asRecord(row?.contractor);
  const basis = asRecord(row?.basis_finding);
  const id = text(row?.id);
  const packageId = text(pack?.id);
  const proposalId = text(row?.proposal_id);
  const contractorId = text(contractor?.id);
  const question = text(row?.question);
  const dueAt = text(row?.due_at);
  const createdAt = text(row?.created_at);
  const status = CLARIFICATION_STATUSES.find((candidate) => candidate === row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || packageId === undefined || proposalId === undefined || contractorId === undefined || question === undefined || dueAt === undefined || createdAt === undefined) return undefined;
  if (status === undefined || version === undefined) return undefined;
  const basisId = text(basis?.id);
  return {
    id,
    package: { id: packageId, code: text(pack?.code) ?? '' },
    proposalId,
    contractor: { id: contractorId, legalName: text(contractor?.legal_name) ?? '' },
    question,
    basis: basisId === undefined ? null : { id: basisId, criterionCode: text(basis?.criterion_code) ?? '' },
    dueAt,
    status,
    sentDocumentId: nullableText(row.sent_document_id),
    answerDocumentId: nullableText(row.answer_document_id),
    answeredAt: nullableText(row.answered_at),
    answeredBy: toPerson(row.answered_by),
    answeredAsGuest: typeof row.answered_as_guest === 'boolean' ? row.answered_as_guest : null,
    askedBy: toPerson(row.asked_by),
    createdAt,
    canAnswer: asRecord(row.actions)?.answer === true,
    version,
  };
}

export function toClarificationList(raw: unknown): Clarification[] {
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toClarification(item) ?? []) : [];
}

/**
 * The status as it stands at `now`: a request nobody answered by its deadline is EXPIRED, whether the server has said so yet or the page was read before the deadline. A request that was answered, withdrawn
 * or not yet sent stays what it is.
 */
export function statusAt(line: Clarification, now: Date): ClarificationStatus {
  if (line.status === 'SENT' && Date.parse(line.dueAt) < now.getTime()) return 'EXPIRED';
  return line.status;
}

/** Whether the caller is offered the answer of a request: it waits, its time is not up, the session is not read-only, the right is held and the server said so. */
export function mayAnswer(line: Clarification, permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined, now: Date): boolean {
  return mode !== 'READ_ONLY' && holds(permissions, ANSWER_PERMISSION) && line.canAnswer && statusAt(line, now) === 'SENT';
}

// ---- the recipients ------------------------------------------------------------------------------------------------------------------------

export interface Recipient {
  proposalId: string;
  contractorName: string;
}

/** The proposals a question can be asked about: the live ones the caller has in full. A replaced or withdrawn proposal takes no question, and one the caller sees only in part is not theirs to question. */
export function recipientsOf(proposals: readonly Proposal[]): Recipient[] {
  return proposals
    .filter((proposal) => proposal.status === 'RECEIVED' && proposal.access === 'FULL')
    .map((proposal) => ({ proposalId: proposal.id, contractorName: proposal.contractorName }))
    .sort((a, b) => a.contractorName.localeCompare(b.contractorName) || a.proposalId.localeCompare(b.proposalId));
}

// ---- asking -----------------------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'uuid' | 'tooShort' | 'tooLong' | 'moment' | 'past';

export interface SendForm {
  proposalId: string;
  question: string;
  basisFindingId: string;
  /** What the `datetime-local` control holds: a moment without a zone, read in the zone of the person. */
  dueAt: string;
}

export const emptySend = (proposalId = ''): SendForm => ({ proposalId, question: '', basisFindingId: '', dueAt: '' });

const momentOf = (local: string): number => (LOCAL_MOMENT.test(local) ? new Date(local).getTime() : Number.NaN);

/** What is wrong with the question before it is sent: the recipient, the words, the finding it rests on when one is named, and a deadline that is a moment and lies ahead. The server judges each again. */
export function validateSend(form: SendForm, now: Date): Partial<Record<keyof SendForm, FormProblem>> {
  const problems: Partial<Record<keyof SendForm, FormProblem>> = {};
  if (form.proposalId === '') problems.proposalId = 'required';
  const length = form.question.trim().length;
  if (length < MIN_QUESTION) problems.question = 'tooShort';
  else if (length > MAX_QUESTION) problems.question = 'tooLong';
  const basis = form.basisFindingId.trim();
  if (basis !== '' && !UUID.test(basis)) problems.basisFindingId = 'uuid';
  const due = form.dueAt.trim();
  if (due === '') problems.dueAt = 'required';
  else if (Number.isNaN(momentOf(due))) problems.dueAt = 'moment';
  else if (momentOf(due) <= now.getTime()) problems.dueAt = 'past';
  return problems;
}

export interface SendBody {
  proposal_id: string;
  question: string;
  due_at: string;
  basis_finding_id?: string;
}

export function sendBody(form: SendForm): SendBody {
  const basis = form.basisFindingId.trim();
  return {
    proposal_id: form.proposalId,
    question: form.question.trim(),
    due_at: new Date(form.dueAt.trim()).toISOString(),
    ...(basis === '' ? {} : { basis_finding_id: basis.toLowerCase() }),
  };
}

// ---- answering ------------------------------------------------------------------------------------------------------------------------------

/** What is typed for each request, by its id: the document that answers it. */
export type AnswerDrafts = Readonly<Record<string, string>>;

export const withAnswerDraft = (drafts: AnswerDrafts, id: string, documentId: string): AnswerDrafts => ({ ...drafts, [id]: documentId });
export const withoutAnswerDraft = (drafts: AnswerDrafts, id: string): AnswerDrafts => Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== id));

/** The answer rests on a document of DOC. */
export function validateAnswer(documentId: string): FormProblem | undefined {
  const value = documentId.trim();
  if (value === '') return 'required';
  return UUID.test(value) ? undefined : 'uuid';
}

export interface AnswerBody {
  answer_document_id: string;
}

export const answerBody = (documentId: string): AnswerBody => ({ answer_document_id: documentId.trim().toLowerCase() });

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'dueInPast'
  | 'proposalNotOpen'
  | 'undeclared'
  | 'expired'
  | 'answered'
  | 'versionConflict'
  | 'documentUsed'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'DUE_IN_PAST':
      return 'dueInPast';
    case 'PROPOSAL_NOT_OPEN':
      return 'proposalNotOpen';
    case 'CONFLICT_UNDECLARED':
      return 'undeclared';
    case 'CLARIFICATION_EXPIRED':
      return 'expired';
    case 'CLARIFICATION_STATE_INVALID':
      return 'answered';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
      return error.extensions.reason === 'DOCUMENT_ALREADY_USED' ? 'documentUsed' : 'validation';
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

/** A read that is refused for the declaration of conflicts of interest is not an error of the screen: the member is told to declare first. */
export function readFailure(error: unknown): 'undeclared' | undefined {
  return error instanceof ApiError && error.code === 'CONFLICT_UNDECLARED' ? 'undeclared' : undefined;
}

/** The address of the declaration of conflicts of interest of the package, where a member who owes it makes it. */
export const declarationPath = (packageId: string): string => `/bid/bid-05?package=${encodeURIComponent(packageId)}`;
