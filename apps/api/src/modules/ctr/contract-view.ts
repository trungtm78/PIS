import type { ContractDetail, ContractLine, PartiesCheck, PartyRow, RevisionRow, StatusChangeRow } from '@machvon/db';

/**
 * What a reader may see of a contract, beyond the line: `internal` is the right of the staff of the owner (a guest contractor does not have
 * it) to the ceiling of the price and to the people and the reasons behind the history; `ledger` is the right to the totals the ledger keeps
 * on the contract (`ledger.read`), which no other reader sees at all, not even as zeros.
 */
export interface ContractRights {
  internal: boolean;
  ledger: boolean;
}

export function partyView(row: PartyRow): Record<string, unknown> {
  return {
    id: row.id,
    contractor_id: row.contractorId,
    contractor_name: row.contractorName,
    role: row.role,
    share_pct: row.sharePct,
    work_value_vnd: row.workValueVnd,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    version: row.version,
  };
}

function checkView(check: PartiesCheck): Record<string, unknown> {
  return { share_total: check.shareTotal, work_value_total_vnd: check.workValueTotal, shares_complete: check.sharesComplete, work_matches_value: check.workMatchesValue };
}

/**
 * The line of the register as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until
 * it is listed here. The fields the picker of guest invitations (ADM-17) reads are the same: id, code, status, contractor, project, owner unit and due date.
 */
export function contractLineView(line: ContractLine, rights: ContractRights): Record<string, unknown> {
  return {
    id: line.id,
    code: line.code,
    title: line.title,
    status: line.status,
    type: line.type,
    project_id: line.projectId,
    project_code: line.projectCode,
    project_name: line.projectName,
    package_id: line.packageId,
    contractor_id: line.contractorId,
    contractor_name: line.contractorName,
    owner_unit_id: line.ownerUnitId,
    is_joint_venture: line.isJointVenture,
    contract_value_vnd: line.contractValueVnd,
    ...(rights.internal ? { estimate_ceiling_vnd: line.estimateCeilingVnd } : {}),
    completion_due: line.completionDue,
    version: line.version,
  };
}

export function revisionView(row: RevisionRow): Record<string, unknown> {
  return {
    id: row.id,
    contract_id: row.contractId,
    contract_code: row.contractCode,
    revision: row.revision,
    kind: row.kind,
    status: row.status,
    amount_vnd: row.amountVnd,
    document_version_id: row.documentVersionId,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    retroactive: row.retroactive,
    decided_at: row.decidedAt,
    version: row.version,
    created_at: row.createdAt,
  };
}

function statusChangeView(row: StatusChangeRow): Record<string, unknown> {
  return {
    id: row.id,
    from_status: row.fromStatus,
    to_status: row.toStatus,
    reason: row.reason,
    effective_on: row.effectiveOn,
    command: row.command,
    created_at: row.createdAt,
    created_by: row.createdBy,
  };
}

/** The detail the three screens read: the line, the terms, the revisions, the members with their sums and, by right, the history and the ledger totals. */
export function contractDetailView(detail: ContractDetail, rights: ContractRights): Record<string, unknown> {
  return {
    ...contractLineView(detail, rights),
    advance_category: detail.advanceCategory,
    requires_quality_acceptance: detail.requiresQualityAcceptance,
    signed_on: detail.signedOn,
    effective_from: detail.effectiveFrom,
    status_reason: detail.statusReason,
    created_at: detail.createdAt,
    updated_at: detail.updatedAt,
    revisions: detail.revisions.map(revisionView),
    parties: detail.parties.map(partyView),
    parties_check: checkView(detail.partiesCheck),
    ...(rights.internal ? { created_by: detail.createdBy, status_changes: detail.statusChanges.map(statusChangeView) } : {}),
    ...(rights.ledger
      ? {
          accepted_total_vnd: detail.ledger.acceptedTotalVnd,
          requested_total_vnd: detail.ledger.requestedTotalVnd,
          paid_total_vnd: detail.ledger.paidTotalVnd,
          advance_paid_vnd: detail.ledger.advancePaidVnd,
          advance_recovered_vnd: detail.ledger.advanceRecoveredVnd,
          advance_outstanding_vnd: detail.ledger.advanceOutstandingVnd,
          retention_held_vnd: detail.ledger.retentionHeldVnd,
          retention_released_vnd: detail.ledger.retentionReleasedVnd,
        }
      : {}),
  };
}
