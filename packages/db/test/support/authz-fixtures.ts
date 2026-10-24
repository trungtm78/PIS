import { resolve } from 'node:path';
import type { TenantContext } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { startMigratedTestDatabase } from '../../src/migrated-test-database';
import { TenantDatabase } from '../../src/tenant-database';
import type { TestDatabase } from '../../src/test-database';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const TENANT_A = '00000000-0000-4000-8000-00000000000a';
export const TENANT_B = '00000000-0000-4000-8000-00000000000b';
export const ACTOR = '00000000-0000-4000-8000-0000000000f0';

/** Deterministic ids: `id(1, 7)` is the 7th id of family 1. */
export function id(family: number, n: number): string {
  return `00000000-0000-4000-${family.toString(16).padStart(4, '0')}-${n.toString(16).padStart(12, '0')}`;
}

export const UNIT_FAMILY = 0x10;
export const MEMBER_FAMILY = 0x20;
export const ROLE_FAMILY = 0x30;
export const GRANT_FAMILY = 0x40;
export const PROJECT_FAMILY = 0x50;

export const unitId = (n: number): string => id(UNIT_FAMILY, n);
export const memberId = (n: number): string => id(MEMBER_FAMILY, n);
export const roleId = (n: number): string => id(ROLE_FAMILY, n);
export const grantId = (n: number): string => id(GRANT_FAMILY, n);

export function contextFor(tenantId: string, membershipId: string, scopeVersion = 1): TenantContext {
  return { tenantId, membershipId, scopeVersion };
}

export interface UnitSeed {
  n: number;
  path: string;
  parent?: number;
}

export interface GrantSeed {
  n: number;
  member: number;
  role: number;
  kind: 'TENANT' | 'UNIT_SUBTREE' | 'UNIT_ONLY' | 'PROJECT' | 'CONTRACT';
  refs?: readonly string[];
  status?: 'Active' | 'Revoked' | 'Expired';
  from?: string;
  until?: string | null;
}

export class AuthzHarness {
  database!: TestDatabase;
  appPool!: Pool;
  tenants!: TenantDatabase;

  async start(): Promise<void> {
    this.database = await startMigratedTestDatabase(REPO_ROOT);
    this.appPool = new Pool({ connectionString: this.database.urlFor('machvon_app'), max: 6 });
    this.appPool.on('error', () => undefined);
    this.tenants = new TenantDatabase(this.appPool);
  }

  async stop(): Promise<void> {
    await this.appPool?.end();
    if (this.database) await this.database.stop();
  }

  /** Runs statements as machvon_owner with the tenant set (FORCE RLS applies to the owner too). */
  async owner<T extends object = Record<string, unknown>>(tenantId: string, statements: Array<[string, unknown[]?]>): Promise<T[]> {
    const client = new Client({ connectionString: this.database.urlFor('machvon_owner') });
    await client.connect();
    try {
      await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
      let last: T[] = [];
      for (const [text, params] of statements) last = (await client.query(text, params)).rows as T[];
      return last;
    } finally {
      await client.end();
    }
  }

  seedUnits(tenantId: string, units: readonly UnitSeed[]): Promise<unknown> {
    const statements: Array<[string, unknown[]?]> = units.map((unit) => [
      `insert into machvon.organization_unit (tenant_id, id, code, name, parent_id, valid_from, path, depth)
       values ($1, $2, $3, $4, $5, date '2026-01-01', $6, $7)`,
      [tenantId, unitId(unit.n), `U${unit.n}`, `Unit ${unit.n}`, unit.parent === undefined ? null : unitId(unit.parent), unit.path, unit.path.split('/').length - 3],
    ]);
    return this.owner(tenantId, statements);
  }

  seedMembership(tenantId: string, n: number, organization: number, options: { status?: string; validFrom?: string; validUntil?: string | null } = {}): Promise<unknown> {
    return this.owner(tenantId, [
      [
        "insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, $4, 'Active') on conflict do nothing",
        [id(0x60, n), `sub-${n}`, `user${n}@example.test`, `User ${n}`],
      ],
      [
        'insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from, valid_until) values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, $7::timestamptz - make_interval(days => 365), now()), $7)',
        [tenantId, memberId(n), id(0x60, n), unitId(organization), options.status ?? 'Active', options.validFrom ?? null, options.validUntil ?? null],
      ],
    ]);
  }

  seedRole(tenantId: string, n: number, code: string, permissions: readonly string[], rank: number): Promise<unknown> {
    return this.owner(tenantId, [
      [
        "insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, $3, $3, $4, $5, 'Active', $6)",
        [tenantId, roleId(n), code, permissions, rank, ACTOR],
      ],
    ]);
  }

  seedGrants(tenantId: string, grants: readonly GrantSeed[]): Promise<unknown> {
    const statements: Array<[string, unknown[]?]> = grants.map((grant) => [
      `insert into machvon.role_grant
         (tenant_id, id, membership_id, role_id, scope_json, effective_from, effective_until, scope_kind, scope_ref_ids, status, granted_by, grant_reason, revoked_at)
       values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz, $8, $9::uuid[], $10, $11, 'test', case when $10 = 'Revoked' then now() end)`,
      [
        tenantId,
        grantId(grant.n),
        memberId(grant.member),
        roleId(grant.role),
        JSON.stringify({ kind: grant.kind, ref_ids: grant.refs ?? [] }),
        grant.from ?? '2026-01-01T00:00:00Z',
        grant.until ?? null,
        grant.kind,
        grant.refs ?? [],
        grant.status ?? 'Active',
        ACTOR,
      ],
    ]);
    return this.owner(tenantId, statements);
  }
}
