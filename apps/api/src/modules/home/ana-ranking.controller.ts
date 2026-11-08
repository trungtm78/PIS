import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AnaRankingStore, ANNOTATION_RESOURCE, AnalyticsGovernanceStore, COMPLAINT_RESOURCE, DisSnapshotStore, HomeStore, TenantDatabase } from '@machvon/db';
import type { RankingAnnotationRow, RankingComplaintRow, ScopeBuilder } from '@machvon/db';
import {
  ANNOTATION_STATUSES,
  COMPLAINT_STATUSES,
  DomainError,
  RANKING_RULE_TYPE,
  annotationNext,
  assertAnnotationDecider,
  assertComplaintResolver,
  checkAnnotation,
  checkAnnotationDecision,
  checkComplaint,
  checkComplaintResolution,
  complaintDueDay,
  complaintNext,
  describeRuleType,
  leaderGate,
  rankMultiMetric,
  vietnamDateOf,
} from '@machvon/kernel';
import type { ComplaintStatus, EffectiveAccess, MultiRankedUnit, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_CLOCK, HOME_RANKING_VISIBILITY } from './tokens';
import type { RankingVisibility } from './tokens';
import { workScopes } from './work-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const LIST_MAX = 100;
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });

const unitView = (unit: MultiRankedUnit): Record<string, unknown> => ({
  unit_id: unit.unitId,
  code: unit.code,
  name: unit.name,
  band: unit.band,
  rank: unit.rank,
  of_band: unit.ofBand,
  band_thin: unit.bandThin,
  composite: unit.composite,
  null_reason: unit.nullReason,
  standing: unit.standing,
  metrics: unit.metrics.map((metric) => ({ code: metric.code, direction: metric.direction, weight: metric.weight, value: metric.value, score: metric.score, null_reason: metric.nullReason, excluded: metric.excluded, under_complaint: metric.underComplaint })),
  annotation: unit.annotation === null ? null : { id: unit.annotation.id, reason_code: unit.annotation.reasonCode, valid_to: unit.annotation.validTo },
  pair: { quadrant: unit.pair.quadrant, rate_pct: unit.pair.ratePct, physical_pct: unit.pair.physicalPct, null_reason: unit.pair.nullReason },
});

const annotationView = (row: RankingAnnotationRow): Record<string, unknown> => ({
  id: row.id,
  unit: { id: row.unitId, code: row.unitCode, name: row.unitName },
  reason_code: row.reasonCode,
  metric_codes: row.metricCodes,
  evidence: row.evidence,
  valid_from: row.validFrom,
  valid_to: row.validTo,
  status: row.status,
  proposed_by: row.proposedBy,
  proposed_at: row.proposedAt,
  decided_by: row.decidedBy,
  decided_at: row.decidedAt,
  decision_note: row.decisionNote,
});

const complaintView = (row: RankingComplaintRow, today: string): Record<string, unknown> => ({
  id: row.id,
  unit: { id: row.unitId, code: row.unitCode, name: row.unitName },
  metric_code: row.metricCode,
  as_of_date: row.asOfDate,
  snapshot_id: row.snapshotId,
  claim: row.claim,
  claimed_value: row.claimedValue,
  status: row.status,
  filed_by: row.filedBy,
  filed_at: row.filedAt,
  due_on: row.dueOn,
  overdue: (row.status === 'FILED' || row.status === 'UNDER_REVIEW') && row.dueOn < today,
  reviewer: row.reviewer,
  review_started_at: row.reviewStartedAt,
  resolved_by: row.resolvedBy,
  resolved_at: row.resolvedAt,
  resolution: row.resolution,
});

/**
 * The ranking of the units on several measures (G3-8, DIS and HOME): measures judged among the units of a similar size, a note for a unit held back by something outside its control that a different person approved, the
 * figures a unit disputes marked until answered, and the rate of disbursement beside the physical progress. The existing ranking by rate (`getDisbursementRankings`) is untouched. Notes and complaints are append-only
 * lines of a lifecycle with an audit row and an event; the maker never decides their own note and the person who answers a complaint is not the one who filed it.
 */
@Controller()
export class AnaRankingController {
  private readonly ranking = new AnaRankingStore();
  private readonly snapshots = new DisSnapshotStore();
  private readonly home = new HomeStore();
  private readonly register = new AnalyticsGovernanceStore();
  private readonly clock: () => Date;
  private readonly visibility: (tenant: TenantContext) => Promise<RankingVisibility>;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
    @Optional() @Inject(HOME_RANKING_VISIBILITY) visibility?: (tenant: TenantContext) => Promise<RankingVisibility>,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.visibility = visibility ?? ((): Promise<RankingVisibility> => Promise.resolve('ALL'));
  }

  @Get('home/rankings/multi')
  @OperationId('getMultiMetricRanking')
  async multi(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('snapshot_id') snapshotId?: unknown): Promise<Record<string, unknown>> {
    if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !UUID.test(snapshotId))) throw invalid('snapshot_id');
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const ownOnly = (await this.visibility(tenant)) === 'OWN_ONLY';
    const rule = describeRuleType(RANKING_RULE_TYPE);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const reading = await this.ranking.model(tx, today);
      const snapshot = snapshotId === undefined ? await this.snapshots.latestFrozen(tx) : await this.snapshots.find(tx, snapshotId.toLowerCase());
      if (snapshotId !== undefined && snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      if (snapshot === undefined) return { reading, snapshot: undefined, gate: null, measures: [], annotations: [], complaints: [] };
      if (snapshot.status !== 'FROZEN' && snapshot.status !== 'SUPERSEDED') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
      const definitions = await this.register.kpiDefinitions(tx, today);
      const certification = (await this.register.kpiCertifications(tx, definitions.values())).get('DISBURSEMENT_RATE_PM');
      const gate = certification === undefined ? null : leaderGate(certification.status);
      if (gate !== null) return { reading, snapshot, gate, measures: [], annotations: [], complaints: [] };
      return {
        reading,
        snapshot,
        gate: null,
        measures: await this.ranking.measures(tx, snapshot.id, ownOnly ? scopes.unitScope : EVERYTHING, now),
        annotations: await this.ranking.approvedAnnotations(tx, today),
        complaints: await this.ranking.openComplaints(tx),
      };
    });
    const { model } = read.reading;
    const result = rankMultiMetric(model, read.measures, read.annotations, read.complaints, today);
    return {
      snapshot_id: read.snapshot?.id ?? null,
      as_of_date: read.snapshot?.asOfDate ?? null,
      certification_gate: read.gate,
      null_reason: read.snapshot === undefined ? 'NO_SNAPSHOT' : read.gate !== null ? 'NOT_CERTIFIED' : null,
      model: {
        rule_version: read.reading.version,
        unverified: read.reading.unverified,
        metrics: model.metrics.map((metric) => ({ code: metric.code, direction: metric.direction, weight: metric.weight })),
        min_metrics: model.minMetrics,
        min_units_per_band: model.minUnitsPerBand,
        annotation_effect: model.annotationEffect,
        annotation_reasons: model.annotationReasons,
        annotation_max_days: model.annotationMaxDays,
        pair_gap_pct: model.pairGapPct,
        pair_high_pct: model.pairHighPct,
      },
      info: { formula: rule.formula, source: rule.source, as_of: rule.asOf, rule_version: read.reading.version, unverified: read.reading.unverified },
      bands: result.bands.map((band) => ({ code: band.code, min_plan_vnd: model.scaleBands.find((one) => one.code === band.code)?.minPlanVnd ?? '0', units: band.units, thin: band.thin })),
      units: result.units.map(unitView),
    };
  }

  @Get('home/rankings/annotations')
  @OperationId('listRankingAnnotations')
  async annotations(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('unit_id') unitId?: unknown, @Query('limit') limitText?: unknown): Promise<Record<string, unknown>> {
    const filter = this.filterOf(status, unitId, limitText, ANNOTATION_STATUSES);
    const scopes = workScopes(access, this.clock());
    const rows = await this.database.withTenant(tenant, (tx) => this.ranking.annotations(tx, filter, scopes.unitScope, tenant.membershipId, filter.limit));
    return { items: rows.map(annotationView) };
  }

  @Get('home/rankings/complaints')
  @OperationId('listRankingComplaints')
  async complaints(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('unit_id') unitId?: unknown, @Query('limit') limitText?: unknown): Promise<Record<string, unknown>> {
    const filter = this.filterOf(status, unitId, limitText, COMPLAINT_STATUSES);
    const now = this.clock();
    const scopes = workScopes(access, now);
    const rows = await this.database.withTenant(tenant, (tx) => this.ranking.complaints(tx, filter, scopes.unitScope, tenant.membershipId, filter.limit));
    const today = vietnamDateOf(now);
    return { items: rows.map((row) => complaintView(row, today)), as_of: today };
  }

  @Post('home/rankings/annotations')
  @HttpCode(200)
  @OperationId('proposeRankingAnnotation')
  @Command({ operation: 'proposeRankingAnnotation' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['ProposeRankingAnnotation']): Promise<CommandResult> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const { model } = await this.ranking.model(scope.tx, today);
    const draft = checkAnnotation(body, model, today);
    await this.assertUnit(scope, access, draft.unitId, now);
    const recorded = await this.ranking.insertAnnotation(scope.tx, { ...draft, actor: scope.tenant.membershipId });
    const facts = { unit_id: draft.unitId, reason_code: draft.reasonCode, metric_codes: draft.metricCodes, valid_from: draft.validFrom, valid_to: draft.validTo };
    await scope.audit({ action: 'home.ranking_annotation_proposed', resourceType: ANNOTATION_RESOURCE, resourceId: recorded.id, reason: draft.evidence, diff: facts });
    await scope.emit({ aggregateType: ANNOTATION_RESOURCE, aggregateId: recorded.id, aggregateVersion: 1, type: 'home.ranking_annotation_proposed.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), annotation_id: recorded.id, ...facts }, eventKey: `ranking_annotation:${recorded.id}:1` });
    return commandResult(scope, 'PROPOSED', 1, recorded.id);
  }

  @Post('home/rankings/annotations/:id/decision')
  @HttpCode(200)
  @OperationId('decideRankingAnnotation')
  @Command({ operation: 'decideRankingAnnotation' })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DecideRankingAnnotation']): Promise<CommandResult> {
    const now = this.clock();
    const scopes = workScopes(access, now);
    const row = await this.ranking.findAnnotation(scope.tx, id, scopes.unitScope, scope.tenant.membershipId, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    const draft = checkAnnotationDecision(body);
    assertAnnotationDecider(draft.decision, row.proposedBy.id, scope.tenant.membershipId);
    const next = annotationNext(row.status, draft.decision);
    if (next === null) throw new DomainError('RANKING_ANNOTATION_STATE', 409, 'decision');
    await this.ranking.moveAnnotation(scope.tx, id, next, scope.tenant.membershipId, draft.note);
    const facts = { unit_id: row.unitId, from: row.status, to: next };
    await scope.audit({ action: 'home.ranking_annotation_decided', resourceType: ANNOTATION_RESOURCE, resourceId: id, reason: draft.note, diff: facts });
    await scope.emit({ aggregateType: ANNOTATION_RESOURCE, aggregateId: id, aggregateVersion: 2, type: 'home.ranking_annotation_decided.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), annotation_id: id, ...facts }, eventKey: `ranking_annotation:${id}:${next}` });
    return commandResult(scope, next, 2, id);
  }

  @Post('home/rankings/complaints')
  @HttpCode(200)
  @OperationId('fileRankingComplaint')
  @Command({ operation: 'fileRankingComplaint' })
  async file(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['FileRankingComplaint']): Promise<CommandResult> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const { model } = await this.ranking.model(scope.tx, today);
    const draft = checkComplaint(body, model, today);
    await this.assertUnit(scope, access, draft.unitId, now);
    const snapshotId = await this.ranking.snapshotOfDay(scope.tx, draft.asOfDate);
    const recorded = await this.ranking.insertComplaint(scope.tx, { ...draft, snapshotId, dueOn: complaintDueDay(today, model), actor: scope.tenant.membershipId });
    const facts = { unit_id: draft.unitId, metric_code: draft.metricCode, as_of_date: draft.asOfDate, due_on: complaintDueDay(today, model) };
    await scope.audit({ action: 'home.ranking_complaint_filed', resourceType: COMPLAINT_RESOURCE, resourceId: recorded.id, reason: draft.claim, diff: facts });
    await scope.emit({ aggregateType: COMPLAINT_RESOURCE, aggregateId: recorded.id, aggregateVersion: 1, type: 'home.ranking_complaint_filed.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), complaint_id: recorded.id, ...facts }, eventKey: `ranking_complaint:${recorded.id}:FILED` });
    return commandResult(scope, 'FILED', 1, recorded.id);
  }

  @Post('home/rankings/complaints/:id/resolution')
  @HttpCode(200)
  @OperationId('resolveRankingComplaint')
  @Command({ operation: 'resolveRankingComplaint' })
  async resolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ResolveRankingComplaint']): Promise<CommandResult> {
    const now = this.clock();
    const scopes = workScopes(access, now);
    const row = await this.ranking.findComplaint(scope.tx, id, scopes.unitScope, scope.tenant.membershipId, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    const draft = checkComplaintResolution(body);
    assertComplaintResolver(row.filedBy.id, scope.tenant.membershipId);
    const next: ComplaintStatus | null = complaintNext(row.status, draft.action);
    if (next === null) throw new DomainError('RANKING_COMPLAINT_STATE', 409, 'action');
    if (draft.action === 'START_REVIEW') await this.ranking.startReview(scope.tx, id, scope.tenant.membershipId);
    else await this.ranking.resolveComplaint(scope.tx, id, next, scope.tenant.membershipId, draft.resolution as string);
    const facts = { unit_id: row.unitId, metric_code: row.metricCode, from: row.status, to: next };
    await scope.audit({ action: 'home.ranking_complaint_resolved', resourceType: COMPLAINT_RESOURCE, resourceId: id, ...(draft.resolution === null ? {} : { reason: draft.resolution }), diff: facts });
    await scope.emit({ aggregateType: COMPLAINT_RESOURCE, aggregateId: id, aggregateVersion: 2, type: 'home.ranking_complaint_resolved.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), complaint_id: id, ...facts }, eventKey: `ranking_complaint:${id}:${next}` });
    return commandResult(scope, next, 2, id);
  }

  private filterOf(status: unknown, unitId: unknown, limitText: unknown, allowed: readonly string[]): { status: string | undefined; unitId: string | undefined; limit: number } {
    if (status !== undefined && (typeof status !== 'string' || !allowed.includes(status))) throw invalid('status');
    if (unitId !== undefined && (typeof unitId !== 'string' || !UUID.test(unitId))) throw invalid('unit_id');
    if (limitText !== undefined && (typeof limitText !== 'string' || !/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > LIST_MAX)) throw invalid('limit');
    return { status: status as string | undefined, unitId: unitId as string | undefined, limit: limitText === undefined ? 50 : Number(limitText) };
  }

  /** The unit exists and the person may read it (403 SCOPE_DENIED names nothing; a unit that does not exist looks the same). */
  private async assertUnit(scope: CommandScope, access: EffectiveAccess, unitId: string, now: Date): Promise<void> {
    if (!(await this.home.unitReadable(scope.tx, workScopes(access, now).unitScope, unitId))) throw new DomainError('SCOPE_DENIED', 403);
  }
}
