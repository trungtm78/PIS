import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { accessPolicyOf, archiveTenantState, offboardTenant, resumeTenant, suspendTenant } from '@machvon/db';
import type { StateChange } from '@machvon/db';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { TENANT_STATE_EFFECTS } from './tenant-state-effects';
import type { TenantStateEffects } from './tenant-state-effects';
import { TENANT_STATUS_CHANGED_EVENT } from './tenant-status-consumer';

const RESOURCE_TYPE = 'tenant';

type TenantLifecycleResult = Schemas['TenantLifecycleResult'];

/**
 * Suspending and resuming a tenant (ST-SAS-004, SAS-03): control-plane commands, permission `system.tenant.manage`, one
 * version-checked transition each. The audit row and the status event belong to the affected tenant and are written in
 * the transaction of the change; the caches of this process are dropped once it has committed.
 */
@Controller('system/tenants')
export class TenantStateController {
  constructor(@Optional() @Inject(TENANT_STATE_EFFECTS) private readonly effects?: TenantStateEffects) {}

  @Post(':tenantId/suspend')
  @HttpCode(200)
  @OperationId('suspendTenant')
  @Command({ operation: 'suspendTenant', plane: 'control', versioned: true })
  async suspend(
    @Scope() scope: CommandScope,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: Schemas['TenantSuspend'],
  ): Promise<TenantLifecycleResult> {
    const change = await suspendTenant(
      scope.tx,
      {
        tenantId,
        reasonCode: body.reason_code,
        accessPolicy: body.access_policy,
        expectedVersion: scope.expectedVersion ?? 0,
        restoreTenantId: scope.tenant.tenantId,
      },
      (changed) => this.record(scope, changed, 'tenant.suspended', body.reason, { reason_code: body.reason_code, access_policy: accessPolicyOf(body.reason_code) }),
    );
    return this.result(scope, change);
  }

  @Post(':tenantId/resume')
  @HttpCode(200)
  @OperationId('resumeTenant')
  @Command({ operation: 'resumeTenant', plane: 'control', versioned: true })
  async resume(
    @Scope() scope: CommandScope,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: Schemas['ReasonOnly'],
  ): Promise<TenantLifecycleResult> {
    const change = await resumeTenant(
      scope.tx,
      { tenantId, expectedVersion: scope.expectedVersion ?? 0, restoreTenantId: scope.tenant.tenantId },
      (changed) => this.record(scope, changed, 'tenant.resumed', body.reason, {}),
    );
    return this.result(scope, change);
  }

  /**
   * Starts the offboarding of an Active or Suspended tenant (ST-SAS-016, SAS-17): it becomes read-only and may export, for the window of days agreed from the end of its contract. The reminders to its owner (day 0, 30, 60 and
   * seven days before the window ends) are the notifications' (NOT-004..006); the event of the change is what they follow.
   */
  @Post(':tenantId/offboard')
  @HttpCode(202)
  @OperationId('startTenantOffboarding')
  @Command({ operation: 'startTenantOffboarding', plane: 'control', versioned: true })
  async offboard(
    @Scope() scope: CommandScope,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: Schemas['TenantOffboard'],
  ): Promise<TenantLifecycleResult> {
    const change = await offboardTenant(
      scope.tx,
      { tenantId, contractEndDate: body.contract_end_date, exportWindowDays: body.export_window_days, reason: body.reason, expectedVersion: scope.expectedVersion ?? 0, restoreTenantId: scope.tenant.tenantId },
      (changed) => this.record(scope, changed, 'tenant.offboarding_started', body.reason, { contract_end_date: body.contract_end_date, export_window_days: body.export_window_days, export_window_ends_at: changed.exportWindowEndsAt?.toISOString() }),
    );
    return this.result(scope, change);
  }

  /**
   * Archives an Offboarding tenant (ST-SAS-016): its people can no longer sign in. It needs an export that was Delivered or a window that has ended (409 EXPORT_NOT_CONFIRMED). The purge that follows keeps what a legal hold
   * holds (BR-PL): the archive does not delete anything itself.
   */
  @Post(':tenantId/archive')
  @HttpCode(200)
  @OperationId('archiveTenant')
  @Command({ operation: 'archiveTenant', plane: 'control', versioned: true })
  async archive(@Scope() scope: CommandScope, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: Schemas['ReasonOnly']): Promise<TenantLifecycleResult> {
    const change = await archiveTenantState(scope.tx, { tenantId, expectedVersion: scope.expectedVersion ?? 0, restoreTenantId: scope.tenant.tenantId }, (changed) =>
      this.record(scope, changed, 'tenant.archived', body.reason, {}),
    );
    return this.result(scope, change);
  }

  // The audit row and the event of the change, written while the transaction acts as the affected tenant.
  private async record(scope: CommandScope, change: StateChange, action: string, reason: string, extra: Record<string, unknown>): Promise<void> {
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: change.tenantId,
      reason,
      diff: { from: change.from, to: change.to, ...extra },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: change.tenantId,
      aggregateVersion: change.version,
      type: TENANT_STATUS_CHANGED_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: change.tenantId, from: change.from, to: change.to, ...(change.reasonCode === undefined ? {} : { reason_code: change.reasonCode }) },
      eventKey: `${RESOURCE_TYPE}:${change.tenantId}:status:${change.version}`,
    });
  }

  private result(scope: CommandScope, change: StateChange): TenantLifecycleResult {
    const effects = this.effects;
    if (effects !== undefined) scope.afterCommit(() => effects.invalidate(change.tenantId));
    return { tenant_id: change.tenantId, status: change.to, version: change.version };
  }
}
