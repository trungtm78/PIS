import { DomainError, absencePhaseAt, coverInForce, nextCoverStatus, versionConflict } from '@machvon/kernel';
import type { AbsenceFacts, AbsenceSpan, CoverEdge, CoverMove, CoverScopeKind, CoverStatus, PersonFacts, PositionHolder } from '@machvon/kernel';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const LIST_LIMIT = 200;

export type AbsenceStatus = 'DECLARED' | 'ENDED' | 'CANCELLED';

export interface AbsenceRecord {
  id: string;
  membershipId: string;
  name: string | null;
  unitId: string | null;
  kind: string;
  validFrom: string;
  validUntil: string;
  /** The end it counts to now: the end declared, or the moment the person was back when that was earlier. */
  effectiveUntil: string;
  reason: string | null;
  status: AbsenceStatus;
  declaredBy: string;
  declaredAt: string;
  endedAt: string | null;
  endedBy: string | null;
  endReason: string | null;
  version: number;
}

export interface CoverRecord {
  id: string;
  absenceId: string;
  absentId: string;
  absentName: string | null;
  deputyId: string;
  deputyName: string | null;
  validFrom: string;
  validUntil: string;
  scopeKind: CoverScopeKind;
  sources: string[];
  status: CoverStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  version: number;
}

interface AbsenceSql {
  id: string;
  membership_id: string;
  name: string | null;
  unit_id: string | null;
  kind: string;
  valid_from: string;
  valid_until: string;
  effective_until: string;
  reason: string | null;
  status: AbsenceStatus;
  declared_by: string;
  declared_at: string;
  ended_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
  version: number;
}

interface CoverSql {
  id: string;
  absence_id: string;
  absent_id: string;
  absent_name: string | null;
  deputy_id: string;
  deputy_name: string | null;
  valid_from: string;
  valid_until: string;
  scope_kind: CoverScopeKind;
  sources: string[];
  status: CoverStatus;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  version: number;
}

const ABSENCE_FROM = `machvon.alert_absence a
  join machvon.membership m on m.tenant_id = a.tenant_id and m.id = a.membership_id
  left join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id
  left join machvon.tenant_user_directory d on d.tenant_id = a.tenant_id and d.membership_id = a.membership_id`;
const ABSENCE_COLUMNS = `a.id, a.membership_id, d.display_name as name, m.organization_id as unit_id, a.kind, ${ISO('a.valid_from')} as valid_from, ${ISO('a.valid_until')} as valid_until,
  ${ISO('case when a.ended_at is not null then least(a.valid_until, a.ended_at) else a.valid_until end')} as effective_until, a.reason, a.status, a.declared_by, ${ISO('a.declared_at')} as declared_at,
  ${ISO('a.ended_at')} as ended_at, a.ended_by, a.end_reason, a.version`;
const COVER_FROM = `machvon.alert_absence_cover c
  left join machvon.tenant_user_directory da on da.tenant_id = c.tenant_id and da.membership_id = c.absent_membership_id
  left join machvon.tenant_user_directory dd on dd.tenant_id = c.tenant_id and dd.membership_id = c.deputy_membership_id`;
const COVER_COLUMNS = `c.id, c.absence_id, c.absent_membership_id as absent_id, da.display_name as absent_name, c.deputy_membership_id as deputy_id, dd.display_name as deputy_name, ${ISO('c.valid_from')} as valid_from,
  ${ISO('c.valid_until')} as valid_until, c.scope_kind, c.sources, c.status, c.requested_by, ${ISO('c.requested_at')} as requested_at, c.decided_by, ${ISO('c.decided_at')} as decided_at, c.decision_note, c.revoked_by,
  ${ISO('c.revoked_at')} as revoked_at, c.revoke_reason, c.version`;

const toAbsence = (row: AbsenceSql): AbsenceRecord => ({
  id: row.id,
  membershipId: row.membership_id,
  name: row.name,
  unitId: row.unit_id,
  kind: row.kind,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  effectiveUntil: row.effective_until,
  reason: row.reason,
  status: row.status,
  declaredBy: row.declared_by,
  declaredAt: row.declared_at,
  endedAt: row.ended_at,
  endedBy: row.ended_by,
  endReason: row.end_reason,
  version: Number(row.version),
});

const toCover = (row: CoverSql): CoverRecord => ({
  id: row.id,
  absenceId: row.absence_id,
  absentId: row.absent_id,
  absentName: row.absent_name,
  deputyId: row.deputy_id,
  deputyName: row.deputy_name,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  scopeKind: row.scope_kind,
  sources: row.sources,
  status: row.status,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  revokedBy: row.revoked_by,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
  version: Number(row.version),
});

export const edgeOf = (cover: CoverRecord): CoverEdge => ({ id: cover.id, absentId: cover.absentId, deputyId: cover.deputyId, from: new Date(cover.validFrom), until: new Date(cover.validUntil), status: cover.status, scopeKind: cover.scopeKind, sources: cover.sources });

export interface AbsenceListQuery {
  unitScope: ScopeBuilder;
  /** `current`: not over and not ended; `all`: every absence of the last year. */
  state: 'current' | 'all';
  now: Date;
  /** Only this person's, for a reader who sees their own. */
  membershipId?: string;
  limit?: number;
}

/**
 * The absences and the covers of the alert centre (G2-7). The store keeps and moves them; the rules (window, loop, depth, rank, the third person who allows) are the kernel's and are judged by the command that calls it. Every change is
 * under the version of the row; a stale version is 409 VERSION_CONFLICT.
 */
export class AlertCoverStore {
  async declareAbsence(tx: TenantTx, input: { membershipId: string; kind: string; from: Date; until: Date; reason: string | undefined; declaredBy: string }): Promise<AbsenceRecord> {
    const overlap = await tx.query<{ found: boolean }>(
      `select exists (select 1 from machvon.alert_absence a where a.membership_id = $1::uuid and a.status = 'DECLARED' and a.valid_from < $3::timestamptz and $2::timestamptz < a.valid_until) as found`,
      [input.membershipId.toLowerCase(), input.from.toISOString(), input.until.toISOString()],
    );
    if (overlap[0]?.found === true) throw new DomainError('ALERT_ABSENCE_OVERLAP', 409, 'valid_from');
    const [created] = await tx.query<{ id: string }>(
      `insert into machvon.alert_absence (tenant_id, membership_id, kind, valid_from, valid_until, reason, declared_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6::uuid) returning id`,
      [input.membershipId.toLowerCase(), input.kind, input.from.toISOString(), input.until.toISOString(), input.reason ?? null, input.declaredBy.toLowerCase()],
    );
    return (await this.findAbsence(tx, (created as { id: string }).id)) as AbsenceRecord;
  }

  async findAbsence(tx: TenantTx, id: string): Promise<AbsenceRecord | undefined> {
    const rows = await tx.query<AbsenceSql>(`select ${ABSENCE_COLUMNS} from ${ABSENCE_FROM} where a.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toAbsence(rows[0]);
  }

  /** The absences of the people the reader may read, newest first. */
  async listAbsences(tx: TenantTx, query: AbsenceListQuery): Promise<AbsenceRecord[]> {
    const scope = query.unitScope(3);
    const rows = await tx.query<AbsenceSql>(
      `select ${ABSENCE_COLUMNS} from ${ABSENCE_FROM}
        where ($1::uuid is null or a.membership_id = $1::uuid) and ${scope.sql}
          and (case when $2::text = 'current' then a.status = 'DECLARED' and a.valid_until > $${3 + scope.params.length}::timestamptz else a.valid_until > $${3 + scope.params.length}::timestamptz - interval '365 days' end)
        order by a.valid_from desc, a.id limit ${Math.min(query.limit ?? LIST_LIMIT, LIST_LIMIT)}`,
      [query.membershipId?.toLowerCase() ?? null, query.state, ...scope.params, query.now.toISOString()],
    );
    return rows.map(toAbsence);
  }

  /** Ends an absence early (the person is back: ENDED) or withdraws it (it did not happen: CANCELLED); the covers that are still live are revoked with it. */
  async endAbsence(tx: TenantTx, id: string, expectedVersion: number, input: { actor: string; status: 'ENDED' | 'CANCELLED'; reason: string; now: Date }): Promise<{ absence: AbsenceRecord; revokedCovers: string[] }> {
    const current = await this.findAbsence(tx, id);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'DECLARED') throw new DomainError('ALERT_ABSENCE_STATE_INVALID', 409, 'status');
    if (new Date(current.effectiveUntil).getTime() <= input.now.getTime()) throw new DomainError('ALERT_ABSENCE_STATE_INVALID', 409, 'valid_until');
    const changed = await tx.query<{ id: string }>(
      `update machvon.alert_absence set status = $2, ended_at = $3::timestamptz, ended_by = $4::uuid, end_reason = $5, version = version + 1 where id = $1::uuid and version = $6::int and status = 'DECLARED' returning id`,
      [id, input.status, input.now.toISOString(), input.actor.toLowerCase(), input.reason, expectedVersion],
    );
    if (changed.length === 0) throw versionConflict((await this.findAbsence(tx, id))?.version ?? 0);
    const revoked = await tx.query<{ id: string }>(
      `update machvon.alert_absence_cover set status = 'REVOKED', revoked_by = $2::uuid, revoked_at = $3::timestamptz, revoke_reason = $4, version = version + 1
        where absence_id = $1::uuid and status in ('PENDING', 'APPROVED') returning id`,
      [id, input.actor.toLowerCase(), input.now.toISOString(), input.reason],
    );
    return { absence: (await this.findAbsence(tx, id)) as AbsenceRecord, revokedCovers: revoked.map((row) => row.id) };
  }

  async proposeCover(tx: TenantTx, input: { absence: AbsenceRecord; deputyId: string; from: Date; until: Date; scopeKind: CoverScopeKind; sources: readonly string[]; requestedBy: string }): Promise<CoverRecord> {
    const [created] = await tx.query<{ id: string }>(
      `insert into machvon.alert_absence_cover (tenant_id, absence_id, absent_membership_id, deputy_membership_id, valid_from, valid_until, scope_kind, sources, requested_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz, $6, $7::text[], $8::uuid) returning id`,
      [input.absence.id, input.absence.membershipId, input.deputyId.toLowerCase(), input.from.toISOString(), input.until.toISOString(), input.scopeKind, [...input.sources], input.requestedBy.toLowerCase()],
    );
    return (await this.findCover(tx, (created as { id: string }).id)) as CoverRecord;
  }

  async findCover(tx: TenantTx, id: string): Promise<CoverRecord | undefined> {
    const rows = await tx.query<CoverSql>(`select ${COVER_COLUMNS} from ${COVER_FROM} where c.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toCover(rows[0]);
  }

  /** The covers of some absences, oldest first. */
  async coversOf(tx: TenantTx, absenceIds: readonly string[]): Promise<CoverRecord[]> {
    if (absenceIds.length === 0) return [];
    const rows = await tx.query<CoverSql>(`select ${COVER_COLUMNS} from ${COVER_FROM} where c.absence_id = any($1::uuid[]) order by c.requested_at, c.id`, [[...absenceIds]]);
    return rows.map(toCover);
  }

  /** The covers that wait for a decision, for the people who allow them. */
  async pendingCovers(tx: TenantTx, unitScope: ScopeBuilder): Promise<CoverRecord[]> {
    const scope = unitScope(1);
    const rows = await tx.query<CoverSql>(
      `select ${COVER_COLUMNS} from ${COVER_FROM}
         join machvon.membership am on am.tenant_id = c.tenant_id and am.id = c.absent_membership_id
         join machvon.organization_unit u on u.tenant_id = am.tenant_id and u.id = am.organization_id
        where c.status = 'PENDING' and ${scope.sql} order by c.requested_at, c.id limit ${LIST_LIMIT}`,
      scope.params,
    );
    return rows.map(toCover);
  }

  /** Allows or rejects a pending cover (the third person), or revokes a live one; the kernel judges who may. */
  async moveCover(tx: TenantTx, id: string, expectedVersion: number, move: CoverMove, input: { actor: string; note: string | undefined; now: Date }): Promise<{ before: CoverStatus; cover: CoverRecord }> {
    const current = await this.findCover(tx, id);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    const next = nextCoverStatus(current.status, move, { actor: input.actor, requester: current.requestedBy, absent: current.absentId, deputy: current.deputyId });
    // The version and the state the move started from are in the statement: a decision that raced this one finds no row to change and is a conflict, not a second decision.
    const changed =
      move === 'REVOKE'
        ? await tx.query<{ id: string }>(
            `update machvon.alert_absence_cover set status = $2, revoked_by = $3::uuid, revoked_at = $4::timestamptz, revoke_reason = $5, version = version + 1 where id = $1::uuid and version = $6::int and status = $7 returning id`,
            [id, next, input.actor.toLowerCase(), input.now.toISOString(), input.note ?? null, expectedVersion, current.status],
          )
        : await tx.query<{ id: string }>(
            `update machvon.alert_absence_cover set status = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_note = $5, version = version + 1 where id = $1::uuid and version = $6::int and status = $7 returning id`,
            [id, next, input.actor.toLowerCase(), input.now.toISOString(), input.note ?? null, expectedVersion, current.status],
          );
    if (changed.length === 0) throw versionConflict((await this.findCover(tx, id))?.version ?? 0);
    return { before: current.status, cover: (await this.findCover(tx, id)) as CoverRecord };
  }

  /** The covers that are pending or allowed and have not ended: the graph the loop and the depth are judged on, and the covers that route alerts. */
  async liveEdges(tx: TenantTx, now: Date): Promise<CoverEdge[]> {
    const rows = await tx.query<CoverSql>(`select ${COVER_COLUMNS} from ${COVER_FROM} where c.status in ('PENDING', 'APPROVED') and c.valid_until > $1::timestamptz`, [now.toISOString()]);
    return rows.map((row) => edgeOf(toCover(row)));
  }

  /** The absences that are on or are coming, as the rules read them (the end is the moment the person was back when that was earlier). */
  async absenceFacts(tx: TenantTx, now: Date): Promise<AbsenceFacts[]> {
    const rows = await tx.query<{ id: string; membership_id: string; valid_from: string; effective_until: string; declared_at: string }>(
      `select a.id, a.membership_id, ${ISO('a.valid_from')} as valid_from, ${ISO('case when a.ended_at is not null then least(a.valid_until, a.ended_at) else a.valid_until end')} as effective_until, ${ISO('a.declared_at')} as declared_at
         from machvon.alert_absence a where a.status = 'DECLARED' and a.valid_until > $1::timestamptz`,
      [now.toISOString()],
    );
    return rows.map((row) => ({ id: row.id, membershipId: row.membership_id, from: new Date(row.valid_from), until: new Date(row.effective_until), declaredAt: new Date(row.declared_at) }));
  }

  async absenceSpans(tx: TenantTx, now: Date): Promise<AbsenceSpan[]> {
    return (await this.absenceFacts(tx, now)).map((fact) => ({ membershipId: fact.membershipId, from: fact.from, until: fact.until }));
  }

  /** Whether each of the people is in force now and the highest rank of their grants (0 for none); a person the tenant does not know is inactive. */
  async personFacts(tx: TenantTx, ids: readonly string[], now: Date): Promise<Map<string, PersonFacts>> {
    const found = new Map<string, PersonFacts>();
    const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
    if (unique.length > 0) {
      const rows = await tx.query<{ id: string; active: boolean; rank: number }>(
        `select m.id, (m.status = 'Active' and m.valid_from <= $2::timestamptz and (m.valid_until is null or m.valid_until > $2::timestamptz)) as active,
                coalesce((select max(r.rank) from machvon.role_grant g join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
                           where g.tenant_id = m.tenant_id and g.membership_id = m.id and g.status = 'Active' and g.effective_from <= $2::timestamptz and (g.effective_until is null or g.effective_until > $2::timestamptz)), 0)::int as rank
           from machvon.membership m where m.id = any($1::uuid[])`,
        [unique, now.toISOString()],
      );
      for (const row of rows) found.set(row.id, { id: row.id, active: row.active, rank: row.rank });
    }
    for (const id of unique) if (!found.has(id)) found.set(id, { id, active: false, rank: 0 });
    return found;
  }

  /** The memberships that are not in force now, among those that hold or held an open item: the owners that have left. */
  async inactiveAmong(tx: TenantTx, ids: readonly string[], now: Date): Promise<Set<string>> {
    const facts = await this.personFacts(tx, ids, now);
    return new Set([...facts.values()].filter((fact) => !fact.active).map((fact) => fact.id));
  }

  /**
   * Who holds a role of line leadership in which unit, and whether they are present (in force and not away) or away with a cover for all sources in force: what the coverage of positions is computed from. Roles of rank from `minRank` up to but
   * not including `maxRankExclusive` (the administrative roles are not positions of leadership).
   */
  async positionHolders(tx: TenantTx, now: Date, minRank: number, maxRankExclusive: number, unitScope: ScopeBuilder = () => ({ sql: 'true', params: [] })): Promise<PositionHolder[]> {
    const scope = unitScope(4);
    const rows = await tx.query<{ role_code: string; rank: number; unit_id: string; membership_id: string; active: boolean }>(
      `select distinct r.code as role_code, r.rank, m.organization_id as unit_id, g.membership_id,
              (m.status = 'Active' and m.valid_from <= $1::timestamptz and (m.valid_until is null or m.valid_until > $1::timestamptz)) as active
         from machvon.role_grant g
         join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
         join machvon.membership m on m.tenant_id = g.tenant_id and m.id = g.membership_id
         join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id
        where g.status = 'Active' and g.effective_from <= $1::timestamptz and (g.effective_until is null or g.effective_until > $1::timestamptz)
          and r.status = 'Active' and r.rank >= $2::int and r.rank < $3::int and ${scope.sql}
        order by r.code, m.organization_id, g.membership_id`,
      [now.toISOString(), minRank, maxRankExclusive, ...scope.params],
    );
    const spans = await this.absenceSpans(tx, now);
    const edges = await this.liveEdges(tx, now);
    return rows.map((row) => {
      const absent = spans.some((span) => span.membershipId === row.membership_id && absencePhaseAt(span, now) === 'ACTIVE');
      const covered = edges.some((edge) => edge.absentId === row.membership_id && edge.scopeKind === 'ALL' && coverInForce(edge, now));
      return { roleCode: row.role_code, roleRank: row.rank, unitId: row.unit_id, membershipId: row.membership_id, present: row.active && !absent, coveredNow: row.active && absent && covered };
    });
  }
}
