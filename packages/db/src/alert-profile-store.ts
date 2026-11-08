import { DomainError, emptyAlertProfile, versionConflict } from '@machvon/kernel';
import type { AlertProfile, HealthNotice, NotifyChannel, NotifyDecision, NotifySeverity } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface StoredAlertProfile {
  profile: AlertProfile;
  /** 0 for a person who never saved one: the policy applies. */
  version: number;
  /** The quiet hours the person set in the notification preferences (NOT-03), when they did. */
  ownQuiet: { from: string; to: string; timeZone: string } | null;
}

export interface NoticeEntry {
  recipientId: string;
  occasion: 'NEW_ITEM' | 'REMINDER' | 'ESCALATION' | 'RECLAIM' | 'DIGEST';
  severity: NotifySeverity;
  source: string | null;
  sourceId: string | null;
  channel: 'PUSH' | 'EMAIL' | 'SMS' | 'ZALO' | 'DIGEST';
  decision: NotifyDecision;
  holdUntil: Date | null;
  bypass: 'URGENT_UNCLAIMED' | null;
  inQuiet: boolean;
  localDay: string;
  seriesKey: string;
}

const clock = (value: string | null): string | null => (value === null ? null : value.slice(0, 5));

/**
 * The profile of a person for alerts and the log of what was decided about telling them (G2-5). The profile is replaced whole under one version (If-Match); whatever the person left empty is the policy's. The log is appended by the job,
 * one row for each decision for each channel, with a series key so a pass that runs twice records each once; it keeps ids and decisions and never the words of an alert.
 */
export class AlertProfileStore {
  async get(tx: TenantTx, membershipId: string): Promise<StoredAlertProfile> {
    const rows = await tx.query<{
      channels: AlertProfile['channels'];
      quiet_from: string | null;
      quiet_to: string | null;
      quiet_weekends: boolean | null;
      quiet_time_zone: string | null;
      digest_enabled: boolean;
      digest_at: string | null;
      push_min_severity: 'URGENT' | 'ACTION' | null;
      push_cap_per_day: number | null;
      group_same_root: boolean | null;
      version: string;
    }>(
      `select channels, quiet_from::text as quiet_from, quiet_to::text as quiet_to, quiet_weekends, quiet_time_zone, digest_enabled, digest_at::text as digest_at, push_min_severity, push_cap_per_day, group_same_root, version::text as version
         from machvon.alert_notification_profile where membership_id = $1::uuid`,
      [membershipId.toLowerCase()],
    );
    const own = await tx.query<{ quiet_start: string | null; quiet_end: string | null; time_zone: string }>('select quiet_start::text as quiet_start, quiet_end::text as quiet_end, time_zone from machvon.notification_preference_profile where membership_id = $1::uuid', [membershipId.toLowerCase()]);
    const ownQuiet = own[0]?.quiet_start == null || own[0].quiet_end == null ? null : { from: own[0].quiet_start.slice(0, 5), to: own[0].quiet_end.slice(0, 5), timeZone: own[0].time_zone };
    const row = rows[0];
    if (row === undefined) return { profile: emptyAlertProfile(), version: 0, ownQuiet };
    return {
      profile: {
        channels: row.channels,
        quiet: row.quiet_from === null || row.quiet_to === null || row.quiet_weekends === null || row.quiet_time_zone === null ? null : { from: clock(row.quiet_from) as string, to: clock(row.quiet_to) as string, weekends: row.quiet_weekends, timeZone: row.quiet_time_zone },
        digest_enabled: row.digest_enabled,
        digest_at: clock(row.digest_at),
        push_min_severity: row.push_min_severity,
        push_cap_per_day: row.push_cap_per_day,
        group_same_root: row.group_same_root,
      },
      version: Number(row.version),
      ownQuiet,
    };
  }

  /** Replaces the whole profile of the person under the version they read (0 when they never saved one); a stale version is 409 VERSION_CONFLICT. Returns the new version. */
  async put(tx: TenantTx, membershipId: string, profile: AlertProfile, expectedVersion: number): Promise<number> {
    const current = await this.get(tx, membershipId);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    const values = [
      profile.channels === null ? null : JSON.stringify(profile.channels),
      profile.quiet?.from ?? null,
      profile.quiet?.to ?? null,
      profile.quiet?.weekends ?? null,
      profile.quiet?.timeZone ?? null,
      profile.digest_enabled,
      profile.digest_at,
      profile.push_min_severity,
      profile.push_cap_per_day,
      profile.group_same_root,
    ];
    if (current.version === 0) {
      await tx.query(
        `insert into machvon.alert_notification_profile (tenant_id, membership_id, channels, quiet_from, quiet_to, quiet_weekends, quiet_time_zone, digest_enabled, digest_at, push_min_severity, push_cap_per_day, group_same_root)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $11::uuid, $1::jsonb, $2::time, $3::time, $4::boolean, $5, $6::boolean, $7::time, $8, $9::int, $10::boolean)`,
        [...values, membershipId.toLowerCase()],
      );
      return 1;
    }
    const updated = await tx.query<{ version: string }>(
      `update machvon.alert_notification_profile set channels = $1::jsonb, quiet_from = $2::time, quiet_to = $3::time, quiet_weekends = $4::boolean, quiet_time_zone = $5, digest_enabled = $6::boolean, digest_at = $7::time,
              push_min_severity = $8, push_cap_per_day = $9::int, group_same_root = $10::boolean, version = version + 1, updated_at = now()
        where membership_id = $11::uuid and version = $12::bigint returning version::text as version`,
      [...values, membershipId.toLowerCase(), expectedVersion],
    );
    if (updated[0] === undefined) throw new DomainError('VERSION_CONFLICT', 409);
    return Number(updated[0].version);
  }

  /** Records one decision; the one decision of a series is recorded once. */
  async record(tx: TenantTx, entry: NoticeEntry): Promise<boolean> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.alert_notification_log (tenant_id, recipient_membership_id, occasion, severity, source, source_id, channel, decision, hold_until, bypass, in_quiet, local_day, series_key)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::boolean, $11::date, $12)
       on conflict (tenant_id, series_key) do nothing returning id`,
      [entry.recipientId.toLowerCase(), entry.occasion, entry.severity, entry.source, entry.sourceId, entry.channel, entry.decision, entry.holdUntil?.toISOString() ?? null, entry.bypass, entry.inQuiet, entry.localDay, entry.seriesKey],
    );
    return inserted.length > 0;
  }

  /** The interrupting notices a person already got on a day of theirs, and the urgent ones in the hour before `now`. */
  async countsOf(tx: TenantTx, recipientId: string, localDay: string, now: Date): Promise<{ sentToday: number; urgentThisHour: number }> {
    const rows = await tx.query<{ sent: string; urgent: string }>(
      `select count(*) filter (where decision in ('SEND_NOW', 'SEND_GROUPED') and channel in ('PUSH', 'SMS', 'ZALO'))::text as sent,
              count(*) filter (where decision in ('SEND_NOW', 'SEND_GROUPED') and channel in ('PUSH', 'SMS', 'ZALO') and severity = 'URGENT' and created_at > $3::timestamptz - interval '1 hour')::text as urgent
         from machvon.alert_notification_log where recipient_membership_id = $1::uuid and local_day = $2::date`,
      [recipientId.toLowerCase(), localDay, now.toISOString()],
    );
    return { sentToday: Number(rows[0]?.sent ?? 0), urgentThisHour: Number(rows[0]?.urgent ?? 0) };
  }

  /** The channels the person agreed to be written to for reminders (the latest consent of each channel decides). */
  async consentOf(tx: TenantTx, recipientId: string): Promise<Partial<Record<NotifyChannel, boolean>>> {
    const rows = await tx.query<{ channel: string; status: string }>(
      `select distinct on (c.channel) c.channel, c.status from machvon.contact_consent c where c.membership_id = $1::uuid and c.purpose = 'REMINDER' order by c.channel, c.effective_at desc, c.id desc`,
      [recipientId.toLowerCase()],
    );
    const found: Partial<Record<NotifyChannel, boolean>> = {};
    for (const row of rows) if (row.channel === 'SMS' || row.channel === 'ZALO' || row.channel === 'EMAIL' || row.channel === 'PUSH') found[row.channel] = row.status === 'Granted';
    return found;
  }

  /** When the latest digest was decided for the person, or null when none was. */
  async lastDigestAt(tx: TenantTx, recipientId: string): Promise<Date | null> {
    const rows = await tx.query<{ at: string | null }>(`select ${ISO('max(created_at)')} as at from machvon.alert_notification_log where recipient_membership_id = $1::uuid and occasion = 'DIGEST'`, [recipientId.toLowerCase()]);
    const at = rows[0]?.at;
    return at === null || at === undefined ? null : new Date(at);
  }

  /** What the health page counts: the decisions of a window. */
  async forHealth(tx: TenantTx, from: Date, to: Date): Promise<HealthNotice[]> {
    const rows = await tx.query<{ recipient_membership_id: string; local_day: string; channel: string; decision: NotifyDecision; severity: NotifySeverity; in_quiet: boolean; bypass: string | null }>(
      `select recipient_membership_id, local_day::text as local_day, channel, decision, severity, in_quiet, bypass from machvon.alert_notification_log where created_at >= $1::timestamptz and created_at < $2::timestamptz order by created_at, id`,
      [from.toISOString(), to.toISOString()],
    );
    return rows.map((row) => ({ memberId: row.recipient_membership_id, day: row.local_day, channel: row.channel, decision: row.decision, severity: row.severity, inQuiet: row.in_quiet, bypass: row.bypass }));
  }
}
