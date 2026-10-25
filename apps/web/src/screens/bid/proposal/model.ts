import { ApiError } from '@machvon/api-client';
import { localInput, momentOfInput } from '../procurement/model';
import type { MilestoneLine, TrackedPackage } from '../procurement/model';

/** The permissions of BID-05 (x-permission of the operations in openapi.json). */
export const RECEIVE_PERMISSION = 'bid.proposal.receive';
export const EVALUATE_PERMISSION = 'bid.evaluate';

/** A package takes proposals while its plan is in force (APPROVED); the others are not open for bids. */
export const OPEN_FOR_BIDS = 'APPROVED';

export const PROPOSAL_PARTS = ['LEGAL', 'TECHNICAL', 'FINANCIAL', 'OTHER'] as const;
export type ProposalPart = (typeof PROPOSAL_PARTS)[number];
export const PROPOSAL_STATUSES = ['RECEIVED', 'SUPERSEDED', 'WITHDRAWN'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const PROPOSAL_ACCESS = ['FULL', 'METADATA', 'DECLARATION_REQUIRED'] as const;
export type ProposalAccess = (typeof PROPOSAL_ACCESS)[number];
export const CONFLICT_DECISIONS = ['ALLOWED', 'RECUSED', 'BLOCKED'] as const;
export type ConflictDecision = (typeof CONFLICT_DECISIONS)[number];
export const DECLARATION_STANDINGS = ['CLEAR', 'PENDING', 'ALLOWED', 'RECUSED', 'BLOCKED'] as const;
export type DeclarationStanding = (typeof DECLARATION_STANDINGS)[number];

export const MAX_FILES = 500;
export const MAX_TITLE = 200;
export const MAX_RELATION = 2000;
export const MIN_REASON = 20;
/** The file types the door takes: a proposal is handed in as PDF. */
export const FILE_ACCEPT = 'application/pdf,.pdf';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

export const canReceive = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions ?? []).includes(RECEIVE_PERMISSION);
export const canEvaluate = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions ?? []).includes(EVALUATE_PERMISSION);

/** The packages that are open for bids, by code. */
export const openPackages = (packages: readonly TrackedPackage[]): TrackedPackage[] =>
  packages.filter((pack) => pack.status === OPEN_FOR_BIDS).sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));

/** The moment the bids of a package open: the day it happened, else the day it is planned for; null when the package has none. */
export function openingOf(packageId: string, milestones: readonly MilestoneLine[]): string | null {
  const opening = milestones.find((line) => line.packageId === packageId && line.kind === 'BID_OPENING');
  return opening === undefined ? null : (opening.actualAt ?? opening.plannedAt);
}

// ---- the proposals -----------------------------------------------------------------------------------------------------------------------

export interface ProposalFile {
  id: string;
  part: ProposalPart;
  title: string;
  mime: string;
  pageCount: number;
  sizeBytes: number | null;
}

export interface Proposal {
  id: string;
  packageId: string;
  packageCode: string;
  contractorId: string;
  contractorName: string;
  revision: number;
  status: ProposalStatus;
  submittedAt: string;
  accessReleasedAt: string;
  locked: boolean;
  fileCount: number;
  access: ProposalAccess;
  /** Only in the full view. */
  bidPriceVnd: string | null;
  documents: ProposalFile[];
  version: number;
}

function toFile(raw: unknown): ProposalFile | undefined {
  const row = isRecord(raw) ? raw : undefined;
  const id = text(row?.id);
  const part = oneOf(PROPOSAL_PARTS, row?.part);
  const title = text(row?.title);
  const pages = whole(row?.page_count);
  if (row === undefined || id === undefined || part === undefined || title === undefined || pages === undefined) return undefined;
  return { id, part, title, mime: text(row.mime) ?? '', pageCount: pages, sizeBytes: whole(row.size_bytes) ?? null };
}

export function toProposal(raw: unknown): Proposal | undefined {
  const row = isRecord(raw) ? raw : undefined;
  const pack = isRecord(row?.package) ? row.package : undefined;
  const contractor = isRecord(row?.contractor) ? row.contractor : undefined;
  const id = text(row?.id);
  const packageId = text(pack?.id);
  const contractorId = text(contractor?.id);
  const status = oneOf(PROPOSAL_STATUSES, row?.status);
  const access = oneOf(PROPOSAL_ACCESS, row?.access);
  const revision = whole(row?.revision);
  const version = whole(row?.version);
  const submittedAt = text(row?.submitted_at);
  const releasedAt = text(row?.access_released_at);
  if (row === undefined || id === undefined || packageId === undefined || contractorId === undefined || status === undefined || access === undefined) return undefined;
  if (revision === undefined || version === undefined || submittedAt === undefined || releasedAt === undefined) return undefined;
  return {
    id,
    packageId,
    packageCode: text(pack?.code) ?? '',
    contractorId,
    contractorName: text(contractor?.legal_name) ?? '',
    revision,
    status,
    submittedAt,
    accessReleasedAt: releasedAt,
    locked: row.locked !== false,
    fileCount: whole(row.file_count) ?? 0,
    access,
    bidPriceVnd: nullableText(row.bid_price_vnd),
    documents: (Array.isArray(row.documents) ? row.documents : []).flatMap((file) => toFile(file) ?? []),
    version,
  };
}

/** The proposals of a package: the live ones first (the newest first), the replaced ones after. */
export const orderedProposals = (proposals: readonly Proposal[]): Proposal[] =>
  [...proposals].sort((a, b) => Number(b.status === 'RECEIVED') - Number(a.status === 'RECEIVED') || b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id));

// ---- the declarations --------------------------------------------------------------------------------------------------------------------

export interface Declaration {
  id: string;
  memberName: string;
  hasConflict: boolean;
  relationText: string | null;
  contractorName: string | null;
  contractorId: string | null;
  declaredAt: string;
  decision: ConflictDecision | null;
  decisionReason: string | null;
  deciderName: string | null;
  standing: DeclarationStanding;
  own: boolean;
  version: number;
}

export interface DeclarationList {
  items: Declaration[];
  mayDecide: boolean;
}

export function toDeclaration(raw: unknown): Declaration | undefined {
  const row = isRecord(raw) ? raw : undefined;
  const member = isRecord(row?.member) ? row.member : undefined;
  const contractor = isRecord(row?.contractor) ? row.contractor : undefined;
  const decider = isRecord(row?.decided_by) ? row.decided_by : undefined;
  const id = text(row?.id);
  const standing = oneOf(DECLARATION_STANDINGS, row?.standing);
  const version = whole(row?.version);
  const declaredAt = text(row?.declared_at);
  if (row === undefined || id === undefined || standing === undefined || version === undefined || declaredAt === undefined || typeof row.has_conflict !== 'boolean') return undefined;
  return {
    id,
    memberName: text(member?.display_name) ?? '',
    hasConflict: row.has_conflict,
    relationText: nullableText(row.relation_text),
    contractorName: text(contractor?.legal_name) ?? null,
    contractorId: text(contractor?.id) ?? null,
    declaredAt,
    decision: oneOf(CONFLICT_DECISIONS, row.decision) ?? null,
    decisionReason: nullableText(row.decision_reason),
    deciderName: text(decider?.display_name) ?? null,
    standing,
    own: row.is_own === true,
    version,
  };
}

export function toDeclarationList(raw: unknown): DeclarationList {
  const body = isRecord(raw) ? raw : {};
  return { items: (Array.isArray(body.items) ? body.items : []).flatMap((item) => toDeclaration(item) ?? []), mayDecide: body.may_decide === true };
}

/** A contractor that may hand in a proposal: verified, by name. */
export interface ContractorOption {
  id: string;
  legalName: string;
  restricted: boolean;
}

export function toContractorOption(raw: unknown): ContractorOption | undefined {
  const row = isRecord(raw) ? raw : undefined;
  const id = text(row?.id);
  if (row === undefined || id === undefined || row.verification_status !== 'VERIFIED') return undefined;
  return { id, legalName: text(row.legal_name) ?? '', restricted: row.restriction_in_force !== null && row.restriction_in_force !== undefined };
}

// ---- the intake of a proposal ------------------------------------------------------------------------------------------------------------

export interface UploadedProposalFile {
  fileObjectKey: string;
  fileSha256: string;
  sizeBytes: number;
  pageCount: number;
}

export function toUploadedProposalFile(raw: unknown): UploadedProposalFile | undefined {
  const row = isRecord(raw) ? raw : undefined;
  const key = text(row?.file_object_key);
  const sha = text(row?.file_sha256);
  const size = whole(row?.size_bytes);
  const pages = whole(row?.page_count);
  if (row === undefined || key === undefined || sha === undefined || size === undefined || pages === undefined) return undefined;
  return { fileObjectKey: key, fileSha256: sha, sizeBytes: size, pageCount: pages };
}

export interface IntakeFile {
  /** Tells the rows of the form apart while the list changes. */
  uid: number;
  part: ProposalPart;
  title: string;
  /** The name of the file the clerk chose. */
  fileName: string;
  uploaded: UploadedProposalFile | undefined;
}

export interface IntakeForm {
  contractorId: string;
  submittedAt: string;
  price: string;
  files: IntakeFile[];
}

export const EMPTY_INTAKE: IntakeForm = { contractorId: '', submittedAt: '', price: '', files: [] };

export type IntakeProblem = 'required' | 'date' | 'future' | 'digits' | 'files' | 'tooMany' | 'title' | 'notUploaded';

export interface IntakeProblems {
  contractorId?: IntakeProblem;
  submittedAt?: IntakeProblem;
  price?: IntakeProblem;
  files?: IntakeProblem;
  /** By uid of the row. */
  rows: Record<number, IntakeProblem>;
}

/** What is wrong with a proposal before it is sent: the contractor, a hand-in time that is a real time and not in the future, a price in whole VND, and files that are named and stored. */
export function validateIntake(form: IntakeForm, now: Date): IntakeProblems {
  const problems: IntakeProblems = { rows: {} };
  if (form.contractorId === '') problems.contractorId = 'required';
  const handedIn = form.submittedAt.trim() === '' ? undefined : momentOfInput(form.submittedAt);
  if (form.submittedAt.trim() === '') problems.submittedAt = 'required';
  else if (handedIn === undefined) problems.submittedAt = 'date';
  else if (Date.parse(handedIn) > now.getTime()) problems.submittedAt = 'future';
  if (form.price.trim() !== '' && !/^[0-9]{1,24}$/.test(form.price.trim())) problems.price = 'digits';
  if (form.files.length === 0) problems.files = 'files';
  else if (form.files.length > MAX_FILES) problems.files = 'tooMany';
  for (const file of form.files) {
    const title = file.title.trim();
    if (title === '' || title.length > MAX_TITLE) problems.rows[file.uid] = 'title';
    else if (file.uploaded === undefined) problems.rows[file.uid] = 'notUploaded';
  }
  return problems;
}

export const hasProblems = (problems: IntakeProblems): boolean =>
  problems.contractorId !== undefined || problems.submittedAt !== undefined || problems.price !== undefined || problems.files !== undefined || Object.keys(problems.rows).length > 0;

export interface ReceiveBody {
  package_id: string;
  contractor_id: string;
  submitted_at: string;
  bid_price_vnd?: string;
  documents: Array<{ part: ProposalPart; title: string; file_object_key: string; file_sha256: string }>;
}

/** The body of the receipt: the price is left out when it is empty. Only files that are stored are named. */
export function receiveBody(packageId: string, form: IntakeForm): ReceiveBody {
  const price = form.price.trim();
  return {
    package_id: packageId,
    contractor_id: form.contractorId,
    submitted_at: momentOfInput(form.submittedAt) ?? '',
    ...(price === '' ? {} : { bid_price_vnd: price }),
    documents: form.files.flatMap((file) =>
      file.uploaded === undefined ? [] : [{ part: file.part, title: file.title.trim(), file_object_key: file.uploaded.fileObjectKey, file_sha256: file.uploaded.fileSha256 }],
    ),
  };
}

// ---- the declaration and its decision ----------------------------------------------------------------------------------------------------

export interface DeclareForm {
  /** undefined until the member answers: the question is asked, never assumed. */
  hasConflict: boolean | undefined;
  relation: string;
  contractorId: string;
}

export const EMPTY_DECLARE: DeclareForm = { hasConflict: undefined, relation: '', contractorId: '' };

export type DeclareProblem = 'answer' | 'relation' | 'tooLong';

export function validateDeclare(form: DeclareForm): Partial<Record<'hasConflict' | 'relation', DeclareProblem>> {
  const problems: Partial<Record<'hasConflict' | 'relation', DeclareProblem>> = {};
  if (form.hasConflict === undefined) problems.hasConflict = 'answer';
  else if (form.hasConflict) {
    const relation = form.relation.trim();
    if (relation === '') problems.relation = 'relation';
    else if (relation.length > MAX_RELATION) problems.relation = 'tooLong';
  }
  return problems;
}

export interface DeclareBody {
  has_conflict: boolean;
  relation_text?: string;
  contractor_id?: string;
}

/** The body of the declaration: a declaration of no conflict carries neither the words nor the contractor. */
export function declareBody(form: DeclareForm): DeclareBody {
  if (form.hasConflict !== true) return { has_conflict: false };
  return { has_conflict: true, relation_text: form.relation.trim(), ...(form.contractorId === '' ? {} : { contractor_id: form.contractorId }) };
}

export interface DecideForm {
  decision: ConflictDecision | '';
  reason: string;
}

export const EMPTY_DECIDE: DecideForm = { decision: '', reason: '' };

export type DecideProblem = 'required' | 'short' | 'tooLong';

export function validateDecide(form: DecideForm): Partial<Record<keyof DecideForm, DecideProblem>> {
  const problems: Partial<Record<keyof DecideForm, DecideProblem>> = {};
  if (form.decision === '') problems.decision = 'required';
  const reason = form.reason.trim();
  if (reason.length < MIN_REASON) problems.reason = 'short';
  else if (reason.length > MAX_RELATION) problems.reason = 'tooLong';
  return problems;
}

export const decideBody = (form: DecideForm): { decision: ConflictDecision; decision_reason: string } => ({ decision: form.decision as ConflictDecision, decision_reason: form.reason.trim() });

// ---- refusals ----------------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'bidClosed'
  | 'openingUnset'
  | 'restricted'
  | 'notVerified'
  | 'packageState'
  | 'alreadyDeclared'
  | 'undeclared'
  | 'selfApproval'
  | 'versionConflict'
  | 'noConflict'
  | 'notPdf'
  | 'notClean'
  | 'tooLarge'
  | 'fileUsed'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'BID_CLOSED':
      return 'bidClosed';
    case 'BID_OPENING_UNSET':
      return 'openingUnset';
    case 'CONTRACTOR_RESTRICTED':
      return 'restricted';
    case 'CONTRACTOR_NOT_VERIFIED':
      return 'notVerified';
    case 'PACKAGE_STATE_INVALID':
      return 'packageState';
    case 'ALREADY_DECLARED':
      return 'alreadyDeclared';
    case 'CONFLICT_UNDECLARED':
      return 'undeclared';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'NO_CONFLICT_DECLARED':
      return 'noConflict';
    case 'UPLOAD_NOT_PDF':
    case 'FILE_TYPE_NOT_ALLOWED':
      return 'notPdf';
    case 'FILE_NOT_CLEAN':
    case 'SCAN_PENDING':
      return 'notClean';
    case 'PAYLOAD_TOO_LARGE':
      return 'tooLarge';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return error.extensions.reason === 'FILE_ALREADY_ATTACHED' ? 'fileUsed' : 'validation';
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

/** The size of a file in the unit a person reads: KB or MB with one decimal. */
export function sizeText(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A moment as Vietnam wall-clock text, `YYYY-MM-DD HH:mm`; empty for none. */
export const momentText = (moment: string | null): string => localInput(moment).replace('T', ' ');
