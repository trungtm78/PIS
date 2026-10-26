import { DomainError, versionConflict } from '@machvon/kernel';
import type { Scope } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const TENANT_OWNER = 'TENANT_OWNER';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const GRANT_WINDOW_CONSTRAINT = 'role_grant_window_ck';
// Contract statuses in which a guest contractor may be given access (BR-IAM-08): signed and running, not draft or ended.
const GUEST_CONTRACT_STATUSES = ['SIGNED', 'ACTIVE', 'SUSPENDED', 'COMPLETED'];

export type ScopeKind = 'TENANT' | 'UNIT_SUBTREE' | 'UNIT_ONLY' | 'PROJECT' | 'CONTRACT';

export interface RoleRow {
  id: string;
  code: string;
  name: string;
  permissions: string[];
  rank: number;
  isSystem: boolean;
  guestAllowed: boolean;
  status: string;
  version: number;
}

export interface MembershipRow {
  id: string;
  status: string;
  membershipType: string;
  /** True when `valid_until` has passed on the database clock. */
  lapsed: boolean;
  /** The contractor of a guest contractor membership. */
  contractorId: string | null;
}

export interface GrantRow {
  id: string;
  membershipId: string;
  roleId: string;
  roleCode: string;
  scopeKind: ScopeKind;
  scopeRefIds: string[];
  status: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  grantedBy: string;
  grantReason: string;
  version: number;
}

/** A scope as stored on a grant, with the scope the anti-escalation check can reason about. */
export interface ResolvedScope {
  /** The scope exactly as requested (unit scopes carry the paths of their units). */
  scope: Scope;
  /** For PROJECT and CONTRACT: the owner units as a UNIT_ONLY scope, which a unit-subtree grantor provably covers. */
  ownerUnitScope?: Scope;
  /** Paths of the units involved, for `scope_json.path_prefixes`. */
  paths: string[];
}

interface RoleQueryRow {
  id: string;
  code: string;
  name: string;
  permissions: string[];
  rank: number;
  is_system: boolean;
  guest_allowed: boolean;
  status: string;
  version: string;
}

interface GrantQueryRow {
  id: string;
  membership_id: string;
  role_id: string;
  role_code: string;
  scope_kind: ScopeKind;
  scope_ref_ids: string[];
  status: string;
  effective_from: string;
  effective_until: string | null;
  granted_by: string;
  grant_reason: string;
  version: string;
}

const ROLE_COLUMNS = 'id, code, name, permissions, rank, is_system, guest_allowed, status, version::text as version';
const GRANT_SELECT = `select g.id, g.membership_id, g.role_id, r.code as role_code, g.scope_kind, g.scope_ref_ids, g.status,
    to_char(g.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_from,
    to_char(g.effective_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_until,
    g.granted_by, g.grant_reason, g.version::text as version
  from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id`;

function toRole(row: RoleQueryRow): RoleRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    permissions: row.permissions,
    rank: row.rank,
    isSystem: row.is_system,
    guestAllowed: row.guest_allowed,
    status: row.status,
    version: Number(row.version),
  };
}

function toGrant(row: GrantQueryRow): GrantRow {
  return {
    id: row.id,
    membershipId: row.membership_id,
    roleId: row.role_id,
    roleCode: row.role_code,
    scopeKind: row.scope_kind,
    scopeRefIds: row.scope_ref_ids,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    grantedBy: row.granted_by,
    grantReason: row.grant_reason,
    version: Number(row.version),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

function isGrantWindowViolation(error: unknown): boolean {
  const failure = error as { code?: unknown; constraint?: unknown } | null;
  return typeof failure === 'object' && failure !== null && failure.code === CHECK_VIOLATION && failure.constraint === GRANT_WINDOW_CONSTRAINT;
}

export interface NewCustomRole {
  code: string;
  name: string;
  permissions: readonly string[];
  rank: number;
  guestAllowed: boolean;
  createdBy: string;
}

export interface NewGrant {
  membershipId: string;
  roleId: string;
  scopeKind: ScopeKind;
  scopeRefIds: readonly string[];
  paths: readonly string[];
  effectiveFrom?: string;
  effectiveUntil?: string;
  grantedBy: string;
  reason: string;
}

/**
 * What a reader of other members' grants may see: their own grants always, plus the grants whose scope lies inside
 * the scopes the reader holds `iam.role.grant` on. Unit scopes are compared by whole path segments; a PROJECT or
 * CONTRACT grant counts as inside a unit through the unit that owns the project or contract. No reach at all
 * (undefined where a reach is accepted) means tenant-wide authority.
 */
export interface GrantReach {
  ownMembershipId: string;
  /** Paths of the reader's UNIT_SUBTREE scopes. */
  subtreePaths: readonly string[];
  /** Paths of the reader's UNIT_ONLY scopes. */
  unitOnlyPaths: readonly string[];
  projectIds: readonly string[];
  contractIds: readonly string[];
}

/** The ordering key of the last role of a page: roles come back ordered by (code, id). */
export interface RolePageAnchor {
  code: string;
  id: string;
}

export interface RolePage {
  after: RolePageAnchor | undefined;
  limit: number;
}

export interface GrantPage {
  after: string | undefined;
  limit: number;
  reach?: GrantReach;
}

export type GuestContractIssue = 'FOREIGN_CONTRACTOR' | 'NOT_ACTIVE';

// The paths of the units a grant is about, read from the units, projects and contracts it names (scope_json is not trusted).
const GRANT_UNIT_PATHS = `left join lateral (
    select coalesce(array_agg(distinct x.path), '{}'::text[]) as paths from (
      select u.path from machvon.organization_unit u where g.scope_kind in ('UNIT_SUBTREE', 'UNIT_ONLY') and u.id = any(g.scope_ref_ids)
      union all
      select u.path from machvon.project p join machvon.organization_unit u on u.id = p.owner_unit_id
        where g.scope_kind = 'PROJECT' and p.id = any(g.scope_ref_ids)
      union all
      select u.path from machvon.contract c join machvon.project p on p.id = c.project_id join machvon.organization_unit u on u.id = p.owner_unit_id
        where g.scope_kind = 'CONTRACT' and c.id = any(g.scope_ref_ids)
    ) x
  ) gp on true`;

function reachClause(first: number): string {
  const [own, subtree, unitOnly, projects, contracts] = [first, first + 1, first + 2, first + 3, first + 4].map((n) => `$${n}`);
  return `(g.membership_id = ${own}::uuid or (g.scope_kind <> 'TENANT' and (
      (cardinality(gp.paths) > 0 and not exists (
        select 1 from unnest(gp.paths) p(path) where not (
          exists (select 1 from unnest(${subtree}::text[]) s(prefix) where starts_with(rtrim(p.path, '/') || '/', rtrim(s.prefix, '/') || '/'))
          or (g.scope_kind in ('UNIT_ONLY', 'PROJECT', 'CONTRACT') and p.path = any(${unitOnly}::text[])))))
      or (g.scope_kind = 'PROJECT' and g.scope_ref_ids <@ ${projects}::uuid[])
      or (g.scope_kind = 'CONTRACT' and g.scope_ref_ids <@ ${contracts}::uuid[]))))`;
}

function reachParams(reach: GrantReach): unknown[] {
  return [reach.ownMembershipId, [...reach.subtreePaths], [...reach.unitOnlyPaths], [...reach.projectIds], [...reach.contractIds]];
}

/**
 * Roles and grants inside a tenant transaction (BR-IAM-05 to BR-IAM-07). Every method works on the
 * transaction it is given, so the caller's audit row, outbox event and scope_version bump commit with it.
 */
export class RoleStore {
  async findRole(tx: TenantTx, roleId: string, options: { forUpdate?: boolean } = {}): Promise<RoleRow | undefined> {
    const rows = await tx.query<RoleQueryRow>(
      `select ${ROLE_COLUMNS} from machvon.role_definition where id = $1::uuid${options.forUpdate === true ? ' for update' : ''}`,
      [roleId],
    );
    return rows[0] === undefined ? undefined : toRole(rows[0]);
  }

  /** Roles of the tenant after the anchor, ordered by (code, id), for keyset pagination (row level security scopes the tenant). */
  async listRoles(tx: TenantTx, page: RolePage): Promise<RoleRow[]> {
    const rows = await tx.query<RoleQueryRow>(
      `select ${ROLE_COLUMNS} from machvon.role_definition
       where ($1::text is null or (code, id) > ($1::text, $2::uuid))
       order by code, id limit $3`,
      [page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRole);
  }

  async createCustomRole(tx: TenantTx, input: NewCustomRole): Promise<{ id: string; version: number }> {
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, is_system, guest_allowed, status, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3::text[], $4, false, $5, 'Active', $6::uuid)
         returning id`,
        [input.code, input.name, input.permissions, input.rank, input.guestAllowed, input.createdBy],
      );
      return { id: rows[0]?.id ?? '', version: 1 };
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('ROLE_CODE_TAKEN', 409);
      throw error;
    }
  }

  /** Locks and returns a custom role for change; a system role is immutable and a stale version is a conflict. */
  async lockCustomRole(tx: TenantTx, roleId: string, expectedVersion: number): Promise<RoleRow> {
    const role = await this.findRole(tx, roleId, { forUpdate: true });
    if (role === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (role.isSystem) throw new DomainError('SYSTEM_ROLE_IMMUTABLE', 409);
    if (role.version !== expectedVersion) throw versionConflict(role.version);
    return role;
  }

  /** Applies a change to a role locked by `lockCustomRole`; returns the new version and every membership holding it. */
  async updateCustomRole(
    tx: TenantTx,
    roleId: string,
    change: { name?: string; permissions: readonly string[]; rank?: number },
  ): Promise<{ version: number; holderMembershipIds: string[] }> {
    const rows = await tx.query<{ version: string }>(
      `update machvon.role_definition
         set name = coalesce($2, name), permissions = $3::text[], rank = coalesce($4, rank), version = version + 1
       where id = $1::uuid returning version::text as version`,
      [roleId, change.name ?? null, change.permissions, change.rank ?? null],
    );
    const holders = await tx.query<{ membership_id: string }>(
      "select distinct membership_id from machvon.role_grant where role_id = $1::uuid and status = 'Active' order by membership_id",
      [roleId],
    );
    return { version: Number(rows[0]?.version), holderMembershipIds: holders.map((row) => row.membership_id) };
  }

  /** Locks the recipient so two grants or revocations for one member serialise. */
  async lockMembership(tx: TenantTx, membershipId: string): Promise<MembershipRow | undefined> {
    const rows = await tx.query<{ id: string; status: string; membership_type: string; lapsed: boolean; contractor_id: string | null }>(
      `select id, status, membership_type, coalesce(valid_until <= now(), false) as lapsed, contractor_id
       from machvon.membership where id = $1::uuid for update`,
      [membershipId],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { id: row.id, status: row.status, membershipType: row.membership_type, lapsed: row.lapsed, contractorId: row.contractor_id };
  }

  async scopeVersionOf(tx: TenantTx, membershipId: string): Promise<number> {
    const rows = await tx.query<{ scope_version: string }>('select scope_version::text as scope_version from machvon.membership where id = $1::uuid', [membershipId]);
    return Number(rows[0]?.scope_version ?? 0);
  }

  /**
   * Resolves requested scope references into scopes the checks can reason about. Returns undefined when a
   * reference does not exist in the tenant (the caller answers 422). A PROJECT or CONTRACT scope also carries the
   * UNIT_ONLY scope of its owner units because a unit-subtree grantor is only provably in range through them.
   */
  async resolveScope(tx: TenantTx, kind: ScopeKind, refIds: readonly string[]): Promise<ResolvedScope | undefined> {
    const refs = [...new Set(refIds)].sort();
    if (kind === 'TENANT') return refs.length === 0 ? { scope: { kind: 'TENANT' }, paths: [] } : undefined;
    if (refs.length === 0) return undefined;
    if (kind === 'UNIT_SUBTREE' || kind === 'UNIT_ONLY') {
      const units = await tx.query<{ path: string }>('select path from machvon.organization_unit where id = any($1::uuid[]) order by id', [refs]);
      if (units.length !== refs.length) return undefined;
      const paths = units.map((unit) => unit.path);
      return { scope: { kind, refIds: refs, paths }, paths };
    }
    const owners =
      kind === 'PROJECT'
        ? await tx.query<{ resource_id: string; unit_id: string; path: string }>(
            `select p.id as resource_id, u.id as unit_id, u.path from machvon.project p
               join machvon.organization_unit u on u.id = p.owner_unit_id where p.id = any($1::uuid[])`,
            [refs],
          )
        : await tx.query<{ resource_id: string; unit_id: string; path: string }>(
            `select c.id as resource_id, u.id as unit_id, u.path from machvon.contract c
               join machvon.project p on p.id = c.project_id
               join machvon.organization_unit u on u.id = p.owner_unit_id where c.id = any($1::uuid[])`,
            [refs],
          );
    if (new Set(owners.map((owner) => owner.resource_id)).size !== refs.length) return undefined;
    const unitIds = [...new Set(owners.map((owner) => owner.unit_id))].sort();
    const paths = [...new Set(owners.map((owner) => owner.path))].sort();
    return { scope: { kind, refIds: refs }, ownerUnitScope: { kind: 'UNIT_ONLY', refIds: unitIds, paths }, paths };
  }

  async insertGrant(tx: TenantTx, input: NewGrant): Promise<{ id: string; version: number }> {
    const refs = [...new Set(input.scopeRefIds)].sort();
    const scopeJson = { kind: input.scopeKind, ref_ids: refs, path_prefixes: input.paths };
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.role_grant
           (tenant_id, id, membership_id, role_id, scope_json, effective_from, effective_until, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::jsonb,
           coalesce($4::timestamptz, now()), $5::timestamptz, $6, $7::uuid[], 'Active', $8::uuid, $9)
         returning id`,
        [input.membershipId, input.roleId, JSON.stringify(scopeJson), input.effectiveFrom ?? null, input.effectiveUntil ?? null, input.scopeKind, refs, input.grantedBy, input.reason],
      );
      return { id: rows[0]?.id ?? '', version: 1 };
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('ROLE_GRANT_EXISTS', 409);
      // An impossible window (for example an end in the past with no start) is the caller's mistake, not a server fault.
      if (isGrantWindowViolation(error)) throw new DomainError('VALIDATION_FAILED', 422, 'effective_until');
      throw error;
    }
  }

  /** Locks a grant for revocation; a stale version is a conflict, a grant that is not Active cannot be revoked again. */
  async lockGrant(tx: TenantTx, grantId: string, expectedVersion: number): Promise<GrantRow> {
    const rows = await tx.query<GrantQueryRow>(`${GRANT_SELECT} where g.id = $1::uuid for update of g`, [grantId]);
    const grant = rows[0] === undefined ? undefined : toGrant(rows[0]);
    if (grant === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (grant.version !== expectedVersion) throw versionConflict(grant.version);
    if (grant.status !== 'Active') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    return grant;
  }

  /**
   * BR-IAM-08: tells why a guest contractor may not be given these contracts, or undefined when they are fine. A
   * contract of another contractor wins over a status problem, so nothing is learnt about contracts of others.
   */
  async guestContractIssue(tx: TenantTx, contractorId: string | null, contractIds: readonly string[]): Promise<GuestContractIssue | undefined> {
    const rows = await tx.query<{ contractor_id: string; status: string }>(
      'select contractor_id, status from machvon.contract where id = any($1::uuid[])',
      [[...new Set(contractIds)]],
    );
    if (contractorId === null || rows.some((row) => row.contractor_id !== contractorId)) return 'FOREIGN_CONTRACTOR';
    return rows.some((row) => !GUEST_CONTRACT_STATUSES.includes(row.status)) ? 'NOT_ACTIVE' : undefined;
  }

  /** The highest rank in force now (as `highestRankOf`) of each of these members, in one read; a member with no grant in force has none in the map. */
  async highestRanksOf(tx: TenantTx, membershipIds: readonly string[]): Promise<Map<string, number>> {
    if (membershipIds.length === 0) return new Map();
    const rows = await tx.query<{ membership_id: string; rank: number }>(
      `select g.membership_id, max(r.rank) as rank from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id
       where g.membership_id = any($1::uuid[]) and g.status = 'Active' and r.status = 'Active'
         and g.effective_from <= now() and (g.effective_until is null or g.effective_until > now())
       group by g.membership_id`,
      [[...membershipIds]],
    );
    return new Map(rows.map((row) => [row.membership_id, row.rank]));
  }

  /** The highest rank among the member's grants in force now (Active, inside their window) of Active roles (0 when none). */
  async highestRankOf(tx: TenantTx, membershipId: string): Promise<number> {
    const rows = await tx.query<{ rank: number | null }>(
      `select max(r.rank) as rank from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id
       where g.membership_id = $1::uuid and g.status = 'Active' and r.status = 'Active'
         and g.effective_from <= now() and (g.effective_until is null or g.effective_until > now())`,
      [membershipId],
    );
    return rows[0]?.rank ?? 0;
  }

  /**
   * Revokes a grant locked by `lockGrant`. Revoking the last Active TENANT_OWNER grant of a tenant is refused
   * (409 LAST_TENANT_OWNER); the TENANT_OWNER role row is locked first so two concurrent revocations cannot
   * each see the other owner still in place.
   */
  async revokeGrant(tx: TenantTx, grant: GrantRow, revokedBy: string, reason: string): Promise<{ version: number }> {
    if (grant.roleCode === TENANT_OWNER) {
      await tx.query('select id from machvon.role_definition where id = $1::uuid for update', [grant.roleId]);
      const others = await tx.query<{ n: string }>(
        `select count(*) as n from machvon.role_grant g join machvon.membership m on m.id = g.membership_id
         where g.role_id = $1::uuid and g.status = 'Active' and g.id <> $2::uuid and m.status = 'Active'`,
        [grant.roleId, grant.id],
      );
      if (Number(others[0]?.n) === 0) throw new DomainError('LAST_TENANT_OWNER', 409);
    }
    const rows = await tx.query<{ version: string }>(
      `update machvon.role_grant
         set status = 'Revoked', revoked_by = $2::uuid, revoked_at = now(), revoke_reason = $3, version = version + 1
       where id = $1::uuid returning version::text as version`,
      [grant.id, revokedBy, reason],
    );
    return { version: Number(rows[0]?.version) };
  }

  /** One grant; with a reach, only when the reach allows it (otherwise it is indistinguishable from a missing one). */
  async getGrant(tx: TenantTx, grantId: string, reach?: GrantReach): Promise<GrantRow | undefined> {
    const rows =
      reach === undefined
        ? await tx.query<GrantQueryRow>(`${GRANT_SELECT} where g.id = $1::uuid`, [grantId])
        : await tx.query<GrantQueryRow>(`${GRANT_SELECT} ${GRANT_UNIT_PATHS} where g.id = $1::uuid and ${reachClause(2)}`, [grantId, ...reachParams(reach)]);
    return rows[0] === undefined ? undefined : toGrant(rows[0]);
  }

  /** Keyset page of grants ordered by id; one extra row tells the caller whether another page exists. */
  async listGrants(tx: TenantTx, page: GrantPage): Promise<GrantRow[]> {
    const reach = page.reach;
    const rows = await tx.query<GrantQueryRow>(
      reach === undefined
        ? `${GRANT_SELECT} where ($1::uuid is null or g.id > $1::uuid) order by g.id limit $2`
        : `${GRANT_SELECT} ${GRANT_UNIT_PATHS} where ($1::uuid is null or g.id > $1::uuid) and ${reachClause(3)} order by g.id limit $2`,
      [page.after ?? null, page.limit + 1, ...(reach === undefined ? [] : reachParams(reach))],
    );
    return rows.map(toGrant);
  }
}
