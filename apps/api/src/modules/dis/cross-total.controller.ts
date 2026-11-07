import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisCrossTotalStore, DisSnapshotStore, TenantDatabase, crossTotalRecord, projectScope } from '@machvon/db';
import type { CrossTotalView } from '@machvon/db';
import { DomainError, UNMATCHED_FUND } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { snapshotView } from './period-snapshot.controller';

/** A check as openapi.json exposes it (an allowlist). The dimensions that disagree are named; `unit`, `fund` and `project` are the three ways the same disbursed money was added up. */
export function crossTotalView(view: Omit<CrossTotalView, 'id' | 'origin' | 'createdBy' | 'createdAt'> & Partial<Pick<CrossTotalView, 'id' | 'origin' | 'createdBy' | 'createdAt'>>): Record<string, unknown> {
  const dimension = (name: 'UNIT' | 'FUND' | 'PROJECT'): Record<string, unknown> => ({
    total_vnd: view.totals[name],
    key_count: view.keys[name].keyCount,
    top: view.keys[name].top,
    source: view.keys[name].source,
    disagrees: view.disagreeing.includes(name),
    offset_vnd: view.offsetVnd[name] ?? null,
  });
  return {
    id: view.id ?? null,
    snapshot_id: view.snapshotId,
    period_id: view.periodId,
    fiscal_year: view.fiscalYear,
    treasury_cutoff_date: view.treasuryCutoffDate,
    window_from: view.windowFrom,
    published: view.published,
    disagreeing: view.disagreeing,
    agreeing: view.agreeing,
    unit: dimension('UNIT'),
    fund: dimension('FUND'),
    project: dimension('PROJECT'),
    unattributed_fund_vnd: view.unattributedFundVnd,
    unattributed_fund_key: UNMATCHED_FUND,
    project_gaps: view.projectGaps.map((gap) => ({ project_id: gap.key, project_code: gap.label, snapshot_vnd: gap.leftVnd, ledger_vnd: gap.rightVnd, gap_vnd: gap.gapVnd })),
    origin: view.origin ?? null,
    created_by: view.createdBy ?? null,
    created_at: view.createdAt ?? null,
  };
}

/**
 * The cross-total control of the disbursed money (G4-5, DIS): unit = fund = project to the dong, or the indicator is not published. The freeze of a snapshot is gated by it (`PeriodSnapshotController.freeze`); this controller reads
 * the control now and writes a check on demand, so a data steward can see which dimension disagrees, and why, before trying to freeze. A snapshot holds the whole tenant, so only a caller whose permission covers it reads or writes.
 */
@Controller()
export class CrossTotalController {
  private readonly checks = new DisCrossTotalStore();
  private readonly snapshots = new DisSnapshotStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('period-snapshots/:id/cross-total')
  @OperationId('getCrossTotalControl')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    if (projectScope(access, PERMISSIONS.getCrossTotalControl, now)(1).sql !== 'true') throw new DomainError('SCOPE_DENIED', 403, 'scope');
    const found = await this.database.withTenant(tenant, async (tx) => {
      const snapshot = await this.snapshots.find(tx, id);
      if (snapshot === undefined) return undefined;
      return { snapshot, live: await this.checks.compute(tx, id), recorded: await this.checks.latest(tx, id), history: await this.checks.history(tx, id, 10) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      snapshot: snapshotView(found.snapshot),
      live: crossTotalView(found.live),
      recorded: found.recorded === undefined ? null : crossTotalView(found.recorded),
      history: found.history.map(crossTotalView),
      as_of: now.toISOString(),
      formula: 'Tổng theo đơn vị (các dòng của snapshot) = tổng theo nguồn vốn (sổ Kho bạc theo dòng phân bổ) = tổng theo dự án (sổ Kho bạc theo dự án), từ đầu năm tài chính đến ngày chốt; bằng nhau đến từng đồng thì chỉ tiêu mới được công bố',
    };
  }

  @Post('period-snapshots/:id/cross-total-checks')
  @HttpCode(200)
  @OperationId('evaluateCrossTotal')
  @Command({ operation: 'evaluateCrossTotal' })
  async evaluate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['CrossTotalCheckResult']> {
    const now = new Date();
    if (projectScope(access, PERMISSIONS.evaluateCrossTotal, now)(1).sql !== 'true') throw new DomainError('SCOPE_DENIED', 403, 'scope');
    const check = await this.checks.evaluate(scope.tx, id, scope.tenant.membershipId, 'MANUAL');
    const record = crossTotalRecord(check, scope.tenant.tenantId, scope.tenant.membershipId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    return {
      ...commandResult(scope, check.published ? 'PUBLISHED' : 'NOT_PUBLISHED', 1, check.id as string),
      resource_id: check.id as string,
      published: check.published,
      total_unit_vnd: check.totals.UNIT,
      total_fund_vnd: check.totals.FUND,
      total_project_vnd: check.totals.PROJECT,
      disagreeing: check.disagreeing,
    };
  }
}

