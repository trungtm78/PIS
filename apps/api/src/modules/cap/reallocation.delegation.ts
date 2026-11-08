import { DoaMatrixStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { DomainError, vietnamDateOf, withinDelegation } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';

export interface ReallocationDelegationQuery {
  /** The DoA document type of the policy (`delegation_document_type`, `CAP_REALLOCATION` by default). */
  documentType: string;
  /** The permission the approver holds; their grant has to reach the rank of the approver role of the band. */
  permission: string;
  amountVnd: string;
  /** The unit the proposal is made for (the unit the rule is looked up from). */
  unit: { id: string; path: string };
  now: Date;
}

/**
 * The delegation of authority for a reallocation (G1-12, "duyet theo uy quyen"): the matrix of ADM says which role may approve the total of a proposal, and the grants of the person who decides or applies
 * must reach that role over the unit of the proposal (403 `SCOPE_DENIED` below it, 422 `DOA_RULE_NOT_FOUND` for an amount no band covers). A tenant that configured no band at all for the document type keeps
 * the behaviour it had before (no limit); one that configured bands is always limited, so a band left out is a refusal and never a permission. The check runs on a transaction, not on a command scope, because the
 * approval workflow runs the same steps.
 */
export async function assertReallocationDelegation(doa: DoaMatrixStore, tx: TenantTx, access: EffectiveAccess, query: ReallocationDelegationQuery): Promise<void> {
  const businessDate = vietnamDateOf(query.now);
  const configured = await tx.query<{ found: boolean }>(
    `select exists (
       select 1 from machvon.doa_rule r join machvon.doa_matrix_version m on m.id = r.matrix_version_id
        where r.document_type = $1 and m.status in ('Published', 'Superseded') and m.effective_from <= $2::date and (m.effective_until is null or $2::date < m.effective_until)) as found`,
    [query.documentType, businessDate],
  );
  if (configured[0]?.found !== true) return;
  const resolution = await doa.resolve(tx, { documentType: query.documentType, amountVnd: query.amountVnd, unitId: query.unit.id, businessDate });
  const roles = await tx.query<{ rank: number }>('select rank from machvon.role_definition where id = $1::uuid', [resolution.approverRoleId]);
  const rank = roles[0]?.rank;
  if (rank === undefined) throw new DomainError('DOA_RULE_NOT_FOUND', 422, 'approver_role_id');
  if (!withinDelegation(access, query.now, query.permission, { ownerUnitPath: query.unit.path, ownerUnitId: query.unit.id }, rank)) {
    throw new DomainError('SCOPE_DENIED', 403, 'delegation', { extensions: { approver_role_id: resolution.approverRoleId } });
  }
}

/** Who may approve the total of a proposal, for the screen: the role of the band (null when no band is configured for the document type) and the levels it asks for. */
export async function delegationOf(doa: DoaMatrixStore, tx: TenantTx, query: Pick<ReallocationDelegationQuery, 'documentType' | 'amountVnd' | 'unit' | 'now'>): Promise<{ configured: boolean; approverRoleId: string | null; approverRoleName: string | null; approvalLevels: number | null; matrixVersionId: string | null }> {
  const businessDate = vietnamDateOf(query.now);
  const configured = await tx.query<{ found: boolean }>(
    `select exists (
       select 1 from machvon.doa_rule r join machvon.doa_matrix_version m on m.id = r.matrix_version_id
        where r.document_type = $1 and m.status in ('Published', 'Superseded') and m.effective_from <= $2::date and (m.effective_until is null or $2::date < m.effective_until)) as found`,
    [query.documentType, businessDate],
  );
  if (configured[0]?.found !== true) return { configured: false, approverRoleId: null, approverRoleName: null, approvalLevels: null, matrixVersionId: null };
  const resolution = await doa.resolve(tx, { documentType: query.documentType, amountVnd: query.amountVnd, unitId: query.unit.id, businessDate });
  const roles = await tx.query<{ name: string }>('select name from machvon.role_definition where id = $1::uuid', [resolution.approverRoleId]);
  return { configured: true, approverRoleId: resolution.approverRoleId, approverRoleName: roles[0]?.name ?? null, approvalLevels: resolution.approvalLevels, matrixVersionId: resolution.matrixVersionId };
}
