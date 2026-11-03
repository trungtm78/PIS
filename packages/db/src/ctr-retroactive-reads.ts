import type { TenantTx } from './tenant-database.ts';

/** One balance of the ledger that a retroactive adjustment moved. */
export interface RetroactiveLineRecord {
  id: string;
  acceptanceId: string;
  acceptanceNo: string | null;
  boqItemId: string;
  boqItemKey: string;
  partyId: string | null;
  quantity: string;
  oldAmountVnd: string;
  newUnitPrice: string;
  newAmountVnd: string;
  deltaVnd: string;
}

/** One adjustment as the screens read it (ST-CTR-016): the change order and the revision it made, the day it reaches back to, the decision document, and the balances it moved. */
export interface RetroactiveRecord {
  id: string;
  contractId: string;
  changeRequestId: string;
  changeRequestCode: string | null;
  revisionId: string;
  effectiveOn: string;
  approvedOn: string;
  basis: string;
  decisionDocumentVersionId: string;
  totalDeltaVnd: string;
  approvedBy: string;
  createdAt: string;
  affected: RetroactiveLineRecord[];
}

interface HeaderSql {
  id: string;
  change_request_id: string;
  change_request_code: string | null;
  revision_id: string;
  effective_on: string;
  approved_on: string;
  basis: string;
  decision_document_version_id: string;
  total_delta_vnd: string;
  created_by: string;
  created_at: string;
}

interface LineSql {
  id: string;
  adjustment_id: string;
  acceptance_id: string;
  acceptance_no: string | null;
  boq_item_id: string;
  boq_item_key: string;
  party_id: string | null;
  quantity: string;
  old_amount_vnd: string;
  new_unit_price: string;
  new_amount_vnd: string;
  delta_vnd: string;
}

/** The adjustments of a contract with the balances each one moved, oldest first; the lines of an adjustment in the order of the acceptance number, the item and the line. */
export async function retroactiveRecordsOf(tx: TenantTx, contractId: string): Promise<RetroactiveRecord[]> {
  const headers = await tx.query<HeaderSql>(
    `select a.id, a.change_request_id, q.code as change_request_code, a.revision_id, a.effective_on::text as effective_on, a.approved_on::text as approved_on, a.basis,
            a.decision_document_version_id, a.total_delta_vnd::text as total_delta_vnd, a.created_by, to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
       from machvon.retroactive_adjustment a join machvon.change_request q on q.tenant_id = a.tenant_id and q.id = a.change_request_id
      where a.contract_id = $1::uuid order by a.created_at, a.id`,
    [contractId],
  );
  if (headers.length === 0) return [];
  const lines = await tx.query<LineSql>(
    `select l.id, l.adjustment_id, l.acceptance_id, ac.acceptance_no, l.boq_item_id, i.business_key as boq_item_key, l.party_id, l.quantity::text as quantity,
            l.old_amount_vnd::text as old_amount_vnd, l.new_unit_price::text as new_unit_price, l.new_amount_vnd::text as new_amount_vnd, l.delta_vnd::text as delta_vnd
       from machvon.retroactive_adjustment_line l
       join machvon.acceptance ac on ac.tenant_id = l.tenant_id and ac.id = l.acceptance_id
       join machvon.boq_item i on i.tenant_id = l.tenant_id and i.id = l.boq_item_id
      where l.adjustment_id = any($1::uuid[]) order by ac.acceptance_no nulls last, l.acceptance_id, i.business_key, l.id`,
    [headers.map((header) => header.id)],
  );
  return headers.map((header) => ({
    id: header.id,
    contractId,
    changeRequestId: header.change_request_id,
    changeRequestCode: header.change_request_code,
    revisionId: header.revision_id,
    effectiveOn: header.effective_on,
    approvedOn: header.approved_on,
    basis: header.basis,
    decisionDocumentVersionId: header.decision_document_version_id,
    totalDeltaVnd: header.total_delta_vnd,
    approvedBy: header.created_by,
    createdAt: header.created_at,
    affected: lines
      .filter((line) => line.adjustment_id === header.id)
      .map((line) => ({
        id: line.id,
        acceptanceId: line.acceptance_id,
        acceptanceNo: line.acceptance_no,
        boqItemId: line.boq_item_id,
        boqItemKey: line.boq_item_key,
        partyId: line.party_id,
        quantity: line.quantity,
        oldAmountVnd: line.old_amount_vnd,
        newUnitPrice: line.new_unit_price,
        newAmountVnd: line.new_amount_vnd,
        deltaVnd: line.delta_vnd,
      })),
  }));
}
