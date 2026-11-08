import { EGP_RESOLUTION_FOLLOW_UP, egpAlertFor, egpObligationClock, egpPostingFacet, message } from '@machvon/kernel';
import type { EgpPostingKind, EgpSeverityParams } from '@machvon/kernel';
import type { EgpItemRow, EgpObligationRow } from '@machvon/db';
import { obligationOf } from '@machvon/db';

export const RATE_FORMULA = message('bid.egp.posting.rate.formula');
export const RATE_SOURCE = message('bid.egp.posting.rate.source');
export const RECONCILE_FORMULA = message('bid.egp.reconcile.formula');
export const RECONCILE_SOURCE = message('bid.egp.reconcile.source');

type Names = ReadonlyMap<string, string>;
const nameOf = (names: Names, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

/** What the caller may do with an obligation now: the kernel's edges and the rule that who submits is not who prepared; the permissions are the caller's. */
export interface PostingCaller {
  membershipId: string;
  mayPrepare: boolean;
  maySubmit: boolean;
}

export function obligationDto(
  row: EgpObligationRow,
  context: { now: Date; severity: EgpSeverityParams; names: Names; caller: PostingCaller; obligationText: string | null; batchStatus: string | null },
): Record<string, unknown> {
  const clock = egpObligationClock(obligationOf(row), context.now);
  const alert = egpAlertFor(clock) ?? null;
  const facet = egpPostingFacet(clock, context.severity);
  const open = row.state === 'DUE' || row.state === 'REJECTED';
  return {
    id: row.id,
    kind: row.kind,
    obligation: context.obligationText,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    subject_code: row.subjectCode,
    trigger_event: row.triggerEvent,
    triggered_at: row.triggeredAt,
    due_at: row.dueAt,
    remind_before_days: row.remindBeforeDays,
    rule_code: row.ruleCode,
    rule_version: row.ruleVersion,
    rule_source: row.ruleSource,
    legal_status: row.legalStatus,
    state: row.state,
    clock: { status: clock.status, ms_to_due: clock.msToDue },
    alert,
    severity: facet === undefined ? null : facet === 'DUE_SOON' ? 'ACTION' : 'URGENT',
    owner_id: row.ownerId,
    owner_name: nameOf(context.names, row.ownerId),
    prepared_by_name: nameOf(context.names, row.preparedBy),
    prepared_at: row.preparedAt,
    submitted_by_name: nameOf(context.names, row.submittedBy),
    submitted_at: row.submittedAt,
    rejected_at: row.rejectedAt,
    rejection_reason: row.rejectionReason,
    cancel_reason: row.cancelReason,
    receipt_ref: row.receiptRef,
    receipted_at: row.receiptedAt,
    receipt_recorded_by_name: nameOf(context.names, row.receiptRecordedBy),
    packet_sha256: row.packetSha256,
    packet: row.packet === null ? null : (row.packet as unknown as Record<string, unknown>),
    export_batch_id: row.exportBatchId,
    export_batch_status: context.batchStatus,
    version: row.version,
    created_at: row.createdAt,
    actions: {
      prepare: context.caller.mayPrepare && open,
      submit: context.caller.maySubmit && row.state === 'PREPARED' && row.preparedBy !== context.caller.membershipId,
      receipt: context.caller.maySubmit && row.state === 'SUBMITTED',
      reject: context.caller.maySubmit && row.state === 'SUBMITTED',
      cancel: context.caller.mayPrepare && (open || row.state === 'PREPARED'),
    },
  };
}

export const KINDS_WITH_BATCH: readonly EgpPostingKind[] = ['CONTRACTOR_PERFORMANCE', 'VIOLATION'];

export function itemDto(row: EgpItemRow, context: { now: Date; names: Names; caller: { membershipId: string; mayResolve: boolean } }): Record<string, unknown> {
  return {
    id: row.id,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    subject_code: row.subjectCode,
    external_code: row.externalCode,
    field: row.field,
    difference_kind: row.differenceKind,
    ours: row.ours,
    theirs: row.theirs,
    delta: row.delta,
    state: row.state,
    owner_id: row.ownerId,
    owner_name: nameOf(context.names, row.ownerId),
    opened_at: row.openedAt,
    due_at: row.dueAt,
    overdue: row.state === 'OPEN' && Date.parse(row.dueAt) < context.now.getTime(),
    source_import_id: row.importId,
    resolution:
      row.resolutionKind === null
        ? null
        : {
            kind: row.resolutionKind,
            resolved_by_name: nameOf(context.names, row.resolvedBy),
            resolved_at: row.resolvedAt,
            reason: row.reason,
            evidence_ref: row.evidenceRef,
            review_on: row.reviewOn,
            follow_up: EGP_RESOLUTION_FOLLOW_UP[row.resolutionKind],
          },
    version: row.version,
    is_maker: row.makerIds.includes(context.caller.membershipId),
    actions: { resolve: context.caller.mayResolve && row.state === 'OPEN' && !row.makerIds.includes(context.caller.membershipId) },
  };
}
