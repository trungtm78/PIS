import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import { TenantDatabase } from '../src/tenant-database';
import type { TestDatabase } from '../src/test-database';
import { DEFAULT_MFA_REQUIRED_ROLES, loadSelectionFacts } from '../src/tenant-selection';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const UNIT = (n: number): string => `00000000-0000-4000-8000-0000000000c${n}`;
const USER = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = (n: number): string => `00000000-0000-4000-8000-0000000000d${n}`;
const ROLE = (n: number): string => `00000000-0000-4000-8000-0000000000e${n}`;
const ctx = (tenantId: string) => ({ tenantId, membershipId: MEMBER(0), scopeVersion: 0 });

describe('loadSelectionFacts', () => {
  let database: TestDatabase;
  let pool: Pool;
  let tenants: TenantDatabase;

  async function owner(tenantId: string, statements: Array<[string, unknown[]?]>): Promise<void> {
    const client = new Client({ connectionString: database.urlFor('machvon_owner') });
    await client.connect();
    try {
      await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
      for (const [text, params] of statements) await client.query(text, params);
    } finally {
      await client.end();
    }
  }

  const facts = (tenantId: string, membership: string) => tenants.withTenant(ctx(tenantId), (tx) => loadSelectionFacts(tx, membership));

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    pool = new Pool({ connectionString: database.urlFor('machvon_app'), max: 4 });
    pool.on('error', () => undefined);
    tenants = new TenantDatabase(pool);
    await owner(TENANT_A, [
      ["insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, 'sub-sel', 'sel@example.test', 'Sel', 'Active')", [USER]],
      ...[1, 2, 3].map((n): [string, unknown[]] => ["insert into machvon.organization_unit (tenant_id, id, code, name, valid_from) values ($1, $2, $3, 'Unit', date '2026-01-01')", [TENANT_A, UNIT(n), `U${n}`]]),
      ["insert into machvon.membership (tenant_id, id, user_id, organization_id, status, scope_version) values ($1, $2, $3, $4, 'Active', 7)", [TENANT_A, MEMBER(1), USER, UNIT(1)]],
      [
        "insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Active', now() + interval '1 day')",
        [TENANT_A, MEMBER(2), USER, UNIT(2)],
      ],
      [
        "insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from, valid_until) values ($1, $2, $3, $4, 'Active', now() - interval '2 days', now() - interval '1 day')",
        [TENANT_A, MEMBER(3), USER, UNIT(3)],
      ],
      ["insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, 'LEADER', 'Leader', '{approval.decide}', 60, 'Active', $3)", [TENANT_A, ROLE(1), ACTOR]],
      ["insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, 'MEMBER', 'Member', '{profile.self}', 5, 'Active', $3)", [TENANT_A, ROLE(2), ACTOR]],
      ["insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, 'TENANT_ADMIN', 'Admin', '{iam.unit.manage}', 70, 'Active', $3)", [TENANT_A, ROLE(3), ACTOR]],
    ]);
    const grant = (n: number, role: number, from: string, until: string | null, status = 'Active'): [string, unknown[]] => [
      `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, effective_until, scope_kind, scope_ref_ids, status, granted_by, grant_reason, revoked_at)
       values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, $5::timestamptz, $6::timestamptz, 'TENANT', '{}', $7, $8, 'test', case when $7 = 'Revoked' then now() end)`,
      [TENANT_A, `00000000-0000-4000-8000-0000000000f${n}`, MEMBER(1), ROLE(role), from, until, status, ACTOR],
    ];
    await owner(TENANT_A, [
      grant(1, 2, '2026-01-01T00:00:00Z', null),
      grant(2, 1, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), // LEADER, ended long ago
      grant(3, 3, '2099-01-01T00:00:00Z', null), // TENANT_ADMIN, starts in the far future
      grant(4, 1, '2026-01-01T00:00:00Z', null, 'Revoked'), // LEADER, revoked
    ]);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    if (database) await database.stop();
  }, 60_000);

  it('reads the membership of the tenant with its database scope version and the roles that are in force', async () => {
    const found = await facts(TENANT_A, MEMBER(1));
    expect(found).toEqual({
      userAccountId: USER,
      status: 'Active',
      insideValidity: true,
      scopeVersion: 7,
      roleCodes: ['MEMBER'],
      mfaRequiredRoles: DEFAULT_MFA_REQUIRED_ROLES,
    });
  });

  it('reports a membership outside its validity window, before it starts and after it ended', async () => {
    expect((await facts(TENANT_A, MEMBER(2)))?.insideValidity).toBe(false);
    expect((await facts(TENANT_A, MEMBER(3)))?.insideValidity).toBe(false);
  });

  it('finds nothing for a membership of another tenant or one that does not exist', async () => {
    expect(await facts(TENANT_B, MEMBER(1))).toBeUndefined();
    expect(await facts(TENANT_A, MEMBER(9))).toBeUndefined();
  });

  it('uses the published security policy when the tenant has one, and ignores a draft or a malformed one', async () => {
    const policy = (id: number, revision: number, status: string, json: unknown): [string, unknown[]] => [
      "insert into machvon.security_policy_version (tenant_id, id, revision, policy_json, status, created_by, approved_by, published_at) values ($1, $2, $3, $4::jsonb, $5, $6, '00000000-0000-4000-8000-0000000000f9', now())",
      [TENANT_A, `00000000-0000-4000-8000-0000000000b${id}`, revision, JSON.stringify(json), status, ACTOR],
    ];
    await owner(TENANT_A, [policy(1, 1, 'Published', { mfa_required_roles: ['MEMBER'] })]);
    expect((await facts(TENANT_A, MEMBER(1)))?.mfaRequiredRoles).toEqual(['MEMBER']);
    await owner(TENANT_A, [policy(2, 2, 'Draft', { mfa_required_roles: ['LEADER'] })]);
    expect((await facts(TENANT_A, MEMBER(1)))?.mfaRequiredRoles).toEqual(['MEMBER']);
    // One version is in force at a time (V014): the first is superseded before the next is published.
    await owner(TENANT_A, [["update machvon.security_policy_version set status = 'Superseded' where revision = 1", []], policy(3, 3, 'Published', { mfa_required_roles: 'LEADER' })]);
    expect((await facts(TENANT_A, MEMBER(1)))?.mfaRequiredRoles).toEqual(DEFAULT_MFA_REQUIRED_ROLES);
  });

  it('locks the membership row so two selections of one membership serialise', async () => {
    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolveHeld) => {
      releaseFirst = resolveHeld;
    });
    let locked: () => void = () => undefined;
    const lockedSignal = new Promise<void>((resolveLocked) => {
      locked = resolveLocked;
    });
    const first = tenants.withTenant(ctx(TENANT_A), async (tx) => {
      await loadSelectionFacts(tx, MEMBER(1));
      locked();
      await held;
    });
    await lockedSignal;
    let secondDone = false;
    const second = facts(TENANT_A, MEMBER(1)).then(() => {
      secondDone = true;
    });
    // Wait for the condition, not for a time: the second transaction is blocked on the row lock of the first.
    const probe = new Client({ connectionString: database.adminUrl });
    await probe.connect();
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await probe.query("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from machvon.membership%'");
        if ((rows[0]?.n as number) > 0) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      const { rows: waiting } = await probe.query("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from machvon.membership%'");
      expect(waiting[0]?.n).toBe(1);
    } finally {
      await probe.end();
    }
    expect(secondDone).toBe(false);
    releaseFirst();
    await first;
    await second;
    expect(secondDone).toBe(true);
  });
});
