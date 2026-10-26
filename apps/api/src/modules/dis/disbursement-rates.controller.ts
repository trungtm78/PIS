import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DIS_RATE_NULL_METRIC, DisSnapshotStore, TenantDatabase, projectScope } from '@machvon/db';
import { DomainError, NOOP_METRICS, RATE_BASES, addSums, rateOfSums } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, RateBasis, RateFigures, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

const READ_PERMISSION = PERMISSIONS.getDisbursementRates;
const GROUPS = ['UNIT', 'PROJECT'] as const;
/** The terms the formulas are proposals under, until the business owner signs them (CXN-03). */
const LEGAL_REFS = ['CXN-03'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function optionalOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value as T;
}

/** The figures of one row of the answer, in the words of the contract. */
function figuresView(figures: RateFigures): Record<string, unknown> {
  return {
    projects: figures.projects,
    numerator_disbursed_vnd: figures.numeratorVnd,
    plan_pm_assigned_vnd: figures.planPmVnd,
    plan_local_added_vnd: figures.planLocalVnd,
    plan_total_vnd: figures.planTotalVnd,
    rate_pm_pct: figures.ratePmPct,
    rate_total_pct: figures.rateTotalPct,
    rate_null_reason: figures.rateNullReason,
    treasury_coverage: figures.treasuryCoverage,
    reported_vnd: figures.reportedVnd,
    ctmtqg_subset_vnd: figures.ctmtqgVnd,
  };
}

/**
 * The two disbursement rates over a snapshot and a scope (ST-DIS-010, DIS 3 F6, DIS-19, DIS-12, DIS-16): one numerator over the plan the Prime Minister gave and over the plan with what the province
 * added, always together, made from the sums of the lines of the group and never from the rates of its parts (BR-DIS-04); a rate that cannot be given is null and says why (BR-DIS-08). The year plan is
 * divided by what the Treasury paid up to the cutoff; the capital carried over has its own rate, apart, on what was reported (the Treasury pays a project, not a source).
 */
@Controller()
export class DisbursementRatesController {
  private readonly snapshots = new DisSnapshotStore();
  private readonly clock: () => Date;
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
    @Optional() @Inject(DIS_METRICS) metrics?: MetricsSink,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Get('disbursement-rates')
  @OperationId('getDisbursementRates')
  async rates(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('snapshot_id') snapshotId?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('fund_source_version_id') fundSourceVersionId?: unknown,
    @Query('bucket') bucket?: unknown,
    @Query('group_by') groupBy?: unknown,
  ): Promise<Record<string, unknown>> {
    const filter = {
      snapshotId: optionalUuid(snapshotId, 'snapshot_id'),
      unitId: optionalUuid(unitId, 'unit_id'),
      projectId: optionalUuid(projectId, 'project_id'),
      fundSourceVersionId: optionalUuid(fundSourceVersionId, 'fund_source_version_id'),
      basis: optionalOf<RateBasis>(bucket, 'bucket', RATE_BASES) ?? 'CURRENT_YEAR',
      groupBy: optionalOf(groupBy, 'group_by', GROUPS),
    };
    const scope = projectScope(access, READ_PERMISSION, this.clock());
    const answer = await this.database.withTenant(tenant, async (tx) => {
      const snapshot = filter.snapshotId === undefined ? await this.snapshots.latestFrozen(tx) : await this.snapshots.find(tx, filter.snapshotId);
      if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      const query = { basis: filter.basis, projectId: filter.projectId, unitId: filter.unitId, fundSourceVersionId: filter.fundSourceVersionId };
      const whole = await this.snapshots.rateSums(tx, snapshot.id, scope, { ...query, groupBy: 'NONE' });
      const groups = filter.groupBy === undefined ? [] : await this.snapshots.rateSums(tx, snapshot.id, scope, { ...query, groupBy: filter.groupBy });
      return { snapshot, whole: addSums(whole.map((row) => row.sums)), groups };
    });
    const total = rateOfSums(answer.whole, filter.basis);
    const rows = answer.groups.map((group) => ({ id: group.id, code: group.code, name: group.name, figures: rateOfSums(group.sums, filter.basis) }));
    for (const figures of [total, ...rows.map((row) => row.figures)]) {
      if (figures.rateNullReason !== null) this.metrics.increment(DIS_RATE_NULL_METRIC, { reason: figures.rateNullReason });
    }
    const { snapshot } = answer;
    return {
      snapshot_id: snapshot.id,
      snapshot_kind: snapshot.snapshotKind,
      snapshot_status: snapshot.status,
      as_of_date: snapshot.asOfDate,
      treasury_cutoff_date: snapshot.treasuryCutoffDate,
      definition_status: snapshot.definitionStatus,
      basis: filter.basis,
      scope: { unit_id: filter.unitId ?? null, project_id: filter.projectId ?? null, fund_source_version_id: filter.fundSourceVersionId ?? null, bucket: filter.basis, group_by: filter.groupBy ?? null },
      ...figuresView(total),
      legal_confirmation_refs: LEGAL_REFS,
      groups: rows.map((row) => ({ id: row.id, code: row.code, name: row.name, ...figuresView(row.figures) })),
    };
  }
}
