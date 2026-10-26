import { DomainError } from './errors.ts';
import { charactersOf } from './dis-lifecycle.ts';
import { asUuid } from './tenant-context.ts';
import type { RevisionStatus } from './dis-report.ts';

/** The limits of what a reviewer writes and of what a maker answers with (the schemas `DisReportDecision` and `DisReportCorrection`). */
export const DECISION_LIMITS = { reasonMax: 2000, itemMin: 3, itemMax: 2000, itemsMax: 20, evidenceMax: 20, amendmentReasonMin: 10 } as const;

/** The decisions of the state machine of a report (DIS 3, section 4); the contract also names `reject`, which the machine does not have, so it is refused as a value of `decision`. */
export const DECISIONS = ['approve', 'return', 'request_amendment'] as const;
export type ReportDecision = (typeof DECISIONS)[number];

/** The status each decision leads to. */
export const STATUS_AFTER: Readonly<Record<ReportDecision, RevisionStatus>> = { approve: 'ACCEPTED', return: 'RETURNED', request_amendment: 'AMENDMENT_REQUESTED' };

/** The statuses a reviewer decides on: a report that was handed in and waits, and for an amendment one that was accepted. */
const DECIDABLE: Readonly<Record<ReportDecision, readonly RevisionStatus[]>> = {
  approve: ['SUBMITTED', 'UNDER_REVIEW'],
  return: ['SUBMITTED', 'UNDER_REVIEW'],
  request_amendment: ['ACCEPTED'],
};

/** The statuses a correction starts from: the report was accepted and is wrong, or it was sent back, or an amendment was asked for, or it was taken back by its maker (the period is reported again from it, ST-DIS-007). */
const CORRECTABLE: readonly RevisionStatus[] = ['ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN'];

export interface RawDecision {
  decision?: unknown;
  reason?: unknown;
  evidence_ids?: unknown;
  return_items?: unknown;
  due_at?: unknown;
}

export interface DecisionInput {
  decision: ReportDecision;
  reason: string;
  evidenceIds: readonly string[];
  returnItems: readonly string[];
  dueAt: Date | null;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function wordsOf(value: unknown, max: number, field: string, min = 1): string {
  if (typeof value !== 'string') throw invalid(field);
  const text = value.trim();
  const length = charactersOf(text);
  if (length < min || length > max) throw invalid(field);
  return text;
}

function evidenceOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid('evidence_ids');
  if (value.length > DECISION_LIMITS.evidenceMax) throw invalid('evidence_ids');
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const id = asUuid(entry);
    if (id === undefined || seen.has(id)) throw invalid(`evidence_ids[${index}]`);
    seen.add(id);
    return id;
  });
}

function itemsOf(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DECISION_LIMITS.itemsMax) throw invalid('return_items');
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = wordsOf(entry, DECISION_LIMITS.itemMax, `return_items[${index}]`, DECISION_LIMITS.itemMin);
    if (seen.has(item.toLowerCase())) throw invalid(`return_items[${index}]`);
    seen.add(item.toLowerCase());
    return item;
  });
}

function dueOf(value: unknown, now: Date): Date | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) throw invalid('due_at');
  const due = new Date(value);
  if (Number.isNaN(due.getTime()) || due.getTime() <= now.getTime()) throw invalid('due_at');
  return due;
}

/**
 * What a reviewer enters, once it is read: the decision, the reason, the evidence, and for a return the list of what to fix and the day it is due (both required, the day after the decision).
 * A request for an amendment may name them too; an approval names none of them. The first fault is the answer (422 `VALIDATION_FAILED` naming the field).
 */
export function decisionOf(raw: RawDecision, now: Date): DecisionInput {
  if (typeof raw.decision !== 'string' || !(DECISIONS as readonly string[]).includes(raw.decision)) throw invalid('decision');
  const decision = raw.decision as ReportDecision;
  const reason = wordsOf(raw.reason, DECISION_LIMITS.reasonMax, 'reason');
  const evidenceIds = evidenceOf(raw.evidence_ids);
  const returnItems = itemsOf(raw.return_items);
  if (decision === 'approve') {
    if (returnItems.length > 0) throw invalid('return_items');
    if (raw.due_at !== undefined) throw invalid('due_at');
    return { decision, reason, evidenceIds, returnItems, dueAt: null };
  }
  if (decision === 'return' && returnItems.length === 0) throw invalid('return_items');
  const dueAt = dueOf(raw.due_at, now);
  if (decision === 'return' && dueAt === null) throw invalid('due_at');
  return { decision, reason, evidenceIds, returnItems, dueAt };
}

/** The status a report reaches by a decision, or 409 `REPORT_STATE_INVALID` naming the status it is in. */
export function decisionOutcome(status: RevisionStatus, decision: ReportDecision): RevisionStatus {
  if (!DECIDABLE[decision].includes(status)) throw new DomainError('REPORT_STATE_INVALID', 409, 'status', { extensions: { report_status: status } });
  return STATUS_AFTER[decision];
}

export interface RawCorrection {
  amendment_reason?: unknown;
}

/** What a maker answers a decision with: why the numbers change (422 `CORRECTION_REASON_REQUIRED` naming `amendment_reason` for none, a short one or a long one). */
export function correctionOf(raw: RawCorrection): { amendmentReason: string } {
  const reason = typeof raw.amendment_reason === 'string' ? raw.amendment_reason.trim() : '';
  const length = charactersOf(reason);
  if (length < DECISION_LIMITS.amendmentReasonMin || length > DECISION_LIMITS.reasonMax) throw new DomainError('CORRECTION_REASON_REQUIRED', 422, 'amendment_reason');
  return { amendmentReason: reason };
}

/** The refusal of a correction of a report that is not one to correct from, or undefined when it is. */
export function correctionSourceRefusal(status: RevisionStatus): DomainError | undefined {
  return CORRECTABLE.includes(status) ? undefined : new DomainError('REPORT_STATE_INVALID', 409, 'status', { extensions: { report_status: status } });
}
