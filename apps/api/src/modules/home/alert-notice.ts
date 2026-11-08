import { randomUUID } from 'node:crypto';
import { AlertProfileStore, WORKER_MEMBERSHIP_ID, enqueueOutbox } from '@machvon/db';
import type { NoticeEntry, TenantTx, WorkRow } from '@machvon/db';
import { assertPushPayloadSafe, buildPushPayload, composeDigest, effectiveAlertProfile, parseClock, planNotification, quietAt } from '@machvon/kernel';
import type { AlertNotifyPolicy, Digest, DigestInputRow, EffectiveAlertProfile, NotifyOccasionKind, NotifySeverity, PushKind, TenantContext } from '@machvon/kernel';

/** The aggregate and the event that carry a decision to send a notice to a person (consumed by delivery, G2-6): ids and a push that holds no amounts and no names. */
export const ALERT_NOTICE_AGGREGATE = 'alert_notice';
export const ALERT_NOTICE_EVENT = 'home.alert_notice.v1';
export const ALERT_NOTICE_METRIC = 'home_alert_notice_total';
/** The path a push takes the person to; they log in to see what it is about. */
export const ALERT_NOTICE_LINK = '/home/my-work';

/** The day of an instant on the wall clock of a zone (`YYYY-MM-DD`). */
export const localDayOf = (at: Date, zone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** The minutes after midnight of an instant on the wall clock of a zone. */
export function localMinutesOf(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return read('hour') * 60 + read('minute');
}

interface Prepared {
  profile: EffectiveAlertProfile;
  consent: Awaited<ReturnType<AlertProfileStore['consentOf']>>;
  localDay: string;
  sentToday: number;
  urgentThisHour: number;
}

export interface NoticeRequest {
  recipientId: string;
  occasion: NotifyOccasionKind;
  severity: NotifySeverity;
  source: string | null;
  sourceId: string | null;
  claimBreached: boolean;
  typeMayBreakQuiet: boolean;
  /** The one identity of the occasion (an item, a reminder, a level): a notice is decided once for each occasion and channel. */
  key: string;
  /** The kind and the count of the push when it is not the plain notice of one item (the digest says how many it holds). */
  push?: { kind: PushKind; count: number };
}

const KIND_OF: Readonly<Record<NotifyOccasionKind, PushKind>> = { NEW_ITEM: 'ITEM', REMINDER: 'ITEM', ESCALATION: 'ESCALATION', RECLAIM: 'ITEM' };

/**
 * Deciding and recording how a person is told of an alert (G2-5): the profile of the person laid over the policy, the cap of the day, the consent of the channels, then the kernel plan. Every decision for every channel is a row of
 * `alert_notification_log` (once for an occasion and channel), and what is to be sent is an event of the outbox with a push that holds no amounts and no names (R7). The bell is not here: it is the list and nothing in this class can hide an item from it.
 */
export class AlertNotifier {
  private readonly cache = new Map<string, Prepared>();

  constructor(
    private readonly tx: TenantTx,
    private readonly tenant: TenantContext,
    private readonly policy: AlertNotifyPolicy,
    private readonly now: Date,
    private readonly profiles: AlertProfileStore = new AlertProfileStore(),
  ) {}

  private async prepared(recipientId: string): Promise<Prepared> {
    const key = recipientId.toLowerCase();
    const known = this.cache.get(key);
    if (known !== undefined) return known;
    const stored = await this.profiles.get(this.tx, key);
    const profile = effectiveAlertProfile(this.policy, stored.profile, stored.ownQuiet);
    const localDay = localDayOf(this.now, profile.quiet.timeZone);
    const counts = await this.profiles.countsOf(this.tx, key, localDay, this.now);
    const made: Prepared = { profile, consent: await this.profiles.consentOf(this.tx, key), localDay, sentToday: counts.sentToday, urgentThisHour: counts.urgentThisHour };
    this.cache.set(key, made);
    return made;
  }

  private async emit(entry: NoticeEntry, kind: PushKind, count: number): Promise<void> {
    const push = buildPushPayload({ kind, severity: entry.severity, count, link: ALERT_NOTICE_LINK });
    assertPushPayloadSafe(push);
    await enqueueOutbox(this.tx, {
      aggregateType: ALERT_NOTICE_AGGREGATE,
      aggregateId: entry.recipientId,
      aggregateVersion: 1,
      type: ALERT_NOTICE_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: this.tenant.tenantId,
        actor_id: WORKER_MEMBERSHIP_ID,
        occurred_at: this.now.toISOString(),
        recipient_membership_id: entry.recipientId,
        channel: entry.channel,
        occasion: entry.occasion,
        severity: entry.severity,
        source: entry.source,
        source_id: entry.sourceId,
        push,
      },
      eventKey: `alert_notice:${entry.seriesKey}`,
      correlationId: randomUUID(),
    });
  }

  /** Decides, records and (when something is to be sent) announces the notice of one occasion; returns how many interrupting notices were sent. */
  async notify(request: NoticeRequest): Promise<number> {
    const prepared = await this.prepared(request.recipientId);
    const plan = planNotification(
      { kind: request.occasion, severity: request.severity, claimBreached: request.claimBreached, typeMayBreakQuiet: request.typeMayBreakQuiet },
      { now: this.now, profile: prepared.profile, sentToday: prepared.sentToday, urgentThisHour: prepared.urgentThisHour, consent: prepared.consent },
    );
    let sent = 0;
    let anySend = false;
    for (const delivery of plan.deliveries) {
      const entry: NoticeEntry = {
        recipientId: request.recipientId,
        occasion: request.occasion,
        severity: request.severity,
        source: request.source,
        sourceId: request.sourceId,
        channel: delivery.channel as NoticeEntry['channel'],
        decision: delivery.decision,
        holdUntil: delivery.holdUntil === null ? null : new Date(delivery.holdUntil),
        bypass: delivery.bypass,
        inQuiet: delivery.inQuiet,
        localDay: prepared.localDay,
        seriesKey: `NOTICE:${request.occasion}:${request.key}:${delivery.channel}`,
      };
      const created = await this.profiles.record(this.tx, entry);
      if (!created) continue;
      if (delivery.decision === 'SEND_NOW' || delivery.decision === 'SEND_GROUPED') {
        anySend = true;
        if (delivery.channel === 'PUSH' || delivery.channel === 'SMS' || delivery.channel === 'ZALO') {
          prepared.sentToday += 1;
          if (request.severity === 'URGENT') prepared.urgentThisHour += 1;
          sent += 1;
        }
        const plain = request.push ?? { kind: KIND_OF[request.occasion], count: 1 };
        await this.emit(entry, delivery.decision === 'SEND_GROUPED' ? 'GROUP' : plain.kind, delivery.decision === 'SEND_GROUPED' ? Math.max(1, prepared.urgentThisHour) : plain.count);
      }
    }
    // What was held, capped or only to be watched is in the digest; a marker row says it was decided, so the plan is not made again for the same occasion.
    if (plan.digest && !anySend) {
      await this.profiles.record(this.tx, {
        recipientId: request.recipientId,
        occasion: request.occasion,
        severity: request.severity,
        source: request.source,
        sourceId: request.sourceId,
        channel: 'DIGEST',
        decision: 'DIGEST',
        holdUntil: null,
        bypass: null,
        inQuiet: false,
        localDay: prepared.localDay,
        seriesKey: `NOTICE:${request.occasion}:${request.key}:DIGEST`,
      });
    }
    return sent;
  }

  /** Sends a notice that was held for the quiet hours, now that they are over: one release for each held notice. */
  async release(held: { id: string; recipientId: string; occasion: NoticeEntry['occasion']; severity: NotifySeverity; source: string | null; sourceId: string | null; channel: NoticeEntry['channel'] }): Promise<boolean> {
    const prepared = await this.prepared(held.recipientId);
    const entry: NoticeEntry = {
      recipientId: held.recipientId,
      occasion: held.occasion,
      severity: held.severity,
      source: held.source,
      sourceId: held.sourceId,
      channel: held.channel,
      decision: 'SEND_NOW',
      holdUntil: null,
      bypass: null,
      inQuiet: false,
      localDay: prepared.localDay,
      seriesKey: `RELEASE:${held.id}`,
    };
    if (!(await this.profiles.record(this.tx, entry))) return false;
    prepared.sentToday += 1;
    await this.emit(entry, KIND_OF[held.occasion === 'DIGEST' ? 'NEW_ITEM' : (held.occasion as NotifyOccasionKind)], 1);
    return true;
  }

  /**
   * The morning digest: once a day, when the person's own time has come, the one card of what is overdue, due soon, new and waiting for them as a deputy; a push tells them it is there (a count and a path) when the profile and the cap allow it.
   * Not sent when there is nothing in it, when the person turned the digest off, or when one was already decided today.
   */
  async digestIfDue(recipientId: string, rows: readonly DigestInputRow[], today: string): Promise<Digest | null> {
    const prepared = await this.prepared(recipientId);
    if (!prepared.profile.digestEnabled) return null;
    const at = parseClock(prepared.profile.digestAt);
    if (at === undefined || localMinutesOf(this.now, prepared.profile.quiet.timeZone) < at) return null;
    const last = await this.profiles.lastDigestAt(this.tx, recipientId);
    if (last !== null && localDayOf(last, prepared.profile.quiet.timeZone) === prepared.localDay) return null;
    const digest = composeDigest(rows, { today, lookaheadDays: this.policy.digest_lookahead_days, maxLines: this.policy.digest_max_lines, newSince: last === null ? null : last.toISOString() });
    if (digest.total === 0) return null;
    const entry: NoticeEntry = {
      recipientId,
      occasion: 'DIGEST',
      severity: 'ACTION',
      source: null,
      sourceId: null,
      channel: 'DIGEST',
      decision: 'DIGEST',
      holdUntil: null,
      bypass: null,
      inQuiet: false,
      localDay: prepared.localDay,
      seriesKey: `NOTICE:DIGEST:${prepared.localDay}:${recipientId.toLowerCase()}`,
    };
    if (!(await this.profiles.record(this.tx, entry))) return null;
    // The push of the digest is one notice for the day, sent only when it is not the quiet hours of the person (the card is there to be read when they choose, and a push held over a weekend would be stale): it keeps the cap like any other.
    if (!quietAt(this.now, prepared.profile.quiet).quiet) {
      await this.notify({ recipientId, occasion: 'REMINDER', severity: 'ACTION', source: null, sourceId: null, claimBreached: false, typeMayBreakQuiet: false, key: `digest:${prepared.localDay}`, push: { kind: 'DIGEST', count: digest.total } });
    }
    return digest;
  }
}

/** The rows of the digest from the list of a person: what is overdue, near, new, and what they hold as a deputy; `firstSeen` tells when the alert centre first saw each item. */
export function digestRowsOf(rows: readonly (WorkRow & { onBehalfOf?: string | { id: string; name: string | null } | null })[], firstSeen: ReadonlyMap<string, string>): DigestInputRow[] {
  return rows
    .filter((row) => row.lifecycle !== 'RESOLVED')
    .map((row) => ({
      source: row.source,
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      severity: row.severity,
      dueOn: row.dueOn,
      consequence: row.consequence,
      firstSeenAt: firstSeen.get(`${row.source}:${row.id}`) ?? null,
      target: row.target,
      onBehalfOf: row.onBehalfOf === undefined || row.onBehalfOf === null ? null : typeof row.onBehalfOf === 'string' ? row.onBehalfOf : (row.onBehalfOf.name ?? row.onBehalfOf.id),
      snoozed: row.snoozedUntil !== null,
    }));
}

