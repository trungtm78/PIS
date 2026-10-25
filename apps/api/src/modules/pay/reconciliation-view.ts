import { isWaiting } from '@machvon/kernel';
import type { ReconciliationItemView, TreasuryTrackingRow } from '@machvon/db';

/**
 * An item of difference as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown until it is listed here. The buttons say which commands the
 * state of the item allows (an item is explained first, then resolved; a write-off comes from one that still waits); the permission of the caller is the screen's to add, and the server judges each
 * command again.
 */
export function reconciliationItemView(item: ReconciliationItemView): Record<string, unknown> {
  const waiting = isWaiting(item.status);
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    project_id: item.projectId,
    project_code: item.projectCode,
    contract_id: item.contractId,
    contract_code: item.contractCode,
    payment_request_id: item.paymentRequestId,
    request_no: item.requestNo,
    treasury_transaction_id: item.transactionId,
    document_no: item.documentNo,
    source_file_name: item.sourceFileName,
    source_file_sha256: item.sourceFileSha256,
    internal_amount_vnd: item.internalAmountVnd,
    confirmed_amount_vnd: item.confirmedAmountVnd,
    difference_vnd: item.differenceVnd,
    owner_membership_id: item.ownerMembershipId,
    owner_name: item.ownerName,
    due_at: item.dueAt,
    overdue: item.overdue,
    resolution_note: item.resolutionNote,
    resolved_by: item.resolvedBy,
    resolved_at: item.resolvedAt,
    approval_document_version_id: item.approvalDocumentVersionId,
    issue_id: item.issueId,
    version: item.version,
    actions: { assign: waiting, explain: item.status === 'OPEN', resolve: item.status === 'EXPLAINED', write_off: waiting },
  };
}

/** One project of PAY-09 as openapi.json exposes it. */
export function trackingView(row: TreasuryTrackingRow): Record<string, unknown> {
  return {
    project_id: row.projectId,
    project_code: row.projectCode,
    project_name: row.projectName,
    sent: { count: row.sent.count, amount_vnd: row.sent.amountVnd },
    settled: { count: row.settled.count, amount_vnd: row.settled.amountVnd },
    confirmed: { count: row.confirmed.count, amount_vnd: row.confirmed.amountVnd },
    unmatched: row.unmatched,
    differences: { count: row.differences.count, amount_vnd: row.differences.differenceVnd },
    last_confirmed_at: row.lastConfirmedAt,
    last_import_at: row.lastImportAt,
  };
}
