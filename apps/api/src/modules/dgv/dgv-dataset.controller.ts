import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { DATASET_CLASSIFICATIONS, DgvDatasetStore, TenantDatabase } from '@machvon/db';
import type { DatasetClassification, DatasetRow, DatasetViewer } from '@machvon/db';
import type { AuditClassification } from '@machvon/db';
import { DomainError, activeGrants, asUuid } from '@machvon/kernel';
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
import { textOf } from './inputs';

const DATASET_RESOURCE = 'dataset';
const CLASSIFICATIONS: ReadonlySet<string> = new Set(DATASET_CLASSIFICATIONS);

/** The audit trail has four classes; the fifth class of a dataset (important core data) is recorded as CONFIDENTIAL, the highest it has. */
function auditClassificationOf(classification: DatasetClassification): AuditClassification {
  return classification === 'IMPORTANT_CORE' ? 'CONFIDENTIAL' : classification;
}

/** The viewer of a request: the person and the roles of the grants in force, whatever their scope (a dataset belongs to no organisation unit). */
function viewerOf(tenant: TenantContext, access: EffectiveAccess): DatasetViewer {
  return { membershipId: tenant.membershipId, roleCodes: [...new Set(activeGrants(access, new Date()).map((grant) => grant.roleCode))] };
}

function memberOf(value: string, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

function datasetViewOf(row: DatasetRow): Record<string, unknown> {
  return {
    id: row.id,
    dataset_code: row.datasetCode,
    title: row.title,
    domain: row.domain,
    grain: row.grain,
    producer_module: row.producerModule,
    owner_user_id: row.ownerId,
    owner_name: row.ownerName,
    steward_user_id: row.stewardId,
    steward_name: row.stewardName,
    classification: row.classification,
    is_critical: row.isCritical,
    freshness_slo_seconds: row.freshnessSloSeconds,
    contract_revision: row.contractRevision,
    status: row.status,
    quality_badge: row.qualityBadge,
    version: row.version,
  };
}

/**
 * The commands of the dataset catalogue (ST-DGV-001, DGV 3.1 F1): a dataset is registered in DRAFT with an owner and a steward who are two
 * people when the dataset is critical, and its owner and steward are changed for a stated reason against the version the person read.
 */
@Controller()
export class DgvDatasetController {
  private readonly datasets = new DgvDatasetStore();

  @Post('dgv/datasets')
  @HttpCode(200)
  @OperationId('registerDataset')
  @Command({ operation: 'registerDataset' })
  async register(@Scope() scope: CommandScope, @Body() body: Schemas['DgvDatasetRegister']): Promise<CommandResult> {
    const ownerId = memberOf(body.owner_user_id, 'owner_user_id');
    const stewardId = memberOf(body.steward_user_id, 'steward_user_id');
    const retentionPolicyId = body.retention_policy_id === undefined ? undefined : memberOf(body.retention_policy_id, 'retention_policy_id');
    const created = await this.datasets.register(
      scope.tx,
      {
        datasetCode: body.dataset_code,
        title: body.title,
        domain: body.domain,
        grain: body.grain,
        producerModule: body.producer_module,
        ownerId,
        stewardId,
        classification: body.classification,
        isCritical: body.is_critical,
        freshnessSloSeconds: body.freshness_slo_seconds,
        retentionPolicyId,
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'dgv.dataset_registered',
      resourceType: DATASET_RESOURCE,
      resourceId: created.id,
      classification: auditClassificationOf(body.classification),
      diff: {
        dataset_code: body.dataset_code,
        domain: body.domain,
        producer_module: body.producer_module,
        classification: body.classification,
        is_critical: body.is_critical,
        owner_user_id: ownerId,
        steward_user_id: stewardId,
      },
    });
    await scope.emit({
      aggregateType: DATASET_RESOURCE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'dgv.dataset.registered.v1',
      schemaVersion: 1,
      payload: { dataset_id: created.id, dataset_code: body.dataset_code, domain: body.domain, classification: body.classification, is_critical: body.is_critical },
      eventKey: `${DATASET_RESOURCE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, 'DRAFT', created.version, created.id);
  }

  @Post('dgv/datasets/:id/ownership')
  @HttpCode(200)
  @OperationId('assignDatasetOwnership')
  @Command({ operation: 'assignDatasetOwnership', versioned: true })
  async assignOwnership(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DgvOwnership'],
  ): Promise<CommandResult> {
    const change = { ownerId: memberOf(body.owner_user_id, 'owner_user_id'), stewardId: memberOf(body.steward_user_id, 'steward_user_id') };
    const done = await this.datasets.assignOwnership(scope.tx, id, scope.expectedVersion ?? 0, change, viewerOf(scope.tenant, access));
    await scope.audit({
      action: 'dgv.dataset_ownership_changed',
      resourceType: DATASET_RESOURCE,
      resourceId: id,
      reason: body.reason,
      diff: { before: { owner_user_id: done.before.ownerId, steward_user_id: done.before.stewardId }, after: { owner_user_id: change.ownerId, steward_user_id: change.stewardId }, is_critical: done.isCritical },
    });
    await scope.emit({
      aggregateType: DATASET_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'dgv.dataset.ownership_changed.v1',
      schemaVersion: 1,
      payload: { dataset_id: id, owner_user_id: change.ownerId, steward_user_id: change.stewardId, previous_owner_user_id: done.before.ownerId, previous_steward_user_id: done.before.stewardId },
      eventKey: `${DATASET_RESOURCE}:${id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, id);
  }
}

/** The search of the catalogue (DGV-04): the datasets that the caller's roles and the classification allow, never a count of the rest. */
@Controller()
export class DgvCatalogController {
  private readonly datasets = new DgvDatasetStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('dgv/catalog')
  @OperationId('searchCatalog')
  async search(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('q') q?: unknown,
    @Query('domain') domain?: unknown,
    @Query('classification') classification?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; total: number; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (classification !== undefined && (typeof classification !== 'string' || !CLASSIFICATIONS.has(classification))) throw new DomainError('VALIDATION_FAILED', 422, 'classification');
    const filter = { query: textOf(q, 'q'), domain: textOf(domain, 'domain'), classification: classification as DatasetClassification | undefined };
    const viewer = viewerOf(tenant, access);
    const { rows, total } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.datasets.search(tx, viewer, filter, { limit: request.limit + 1, after: request.after }),
      total: await this.datasets.count(tx, viewer, filter),
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(datasetViewOf),
      total,
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.datasetCode, id: last.id }) : null,
    };
  }
}
