import { DEFAULT_QUIET_END, DEFAULT_QUIET_START, DEFAULT_TIME_ZONE, DomainError, PREFERENCE_CHANNELS, isValidTimeZone, parseClock, versionConflict } from '@machvon/kernel';
import type { PreferenceChannel, QuietHours } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type DigestMode = 'IMMEDIATE' | 'HOURLY' | 'DAILY';

/** The category that stands for every category (NOT-03: the row of a channel that holds for all events). */
export const ALL_CATEGORIES = '*';

const DIGEST_MODES: readonly string[] = ['IMMEDIATE', 'HOURLY', 'DAILY'];
const CATEGORY = /^(\*|[a-z][a-z0-9_]{0,59})$/;
const MAX_ITEMS = 200;
/** An event of these priorities always reaches the inbox (NOT 3.1 step 4), so the inbox of its category cannot be switched off. */
const URGENT_PRIORITIES = ['CRITICAL', 'HIGH'];

export interface PreferenceItem {
  eventCategory: string;
  channel: PreferenceChannel;
  enabled: boolean;
  digestMode: DigestMode;
}

/** The preferences of one person as stored: version 0 and the defaults for a person who never saved any. */
export interface PreferenceSnapshot {
  version: number;
  /** The hours in force: the person's own, or the default ones (BR-NOT-08) when they never chose; undefined when the person turned quiet hours off. */
  quietHours: Pick<QuietHours, 'start' | 'end'> | undefined;
  timeZone: string;
  items: PreferenceItem[];
  /** True while the person has saved nothing: the hours are the default ones. */
  isDefault: boolean;
}

export interface PreferenceInput {
  items: readonly PreferenceItem[];
  /** Both or neither: without them the person has no quiet hours. */
  quietStart?: string | undefined;
  quietEnd?: string | undefined;
  timeZone?: string | undefined;
}

/** An inbox that cannot be switched off: the category (or every category) holds events that always reach the inbox. */
export interface LockedChannel {
  eventCategory: string;
  channel: PreferenceChannel;
}

interface ProfileSql {
  quiet_start: string | null;
  quiet_end: string | null;
  time_zone: string;
  version: string;
}

interface ItemSql {
  event_category: string;
  channel: PreferenceChannel;
  enabled: boolean;
  digest_mode: DigestMode;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The hours of a profile: the default ones for a person who has none, and none for a person who turned them off. */
function hoursOf(profile: ProfileSql | undefined): Pick<QuietHours, 'start' | 'end'> | undefined {
  if (profile === undefined) return { start: DEFAULT_QUIET_START, end: DEFAULT_QUIET_END };
  return profile.quiet_start === null || profile.quiet_end === null ? undefined : { start: profile.quiet_start.slice(0, 5), end: profile.quiet_end.slice(0, 5) };
}

/**
 * The preferences of a person: which channels they accept for which categories of events, when they are not to be disturbed and in which time zone.
 * The whole set is replaced under one version (`If-Match`); what the set does not name is on (the consent, not the preference, is the gate of a
 * personal channel). Every method runs in the caller's tenant transaction.
 */
export class NotificationPreferenceStore {
  async read(tx: TenantTx, membershipId: string): Promise<PreferenceSnapshot> {
    const profile = await this.profileOf(tx, membershipId);
    const items = await tx.query<ItemSql>(
      'select event_category, channel, enabled, digest_mode from machvon.notification_preference where membership_id = $1::uuid order by event_category, channel',
      [membershipId],
    );
    return {
      version: profile === undefined ? 0 : Number(profile.version),
      quietHours: hoursOf(profile),
      timeZone: profile?.time_zone ?? DEFAULT_TIME_ZONE,
      items: items.map((item) => ({ eventCategory: item.event_category, channel: item.channel, enabled: item.enabled, digestMode: item.digest_mode })),
      isDefault: profile === undefined,
    };
  }

  /**
   * Replaces the preferences of the person under the version they saw (0 for a person who never saved any). A duplicate pair, a category or time zone
   * that does not exist, a clock time that is not one, hours that are half given or empty, and an inbox that is locked are 422; a stale version is 409.
   * Returns the new version.
   */
  async replace(tx: TenantTx, membershipId: string, input: PreferenceInput, expectedVersion: number): Promise<number> {
    this.validate(input);
    const locked = await this.lockedChannels(tx);
    const refused = input.items.find((item) => item.channel === 'IN_APP' && !item.enabled && locked.some((lock) => item.eventCategory === ALL_CATEGORIES || lock.eventCategory === item.eventCategory));
    if (refused !== undefined) throw new DomainError('MANDATORY_CHANNEL_LOCKED', 422, 'items');
    const next = await this.claimProfile(tx, membershipId, expectedVersion);
    await tx.query('delete from machvon.notification_preference where membership_id = $1::uuid', [membershipId]);
    for (const item of input.items) {
      await tx.query(
        `insert into machvon.notification_preference (tenant_id, id, membership_id, event_category, channel, enabled, digest_mode)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4, $5)`,
        [membershipId, item.eventCategory, item.channel, item.enabled, item.digestMode],
      );
    }
    await tx.query(
      `update machvon.notification_preference_profile set quiet_start = $2::time, quiet_end = $3::time, time_zone = $4, version = $5, updated_at = now() where membership_id = $1::uuid`,
      [membershipId, input.quietStart ?? null, input.quietEnd ?? null, input.timeZone ?? DEFAULT_TIME_ZONE, next],
    );
    return next;
  }

  /**
   * Whether the person accepts the channel for the category of an event: the row of the category, else the row of every category, else yes. The
   * inbox of an urgent message is not asked (the caller never asks for it).
   */
  async channelEnabled(tx: TenantTx, membershipId: string, category: string, channel: PreferenceChannel): Promise<boolean> {
    const [row] = await tx.query<{ enabled: boolean }>(
      `select enabled from machvon.notification_preference
        where membership_id = $1::uuid and channel = $3 and event_category in ($2, '*')
        order by (event_category = '*') limit 1`,
      [membershipId, category, channel],
    );
    return row?.enabled ?? true;
  }

  /** The quiet hours in force for the person: theirs, the default ones when they never chose, or none when they turned them off. */
  async quietHoursOf(tx: TenantTx, membershipId: string): Promise<QuietHours | undefined> {
    const profile = await this.profileOf(tx, membershipId);
    const hours = hoursOf(profile);
    return hours === undefined ? undefined : { ...hours, timeZone: profile?.time_zone ?? DEFAULT_TIME_ZONE };
  }

  private async profileOf(tx: TenantTx, membershipId: string): Promise<ProfileSql | undefined> {
    const [profile] = await tx.query<ProfileSql>(
      'select quiet_start::text as quiet_start, quiet_end::text as quiet_end, time_zone, version::text as version from machvon.notification_preference_profile where membership_id = $1::uuid',
      [membershipId],
    );
    return profile;
  }

  /** The channels a person cannot switch off, by category, from the Published workflows (an urgent event always reaches the inbox). */
  async lockedChannels(tx: TenantTx): Promise<LockedChannel[]> {
    const rows = await tx.query<{ category: string }>(
      `select distinct split_part(event_type, '.', 1) as category from machvon.workflow_version
        where kind = 'NOTIFICATION' and status = 'Published' and event_type is not null and definition_json ->> 'priority' = any($1::text[]) order by 1`,
      [URGENT_PRIORITIES],
    );
    return rows.map((row) => ({ eventCategory: row.category, channel: 'IN_APP' }));
  }

  private validate(input: PreferenceInput): void {
    if (input.items.length > MAX_ITEMS) throw invalid('items');
    const seen = new Set<string>();
    for (const item of input.items) {
      if (!CATEGORY.test(item.eventCategory)) throw invalid('items.event_category');
      if (!PREFERENCE_CHANNELS.includes(item.channel)) throw invalid('items.channel');
      if (!DIGEST_MODES.includes(item.digestMode)) throw invalid('items.digest_mode');
      const key = `${item.eventCategory}|${item.channel}`;
      if (seen.has(key)) throw invalid('items');
      seen.add(key);
    }
    if ((input.quietStart === undefined) !== (input.quietEnd === undefined)) throw invalid('quiet_start');
    if (input.quietStart !== undefined && input.quietEnd !== undefined) {
      const start = parseClock(input.quietStart);
      const end = parseClock(input.quietEnd);
      if (start === undefined) throw invalid('quiet_start');
      if (end === undefined || end === start) throw invalid('quiet_end');
    }
    if (input.timeZone !== undefined && !isValidTimeZone(input.timeZone)) throw invalid('time_zone');
  }

  /**
   * Takes the profile under the lock of this transaction, creating it for a person who has none, and returns the version the change will carry (1 for
   * a new profile, else the next one). A version other than the one the person saw is 409, also for the loser of two first saves.
   */
  private async claimProfile(tx: TenantTx, membershipId: string, expectedVersion: number): Promise<number> {
    if (expectedVersion === 0) {
      const created = await tx.query<{ version: string }>(
        `insert into machvon.notification_preference_profile (tenant_id, membership_id) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid)
         on conflict do nothing returning version::text as version`,
        [membershipId],
      );
      if (created[0] !== undefined) return Number(created[0].version);
    }
    const [current] = await tx.query<{ version: string }>('select version::text as version from machvon.notification_preference_profile where membership_id = $1::uuid for update', [membershipId]);
    const version = current === undefined ? 0 : Number(current.version);
    if (current === undefined || version !== expectedVersion) throw versionConflict(version);
    return version + 1;
  }
}
