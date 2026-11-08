import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapReallocationImpactStore, CapReallocationStore, DoaMatrixStore, TenantDatabase, projectScope, reallocationScope } from '@machvon/db';
import type { CandidatesView, ImpactView } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { snakeKeys } from '../../snake-case';
import { CurrentTenant } from '../../tenant-context.decorator';
import { delegationOf } from './reallocation.delegation';

const READ_PERMISSION = PERMISSIONS.getReallocationImpact;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const policyView = (policy: ImpactView['assumptions'] | CandidatesView['policy']): Record<string, unknown> => snakeKeys(policy) as Record<string, unknown>;

/** The impact of a proposal as the contract exposes it: the figures are the kernel's, written in snake_case; the delegation says who may approve the total. */
export function impactView(view: ImpactView, delegation: Record<string, unknown>, now: Date): Record<string, unknown> {
  return {
    proposal_id: view.proposalId,
    basis_snapshot_id: view.basisSnapshotId,
    plan_year: view.planYear,
    as_of_date: view.asOfDate,
    treasury_cutoff_date: view.treasuryCutoffDate,
    frozen: view.frozen,
    record: view.record === null ? null : snakeKeys(view.record),
    policy: { rule_version: view.policyRuleVersion, source: view.policySource, ...(policyView(view.assumptions) as object) },
    assumptions: snakeKeys(view.assumptions),
    moves: snakeKeys(view.moves),
    result: snakeKeys(view.result),
    units: view.units,
    projects: view.projects,
    delegation,
    as_of: now.toISOString(),
  };
}

export function candidatesView(view: CandidatesView, now: Date): Record<string, unknown> {
  return {
    snapshot_id: view.snapshotId,
    as_of_date: view.asOfDate,
    treasury_cutoff_date: view.treasuryCutoffDate,
    plan_year: view.planYear,
    policy: {
      version: view.policy.version,
      source: view.policy.source,
      unverified: view.policy.unverified,
      formula: view.policy.formula,
      source_text: view.policy.sourceText,
      as_of: view.policy.asOf,
      params: snakeKeys(view.policy.policy),
    },
    donors: snakeKeys(view.result.donors),
    recipients: snakeKeys(view.result.recipients),
    excluded: snakeKeys(view.result.excluded),
    lines: snakeKeys(view.lines),
    projects: view.projects,
    units: view.units,
    as_of: now.toISOString(),
  };
}

/**
 * The reads of the reallocation by performance (G1-12, CAP-19): the impact of a proposal on the disbursement rates (the record frozen when it was handed in, a live simulation for a draft) and the candidates
 * ranked by projected performance. A proposal whose unit is outside the scope of the caller does not exist for them (404).
 */
@Controller()
export class ReallocationImpactReadsController {
  private readonly proposals = new CapReallocationStore();
  private readonly impacts = new CapReallocationImpactStore();
  private readonly doa = new DoaMatrixStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('reallocation-proposals/:id/impact')
  @OperationId('getReallocationImpact')
  async impact(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const predicate = reallocationScope(access, READ_PERMISSION, now)(2);
      const visible = await tx.query<{ id: string }>(
        `select rp.id from machvon.reallocation_proposal rp join machvon.organization_unit u on u.tenant_id = rp.tenant_id and u.id = rp.scope_unit_id where rp.id = $1::uuid and (${predicate.sql})`,
        [id.toLowerCase(), ...predicate.params],
      );
      if (visible[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const proposal = await this.proposals.find(tx, id.toLowerCase());
      if (proposal === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const view = await this.impacts.read(tx, { id: proposal.id, basisSnapshotId: proposal.basisSnapshotId, status: proposal.status }, now);
      const policy = await this.impacts.policy(tx, now);
      const units = await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [proposal.scopeUnitId]);
      const unit = units[0];
      const reading = unit === undefined ? { configured: false, approverRoleId: null, approverRoleName: null, approvalLevels: null, matrixVersionId: null } : await delegationOf(this.doa, tx, { documentType: policy.policy.delegation_document_type, amountVnd: proposal.totalVnd, unit, now });
      return impactView(
        view,
        { document_type: policy.policy.delegation_document_type, configured: reading.configured, approver_role_id: reading.approverRoleId, approver_role_name: reading.approverRoleName, approval_levels: reading.approvalLevels, matrix_version_id: reading.matrixVersionId },
        now,
      );
    });
  }

  @Get('reallocation-candidates')
  @OperationId('listReallocationCandidates')
  async candidates(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('snapshot_id') snapshotId?: unknown, @Query('unit_id') unitId?: unknown): Promise<Record<string, unknown>> {
    const now = new Date();
    const snapshot = this.optionalUuid(snapshotId, 'snapshot_id');
    const unit = this.optionalUuid(unitId, 'unit_id');
    const view = await this.database.withTenant(tenant, (tx) => this.impacts.candidates(tx, { snapshotId: snapshot, unitId: unit, scope: projectScope(access, PERMISSIONS.listReallocationCandidates, now), now }));
    return candidatesView(view, now);
  }

  private optionalUuid(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
    return value.toLowerCase();
  }
}
