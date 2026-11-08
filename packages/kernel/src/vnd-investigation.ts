import { DomainError } from './errors.ts';

/**
 * The lead of an investigation (VND-3, research V6): a ranked signal about contractors that the auditors look at. Where a red flag (GOV-10) is about a package or a contract, a lead is about contractors: a cluster of
 * linked parties, rotating winners, a cover bid, a price pattern, the same file author, the same origin of submission, a bidder that withdraws for the same winner, a new company of a banned party. A lead is a signal for
 * review, never a conclusion: it moves through the review of the auditors (take, propose a dismissal with a reason, a different auditor confirms; or confirm the signal as right, which measures the false alarms; or refer to an
 * investigation), is hidden from the people who took part in the packages it is about, and is never shown to a contractor.
 */

export const LEAD_KINDS = ['LINK_CLUSTER', 'RESTRICTED_AFFILIATE', 'ROTATING_WINNERS', 'COVER_BID', 'PRICE_PATTERN', 'FILE_METADATA', 'SHARED_ORIGIN', 'WITHDRAWAL_FOR_WINNER'] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];

export const LEAD_STATUSES = ['NEW', 'IN_REVIEW', 'DISMISS_PROPOSED', 'DISMISSED', 'CONFIRMED', 'REFERRED'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_MOVES = ['TAKE', 'PROPOSE_DISMISS', 'CONFIRM_DISMISS', 'REJECT_DISMISS', 'CONFIRM_SIGNAL', 'REFER'] as const;
export type LeadMove = (typeof LEAD_MOVES)[number];

const STEPS: Readonly<Record<LeadMove, { from: readonly LeadStatus[]; to: LeadStatus; reason: boolean }>> = {
  TAKE: { from: ['NEW'], to: 'IN_REVIEW', reason: false },
  PROPOSE_DISMISS: { from: ['IN_REVIEW'], to: 'DISMISS_PROPOSED', reason: true },
  CONFIRM_DISMISS: { from: ['DISMISS_PROPOSED'], to: 'DISMISSED', reason: false },
  REJECT_DISMISS: { from: ['DISMISS_PROPOSED'], to: 'IN_REVIEW', reason: true },
  CONFIRM_SIGNAL: { from: ['IN_REVIEW'], to: 'CONFIRMED', reason: true },
  REFER: { from: ['IN_REVIEW', 'CONFIRMED'], to: 'REFERRED', reason: true },
};

/** The statuses in which a lead is open work for the auditors (a confirmed signal waits for a referral or stays as a record). */
export const LEAD_OPEN_STATUSES: readonly LeadStatus[] = ['NEW', 'IN_REVIEW', 'DISMISS_PROPOSED'];

/**
 * The status after a move. A dismissal takes two auditors: the one who proposes it with a reason and a different one who confirms it (403 SELF_APPROVAL_DENIED). A move that does not start from the status of the lead is
 * 409 LEAD_STATE_INVALID; a move that carries a decision needs its reason of at least 5 characters (422 VALIDATION_FAILED on `reason`).
 */
export function nextLeadStatus(current: LeadStatus, move: LeadMove, input: { actor: string; proposer: string | null; reason?: string | null }): LeadStatus {
  const step = STEPS[move];
  if (!step.from.includes(current)) throw new DomainError('LEAD_STATE_INVALID', 409, 'status');
  if (step.reason && (input.reason === undefined || input.reason === null || input.reason.trim().length < 5)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  if (move === 'CONFIRM_DISMISS' && input.proposer !== null && input.actor === input.proposer) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  return step.to;
}

/** Whether a new scan reopens a dismissed lead: its rank rose by at least `rise` points, or a kind of evidence it did not have before appeared. A confirmed or referred lead is a record and never reopens. */
export function reopensDismissed(previous: { rank: number; evidenceKinds: readonly string[] }, next: { rank: number; evidenceKinds: readonly string[] }, rise: number): boolean {
  return next.rank >= previous.rank + rise || next.evidenceKinds.some((kind) => !previous.evidenceKinds.includes(kind));
}

/** The rate of leads that auditors confirmed as right over those they decided (confirmed, referred, dismissed): the measure of false alarms (KPI 9 of the research). None while nothing was decided. */
export function leadPrecision(counts: { confirmed: number; referred: number; dismissed: number }): number | null {
  const right = counts.confirmed + counts.referred;
  const decided = right + counts.dismissed;
  return decided === 0 ? null : Math.round((right * 1000) / decided) / 10;
}

export interface InvestigationPolicy {
  /** Points of rank by which a dismissed lead is reopened by a new scan. */
  reopen_rise: number;
  /** Days of the window of bids that a scan reads (packages closed in the last N days). */
  window_days: number;
  /** The rank from which a new lead raises an alert for the auditors. */
  alert_from: number;
}

export const INVESTIGATION_POLICY_DEFAULTS: InvestigationPolicy = { reopen_rise: 15, window_days: 1095, alert_from: 70 };

export function investigationPolicyOf(params: unknown): InvestigationPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw bad('params');
  const read = (field: string, min: number, max: number): number => {
    const value = (params as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  return { reopen_rise: read('reopen_rise', 1, 100), window_days: read('window_days', 30, 3650), alert_from: read('alert_from', 1, 100) };
}

/** The red flag side of the people who must not see a lead: the reader took part in a package it is about. */
export const isInvolvedInLead = (membershipId: string, involved: ReadonlySet<string>): boolean => involved.has(membershipId.toLowerCase());
