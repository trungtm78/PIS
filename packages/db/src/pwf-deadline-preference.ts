import { DomainError, pwfDeadlineBand, versionConflict, vietnamDateOf } from '@machvon/kernel';
import { PwfBandPolicies } from './pwf-band-policies.ts';
import type { BandPolicySet } from './pwf-band-policies.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The personal tier of the three colours (BR-PWF-23, R40): the days at which THIS person wants green, yellow and red to start, and the extra reminder days they want, kept in the row of their profile of alerts
 * (`alert_notification_profile`, V2003; the columns are NULL until they set them: NULL is the official line). A personal level may start earlier than the official one, never later: it is refused when it is saved and, when the
 * official rule has moved past it since, it is raised to the official line when it is read and named. It changes the colour and the reminders the person sees, never the official colour, the escalation or a KPI.
 *
 * The row is the profile's: it has one version, which the commands on either side of it check, so a stale form on one of them is refused (409 VERSION_CONFLICT) instead of overwriting the other.
 */

export interface StoredPreference {
  green_days: number | null;
  yellow_days: number | null;
  red_days: number | null;
  reminder_days: number[];
  /** 0 for a person who never saved any choice of alerts: nothing is stored yet. */
  version: number;
}

export interface PreferenceReading extends StoredPreference {
  /** The ladder in force for the person's own unit. */
  official: pwfDeadlineBand.BandThresholds;
  /** The levels the person set that the official rule has since passed. */
  clamped: Array<keyof pwfDeadlineBand.BandThresholds>;
  /** The official reminder days of the rule for the person's unit. */
  officialReminderDays: number[];
}

interface ProfileSql {
  deadline_green_days: number | null;
  deadline_yellow_days: number | null;
  deadline_red_days: number | null;
  personal_reminder_days: number[] | null;
  version: string;
}

export const EMPTY_PREFERENCE: StoredPreference = { green_days: null, yellow_days: null, red_days: null, reminder_days: [], version: 0 };

/** The thresholds a person set, as the partial ladder the kernel merges: what they left empty is not there. */
export function personalThresholdsOf(stored: Pick<StoredPreference, 'green_days' | 'yellow_days' | 'red_days'>): pwfDeadlineBand.PersonalThresholds {
  return {
    ...(stored.green_days === null ? {} : { green_days: stored.green_days }),
    ...(stored.yellow_days === null ? {} : { yellow_days: stored.yellow_days }),
    ...(stored.red_days === null ? {} : { red_days: stored.red_days }),
  };
}

export const hasPersonalLadder = (stored: Pick<StoredPreference, 'green_days' | 'yellow_days' | 'red_days'>): boolean => stored.green_days !== null || stored.yellow_days !== null || stored.red_days !== null;

export class PwfDeadlinePreferenceStore {
  private readonly policies = new PwfBandPolicies();

  /** What a person stored (nothing at version 0). */
  async stored(tx: TenantTx, membershipId: string): Promise<StoredPreference> {
    const rows = await tx.query<ProfileSql>(
      'select deadline_green_days, deadline_yellow_days, deadline_red_days, personal_reminder_days, version::text as version from machvon.alert_notification_profile where membership_id = $1::uuid',
      [membershipId.toLowerCase()],
    );
    const row = rows[0];
    if (row === undefined) return { ...EMPTY_PREFERENCE };
    return { green_days: row.deadline_green_days, yellow_days: row.deadline_yellow_days, red_days: row.deadline_red_days, reminder_days: row.personal_reminder_days ?? [], version: Number(row.version) };
  }

  /** The path of the unit a person belongs to (the unit their official rule is read for), or null when they belong to none. */
  private async unitPathOf(tx: TenantTx, membershipId: string): Promise<string | null> {
    const rows = await tx.query<{ path: string }>(
      'select u.path from machvon.membership m join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id where m.id = $1::uuid',
      [membershipId.toLowerCase()],
    );
    return rows[0]?.path ?? null;
  }

  /** The official policy for the unit of the person, and the set of policies it came from (for the tasks of other units). */
  async official(tx: TenantTx, membershipId: string, today: string): Promise<{ policy: pwfDeadlineBand.BandPolicy; set: BandPolicySet }> {
    const set = await this.policies.load(tx, today);
    return { policy: set.forUnitPath(await this.unitPathOf(tx, membershipId)), set };
  }

  async read(tx: TenantTx, membershipId: string, now: Date): Promise<PreferenceReading> {
    const stored = await this.stored(tx, membershipId);
    const { policy } = await this.official(tx, membershipId, vietnamDateOf(now));
    const official: pwfDeadlineBand.BandThresholds = { green_days: policy.green_days, yellow_days: policy.yellow_days, red_days: policy.red_days };
    return { ...stored, official, clamped: pwfDeadlineBand.clampedLevels(official, personalThresholdsOf(stored)), officialReminderDays: [...policy.reminder_days] };
  }

  /**
   * Saves the preference of a person under the version they read (0 when nothing was stored): the kernel judges it against the official ladder of their unit (422 DEADLINE_BAND_THRESHOLDS_INVALID or
   * DEADLINE_PERSONAL_NOT_EARLIER naming the field), a stale version is 409 VERSION_CONFLICT. All three levels null and no reminder days clear it. Returns the new version.
   */
  async save(tx: TenantTx, membershipId: string, input: pwfDeadlineBand.PersonalPreference, expectedVersion: number, now: Date): Promise<number> {
    const { policy } = await this.official(tx, membershipId, vietnamDateOf(now));
    pwfDeadlineBand.assertPersonalPreference({ green_days: policy.green_days, yellow_days: policy.yellow_days, red_days: policy.red_days }, input);
    const current = await this.stored(tx, membershipId);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    const values = [input.green_days, input.yellow_days, input.red_days, [...input.reminder_days]];
    if (current.version === 0) {
      await tx.query(
        `insert into machvon.alert_notification_profile (tenant_id, membership_id, deadline_green_days, deadline_yellow_days, deadline_red_days, personal_reminder_days)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $5::uuid, $1::int, $2::int, $3::int, $4::int[])`,
        [...values, membershipId.toLowerCase()],
      );
      return 1;
    }
    const updated = await tx.query<{ version: string }>(
      `update machvon.alert_notification_profile set deadline_green_days = $1::int, deadline_yellow_days = $2::int, deadline_red_days = $3::int, personal_reminder_days = $4::int[], version = version + 1, updated_at = now()
        where membership_id = $5::uuid and version = $6::bigint returning version::text as version`,
      [...values, membershipId.toLowerCase(), expectedVersion],
    );
    if (updated[0] === undefined) throw new DomainError('VERSION_CONFLICT', 409);
    return Number(updated[0].version);
  }
}
