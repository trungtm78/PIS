import { randomBytes } from 'node:crypto';
import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { AnalyticsGovernanceStore, AnalyticsRagStore, DisSnapshotStore, HomeStore, TenantDatabase, projectScope } from '@machvon/db';
import type { PeriodSnapshotRow as SnapshotRow } from '@machvon/db';
import { DomainError, addSums, leaderGate, previousWeekOf, rateOfSums, signHomeContext, vietnamDateOf, weekStartOf, weeklyChanges } from '@machvon/kernel';
import type { ChangeLine, EffectiveAccess, TenantContext, UnitWeek, WeekFigures } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { readRag } from './rag-reading';
import { HOME_READ_PERMISSION, scopeHashOf } from './scope-hash';
import { HOME_CLOCK, HOME_CONTEXT_KEY } from './tokens';
import { workScopes } from './work-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * "Thay đổi từ tuần trước" (G3-4, HOME and BI): at most five lines made by rules from the figures of this snapshot and of the week before, each a fact with its numbers and a link to where it can be checked (a drill
 * with its token, the colours, the warnings, the work, the ranking). No language model writes a word: the kernel (`weeklyChanges`) makes the lines, and a line that cannot be computed is not written. The figures are
 * read in the scope of the reader, so the lines are the reader's own; the units that moved are told as counts, never by name (the link opens the list where the right to read is judged again). A figure that a leader
 * is not given because its definition is not certified makes no line.
 */
@Controller()
export class HomeChangesController {
  private readonly snapshots = new DisSnapshotStore();
  private readonly home = new HomeStore();
  private readonly rag = new AnalyticsRagStore();
  private readonly register = new AnalyticsGovernanceStore();
  private readonly clock: () => Date;
  private readonly key: Buffer;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
    @Optional() @Inject(HOME_CONTEXT_KEY) key?: Buffer,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.key = key ?? randomBytes(32);
  }

  @Get('home/changes')
  @OperationId('getHomeChanges')
  async changes(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('unit_id') unitId?: unknown): Promise<Record<string, unknown>> {
    if (unitId !== undefined && (typeof unitId !== 'string' || !UUID.test(unitId))) throw invalid('unit_id');
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const projects = projectScope(access, HOME_READ_PERMISSION, now);
    const underUnitId = unitId as string | undefined;
    const read = await this.database.withTenant(tenant, async (tx) => {
      if (underUnitId !== undefined && !(await this.home.unitReadable(tx, scopes.unitScope, underUnitId))) throw new DomainError('SCOPE_DENIED', 403);
      const snapshot = await this.snapshots.latestFrozen(tx);
      if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      const week = weekStartOf(snapshot.asOfDate);
      const definitions = await this.register.kpiDefinitions(tx, today);
      const certifications = await this.register.kpiCertifications(tx, definitions.values());
      const figures = async (shot: SnapshotRow): Promise<Pick<WeekFigures, 'asOfDate' | 'ratePmPct' | 'disbursedVnd' | 'projectsWithoutData'>> => {
        const query = { basis: 'CURRENT_YEAR' as const, underUnitId };
        const whole = rateOfSums(addSums((await this.snapshots.rateSums(tx, shot.id, projects, { ...query, groupBy: 'NONE' })).map((row) => row.sums)), 'CURRENT_YEAR');
        const perProject = await this.snapshots.rateSums(tx, shot.id, projects, { ...query, groupBy: 'PROJECT' });
        // A figure a leader would not be given (its definition is not certified) is not the stuff of a line either.
        const held = (code: string): boolean => {
          const certification = certifications.get(code);
          return certification === undefined || leaderGate(certification.status) !== null;
        };
        return {
          asOfDate: shot.asOfDate,
          ratePmPct: held('DISBURSEMENT_RATE_PM') ? null : whole.ratePmPct,
          disbursedVnd: held('DISBURSED_TREASURY') ? null : whole.numeratorVnd,
          projectsWithoutData: perProject.filter((row) => row.sums.allNone).length,
        };
      };
      const current = await figures(snapshot);
      const live = await readRag(tx, { snapshot, unitScope: scopes.unitScope, now, today, unitId: underUnitId });
      const before = await this.rag.previousFrozenSnapshotId(tx, week);
      const previousShot = before === undefined ? undefined : await this.snapshots.find(tx, before.id);
      const previous = previousShot === undefined ? undefined : await figures(previousShot);
      const previousWeek = previousShot === undefined ? undefined : weekStartOf(previousShot.asOfDate);
      const stored = previousWeek === undefined || previousWeek === week ? [] : await this.rag.scoresOfWeek(tx, previousWeek, scopes.unitScope);
      return { snapshot, week, current, live, previous, stored };
    });
    // Only the units read in both weeks are compared (a unit that appeared this week is not "turned red").
    const storedBy = new Map(read.stored.filter((row) => underUnitId === undefined || row.unitId === underUnitId).map((row) => [row.unitId, row]));
    const currentUnits = new Map<string, UnitWeek>();
    const previousUnits = new Map<string, UnitWeek>();
    for (const unit of read.live.units) {
      const old = storedBy.get(unit.input.unitId);
      if (old === undefined) continue;
      currentUnits.set(unit.input.unitId, { band: unit.evaluation.band, criticalWarnings: unit.input.facts.criticalWarnings, overdueExplanations: unit.input.facts.overdueExplanations });
      previousUnits.set(unit.input.unitId, { band: old.band, criticalWarnings: old.criticalWarnings, overdueExplanations: old.overdueExplanations });
    }
    const result = weeklyChanges({ ...read.current, units: currentUnits }, read.previous === undefined ? null : { ...read.previous, units: previousUnits });
    const scopeHash = scopeHashOf(tenant, access, underUnitId ?? null, now);
    const tokenFor = (line: ChangeLine): string | null =>
      line.link === 'DRILL' && line.metricCode !== null
        ? signHomeContext({ tenantId: tenant.tenantId, membershipId: tenant.membershipId, snapshotId: read.snapshot.id, scopeHash, metricCode: line.metricCode, unitId: underUnitId ?? null, unitExact: false, projectId: null, lineId: null }, this.key, () => Math.floor(now.getTime() / 1000))
        : null;
    return {
      snapshot_id: read.snapshot.id,
      as_of_date: read.snapshot.asOfDate,
      week_start: read.week,
      previous_week_start: previousWeekOf(read.week),
      previous_as_of_date: result.previousAsOf,
      reason: result.reason,
      max_lines: 5,
      lines: result.lines.map((line) => ({ kind: line.kind, direction: line.direction, params: line.params, link: line.link, metric_code: line.metricCode, context_token: tokenFor(line) })),
    };
  }
}
