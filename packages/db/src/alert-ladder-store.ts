import { DomainError, LADDER_RULE_TYPE, ladderDefaults, ladderPolicyOf, receiptStateOf, rungMayMove } from '@machvon/kernel';
import type { LadderChannel, LadderMove, LadderPolicy, LadderSeverity, RungRecord, RungState, SuppressionReason } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

export type RunState = 'ACTIVE' | 'DONE' | 'ESCALATED' | 'EXHAUSTED' | 'EXPIRED';

export interface LadderPolicyReading {
  policy: LadderPolicy;
  /** `builtin` when the tenant approved no rule for the severity: the version of the rule that decided otherwise. */
  version: string;
  unverified: boolean;
  formula: string | null;
  source: string | null;
  asOf: string | null;
}

export interface RunRow {
  id: string;
  source: string;
  sourceId: string;
  recipientId: string;
  severity: LadderSeverity;
  alertTypeCode: string | null;
  policyVersion: string;
  policy: LadderPolicy;
  state: RunState;
  doneBy: 'RECEIPT' | 'ACTED' | 'CLEARED' | null;
  startedAt: string;
  nextAt: string;
  escalatedAt: string | null;
  endedAt: string | null;
  version: number;
}

export interface RungRow {
  id: string;
  runId: string;
  index: number;
  channel: LadderChannel;
  state: RungState;
  reason: SuppressionReason | null;
  sentAt: string | null;
  receiptAt: string | null;
  outboxEventId: string | null;
  notificationId: string | null;
}

export interface LadderKpi {
  from: string;
  to: string;
  runs: number;
  /** Runs of an urgent alert that got a receipt of the wanted kind, and in how many minutes (the line of the KPI is `withinMinutes`). */
  urgent: { runs: number; receipted: number; receiptedWithin: number; withinMinutes: number; medianMinutesToReceipt: number | null; escalated: number; exhausted: number };
  byChannel: Array<{ channel: LadderChannel; sent: number; delivered: number; seen: number; failed: number; suppressed: number; noWorkflow: number }>;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** A rung whose event reached the relay and met no notification workflow within this many minutes had no workflow to carry it. */
const NO_WORKFLOW_AFTER_MINUTES = 10;

interface RawRun {
  id: string;
  source: string;
  source_id: string;
  recipient_membership_id: string;
  severity: LadderSeverity;
  alert_type_code: string | null;
  policy_version: string;
  policy: LadderPolicy;
  state: RunState;
  done_by: RunRow['doneBy'];
  started_at: string;
  next_at: string;
  escalated_at: string | null;
  ended_at: string | null;
  version: number;
}

const RUN_COLUMNS = `r.id, r.source, r.source_id, r.recipient_membership_id, r.severity, r.alert_type_code, r.policy_version, r.policy, r.state, r.done_by, ${ISO('r.started_at')} as started_at, ${ISO('r.next_at')} as next_at,
  ${ISO('r.escalated_at')} as escalated_at, ${ISO('r.ended_at')} as ended_at, r.version`;

const toRun = (row: RawRun): RunRow => ({
  id: row.id,
  source: row.source,
  sourceId: row.source_id,
  recipientId: row.recipient_membership_id,
  severity: row.severity,
  alertTypeCode: row.alert_type_code,
  policyVersion: row.policy_version,
  policy: row.policy,
  state: row.state,
  doneBy: row.done_by,
  startedAt: row.started_at,
  nextAt: row.next_at,
  escalatedAt: row.escalated_at,
  endedAt: row.ended_at,
  version: row.version,
});

interface RawRung {
  id: string;
  run_id: string;
  rung_index: number;
  channel: LadderChannel;
  state: RungState;
  reason: SuppressionReason | null;
  sent_at: string | null;
  receipt_at: string | null;
  outbox_event_id: string | null;
  notification_id: string | null;
}

const RUNG_COLUMNS = `g.id, g.run_id, g.rung_index, g.channel, g.state, g.reason, ${ISO('g.sent_at')} as sent_at, ${ISO('g.receipt_at')} as receipt_at, g.outbox_event_id, g.notification_id`;
const toRung = (row: RawRung): RungRow => ({ id: row.id, runId: row.run_id, index: row.rung_index, channel: row.channel, state: row.state, reason: row.reason, sentAt: row.sent_at, receiptAt: row.receipt_at, outboxEventId: row.outbox_event_id, notificationId: row.notification_id });

/** The suppression reasons of the delivery gate, as the ladder names them. */
const REASON_OF: Readonly<Record<string, SuppressionReason>> = { NO_CONSENT: 'NO_CONSENT', CONSENT_WITHDRAWN: 'NO_CONSENT', PREFERENCE_OFF: 'PROFILE', QUIET_HOURS: 'QUIET_HOURS' };

/**
 * The channel ladders of the alerts (G2-6). The store keeps the run and its rungs and reads the receipts back from the delivery engine; the decisions (which rung next, when the ladder ends) are the kernel's
 * `nextLadderMove`, the sending is the job's (it writes the event of the outbox in the same transaction as `recordRung`). Receipts only move forward: a seen rung is never shown as merely sent.
 */
export class AlertLadderStore {
  private readonly port = new GovernancePolicyPort();

  /** The ladder policy of a severity in force today: the approved rule of the tenant, else the built-in one (flagged as not confirmed); a rule that does not read falls back to the built-in one. */
  async policy(tx: TenantTx, severity: LadderSeverity, today: string): Promise<LadderPolicyReading> {
    const resolved = await this.port.get(tx, LADDER_RULE_TYPE, severity, today);
    const builtin = ladderDefaults()[severity];
    if (resolved === undefined) return { policy: builtin, version: 'builtin', unverified: true, formula: null, source: null, asOf: null };
    const provenance = resolved.provenance;
    try {
      return { policy: ladderPolicyOf(resolved.params), version: resolved.source === 'DEFAULT' ? 'builtin' : String(resolved.version), unverified: resolved.unverified, formula: provenance?.formula ?? null, source: provenance?.source ?? null, asOf: provenance?.asOf ?? null };
    } catch {
      return { policy: builtin, version: 'builtin', unverified: true, formula: provenance?.formula ?? null, source: provenance?.source ?? null, asOf: provenance?.asOf ?? null };
    }
  }

  /**
   * Starts the ladder of an item for a person; `undefined` when one is already active, and also when one already ran for this occurrence of the alert: a ladder that ended (received, escalated, ran out) is not started
   * again while the item stays as it is, only after the observation reopened the alert (its condition cleared and came back).
   */
  async start(tx: TenantTx, input: { source: string; sourceId: string; recipient: string; severity: LadderSeverity; alertTypeCode: string | null; reading: LadderPolicyReading; now: Date }): Promise<RunRow | undefined> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.alert_ladder_run (tenant_id, source, source_id, recipient_membership_id, severity, alert_type_code, policy_version, policy, started_at, next_at)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::timestamptz, $8::timestamptz
        where not exists (
          select 1 from machvon.alert_ladder_run prior
           where prior.source = $1 and prior.source_id = $2 and prior.recipient_membership_id = $3::uuid
             and prior.started_at >= coalesce((select o.last_reopened_at from machvon.alert_observation o where o.source = $1 and o.source_id = $2), '-infinity'::timestamptz))
       on conflict (tenant_id, source, source_id, recipient_membership_id) where state = 'ACTIVE' do nothing returning id`,
      [input.source, input.sourceId, input.recipient, input.severity, input.alertTypeCode, input.reading.version, JSON.stringify(input.reading.policy), input.now.toISOString()],
    );
    const id = inserted[0]?.id;
    return id === undefined ? undefined : this.require(tx, id);
  }

  async find(tx: TenantTx, id: string): Promise<RunRow | undefined> {
    const [row] = await tx.query<RawRun>(`select ${RUN_COLUMNS} from machvon.alert_ladder_run r where r.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRun(row);
  }

  async require(tx: TenantTx, id: string): Promise<RunRow> {
    const found = await this.find(tx, id);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    return found;
  }

  /** The active runs whose time has come, oldest first. */
  async due(tx: TenantTx, now: Date, limit: number): Promise<RunRow[]> {
    const rows = await tx.query<RawRun>(`select ${RUN_COLUMNS} from machvon.alert_ladder_run r where r.state = 'ACTIVE' and r.next_at <= $1::timestamptz order by r.next_at, r.id limit $2 for update skip locked`, [now.toISOString(), limit]);
    return rows.map(toRun);
  }

  /** The active runs of a person (the job decides whether each still has to go on). */
  async activeOf(tx: TenantTx, recipient: string): Promise<RunRow[]> {
    const rows = await tx.query<RawRun>(`select ${RUN_COLUMNS} from machvon.alert_ladder_run r where r.state = 'ACTIVE' and r.recipient_membership_id = $1::uuid order by r.next_at, r.id`, [recipient]);
    return rows.map(toRun);
  }

  async rungs(tx: TenantTx, runId: string): Promise<RungRow[]> {
    const rows = await tx.query<RawRung>(`select ${RUNG_COLUMNS} from machvon.alert_ladder_rung g where g.run_id = $1::uuid order by g.rung_index`, [runId]);
    return rows.map(toRung);
  }

  /** The rungs of a run as the kernel judges them. */
  static records(rungs: readonly RungRow[]): RungRecord[] {
    return rungs.map((rung) => ({ index: rung.index, channel: rung.channel, state: rung.state, sentAt: rung.sentAt }));
  }

  /** Records a rung that was sent (with the event that carries it) or that was not sent and why; recording the same rung twice records it once. */
  async recordRung(tx: TenantTx, input: { runId: string; index: number; channel: LadderChannel; now: Date; outboxEventId: string | null; eventKey: string | null; suppressed: SuppressionReason | null }): Promise<{ id: string; created: boolean }> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.alert_ladder_rung (tenant_id, run_id, rung_index, channel, state, reason, sent_at, outbox_event_id, event_key)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6::timestamptz, $7::uuid, $8)
       on conflict (tenant_id, run_id, rung_index) do nothing returning id`,
      [input.runId, input.index, input.channel, input.suppressed === null ? 'QUEUED' : 'SUPPRESSED', input.suppressed, input.now.toISOString(), input.outboxEventId, input.eventKey],
    );
    if (inserted[0] !== undefined) return { id: inserted[0].id, created: true };
    const [existing] = await tx.query<{ id: string }>('select id from machvon.alert_ladder_rung where run_id = $1::uuid and rung_index = $2', [input.runId, input.index]);
    return { id: (existing as { id: string }).id, created: false };
  }

  /** Moves a run: where it waits next, or how it ended. */
  async schedule(tx: TenantTx, runId: string, nextAt: Date): Promise<void> {
    await tx.query("update machvon.alert_ladder_run set next_at = $2::timestamptz, version = version + 1 where id = $1::uuid and state = 'ACTIVE'", [runId, nextAt.toISOString()]);
  }

  async finish(tx: TenantTx, runId: string, move: Extract<LadderMove, { kind: 'DONE' | 'ESCALATE' | 'EXHAUSTED' | 'EXPIRED' }>, now: Date): Promise<void> {
    const state: RunState = move.kind === 'DONE' ? 'DONE' : move.kind === 'ESCALATE' ? 'ESCALATED' : move.kind === 'EXHAUSTED' ? 'EXHAUSTED' : 'EXPIRED';
    await tx.query(
      `update machvon.alert_ladder_run set state = $2, done_by = $3, escalated_at = $4::timestamptz, ended_at = $5::timestamptz, version = version + 1 where id = $1::uuid and state = 'ACTIVE'`,
      [runId, state, move.kind === 'DONE' ? move.by : null, move.kind === 'ESCALATE' ? now.toISOString() : null, now.toISOString()],
    );
  }

  /**
   * Reads the receipts of the rungs of one run back from the delivery engine and writes what moved: the notification the event of the rung became, its sends (delivered, read, failed, suppressed) and the moment the person
   * opened it. A rung whose event was published and met no workflow for a few minutes is suppressed as NO_WORKFLOW. A state only moves forward.
   */
  async syncReceipts(tx: TenantTx, runId: string, now: Date): Promise<number> {
    const rungs = await this.rungs(tx, runId);
    const [run] = await tx.query<{ recipient_membership_id: string }>('select recipient_membership_id from machvon.alert_ladder_run where id = $1::uuid', [runId]);
    const recipient = (run as { recipient_membership_id: string }).recipient_membership_id;
    let changed = 0;
    for (const rung of rungs) {
      if (rung.outboxEventId === null || rung.state === 'SEEN' || (rung.state === 'SUPPRESSED' && rung.reason !== 'NO_WORKFLOW')) continue;
      const [evidence] = await tx.query<{ id: string; status: string; read_at: string | null; suppression_reason: string | null; attempts: string[]; delivered_at: string | null }>(
        `select n.id, n.status, ${ISO('n.read_at')} as read_at, n.suppression_reason, coalesce(array_agg(a.status) filter (where a.id is not null), '{}') as attempts, ${ISO('max(a.delivered_at)')} as delivered_at
           from machvon.notification_instance n left join machvon.delivery_attempt a on a.tenant_id = n.tenant_id and a.notification_id = n.id
          where n.event_id = $1::uuid and n.recipient_id = $2::uuid group by n.id, n.status, n.read_at, n.suppression_reason limit 1`,
        [rung.outboxEventId, recipient],
      );
      let state: RungState;
      let reason: SuppressionReason | null = null;
      let receiptAt: string | null = null;
      if (evidence === undefined) {
        const [event] = await tx.query<{ status: string; published_at: string | null }>(`select status, ${ISO('published_at')} as published_at from machvon.outbox_event where id = $1::uuid`, [rung.outboxEventId]);
        const publishedAt = event?.published_at ?? null;
        const overdue = event?.status === 'PUBLISHED' && publishedAt !== null && now.getTime() - Date.parse(publishedAt) >= NO_WORKFLOW_AFTER_MINUTES * 60_000;
        if (event?.status === 'DEAD') {
          state = 'FAILED';
        } else if (overdue) {
          state = 'SUPPRESSED';
          reason = 'NO_WORKFLOW';
        } else {
          state = 'QUEUED';
        }
      } else {
        // The inbox is delivered by the insert of the notification itself: a notification that exists and is Delivered has reached the person's inbox.
        const attempts = rung.channel === 'IN_APP' && ['Delivered', 'Read'].includes(evidence.status) ? [...evidence.attempts, 'Delivered'] : evidence.attempts;
        state = receiptStateOf({ notificationExists: true, readAt: evidence.read_at, attemptStatuses: attempts, suppressionReason: evidence.suppression_reason });
        if (state === 'SUPPRESSED') reason = REASON_OF[evidence.suppression_reason ?? ''] ?? 'PROFILE';
        receiptAt = state === 'SEEN' ? (evidence.read_at ?? evidence.delivered_at) : state === 'DELIVERED' ? (evidence.delivered_at ?? now.toISOString()) : null;
      }
      const forward = rungMayMove(rung.state, rung.reason, state);
      if (!forward && evidence?.id === rung.notificationId) continue;
      await tx.query(
        `update machvon.alert_ladder_rung set state = $2, reason = $3, receipt_at = coalesce($4::timestamptz, receipt_at), notification_id = coalesce($5::uuid, notification_id), updated_at = now() where id = $1::uuid`,
        [rung.id, forward ? state : rung.state, forward ? reason : rung.reason, forward ? receiptAt : null, evidence?.id ?? null],
      );
      if (forward) changed += 1;
    }
    return changed;
  }

  /** Runs that ended in the last days whose rungs are still waiting for a receipt: their receipts are read for a while longer so that the KPI counts what really arrived. */
  async pendingReceipts(tx: TenantTx, now: Date, graceHours: number, limit: number): Promise<string[]> {
    const rows = await tx.query<{ id: string }>(
      `select distinct r.id from machvon.alert_ladder_run r join machvon.alert_ladder_rung g on g.tenant_id = r.tenant_id and g.run_id = r.id
        where r.state <> 'ACTIVE' and r.ended_at >= $1::timestamptz - ($2::int * interval '1 hour') and g.state in ('QUEUED', 'SENT', 'DELIVERED') and g.outbox_event_id is not null limit $3`,
      [now.toISOString(), graceHours, limit],
    );
    return rows.map((row) => row.id);
  }

  // -- reads ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The ladders of one alert item, newest first, each with its rungs. */
  async forItem(tx: TenantTx, source: string, sourceId: string): Promise<Array<{ run: RunRow; rungs: RungRow[] }>> {
    const rows = await tx.query<RawRun>(`select ${RUN_COLUMNS} from machvon.alert_ladder_run r where r.source = $1 and r.source_id = $2 order by r.started_at desc, r.id desc limit 20`, [source, sourceId]);
    const out: Array<{ run: RunRow; rungs: RungRow[] }> = [];
    for (const row of rows) out.push({ run: toRun(row), rungs: await this.rungs(tx, row.id) });
    return out;
  }

  /** The runs of a period, newest first, with their rungs (the live view of the screen). */
  async list(tx: TenantTx, filter: { state?: RunState | undefined; severity?: LadderSeverity | undefined; limit: number; offset: number }): Promise<Array<{ run: RunRow; rungs: RungRow[] }>> {
    const params: unknown[] = [];
    const add = (value: unknown): string => `$${params.push(value)}`;
    const where: string[] = [];
    if (filter.state !== undefined) where.push(`r.state = ${add(filter.state)}`);
    if (filter.severity !== undefined) where.push(`r.severity = ${add(filter.severity)}`);
    const limit = add(filter.limit);
    const offset = add(filter.offset);
    const rows = await tx.query<RawRun>(`select ${RUN_COLUMNS} from machvon.alert_ladder_run r ${where.length === 0 ? '' : `where ${where.join(' and ')}`} order by r.started_at desc, r.id desc limit ${limit} offset ${offset}`, params);
    const out: Array<{ run: RunRow; rungs: RungRow[] }> = [];
    for (const row of rows) out.push({ run: toRun(row), rungs: await this.rungs(tx, row.id) });
    return out;
  }

  /**
   * The delivery KPIs of a period of days: how many ladders ran, how many urgent ones got the receipt the policy wants and how fast, how many were escalated or ran out, and for each channel how its rungs ended. A rung that was
   * not sent for want of a workflow is counted apart (`noWorkflow`): it is a gap in the configuration, not a failure of a provider.
   */
  async kpi(tx: TenantTx, from: string, to: string, withinMinutes: number): Promise<LadderKpi> {
    const [totals] = await tx.query<{ runs: string; urgent: string; receipted: string; within: string; median: string | null; escalated: string; exhausted: string }>(
      `with first_receipt as (
         select r.id, r.severity, r.state, r.started_at, min(g.receipt_at) filter (where g.receipt_at is not null and (g.state = 'SEEN' or r.policy ->> 'stop_when' = 'DELIVERED')) as at
           from machvon.alert_ladder_run r left join machvon.alert_ladder_rung g on g.tenant_id = r.tenant_id and g.run_id = r.id
          where r.started_at >= $1::date and r.started_at < $2::date group by r.id, r.severity, r.state, r.started_at)
       select count(*)::text as runs,
              count(*) filter (where severity = 'URGENT')::text as urgent,
              count(*) filter (where severity = 'URGENT' and at is not null)::text as receipted,
              count(*) filter (where severity = 'URGENT' and at is not null and at <= started_at + ($3::int * interval '1 minute'))::text as within,
              (percentile_cont(0.5) within group (order by extract(epoch from (at - started_at)) / 60) filter (where severity = 'URGENT' and at is not null))::text as median,
              count(*) filter (where severity = 'URGENT' and state = 'ESCALATED')::text as escalated,
              count(*) filter (where severity = 'URGENT' and state = 'EXHAUSTED')::text as exhausted
         from first_receipt`,
      [from, to, withinMinutes],
    );
    const channels = await tx.query<{ channel: LadderChannel; sent: string; delivered: string; seen: string; failed: string; suppressed: string; no_workflow: string }>(
      `select g.channel, count(*) filter (where g.state <> 'SUPPRESSED')::text as sent,
              count(*) filter (where g.state = 'DELIVERED')::text as delivered, count(*) filter (where g.state = 'SEEN')::text as seen, count(*) filter (where g.state = 'FAILED')::text as failed,
              count(*) filter (where g.state = 'SUPPRESSED' and g.reason <> 'NO_WORKFLOW')::text as suppressed, count(*) filter (where g.reason = 'NO_WORKFLOW')::text as no_workflow
         from machvon.alert_ladder_rung g join machvon.alert_ladder_run r on r.tenant_id = g.tenant_id and r.id = g.run_id
        where r.started_at >= $1::date and r.started_at < $2::date group by g.channel order by g.channel`,
      [from, to],
    );
    const t = totals as NonNullable<typeof totals>;
    return {
      from,
      to,
      runs: Number(t.runs),
      urgent: { runs: Number(t.urgent), receipted: Number(t.receipted), receiptedWithin: Number(t.within), withinMinutes, medianMinutesToReceipt: t.median === null ? null : Math.round(Number(t.median) * 10) / 10, escalated: Number(t.escalated), exhausted: Number(t.exhausted) },
      byChannel: channels.map((row) => ({ channel: row.channel, sent: Number(row.sent), delivered: Number(row.delivered), seen: Number(row.seen), failed: Number(row.failed), suppressed: Number(row.suppressed), noWorkflow: Number(row.no_workflow) })),
    };
  }
}
