import type {
  TreasuryConnectorView,
  TreasuryImportItemView,
  TreasuryImportRowView,
  TreasuryImportView,
  TreasuryTotals,
  TreasuryTransactionRow,
} from '@machvon/db';

/**
 * The Treasury layers of PAY as openapi.json exposes them (x-exposure dto): allowlists, so a column added to a table later is not shown until
 * it is listed here. Nothing here carries an account number, the hash of a row or the key under which a transaction is deduplicated: a
 * transaction is named by its voucher number and its date, and an import line shows its row as masked when it was read.
 */
export function treasuryTransactionView(row: TreasuryTransactionRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.projectId,
    project_code: row.projectCode,
    provider: row.provider,
    source_kind: row.sourceKind,
    direction: row.direction,
    document_no: row.documentNo,
    document_date: row.documentDate,
    amount_vnd: row.amountVnd,
    confirmed_at: row.confirmedAt,
    match_status: row.matchStatus,
    payment_request_id: row.paymentRequestId,
    import_id: row.importId,
    plan_year: row.planYear,
  };
}

/** One import in the list of imports: the header of `getTreasuryImport` without its lines. */
export function treasuryImportLineView(header: TreasuryImportView): Record<string, unknown> {
  return {
    id: header.id,
    file_name: header.fileName,
    file_sha256: header.fileSha256,
    source_kind: header.sourceKind,
    statement_date: header.statementDate,
    status: header.status,
    row_total: header.counts.total,
    row_new: header.counts.new,
    row_duplicate: header.counts.duplicate,
    row_conflict: header.counts.conflict,
    row_error: header.counts.error,
    imported_by: header.importedBy,
    imported_by_name: header.importedByName,
    imported_at: header.importedAt,
  };
}

function lineView(row: TreasuryImportRowView): Record<string, unknown> {
  return {
    row_no: row.rowNo,
    business_key: row.businessKey,
    outcome: row.outcome,
    error_code: row.errorCode,
    treasury_transaction_id: row.treasuryTransactionId,
    raw_masked: row.rawMasked,
  };
}

function differenceView(item: TreasuryImportItemView): Record<string, unknown> {
  return {
    id: item.id,
    code: item.code,
    business_key: item.businessKey,
    row_no: item.line,
    expected: item.expected,
    actual: item.actual,
    difference: item.difference,
    owner_membership_id: item.ownerMembershipId,
    owner_name: item.ownerName,
    due_at: item.dueAt,
    status: item.status,
  };
}

/**
 * One import as PAY-13 shows it: what was read (the counts of the header are those of the whole file), what became of each line, the
 * differences that wait for an owner, and where the adapter stands. The adapter is PROPOSED and the Treasury API is MISSING: the screen says
 * so beside the result, because the layout is a working assumption until the agency gives samples (R-PAY-04).
 */
export function treasuryImportView(
  header: TreasuryImportView,
  detail: { lines: { rows: TreasuryImportRowView[]; truncated: boolean }; differences: TreasuryImportItemView[]; connector: TreasuryConnectorView; totals: TreasuryTotals },
): Record<string, unknown> {
  return {
    id: header.id,
    provider: header.provider,
    source_kind: header.sourceKind,
    file_name: header.fileName,
    file_sha256: header.fileSha256,
    statement_date: header.statementDate,
    status: header.status,
    row_total: header.counts.total,
    row_new: header.counts.new,
    row_duplicate: header.counts.duplicate,
    row_conflict: header.counts.conflict,
    row_error: header.counts.error,
    imported_by: header.importedBy,
    imported_by_name: header.importedByName,
    imported_at: header.importedAt,
    adapter: {
      connector_code: detail.connector.connectorCode,
      format_version: detail.connector.formatVersion,
      file_status: detail.connector.adapterStatus,
      api_status: 'MISSING',
      connector_status: detail.connector.status,
      last_error_code: detail.connector.lastErrorCode,
      last_success_at: detail.connector.lastSuccessAt,
    },
    certified_total: { rows: detail.totals.rows, amount_vnd: detail.totals.amountVnd, open_differences: detail.totals.openDifferences },
    rows: detail.lines.rows.map(lineView),
    rows_truncated: detail.lines.truncated,
    differences: detail.differences.map(differenceView),
  };
}
