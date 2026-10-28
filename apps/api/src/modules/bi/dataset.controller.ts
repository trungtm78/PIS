import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BiDatasetStore, TenantDatabase } from '@machvon/db';
import type { BiDatasetRow, DatasetVersionRow } from '@machvon/db';
import { DATASET_VERSION_STATUSES, DomainError, asUuid, certifiedRows, feedsCertified } from '@machvon/kernel';
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
import { holdsOnWholeTenant } from '../adm/tenant-authority';

export const DATASET_VERSION_FROZEN_EVENT = 'bi.dataset_version.frozen.v1';
const VERSION_RESOURCE = 'bi_dataset_version';
const PERIOD = /^[0-9A-Za-z][0-9A-Za-z_.-]{3,19}$/;

export function datasetView(row: BiDatasetRow): Record<string, unknown> {
  return {
    id: row.id,
    dataset_code: row.datasetCode,
    title: row.title,
    source_kind: row.sourceKind,
    grain: row.grain,
    join_paths: row.joinPaths,
    dgv_dataset_id: row.dgvDatasetId,
    classification: row.classification,
    refresh_policy: row.refreshPolicy,
    status: row.status,
    latest_version: row.latest === null ? null : { as_of_period: row.latest.asOfPeriod, quality_badge: row.latest.qualityBadge, built_at: row.latest.builtAt },
    version: row.version,
  };
}

export function versionView(row: DatasetVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    dataset_id: row.datasetId,
    as_of_period: row.asOfPeriod,
    reporting_period_id: row.reportingPeriodId,
    source_snapshot_id: row.sourceSnapshotId,
    built_at: row.builtAt,
    row_count: row.rowCount,
    // DGV adds up the rows each of its rules quarantined, so a row that two rules quarantined is counted twice: the excluded count is an upper bound of the distinct rows and the certified count a lower bound.
    certified_row_count_min: certifiedRows(row.rowCount, row.excludedQuarantineRows),
    checksum_sha256: row.checksumSha256,
    quality_run_id: row.qualityRunId,
    quality_badge: row.qualityBadge,
    excluded_quarantine_rows: row.excludedQuarantineRows,
    feeds_certified: feedsCertified(row.qualityBadge),
    status: row.status,
    supersedes_id: row.supersedesId,
    version: row.version,
  };
}

/** The event that tells the readers a version of a dataset is frozen: what a drill or a dashboard pins itself to. */
export function frozenEventOf(version: DatasetVersionRow, datasetCode: string, occurredAt: Date) {
  return {
    aggregateType: VERSION_RESOURCE,
    aggregateId: version.id,
    aggregateVersion: version.version,
    type: DATASET_VERSION_FROZEN_EVENT,
    schemaVersion: 1,
    payload: { dataset_id: version.datasetId, dataset_code: datasetCode, as_of_period: version.asOfPeriod, snapshot_id: version.sourceSnapshotId, quality_badge: version.qualityBadge, version_id: version.id, supersedes_id: version.supersedesId, occurred_at: occurredAt.toISOString() },
    eventKey: `${VERSION_RESOURCE}:${version.id}:frozen`,
  };
}

/**
 * The versions of a dataset by period (ST-BI-002, BI 3 F2): a person with the right to build asks for the version of a period (or it is built when a snapshot freezes, see the consumer). A version is made from a
 * frozen close snapshot of DIS and the latest quality run of it; asking again for the same content changes nothing, and a build already in progress is BUILD_ALREADY_RUNNING.
 */
@Controller()
export class DatasetBuildController {
  private readonly datasets = new BiDatasetStore();

  @Post('bi/datasets/:id/versions')
  @HttpCode(202)
  @OperationId('buildBiDatasetVersion')
  @Command({ operation: 'buildBiDatasetVersion' })
  async build(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['BiDatasetVersionBuild'],
  ): Promise<CommandResult & { outcome: string; quality_badge: string }> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.buildBiDatasetVersion)) throw new DomainError('SCOPE_DENIED', 403);
    if (!PERIOD.test(body.as_of_period)) throw new DomainError('VALIDATION_FAILED', 422, 'as_of_period');
    const snapshotId = body.source_snapshot_id === undefined ? undefined : asUuid(body.source_snapshot_id);
    if (body.source_snapshot_id !== undefined && snapshotId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'source_snapshot_id');
    const result = await this.datasets.build(scope.tx, { datasetId: id, asOfPeriod: body.as_of_period, sourceSnapshotId: snapshotId, actor: scope.tenant.membershipId });
    const { version } = result;
    await scope.audit({
      action: result.outcome === 'BUILT' ? 'bi.dataset_version_built' : 'bi.dataset_version_build_unchanged',
      resourceType: VERSION_RESOURCE,
      resourceId: version.id,
      diff: { dataset_id: id, as_of_period: version.asOfPeriod, snapshot_id: version.sourceSnapshotId, quality_badge: version.qualityBadge, excluded_quarantine_rows: version.excludedQuarantineRows, superseded_id: result.supersededId },
    });
    if (result.outcome === 'BUILT') {
      const dataset = await this.datasets.find(scope.tx, id);
      await scope.emit(frozenEventOf(version, dataset?.datasetCode ?? '', new Date()));
    }
    return { ...commandResult(scope, version.status, version.version, version.id), outcome: result.outcome, quality_badge: version.qualityBadge };
  }
}

/** The datasets of BI and their versions (the reads of BI-07 and BI-18). */
@Controller('bi/datasets')
export class DatasetReadsController {
  private readonly datasets = new BiDatasetStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listBiDatasets')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.datasets.list(tx, { limit: request.limit + 1, after: request.after === undefined ? undefined : { code: request.after.code } }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(datasetView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.datasetCode, id: last.id }) : null };
  }

  @Get(':id/versions')
  @OperationId('listBiDatasetVersions')
  async versions(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('as_of_period') asOfPeriod?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (asOfPeriod !== undefined && (typeof asOfPeriod !== 'string' || !PERIOD.test(asOfPeriod))) throw new DomainError('VALIDATION_FAILED', 422, 'as_of_period');
    if (status !== undefined && (typeof status !== 'string' || !(DATASET_VERSION_STATUSES as readonly string[]).includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const after = request.after === undefined ? undefined : { builtAt: request.after.code, id: request.after.id };
    if (after !== undefined && Number.isNaN(Date.parse(after.builtAt))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const found = await this.database.withTenant(tenant, async (tx) => {
      if ((await this.datasets.find(tx, id)) === undefined) return undefined;
      return this.datasets.versions(tx, id, { asOfPeriod: asOfPeriod as string | undefined, status: status as string | undefined }, { limit: request.limit + 1, after });
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const shown = found.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(versionView), next_cursor: found.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null };
  }
}
