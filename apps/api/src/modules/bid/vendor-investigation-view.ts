import { vietnamDateOf } from '@machvon/kernel';
import type { HitEventRow, HitRow, LeadHistoryRow, LeadRow, PartyLinkRow, ScreeningRunRow, ScreeningSourceState } from '@machvon/db';
import type { Policy } from '@machvon/db';

export type Names = ReadonlyMap<string, string>;
const nameOf = (names: Names, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

export const todayOf = (now: Date): string => vietnamDateOf(now);

/** The rule a figure rests on, with its version, its provenance and whether it is still unconfirmed (schema VendorInvPolicyInfo). */
export const invPolicyDto = <T>(code: string, policy: Policy<T>): Record<string, unknown> => ({
  code,
  version: policy.version,
  unverified: policy.unverified,
  formula: policy.formula,
  source: policy.source,
  as_of: policy.asOf,
  params: policy.value as Record<string, unknown>,
});

/** A lead as a line of the list. A lead is a signal for review: `is_conclusion` is always false. */
export const leadLineDto = (row: LeadRow, names: Names, contractorNames: Names, packageCodes: Names): Record<string, unknown> => ({
  id: row.id,
  kind: row.kind,
  rank: row.rank,
  status: row.status,
  contractor_ids: row.contractorIds,
  contractor_names: row.contractorIds.map((id) => contractorNames.get(id) ?? id),
  package_ids: row.packageIds,
  package_codes: row.packageIds.map((id) => packageCodes.get(id) ?? id),
  evidence_kinds: row.evidenceKinds,
  first_flagged_at: row.firstFlaggedAt,
  last_evaluated_at: row.lastEvaluatedAt,
  evaluation_count: row.evaluationCount,
  reviewer_name: nameOf(names, row.reviewerId),
  reopened_count: row.reopenedCount,
  version: row.version,
  is_conclusion: false,
});

/** The signals of a lead: the numbers the signal rests on, taken from the evidence the scan stored (a link lead has none of its own). */
export function leadSignals(row: LeadRow): Array<Record<string, unknown>> {
  const signal = row.evidence.signal as { code?: string; score?: number; evidence?: Record<string, unknown> } | undefined;
  if (signal !== undefined && typeof signal.code === 'string') return [{ code: signal.code, score: signal.score ?? row.rank, package_ids: row.packageIds, contractor_ids: row.contractorIds, evidence: signal.evidence ?? {} }];
  return [{ code: row.kind, score: row.rank, package_ids: row.packageIds, contractor_ids: row.contractorIds, evidence: { ...row.evidence } }];
}

export const linkDto = (row: PartyLinkRow): Record<string, unknown> => ({
  a_id: row.aId,
  b_id: row.bId,
  strength: row.strength,
  status: row.status,
  evidence: row.evidence.map((entry) => ({ kind: entry.kind, fingerprint: entry.fingerprint, weight: entry.weight })),
});

export const leadEventDto = (row: LeadHistoryRow, names: Names): Record<string, unknown> => ({
  id: row.id,
  move: row.move,
  from_status: row.fromStatus,
  to_status: row.toStatus,
  actor_name: nameOf(names, row.actorId),
  reason: row.reason,
  rank: row.rank,
  at: row.at,
});

export function hitDto(row: HitRow, names: Names, now: Date, decideWithinDays: number): Record<string, unknown> {
  const today = todayOf(now);
  const inForce = (row.entryValidFrom === null || row.entryValidFrom <= today) && (row.entryValidUntil === null || row.entryValidUntil >= today);
  const due = Date.parse(row.firstSeenAt) + decideWithinDays * 86_400_000;
  const decided = row.decidedAt !== null && (row.status === 'CONFIRMED' || row.status === 'DISMISSED');
  return {
    id: row.id,
    contractor_id: row.contractorId,
    contractor_name: row.contractorName,
    contractor_tax_identifier: row.contractorTaxIdentifier,
    source: row.source,
    entry_ref: row.entryRef,
    entry_name: row.entryName,
    entry_tax_code: row.entryTaxCode,
    entry_valid_from: row.entryValidFrom,
    entry_valid_until: row.entryValidUntil,
    in_force: inForce,
    score: row.score,
    basis: row.basis,
    similarity: row.similarity,
    hold: row.hold && (row.status === 'PENDING' || row.status === 'CONFIRMED'),
    status: row.status,
    first_seen_at: row.firstSeenAt,
    last_seen_at: row.lastSeenAt,
    decided_by_name: nameOf(names, row.decidedBy),
    decided_at: row.decidedAt,
    decision_reason: row.decisionReason,
    case_id: row.caseId,
    egp_record_id: row.egpRecordId,
    reopened_count: row.reopenedCount,
    clock: decided ? 'DECIDED' : row.status === 'PENDING' && now.getTime() > due ? 'OVERDUE' : 'ON_TIME',
    version: row.version,
  };
}

export const hitEventDto = (row: HitEventRow, names: Names): Record<string, unknown> => ({ id: row.id, move: row.move, from_status: row.fromStatus, to_status: row.toStatus, actor_name: nameOf(names, row.actorId), reason: row.reason, score: row.score, at: row.at });

export const runDto = (row: ScreeningRunRow, names: Names): Record<string, unknown> => ({
  id: row.id,
  trigger_kind: row.triggerKind,
  started_at: row.startedAt,
  finished_at: row.finishedAt,
  contractors: row.contractors,
  entries: row.entries,
  hits_new: row.hitsNew,
  hits_reopened: row.hitsReopened,
  hits_resolved: row.hitsResolved,
  holds: row.holds,
  policy_version: row.policyVersion,
  requested_by_name: nameOf(names, row.requestedBy),
});

export const sourceDto = (row: ScreeningSourceState): Record<string, unknown> => ({ source: row.source, entries: row.entries, as_of: row.asOf, reference: row.reference });
