import { hpmAcceptance, integrationTexts } from '@machvon/edition-enterprise/src/server.ts';
import type { EbsItemRow, EbsRunRow, HpmAttemptRow, HpmCorrectionRow, HpmPushRow } from '@machvon/edition-enterprise/src/server.ts';

/** The names of people by id, as the reads of BID give them (`BidWorkflowReads.names`). */
export type Names = ReadonlyMap<string, string>;
const nameOf = (names: Names, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

export interface Caller {
  membershipId: string;
  mayRetry: boolean;
  mayRecordReceipt: boolean;
  mayDecideCorrection: boolean;
  mayResolve: boolean;
  mayReassign: boolean;
}

const attemptDto = (attempt: HpmAttemptRow, names: Names): Record<string, unknown> => ({
  attempt_no: attempt.attemptNo,
  outcome: attempt.outcome,
  error_code: attempt.errorCode,
  package_sha256: attempt.packageSha256,
  actor_name: nameOf(names, attempt.actorId),
  attempted_at: attempt.attemptedAt,
});

/** The answer of the adapter as the screen reads it: where the package is, its hash and the words that tell the receiver has not confirmed (the response is stored as the adapter gave it; only the known members are shown). */
function responseDto(response: Record<string, unknown> | null): Record<string, unknown> | null {
  if (response === null) return null;
  return {
    mode: response.mode ?? 'FILE',
    location: response.location ?? '',
    package_name: response.packageName ?? '',
    package_sha256: response.packageSha256 ?? '',
    package_size: typeof response.packageSize === 'number' ? response.packageSize : 0,
    package_format: response.packageFormat ?? '',
    receiver: response.receiver ?? 'AWAITING_RECEIPT',
    acceptance: response.acceptance ?? 'PENDING_EXTERNAL',
  };
}

export function pushDto(row: HpmPushRow, names: Names, caller: Caller): Record<string, unknown> {
  return {
    id: row.id,
    key: row.key,
    org_unit_id: row.orgUnitId,
    layout_code: row.layoutCode,
    period: row.period,
    revision: row.revision,
    sha256: row.sha256,
    snapshot: row.snapshot === null ? null : { snapshot_id: row.snapshot.snapshotId, revision: row.snapshot.revision, cutoff: row.snapshot.cutoff },
    form_status: row.marks?.formStatus ?? null,
    demo_mark: row.marks?.demoMark ?? null,
    package_format: row.packageFormat,
    acceptance: hpmAcceptance(row.packageFormat),
    status: row.status,
    attempts: row.attempts,
    last_attempt_at: row.lastAttemptAt,
    last_error_code: row.lastErrorCode,
    response: responseDto(row.response),
    correction_id: row.correctionId,
    overwrites: row.overwrites,
    pushed_by: row.pushedBy,
    pushed_by_name: nameOf(names, row.pushedBy),
    receipt: row.receiptBy === null ? null : { reference: row.receiptReference, note: row.receiptNote, by: row.receiptBy, by_name: nameOf(names, row.receiptBy), at: row.receiptAt },
    version: row.version,
    created_at: row.createdAt,
    attempt_log: row.attemptRows.map((attempt) => attemptDto(attempt, names)),
    actions: {
      may_retry: caller.mayRetry && (row.status === 'FAILED' || row.status === 'WRITTEN'),
      // The person who pushed does not record the receipt of their own push; a package that was not written has no receipt to record.
      may_record_receipt: caller.mayRecordReceipt && row.status === 'WRITTEN' && row.pushedBy !== caller.membershipId,
    },
  };
}

export function correctionDto(row: HpmCorrectionRow, names: Names, caller: Caller): Record<string, unknown> {
  return {
    id: row.id,
    layout_code: row.layoutCode,
    period: row.period,
    from_revision: row.fromRevision,
    period_reopen_id: row.periodReopenId,
    reason: row.reason,
    state: row.state,
    proposed_by: row.proposedBy,
    proposed_by_name: nameOf(names, row.proposedBy),
    decided_by: row.decidedBy,
    decided_by_name: nameOf(names, row.decidedBy),
    decided_at: row.decidedAt,
    decision_reason: row.decisionReason,
    consumed_by_push_id: row.consumedByPushId,
    consumed_at: row.consumedAt,
    version: row.version,
    created_at: row.createdAt,
    actions: { may_decide: caller.mayDecideCorrection && row.state === 'PROPOSED' && row.proposedBy !== caller.membershipId },
  };
}

export function differenceDto(row: EbsItemRow, names: Names, caller: Caller, now: Date, acceptance: 'PENDING_EXTERNAL' | 'ACCEPTABLE'): Record<string, unknown> {
  const open = row.state === 'OPEN';
  return {
    id: row.id,
    project_id: row.projectId,
    project_code: row.projectCode,
    period: row.period,
    measure: row.measure,
    difference_kind: row.differenceKind,
    ours: row.ours,
    theirs: row.theirs,
    delta: row.delta,
    state: row.state,
    owner_id: row.ownerId,
    owner_name: nameOf(names, row.ownerId),
    opened_at: row.openedAt,
    due_at: row.dueAt,
    overdue: open && Date.parse(row.dueAt) < now.getTime(),
    resolution:
      row.resolutionKind === null
        ? null
        : { kind: row.resolutionKind, resolved_by: row.resolvedBy, resolved_by_name: nameOf(names, row.resolvedBy), resolved_at: row.resolvedAt, reason: row.reason, evidence_ref: row.evidenceRef, review_on: row.reviewOn },
    acceptance,
    version: row.version,
    actions: {
      // Only the owner settles an item, and never a maker; the maker of the figures may not be handed it either.
      may_resolve: caller.mayResolve && open && row.ownerId === caller.membershipId && !row.makerIds.includes(caller.membershipId),
      may_reassign: caller.mayReassign && open,
    },
  };
}

export function runDto(run: EbsRunRow, names: Names): Record<string, unknown> {
  return {
    id: run.id,
    layout_version: run.layoutVersion,
    file_sha256: run.fileSha256,
    status: run.status,
    error_code: run.errorCode,
    counts: { total: run.counts.total, applied: run.counts.applied, duplicate: run.counts.duplicate, conflict: run.counts.conflict, quarantined: run.counts.quarantined, differences_opened: run.counts.differencesOpened },
    imported_by_name: nameOf(names, run.importedBy),
    created_at: run.createdAt,
    completed_at: run.completedAt,
  };
}

/** One quarantined row as the error report shows it. */
export function rowErrorDto(row: { line: number; businessKey: string | null; errorCode: string; field: string; maskedPreview: Record<string, string> | null }): Record<string, unknown> {
  return { line: row.line, business_key: row.businessKey, code: row.errorCode, field: row.field, preview: row.maskedPreview };
}

export const pendingExternalDto = (which: 'hpm' | 'ebs'): Array<Record<string, string>> => integrationTexts().pendingExternal[which].map((item) => ({ code: item.code, what: item.what, owner: item.owner, consequence: item.consequence }));

/** The rule behind a number of the screen, with where it comes from and whether anybody confirmed it. */
export interface RuleReading {
  source: string;
  version: number;
  unverified: boolean;
  formula: string | null;
  sourceText: string | null;
  asOf: string | null;
  legalStatus: string | null;
}

export const ruleDto = (rule: RuleReading): Record<string, unknown> => ({
  source: rule.source,
  version: rule.version,
  unverified: rule.unverified,
  legal_status: rule.legalStatus,
  formula: rule.formula,
  source_text: rule.sourceText,
  as_of: rule.asOf,
});

