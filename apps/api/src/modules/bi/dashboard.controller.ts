import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { BiDashboardShareStore, BiDashboardStore, BiPublicationStore, TenantDatabase } from '@machvon/db';
import type { ShareRow } from '@machvon/db';
import type { DashboardRecord, DashboardVersionRecord } from '@machvon/db';
import { DomainError, parseDashboardDraft, versionConflict } from '@machvon/kernel';
import type { SignOffBlock, SignOffEntry, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const RESOURCE_TYPE = 'dashboard';
const STATUSES: readonly string[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

export const dashboardView = (record: DashboardRecord, viewer: string): Record<string, unknown> => ({
  id: record.id,
  code: record.code,
  title: record.title,
  owner: { id: record.ownerUserId, name: record.ownerName },
  audience: record.audience,
  status: record.status,
  current_version:
    record.current === null
      ? null
      : { id: record.currentVersionId, revision: record.current.revision, status: record.current.status, metric_count: record.current.metricCount, metrics_certified: record.current.allCertified },
  mine: record.ownerUserId === viewer,
  // The owner, and a person the dashboard is shared with to change, change it; one it is shared with to see, or that is in the library, reads it.
  permission: record.permission,
  may_edit: record.permission === 'OWNER' || record.permission === 'EDIT',
  created_at: record.createdAt,
  updated_at: record.updatedAt,
  version: record.version,
});

export const shareView = (row: ShareRow): Record<string, unknown> => ({
  id: row.id,
  dashboard_id: row.dashboardId,
  grantee_kind: row.granteeKind,
  grantee_ref_id: row.granteeRefId,
  grantee_name: row.granteeName,
  permission: row.permission,
  status: row.status,
  revoked_at: row.revokedAt,
  created_at: row.createdAt,
  created_by: row.createdBy,
  version: row.version,
});

const signatureView = (entry: SignOffEntry | null): Record<string, unknown> | null => (entry === null ? null : { id: entry.id, name: entry.name, at: entry.at });

/** The block of three signatures of a version (BC.02): who prepared it, who checked it, who approved it; a step nobody took is null, and `complete` says all three signed. */
export const signOffView = (block: SignOffBlock): Record<string, unknown> => ({
  version_id: block.versionId,
  revision: block.revision,
  prepared_by: signatureView(block.prepared),
  checked_by: signatureView(block.checked),
  approved_by: signatureView(block.approved),
  state: block.state,
  complete: block.complete,
});

export const versionView = (record: DashboardVersionRecord, signOff?: SignOffBlock): Record<string, unknown> => ({
  id: record.id,
  dashboard_id: record.dashboardId,
  revision: record.revision,
  layout_json: record.layout,
  metric_versions: record.metricVersionIds,
  filter_mappings: record.filterMappings,
  breakpoints: record.breakpoints,
  dataset_version_policy: record.datasetVersionPolicy,
  pinned_dataset_version_ids: record.pinnedDatasetVersionIds,
  status: record.status,
  created_by: record.createdBy,
  created_at: record.createdAt,
  published_by: record.publishedBy,
  published_at: record.publishedAt,
  ...(signOff === undefined ? {} : { sign_off: signOffView(signOff) }),
});

/**
 * Dashboards and their versions (ST-BI-005, BI 3 F5). A dashboard is made by one person and is theirs; a version is saved whole and never changes, over metrics that are certified and, when the datasets are pinned, over
 * versions that are frozen. The library shows the dashboards of the caller and those the tenant published to it.
 */
@Controller()
export class DashboardController {
  private readonly dashboards = new BiDashboardStore();

  @Post('bi/dashboards')
  @HttpCode(200)
  @OperationId('createDashboard')
  @Command({ operation: 'createDashboard' })
  async create(@Scope() scope: CommandScope, @Body() body: Schemas['BiDashboardCreate']): Promise<CommandResult & { code: string }> {
    const created = await this.dashboards.create(scope.tx, { code: body.code, title: body.title, actor: scope.tenant.membershipId });
    await scope.audit({ action: 'bi.dashboard.create', resourceType: RESOURCE_TYPE, resourceId: created.id, diff: { code: created.code } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'bi.dashboard.created.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, dashboard_id: created.id, code: created.code, owner_id: created.ownerUserId, version: created.version, actor_id: scope.tenant.membershipId, occurred_at: new Date().toISOString() },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, created.status, created.version, created.id), code: created.code };
  }

  @Post('bi/dashboards/:id/versions')
  @HttpCode(200)
  @OperationId('saveDashboardVersion')
  @Command({ operation: 'saveDashboardVersion', versioned: true })
  async saveVersion(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BiDashboardVersionDraft']): Promise<CommandResult & { revision: number; version_id: string }> {
    const viewer = scope.tenant.membershipId;
    const dashboard = await this.dashboards.lock(scope.tx, id.toLowerCase());
    // A dashboard that is not the caller's and not in the library is as good as none; one they see and do not own is theirs to read only.
    const seen = dashboard === undefined ? undefined : await this.dashboards.find(scope.tx, dashboard.id, viewer);
    if (dashboard === undefined || seen === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (dashboard.version !== scope.expectedVersion) throw versionConflict(dashboard.version);
    if (seen.permission !== 'OWNER' && seen.permission !== 'EDIT') throw new DomainError('SCOPE_DENIED', 403);
    if (dashboard.status === 'ARCHIVED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const draft = parseDashboardDraft(body);
    // Every metric exists in the tenant and is certified: a dashboard is never built over a number nobody vouches for (BR-BI).
    const found = new Map((await this.dashboards.metricChecks(scope.tx, draft.metricVersionIds)).map((metric) => [metric.id, metric.status]));
    const missing = draft.metricVersionIds.filter((metric) => !found.has(metric));
    if (missing.length > 0) throw new DomainError('VALIDATION_FAILED', 422, 'metric_versions');
    const uncertified = draft.metricVersionIds.filter((metric) => found.get(metric) !== 'CERTIFIED');
    if (uncertified.length > 0) throw new DomainError('METRIC_NOT_CERTIFIED', 422, 'metric_versions', { extensions: { metric_version_ids: uncertified } });
    // A pinned version of a dataset exists and is frozen.
    const pinned = new Map((await this.dashboards.datasetVersionChecks(scope.tx, draft.pinnedDatasetVersionIds)).map((version) => [version.id, version.status]));
    if (draft.pinnedDatasetVersionIds.some((version) => !pinned.has(version))) throw new DomainError('VALIDATION_FAILED', 422, 'pinned_dataset_version_ids');
    const unfrozen = draft.pinnedDatasetVersionIds.filter((version) => pinned.get(version) !== 'FROZEN');
    if (unfrozen.length > 0) throw new DomainError('DATASET_VERSION_NOT_FROZEN', 422, 'pinned_dataset_version_ids', { extensions: { dataset_version_ids: unfrozen } });

    const saved = await this.dashboards.saveVersion(scope.tx, dashboard, draft, viewer);
    const version = dashboard.version + 1;
    await scope.audit({
      action: 'bi.dashboard.save_version',
      resourceType: RESOURCE_TYPE,
      resourceId: dashboard.id,
      diff: { code: dashboard.code, revision: saved.revision, version_id: saved.id, metric_versions: draft.metricVersionIds, dataset_version_policy: draft.policy, widgets: draft.layout.widgets.length },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: dashboard.id,
      aggregateVersion: version,
      type: 'bi.dashboard.version_saved.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, dashboard_id: dashboard.id, dashboard_version_id: saved.id, revision: saved.revision, version, actor_id: viewer, occurred_at: new Date().toISOString() },
      eventKey: `${RESOURCE_TYPE}:${dashboard.id}:${version}`,
    });
    return { ...commandResult(scope, dashboard.status, version, dashboard.id), revision: saved.revision, version_id: saved.id };
  }
}

/** The library of dashboards and one dashboard with its versions (BI-01, BI-03). */
@Controller('bi/dashboards')
export class DashboardReadsController {
  private readonly dashboards = new BiDashboardStore();
  private readonly shares = new BiDashboardShareStore();
  private readonly publications = new BiPublicationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listDashboards')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    if (status !== undefined && !(typeof status === 'string' && STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(limit, cursor);
    const found = await this.database.withTenant(tenant, (tx) =>
      this.dashboards.list(tx, tenant.membershipId, { status: status as string | undefined }, { limit: request.limit, after: request.after === undefined ? undefined : { code: request.after.code, id: request.after.id } }),
    );
    return { items: found.records.map((record) => dashboardView(record, tenant.membershipId)), next_cursor: found.next === undefined ? null : encodeCursor(found.next) };
  }

  @Get(':id')
  @OperationId('getDashboard')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, async (tx) => {
      const record = await this.dashboards.find(tx, id.toLowerCase(), tenant.membershipId);
      if (record === undefined) return undefined;
      // The shares are the owner's to see: who a dashboard is shared with is not told to a person it is shared with.
      const shares = record.permission === 'OWNER' ? await this.shares.forDashboard(tx, record.id) : [];
      const versions = await this.dashboards.versions(tx, record.id);
      return { record, versions, shares, signOffs: await this.publications.signOffsOfVersions(tx, versions.map((version) => version.id)) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const current = found.record.currentVersionId === null ? undefined : found.signOffs.get(found.record.currentVersionId);
    // The signatures of the version the dashboard points to; a dashboard that has no version has nothing to sign.
    return {
      ...dashboardView(found.record, tenant.membershipId),
      ...(current === undefined ? {} : { sign_off: signOffView(current) }),
      versions: found.versions.map((version) => versionView(version, found.signOffs.get(version.id))),
      shares: found.shares.map(shareView),
    };
  }
}

/** The versions of the dashboards the caller sees: the scaffold read of the family (`dashboard_version.read`). */
@Controller('resources/dashboard_version')
export class DashboardVersionReadsController {
  private readonly dashboards = new BiDashboardStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_dashboard_version')
  async list(@CurrentTenant() tenant: TenantContext, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const found = await this.database.withTenant(tenant, (tx) =>
      this.dashboards.listVersions(tx, tenant.membershipId, { limit: request.limit, after: request.after === undefined ? undefined : { at: request.after.code, id: request.after.id } }),
    );
    return { items: found.records.map((record) => versionView(record)), next_cursor: found.next === undefined ? null : encodeCursor({ code: found.next.at, id: found.next.id }) };
  }

  @Get(':id')
  @OperationId('get_resources_dashboard_version_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const record = await this.database.withTenant(tenant, (tx) => this.dashboards.findVersion(tx, id.toLowerCase(), tenant.membershipId));
    if (record === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return versionView(record);
  }
}
