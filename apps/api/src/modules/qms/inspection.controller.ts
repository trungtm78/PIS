import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { QmsInspectionStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, QmsInspectionResult } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { inspectionActionsOf, inspectionView } from './inspection-view';
import type { InspectionPermissions } from './inspection-view';

const REQUEST_PERMISSION = PERMISSIONS.requestInspection;
const MANAGE_PERMISSION = PERMISSIONS.scheduleInspection;
const RECORD_PERMISSION = PERMISSIONS.recordInspectionResult;
const CANCEL_PERMISSION = PERMISSIONS.cancelInspection;
const READ_PERMISSION = PERMISSIONS.listInspections;
const RESOURCE_TYPE = 'inspection';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: InspectionPermissions = { manage: MANAGE_PERMISSION, record: RECORD_PERMISSION };

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * The inspections of work under a contract (ST-QMS-004, QMS 3.2). A contractor (a guest, in its own contract) or the supervisor asks for an inspection on a contract that is being performed;
 * a construction contract waits for the permits of the start of construction (422 `PERMIT_GATE_BLOCKED`). The regime in force on the day of the request gives the inspection its checklist and the
 * roles that will sign its minutes, with a warning while the regime waits for its confirmation; the supervisor schedules it with the people who take part and records its result against the
 * checklist (422 `CHECKLIST_INCOMPLETE`). A recorded inspection is kept as it is.
 */
@Controller()
export class InspectionController {
  private readonly inspections = new QmsInspectionStore();

  @Post('inspections')
  @HttpCode(200)
  @OperationId('requestInspection')
  @Command({ operation: 'requestInspection' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['QmsRequestInspection']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.inspections.request(
      scope.tx,
      { contractId: body.contract_id, boqItemId: body.boq_item_id, inspectionType: body.inspection_type, title: body.title, locationText: body.location_text, requestedFor: body.requested_for, siteDiaryId: body.site_diary_id },
      scope.tenant.membershipId,
      scopesFor(access, REQUEST_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'inspection.requested', 'qms.inspection.requested.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('inspections/:id/schedule')
  @HttpCode(200)
  @OperationId('scheduleInspection')
  @Command({ operation: 'scheduleInspection', versioned: true })
  async schedule(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsScheduleInspection']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.inspections.schedule(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { scheduledAt: body.scheduled_at, participantMembershipIds: body.participant_membership_ids },
      scope.tenant.membershipId,
      scopesFor(access, MANAGE_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'inspection.scheduled', 'qms.inspection.scheduled.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('inspections/:id/result')
  @HttpCode(200)
  @OperationId('recordInspectionResult')
  @Command({ operation: 'recordInspectionResult', versioned: true })
  async record(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsRecordInspectionResult']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.inspections.record(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { result: body.result, resultNote: body.result_note, checklist: body.checklist },
      scope.tenant.membershipId,
      scopesFor(access, RECORD_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'inspection.result_recorded', 'qms.inspection.result_recorded.v1', now, body.result_note);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('inspections/:id/cancel')
  @HttpCode(200)
  @OperationId('cancelInspection')
  @Command({ operation: 'cancelInspection', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsCancelInspection']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.inspections.cancel(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, CANCEL_PERMISSION, now), now);
    await this.written(scope, done, 'inspection.cancelled', 'qms.inspection.cancelled.v1', now, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, codes, dates, statuses and the codes of the items that failed, never the words of a note beyond the audit row that keeps them. */
  private async written(scope: CommandScope, done: QmsInspectionResult, action: string, type: string, now: Date, reason?: string): Promise<void> {
    const facts = {
      inspection_no: done.inspectionNo,
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      boq_item_id: done.boqItemId,
      inspection_type: done.inspectionType,
      requested_for: done.requestedFor,
      regime_rule_version_id: done.regimeRuleVersionId,
      required_roles: done.requiredRoles,
      regime_awaiting_confirmation: done.regimeAwaitingConfirmation,
      scheduled_at: done.scheduledAt,
      participant_membership_ids: done.participantMembershipIds,
      result: done.result,
      failed_item_codes: done.failedItemCodes,
    };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, inspection_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}

/** The inspections of the contracts in the scope of the caller (the right to read them is `inspection.read`; a guest contractor holds it over its own contract). */
@Controller('inspections')
export class InspectionReadsController {
  private readonly inspections = new QmsInspectionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listInspections')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('contract_id') contractId?: unknown): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const filter = contractId === undefined ? undefined : typeof contractId === 'string' ? asUuid(contractId) : undefined;
    if (contractId !== undefined && filter === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    const now = new Date();
    const lines = await this.database.withTenant(tenant, (tx) => this.inspections.list(tx, contractScope(access, READ_PERMISSION, now), { contractId: filter?.toLowerCase() }));
    return { items: lines.map((line) => inspectionView(line, inspectionActionsOf(line, access, now, ACTION_PERMISSIONS))), as_of: now.toISOString() };
  }

  @Get(':id')
  @OperationId('getInspection')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const line = await this.database.withTenant(tenant, (tx) => this.inspections.find(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now)));
    // An inspection in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return inspectionView(line, inspectionActionsOf(line, access, now, ACTION_PERMISSIONS));
  }
}
