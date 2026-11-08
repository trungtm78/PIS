import { DomainError } from '@machvon/kernel';
import type { AcknowledgedLevel, EscalationCandidate, EscalationKind, EscalationOwner, EscalationTrigger, EscalationVia } from '@machvon/kernel';
import { actionKey } from './home-work-action-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const CHUNK = 1000;
const LIST_LIMIT = 200;

export type AlertEscalationStatus = 'OPEN' | 'ACKNOWLEDGED' | 'CLOSED';
export type EscalationCloseReason = 'RESOLVED' | 'SOURCE_CLEARED' | 'OWNER_BACK';
export type RoutedVia = EscalationVia | 'DEPUTY' | 'NONE';

export interface EscalationRecord {
  id: string;
  source: string;
  sourceId: string;
  level: number;
  kind: EscalationKind | 'PROMOTION';
  trigger: EscalationTrigger | 'WATCH_AGED';
  recipientId: string | null;
  recipientName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  routedVia: RoutedVia;
  coverId: string | null;
  severity: 'URGENT' | 'ACTION' | 'WATCH';
  fromSeverity: 'URGENT' | 'ACTION' | 'WATCH' | null;
  itemTitle: string;
  itemSubtitle: string | null;
  itemDueOn: string | null;
  target: { screen: string; id: string };
  reachedAt: string;
  policyVersion: string;
  status: AlertEscalationStatus;
  acknowledgedAt: string | null;
  closedAt: string | null;
  closeReason: EscalationCloseReason | null;
  createdAt: string;
}

export interface AlertEscalationInput {
  source: string;
  sourceId: string;
  /** The occurrence of the item (the reopen count of its trace): what a level or a promotion belongs to. */
  occurrence: number;
  level: number;
  kind: EscalationKind | 'PROMOTION';
  trigger: EscalationTrigger | 'WATCH_AGED';
  recipientId: string | null;
  ownerId: string | null;
  routedVia: RoutedVia;
  coverId: string | null;
  severity: 'URGENT' | 'ACTION' | 'WATCH';
  fromSeverity: 'URGENT' | 'ACTION' | 'WATCH' | null;
  itemTitle: string;
  itemSubtitle: string | null;
  itemDueOn: string | null;
  target: { screen: string; id: string };
  reachedAt: Date;
  policyVersion: string;
  seriesKey: string;
}

/** What is known of the climb of one item: the levels recorded, how far it went, and the levels a recipient acknowledged. */
export interface ItemClimb {
  levels: Set<number>;
  acknowledged: AcknowledgedLevel[];
  max: number;
  promoted: boolean;
}

interface Sql {
  id: string;
  source: string;
  source_id: string;
  level: number;
  kind: EscalationRecord['kind'];
  trigger: EscalationRecord['trigger'];
  recipient_id: string | null;
  recipient_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  routed_via: RoutedVia;
  cover_id: string | null;
  severity: EscalationRecord['severity'];
  from_severity: EscalationRecord['fromSeverity'];
  item_title: string;
  item_subtitle: string | null;
  item_due_on: string | null;
  target_screen: string;
  target_id: string;
  reached_at: string;
  policy_version: string;
  status: AlertEscalationStatus;
  acknowledged_at: string | null;
  closed_at: string | null;
  close_reason: EscalationCloseReason | null;
  created_at: string;
}

const FROM = `machvon.alert_escalation e
  left join machvon.tenant_user_directory dr on dr.tenant_id = e.tenant_id and dr.membership_id = e.recipient_membership_id
  left join machvon.tenant_user_directory dw on dw.tenant_id = e.tenant_id and dw.membership_id = e.owner_membership_id`;
const COLUMNS = `e.id, e.source, e.source_id, e.level, e.kind, e.trigger, e.recipient_membership_id as recipient_id, dr.display_name as recipient_name, e.owner_membership_id as owner_id, dw.display_name as owner_name, e.routed_via,
  e.cover_id, e.severity, e.from_severity, e.item_title, e.item_subtitle, e.item_due_on::text as item_due_on, e.target_screen, e.target_id, ${ISO('e.reached_at')} as reached_at, e.policy_version, e.status,
  ${ISO('e.acknowledged_at')} as acknowledged_at, ${ISO('e.closed_at')} as closed_at, e.close_reason, ${ISO('e.created_at')} as created_at`;

const toRecord = (row: Sql): EscalationRecord => ({
  id: row.id,
  source: row.source,
  sourceId: row.source_id,
  level: row.level,
  kind: row.kind,
  trigger: row.trigger,
  recipientId: row.recipient_id,
  recipientName: row.recipient_name,
  ownerId: row.owner_id,
  ownerName: row.owner_name,
  routedVia: row.routed_via,
  coverId: row.cover_id,
  severity: row.severity,
  fromSeverity: row.from_severity,
  itemTitle: row.item_title,
  itemSubtitle: row.item_subtitle,
  itemDueOn: row.item_due_on,
  target: { screen: row.target_screen, id: row.target_id },
  reachedAt: row.reached_at,
  policyVersion: row.policy_version,
  status: row.status,
  acknowledgedAt: row.acknowledged_at,
  closedAt: row.closed_at,
  closeReason: row.close_reason,
  createdAt: row.created_at,
});

/** The segments two unit paths share from the root: how near two places are in the tree. */
export function commonDepth(left: string, right: string): number {
  const a = left.split('/').filter((part) => part !== '');
  const b = right.split('/').filter((part) => part !== '');
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * The levels an item of the alert centre was sent up (G2-3): appended by the job with the event that carries them, acknowledged by the person who received a level, closed when the item is done. The recipients are found here from the
 * grants and the units, and the rules that choose among them are the kernel's.
 */
export class AlertEscalationStore {
  /** Records one row of a level (or a promotion); the one row of a series is recorded once. */
  async record(tx: TenantTx, input: AlertEscalationInput): Promise<{ id: string; created: boolean }> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.alert_escalation (tenant_id, source, source_id, level, kind, trigger, recipient_membership_id, owner_membership_id, routed_via, cover_id, severity, from_severity, item_title, item_subtitle, item_due_on,
                                             target_screen, target_id, reached_at, policy_version, series_key, occurrence)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3::int, $4, $5, $6::uuid, $7::uuid, $8, $9::uuid, $10, $11, $12, $13, $14::date, $15, $16, $17::timestamptz, $18, $19, $20::int)
       on conflict (tenant_id, series_key) do nothing returning id`,
      [
        input.source,
        input.sourceId,
        input.level,
        input.kind,
        input.trigger,
        input.recipientId?.toLowerCase() ?? null,
        input.ownerId?.toLowerCase() ?? null,
        input.routedVia,
        input.coverId,
        input.severity,
        input.fromSeverity,
        input.itemTitle.slice(0, 300),
        input.itemSubtitle === null ? null : input.itemSubtitle.slice(0, 300),
        input.itemDueOn,
        input.target.screen,
        input.target.id,
        input.reachedAt.toISOString(),
        input.policyVersion,
        input.seriesKey,
        input.occurrence,
      ],
    );
    if (inserted[0] !== undefined) return { id: inserted[0].id, created: true };
    const [existing] = await tx.query<{ id: string }>('select id from machvon.alert_escalation where series_key = $1', [input.seriesKey]);
    return { id: (existing as { id: string }).id, created: false };
  }

  /** What is recorded of the climb of each item: the levels, the ones acknowledged, the highest, whether it was promoted. An item with none is not in the map. */
  async climbOf(tx: TenantTx, items: ReadonlyArray<{ source: string; sourceId: string }>): Promise<Map<string, ItemClimb>> {
    const climbs = new Map<string, ItemClimb>();
    for (let from = 0; from < items.length; from += CHUNK) {
      const chunk = items.slice(from, from + CHUNK);
      const rows = await tx.query<{ source: string; source_id: string; level: number; kind: string; acknowledged_at: string | null }>(
        `select e.source, e.source_id, e.level, e.kind, ${ISO('e.acknowledged_at')} as acknowledged_at
           from machvon.alert_escalation e join unnest($1::text[], $2::text[]) as k (source, source_id) on k.source = e.source and k.source_id = e.source_id
           left join machvon.alert_item_trace t on t.tenant_id = e.tenant_id and t.source = e.source and t.source_id = e.source_id
          where e.occurrence = coalesce(t.reopen_count, 0)`,
        [chunk.map((item) => item.source), chunk.map((item) => item.sourceId)],
      );
      for (const row of rows) {
        const key = actionKey(row.source, row.source_id);
        const climb = climbs.get(key) ?? { levels: new Set<number>(), acknowledged: [], max: 0, promoted: false };
        if (row.kind === 'PROMOTION') climb.promoted = true;
        else {
          climb.levels.add(row.level);
          climb.max = Math.max(climb.max, row.level);
          if (row.acknowledged_at !== null) climb.acknowledged.push({ level: row.level, ackedAt: new Date(row.acknowledged_at) });
        }
        climbs.set(key, climb);
      }
    }
    return climbs;
  }

  /** The rows a person received that are still to be dealt with (open or acknowledged), oldest first. */
  async openFor(tx: TenantTx, recipientId: string): Promise<EscalationRecord[]> {
    const rows = await tx.query<Sql>(
      `select ${COLUMNS} from ${FROM} where e.recipient_membership_id = $1::uuid and e.status in ('OPEN', 'ACKNOWLEDGED') order by e.reached_at, e.id limit 2000`,
      [recipientId.toLowerCase()],
    );
    return rows.map(toRecord);
  }

  async find(tx: TenantTx, id: string): Promise<EscalationRecord | undefined> {
    const rows = await tx.query<Sql>(`select ${COLUMNS} from ${FROM} where e.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRecord(rows[0]);
  }

  /** The recipient acknowledges the row once: 404 when it is not theirs, 409 when it was already acknowledged or closed. */
  async acknowledge(tx: TenantTx, id: string, recipientId: string, now: Date): Promise<{ record: EscalationRecord }> {
    const current = await this.find(tx, id);
    if (current === undefined || current.recipientId?.toLowerCase() !== recipientId.toLowerCase()) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (current.status !== 'OPEN') throw new DomainError('ALERT_ESCALATION_STATE_INVALID', 409, 'status');
    await tx.query(`update machvon.alert_escalation set status = 'ACKNOWLEDGED', acknowledged_at = $2::timestamptz where id = $1::uuid`, [id, now.toISOString()]);
    return { record: (await this.find(tx, id)) as EscalationRecord };
  }

  /** Closes every open row of an item (it is done, or it is gone); returns how many. */
  async closeItem(tx: TenantTx, source: string, sourceId: string, reason: EscalationCloseReason, now: Date): Promise<number> {
    const closed = await tx.query<{ id: string }>(
      `update machvon.alert_escalation set status = 'CLOSED', closed_at = $3::timestamptz, close_reason = $4 where source = $1 and source_id = $2 and status in ('OPEN', 'ACKNOWLEDGED') returning id`,
      [source, sourceId, now.toISOString(), reason],
    );
    return closed.length;
  }

  /** Closes the open rows of all the items that are closed in the trace, in one statement. */
  async closeOfClosedItems(tx: TenantTx, now: Date): Promise<number> {
    const closed = await tx.query<{ id: string }>(
      `update machvon.alert_escalation e set status = 'CLOSED', closed_at = $1::timestamptz, close_reason = case when t.state = 'RESOLVED' then 'RESOLVED' else 'SOURCE_CLEARED' end
         from machvon.alert_item_trace t
        where t.tenant_id = e.tenant_id and t.source = e.source and t.source_id = e.source_id and t.state <> 'OPEN' and e.status in ('OPEN', 'ACKNOWLEDGED') returning e.id`,
      [now.toISOString()],
    );
    return closed.length;
  }

  /** The rows for the monitor, newest first, for the people whose items the reader may read (the owner's unit decides). */
  async list(tx: TenantTx, query: { unitScope: ScopeBuilder; status: 'open' | 'all'; limit?: number }): Promise<EscalationRecord[]> {
    const scope = query.unitScope(2);
    const rows = await tx.query<Sql>(
      `select ${COLUMNS} from ${FROM}
         join machvon.membership om on om.tenant_id = e.tenant_id and om.id = coalesce(e.owner_membership_id, e.recipient_membership_id)
         join machvon.organization_unit u on u.tenant_id = om.tenant_id and u.id = om.organization_id
        where ($1::text = 'all' or e.status in ('OPEN', 'ACKNOWLEDGED')) and ${scope.sql}
        order by e.created_at desc, e.id limit ${Math.min(query.limit ?? LIST_LIMIT, LIST_LIMIT)}`,
      [query.status, ...scope.params],
    );
    return rows.map(toRecord);
  }

  /** The owner of an item as the escalation sees them: the highest rank of their grants now, and the unit they work in. */
  async ownerOf(tx: TenantTx, membershipId: string, now: Date): Promise<(EscalationOwner & { unitId: string | null; unitPath: string }) | undefined> {
    const rows = await tx.query<{ rank: number; unit_id: string | null; unit_path: string | null }>(
      `select coalesce((select max(r.rank) from machvon.role_grant g join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
                         where g.tenant_id = m.tenant_id and g.membership_id = m.id and g.status = 'Active' and g.effective_from <= $2::timestamptz and (g.effective_until is null or g.effective_until > $2::timestamptz)), 0)::int as rank,
              m.organization_id as unit_id, u.path as unit_path
         from machvon.membership m left join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id where m.id = $1::uuid`,
      [membershipId.toLowerCase(), now.toISOString()],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { membershipId: membershipId.toLowerCase(), rank: row.rank, unitId: row.unit_id, unitPath: row.unit_path ?? '/' };
  }

  /**
   * The people who could receive an escalated item of an owner: every member in force who holds a grant, in force, whose scope reaches the owner's unit (the whole tenant, the unit itself, or a subtree that contains it), with the
   * rank of the grant, the role, and how near their unit is to the owner's in the tree.
   */
  async candidatesFor(tx: TenantTx, ownerUnitPath: string, ownerUnitId: string | null, now: Date): Promise<EscalationCandidate[]> {
    const rows = await tx.query<{ membership_id: string; rank: number; role_code: string; unit_path: string | null }>(
      `select g.membership_id, r.rank, r.code as role_code, mu.path as unit_path
         from machvon.role_grant g
         join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id and r.status = 'Active'
         join machvon.membership m on m.tenant_id = g.tenant_id and m.id = g.membership_id
         left join machvon.organization_unit mu on mu.tenant_id = m.tenant_id and mu.id = m.organization_id
        where g.status = 'Active' and g.effective_from <= $1::timestamptz and (g.effective_until is null or g.effective_until > $1::timestamptz)
          and m.status = 'Active' and m.valid_from <= $1::timestamptz and (m.valid_until is null or m.valid_until > $1::timestamptz)
          and (g.scope_kind = 'TENANT'
               or (g.scope_kind = 'UNIT_ONLY' and $3::uuid = any(g.scope_ref_ids))
               or (g.scope_kind = 'UNIT_SUBTREE' and exists (select 1 from machvon.organization_unit ru where ru.id = any(g.scope_ref_ids) and starts_with($2::text, ru.path))))
        order by g.membership_id, r.rank desc`,
      [now.toISOString(), ownerUnitPath, ownerUnitId],
    );
    return rows.map((row) => ({ membershipId: row.membership_id, rank: row.rank, unitDepth: commonDepth(row.unit_path ?? '/', ownerUnitPath), roleCodes: [row.role_code] }));
  }
}
