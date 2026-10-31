import { Body, Controller, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { ControlDatabase, FeatureFlagStore, PLATFORM_TENANT_ID } from '@machvon/db';
import type { FlagChange, FlagRow } from '@machvon/db';
import { DomainError, assertFlagUpdate } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';

const RESOURCE_TYPE = 'feature_flag';
export const FLAG_CHANGED_EVENT = 'sas.feature_flag.changed.v1';
const FLAG_KEY = /^[a-z][a-z0-9_.]{2,63}$/;

/** The flag as the contract exposes it: an allowlist. */
export function flagView(flag: FlagRow): Record<string, unknown> {
  return {
    flag_key: flag.key,
    description: flag.description,
    status: flag.status,
    rollout: { tenant_cohorts: flag.rollout.cohorts, tenant_ids: flag.rollout.tenantIds, percentage: flag.rollout.percentage },
    revision: flag.revision,
    version: flag.version,
    updated_by: flag.updatedBy,
    updated_at: flag.updatedAt,
  };
}

/** What the audit row and the event say of a change of a flag: where it was and where it went; nothing of a person. */
const changeOf = (change: FlagChange): Record<string, unknown> => ({
  flag_key: change.after.key,
  from_status: change.before.status,
  to_status: change.after.status,
  revision: change.after.revision,
  cohorts: change.after.rollout.cohorts,
  tenant_count: change.after.rollout.tenantIds.length,
  percentage: change.after.rollout.percentage,
});

/**
 * The release flags (ST-SAS-020, SAS 3.11, SAS-20): control plane only, permission `system.release.manage`. A flag decides the code path a tenant runs while a release is staged (`Off`, `Rollout` to cohorts, tenants or a
 * share, `On`, or `Retired`, which is final); it never grants an entitlement. The flags are declared in the code, so a flag is changed under the version it was read at and is never added here.
 */
@Controller('system/feature-flags')
export class FeatureFlagController {
  private readonly flags = new FeatureFlagStore();

  constructor(@Inject(ControlDatabase) private readonly control: ControlDatabase) {}

  @Get()
  @OperationId('listFeatureFlags')
  async list(): Promise<{ items: Array<Record<string, unknown>> }> {
    const flags = await this.control.withTenantOf(PLATFORM_TENANT_ID, (tx) => this.flags.list(tx));
    return { items: flags.map(flagView) };
  }

  @Put(':flagKey')
  @HttpCode(200)
  @OperationId('updateFeatureFlag')
  @Command({ operation: 'updateFeatureFlag', plane: 'control', versioned: true })
  async update(@Scope() scope: CommandScope, @Param('flagKey') flagKey: string, @Body() body: Schemas['FeatureFlagUpdate']): Promise<CommandResult> {
    if (!FLAG_KEY.test(flagKey)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const update = assertFlagUpdate(body);
    const change = await this.flags.update(scope.tx, { key: flagKey, expectedVersion: scope.expectedVersion ?? 0, update, actor: scope.tenant.membershipId });
    await scope.audit({ action: 'feature_flag.updated', resourceType: RESOURCE_TYPE, resourceId: change.after.id, reason: update.reason, diff: changeOf(change) });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: change.after.id,
      aggregateVersion: change.after.version,
      type: FLAG_CHANGED_EVENT,
      schemaVersion: 1,
      payload: changeOf(change),
      eventKey: `${RESOURCE_TYPE}:${change.after.id}:${change.after.version}`,
    });
    return commandResult(scope, change.after.status, change.after.version, change.after.id);
  }
}
