import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidLinkReads, BidMilestoneStore, LINK_DIFF_STATUSES, TenantDatabase, projectScope } from '@machvon/db';
import type { LinkDiffStatus, LinkLine, ProcurementMilestoneLine } from '@machvon/db';
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

const MANAGE_PERMISSION = PERMISSIONS.recordProcurementMilestone;
const READ_PERMISSION = PERMISSIONS.listProcurementMilestones;
const PACKAGE_RESOURCE = 'procurement_package';

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** A milestone as the tracker reads it: an allowlist of what a milestone is. */
export function milestoneView(line: ProcurementMilestoneLine): Record<string, unknown> {
  return {
    id: line.id,
    package_id: line.packageId,
    milestone_kind: line.kind,
    planned_at: line.plannedAt,
    actual_at: line.actualAt,
    source: line.source,
    import_batch_id: line.importBatchId,
    version: line.version,
  };
}

/** A link as the reconciliation view reads it: the codes, the difference with its owner, and the import that last looked at it. */
export function linkView(line: LinkLine): Record<string, unknown> {
  return {
    id: line.id,
    package_id: line.packageId,
    package_code: line.packageCode,
    package_title: line.packageTitle,
    project: { id: line.project.id, code: line.project.code },
    external_system: line.externalSystem,
    external_code: line.externalCode,
    diff_status: line.diffStatus,
    diff: line.diff,
    diff_owner: line.diffOwner === null ? null : { membership_id: line.diffOwner.membershipId, display_name: line.diffOwner.displayName },
    batch:
      line.batch === null
        ? null
        : {
            id: line.batch.id,
            file_sha256: line.batch.fileSha256,
            adapter_status: line.batch.adapterStatus,
            applied_at: line.batch.appliedAt,
            rows_total: line.batch.rowsTotal,
            rows_ok: line.batch.rowsOk,
            rows_error: line.batch.rowsError,
          },
    version: line.version,
  };
}

/**
 * The milestones of the choice of a contractor (ST-BID-005, BID-17): a planner records the planned and the actual date of a milestone of a package, in the scope of
 * `bid.plan.manage`, under the version of the package they saw. The dates keep the order of the milestones (409 MILESTONE_ORDER_INVALID); a milestone that a file of the national
 * bidding system wrote becomes the planner's as soon as they record it, and a date that settles a difference with that file says so in its audit row.
 */
@Controller()
export class MilestoneController {
  private readonly milestones = new BidMilestoneStore();

  @Post('procurement-packages/:id/milestones')
  @HttpCode(200)
  @OperationId('recordProcurementMilestone')
  @Command({ operation: 'recordProcurementMilestone', versioned: true })
  async record(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['BidMilestone'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.milestones.record(
      scope.tx,
      {
        packageId: id.toLowerCase(),
        expectedVersion: scope.expectedVersion ?? 0,
        kind: body.milestone_kind,
        plannedAt: body.planned_at,
        actualAt: body.actual_at,
      },
      scope.tenant.membershipId,
      projectScope(access, MANAGE_PERMISSION, now),
      now,
    );
    await scope.audit({
      action: 'bid.milestone_recorded',
      resourceType: PACKAGE_RESOURCE,
      resourceId: done.packageId,
      diff: {
        package_code: done.packageCode,
        milestone_kind: done.kind,
        planned_at: done.plannedAt,
        actual_at: done.actualAt,
        source: done.source,
        previous: done.previous === null ? null : { planned_at: done.previous.plannedAt, actual_at: done.previous.actualAt, source: done.previous.source },
        settled_difference: done.settledDifference,
      },
    });
    await scope.emit({
      aggregateType: PACKAGE_RESOURCE,
      aggregateId: done.packageId,
      aggregateVersion: done.version,
      type: 'bid.milestone.recorded.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        package_id: done.packageId,
        project_id: done.projectId,
        milestone_kind: done.kind,
        planned_at: done.plannedAt,
        actual_at: done.actualAt,
        source: done.source,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${PACKAGE_RESOURCE}:${done.packageId}:${done.version}`,
    });
    return commandResult(scope, done.kind, done.version, done.packageId);
  }
}

/** The milestones and the links to the national bidding network, for reading (BID-17, BID-19), in the scope of `bid.read`. */
@Controller()
export class MilestoneReadsController {
  private readonly milestones = new BidMilestoneStore();
  private readonly links = new BidLinkReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('procurement-milestones')
  @OperationId('listProcurementMilestones')
  async listMilestones(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('package_id') pack?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const filter = { projectId: project === undefined ? undefined : idOf(project, 'project_id'), packageId: pack === undefined ? undefined : idOf(pack, 'package_id') };
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.milestones.list(tx, projectScope(access, READ_PERMISSION, now), filter));
    return { items: rows.map(milestoneView), as_of: now.toISOString() };
  }

  @Get('procurement-external-links')
  @OperationId('listProcurementExternalLinks')
  async listLinks(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('diff_status') status?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    if (status !== undefined && !(LINK_DIFF_STATUSES as readonly unknown[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'diff_status');
    const filter = { projectId: project === undefined ? undefined : idOf(project, 'project_id'), diffStatus: status as LinkDiffStatus | undefined };
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.links.list(tx, projectScope(access, PERMISSIONS.listProcurementExternalLinks, now), filter));
    return { items: rows.map(linkView), as_of: now.toISOString() };
  }
}
