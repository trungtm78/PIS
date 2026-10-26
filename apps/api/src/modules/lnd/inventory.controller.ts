import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndInventoryStore, TenantDatabase, householdScopeUnits } from '@machvon/db';
import type { InventoryLine } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
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

const PROCESS_PERMISSION = PERMISSIONS.recordInventory;
const READ_PERMISSION = PERMISSIONS.listInventoryRecords;
const RESOURCE_TYPE = 'land_inventory_record';
const CLASSIFICATION = 'PERSONAL';

/** A record as the screen reads it: an allowlist of what a record is. What is counted at a household is read only inside the unit of the household. */
export function inventoryLineView(line: InventoryLine): Record<string, unknown> {
  return {
    id: line.id,
    household_id: line.householdId,
    household_code: line.householdCode,
    parcel_id: line.parcelId,
    parcel_code: line.parcelCode,
    owner_unit_id: line.ownerUnitId,
    item_kind: line.itemKind,
    description: line.description,
    quantity: line.quantity,
    unit_code: line.unitCode,
    unit_price_vnd: line.unitPriceVnd,
    amount_vnd: line.amountVnd,
    price_decision_ref: line.priceDecisionRef,
    price_decision_revision: line.priceDecisionRevision,
    surveyed_on: line.surveyedOn,
    surveyed_by: line.surveyedBy,
    household_confirmed_on: line.householdConfirmedOn,
    household_dispute: line.householdDispute,
    confirmed_by: line.confirmedBy,
    note: line.note,
    evidence_photo_id: line.evidencePhotoId,
    document_version_id: line.documentVersionId,
    status: line.status,
    version: line.version,
  };
}

/**
 * The inventory of the assets of the affected households (ST-LND-004, LND 3.2, BR-LND-04, UAT-AC382, UAT-PLAN-29). A record is counted by an officer of the unit of the household at the unit price of a decision
 * on land prices that was in force on the day of the survey, and is a DRAFT until the household has answered and someone else has recorded the answer. The trail and the events carry ids, the kind, the
 * quantity, the price and the amount; the description of what is counted and the note of an objection stay in the record.
 */
@Controller()
export class LandInventoryController {
  private readonly inventory = new LndInventoryStore();

  @Post('land-inventory-records')
  @HttpCode(200)
  @OperationId('recordInventory')
  @Command({ operation: 'recordInventory' })
  async record(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndRecordInventory']): Promise<CommandResult> {
    const now = new Date();
    const units = await householdScopeUnits(scope.tx, access, PROCESS_PERMISSION, now);
    const created = await this.inventory.record(
      scope.tx,
      {
        householdId: body.household_id,
        parcelId: body.parcel_id,
        itemKind: body.item_kind,
        description: body.description,
        quantity: body.quantity,
        unitCode: body.unit_code,
        unitPriceVnd: body.unit_price_vnd,
        priceDecisionRef: body.price_decision_ref,
        surveyedOn: body.surveyed_on,
        evidencePhotoId: body.evidence_photo_id,
        documentVersionId: body.document_version_id,
      },
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'lnd.inventory_recorded',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: CLASSIFICATION,
      diff: {
        household_id: created.householdId,
        parcel_id: created.parcelId,
        project_id: created.projectId,
        owner_unit_id: created.ownerUnitId,
        item_kind: created.itemKind,
        quantity: created.quantity,
        unit_code: created.unitCode,
        unit_price_vnd: created.unitPriceVnd,
        amount_vnd: created.amountVnd,
        price_decision_ref: created.priceDecisionRef,
        price_decision_version_id: created.priceDecisionVersionId,
        price_decision_revision: created.priceDecisionRevision,
        surveyed_on: created.surveyedOn,
        status: created.status,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'lnd.inventory.recorded.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        inventory_id: created.id,
        household_id: created.householdId,
        parcel_id: created.parcelId,
        project_id: created.projectId,
        owner_unit_id: created.ownerUnitId,
        item_kind: created.itemKind,
        amount_vnd: created.amountVnd,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('land-inventory-records/:id/confirm')
  @HttpCode(200)
  @OperationId('confirmInventory')
  @Command({ operation: 'confirmInventory', versioned: true })
  async confirm(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndConfirmInventory'],
  ): Promise<CommandResult> {
    const now = new Date();
    const units = await householdScopeUnits(scope.tx, access, PROCESS_PERMISSION, now);
    const done = await this.inventory.confirm(
      scope.tx,
      id,
      { outcome: body.outcome, householdConfirmedOn: body.household_confirmed_on, note: body.note },
      scope.expectedVersion ?? 0,
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'lnd.inventory_confirmed',
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: {
        household_id: done.householdId,
        parcel_id: done.parcelId,
        project_id: done.projectId,
        owner_unit_id: done.ownerUnitId,
        outcome: done.outcome,
        amount_vnd: done.amountVnd,
        household_confirmed_on: done.householdConfirmedOn,
        household_status: done.householdStatus,
        household_moved: done.householdMoved,
        parcel_moved: done.parcelMoved,
        status: done.status,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: 'lnd.inventory.confirmed.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        inventory_id: done.id,
        household_id: done.householdId,
        parcel_id: done.parcelId,
        project_id: done.projectId,
        owner_unit_id: done.ownerUnitId,
        outcome: done.outcome,
        amount_vnd: done.amountVnd,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }
}

/** The records of a household (LND-04), inside the unit of the household. */
@Controller()
export class LandInventoryReadsController {
  private readonly inventory = new LndInventoryStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('land-inventory-records')
  @OperationId('listInventoryRecords')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('household_id') household?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const householdId = typeof household === 'string' ? asUuid(household) : undefined;
    if (householdId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'household_id');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      const units = await householdScopeUnits(tx, access, READ_PERMISSION, now);
      return this.inventory.list(tx, units, { householdId, status: typeof status === 'string' ? status : undefined, limit: request.limit + 1, after: request.after });
    });
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(inventoryLineView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.parcelCode, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
