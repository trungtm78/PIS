import type { DoaMatrixStore } from '@machvon/db';
import { DomainError, vietnamDateOf, withinDelegation } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef } from '@machvon/kernel';
import type { CommandScope } from './command-scope';

export interface DelegationQuery {
  /** The DoA document type the approval is limited under. */
  documentType: string;
  /** The permission the approver holds; their grant has to reach the rank of the approver role of the band. */
  permission: string;
  amountVnd: string;
  /** The unit the rule is looked up from (the owner unit of the project). */
  unitId: string;
  place: ResourceRef;
  now: Date;
  /** What a tenant that has no rule at all for the document type means: `REFUSE` (422 `DOA_RULE_NOT_FOUND`) or `ALLOW` (no limit has been configured). */
  unconfigured: 'REFUSE' | 'ALLOW';
}

/**
 * The delegation limit of the matrix of ADM for the amount of a document, tested against the grants of the caller: 403 `SCOPE_DENIED` above it, and 422 `DOA_RULE_NOT_FOUND` when
 * no rule applies. A document type for which the tenant configured no rule at all is limited or not as `unconfigured` says; one for which it configured rules is always limited, so a
 * band that was left out is a refusal and never a permission.
 */
export async function assertWithinDelegation(doa: DoaMatrixStore, scope: CommandScope, access: EffectiveAccess, query: DelegationQuery): Promise<void> {
  const businessDate = vietnamDateOf(query.now);
  if (query.unconfigured === 'ALLOW') {
    const configured = await scope.tx.query<{ found: boolean }>(
      `select exists (
         select 1 from machvon.doa_rule r join machvon.doa_matrix_version m on m.id = r.matrix_version_id
          where r.document_type = $1 and m.status in ('Published', 'Superseded') and m.effective_from <= $2::date and (m.effective_until is null or $2::date < m.effective_until)) as found`,
      [query.documentType, businessDate],
    );
    if (configured[0]?.found !== true) return;
  }
  const resolution = await doa.resolve(scope.tx, { documentType: query.documentType, amountVnd: query.amountVnd, unitId: query.unitId, businessDate });
  const roles = await scope.tx.query<{ rank: number }>('select rank from machvon.role_definition where id = $1::uuid', [resolution.approverRoleId]);
  const rank = roles[0]?.rank;
  if (rank === undefined) throw new DomainError('DOA_RULE_NOT_FOUND', 422, 'approver_role_id');
  if (!withinDelegation(access, query.now, query.permission, query.place, rank)) {
    throw new DomainError('SCOPE_DENIED', 403, 'delegation', { extensions: { approver_role_id: resolution.approverRoleId } });
  }
}
