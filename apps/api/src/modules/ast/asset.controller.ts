import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AstAssetStore, TenantDatabase, contractScope, handoverScope } from '@machvon/db';
import type { AstAssetResult, AstOmLinkResult, ContractScopes, HandoverScopes } from '@machvon/db';
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
import { assetView } from './asset-view';
import type { AssetPermissions } from './asset-view';

const MANAGE_PERMISSION = PERMISSIONS.registerAsset;
const TRANSFER_PERMISSION = PERMISSIONS.transferAsset;
const LINK_OM_PERMISSION = PERMISSIONS.linkOmPlan;
const READ_PERMISSION = PERMISSIONS.get_resources_asset_record;
const RESOURCE_TYPE = 'asset_record';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: AssetPermissions = { manage: MANAGE_PERMISSION, transfer: TRANSFER_PERMISSION, linkOm: LINK_OM_PERMISSION };

const contractScopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });
const scopesFor = (access: EffectiveAccess, permission: string, now: Date): HandoverScopes => ({ update: handoverScope(access, permission, now), read: handoverScope(access, READ_PERMISSION, now) });

/**
 * The assets a work produces (ST-AST-002, AST 3.2, BR-AST-02). The accountant registers an asset after the handover of its work was accepted (409 `HANDOVER_STATE_INVALID` before), with its value, the
 * basis of the value and the unit that receives it; the assets of a contract never add up to more than the contract is worth (422 `VALUE_EXCEEDS_CONTRACT`) and a code is used once in a project (409
 * `ASSET_CODE_DUPLICATE`). The receiving unit transfers it with the dossier of the commissioning, and types the code the asset has in the system of public assets, which is not connected.
 */
@Controller()
export class AssetController {
  private readonly assets = new AstAssetStore();

  @Post('asset-records')
  @HttpCode(200)
  @OperationId('registerAsset')
  @Command({ operation: 'registerAsset' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AstRegisterAsset']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.assets.register(
      scope.tx,
      {
        projectId: body.project_id,
        handoverId: body.handover_id,
        assetCode: body.asset_code,
        name: body.name,
        assetClassMasterVersionId: body.asset_class_master_version_id,
        sourceContractId: body.source_contract_id,
        recipientUnitId: body.recipient_unit_id,
        valueVnd: body.value_vnd,
        valueBasis: body.value_basis,
        fundingOrigin: body.funding_origin,
        warrantyUntil: body.warranty_until,
      },
      scope.tenant.membershipId,
      contractScopesFor(access, MANAGE_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'asset.registered', 'ast.asset.registered.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('asset-records/:id/transfer')
  @HttpCode(200)
  @OperationId('transferAsset')
  @Command({ operation: 'transferAsset', versioned: true })
  async transfer(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstTransferAsset']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.assets.transfer(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { transferredOn: body.transferred_on, commissioningDocumentVersionId: body.commissioning_document_version_id, externalAssetId: body.external_asset_id },
      scope.tenant.membershipId,
      scopesFor(access, TRANSFER_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'asset.transferred', 'ast.asset.transferred.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('asset-records/:id/om-link')
  @HttpCode(200)
  @OperationId('linkOmPlan')
  @Command({ operation: 'linkOmPlan' })
  async linkOm(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AstLinkOmPlan']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.assets.linkOm(
      scope.tx,
      id.toLowerCase(),
      {
        operatorUnitId: body.operator_unit_id,
        omPlanDocumentVersionId: body.om_plan_document_version_id,
        omContractId: body.om_contract_id,
        maintenanceCycleMonths: body.maintenance_cycle_months,
        nextMaintenanceDue: body.next_maintenance_due,
        externalSystemRef: body.external_system_ref,
      },
      scope.tenant.membershipId,
      scopesFor(access, LINK_OM_PERMISSION, now),
    );
    await this.linked(scope, done, now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a link: ids, the unit, the cycle and the day of the next maintenance; the reference to the other system is typed by hand and stays in the table. */
  private async linked(scope: CommandScope, done: AstOmLinkResult, now: Date): Promise<void> {
    const facts = {
      asset_id: done.assetId,
      asset_code: done.assetCode,
      project_id: done.projectId,
      contract_id: done.contractId,
      operator_unit_id: done.operatorUnitId,
      om_plan_document_version_id: done.omPlanDocumentVersionId,
      om_contract_id: done.omContractId,
      maintenance_cycle_months: done.maintenanceCycleMonths,
      next_maintenance_due: done.nextMaintenanceDue,
    };
    await scope.audit({ action: 'asset.om_linked', resourceType: 'om_link', resourceId: done.id, classification: CLASSIFICATION, diff: { status: done.status, ...facts } });
    await scope.emit({
      aggregateType: 'om_link',
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'ast.om_link.linked.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, om_link_id: done.id, ...facts, status: done.status, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `om_link:${done.id}:${done.version}`,
    });
  }

  /** The audit row and the event of a command: ids, codes, statuses and the figures of the asset and of the contract it is booked under; the code of the asset in another system is an identifier, not a word. */
  private async written(scope: CommandScope, done: AstAssetResult, action: string, type: string, now: Date): Promise<void> {
    const facts = {
      asset_code: done.assetCode,
      handover_id: done.handoverId,
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      recipient_unit_id: done.recipientUnitId,
      value_vnd: done.valueVnd,
      value_basis: done.valueBasis,
      contract_value_vnd: done.contractValueVnd,
      registered_total_vnd: done.registeredTotalVnd,
      transferred_on: done.transferredOn,
      external_asset_id: done.externalAssetId,
    };
    await scope.audit({ action, resourceType: RESOURCE_TYPE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_status: done.fromStatus, to_status: done.status, ...facts } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, asset_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}

const idFilter = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** The assets in the scope of the caller (the right to read them is `asset_record.read`; the value is shown to whoever registers or transfers assets). */
@Controller('resources/asset_record')
export class AssetReadsController {
  private readonly assets = new AstAssetStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_asset_record')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('handover_id') handoverId?: unknown,
    @Query('status') status?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const filter = { contractId: idFilter(contractId, 'contract_id'), handoverId: idFilter(handoverId, 'handover_id'), status, limit: request.limit + 1, after: request.after };
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.assets.list(tx, handoverScope(access, READ_PERMISSION, now), filter));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => assetView(line, access, now, ACTION_PERMISSIONS)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_asset_record_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const line = await this.database.withTenant(tenant, (tx) => this.assets.find(tx, id.toLowerCase(), handoverScope(access, READ_PERMISSION, now)));
    // An asset in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return assetView(line, access, now, ACTION_PERMISSIONS);
  }
}
