import { ApiError } from '@machvon/api-client';
import { FINDING_STATUSES } from '../analysis/model';
import type { FindingStatus } from '../analysis/model';
import { CELL_RISKS } from '../compare/model';
import type { CellRisk, Comparison } from '../compare/model';
import { REVIEW_DECISIONS } from '../review/model';
import type { ReviewDecision } from '../review/model';

/** The one permission of BID-13 (x-permission of the four operations in openapi.json): a member of the evaluation team over the project. The server judges every command and every read again. */
export const REPORT_PERMISSION = 'bid.evaluate';

export const REPORT_STATUSES = ['DRAFT', 'SIGNED_OFF', 'ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const NOT_COVERED_REASONS = ['NOT_SELECTED', 'NO_ANALYSIS_RUN', 'CRITERIA_VERSION_MISMATCH'] as const;
export type NotCoveredReason = (typeof NOT_COVERED_REASONS)[number];
export const AWAITING_STANDINGS = ['UNDECLARED', 'CLEAR', 'ALLOWED', 'PENDING'] as const;
export type AwaitingStanding = (typeof AWAITING_STANDINGS)[number];

/** The words of the conclusion and of a dissent fit the minutes; the server holds the same limits. */
export const MIN_CONCLUSION = 20;
export const MAX_CONCLUSION = 8000;
export const MIN_DISSENT = 20;
export const MAX_DISSENT = 4000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const nullableNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined => options.find((candidate) => candidate === value);
const list = <T>(value: unknown, read: (item: unknown) => T | undefined): T[] => (Array.isArray(value) ? value.flatMap((item) => read(item) ?? []) : []);

export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/** Whether the caller is offered the forms: the right to evaluate is held and the session is not read-only. */
export const canAct = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && holds(permissions, REPORT_PERMISSION);

export interface Person {
  membershipId: string;
  displayName: string;
}

export interface ReportProposal {
  proposalId: string;
  contractor: { id: string; name: string };
  runId: string;
  criteriaCount: number;
  decidedCount: number;
  mandatoryNotMet: number;
  weightedScore: string | null;
}

export interface ReportCriterion {
  code: string;
  name: string;
  maxScore: number | null;
  mandatory: boolean;
}

export interface ReportCell {
  proposalId: string;
  decided: { status: FindingStatus; score: string | null; decision: ReviewDecision; decidedAt: string } | null;
  risk: CellRisk;
}

export interface ReportRow {
  criterion: ReportCriterion;
  cells: ReportCell[];
}

export interface NotCovered {
  proposalId: string;
  contractorName: string;
  reason: NotCoveredReason;
}

/** What the report froze: what the experts decided, cell by cell; nothing here ranks the proposals or names one. */
export interface ReportSummary {
  conclusion: string;
  criteriaVersionId: string;
  proposals: ReportProposal[];
  rows: ReportRow[];
  notCovered: NotCovered[];
  excludedAttributes: string[];
}

export interface Signature extends Person {
  signedAt: string | null;
  withDissent: boolean;
}

export interface Awaited extends Person {
  standing: AwaitingStanding;
}

export interface Dissent extends Person {
  text: string;
  recordedAt: string;
}

export interface Report {
  id: string;
  package: { id: string; code: string };
  status: ReportStatus;
  summary: ReportSummary;
  signedOffBy: Signature[];
  awaiting: Awaited[];
  dissentingOpinions: Dissent[];
  payloadSha256: string | null;
  reportDocumentId: string | null;
  /** The state of the document DOC drafted for the minutes, as DOC keeps it. */
  documentStatus: string | null;
  stale: boolean;
  /** The server says the caller may sign it now; the screen adds the session and the permission. */
  canSign: boolean;
  createdBy: Person;
  createdAt: string;
  issueRequestedAt: string | null;
  issuedAt: string | null;
  recalledAt: string | null;
  version: number;
}

function toPerson(raw: unknown): Person | undefined {
  const row = asRecord(raw);
  const membershipId = text(row?.membership_id);
  return row === undefined || membershipId === undefined ? undefined : { membershipId, displayName: text(row.display_name) ?? '' };
}

function toProposal(raw: unknown): ReportProposal | undefined {
  const row = asRecord(raw);
  const contractor = asRecord(row?.contractor);
  const proposalId = text(row?.proposal_id);
  const contractorId = text(contractor?.id);
  const runId = text(row?.run_id);
  const criteriaCount = whole(row?.criteria_count);
  const decidedCount = whole(row?.decided_count);
  const mandatoryNotMet = whole(row?.mandatory_not_met);
  if (row === undefined || proposalId === undefined || contractorId === undefined || runId === undefined || criteriaCount === undefined || decidedCount === undefined || mandatoryNotMet === undefined) return undefined;
  return { proposalId, contractor: { id: contractorId, name: text(contractor?.legal_name) ?? '' }, runId, criteriaCount, decidedCount, mandatoryNotMet, weightedScore: nullableText(row.weighted_score) };
}

function toCell(raw: unknown): ReportCell | undefined {
  const row = asRecord(raw);
  const decided = asRecord(row?.decided);
  const proposalId = text(row?.proposal_id);
  const risk = oneOf(CELL_RISKS, row?.risk);
  if (row === undefined || proposalId === undefined || risk === undefined) return undefined;
  const status = oneOf(FINDING_STATUSES, decided?.status);
  const decision = oneOf(REVIEW_DECISIONS, decided?.decision);
  const decidedAt = text(decided?.decided_at);
  return { proposalId, risk, decided: status === undefined || decision === undefined || decidedAt === undefined ? null : { status, score: nullableText(decided?.score), decision, decidedAt } };
}

function toRow(raw: unknown): ReportRow | undefined {
  const row = asRecord(raw);
  const criterion = asRecord(row?.criterion);
  const code = text(criterion?.code);
  if (row === undefined || code === undefined) return undefined;
  return { criterion: { code, name: text(criterion?.name) ?? '', maxScore: nullableNumber(criterion?.max_score), mandatory: criterion?.mandatory === true }, cells: list(row.cells, toCell) };
}

function toNotCovered(raw: unknown): NotCovered | undefined {
  const row = asRecord(raw);
  const proposalId = text(row?.proposal_id);
  const reason = oneOf(NOT_COVERED_REASONS, row?.reason);
  return row === undefined || proposalId === undefined || reason === undefined ? undefined : { proposalId, contractorName: text(asRecord(row.contractor)?.legal_name) ?? '', reason };
}

function toSummary(raw: unknown): ReportSummary | undefined {
  const row = asRecord(raw);
  const conclusion = text(row?.conclusion);
  const criteriaVersionId = text(row?.criteria_version_id);
  if (row === undefined || conclusion === undefined || criteriaVersionId === undefined) return undefined;
  return {
    conclusion,
    criteriaVersionId,
    proposals: list(row.proposals, toProposal),
    rows: list(row.rows, toRow),
    notCovered: list(row.not_covered, toNotCovered),
    excludedAttributes: list(row.excluded_attributes, text),
  };
}

export function toReport(raw: unknown): Report | undefined {
  const row = asRecord(raw);
  const pack = asRecord(row?.package);
  const id = text(row?.id);
  const packageId = text(pack?.id);
  const status = oneOf(REPORT_STATUSES, row?.status);
  const summary = toSummary(row?.summary);
  const creator = toPerson(row?.created_by);
  const createdAt = text(row?.created_at);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || packageId === undefined || status === undefined || summary === undefined || creator === undefined || createdAt === undefined || version === undefined) return undefined;
  return {
    id,
    package: { id: packageId, code: text(pack?.code) ?? '' },
    status,
    summary,
    signedOffBy: list(row.signed_off_by, (item) => {
      const person = toPerson(item);
      return person === undefined ? undefined : { ...person, signedAt: nullableText(asRecord(item)?.signed_at), withDissent: asRecord(item)?.dissent === true };
    }),
    awaiting: list(row.awaiting, (item) => {
      const person = toPerson(item);
      const standing = oneOf(AWAITING_STANDINGS, asRecord(item)?.standing);
      return person === undefined || standing === undefined ? undefined : { ...person, standing };
    }),
    dissentingOpinions: list(row.dissenting_opinions, (item) => {
      const person = toPerson(item);
      const opinion = text(asRecord(item)?.text);
      const recordedAt = text(asRecord(item)?.recorded_at);
      return person === undefined || opinion === undefined || recordedAt === undefined ? undefined : { ...person, text: opinion, recordedAt };
    }),
    payloadSha256: nullableText(row.payload_sha256),
    reportDocumentId: nullableText(row.report_document_id),
    documentStatus: nullableText(row.document_status),
    stale: row.stale === true,
    canSign: asRecord(row.actions)?.sign_off === true,
    createdBy: creator,
    createdAt,
    issueRequestedAt: nullableText(row.issue_requested_at),
    issuedAt: nullableText(row.issued_at),
    recalledAt: nullableText(row.recalled_at),
    version,
  };
}

export function toReportList(raw: unknown): Report[] {
  return list(asRecord(raw)?.items, toReport);
}

/** Whether the caller is offered the signature of a report: the draft waits for them, nothing changed since, the session is not read-only and the right is held. */
export function maySign(report: Report, permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean {
  return canAct(permissions, mode) && report.canSign && report.status === 'DRAFT' && !report.stale;
}

/** Where the minutes stand: waiting for the signatures, with DOC, issued, replaced by later minutes. The words of DOC's own state are shown beside it as DOC says them. */
export type Stage = 'signing' | 'doc' | 'issued' | 'superseded' | 'refused';

export function stageOf(report: Report): Stage {
  switch (report.status) {
    case 'DRAFT':
      return 'signing';
    case 'SIGNED_OFF':
      return 'refused';
    case 'ISSUE_REQUESTED':
      return 'doc';
    case 'ISSUED':
      return 'issued';
    case 'SUPERSEDED':
      return 'superseded';
  }
}

// ---- making the report ---------------------------------------------------------------------------------------------------------------------

/** A proposal the report can cover: the analysis that stands for it and how far the experts have decided its findings. */
export interface Candidate {
  proposalId: string;
  contractorName: string;
  runId: string;
  decidedCount: number;
  criteriaCount: number;
}

/** The proposals of the comparison, in the order the server gives them (the names of the contractors); the ones left out of the comparison are not candidates. */
export function candidatesOf(comparison: Comparison | undefined): Candidate[] {
  return (comparison?.proposals ?? []).map((proposal) => ({ proposalId: proposal.proposalId, contractorName: proposal.contractor.name, runId: proposal.runId, decidedCount: proposal.decidedCount, criteriaCount: proposal.criteriaCount }));
}

/** The runs asked for when nothing was chosen: all of them, since a report that leaves a proposal out says so and the person means to leave it out only on purpose. */
export const withoutRun = (chosen: readonly string[], runId: string): string[] => chosen.filter((id) => id !== runId);
export const withRun = (chosen: readonly string[], runId: string): string[] => (chosen.includes(runId) ? [...chosen] : [...chosen, runId]);

export interface CreateForm {
  /** The runs the person took out of the report; every other candidate is in. */
  taken: readonly string[];
  conclusion: string;
}

export const emptyCreate = (): CreateForm => ({ taken: [], conclusion: '' });

export type FormProblem = 'required' | 'tooShort' | 'tooLong' | 'noRun';

export function validateCreate(form: CreateForm, candidates: readonly Candidate[]): Partial<Record<'conclusion' | 'runs', FormProblem>> {
  const problems: Partial<Record<'conclusion' | 'runs', FormProblem>> = {};
  const length = form.conclusion.trim().length;
  if (length === 0) problems.conclusion = 'required';
  else if (length < MIN_CONCLUSION) problems.conclusion = 'tooShort';
  else if (length > MAX_CONCLUSION) problems.conclusion = 'tooLong';
  if (candidates.every((candidate) => form.taken.includes(candidate.runId))) problems.runs = 'noRun';
  return problems;
}

export interface CreateBody {
  package_id: string;
  criteria_version_id: string;
  run_ids: string[];
  summary: { conclusion: string };
}

export function createBody(packageId: string, criteriaVersionId: string, form: CreateForm, candidates: readonly Candidate[]): CreateBody {
  return {
    package_id: packageId,
    criteria_version_id: criteriaVersionId,
    run_ids: candidates.filter((candidate) => !form.taken.includes(candidate.runId)).map((candidate) => candidate.runId),
    summary: { conclusion: form.conclusion.trim() },
  };
}

// ---- signing ---------------------------------------------------------------------------------------------------------------------------------

/** What is typed for each report, by its id: the dissent the member signs with, when they have one. */
export type DissentDrafts = Readonly<Record<string, string>>;

export const withDissentDraft = (drafts: DissentDrafts, id: string, dissent: string): DissentDrafts => ({ ...drafts, [id]: dissent });
export const withoutDissentDraft = (drafts: DissentDrafts, id: string): DissentDrafts => Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== id));

/** No dissent is fine; a dissent that is typed has the length the minutes hold. */
export function validateDissent(dissent: string): FormProblem | undefined {
  const length = dissent.trim().length;
  if (length === 0) return undefined;
  if (length < MIN_DISSENT) return 'tooShort';
  return length > MAX_DISSENT ? 'tooLong' : undefined;
}

export interface SignBody {
  dissent?: string;
}

export const signBody = (dissent: string): SignBody => (dissent.trim() === '' ? {} : { dissent: dissent.trim() });

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'unreviewed'
  | 'criteriaMismatch'
  | 'runNotCompleted'
  | 'undeclared'
  | 'alreadySigned'
  | 'notDraft'
  | 'outOfDate'
  | 'versionConflict'
  | 'templateMissing'
  | 'docUnavailable'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'UNREVIEWED_FINDINGS':
      return 'unreviewed';
    case 'CRITERIA_VERSION_MISMATCH':
      return 'criteriaMismatch';
    case 'RUN_NOT_COMPLETED':
      return 'runNotCompleted';
    case 'CONFLICT_UNDECLARED':
      return 'undeclared';
    case 'ALREADY_SIGNED_OFF':
      return 'alreadySigned';
    case 'REPORT_STATE_INVALID':
      return 'notDraft';
    case 'REPORT_OUT_OF_DATE':
      return 'outOfDate';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'DOC_TEMPLATE_MISSING':
      return 'templateMissing';
    case 'PROVIDER_UNAVAILABLE':
      return 'docUnavailable';
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

/** How many findings nobody decided, when the server refused the report for them. */
export function unreviewedCount(error: unknown): number {
  const count = error instanceof ApiError ? error.extensions.unreviewed_count : undefined;
  return typeof count === 'number' ? count : 0;
}

/** A read that is refused for the declaration of conflicts of interest is not an error of the screen: the member is told to declare first. */
export function readFailure(error: unknown): 'undeclared' | undefined {
  return error instanceof ApiError && error.code === 'CONFLICT_UNDECLARED' ? 'undeclared' : undefined;
}

/** The address of the declaration of conflicts of interest of the package, where a member who owes it makes it. */
export const declarationPath = (packageId: string): string => `/bid/bid-05?package=${encodeURIComponent(packageId)}`;
/** The address of the review of the findings of a run (BID-12), where the findings the report waits for are decided. */
export const reviewRunPath = (runId: string): string => `/bid/bid-12?run=${encodeURIComponent(runId)}`;
/** The address of the comparison of the proposals of the package (BID-10). */
export const comparePath = (packageId: string): string => `/bid/bid-10?package=${encodeURIComponent(packageId)}`;
