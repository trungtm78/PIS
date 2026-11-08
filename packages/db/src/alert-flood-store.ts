import { FLOOD_RULE_TYPE, floodPolicyDefaults, floodPolicyOf, stormTransition } from '@machvon/kernel';
import type { FloodPolicy, StormChange, StormState } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

export interface FloodPolicyReading {
  policy: FloodPolicy;
  /** `builtin` when the tenant approved no rule: the version of the rule that decided otherwise. */
  version: string;
  unverified: boolean;
  formula: string | null;
  source: string | null;
  asOf: string | null;
}

export interface FloodEventRow {
  id: string;
  membershipId: string;
  startedAt: string;
  endedAt: string | null;
  peakNew: number;
  groupedCount: number;
  windowMinutes: number;
  startThreshold: number;
  endThreshold: number;
  policyVersion: string;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The storms of the alert centre, one row per storm of a person (G2-11). */
export class AlertFloodStore {
  private readonly port = new GovernancePolicyPort();

  /** The flood policy in force today: the approved rule of the tenant or the built-in default; a rule that does not read falls back to the default (it is flagged as such). */
  async policy(tx: TenantTx, today: string): Promise<FloodPolicyReading> {
    const resolved = await this.port.get(tx, FLOOD_RULE_TYPE, 'DEFAULT', today);
    if (resolved === undefined) return { policy: floodPolicyDefaults(), version: 'builtin', unverified: true, formula: null, source: null, asOf: null };
    let policy: FloodPolicy;
    try {
      policy = floodPolicyOf(resolved.params);
    } catch {
      return { policy: floodPolicyDefaults(), version: 'builtin', unverified: true, formula: resolved.provenance?.formula ?? null, source: resolved.provenance?.source ?? null, asOf: resolved.provenance?.asOf ?? null };
    }
    return { policy, version: resolved.source === 'DEFAULT' ? 'builtin' : String(resolved.version), unverified: resolved.unverified, formula: resolved.provenance?.formula ?? null, source: resolved.provenance?.source ?? null, asOf: resolved.provenance?.asOf ?? null };
  }

  /** The storm that is open for a person, or none. */
  async current(tx: TenantTx, membershipId: string): Promise<StormState> {
    const [row] = await tx.query<{ started_at: string }>(`select ${ISO('started_at')} as started_at from machvon.alert_flood_event where membership_id = $1::uuid and ended_at is null`, [membershipId]);
    return row === undefined ? { active: false, since: null } : { active: true, since: row.started_at };
  }

  /**
   * Looks at the number of new alerts a person got in the window and starts or ends their storm. The transition is the kernel's; this writes it: a start inserts the row (one open storm per person, so two passes cannot
   * open two), an end closes it, and while a storm lasts its peak and its grouped count only grow.
   */
  async observe(tx: TenantTx, membershipId: string, input: { newInWindow: number; grouped: number; now: Date; reading: FloodPolicyReading }): Promise<{ change: StormChange; state: StormState }> {
    const previous = await this.current(tx, membershipId);
    const { next, change } = stormTransition(previous, input.newInWindow, input.reading.policy, input.now);
    if (change === 'STARTED') {
      await tx.query(
        `insert into machvon.alert_flood_event (tenant_id, membership_id, started_at, peak_new, window_minutes, start_threshold, end_threshold, grouped_count, policy_version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::timestamptz, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
        [membershipId, input.now.toISOString(), input.newInWindow, input.reading.policy.window_minutes, input.reading.policy.start_above, input.reading.policy.end_below, input.grouped, input.reading.version],
      );
    } else if (change === 'ENDED') {
      await tx.query('update machvon.alert_flood_event set ended_at = $2::timestamptz where membership_id = $1::uuid and ended_at is null', [membershipId, input.now.toISOString()]);
    } else if (previous.active) {
      await tx.query(
        'update machvon.alert_flood_event set peak_new = greatest(peak_new, $2), grouped_count = greatest(grouped_count, $3) where membership_id = $1::uuid and ended_at is null',
        [membershipId, input.newInWindow, input.grouped],
      );
    }
    return { change, state: next };
  }

  /** The storms of a period of days, newest first, and how long each lasted so far. */
  async list(tx: TenantTx, from: string, to: string, limit: number): Promise<FloodEventRow[]> {
    const rows = await tx.query<{ id: string; membership_id: string; started_at: string; ended_at: string | null; peak_new: number; grouped_count: number; window_minutes: number; start_threshold: number; end_threshold: number; policy_version: string }>(
      `select id, membership_id, ${ISO('started_at')} as started_at, ${ISO('ended_at')} as ended_at, peak_new, grouped_count, window_minutes, start_threshold, end_threshold, policy_version
         from machvon.alert_flood_event where started_at >= $1::date and started_at < $2::date order by started_at desc, id desc limit $3`,
      [from, to, limit],
    );
    return rows.map((row) => ({ id: row.id, membershipId: row.membership_id, startedAt: row.started_at, endedAt: row.ended_at, peakNew: row.peak_new, groupedCount: row.grouped_count, windowMinutes: row.window_minutes, startThreshold: row.start_threshold, endThreshold: row.end_threshold, policyVersion: row.policy_version }));
  }
}
