import type { BoqLineRow } from '@machvon/db';

/** What a reader may see of a line: the staff of the owner see the stable item that downstream ledgers refer to, a guest contractor does not. */
export interface BoqRights {
  internal: boolean;
}

/**
 * The line of a BOQ as openapi.json exposes it (x-exposure keep): an allowlist, so a column added to the table later is not shown until it is
 * listed here. A line carries its prices, so a guest contractor sees the lines of its own contract and nothing of the members' internal rows.
 */
export function boqLineView(row: BoqLineRow, rights: BoqRights): Record<string, unknown> {
  return {
    id: row.id,
    contract_id: row.contractId,
    contract_code: row.contractCode,
    contract_revision_id: row.revisionId,
    revision: row.revision,
    revision_status: row.revisionStatus,
    line_no: row.lineNo,
    business_key: row.businessKey,
    description: row.description,
    unit_code: row.unitCode,
    quantity: row.quantity,
    unit_price: row.unitPrice,
    rounding_rule: row.roundingRule,
    amount_vnd: row.amountVnd,
    retention_pct: row.retentionPct,
    milestone_code: row.milestoneCode,
    milestone_due_on: row.milestoneDueOn,
    party_contractor_id: row.partyContractorId,
    party_name: row.partyName,
    ...(rights.internal ? { boq_item_id: row.boqItemId } : {}),
  };
}
