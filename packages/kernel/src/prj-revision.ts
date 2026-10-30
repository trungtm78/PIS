import { DomainError } from './errors.ts';
import { isCalendarDate } from './retention.ts';
import { asUuid } from './tenant-context.ts';

/**
 * The revisions of a project (ST-PRJ-008, PRJ 3.1 F6, PRJ-06): the investor proposes a change of the investment total, the schedule, the scope or the investor unit with the reason, a different person decides it
 * with a decision document and the day it takes effect, and the figures of the project follow the revision approved last. Pure functions of their input.
 */
export const REVISION_KINDS = ['ADJUST_INVESTMENT', 'ADJUST_SCHEDULE', 'ADJUST_SCOPE', 'ADJUST_INVESTOR'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];
export const PROJECT_REVISION_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type ProjectRevisionStatus = (typeof PROJECT_REVISION_STATUSES)[number];

const MAX_MONEY_DIGITS = 24;
const MONEY = /^(0|[1-9][0-9]*)(\.0+)?$/;
const YEAR_MIN = 1990;
const YEAR_MAX = 2100;
const REASON_MIN = 10;
const SCOPE_MIN = 10;
const TEXT_MAX = 2000;
const SCOPE_MAX = 4000;
const DECISION_REASON_MIN = 5;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function text(raw: unknown, field: string, min: number, max: number): string {
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (value.length < min || value.length > max) throw invalid(field);
  return value;
}

function money(raw: unknown, field: string): string {
  const matched = typeof raw === 'string' ? MONEY.exec(raw.trim()) : null;
  const whole = matched?.[1];
  if (whole === undefined || whole.length > MAX_MONEY_DIGITS) throw invalid(field);
  return whole;
}

function year(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < YEAR_MIN || raw > YEAR_MAX) throw invalid(field);
  return raw;
}

/** What the project holds today, as far as a revision can change it. */
export interface RevisionBase {
  totalInvestmentVnd: string;
  startYear: number | null;
  endYear: number | null;
  investorUnitId: string | null;
}

export interface RevisionProposal {
  kind: RevisionKind;
  reason: string;
  /** The fields the revision changes, as they are now. */
  before: Record<string, unknown>;
  /** The same fields, as the revision would leave them. */
  after: Record<string, unknown>;
  /** The investment total in force once the revision is approved: the new one for an investment change, else the one the project has. */
  totalInvestmentVnd: string;
}

const onlyKeys = (after: Record<string, unknown>, allowed: readonly string[]): void => {
  for (const key of Object.keys(after)) if (!allowed.includes(key)) throw invalid(`after.${key}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What a revision proposes. The fields it changes are named by the kind, and each must really change something: an investment change names the new total (once, at the top of the request, and
 * in `after` when it repeats it), a schedule change names a start year, an end year or both, a scope change names a summary, an investor change names the unit. Anything else in `after` is refused.
 */
export function assertRevisionProposal(raw: { change_kind?: unknown; after?: unknown; total_investment_vnd?: unknown; reason?: unknown }, base: RevisionBase): RevisionProposal {
  const kind = REVISION_KINDS.find((candidate) => candidate === raw.change_kind);
  if (kind === undefined) throw invalid('change_kind');
  const reason = text(raw.reason, 'reason', REASON_MIN, TEXT_MAX);
  if (!isRecord(raw.after)) throw invalid('after');
  const after = raw.after;
  if (kind !== 'ADJUST_INVESTMENT' && raw.total_investment_vnd !== undefined) throw invalid('total_investment_vnd');
  switch (kind) {
    case 'ADJUST_INVESTMENT': {
      onlyKeys(after, ['total_investment_vnd']);
      const total = money(raw.total_investment_vnd, 'total_investment_vnd');
      if (after.total_investment_vnd !== undefined && money(after.total_investment_vnd, 'after.total_investment_vnd') !== total) throw invalid('after.total_investment_vnd');
      if (total === base.totalInvestmentVnd) throw invalid('total_investment_vnd');
      return { kind, reason, before: { total_investment_vnd: base.totalInvestmentVnd }, after: { total_investment_vnd: total }, totalInvestmentVnd: total };
    }
    case 'ADJUST_SCHEDULE': {
      onlyKeys(after, ['start_year', 'end_year']);
      if (after.start_year === undefined && after.end_year === undefined) throw invalid('after');
      const start = after.start_year === undefined ? base.startYear : year(after.start_year, 'after.start_year');
      const end = after.end_year === undefined ? base.endYear : year(after.end_year, 'after.end_year');
      if (start !== null && end !== null && end < start) throw invalid('after.end_year');
      const changes: Record<string, unknown> = {};
      const was: Record<string, unknown> = {};
      if (after.start_year !== undefined && start !== base.startYear) {
        changes.start_year = start;
        was.start_year = base.startYear;
      }
      if (after.end_year !== undefined && end !== base.endYear) {
        changes.end_year = end;
        was.end_year = base.endYear;
      }
      if (Object.keys(changes).length === 0) throw invalid('after');
      return { kind, reason, before: was, after: changes, totalInvestmentVnd: base.totalInvestmentVnd };
    }
    case 'ADJUST_SCOPE': {
      onlyKeys(after, ['scope_summary']);
      return { kind, reason, before: {}, after: { scope_summary: text(after.scope_summary, 'after.scope_summary', SCOPE_MIN, SCOPE_MAX) }, totalInvestmentVnd: base.totalInvestmentVnd };
    }
    case 'ADJUST_INVESTOR': {
      onlyKeys(after, ['investor_unit_id']);
      const unit = asUuid(after.investor_unit_id);
      if (unit === undefined) throw invalid('after.investor_unit_id');
      if (unit === base.investorUnitId) throw invalid('after.investor_unit_id');
      return { kind, reason, before: { investor_unit_id: base.investorUnitId }, after: { investor_unit_id: unit }, totalInvestmentVnd: base.totalInvestmentVnd };
    }
  }
}

export interface RevisionDecision {
  decision: 'approve' | 'reject';
  reason: string;
  decisionDocumentId: string | undefined;
  effectiveFrom: string | undefined;
}

/**
 * The decision on a revision. Approving needs the decision document (422 `DECISION_REQUIRED`) and the day the decision takes effect, which is a real day that has come; rejecting needs neither a day nor
 * (but may carry) a document.
 */
export function assertRevisionDecision(raw: { decision?: unknown; reason?: unknown; decision_document_id?: unknown; effective_from?: unknown }, today: string): RevisionDecision {
  const decision = raw.decision === 'approve' || raw.decision === 'reject' ? raw.decision : undefined;
  if (decision === undefined) throw invalid('decision');
  const reason = text(raw.reason, 'reason', DECISION_REASON_MIN, TEXT_MAX);
  const documentId = raw.decision_document_id === undefined ? undefined : asUuid(raw.decision_document_id);
  if (raw.decision_document_id !== undefined && documentId === undefined) throw invalid('decision_document_id');
  if (decision === 'reject') {
    if (raw.effective_from !== undefined) throw invalid('effective_from');
    return { decision, reason, decisionDocumentId: documentId, effectiveFrom: undefined };
  }
  if (documentId === undefined) throw new DomainError('DECISION_REQUIRED', 422, 'decision_document_id');
  if (typeof raw.effective_from !== 'string' || !isCalendarDate(raw.effective_from) || raw.effective_from > today) throw invalid('effective_from');
  return { decision, reason, decisionDocumentId: documentId, effectiveFrom: raw.effective_from };
}
