import type { EffectiveAccess, GrantView, MetricsSink, Scope, TenantContext } from '@machvon/kernel';
import type { AuthzCache } from './authz-cache.ts';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

const DEFAULT_TTL_SECONDS = 60;

interface MembershipRow {
  scope_version: string;
  active: boolean;
}

/** The columns of a grant with its role that the PDP needs: what `grantViewOf` turns into a GrantView. */
export interface GrantRow {
  code: string;
  rank: number;
  permissions: string[];
  scope_kind: 'TENANT' | 'UNIT_SUBTREE' | 'UNIT_ONLY' | 'PROJECT' | 'CONTRACT';
  scope_ref_ids: string[];
  unit_paths: string[];
  status: string;
  effective_from: Date;
  effective_until: Date | null;
  /** The report periods an Active limit of the grant lists (IAM-2); null when it is not limited. */
  period_codes?: string[] | null;
}

// Active is decided by the database clock: the membership has started (valid_from) and has not ended (valid_until).
// The 60 second cache TTL bounds how long a lapsed or not yet started validity can linger.
const MEMBERSHIP_SQL = `select scope_version::text as scope_version,
    (status = 'Active' and valid_from <= now() and (valid_until is null or valid_until > now())) as active
  from machvon.membership where id = $1::uuid`;

// Grant windows are not filtered here: a cached access must stay correct as time passes, so the pure PDP applies them.
const GRANTS_SQL = `select r.code, r.rank, r.permissions, g.scope_kind, g.scope_ref_ids, g.status, g.effective_from, g.effective_until,
    coalesce((select array_agg(u.path order by u.path) from machvon.organization_unit u where u.id = any(g.scope_ref_ids)), '{}') as unit_paths,
    (select ps.period_codes from machvon.role_grant_period_scope ps where ps.tenant_id = g.tenant_id and ps.role_grant_id = g.id and ps.status = 'Active') as period_codes
  from machvon.role_grant g
  join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
  where g.membership_id = $1::uuid and g.status = 'Active'
  order by g.created_at, g.id`;

function scopeOf(row: GrantRow): Scope {
  if (row.scope_kind === 'TENANT') return { kind: 'TENANT' };
  // UNIT_ONLY carries the paths too: scopeContains still matches it by unit id, while readers that work on paths need them.
  if (row.scope_kind === 'UNIT_SUBTREE' || row.scope_kind === 'UNIT_ONLY') return { kind: row.scope_kind, refIds: row.scope_ref_ids, paths: row.unit_paths };
  return { kind: row.scope_kind, refIds: row.scope_ref_ids };
}

/** The grant as the pure PDP sees it. */
export function grantViewOf(row: GrantRow): GrantView {
  return {
    roleCode: row.code,
    rank: row.rank,
    permissions: row.permissions,
    scope: scopeOf(row),
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    ...(row.period_codes === undefined || row.period_codes === null ? {} : { periodCodes: row.period_codes }),
  };
}

export interface EffectiveAccessStoreOptions {
  /** Cache lifetime; default 60 seconds (IAM section 3.4). */
  ttlSeconds?: number;
  metrics?: MetricsSink;
}

/**
 * The access of another member read inside the transaction of a command, without the cache: what a command that names a second person (an approver) needs to
 * know about them. A membership that is not visible in the tenant has no grants and is not active.
 */
export async function loadAccessIn(tx: TenantTx, membershipId: string): Promise<EffectiveAccess> {
  const [membership] = await tx.query<MembershipRow>(MEMBERSHIP_SQL, [membershipId]);
  if (membership === undefined) return { membershipId, scopeVersion: 0, membershipActive: false, grants: [] };
  const rows = await tx.query<GrantRow>(GRANTS_SQL, [membershipId]);
  return { membershipId, scopeVersion: Number(membership.scope_version), membershipActive: membership.active, grants: rows.map(grantViewOf) };
}

/**
 * Loads EffectiveAccess for a membership from PostgreSQL (BR-IAM-03). The database `scope_version` is always read
 * first and selects the cache entry, so a token carrying an older version never sees a stale entry and a bump takes
 * effect on the next request without waiting for the TTL (BR-IAM-13).
 */
export class EffectiveAccessStore {
  private readonly database: TenantDatabase;
  private readonly cache: AuthzCache;
  private readonly ttlSeconds: number;
  private readonly metrics: MetricsSink | undefined;

  constructor(database: TenantDatabase, cache: AuthzCache, options: EffectiveAccessStoreOptions = {}) {
    this.database = database;
    this.cache = cache;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.metrics = options.metrics;
  }

  async load(ctx: TenantContext): Promise<EffectiveAccess> {
    const membership = await this.readMembership(ctx);
    if (membership === undefined) return { membershipId: ctx.membershipId, scopeVersion: 0, membershipActive: false, grants: [] };
    const scopeVersion = Number(membership.scope_version);
    const cached = await this.cache.get(ctx.tenantId, ctx.membershipId, scopeVersion);
    if (cached !== undefined) {
      this.metrics?.increment('authz_cache_hit_total');
      return cached;
    }
    this.metrics?.increment('authz_cache_miss_total');
    const rows = await this.database.withTenant(ctx, (tx) => tx.query<GrantRow>(GRANTS_SQL, [ctx.membershipId]));
    const access: EffectiveAccess = { membershipId: ctx.membershipId, scopeVersion, membershipActive: membership.active, grants: rows.map(grantViewOf) };
    await this.cache.set(access, ctx.tenantId, this.ttlSeconds);
    return access;
  }

  /** The database `scope_version` of the membership; 0 when the membership is not visible in the tenant. */
  async currentScopeVersion(ctx: TenantContext): Promise<number> {
    const membership = await this.readMembership(ctx);
    return membership === undefined ? 0 : Number(membership.scope_version);
  }

  /** Consumer of `iam.access.changed.v1`: forgets the listed memberships so their next request recomputes. */
  async onAccessChanged(event: { tenantId: string; membershipIds: readonly string[] }): Promise<void> {
    for (const membershipId of event.membershipIds) await this.cache.invalidate(event.tenantId, membershipId);
  }

  private async readMembership(ctx: TenantContext): Promise<MembershipRow | undefined> {
    const rows = await this.database.withTenant(ctx, (tx) => tx.query<MembershipRow>(MEMBERSHIP_SQL, [ctx.membershipId]));
    return rows[0];
  }
}
