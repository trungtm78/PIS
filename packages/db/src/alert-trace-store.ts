import type { HealthGap, HealthItem, NotifySeverity, TraceState } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** What one pass of the job saw of one item of a person's list. */
export interface TraceObservation {
  source: string;
  sourceId: string;
  kind: string;
  typeCode: string;
  severity: NotifySeverity;
  lifecycle: 'NEW' | 'CLAIMED' | 'IN_PROGRESS';
  /** The module's own start, else the moment of this pass. */
  startedAt: Date;
  firstClaimAt: Date | null;
  dueAt: Date | null;
  claimDueAt: Date | null;
  snoozeCount: number;
  levelsConfigured: number;
  pauses: ReadonlyArray<{ from: string; until: string }>;
  /** The item says it is done (its lifecycle is RESOLVED). */
  resolved: boolean;
}

export interface TraceRow {
  source: string;
  sourceId: string;
  state: TraceState;
  severity: NotifySeverity;
  ownerId: string | null;
  firstSeenAt: string;
  startedAt: string;
  maxEscalationLevel: number;
  promoted: boolean;
}

export type GapKind = 'ABSENT_NO_COVER' | 'ABSENCE_STARTING_UNCOVERED' | 'OWNER_INACTIVE' | 'NO_LEADER' | 'FUNCTION_VACANT' | 'POSITION_UNCOVERED';
/** The kinds that leave an alert with nobody to receive it: what the health page counts as orphaned. */
export const ORPHAN_GAP_KINDS: readonly GapKind[] = ['ABSENT_NO_COVER', 'OWNER_INACTIVE', 'NO_LEADER'];

export interface GapDesired {
  kind: GapKind;
  subjectKey: string;
  membershipId: string | null;
  unitId: string | null;
  absenceId: string | null;
  itemCount: number;
}

export interface GapRecord extends GapDesired {
  id: string;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
}

export type GapCloseReason = 'COVERED' | 'BACK' | 'RESOLVED' | 'ABSENCE_ENDED';

/**
 * What the alert centre recorded of the life of each item (G2-10): written only by the job, read by the health page and by the escalation. The items are the same ones the lists show, seen every quarter of an hour; an item that no
 * longer appears while its source could be read is CLEARED (its condition is gone), one that says it is done is RESOLVED. An item that comes back after it was closed is opened again and counted.
 */
export class AlertTraceStore {
  /** Writes what a pass saw of the items of one person: new items are created, known ones are refreshed, closed ones that reappear are opened again. */
  async observe(tx: TenantTx, ownerId: string, unitId: string | null, items: readonly TraceObservation[], now: Date): Promise<number> {
    if (items.length === 0) return 0;
    const column = <T>(pick: (item: TraceObservation) => T): T[] => items.map(pick);
    await tx.query(
      `insert into machvon.alert_item_trace (tenant_id, source, source_id, kind, type_code, severity, severity_first, lifecycle, owner_membership_id, owner_unit_id, started_at, first_seen_at, last_seen_at, first_claim_at, due_at, claim_due_at,
                                             last_change_at, state, closed_at, levels_configured, snooze_count, pauses)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, i.source, i.source_id, i.kind, i.type_code, i.severity, i.severity, i.lifecycle, $1::uuid, $2::uuid, i.started_at, $3::timestamptz, $3::timestamptz, i.first_claim_at, i.due_at, i.claim_due_at,
              $3::timestamptz, case when i.resolved then 'RESOLVED' else 'OPEN' end, case when i.resolved then $3::timestamptz else null end, i.levels_configured, i.snooze_count, i.pauses::jsonb
         from unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::timestamptz[], $11::timestamptz[], $12::timestamptz[], $13::timestamptz[], $14::int[], $15::int[], $16::text[], $17::boolean[])
              as i (source, source_id, kind, type_code, severity, lifecycle, started_at, first_claim_at, due_at, claim_due_at, snooze_count, levels_configured, pauses, resolved)
       on conflict (tenant_id, source, source_id) do update set
         kind = excluded.kind,
         type_code = excluded.type_code,
         last_seen_at = excluded.last_seen_at,
         owner_membership_id = excluded.owner_membership_id,
         owner_unit_id = excluded.owner_unit_id,
         first_claim_at = coalesce(machvon.alert_item_trace.first_claim_at, excluded.first_claim_at),
         due_at = excluded.due_at,
         claim_due_at = excluded.claim_due_at,
         levels_configured = excluded.levels_configured,
         snooze_count = greatest(machvon.alert_item_trace.snooze_count, excluded.snooze_count),
         pauses = excluded.pauses,
         last_change_at = case when machvon.alert_item_trace.state <> excluded.state or machvon.alert_item_trace.lifecycle <> excluded.lifecycle or machvon.alert_item_trace.severity <> excluded.severity
                               or excluded.snooze_count > machvon.alert_item_trace.snooze_count or (machvon.alert_item_trace.first_claim_at is null and excluded.first_claim_at is not null)
                               then excluded.last_change_at else machvon.alert_item_trace.last_change_at end,
         reopen_count = machvon.alert_item_trace.reopen_count + case when machvon.alert_item_trace.state <> 'OPEN' and excluded.state = 'OPEN' then 1 else 0 end,
         severity = excluded.severity,
         lifecycle = excluded.lifecycle,
         state = excluded.state,
         closed_at = case when excluded.state = 'OPEN' then null else coalesce(machvon.alert_item_trace.closed_at, excluded.closed_at) end`,
      [
        ownerId.toLowerCase(),
        unitId,
        now.toISOString(),
        column((item) => item.source),
        column((item) => item.sourceId),
        column((item) => item.kind),
        column((item) => item.typeCode),
        column((item) => item.severity),
        column((item) => item.lifecycle),
        column((item) => item.startedAt.toISOString()),
        column((item) => item.firstClaimAt?.toISOString() ?? null),
        column((item) => item.dueAt?.toISOString() ?? null),
        column((item) => item.claimDueAt?.toISOString() ?? null),
        column((item) => item.snoozeCount),
        column((item) => item.levelsConfigured),
        column((item) => JSON.stringify(item.pauses)),
        column((item) => item.resolved),
      ],
    );
    return items.length;
  }

  /**
   * Closes as CLEARED the open items of the people whose lists were read in this pass and that did not appear in it (their condition is gone), except the items of a source that could not be read for that person (it never says an item
   * is gone). `unavailable` lists, for each person, the sources that failed.
   */
  async clearUnseen(tx: TenantTx, passStart: Date, readers: ReadonlyArray<{ membershipId: string; unavailable: readonly string[] }>, now: Date): Promise<number> {
    if (readers.length === 0) return 0;
    const cleared = await tx.query<{ id: string }>(
      `update machvon.alert_item_trace t set state = 'CLEARED', closed_at = $4::timestamptz, last_change_at = $4::timestamptz
         from unnest($1::uuid[], $2::text[]) as r (membership_id, unavailable)
        where t.owner_membership_id = r.membership_id and t.state = 'OPEN' and t.last_seen_at < $3::timestamptz
          and not (t.source = any(string_to_array(r.unavailable, ',')))
        returning t.id`,
      [readers.map((reader) => reader.membershipId.toLowerCase()), readers.map((reader) => reader.unavailable.join(',')), passStart.toISOString(), now.toISOString()],
    );
    return cleared.length;
  }

  /** The open items whose owner is not in force any more (they left): nobody's list shows them. */
  async openOfInactiveOwners(tx: TenantTx, now: Date): Promise<Array<{ ownerId: string; unitId: string | null; count: number }>> {
    const rows = await tx.query<{ owner_id: string; unit_id: string | null; count: string }>(
      `select t.owner_membership_id as owner_id, m.organization_id as unit_id, count(*)::text as count
         from machvon.alert_item_trace t join machvon.membership m on m.tenant_id = t.tenant_id and m.id = t.owner_membership_id
        where t.state = 'OPEN' and not (m.status = 'Active' and m.valid_from <= $1::timestamptz and (m.valid_until is null or m.valid_until > $1::timestamptz))
        group by t.owner_membership_id, m.organization_id order by t.owner_membership_id`,
      [now.toISOString()],
    );
    return rows.map((row) => ({ ownerId: row.owner_id, unitId: row.unit_id, count: Number(row.count) }));
  }

  /** The open items of a person (what a gap about them leaves without a recipient). */
  async openOf(tx: TenantTx, ownerId: string): Promise<TraceRow[]> {
    const rows = await tx.query<{ source: string; source_id: string; state: TraceState; severity: NotifySeverity; owner_id: string | null; first_seen_at: string; started_at: string; max_escalation_level: number; promoted: boolean }>(
      `select source, source_id, state, severity, owner_membership_id as owner_id, ${ISO('first_seen_at')} as first_seen_at, ${ISO('started_at')} as started_at, max_escalation_level, promoted
         from machvon.alert_item_trace where owner_membership_id = $1::uuid and state = 'OPEN' order by first_seen_at, id`,
      [ownerId.toLowerCase()],
    );
    return rows.map((row) => ({ source: row.source, sourceId: row.source_id, state: row.state, severity: row.severity, ownerId: row.owner_id, firstSeenAt: row.first_seen_at, startedAt: row.started_at, maxEscalationLevel: row.max_escalation_level, promoted: row.promoted }));
  }

  /** Raises the highest level an item went up to, and marks it promoted when asked. */
  async noteEscalation(tx: TenantTx, source: string, sourceId: string, level: number, promoted: boolean): Promise<void> {
    await tx.query(
      `update machvon.alert_item_trace set max_escalation_level = greatest(max_escalation_level, $3::int), promoted = promoted or $4::boolean where source = $1 and source_id = $2`,
      [source, sourceId, level, promoted],
    );
  }

  /** The moment of the latest pass that wrote an item, or null when no pass ever did. */
  async lastPassAt(tx: TenantTx): Promise<Date | null> {
    const rows = await tx.query<{ at: string | null }>(`select ${ISO('max(last_seen_at)')} as at from machvon.alert_item_trace`);
    const at = rows[0]?.at;
    return at === null || at === undefined ? null : new Date(at);
  }

  /** The items the health of a window is computed from: those that began, were taken up or closed in it, and every open one. */
  async forHealth(tx: TenantTx, from: Date, to: Date, unitId: string | null): Promise<HealthItem[]> {
    const rows = await tx.query<{
      source: string;
      type_code: string;
      severity: NotifySeverity;
      owner_id: string | null;
      unit_id: string | null;
      started_at: string;
      first_seen_at: string;
      first_claim_at: string | null;
      state: TraceState;
      closed_at: string | null;
      due_at: string | null;
      last_change_at: string;
      max_escalation_level: number;
      levels_configured: number;
      snooze_count: number;
      pauses: Array<{ from: string; until: string }>;
    }>(
      `select source, type_code, severity, owner_membership_id as owner_id, owner_unit_id as unit_id, ${ISO('started_at')} as started_at, ${ISO('first_seen_at')} as first_seen_at, ${ISO('first_claim_at')} as first_claim_at, state,
              ${ISO('closed_at')} as closed_at, ${ISO('due_at')} as due_at, ${ISO('last_change_at')} as last_change_at, max_escalation_level, levels_configured, snooze_count, pauses
         from machvon.alert_item_trace
        where ($3::uuid is null or owner_unit_id = $3::uuid)
          and (state = 'OPEN' or (first_seen_at >= $1::timestamptz and first_seen_at < $2::timestamptz) or (first_claim_at >= $1::timestamptz and first_claim_at < $2::timestamptz) or (closed_at >= $1::timestamptz and closed_at < $2::timestamptz))
        order by first_seen_at, id`,
      [from.toISOString(), to.toISOString(), unitId],
    );
    return rows.map((row) => ({
      source: row.source,
      typeCode: row.type_code,
      severity: row.severity,
      ownerId: row.owner_id,
      unitId: row.unit_id,
      startedAt: new Date(row.started_at),
      firstSeenAt: new Date(row.first_seen_at),
      firstClaimAt: row.first_claim_at === null ? null : new Date(row.first_claim_at),
      state: row.state,
      closedAt: row.closed_at === null ? null : new Date(row.closed_at),
      dueAt: row.due_at === null ? null : new Date(row.due_at),
      lastChangeAt: new Date(row.last_change_at),
      maxEscalationLevel: row.max_escalation_level,
      levelsConfigured: row.levels_configured,
      snoozeCount: row.snooze_count,
      pauses: row.pauses.map((span) => ({ from: new Date(span.from), until: new Date(span.until) })),
    }));
  }
}

/** The routing gaps: opened and closed by the job, so the time to reroute is measured. */
export class AlertGapStore {
  /**
   * Brings the open gaps of some kinds in line with what the pass found: a gap that is found and not open is opened, one that is open and found again has its count refreshed, one that is open and not found any more is closed with the
   * reason `reasonOf` gives. Opening twice opens once (the open gap of a cause is unique).
   */
  async sync(tx: TenantTx, kinds: readonly GapKind[], desired: readonly GapDesired[], now: Date, reasonOf: (open: GapRecord) => GapCloseReason): Promise<{ opened: GapRecord[]; closed: GapRecord[] }> {
    const open = await this.list(tx, { kinds, open: true });
    const wanted = new Map(desired.map((gap) => [gap.subjectKey, gap]));
    const known = new Map(open.map((gap) => [gap.subjectKey, gap]));
    const opened: GapRecord[] = [];
    const closed: GapRecord[] = [];
    for (const gap of desired) {
      const existing = known.get(gap.subjectKey);
      if (existing !== undefined) {
        if (existing.itemCount !== gap.itemCount) await tx.query('update machvon.alert_routing_gap set item_count = $2::int where id = $1::uuid', [existing.id, gap.itemCount]);
        continue;
      }
      const [created] = await tx.query<{ id: string }>(
        `insert into machvon.alert_routing_gap (tenant_id, kind, subject_key, membership_id, unit_id, absence_id, item_count, opened_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3::uuid, $4::uuid, $5::uuid, $6::int, $7::timestamptz)
         on conflict (tenant_id, subject_key) where closed_at is null do nothing returning id`,
        [gap.kind, gap.subjectKey, gap.membershipId, gap.unitId, gap.absenceId, gap.itemCount, now.toISOString()],
      );
      if (created !== undefined) opened.push({ ...gap, id: created.id, openedAt: now.toISOString(), closedAt: null, closeReason: null });
    }
    for (const gap of open) {
      if (wanted.has(gap.subjectKey)) continue;
      const reason = reasonOf(gap);
      await tx.query('update machvon.alert_routing_gap set closed_at = $2::timestamptz, close_reason = $3 where id = $1::uuid and closed_at is null', [gap.id, now.toISOString(), reason]);
      closed.push({ ...gap, closedAt: now.toISOString(), closeReason: reason });
    }
    return { opened, closed };
  }

  async list(tx: TenantTx, query: { kinds?: readonly GapKind[]; open?: boolean; from?: Date; to?: Date }): Promise<GapRecord[]> {
    const rows = await tx.query<{
      id: string;
      kind: GapKind;
      subject_key: string;
      membership_id: string | null;
      unit_id: string | null;
      absence_id: string | null;
      item_count: number;
      opened_at: string;
      closed_at: string | null;
      close_reason: string | null;
    }>(
      `select id, kind, subject_key, membership_id, unit_id, absence_id, item_count, ${ISO('opened_at')} as opened_at, ${ISO('closed_at')} as closed_at, close_reason
         from machvon.alert_routing_gap
        where ($1::text[] is null or kind = any($1::text[]))
          and ($2::boolean is null or ((closed_at is null) = $2::boolean))
          and ($3::timestamptz is null or closed_at is null or closed_at >= $3::timestamptz)
          and ($4::timestamptz is null or opened_at < $4::timestamptz)
        order by opened_at desc, id limit 1000`,
      [query.kinds === undefined ? null : [...query.kinds], query.open ?? null, query.from?.toISOString() ?? null, query.to?.toISOString() ?? null],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      subjectKey: row.subject_key,
      membershipId: row.membership_id,
      unitId: row.unit_id,
      absenceId: row.absence_id,
      itemCount: row.item_count,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      closeReason: row.close_reason,
    }));
  }

  /** The gaps the health page counts, as the rules read them: those that leave an alert with nobody, open now or closed in the window. */
  async forHealth(tx: TenantTx, from: Date, to: Date): Promise<HealthGap[]> {
    const rows = await this.list(tx, { kinds: ORPHAN_GAP_KINDS, from, to });
    return rows.map((row) => ({ kind: row.kind, itemCount: row.itemCount, openedAt: new Date(row.openedAt), closedAt: row.closedAt === null ? null : new Date(row.closedAt) }));
  }
}
