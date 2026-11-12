import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ExportDatasetStore, TenantDatabase } from '@machvon/db';
import { DomainError, asUuid, biDatasetsOfEdition, egpReasonOf, isBiDatasetOfEdition, resolveEdition } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { exportDatasetDto, productChoiceDto } from './int-view';

const DATASET_RESOURCE = 'int_export_dataset';

/**
 * The certified datasets a tenant lets out (INT-04): switched on or off with a reason. A dataset can be switched on only for a data product that is CERTIFIED now; once on, it is judged against the certification at
 * every read (API and BI), so a revocation in DGV closes it for readers without anyone switching it off.
 */
@Controller()
export class ExportDatasetController {
  private readonly datasets = new ExportDatasetStore();

  @Post('int/export-datasets/state')
  @HttpCode(200)
  @OperationId('setExportDataset')
  @Command({ operation: 'setExportDataset', versioned: true })
  async set(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['ExportDatasetSet']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.setExportDataset)) throw new DomainError('SCOPE_DENIED', 403);
    const edition = resolveEdition(process.env);
    if (!isBiDatasetOfEdition(body.dataset_code, edition)) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_code');
    if (typeof body.enabled !== 'boolean') throw new DomainError('VALIDATION_FAILED', 422, 'enabled');
    const productId = body.product_id === undefined ? null : (asUuid(body.product_id) ?? null);
    if (body.product_id !== undefined && productId === null) throw new DomainError('VALIDATION_FAILED', 422, 'product_id');
    const reason = egpReasonOf(body.reason);
    const now = new Date();
    const done = await this.datasets.set(scope.tx, body.dataset_code, scope.expectedVersion ?? 0, { enabled: body.enabled, productId, reason }, scope.tenant.membershipId, now, biDatasetsOfEdition(edition));
    const id = done.row.id as string;
    await scope.audit({
      action: 'int.export_dataset_set',
      resourceType: DATASET_RESOURCE,
      resourceId: id,
      classification: 'CONFIDENTIAL',
      reason,
      diff: { dataset_code: body.dataset_code, from_enabled: done.before.enabled, to_enabled: done.row.enabled, product_code: done.row.productCode, certification: done.row.certification },
    });
    await scope.emit({
      aggregateType: DATASET_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.row.version,
      type: 'int.export_dataset.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, dataset_id: id, dataset_code: body.dataset_code, enabled: done.row.enabled, version: done.row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${DATASET_RESOURCE}:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.enabled ? 'ENABLED' : 'DISABLED', done.row.version, id);
  }
}

@Controller()
export class ExportDatasetReadsController {
  private readonly datasets = new ExportDatasetStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('int/export-datasets')
  @OperationId('listExportDatasets')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listExportDatasets)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const maySet = holdsOnWholeTenant(access, PERMISSIONS.setExportDataset);
    return this.database.withTenant(tenant, async (tx) => ({
      items: (await this.datasets.state(tx, now, biDatasetsOfEdition(resolveEdition(process.env)))).map((row) => exportDatasetDto(row, maySet)),
      products: (await this.datasets.products(tx)).map(productChoiceDto),
      as_of: now.toISOString(),
    }));
  }
}
