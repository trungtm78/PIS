import { randomUUID } from 'node:crypto';

type Rows = (sql: string, params?: unknown[]) => Promise<unknown>;

/**
 * Pays an increase of a change order from the contingency of its project, the way an approver sees it (lane B2, G1-8): an increase is approved only with a source, so the tests that approve one first
 * put the money in the contingency (the document that allots it, an entry of the ledger) and draw it for exactly this change order (a request by one person, approved by another). Written with the
 * owner connection, but through the same triggers: the balance is the database's, so this cannot leave a fund that does not add up.
 */
export async function coverChange(rows: Rows, input: { tenantId: string; projectId: string; changeId: string; amountVnd: string; authorityDocumentVersionId: string; requester: string; approver: string }): Promise<void> {
  const fundId = randomUUID();
  await rows(
    "insert into machvon.reserve_fund (tenant_id, id, project_id, kind, created_by) values ($1, $2, $3, 'CONTINGENCY', $4) on conflict (tenant_id, project_id, kind) do nothing",
    [input.tenantId, fundId, input.projectId, input.requester],
  );
  const [fund] = (await rows('select id from machvon.reserve_fund where project_id = $1::uuid and kind = $2', [input.projectId, 'CONTINGENCY'])) as Array<{ id: string }>;
  await rows(
    `insert into machvon.reserve_ledger_entry (tenant_id, fund_id, project_id, entry_kind, amount_vnd, authority_document_version_id, reason, requested_by)
     values ($1, $2, $3, 'FUND', $4::numeric, $5, 'Allotted for the tests of the change orders.', $6)`,
    [input.tenantId, fund?.id, input.projectId, input.amountVnd, input.authorityDocumentVersionId, input.requester],
  );
  const drawdownId = randomUUID();
  await rows(
    `insert into machvon.reserve_drawdown (tenant_id, id, fund_id, project_id, amount_vnd, change_request_id, reason, requested_by) values ($1, $2, $3, $4, $5::numeric, $6, 'Paid from the contingency.', $7)`,
    [input.tenantId, drawdownId, fund?.id, input.projectId, input.amountVnd, input.changeId, input.requester],
  );
  const entryId = randomUUID();
  await rows(
    `insert into machvon.reserve_ledger_entry (tenant_id, id, fund_id, project_id, entry_kind, amount_vnd, change_request_id, drawdown_id, reason, requested_by, approved_by)
     values ($1, $2, $3, $4, 'DRAWDOWN', $5::numeric, $6, $7, 'Paid from the contingency.', $8, $9)`,
    [input.tenantId, entryId, fund?.id, input.projectId, input.amountVnd, input.changeId, drawdownId, input.requester, input.approver],
  );
  await rows("update machvon.reserve_drawdown set status = 'APPROVED', decided_by = $2, decided_at = now(), ledger_entry_id = $3 where id = $1::uuid", [drawdownId, input.approver, entryId]);
}

/**
 * Clears the check of the project adjustment of a change order (lane B2, G1-8): a cumulative variation at the threshold of the policy needs it before the approval. The tests that approve a very large change put the
 * cleared check in place the way the person who clears it would have left it.
 */
export async function clearAdjustmentCheck(rows: Rows, input: { tenantId: string; projectId: string; contractId: string; changeId: string; cumulativePct: string; documentVersionId: string; requiredBy: string; clearedBy: string }): Promise<void> {
  await rows(
    `insert into machvon.change_adjustment_check
       (tenant_id, change_request_id, project_id, contract_id, status, cumulative_pct, threshold_pct, basis, decision_document_version_id, required_by, cleared_by, cleared_at, audit_notified_at)
     values ($1, $2, $3, $4, 'CLEARED', $5::numeric, 10, 'The investment decision was adjusted for the tests.', $6, $7, $8, now(), now())
     on conflict (tenant_id, change_request_id) do update set status = 'CLEARED', cumulative_pct = excluded.cumulative_pct, basis = excluded.basis, decision_document_version_id = excluded.decision_document_version_id, cleared_by = excluded.cleared_by, cleared_at = now()`,
    [input.tenantId, input.changeId, input.projectId, input.contractId, input.cumulativePct, input.documentVersionId, input.requiredBy, input.clearedBy],
  );
}
