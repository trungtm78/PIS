import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AlertLadderStore, TenantDatabase } from '@machvon/db';
import type { LadderRunRow, LadderRungRow } from '@machvon/db';
import { DomainError, LADDER_SEVERITIES, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, LadderSeverity, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const READ = PERMISSIONS.getAlertLadderPolicy;
const DAY_MS = 86_400_000;
/** The line of the KPI of the delivery of urgent alerts: the receipt arrives within this many minutes of the start of the ladder (a starting value, not confirmed; the screen says so). */
const URGENT_RECEIPT_MINUTES = 30;

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dayOf = (value: unknown, field: string, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};

const rungView = (rung: LadderRungRow): Record<string, unknown> => ({
  index: rung.index,
  channel: rung.channel,
  state: rung.state,
  reason: rung.reason,
  sent_at: rung.sentAt,
  receipt_at: rung.receiptAt,
});

const runView = (run: LadderRunRow, rungs: LadderRungRow[]): Record<string, unknown> => ({
  id: run.id,
  source: run.source,
  source_id: run.sourceId,
  recipient_id: run.recipientId,
  severity: run.severity,
  alert_type: run.alertTypeCode,
  policy_version: run.policyVersion,
  state: run.state,
  done_by: run.doneBy,
  started_at: run.startedAt,
  next_at: run.state === 'ACTIVE' ? run.nextAt : null,
  escalated_at: run.escalatedAt,
  ended_at: run.endedAt,
  planned: run.policy.rungs.map((rung, index) => ({ index, channel: rung.channel, wait_minutes: rung.wait_minutes })),
  rungs: rungs.map(rungView),
});

/**
 * The channel ladder of the alerts (G2-6), read side: the ladder in force for each severity with the formula, source, day and version of the rule (a built-in ladder says it is not confirmed), the ladders that run and
 * that ran with the receipt of each rung, the ladders of one alert item, and the KPI of delivery. The ladders name people and items of the whole tenant, so only a grant on the whole tenant reads them.
 */
@Controller()
export class AlertLadderReadsController {
  private readonly store = new AlertLadderStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('home/alert-ladder/policy')
  @OperationId('getAlertLadderPolicy')
  async policy(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, READ)) return { as_of: today, denied: true, ladders: [] };
    const ladders = await this.database.withTenant(tenant, async (tx) => {
      const out: Array<Record<string, unknown>> = [];
      for (const severity of LADDER_SEVERITIES) {
        const reading = await this.store.policy(tx, severity, today);
        out.push({
          severity,
          version: reading.version,
          unverified: reading.unverified,
          formula: reading.formula,
          source: reading.source,
          rule_as_of: reading.asOf,
          stop_when: reading.policy.stop_when,
          hand_off: reading.policy.hand_off,
          hand_off_after_minutes: reading.policy.hand_off_after_minutes,
          expires_after_minutes: reading.policy.expires_after_minutes,
          rungs: reading.policy.rungs.map((rung, index) => ({ index, channel: rung.channel, wait_minutes: rung.wait_minutes })),
        });
      }
      return out;
    });
    return { as_of: today, ladders };
  }

  @Get('home/alert-ladder/runs')
  @OperationId('listAlertLadderRuns')
  async runs(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('state') state?: unknown,
    @Query('severity') severity?: unknown,
    @Query('limit') limit?: unknown,
    @Query('offset') offset?: unknown,
  ): Promise<Record<string, unknown>> {
    if (state !== undefined && !['ACTIVE', 'DONE', 'ESCALATED', 'EXHAUSTED', 'EXPIRED'].includes(state as string)) throw new DomainError('VALIDATION_FAILED', 422, 'state');
    if (severity !== undefined && !(LADDER_SEVERITIES as readonly string[]).includes(severity as string)) throw new DomainError('VALIDATION_FAILED', 422, 'severity');
    const take = limit === undefined ? 50 : Number(limit);
    const skip = offset === undefined ? 0 : Number(offset);
    if (!Number.isInteger(take) || take < 1 || take > 200) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
    if (!Number.isInteger(skip) || skip < 0 || skip > 100_000) throw new DomainError('VALIDATION_FAILED', 422, 'offset');
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, READ)) return { as_of: today, items: [], has_more: false };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { state: state as LadderRunRow['state'] | undefined, severity: severity as LadderSeverity | undefined, limit: take + 1, offset: skip }));
    return { as_of: today, items: rows.slice(0, take).map((entry) => runView(entry.run, entry.rungs)), has_more: rows.length > take };
  }

  @Get('home/alert-ladder/item')
  @OperationId('getAlertLadderForItem')
  async item(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('source') source?: unknown, @Query('source_id') sourceId?: unknown): Promise<Record<string, unknown>> {
    if (typeof source !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(source)) throw new DomainError('VALIDATION_FAILED', 422, 'source');
    if (typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 200) throw new DomainError('VALIDATION_FAILED', 422, 'source_id');
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, READ)) return { as_of: today, items: [] };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.forItem(tx, source, sourceId));
    return { as_of: today, items: rows.map((entry) => runView(entry.run, entry.rungs)) };
  }

  @Get('home/alert-ladder/kpi')
  @OperationId('getAlertLadderKpi')
  async kpi(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('from') from?: unknown, @Query('to') to?: unknown): Promise<Record<string, unknown>> {
    const today = vietnamDateOf(new Date());
    const start = dayOf(from, 'from', addDays(today, -30));
    const end = dayOf(to, 'to', addDays(today, 1));
    if (!holdsOnWholeTenant(access, READ)) return { from: start, to: end, as_of: today, denied: true };
    const kpi = await this.database.withTenant(tenant, (tx) => this.store.kpi(tx, start, end, URGENT_RECEIPT_MINUTES));
    const share = kpi.urgent.runs === 0 ? null : Math.round((kpi.urgent.receiptedWithin / kpi.urgent.runs) * 1000) / 10;
    return {
      from: kpi.from,
      to: kpi.to,
      as_of: today,
      runs: kpi.runs,
      formula: 'urgent ladders with a receipt of the wanted kind within the line, over all urgent ladders of the period',
      unverified: true,
      urgent: {
        runs: kpi.urgent.runs,
        receipted: kpi.urgent.receipted,
        receipted_within: kpi.urgent.receiptedWithin,
        within_minutes: kpi.urgent.withinMinutes,
        share_within_pct: share,
        median_minutes_to_receipt: kpi.urgent.medianMinutesToReceipt,
        escalated: kpi.urgent.escalated,
        exhausted: kpi.urgent.exhausted,
      },
      by_channel: kpi.byChannel.map((entry) => ({ channel: entry.channel, sent: entry.sent, delivered: entry.delivered, seen: entry.seen, failed: entry.failed, suppressed: entry.suppressed, no_workflow: entry.noWorkflow })),
    };
  }
}
