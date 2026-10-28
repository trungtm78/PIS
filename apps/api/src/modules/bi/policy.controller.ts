import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BiPolicyStore, TenantDatabase } from '@machvon/db';
import type { PolicyRow } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const RESOURCE_TYPE = 'bi_access_policy';
const STATUSES: readonly string[] = ['DRAFT', 'ACTIVE', 'RETIRED'];

export function policyView(row: PolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    dataset_id: row.datasetId,
    revision: row.revision,
    grantee_kind: row.granteeKind,
    grantee_ref_id: row.granteeRefId,
    row_predicate_ast: row.rowPredicate,
    column_masks: row.columnMasks,
    hidden_columns: Object.entries(row.columnMasks)
      .filter(([, mode]) => mode === 'HIDE')
      .map(([column]) => column)
      .sort(),
    status: row.status,
    approved_by: row.approvedBy,
    created_by: row.createdBy,
    created_at: row.createdAt,
    version: row.version,
  };
}

/**
 * The row and column policies of BI (ST-BI-003, BI BR-BI-05): a data administrator drafts a policy for a role, a unit tree or one membership over a dataset; it allows nothing until someone other than its author makes it
 * ACTIVE (the decision on a publication request, ST-BI-006), and a dataset that no ACTIVE policy covers is closed to the person. Over the whole tenant: a policy is the tenant's, not a unit's.
 */
@Controller()
export class PolicyController {
  private readonly policies = new BiPolicyStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('bi/access-policies')
  @HttpCode(200)
  @OperationId('createBiAccessPolicy')
  @Command({ operation: 'createBiAccessPolicy' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BiAccessPolicyDraft']): Promise<CommandResult & { revision: number }> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.createBiAccessPolicy)) throw new DomainError('SCOPE_DENIED', 403);
    const datasetId = asUuid(body.dataset_id);
    const granteeRefId = asUuid(body.grantee_ref_id);
    if (datasetId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_id');
    if (granteeRefId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'grantee_ref_id');
    const created = await this.policies.create(scope.tx, { datasetId, granteeKind: body.grantee_kind, granteeRefId, rowPredicate: body.row_predicate_ast, columnMasks: body.column_masks, actor: scope.tenant.membershipId });
    await scope.audit({
      action: 'bi.policy_drafted',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: { dataset_id: created.datasetId, grantee_kind: created.granteeKind, grantee_ref_id: created.granteeRefId, revision: created.revision, hidden_columns: Object.keys(created.columnMasks).sort() },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'bi.policy.drafted.v1',
      schemaVersion: 1,
      payload: { policy_id: created.id, dataset_id: created.datasetId, grantee_kind: created.granteeKind, revision: created.revision },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'DRAFT', created.version, created.id), revision: created.revision };
  }

  @Get('bi/access-policies')
  @OperationId('listBiAccessPolicies')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('dataset_id') datasetId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    // The policies are the tenant's: who holds the right on a subtree only does not read them (the guard checks that the right is held, not over what).
    if (!holdsOnWholeTenant(access, PERMISSIONS.listBiAccessPolicies)) throw new DomainError('SCOPE_DENIED', 403);
    const request = parsePageRequest(limit, cursor);
    const dataset = datasetId === undefined ? undefined : asUuid(String(datasetId));
    if (datasetId !== undefined && dataset === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_id');
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const all = await this.database.withTenant(tenant, (tx) => this.policies.list(tx, { datasetId: dataset, status: status as string | undefined }));
    // The list is small (a policy per grantee and dataset) and ordered by dataset, grantee and revision: a page is cut from it by the id of the last row shown.
    const start = request.after === undefined ? 0 : all.findIndex((row) => row.id === request.after?.id) + 1;
    if (request.after !== undefined && start === 0) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const shown = all.slice(start, start + request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(policyView), next_cursor: start + request.limit < all.length && last !== undefined ? encodeCursor({ code: last.datasetId, id: last.id }) : null };
  }
}
