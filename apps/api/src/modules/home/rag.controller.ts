import { Body, Controller, Get, HttpCode, Inject, Optional, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AnalyticsRagStore, DisSnapshotStore, EarlyWarningScoreJob, HomeStore, TenantDatabase, scopePredicate } from '@machvon/db';
import type { PeriodSnapshotRow as SnapshotRow, ScopeBuilder, StoredScore, TenantTx } from '@machvon/db';
import { DomainError, checkRagOverride, previousWeekOf, vietnamDateOf, weekStartOf } from '@machvon/kernel';
import type { EffectiveAccess, RagBand, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { readRag } from './rag-reading';
import type { RagUnitReading } from './rag-reading';
import { HOME_CLOCK } from './tokens';
import { workScopes } from './work-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_TYPE = 'rag_override';
const TREND_WEEKS = 8;
/** What a reader is told first: red, then amber, then the units that cannot be judged yet, then green. */
const ORDER: Readonly<Record<RagBand, number>> = { RED: 0, AMBER: 1, NO_DATA: 2, GREEN: 3 };

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const overrideScope =
  (access: EffectiveAccess, now: Date): ScopeBuilder =>
  (first) =>
    scopePredicate(access, PERMISSIONS.setRagOverride, now, { unitPath: 'u.path', unitId: 'u.id' }, first);

export const factorView = (factor: RagUnitReading['evaluation']['factors'][number]): Record<string, unknown> => ({
  code: factor.code,
  value: factor.value,
  band: factor.band,
  points: factor.points,
  weight: factor.weight,
  direction: factor.direction,
  green: factor.green,
  amber: factor.amber,
});

function unitView(reading: RagUnitReading, history: readonly StoredScore[], weekStart: string): Record<string, unknown> {
  const { evaluation, shown, override } = reading;
  const own = history.filter((row) => row.unitId === reading.input.unitId);
  const before = own.find((row) => row.weekStart === previousWeekOf(weekStart));
  return {
    unit_id: reading.input.unitId,
    code: reading.input.code,
    name: reading.input.name,
    band: shown.band,
    rule_band: shown.ruleBand,
    overridden: shown.overridden,
    override: shown.overridden && override !== null ? { band: override.band, rule_band: override.ruleBand, reason: override.reason, until: override.until, by: override.by, at: override.at } : null,
    score: evaluation.score,
    coverage_pct: evaluation.coveragePct,
    // A unit with too little data is "not enough data": it is not green and the score is not 0.
    no_data_reason: evaluation.band === 'NO_DATA' ? 'LOW_COVERAGE' : null,
    factors: evaluation.factors.map(factorView),
    reasons: evaluation.reasons.map(factorView),
    projects: reading.input.facts.projects,
    previous: before === undefined ? null : { week_start: before.weekStart, score: before.score, band: before.band },
    trend: own.map((row) => ({ week_start: row.weekStart, score: row.score, band: row.band })).sort((left, right) => left.week_start.localeCompare(right.week_start)),
  };
}

/**
 * The explainable colour of the units (G3-2, HOME and BI): red, amber or green is judged by rules (the factors, their lines and weights are `RAG_THRESHOLDS` rules of the governance store), and each unit comes with the one to
 * three factors that moved it, each value against its line, how much of the data was there, the score of the week before and the weeks of the trend. A unit with too little data is "not enough data", never green and never 0. A person may
 * put a colour over the rules' own, with a reason in words and a last day (at most 90 days ahead); the override is shown beside the colour of the rules, never in place of it, and every override and every withdrawal is
 * an append-only line with an audit row and an event. The weekly score of each unit is written once for the week by the job `early-warning-score`, which `scoreEarlyWarningWeek` runs on demand.
 */
@Controller()
export class RagController {
  private readonly snapshots = new DisSnapshotStore();
  private readonly home = new HomeStore();
  private readonly rag = new AnalyticsRagStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('home/rag')
  @OperationId('getRagReading')
  async reading(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('snapshot_id') snapshotId?: unknown, @Query('unit_id') unitId?: unknown): Promise<Record<string, unknown>> {
    if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !UUID.test(snapshotId))) throw invalid('snapshot_id');
    if (unitId !== undefined && (typeof unitId !== 'string' || !UUID.test(unitId))) throw invalid('unit_id');
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      if (unitId !== undefined && !(await this.home.unitReadable(tx, scopes.unitScope, unitId))) throw new DomainError('SCOPE_DENIED', 403);
      const snapshot = await this.snapshotOf(tx, snapshotId);
      const weekStart = weekStartOf(snapshot.asOfDate);
      const reading = await readRag(tx, { snapshot, unitScope: scopes.unitScope, now, today, unitId: unitId as string | undefined });
      const history = await this.rag.history(tx, previousWeekOf(weekStart), TREND_WEEKS, scopes.unitScope);
      return { snapshot, weekStart, reading, history };
    });
    const units = read.reading.units.map((unit) => unitView(unit, read.history, read.weekStart));
    units.sort((left, right) => ORDER[left.band as RagBand] - ORDER[right.band as RagBand] || (Number(right.score ?? -1) - Number(left.score ?? -1)) || String(left.code).localeCompare(String(right.code), 'en'));
    const summary = { RED: 0, AMBER: 0, GREEN: 0, NO_DATA: 0 };
    for (const unit of units) summary[unit.band as RagBand] += 1;
    const { model } = read.reading;
    return {
      snapshot_id: read.snapshot.id,
      as_of_date: read.snapshot.asOfDate,
      week_start: read.weekStart,
      // The numbers of the model are the starting values of the research until the tenant approves its own (`unverified`); the version of each rule that decided is named.
      model: {
        unverified: model.unverified,
        versions: model.versions,
        min_coverage_pct: model.minCoveragePct,
        score_green: model.score.green,
        score_amber: model.score.amber,
        factors: model.factors.map((factor) => ({ code: factor.code, direction: factor.direction, green: factor.green, amber: factor.amber, weight: factor.weight })),
      },
      summary,
      units,
    };
  }

  @Post('home/rag/overrides')
  @HttpCode(200)
  @OperationId('setRagOverride')
  @Command({ operation: 'setRagOverride' })
  async override(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RagOverrideRequest']): Promise<CommandResult> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    await this.assertUnit(scope, access, body.unit_id, now);
    const snapshot = await this.snapshotOf(scope.tx, undefined);
    // The colour the rules give today decides what an override is against; the override of the day before does not count as the rules' own.
    const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
    const reading = await readRag(scope.tx, { snapshot, unitScope: everything, now, today, unitId: body.unit_id });
    const unit = reading.units[0];
    if (unit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'unit_id');
    const draft = checkRagOverride(body, unit.evaluation.band, today);
    const recorded = await this.rag.recordOverride(scope.tx, { unitId: body.unit_id, action: 'SET', band: draft.band, ruleBand: unit.evaluation.band, until: draft.until, reason: draft.reason, actor: scope.tenant.membershipId });
    const facts = { unit_id: body.unit_id, band: draft.band, rule_band: unit.evaluation.band, until: draft.until, score: unit.evaluation.score, snapshot_id: snapshot.id, rule_versions: reading.model.versions };
    await scope.audit({ action: 'home.rag_overridden', resourceType: RESOURCE_TYPE, resourceId: recorded.id, reason: draft.reason, diff: facts });
    await scope.emit({ aggregateType: RESOURCE_TYPE, aggregateId: recorded.id, aggregateVersion: 1, type: 'home.rag_overridden.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...facts }, eventKey: `rag_override:${recorded.id}` });
    return commandResult(scope, 'OVERRIDDEN', 1, recorded.id);
  }

  @Post('home/rag/overrides/revoke')
  @HttpCode(200)
  @OperationId('revokeRagOverride')
  @Command({ operation: 'revokeRagOverride' })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RagOverrideRevoke']): Promise<CommandResult> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    await this.assertUnit(scope, access, body.unit_id, now);
    const reason = typeof body.reason === 'string' ? body.reason.trim().normalize('NFC') : '';
    if (reason.length < 10 || reason.length > 500) throw invalid('reason');
    const active = (await this.rag.activeOverrides(scope.tx, [body.unit_id], today)).get(body.unit_id);
    // No override is in force: there is nothing to take back (and the answer says nothing of the unit beyond that).
    if (active === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'unit_id');
    const recorded = await this.rag.recordOverride(scope.tx, { unitId: body.unit_id, action: 'REVOKE', reason, actor: scope.tenant.membershipId });
    const facts = { unit_id: body.unit_id, withdrawn_band: active.band, withdrawn_until: active.until };
    await scope.audit({ action: 'home.rag_override_revoked', resourceType: RESOURCE_TYPE, resourceId: recorded.id, reason, diff: facts });
    await scope.emit({ aggregateType: RESOURCE_TYPE, aggregateId: recorded.id, aggregateVersion: 1, type: 'home.rag_override_revoked.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...facts }, eventKey: `rag_override:${recorded.id}` });
    return commandResult(scope, 'REVOKED', 1, recorded.id);
  }

  @Post('home/rag/scores')
  @HttpCode(200)
  @OperationId('scoreEarlyWarningWeek')
  @Command({ operation: 'scoreEarlyWarningWeek' })
  async score(@Scope() scope: CommandScope): Promise<CommandResult> {
    const now = this.clock();
    // The pass of the job, for the person who asked: its audit row and its event are written in this command's transaction.
    const job = new EarlyWarningScoreJob({
      recordInTx: (_tx, _actor, entry) => {
        const { correlationId, requestId, ...rest } = entry;
        void correlationId;
        void requestId;
        return scope.audit(rest);
      },
    });
    const result = await job.run(scope.tx, scope.tenant.membershipId, now);
    if (result.skipped === 'NO_SNAPSHOT') throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    // A pass that finds the week scored changes nothing and still leaves a trace of who asked.
    if (result.skipped === 'WEEK_SCORED') await scope.audit({ action: 'home.early_warning_score_requested', resourceType: 'early_warning_score', resourceId: result.snapshotId ?? '', diff: { week_start: result.weekStart, snapshot_id: result.snapshotId, outcome: 'ALREADY_SCORED' } });
    return commandResult(scope, result.skipped === 'WEEK_SCORED' ? 'ALREADY_SCORED' : 'SCORED', Math.max(result.written, 1), result.weekStart ?? '');
  }

  /** The unit exists in the tenant and is within the units the person may override (403 SCOPE_DENIED names nothing; a unit that does not exist looks the same). */
  private async assertUnit(scope: CommandScope, access: EffectiveAccess, unitId: string, now: Date): Promise<void> {
    if (typeof unitId !== 'string' || !UUID.test(unitId)) throw invalid('unit_id');
    if (!(await this.home.unitReadable(scope.tx, overrideScope(access, now), unitId))) throw new DomainError('SCOPE_DENIED', 403);
  }

  private async snapshotOf(tx: TenantTx, snapshotId: unknown): Promise<SnapshotRow> {
    const snapshot = snapshotId === undefined ? await this.snapshots.latestFrozen(tx) : await this.snapshots.find(tx, snapshotId as string);
    if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    if (snapshot.status !== 'FROZEN' && snapshot.status !== 'SUPERSEDED') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
    return snapshot;
  }
}
