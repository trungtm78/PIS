import { DomainError } from './errors.ts';
import { asUuid } from './tenant-context.ts';

/**
 * The risks of a project (ST-PRJ-010, PRJ 3.1 F8, BR-PRJ-07, PRJ-16): a likelihood and an impact from 1 to 5 give a score from 1 to 25 (a generated column of the table), which falls into a band: 1 to 5 low, 6 to 14 medium, 15 and
 * more critical. A risk is OPEN, then MITIGATING, then ESCALATED; it ends CLOSED or ACCEPTED, with a reason. Pure functions of their input.
 */
export const RISK_STATUSES = ['OPEN', 'MITIGATING', 'ESCALATED', 'ACCEPTED', 'CLOSED'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];
/** The statuses a risk is written with: it ends through its own command. */
export const LIVE_STATUSES = ['OPEN', 'MITIGATING', 'ESCALATED'] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];
export const ENDING_STATUSES = ['CLOSED', 'ACCEPTED'] as const;
export type EndingStatus = (typeof ENDING_STATUSES)[number];

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const SCALE_MAX = 5;
/** From this score a risk is critical and reaches the executive warnings (BR-PRJ-07). */
export const CRITICAL_SCORE = 15;
/** Up to this score a risk is low. */
export const LOW_SCORE_MAX = 5;

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOSING_REASON_MIN = 10;
const TEXT_MAX = 2000;
const TITLE_MAX = 300;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The score of a risk: what the generated column of the table holds. */
export const riskScore = (likelihood: number, impact: number): number => likelihood * impact;

/** The band of a score: 1 to 5 low, 6 to 14 medium, 15 and more critical. */
export const riskLevelOf = (score: number): RiskLevel => (score >= CRITICAL_SCORE ? 'CRITICAL' : score > LOW_SCORE_MAX ? 'MEDIUM' : 'LOW');

/** Whether a risk with this score reaches the executive warnings. */
export const isCritical = (score: number): boolean => score >= CRITICAL_SCORE;

function text(raw: unknown, field: string, min: number, max: number): string {
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (value.length < min || value.length > max) throw invalid(field);
  return value;
}

function scale(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > SCALE_MAX) throw invalid(field);
  return raw;
}

function day(raw: unknown, field: string): string {
  const matched = typeof raw === 'string' ? DATE.exec(raw) : null;
  const [year, month, date] = matched === null ? [] : matched.slice(1, 4).map(Number);
  const parsed = matched === null ? undefined : new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1));
  if (matched === null || parsed === undefined || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== (month ?? 0) - 1 || parsed.getUTCDate() !== date) throw invalid(field);
  return matched[0];
}

export interface RiskEntry {
  code: string;
  categoryMasterVersionId: string;
  title: string;
  description: string;
  likelihood: number;
  impact: number;
  ownerMembershipId: string;
  mitigation: string;
  dueDate: string;
  linkedIssueId: string | undefined;
  status: LiveStatus;
}

/** What a risk is written with. A risk starts OPEN unless it is written already further on its way; the date it is due is a real day. */
export function assertRiskEntry(raw: {
  code?: unknown;
  category_master_version_id?: unknown;
  title?: unknown;
  description?: unknown;
  likelihood?: unknown;
  impact?: unknown;
  owner_membership_id?: unknown;
  mitigation?: unknown;
  due_date?: unknown;
  linked_issue_id?: unknown;
  status?: unknown;
}): RiskEntry {
  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  if (!CODE.test(code)) throw invalid('code');
  const category = asUuid(raw.category_master_version_id);
  if (category === undefined) throw invalid('category_master_version_id');
  const owner = asUuid(raw.owner_membership_id);
  if (owner === undefined) throw invalid('owner_membership_id');
  const linked = raw.linked_issue_id === undefined ? undefined : asUuid(raw.linked_issue_id);
  if (raw.linked_issue_id !== undefined && linked === undefined) throw invalid('linked_issue_id');
  const status = raw.status === undefined ? 'OPEN' : LIVE_STATUSES.find((candidate) => candidate === raw.status);
  if (status === undefined) throw invalid('status');
  return {
    code,
    categoryMasterVersionId: category,
    title: text(raw.title, 'title', 3, TITLE_MAX),
    description: text(raw.description, 'description', 3, TEXT_MAX),
    likelihood: scale(raw.likelihood, 'likelihood'),
    impact: scale(raw.impact, 'impact'),
    ownerMembershipId: owner,
    mitigation: text(raw.mitigation, 'mitigation', 3, TEXT_MAX),
    dueDate: day(raw.due_date, 'due_date'),
    linkedIssueId: linked,
    status,
  };
}

export interface RiskClosure {
  status: EndingStatus;
  reason: string;
}

/** The end of a risk: closed, or accepted as it is, and why (10 to 2000 characters). */
export function assertRiskClosure(raw: { status?: unknown; closed_reason?: unknown }): RiskClosure {
  const status = ENDING_STATUSES.find((candidate) => candidate === raw.status);
  if (status === undefined) throw invalid('status');
  return { status, reason: text(raw.closed_reason, 'closed_reason', CLOSING_REASON_MIN, TEXT_MAX) };
}

/** The moves of the status of a risk that is not ended: it stays where it is or goes on towards escalation, and never back (409 `RISK_STATE_INVALID` otherwise); an ended risk moves no more. */
const ORDER: Readonly<Record<RiskStatus, number>> = { OPEN: 0, MITIGATING: 1, ESCALATED: 2, ACCEPTED: 3, CLOSED: 3 };

export function assertRiskMove(from: RiskStatus, to: LiveStatus): void {
  if (from === 'ACCEPTED' || from === 'CLOSED' || ORDER[to] < ORDER[from]) throw new DomainError('RISK_STATE_INVALID', 409, 'status', { extensions: { status: from } });
}

export function assertRiskLive(status: RiskStatus): asserts status is LiveStatus {
  if (status === 'ACCEPTED' || status === 'CLOSED') throw new DomainError('RISK_STATE_INVALID', 409, 'status', { extensions: { status } });
}
