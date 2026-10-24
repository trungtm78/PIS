import type { AppropriationRow } from '@machvon/db';

/**
 * The line of the register as openapi.json exposes it (x-exposure dto): an allowlist, so a column added to the table later is not shown
 * until it is listed here. Amounts are decimal strings in whole VND; the decision document is shown by its citation (symbol and date),
 * never by its title or content.
 */
export function appropriationView(row: AppropriationRow): Record<string, unknown> {
  return {
    id: row.id,
    fund_source: {
      version_id: row.fundSource.versionId,
      business_key: row.fundSource.businessKey,
      label: row.fundSource.label,
      category: row.fundSource.category,
      relation: row.fundSource.relation,
      onlending: row.fundSource.onLending,
      valid_from: row.fundSource.validFrom,
      valid_until: row.fundSource.validUntil,
    },
    program: row.program === null ? null : { version_id: row.program.versionId, business_key: row.program.businessKey, label: row.program.label },
    plan_year: row.planYear,
    origin: row.origin,
    budget_level: row.budgetLevel,
    amount_vnd: row.amountVnd,
    allocated_total_vnd: row.allocatedTotalVnd,
    remaining_vnd: row.remainingVnd,
    decision_document: { id: row.decisionDocumentId, symbol: row.decisionSymbol, issued_on: row.decisionIssuedOn },
    issuing_authority: row.issuingAuthority,
    source_year: row.sourceYear,
    is_extended: row.isExtended,
    extended_to: row.extendedTo,
    extension_document_id: row.extensionDocumentId,
    revision: row.revision,
    supersedes_id: row.supersedesId,
    capital_plan_id: row.capitalPlanId,
    status: row.status,
    created_by: row.createdBy,
    approved_by: row.approvedBy,
    version: row.version,
  };
}
