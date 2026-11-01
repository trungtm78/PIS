import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { BiDashboardShareStore, BiDashboardStore } from '@machvon/db';
import type { ShareRow } from '@machvon/db';
import { DomainError, asUuid, versionConflict } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';

const RESOURCE_TYPE = 'dashboard_share';

const eventPayload = (scope: CommandScope, row: ShareRow): Record<string, unknown> => ({
  tenant_id: scope.tenant.tenantId,
  dashboard_id: row.dashboardId,
  share_id: row.id,
  grantee_kind: row.granteeKind,
  grantee_ref_id: row.granteeRefId,
  permission: row.permission,
  actor_id: scope.tenant.membershipId,
  occurred_at: new Date().toISOString(),
});

/**
 * The shares of a dashboard (ST-BI-007, BI 3 F6): the owner gives a person, a role or a unit the right to see the layout, or to change it, and takes it back at once. A share gives no data: what the figures show is judged
 * for the reader when they are asked for, so a person with a share and a narrower scope sees the layout and their own figures only. Only the owner shares and revokes.
 */
@Controller()
export class DashboardShareController {
  private readonly shares = new BiDashboardShareStore();
  private readonly dashboards = new BiDashboardStore();

  @Post('bi/dashboards/:id/shares')
  @HttpCode(200)
  @OperationId('shareDashboard')
  @Command({ operation: 'shareDashboard', versioned: true })
  async share(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BiShare']): Promise<CommandResult & { dashboard_version: number }> {
    const actor = scope.tenant.membershipId;
    const dashboard = await this.dashboards.lock(scope.tx, id.toLowerCase());
    // A dashboard that is not the caller's and not in the library is as good as none; one they see and do not own is not theirs to share.
    const seen = dashboard === undefined ? undefined : await this.dashboards.find(scope.tx, dashboard.id, actor);
    if (dashboard === undefined || seen === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (dashboard.version !== scope.expectedVersion) throw versionConflict(dashboard.version);
    if (seen.permission !== 'OWNER') throw new DomainError('SCOPE_DENIED', 403);
    if (dashboard.status === 'ARCHIVED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const granteeRefId = asUuid(body.grantee_ref_id);
    if (granteeRefId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'grantee_ref_id');
    if (body.grantee_kind === 'USER' && granteeRefId === dashboard.ownerUserId) throw new DomainError('VALIDATION_FAILED', 422, 'grantee_ref_id');
    // The person, the role or the unit is one of this tenant: what is another's is not seen from here, so it is out of the tenant whatever it is.
    if (!(await this.shares.granteeExists(scope.tx, body.grantee_kind, granteeRefId))) throw new DomainError('GRANTEE_OUT_OF_TENANT', 422, 'grantee_ref_id');
    const created = await this.shares.create(scope.tx, { dashboardId: dashboard.id, kind: body.grantee_kind, granteeRefId, permission: body.permission, actor });
    await this.dashboards.markShared(scope.tx, dashboard.id, true, actor);
    await scope.audit({
      action: 'bi.dashboard.share',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: { dashboard_id: dashboard.id, grantee_kind: created.granteeKind, grantee_ref_id: created.granteeRefId, permission: created.permission },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'bi.dashboard.shared.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, created),
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, created.status, created.version, created.id), dashboard_version: dashboard.version + 1 };
  }

  @Post('bi/dashboard-shares/:id/revocation')
  @HttpCode(200)
  @OperationId('revokeDashboardShare')
  @Command({ operation: 'revokeDashboardShare', versioned: true })
  async revoke(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult & { dashboard_version: number }> {
    const actor = scope.tenant.membershipId;
    const named = await this.shares.find(scope.tx, id.toLowerCase());
    if (named === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The dashboard is locked before the share, as sharing locks it.
    const dashboard = await this.dashboards.lock(scope.tx, named.dashboardId);
    const seen = dashboard === undefined ? undefined : await this.dashboards.find(scope.tx, named.dashboardId, actor);
    if (dashboard === undefined || seen === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (seen.permission !== 'OWNER') throw new DomainError('SCOPE_DENIED', 403);
    const held = await this.shares.lock(scope.tx, named.id);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (held.version !== scope.expectedVersion) throw versionConflict(held.version);
    const revoked = await this.shares.revoke(scope.tx, held.id, actor);
    await this.dashboards.markShared(scope.tx, dashboard.id, (await this.shares.activeCount(scope.tx, dashboard.id)) > 0, actor);
    await scope.audit({
      action: 'bi.dashboard.share_revoke',
      resourceType: RESOURCE_TYPE,
      resourceId: revoked.id,
      diff: { dashboard_id: dashboard.id, grantee_kind: revoked.granteeKind, grantee_ref_id: revoked.granteeRefId, permission: revoked.permission },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: revoked.id,
      aggregateVersion: revoked.version,
      type: 'bi.dashboard.share_revoked.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, revoked),
      eventKey: `${RESOURCE_TYPE}:${revoked.id}:${revoked.version}`,
    });
    return { ...commandResult(scope, revoked.status, revoked.version, revoked.id), dashboard_version: dashboard.version + 1 };
  }
}
