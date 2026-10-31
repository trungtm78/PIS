import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'project.read';
export const PROPOSE_PERMISSION = 'project.revision.propose';
export const APPROVE_PERMISSION = 'project.revision.approve';

export const KINDS = ['ADJUST_INVESTMENT', 'ADJUST_SCHEDULE', 'ADJUST_SCOPE', 'ADJUST_INVESTOR'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type Status = (typeof STATUSES)[number];
/** The stages in which a project takes a revision: the same list as the server's. */
export const REVISABLE_STAGES: readonly string[] = ['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED'];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface DocumentView {
  id: string;
  title: string;
  number: number | null;
  numberYear: number | null;
  symbol: string | null;
  issuedOn: string | null;
}

export interface Person {
  membershipId: string;
  displayName: string | null;
}

export interface RevisionView {
  id: string;
  revision: number;
  kind: Kind | 'INITIAL';
  status: Status;
  before: Raw;
  after: Raw;
  totalInvestmentVnd: string | null;
  reason: string;
  decisionReason: string | null;
  document: DocumentView | null;
  effectiveFrom: string | null;
  createdBy: Person;
  decidedBy: Person | null;
  version: number;
}

export interface RevisionRegister {
  items: RevisionView[];
  currentTotalVnd: string;
}

function toPerson(raw: unknown): Person | undefined {
  const row = asRecord(raw);
  const id = text(row?.membership_id);
  return row === undefined || id === undefined ? undefined : { membershipId: id, displayName: nullableText(row.display_name) };
}

function toDocument(raw: unknown): DocumentView | null {
  const row = asRecord(raw);
  const id = text(row?.id);
  if (row === undefined || id === undefined) return null;
  const whole = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);
  return { id, title: text(row.title) ?? '', number: whole(row.number), numberYear: whole(row.number_year), symbol: nullableText(row.symbol), issuedOn: nullableText(row.issued_on) };
}

function toRevision(raw: unknown): RevisionView | undefined {
  const row = asRecord(raw);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const kind = row?.change_kind === 'INITIAL' ? 'INITIAL' : KINDS.find((candidate) => candidate === row?.change_kind);
  const id = text(row?.id);
  const created = toPerson(row?.created_by);
  if (row === undefined || status === undefined || kind === undefined || id === undefined || created === undefined || typeof row.revision !== 'number' || typeof row.version !== 'number') return undefined;
  return {
    id,
    revision: row.revision,
    kind,
    status,
    before: asRecord(row.before) ?? {},
    after: asRecord(row.after) ?? {},
    totalInvestmentVnd: nullableText(row.total_investment_vnd),
    reason: text(row.reason) ?? '',
    decisionReason: nullableText(row.decision_reason),
    document: toDocument(row.decision_document),
    effectiveFrom: nullableText(row.effective_from),
    createdBy: created,
    decidedBy: toPerson(row.decided_by) ?? null,
    version: row.version,
  };
}

export function toRevisionRegister(raw: unknown): RevisionRegister {
  const page = asRecord(raw);
  return { items: (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toRevision(item) ?? []), currentTotalVnd: text(page?.current_total_investment_vnd) ?? '0' };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** The revision that waits for a decision, if any. */
export const pendingOf = (items: readonly RevisionView[]): RevisionView | undefined => items.find((item) => item.status === 'IN_REVIEW');

/** A revision waits for a decision of someone other than the one who proposed it. */
export const canDecide = (revision: Pick<RevisionView, 'status' | 'createdBy'>, membershipId: string | undefined): boolean => revision.status === 'IN_REVIEW' && (membershipId === undefined || revision.createdBy.membershipId !== membershipId);

/** The revisions that ground the project on paper: the decided ones with a document, for the legal dossier (PRJ-04). */
export const dossierOf = (items: readonly RevisionView[]): RevisionView[] => items.filter((item) => item.document !== null && (item.status === 'APPROVED' || item.status === 'SUPERSEDED'));

/** The fields a revision moves, as pairs of the old and the new content, in a fixed order. */
export interface Change {
  field: string;
  before: unknown;
  after: unknown;
}

const FIELD_ORDER = ['total_investment_vnd', 'start_year', 'end_year', 'investor_unit_id', 'scope_summary'] as const;

export function changesOf(revision: Pick<RevisionView, 'before' | 'after'>): Change[] {
  const fields = [...new Set([...Object.keys(revision.after), ...Object.keys(revision.before)])];
  const rank = (field: string): number => {
    const found = (FIELD_ORDER as readonly string[]).indexOf(field);
    return found < 0 ? FIELD_ORDER.length : found;
  };
  return fields.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right)).map((field) => ({ field, before: revision.before[field] ?? null, after: revision.after[field] ?? null }));
}

// ---- the forms ---------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid' | 'same' | 'past';
export type ProposalField = 'total' | 'startYear' | 'endYear' | 'scope' | 'investorUnit' | 'reason';

export interface ProposalForm {
  kind: Kind;
  total: string;
  startYear: string;
  endYear: string;
  scope: string;
  investorUnit: string;
  reason: string;
}

export const EMPTY_PROPOSAL: ProposalForm = { kind: 'ADJUST_INVESTMENT', total: '', startYear: '', endYear: '', scope: '', investorUnit: '', reason: '' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^(0|[1-9][0-9]*)$/;
const YEAR = /^\d{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function isDay(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return DATE.test(date) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** The day of the form in Vietnam (UTC+7), as `YYYY-MM-DD`. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export interface CurrentFigures {
  totalVnd: string;
}

export function validateProposal(form: ProposalForm, current: CurrentFigures): Partial<Record<ProposalField, FormProblem>> {
  const found: Partial<Record<ProposalField, FormProblem>> = {};
  const reason = form.reason.trim();
  if (reason === '') found.reason = 'required';
  else if (reason.length < 10 || reason.length > 2000) found.reason = 'invalid';
  switch (form.kind) {
    case 'ADJUST_INVESTMENT': {
      const total = form.total.trim();
      if (total === '') found.total = 'required';
      else if (!MONEY.test(total) || total.length > 24) found.total = 'invalid';
      else if (total === current.totalVnd.split('.')[0]) found.total = 'same';
      break;
    }
    case 'ADJUST_SCHEDULE': {
      const start = form.startYear.trim();
      const end = form.endYear.trim();
      if (start === '' && end === '') found.startYear = 'required';
      if (start !== '' && (!YEAR.test(start) || Number(start) < 1990 || Number(start) > 2100)) found.startYear = 'invalid';
      if (end !== '' && (!YEAR.test(end) || Number(end) < 1990 || Number(end) > 2100)) found.endYear = 'invalid';
      if (found.startYear === undefined && found.endYear === undefined && start !== '' && end !== '' && Number(end) < Number(start)) found.endYear = 'invalid';
      break;
    }
    case 'ADJUST_SCOPE': {
      const scope = form.scope.trim();
      if (scope === '') found.scope = 'required';
      else if (scope.length < 10 || scope.length > 4000) found.scope = 'invalid';
      break;
    }
    case 'ADJUST_INVESTOR': {
      const unit = form.investorUnit.trim();
      if (unit === '') found.investorUnit = 'required';
      else if (!UUID.test(unit)) found.investorUnit = 'invalid';
      break;
    }
  }
  return found;
}

export function proposalBody(form: ProposalForm): Record<string, unknown> {
  const reason = form.reason.trim();
  switch (form.kind) {
    case 'ADJUST_INVESTMENT':
      return { change_kind: form.kind, after: {}, total_investment_vnd: form.total.trim(), reason };
    case 'ADJUST_SCHEDULE':
      return { change_kind: form.kind, after: { ...(form.startYear.trim() === '' ? {} : { start_year: Number(form.startYear) }), ...(form.endYear.trim() === '' ? {} : { end_year: Number(form.endYear) }) }, reason };
    case 'ADJUST_SCOPE':
      return { change_kind: form.kind, after: { scope_summary: form.scope.trim() }, reason };
    case 'ADJUST_INVESTOR':
      return { change_kind: form.kind, after: { investor_unit_id: form.investorUnit.trim() }, reason };
  }
}

export const DECISIONS = ['approve', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];
export type DecisionField = 'reason' | 'documentId' | 'effectiveFrom';

export interface DecisionForm {
  decision: Decision;
  reason: string;
  documentId: string;
  effectiveFrom: string;
}

export const EMPTY_DECISION: DecisionForm = { decision: 'approve', reason: '', documentId: '', effectiveFrom: '' };

export function validateDecision(form: DecisionForm, today: string): Partial<Record<DecisionField, FormProblem>> {
  const found: Partial<Record<DecisionField, FormProblem>> = {};
  const reason = form.reason.trim();
  if (reason === '') found.reason = 'required';
  else if (reason.length < 5 || reason.length > 2000) found.reason = 'invalid';
  const document = form.documentId.trim();
  if (document !== '' && !UUID.test(document)) found.documentId = 'invalid';
  if (form.decision === 'approve') {
    if (document === '') found.documentId = 'required';
    if (form.effectiveFrom === '') found.effectiveFrom = 'required';
    else if (!isDay(form.effectiveFrom)) found.effectiveFrom = 'invalid';
    else if (form.effectiveFrom > today) found.effectiveFrom = 'past';
  }
  return found;
}

export function decisionBody(form: DecisionForm): Record<string, unknown> {
  const document = form.documentId.trim();
  return {
    decision: form.decision,
    reason: form.reason.trim(),
    ...(document === '' ? {} : { decision_document_id: document }),
    ...(form.decision === 'approve' ? { effective_from: form.effectiveFrom } : {}),
  };
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type RevisionProblem = 'pendingExists' | 'selfApproval' | 'versionConflict' | 'stageDenied' | 'scopeDenied' | 'documentRequired' | 'validation' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, RevisionProblem>> = {
  REVISION_PENDING_EXISTS: 'pendingExists',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  SCOPE_DENIED: 'scopeDenied',
  DECISION_REQUIRED: 'documentRequired',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeRevision = (error: unknown): RevisionProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
