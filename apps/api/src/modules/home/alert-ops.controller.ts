import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AlertFeedbackStore, AlertFloodStore, AlertObservationStore, GovernancePolicyPort, HomeWorkStore, TenantDatabase, alertTypeCodeOf } from '@machvon/db';
import type { ClosureRow, FeedbackRow, WorkRow } from '@machvon/db';
import { DomainError, FEEDBACK_REASONS, FEEDBACK_RULE_TYPE, asUuid, floodProtects, groupForFlood, needsRationalisation, vietnamDateOf } from '@machvon/kernel';
import type { AlertFeedbackStatus, EffectiveAccess, FloodItem, TenantContext } from '@machvon/kernel';
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
import { WorkActionSupport } from './work-action-support';
import { canReadScope, workScopes } from './work-scope';

const RESOURCE_TYPE = 'alert_feedback';
const REVIEW = PERMISSIONS.reviewAlertFeedback;
const CLOSURES = PERMISSIONS.listAlertClosures;
const DAY_MS = 86_400_000;

const feedbackStatusOf = (value: unknown): AlertFeedbackStatus | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !['PENDING', 'ACCEPTED_FOR_TUNING', 'REJECTED', 'DUPLICATE_OF', 'WITHDRAWN'].includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  return value as AlertFeedbackStatus;
};

const flagOf = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new DomainError('VALIDATION_FAILED', 422, field);
};

const dayOf = (value: unknown, field: string, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** A report as it is shown: the words of the reporter and of the reviewer are in it, so only the reporter and the reviewers get this view. */
const feedbackView = (row: FeedbackRow): Record<string, unknown> => ({
  id: row.id,
  source: row.source,
  source_id: row.sourceId,
  alert_type: row.alertTypeCode,
  severity: row.severity,
  reporter_id: row.reporterId,
  reason: row.reason,
  note: row.note,
  status: row.status,
  reviewer_id: row.reviewerId,
  reviewed_at: row.reviewedAt,
  review_note: row.reviewNote,
  proposal_note: row.proposalNote,
  governance_rule_id: row.governanceRuleId,
  duplicate_of_id: row.duplicateOfId,
  created_at: row.createdAt,
  version: row.version,
});

const closureView = (row: ClosureRow): Record<string, unknown> => ({
  id: row.id,
  source: row.source,
  source_id: row.sourceId,
  kind: row.kind,
  alert_type: row.alertTypeCode,
  severity: row.severity,
  state: row.state,
  first_seen_at: row.firstSeenAt,
  last_seen_at: row.lastSeenAt,
  closed_at: row.closedAt,
  reopen_count: row.reopenCount,
  last_reopened_at: row.lastReopenedAt,
  decisions_before_close: row.decisionsBeforeClose,
  closed_without_record: row.state === 'RESOLVED_BY_SYSTEM' && row.decisionsBeforeClose === 0,
});

function paged<T extends { id: string }>(rows: T[], limit: number, view: (row: T) => Record<string, unknown>, timeOf: (row: T) => string, today: string): { items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string } {
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { items: shown.map(view), next_cursor: rows.length > limit && last !== undefined ? encodeCursor({ code: timeOf(last), id: last.id }) : null, as_of: today };
}

/**
 * The "this alert is wrong" report (G2-9). A person who can see an item of the alert centre says it is wrong with a reason; the item stays exactly as it was (nothing is hidden or silenced by a report) and the report goes to the
 * review queue of the owners of the alert type, who accept it for tuning (a proposal that goes through the governance rules), reject it with a reason, or mark it as the duplicate of another. The reviewer is never the reporter.
 * The words of a note are kept in the report only: the audit row and the event name the report, the type and the reason code, never the note.
 */
@Controller()
export class AlertFeedbackController {
  private readonly store = new AlertFeedbackStore();
  private readonly support = new WorkActionSupport();

  @Post('home/alert-feedback')
  @HttpCode(200)
  @OperationId('reportAlertWrong')
  @Command({ operation: 'reportAlertWrong' })
  async report(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AlertFeedbackSubmit']): Promise<CommandResult> {
    const now = new Date();
    // The item has to be one the person may see: a report about something they cannot see would tell them it exists.
    const row = await this.support.find(scope, access, { source: body.source, source_id: body.source_id }, now);
    const made = await this.store.submit(scope.tx, { source: row.source, sourceId: row.id, alertTypeCode: alertTypeCodeOf(row), severity: row.severity, reporter: scope.tenant.membershipId, reason: body.reason, note: body.note });
    await scope.audit({ action: 'home.alert_feedback_reported', resourceType: RESOURCE_TYPE, resourceId: made.id, classification: 'INTERNAL', diff: { source: row.source, alert_type: made.alertTypeCode, reason: made.reason } });
    await this.emit(scope, made.id, made.version, 'reported', { source: row.source, source_id: row.id, alert_type: made.alertTypeCode, reason: made.reason }, now);
    return commandResult(scope, 'PENDING', made.version, made.id);
  }

  @Post('home/alert-feedback/:id/withdraw')
  @HttpCode(200)
  @OperationId('withdrawAlertFeedback')
  @Command({ operation: 'withdrawAlertFeedback', versioned: true })
  async withdraw(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.withdraw(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({ action: 'home.alert_feedback_withdrawn', resourceType: RESOURCE_TYPE, resourceId: done.id, classification: 'INTERNAL', diff: { alert_type: done.alertTypeCode } });
    await this.emit(scope, done.id, done.version, 'withdrawn', { alert_type: done.alertTypeCode }, now);
    return commandResult(scope, 'WITHDRAWN', done.version, done.id);
  }

  @Post('home/alert-feedback/:id/review')
  @HttpCode(200)
  @OperationId('reviewAlertFeedback')
  @Command({ operation: 'reviewAlertFeedback', versioned: true })
  async review(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AlertFeedbackReview']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, REVIEW)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const ruleId = body.governance_rule_id === undefined ? undefined : asUuid(body.governance_rule_id)?.toLowerCase();
    const duplicateOf = body.duplicate_of_id === undefined ? undefined : asUuid(body.duplicate_of_id)?.toLowerCase();
    if (body.move !== 'ACCEPT_FOR_TUNING' && ruleId !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'governance_rule_id');
    if (body.move !== 'MARK_DUPLICATE' && duplicateOf !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'duplicate_of_id');
    const done = await this.store.decide(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, { move: body.move, reviewNote: body.review_note, proposalNote: body.proposal_note, governanceRuleId: ruleId, duplicateOfId: duplicateOf });
    await scope.audit({ action: 'home.alert_feedback_reviewed', resourceType: RESOURCE_TYPE, resourceId: done.id, classification: 'INTERNAL', diff: { alert_type: done.alertTypeCode, status: done.status, governance_rule_id: done.governanceRuleId } });
    await this.emit(scope, done.id, done.version, 'reviewed', { alert_type: done.alertTypeCode, status: done.status }, now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  private async emit(scope: CommandScope, id: string, version: number, what: string, facts: Record<string, unknown>, now: Date): Promise<void> {
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: version,
      type: `home.alert_feedback.${what}.v1`,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, feedback_id: id, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${id}:${version}`,
    });
  }
}

/** The reads of the reports: the queue of the reviewers, a person's own reports, and the unhelpful share of each type against what was shown. */
@Controller()
export class AlertFeedbackReadsController {
  private readonly store = new AlertFeedbackStore();
  private readonly policies = new GovernancePolicyPort();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('home/alert-feedback')
  @OperationId('listAlertFeedback')
  async queue(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('alert_type') alertType?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { status: feedbackStatusOf(status), alertTypeCode: typeof alertType === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(alertType) ? alertType : undefined };
    if (alertType !== undefined && filter.alertTypeCode === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'alert_type');
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, REVIEW)) return { items: [], next_cursor: null, as_of: today };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.queue(tx, { ...filter, limit: request.limit + 1, after: request.after === undefined ? undefined : { at: request.after.code, id: request.after.id } }));
    return paged(rows, request.limit, feedbackView, (row) => row.createdAt, today);
  }

  @Get('home/alert-feedback/mine')
  @OperationId('listMyAlertFeedback')
  async mine(@CurrentTenant() tenant: TenantContext, @Query('limit') limit?: unknown): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const request = parsePageRequest(limit, undefined);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.mine(tx, tenant.membershipId, request.limit));
    return { items: rows.map(feedbackView), as_of: vietnamDateOf(new Date()) };
  }

  @Get('home/alert-feedback/stats')
  @OperationId('getAlertFeedbackStats')
  async stats(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('from') from?: unknown, @Query('to') to?: unknown): Promise<Record<string, unknown>> {
    const today = vietnamDateOf(new Date());
    const start = dayOf(from, 'from', addDays(today, -30));
    const end = dayOf(to, 'to', addDays(today, 1));
    if (!holdsOnWholeTenant(access, REVIEW)) return { from: start, to: end, as_of: today, items: [], reasons: FEEDBACK_REASONS };
    const [stats, resolved] = await this.database.withTenant(tenant, async (tx) => [await this.store.statsByType(tx, start, end), await this.policies.get(tx, FEEDBACK_RULE_TYPE, 'DEFAULT', today)] as const);
    const rule = resolved?.params;
    const line = typeof rule?.review_line_pct === 'number' ? rule.review_line_pct : 30;
    const minShown = typeof rule?.min_shown === 'number' ? rule.min_shown : 10;
    return {
      from: start,
      to: end,
      as_of: today,
      formula: 'reports / alerts of the type shown in the period',
      review_line_pct: line,
      min_shown: minShown,
      rule_source: resolved?.source ?? 'DEFAULT',
      rule_version: resolved?.version ?? 0,
      unverified: resolved?.unverified ?? true,
      items: stats.map((entry) => ({ alert_type: entry.alertTypeCode, reports: entry.reports, pending: entry.pending, shown: entry.shown, share_pct: entry.share, needs_review: entry.shown >= minShown && needsRationalisation(entry.share, line) })),
    };
  }
}

/** The closing of alerts by the system, its reopenings and the items that closed with no record (G2-8), and the storms of the centre (G2-11). */
@Controller()
export class AlertClosureReadsController {
  private readonly observations = new AlertObservationStore();
  private readonly floods = new AlertFloodStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('home/alert-closures')
  @OperationId('listAlertClosures')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('state') state?: unknown,
    @Query('without_record') withoutRecord?: unknown,
    @Query('reopened') reopened?: unknown,
    @Query('alert_type') alertType?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (state !== undefined && state !== 'OPEN' && state !== 'RESOLVED_BY_SYSTEM') throw new DomainError('VALIDATION_FAILED', 422, 'state');
    if (alertType !== undefined && (typeof alertType !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(alertType))) throw new DomainError('VALIDATION_FAILED', 422, 'alert_type');
    const filter = { state: state as 'OPEN' | 'RESOLVED_BY_SYSTEM' | undefined, withoutRecord: flagOf(withoutRecord, 'without_record'), reopened: flagOf(reopened, 'reopened'), alertTypeCode: alertType as string | undefined };
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, CLOSURES)) return { items: [], next_cursor: null, as_of: today };
    const rows = await this.database.withTenant(tenant, (tx) => this.observations.list(tx, { ...filter, limit: request.limit + 1, after: request.after === undefined ? undefined : { at: request.after.code, id: request.after.id } }));
    return paged(rows, request.limit, closureView, (row) => row.closedAt ?? row.lastSeenAt, today);
  }

  @Get('home/alert-closures/summary')
  @OperationId('getAlertClosureSummary')
  async summary(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('from') from?: unknown, @Query('to') to?: unknown): Promise<Record<string, unknown>> {
    const today = vietnamDateOf(new Date());
    const start = dayOf(from, 'from', addDays(today, -30));
    const end = dayOf(to, 'to', addDays(today, 1));
    if (!holdsOnWholeTenant(access, CLOSURES)) return { from: start, to: end, as_of: today, denied: true };
    const summary = await this.database.withTenant(tenant, (tx) => this.observations.summary(tx, start, end));
    return {
      as_of: today,
      from: summary.from,
      to: summary.to,
      open_now: summary.openNow,
      closed_by_system: summary.closedBySystem,
      reopened: summary.reopened,
      closed_without_record: summary.closedWithoutRecord,
      median_hours_open: summary.medianHoursOpen,
      formula: 'counted from the events of opening, closing and reopening of each observed alert item',
      by_type: summary.byType.map((entry) => ({ alert_type: entry.alertTypeCode, closed: entry.closed, reopened: entry.reopened, without_record: entry.withoutRecord })),
    };
  }

  @Get('home/alert-storms')
  @OperationId('listAlertStorms')
  async storms(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('from') from?: unknown, @Query('to') to?: unknown, @Query('limit') limit?: unknown): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, undefined);
    const today = vietnamDateOf(new Date());
    const start = dayOf(from, 'from', addDays(today, -30));
    const end = dayOf(to, 'to', addDays(today, 1));
    if (!holdsOnWholeTenant(access, CLOSURES)) return { from: start, to: end, as_of: today, items: [] };
    const rows = await this.database.withTenant(tenant, (tx) => this.floods.list(tx, start, end, request.limit));
    return {
      from: start,
      to: end,
      as_of: today,
      items: rows.map((row) => ({ id: row.id, member_id: row.membershipId, started_at: row.startedAt, ended_at: row.endedAt, peak_new: row.peakNew, grouped_count: row.groupedCount, window_minutes: row.windowMinutes, start_above: row.startThreshold, end_below: row.endThreshold, policy_version: row.policyVersion })),
    };
  }
}

/** The flood state of the reader's own list (G2-11): whether they are in a storm, the summary cards that gather the new alerts below the urgent level, and the rule that decided. Urgent items are never in a group. */
@Controller()
export class AlertFloodController {
  private readonly work = new HomeWorkStore();
  private readonly observations = new AlertObservationStore();
  private readonly floods = new AlertFloodStore();
  private readonly feedback = new AlertFeedbackStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('home/work/flood')
  @OperationId('getAlertFlood')
  async flood(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('view') view?: unknown): Promise<Record<string, unknown>> {
    if (view !== undefined && view !== 'mine' && view !== 'scope') throw new DomainError('VALIDATION_FAILED', 422, 'view');
    const now = new Date();
    const today = vietnamDateOf(now);
    const asked: 'mine' | 'scope' = view === 'scope' && canReadScope(access, now) ? 'scope' : 'mine';
    if (view === 'scope' && asked === 'mine') throw new DomainError('SCOPE_DENIED', 403);
    return this.database.withTenant(tenant, async (tx) => {
      const collected = await this.work.collect(tx, { membershipId: tenant.membershipId, now, today, view: asked, mode: 'count', ...workScopes(access, now) });
      const reading = await this.floods.policy(tx, today);
      const keys = collected.rows.map((row: WorkRow) => ({ source: row.source, sourceId: row.id }));
      const firstSeen = await this.observations.firstSeen(tx, keys);
      const windowStart = now.getTime() - reading.policy.window_minutes * 60_000;
      const dayStart = new Date(`${today}T00:00:00+07:00`).getTime();
      const items: FloodItem[] = [];
      let newInWindow = 0;
      let newToday = 0;
      for (const row of collected.rows) {
        const seen = firstSeen.get(`${row.source}\u0000${row.id}`);
        const at = seen === undefined ? now.getTime() : Date.parse(seen);
        const isNew = at >= windowStart;
        if (isNew) newInWindow += 1;
        if (at >= dayStart) newToday += 1;
        items.push({ source: row.source, id: row.id, severity: row.severity, causeKey: (row as WorkRow & { causeKey?: string | null }).causeKey ?? null, projectCode: row.subtitle, isNew });
      }
      const storm = await this.floods.current(tx, tenant.membershipId);
      const protecting = floodProtects(storm, newToday, reading.policy);
      const grouping = groupForFlood(items, reading.policy, protecting);
      const reported = await this.feedback.reportedBy(tx, tenant.membershipId, keys);
      return {
        as_of: now.toISOString(),
        view: asked,
        storm: { active: storm.active, since: storm.since },
        protecting,
        new_in_window: newInWindow,
        new_today: newToday,
        unavailable_sources: collected.unavailableSources,
        reported: [...reported].map((key) => {
          const [source, id] = key.split('\u0000');
          return { source, source_id: id };
        }),
        policy: {
          window_minutes: reading.policy.window_minutes,
          start_above: reading.policy.start_above,
          end_below: reading.policy.end_below,
          max_new_per_day: reading.policy.max_new_per_day,
          group_by: reading.policy.group_by,
          min_group_size: reading.policy.min_group_size,
          version: reading.version,
          unverified: reading.unverified,
          formula: reading.formula,
          source: reading.source,
          rule_as_of: reading.asOf,
        },
        groups: grouping.groups.map((group) => ({ key: group.key, dimension: group.dimension, source: group.source, count: group.count, most_severe: group.mostSevere, members: group.members.map((member) => ({ source: member.source, source_id: member.id })) })),
        singles: grouping.singles.length,
      };
    });
  }
}
