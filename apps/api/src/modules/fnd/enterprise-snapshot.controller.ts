import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisPeriodStore, ENTERPRISE_PACK, ENTERPRISE_SNAPSHOT_BUILD_METRIC, ENTERPRISE_SNAPSHOT_FREEZE_METRIC, EnterpriseSnapshotStore, TenantDatabase, projectScope } from '@machvon/db';
import type { EnterpriseSnapshotRow } from '@machvon/db';
import { DomainError, EnterpriseFigureReader, NOOP_METRICS } from '@machvon/kernel';
import type { EffectiveAccess, FundingMeasure, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { packCodeOf } from './figure.controller';
import { detailDto, queryLimit, queryText, queryUuid, readinessDto, snapshotActions, snapshotDto } from './enterprise-snapshot-view';
import type { NamedRow } from './enterprise-snapshot-view';
import { FND_CLOCK, FND_METRICS, FUNDING_PACK_CODE } from './tokens';

const RESOURCE = 'period_snapshot';
const CLASSIFICATION = 'CONFIDENTIAL';
const STATUSES = ['BUILDING', 'FROZEN', 'SUPERSEDED', 'FAILED'] as const;
const MAX_LIST = 100;

/**
 * The enterprise period snapshot (ENT-3a, docs/ent-snapshot.md; DL.03, BC.01): build one from the accepted funding figures and the indicator figures of a locked period, review it, freeze it by a second person, and read it through
 * the one reader. A refusal to build names the units that have not submitted. Every command is audited (ADM-11) and announced in the outbox with ids, codes and counts, never an amount.
 */
@Controller()
export class EnterpriseSnapshotController {
  private readonly store = new EnterpriseSnapshotStore();
  private readonly periods = new DisPeriodStore();
  private readonly packCode: string;
  private readonly clock: () => Date;
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(FUNDING_PACK_CODE) packCode?: string,
    @Optional() @Inject(FND_CLOCK) clock?: () => Date,
    @Optional() @Inject(FND_METRICS) metrics?: MetricsSink,
  ) {
    this.packCode = packCodeOf(packCode);
    this.clock = clock ?? ((): Date => new Date());
    this.metrics = metrics ?? NOOP_METRICS;
  }

  /** Only a process of the enterprise edition (or a test that hands the enterprise pack in) holds enterprise snapshots. */
  private assertEnterprise(): void {
    if (this.packCode !== ENTERPRISE_PACK) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }

  @Post('enterprise-snapshots')
  @HttpCode(200)
  @OperationId('buildEnterpriseSnapshot')
  @Command({ operation: 'buildEnterpriseSnapshot' })
  async build(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EnterpriseSnapshotBuild']): Promise<CommandResult> {
    this.assertEnterprise();
    const now = this.clock();
    const period = await this.periods.find(scope.tx, body.period_id, 'share');
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'period_id');
    const built = await this.store.build(scope.tx, { period, asOfAt: now, actor: scope.tenant.membershipId, scope: projectScope(access, PERMISSIONS.buildEnterpriseSnapshot, now) });
    const { snapshot } = built;
    await scope.audit({
      action: 'enterprise.snapshot_built',
      resourceType: RESOURCE,
      resourceId: snapshot.id,
      classification: CLASSIFICATION,
      diff: { period_code: period.code, revision: snapshot.revision, row_count: snapshot.rowCount, figure_count: snapshot.figureCount, indicator_count: snapshot.indicatorCount, projects: built.projects, discarded_id: built.discardedId, reopen_id: built.reopenId, taxonomy_pack: snapshot.taxonomyPack, taxonomy_version: snapshot.taxonomyVersion },
    });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: snapshot.id,
      aggregateVersion: snapshot.version,
      type: 'enterprise.snapshot_built.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), snapshot_id: snapshot.id, period_id: period.id, revision: snapshot.revision, row_count: snapshot.rowCount },
      eventKey: `${RESOURCE}:${snapshot.id}:enterprise-built`,
    });
    scope.afterCommit(() => this.metrics.increment(ENTERPRISE_SNAPSHOT_BUILD_METRIC, { revision: snapshot.revision === 1 ? 'first' : 'next' }));
    return commandResult(scope, snapshot.status, snapshot.version, snapshot.id);
  }

  @Post('enterprise-snapshots/:id/freeze')
  @HttpCode(200)
  @OperationId('freezeEnterpriseSnapshot')
  @Command({ operation: 'freezeEnterpriseSnapshot', versioned: true })
  async freeze(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.assertEnterprise();
    const now = this.clock();
    // Freezing makes a figure official and replaces the one frozen before: it is for a person whose permission covers the whole tenant.
    if (projectScope(access, PERMISSIONS.freezeEnterpriseSnapshot, now)(1).sql !== 'true') throw new DomainError('SCOPE_DENIED', 403, 'scope');
    const done = await this.store.freeze(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, now);
    const { snapshot } = done;
    await scope.audit({
      action: 'enterprise.snapshot_frozen',
      resourceType: RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { period_id: snapshot.periodId, period_code: snapshot.periodCode, revision: snapshot.revision, payload_sha256: snapshot.payloadSha256, row_count: snapshot.rowCount, supersedes_id: done.supersededId, version: snapshot.version },
    });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: id,
      aggregateVersion: snapshot.version,
      type: 'enterprise.snapshot_frozen.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), snapshot_id: id, period_id: snapshot.periodId, revision: snapshot.revision, payload_sha256: snapshot.payloadSha256, supersedes_id: done.supersededId },
      eventKey: `${RESOURCE}:${id}:enterprise-frozen`,
    });
    scope.afterCommit(() => this.metrics.increment(ENTERPRISE_SNAPSHOT_FREEZE_METRIC, { revision: snapshot.revision === 1 ? 'first' : 'next' }));
    return commandResult(scope, snapshot.status, snapshot.version, id);
  }

  @Get('enterprise-snapshot-readiness')
  @OperationId('getEnterpriseSnapshotReadiness')
  async readiness(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('period_id') periodId?: unknown): Promise<Record<string, unknown>> {
    this.assertEnterprise();
    const now = this.clock();
    const id = queryUuid(periodId, 'period_id');
    if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'period_id');
    return this.database.withTenant(tenant, async (tx) => {
      const period = await this.periods.find(tx, id);
      if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'period_id');
      const ready = await this.store.readiness(tx, period, projectScope(access, PERMISSIONS.getEnterpriseSnapshotReadiness, now), now);
      return readinessDto(ready, snapshotActions(access, now, null, tenant.membershipId).build);
    });
  }

  @Get('enterprise-snapshots')
  @OperationId('listEnterpriseSnapshots')
  async list(@CurrentTenant() tenant: TenantContext, @Query('period_id') periodId?: unknown, @Query('status') status?: unknown, @Query('limit') limit?: unknown): Promise<Record<string, unknown>> {
    this.assertEnterprise();
    const period = queryUuid(periodId, 'period_id');
    const state = queryText(status, 'status');
    if (state !== undefined && !(STATUSES as readonly string[]).includes(state)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { periodId: period, status: state }, queryLimit(limit, 50, MAX_LIST)));
    return { items: rows.map(snapshotDto), next_cursor: null };
  }

  @Get('enterprise-snapshots/:id')
  @OperationId('getEnterpriseSnapshot')
  async detail(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('measure') measureText?: unknown,
  ): Promise<Record<string, unknown>> {
    this.assertEnterprise();
    const now = this.clock();
    const requested = queryText(measureText, 'measure');
    return this.database.withTenant(tenant, async (tx) => {
      const row = await this.store.find(tx, id);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const view = await this.store.view(tx, row);
      const measure = (requested ?? view.pack.measures[0]) as FundingMeasure;
      if (!(view.pack.measures as readonly string[]).includes(measure)) throw new DomainError('VALIDATION_FAILED', 422, 'measure');
      const reader = new EnterpriseFigureReader(view);
      const scope = projectScope(access, PERMISSIONS.getEnterpriseSnapshot, now);
      const visible = new Set(await this.store.visibleProjects(tx, scope, reader.projectIds()));
      const projectIds = reader.projectIds().filter((one) => visible.has(one));
      const named = async (table: 'project' | 'organization_unit', ids: readonly string[]): Promise<Map<string, NamedRow>> => {
        if (ids.length === 0) return new Map();
        const rows = await tx.query<NamedRow>(`select id, code, name from machvon.${table} where id = any($1::uuid[])`, [[...ids]]);
        return new Map(rows.map((one) => [one.id, one]));
      };
      const unitIds = [...new Set(projectIds.map((one) => reader.unitOfProject(one)).filter((one): one is string => one !== undefined))];
      const lineage = (await this.store.list(tx, { periodId: row.periodId }, MAX_LIST)).filter((one) => one.status !== 'FAILED').sort((left, right) => left.revision - right.revision || left.createdAt.localeCompare(right.createdAt));
      const verified = row.status === 'FROZEN' || row.status === 'SUPERSEDED' ? (await this.store.verify(tx, id)).ok : null;
      return detailDto({
        row,
        reader,
        pack: view.pack,
        measure,
        projectIds,
        projectNames: await named('project', projectIds),
        unitNames: await named('organization_unit', unitIds),
        lineage: lineage as readonly EnterpriseSnapshotRow[],
        hashVerified: verified,
        actions: snapshotActions(access, now, row, tenant.membershipId),
        partial: projectIds.length !== reader.projectIds().length,
      });
    });
  }
}
