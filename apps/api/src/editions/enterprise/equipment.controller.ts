import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { EgpConnectionStore, EquipmentProcurementStore, TenantDatabase, projectScope } from '@machvon/db';
import type { EquipmentLine } from '@machvon/db';
import { DomainError, EQUIPMENT_STAGES, asUuid, equipmentDataGuide } from '@machvon/kernel';
import type { EffectiveAccess, EquipmentDataGuide, EquipmentStage, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const LINE_RESOURCE = 'equipment_procurement_item';
const CONTRACT_PERMISSION = 'contract.read';
const PAYMENT_PERMISSION = 'payment_request.read';
const MAX_REASON = 2000;

/** The line as the view shows it: an allowlist; money is a string of whole dong, and a figure the caller may not read is null and named in `masked`. */
export function equipmentLineView(line: EquipmentLine): Record<string, unknown> {
  return {
    id: line.id,
    code: line.code,
    name: line.name,
    plan_ref: line.planRef,
    status: line.status,
    source: line.source,
    stage: line.stage,
    project: line.project,
    owner_unit: line.ownerUnit,
    planned_value_vnd: line.plannedValueVnd,
    package: line.package === null ? null : { id: line.package.id, code: line.package.code, title: line.package.title, status: line.package.status, external_code: line.package.externalCode },
    selection: line.selection === null ? null : { outcome: line.selection.outcome, status: line.selection.status, award_price_vnd: line.selection.awardPriceVnd, winner_name: line.selection.winnerName },
    contract: line.contract,
    contract_value_vnd: line.contractValueVnd,
    plan_variance_vnd: line.planVarianceVnd,
    paid_vnd: line.paidVnd,
    disbursement_percent: line.disbursementPercent,
    masked: line.masked,
    external_link: line.externalLink === null ? null : { external_code: line.externalLink.externalCode, diff_status: line.externalLink.diffStatus },
    version: line.version,
  };
}

const guideView = (guide: EquipmentDataGuide): Record<string, unknown> => ({ state: guide.state, age_hours: guide.ageHours, layout_version: guide.layoutVersion, acceptance: guide.acceptance, steps: guide.steps });

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/**
 * The equipment procurement of the projects of the Ban Thuong mai (CN.02, EQP-01, EQP-02), enterprise edition only. The reads join BID, CTR and PAY in the scope of the caller over the project (one read path, eng-review R21); the contract value
 * and the payments are shown only to a caller who may read contracts and payments, else they are null and named in `masked`. "How to get the data" is the state of the file import of the national network (PENDING-EXTERNAL layout): the platform
 * opens no connection, a person downloads the files and hands them over.
 */
@Controller('equipment-procurement')
export class EquipmentReadsController {
  private readonly lines = new EquipmentProcurementStore();
  private readonly connection = new EgpConnectionStore();
  private readonly database: TenantDatabase;

  constructor(@Inject(TenantDatabase) database: TenantDatabase) {
    this.database = database;
  }

  private scopes(access: EffectiveAccess, now: Date) {
    return { read: projectScope(access, PERMISSIONS.listEquipmentProcurement, now), contract: projectScope(access, CONTRACT_PERMISSION, now), payment: projectScope(access, PAYMENT_PERMISSION, now) };
  }

  @Get()
  @OperationId('listEquipmentProcurement')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('stage') stage?: unknown,
    @Query('include_cancelled') includeCancelled?: unknown,
  ): Promise<Record<string, unknown>> {
    if (stage !== undefined && !(EQUIPMENT_STAGES as readonly unknown[]).includes(stage)) throw new DomainError('VALIDATION_FAILED', 422, 'stage');
    if (includeCancelled !== undefined && includeCancelled !== 'true' && includeCancelled !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'include_cancelled');
    const now = new Date();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const connection = await this.connection.current(tx);
      return {
        items: await this.lines.list(tx, this.scopes(access, now), {
          projectId: project === undefined ? undefined : idOf(project, 'project_id'),
          stage: stage as EquipmentStage | undefined,
          includeCancelled: includeCancelled === 'true',
        }),
        reading: await this.connection.health(tx, now, connection),
      };
    });
    return { items: found.items.map(equipmentLineView), data_guide: guideView(equipmentDataGuide(found.reading.view.health)), as_of: now.toISOString() };
  }

  @Get(':id')
  @OperationId('getEquipmentProcurement')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const connection = await this.connection.current(tx);
      return { line: await this.lines.get(tx, this.scopes(access, now), id), reading: await this.connection.health(tx, now, connection) };
    });
    // A line of a project outside the scope of the caller looks like one that does not exist.
    if (found.line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { line: equipmentLineView(found.line), data_guide: guideView(equipmentDataGuide(found.reading.view.health)), as_of: now.toISOString() };
  }
}

/** Making a line of the plan and linking the package and the contract it became; both need the right to manage the procurement plan over the project. */
@Controller('equipment-procurement')
export class EquipmentCommandsController {
  private readonly lines = new EquipmentProcurementStore();

  @Post()
  @HttpCode(200)
  @OperationId('createEquipmentProcurementItem')
  @Command({ operation: 'createEquipmentProcurementItem' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CreateEquipmentLine']): Promise<CommandResult> {
    const now = new Date();
    const made = await this.lines.create(scope.tx, projectScope(access, PERMISSIONS.createEquipmentProcurementItem, now), scope.tenant.membershipId, {
      projectId: idOf(body.project_id, 'project_id'),
      code: body.code.trim(),
      name: body.name.trim(),
      plannedValueVnd: body.planned_value_vnd,
      planRef: body.plan_ref?.trim() === '' ? undefined : body.plan_ref?.trim(),
      source: 'MANUAL',
      sourceRef: undefined,
    });
    await scope.audit({
      action: 'bid.equipment_line_created',
      resourceType: LINE_RESOURCE,
      resourceId: made.id,
      classification: 'INTERNAL',
      diff: { project_id: body.project_id, code: body.code.trim(), planned_value_vnd: body.planned_value_vnd },
    });
    return commandResult(scope, 'CREATED', made.version, made.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @OperationId('updateEquipmentProcurementItem')
  @Command({ operation: 'updateEquipmentProcurementItem', versioned: true })
  async update(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['UpdateEquipmentLine'],
  ): Promise<CommandResult> {
    if (body.cancel_reason !== undefined && (body.cancel_reason.trim().length < 5 || body.cancel_reason.length > MAX_REASON)) throw new DomainError('VALIDATION_FAILED', 422, 'cancel_reason');
    const changed = await this.lines.patch(scope.tx, projectScope(access, PERMISSIONS.updateEquipmentProcurementItem, new Date()), scope.tenant.membershipId, id, scope.expectedVersion ?? 0, {
      name: body.name?.trim(),
      planRef: body.plan_ref === undefined ? undefined : body.plan_ref === null || body.plan_ref.trim() === '' ? null : body.plan_ref.trim(),
      packageId: body.package_id === undefined ? undefined : idOf(body.package_id, 'package_id'),
      contractId: body.contract_id === undefined ? undefined : idOf(body.contract_id, 'contract_id'),
      cancelReason: body.cancel_reason?.trim(),
    });
    await scope.audit({
      action: 'bid.equipment_line_updated',
      resourceType: LINE_RESOURCE,
      resourceId: id,
      classification: 'INTERNAL',
      reason: body.cancel_reason,
      diff: {
        cancelled: body.cancel_reason !== undefined,
        from_package_id: changed.before.packageId,
        to_package_id: body.package_id ?? changed.before.packageId,
        from_contract_id: changed.before.contractId,
        to_contract_id: body.contract_id ?? changed.before.contractId,
        renamed: body.name !== undefined && body.name.trim() !== changed.before.name,
      },
    });
    return commandResult(scope, body.cancel_reason === undefined ? 'UPDATED' : 'CANCELLED', changed.version, id);
  }
}
