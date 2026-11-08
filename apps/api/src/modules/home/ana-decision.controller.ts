import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AnaDecisionStore, DECISION_LIST_MAX, DECISION_RESOURCE, HomeWorkStore, TenantDatabase } from '@machvon/db';
import type { AnalyticsDecisionRow, OutcomeRow, TenantTx } from '@machvon/db';
import { DECISION_SUBJECT_KINDS, DomainError, checkDecision, checkOutcome, compareFigure, figuresDigest, followUpState, vietnamDateOf } from '@machvon/kernel';
import type { DecisionDraft, DecisionSubjectKind, EffectiveAccess, FigureFact, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HomeFigureReader } from './figures';
import type { Figure } from './figures';
import { HOME_READ_PERMISSION } from './scope-hash';
import { HOME_CLOCK } from './tokens';
import { WorkActionSupport } from './work-action-support';
import { canReadScope, workScopes } from './work-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const figureFact = (figure: Figure): FigureFact => ({ metric_code: figure.metric_code, value: figure.value, display_value: figure.display_value, unit: figure.unit, null_reason: figure.null_reason });

/** The tiles of the command center as they are kept in a record: the value the leader read, why there is none, and how far it may be trusted. */
const tileFact = (figure: Figure): Record<string, unknown> => ({
  metric_code: figure.metric_code,
  value: figure.value,
  display_value: figure.display_value,
  numerator: figure.numerator,
  denominator: figure.denominator,
  null_reason: figure.null_reason,
  unit: figure.unit,
  certification: figure.certification === null ? null : { status: figure.certification.status, version: figure.certification.version, origin: figure.certification.origin },
  kpi_version: figure.kpi === null ? null : figure.kpi.version,
  flags: figure.flags,
});

function decisionView(row: AnalyticsDecisionRow, today: string): Record<string, unknown> {
  const tile = row.subjectKind === 'KPI_TILE' ? (row.figures.figure as Record<string, unknown> | undefined) : undefined;
  return {
    id: row.id,
    subject: { kind: row.subjectKind, metric_code: row.metricCode, unit_id: row.unitId, unit_name: row.unitName, source: row.workSource, source_id: row.workSourceId, title: row.subjectTitle },
    kind: row.decisionKind,
    reason: row.reason,
    headline: tile === undefined ? null : { metric_code: row.metricCode, display_value: tile.display_value ?? null, null_reason: tile.null_reason ?? null },
    figures_sha256: row.figuresSha256,
    snapshot_id: row.snapshotId,
    as_of_date: row.asOfDate,
    rule_versions: row.ruleVersions,
    unverified: row.unverified,
    follow_up: { owner: row.followUpOwner, due_on: row.followUpDue, state: followUpState(row.followUpDue, row.latestOutcome, today) },
    decided_by: row.decidedBy,
    decided_at: row.decidedAt,
    latest_outcome: row.latestOutcome,
    outcome_count: row.outcomeCount,
  };
}

const outcomeView = (row: OutcomeRow): Record<string, unknown> => ({ id: row.id, outcome: row.outcome, note: row.note, superseded_by: row.supersededBy, actor: row.actor, at: row.at });

/**
 * The decision log of the leader (G3-6): a decision about a figure of HOME-03 or an urgent alert is written with its reason and the figures as they were at that moment, which the server takes from the reading the
 * leader has (never from the request), with the digest that shows later that they were kept as they were. Nothing is edited: what happened afterwards is an outcome line. The decision is read back beside today's
 * figure and the difference, and a decision is shown only to the person who made it, the owner of its follow-up, and the readers of the unit it is about.
 */
@Controller()
export class AnaDecisionController {
  private readonly decisions = new AnaDecisionStore();
  private readonly figures: HomeFigureReader;
  private readonly support = new WorkActionSupport();
  private readonly work = new HomeWorkStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.figures = new HomeFigureReader(database);
  }

  /** The figures of the command center the leader has now for a unit (or the whole scope), or undefined when there is no frozen snapshot to read them from. */
  private async readTiles(tenant: TenantContext, access: EffectiveAccess, unitId: string | undefined, now: Date, today: string): Promise<{ snapshotId: string; asOfDate: string; definitionStatus: string; tiles: Figure[] } | undefined> {
    try {
      const read = await this.figures.read(tenant, access, { snapshotId: undefined, unitId }, now, today);
      return { snapshotId: read.snapshot.id, asOfDate: read.snapshot.asOfDate, definitionStatus: read.snapshot.definitionStatus, tiles: [...read.tiles, ...read.countTiles] };
    } catch (failure) {
      if (failure instanceof DomainError && (failure.code === 'RESOURCE_NOT_FOUND' || failure.code === 'METRIC_UNAVAILABLE' || failure.code === 'SNAPSHOT_NOT_FROZEN')) return undefined;
      throw failure;
    }
  }

  @Post('home/decisions')
  @HttpCode(200)
  @OperationId('recordAnalyticsDecision')
  @Command({ operation: 'recordAnalyticsDecision' })
  async record(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RecordAnalyticsDecision']): Promise<CommandResult> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const reading = await this.decisions.policy(scope.tx, today);
    const draft: DecisionDraft = checkDecision(body, reading.policy, today);
    const scopes = workScopes(access, now);
    const { subject } = draft;
    if (subject.unitId !== null && !(await this.unitReadable(scope.tx, scopes.unitScope, subject.unitId))) throw new DomainError('SCOPE_DENIED', 403);
    if (draft.followUpOwnerId !== null && !(await this.decisions.memberExists(scope.tx, draft.followUpOwnerId))) throw invalid('follow_up.owner_id');
    const context = subject.kind === 'URGENT_ALERT' ? undefined : await this.readTiles(scope.tenant, access, subject.unitId ?? undefined, now, today);
    const facts: Record<string, unknown> = {
      schema: 1,
      captured_at: now.toISOString(),
      subject: { kind: subject.kind, metric_code: subject.metricCode, unit_id: subject.unitId, source: subject.source, source_id: subject.sourceId, title: subject.title },
      snapshot: context === undefined ? null : { id: context.snapshotId, as_of_date: context.asOfDate, definition_status: context.definitionStatus },
      tiles: context === undefined ? [] : context.tiles.map(tileFact),
    };
    if (subject.kind === 'KPI_TILE') {
      // A figure that cannot be read now cannot be frozen: the decision about it is refused rather than written with nothing behind it.
      const tile = context?.tiles.find((candidate) => candidate.metric_code === subject.metricCode);
      if (context === undefined || tile === undefined) throw new DomainError('METRIC_UNAVAILABLE', 422, 'subject.metric_code');
      facts.figure = tileFact(tile);
    } else if (subject.kind === 'URGENT_ALERT') {
      const row = await this.support.find(scope, access, { source: subject.source as string, source_id: subject.sourceId as string }, now);
      if (row.severity !== 'URGENT') throw invalid('subject.source_id');
      facts.alert = { source: row.source, source_id: row.id, severity: row.severity, kind: row.kind, title: row.title, subtitle: row.subtitle, status: row.status, due_on: row.dueOn, original_due_on: row.originalDueOn, consequence: row.consequence };
    }
    const ruleVersions = { DECISION_POLICY: reading.version };
    const digest = figuresDigest(facts);
    const recorded = await this.decisions.insert(scope.tx, {
      subjectKind: subject.kind,
      metricCode: subject.metricCode,
      unitId: subject.unitId,
      workSource: subject.source,
      workSourceId: subject.sourceId,
      subjectTitle: subject.title,
      decisionKind: draft.kind,
      reason: draft.reason,
      figures: facts,
      figuresSha256: digest,
      snapshotId: context?.snapshotId ?? null,
      asOfDate: context?.asOfDate ?? null,
      ruleVersions,
      unverified: reading.unverified,
      followUpOwnerId: draft.followUpOwnerId,
      followUpDue: draft.followUpDue,
      decidedBy: scope.tenant.membershipId,
    });
    const summary = { subject_kind: subject.kind, metric_code: subject.metricCode, unit_id: subject.unitId, source: subject.source, source_id: subject.sourceId, kind: draft.kind, figures_sha256: digest, snapshot_id: context?.snapshotId ?? null, follow_up_due: draft.followUpDue };
    await scope.audit({ action: 'home.decision_recorded', resourceType: DECISION_RESOURCE, resourceId: recorded.id, reason: draft.reason, diff: summary });
    await scope.emit({ aggregateType: DECISION_RESOURCE, aggregateId: recorded.id, aggregateVersion: 1, type: 'home.decision_recorded.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), decision_id: recorded.id, ...summary }, eventKey: `analytics_decision:${recorded.id}` });
    return commandResult(scope, 'RECORDED', 1, recorded.id);
  }

  @Post('home/decisions/:id/outcomes')
  @HttpCode(200)
  @OperationId('recordAnalyticsDecisionOutcome')
  @Command({ operation: 'recordAnalyticsDecisionOutcome' })
  async outcome(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['RecordAnalyticsDecisionOutcome']): Promise<CommandResult> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const whole = scopes.holds(HOME_READ_PERMISSION, true);
    await this.decisions.lock(scope.tx, id);
    const decision = await this.decisions.find(scope.tx, id, scopes.unitScope, scope.tenant.membershipId, whole);
    if (decision === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (decision.latestOutcome === 'SUPERSEDED') throw new DomainError('ANALYTICS_DECISION_SUPERSEDED', 409, 'id');
    const reading = await this.decisions.policy(scope.tx, today);
    const draft = checkOutcome(body, reading.policy);
    if (draft.supersededBy !== null) {
      if (draft.supersededBy === id || (await this.decisions.find(scope.tx, draft.supersededBy, scopes.unitScope, scope.tenant.membershipId, whole)) === undefined) throw invalid('superseded_by');
    }
    const recorded = await this.decisions.insertOutcome(scope.tx, { decisionId: id, outcome: draft.outcome, note: draft.note, supersededBy: draft.supersededBy, actor: scope.tenant.membershipId });
    const facts = { decision_id: id, outcome: draft.outcome, superseded_by: draft.supersededBy };
    await scope.audit({ action: 'home.decision_outcome_recorded', resourceType: DECISION_RESOURCE, resourceId: id, reason: draft.note, diff: facts });
    await scope.emit({ aggregateType: DECISION_RESOURCE, aggregateId: id, aggregateVersion: decision.outcomeCount + 2, type: 'home.decision_outcome_recorded.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...facts }, eventKey: `analytics_decision_outcome:${recorded.id}` });
    return commandResult(scope, draft.outcome, decision.outcomeCount + 2, id);
  }

  @Get('home/decisions')
  @OperationId('listAnalyticsDecisions')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('subject_kind') subjectKind?: unknown,
    @Query('metric_code') metricCode?: unknown,
    @Query('kind') kind?: unknown,
    @Query('decided_by') decidedBy?: unknown,
    @Query('source') source?: unknown,
    @Query('source_id') sourceId?: unknown,
    @Query('open_follow_up') openFollowUp?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limitText?: unknown,
  ): Promise<Record<string, unknown>> {
    if (subjectKind !== undefined && !(DECISION_SUBJECT_KINDS as readonly unknown[]).includes(subjectKind)) throw invalid('subject_kind');
    if (metricCode !== undefined && (typeof metricCode !== 'string' || !CODE.test(metricCode))) throw invalid('metric_code');
    if (kind !== undefined && (typeof kind !== 'string' || !CODE.test(kind))) throw invalid('kind');
    if (decidedBy !== undefined && (typeof decidedBy !== 'string' || !UUID.test(decidedBy))) throw invalid('decided_by');
    if (source !== undefined && (typeof source !== 'string' || !CODE.test(source))) throw invalid('source');
    if (sourceId !== undefined && (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > 128)) throw invalid('source_id');
    if (openFollowUp !== undefined && openFollowUp !== 'true' && openFollowUp !== 'false') throw invalid('open_follow_up');
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/i.test(cursor))) throw invalid('cursor');
    if (limitText !== undefined && (typeof limitText !== 'string' || !/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > DECISION_LIST_MAX)) throw invalid('limit');
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const read = await this.database.withTenant(tenant, async (tx) => ({
      policy: await this.decisions.policy(tx, today),
      page: await this.decisions.list(
        tx,
        {
          subjectKind: subjectKind as DecisionSubjectKind | undefined,
          metricCode: metricCode as string | undefined,
          decisionKind: kind as string | undefined,
          decidedBy: decidedBy as string | undefined,
          workSource: source as string | undefined,
          workSourceId: sourceId as string | undefined,
          openFollowUp: openFollowUp === undefined ? undefined : openFollowUp === 'true',
          cursor: cursor as string | undefined,
          limit: limitText === undefined ? 25 : Number(limitText),
        },
        scopes.unitScope,
        tenant.membershipId,
        scopes.holds(HOME_READ_PERMISSION, true),
        today,
      ),
    }));
    const { policy } = read;
    return {
      items: read.page.rows.map((row) => decisionView(row, today)),
      next_cursor: read.page.nextCursor,
      as_of: today,
      policy: { kinds: policy.policy.kinds, reason_min: policy.policy.reasonMin, reason_max: policy.policy.reasonMax, follow_up_max_days: policy.policy.followUpMaxDays, outcome_note_min: policy.policy.outcomeNoteMin, rule_version: policy.version, unverified: policy.unverified },
    };
  }

  @Get('home/decisions/:id')
  @OperationId('getAnalyticsDecision')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const decision = await this.decisions.find(tx, id, scopes.unitScope, tenant.membershipId, scopes.holds(HOME_READ_PERMISSION, true));
      if (decision === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
      const alert = decision.subjectKind === 'URGENT_ALERT' ? await this.currentAlert(tx, access, tenant.membershipId, now, today, decision.workSource as string, decision.workSourceId as string) : undefined;
      return { decision, outcomes: await this.decisions.outcomes(tx, id), alert };
    });
    const { decision } = read;
    let current: Record<string, unknown> | null = null;
    let comparison: Record<string, unknown> | null = null;
    if (decision.subjectKind === 'KPI_TILE') {
      const readNow = await this.readTiles(tenant, access, decision.unitId ?? undefined, now, today);
      const tile = readNow?.tiles.find((candidate) => candidate.metric_code === decision.metricCode);
      const then = decision.figures.figure as FigureFact | undefined;
      current = tile === undefined || readNow === undefined ? null : { metric_code: tile.metric_code, value: tile.value, display_value: tile.display_value, null_reason: tile.null_reason, as_of_date: readNow.asOfDate, snapshot_id: readNow.snapshotId };
      if (then !== undefined) {
        const compared = compareFigure(then, tile === undefined ? null : figureFact(tile));
        comparison = { metric_code: compared.metricCode, then: compared.then, now: compared.now, delta: compared.delta, direction: compared.direction, null_reason: compared.nullReason };
      }
    } else if (decision.subjectKind === 'URGENT_ALERT') {
      current = read.alert === undefined ? { state: 'GONE' } : { state: 'OPEN', status: read.alert.status, severity: read.alert.severity, due_on: read.alert.dueOn };
    }
    return {
      ...decisionView(decision, today),
      figures: decision.figures,
      digest_ok: figuresDigest(decision.figures) === decision.figuresSha256,
      current,
      comparison,
      outcomes: read.outcomes.map(outcomeView),
    };
  }

  private async unitReadable(tx: TenantTx, unitScope: ReturnType<typeof workScopes>['unitScope'], unitId: string): Promise<boolean> {
    const visible = unitScope(2);
    const rows = await tx.query<{ n: string }>(`select count(*)::text as n from machvon.organization_unit u where u.id = $1::uuid and ${visible.sql}`, [unitId, ...visible.params]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** The item as the reader sees it now (undefined when it is no longer among the work they may read). */
  private async currentAlert(tx: TenantTx, access: EffectiveAccess, membershipId: string, now: Date, today: string, source: string, sourceId: string): Promise<{ status: string; severity: string; dueOn: string | null } | undefined> {
    for (const view of canReadScope(access, now) ? (['mine', 'scope'] as const) : (['mine'] as const)) {
      const collected = await this.work.collect(tx, { membershipId, now, today, view, mode: 'count', includeHidden: true, ...workScopes(access, now) });
      const row = collected.rows.find((candidate) => candidate.source === source && candidate.id === sourceId);
      if (row !== undefined) return { status: row.status, severity: row.severity, dueOn: row.dueOn };
    }
    return undefined;
  }
}
