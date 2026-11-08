import { randomBytes } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { SYSTEM_ROLES, seedSystemRoles } from '@machvon/db/src/system-roles';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { RoleDefinitionsController } from '../src/role-definitions.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, grantId, memberId, roleId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const ACTOR = '00000000-0000-4000-8000-0000000000f0';

const OWNER = 1;
const ADMIN = 2;
const UNIT_ADMIN = 3;
const READER_ONLY = 4;
const MEMBER = 5;
const NARROW = 6;

const GRANT_READER = 50;
const UNIT_HELPER = 51;
const ROLE_GRANTER_LOW = 52;
const PERMS_HOLDER = 53;
const RETIRED_ROLE = 61;
const SECRET_BETA_ROLE = 60;

interface Reply {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

interface RoleView {
  id: string;
  code: string;
  name: string;
  rank: number;
  permissions: string[];
  is_system: boolean;
  guest_allowed: boolean;
  status: string;
  version: number;
}

describe('role definition reads (ST-ADM-005 role picker, CR-ADM-05)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  const roles = new Map<string, string>();

  const get = async (path: string, member: number, tenant = TENANT_A): Promise<Reply> => {
    const token = signTenantContext(contextFor(tenant, memberId(member)), SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}${path}`, { headers: { [TENANT_HEADER]: token } });
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text) as Record<string, unknown>, text };
  };

  const itemsOf = (reply: Reply): RoleView[] => reply.json.items as RoleView[];
  const codesOf = (reply: Reply): string[] => itemsOf(reply).map((role) => role.code);

  async function giveRole(grantNumber: number, member: number, code: string, kind: string, refs: readonly string[] = []): Promise<void> {
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', $6, $7::uuid[], 'Active', $8, 'seed')`,
        [TENANT_A, grantId(grantNumber), memberId(member), roles.get(code), JSON.stringify({ kind, ref_ids: refs }), kind, refs, ACTOR],
      ],
    ]);
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: '/u1/' },
        { n: 2, path: '/u1/u2/', parent: 1 },
      ]);
      await harness.tenants.withTenant(contextFor(tenant, memberId(1)), (tx) => seedSystemRoles(tx, ACTOR));
    }
    for (const member of [OWNER, ADMIN, UNIT_ADMIN, READER_ONLY, MEMBER, NARROW]) await harness.seedMembership(TENANT_A, member, 1);
    await harness.seedMembership(TENANT_B, 1, 1);
    await harness.seedRole(TENANT_A, GRANT_READER, 'GRANT_READER', ['role_grant.read'], 30);
    await harness.seedRole(TENANT_A, UNIT_HELPER, 'UNIT_HELPER', ['iam.unit.manage'], 40);
    await harness.seedRole(TENANT_A, ROLE_GRANTER_LOW, 'ROLE_GRANTER_LOW', ['iam.role.grant', 'role_grant.read'], 10);
    await harness.seedRole(TENANT_A, PERMS_HOLDER, 'PERMS_HOLDER', ['iam.unit.manage'], 80);
    await harness.seedRole(TENANT_A, RETIRED_ROLE, 'RETIRED_ROLE', ['role_grant.read'], 75);
    await harness.owner(TENANT_A, [["update machvon.role_definition set status = 'Retired' where id = $1", [roleId(RETIRED_ROLE)]]]);
    await harness.seedRole(TENANT_B, SECRET_BETA_ROLE, 'BETA_SECRET_ROLE', ['report.read'], 10);
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      for (const row of (await client.query<{ id: string; code: string }>('select id, code from machvon.role_definition where tenant_id = $1', [TENANT_A])).rows) {
        roles.set(row.code, row.id);
      }
    } finally {
      await client.end();
    }
    await giveRole(1, OWNER, 'TENANT_OWNER', 'TENANT');
    await giveRole(2, ADMIN, 'TENANT_ADMIN', 'TENANT');
    await giveRole(3, ADMIN, 'GRANT_READER', 'TENANT');
    await giveRole(4, UNIT_ADMIN, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(2)]);
    await giveRole(5, UNIT_ADMIN, 'GRANT_READER', 'UNIT_SUBTREE', [unitId(2)]);
    await giveRole(6, READER_ONLY, 'GRANT_READER', 'TENANT');
    await giveRole(7, MEMBER, 'MEMBER', 'TENANT');
    await giveRole(8, NARROW, 'ROLE_GRANTER_LOW', 'TENANT');
    await giveRole(9, NARROW, 'PERMS_HOLDER', 'UNIT_SUBTREE', [unitId(2)]);

    const database = new TenantDatabase(harness.appPool);
    const access = new EffectiveAccessStore(database, new InMemoryAuthzCache());
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [PolicyModule.register({ database, access })],
      controllers: [RoleDefinitionsController],
      providers: [
        { provide: TenantDatabase, useValue: database },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('lists all 18 seeded system roles and the custom roles to a tenant owner', async () => {
    const reply = await get('/resources/role_definition?limit=200', OWNER);
    expect(reply.status).toBe(200);
    const codes = codesOf(reply);
    for (const role of SYSTEM_ROLES) expect(codes).toContain(role.code);
    expect(SYSTEM_ROLES).toHaveLength(18);
    expect(codes).toEqual(expect.arrayContaining(['GRANT_READER', 'UNIT_HELPER']));
    expect(codes).toEqual([...codes].sort());
    expect(reply.json.next_cursor).toBeNull();
    const owner = itemsOf(reply).find((role) => role.code === 'TENANT_OWNER');
    expect(owner).toMatchObject({ rank: 99, is_system: true, status: 'Active', version: 1 });
    expect(Object.keys(owner ?? {}).sort()).toEqual(['code', 'guest_allowed', 'id', 'is_system', 'name', 'permissions', 'rank', 'status', 'version']);
  });

  it('shows a tenant administrator every role except TENANT_OWNER, and with grantable=true only roles it could grant', async () => {
    const all = await get('/resources/role_definition?limit=200', ADMIN);
    expect(all.status).toBe(200);
    expect(codesOf(all)).not.toContain('TENANT_OWNER');
    expect(codesOf(all)).toEqual(expect.arrayContaining(['TENANT_ADMIN', 'UNIT_ADMIN', 'GRANT_READER']));

    const grantable = await get('/resources/role_definition?limit=200&grantable=true', ADMIN);
    expect(grantable.status).toBe(200);
    const codes = codesOf(grantable);
    expect(codes).toContain('UNIT_ADMIN');
    for (const refused of ['TENANT_OWNER', 'TENANT_ADMIN', 'SECURITY_ADMIN', 'LEADER']) expect(codes).not.toContain(refused);
    for (const role of itemsOf(grantable)) expect(role.rank).toBeLessThan(90);
  });

  it('shows a unit administrator only the roles it could grant inside its subtree, never TENANT_OWNER', async () => {
    const reply = await get('/resources/role_definition?limit=200', UNIT_ADMIN);
    expect(reply.status).toBe(200);
    // SPECIALIST and INVESTOR_OFFICER carry no permissions yet (matrix awaiting sign-off), so any grantor outranking them may grant them.
    expect(codesOf(reply).sort()).toEqual(['GRANT_READER', 'INVESTOR_OFFICER', 'ROLE_GRANTER_LOW', 'SPECIALIST', 'UNIT_HELPER']);
    for (const role of itemsOf(reply)) expect(role.rank).toBeLessThan(70);
  });

  it('leaves Retired roles out of the grantable list, because grantRole refuses a role that is not Active', async () => {
    const grantable = await get('/resources/role_definition?limit=200&grantable=true', ADMIN);
    expect(codesOf(grantable)).not.toContain('RETIRED_ROLE');
    // The role matrix (no grantable flag) still lists it for someone who manages roles tenant-wide.
    const all = await get('/resources/role_definition?limit=200', ADMIN);
    expect(itemsOf(all).find((role) => role.code === 'RETIRED_ROLE')?.status).toBe('Retired');
  });

  it('offers a role that the caller may grant inside a narrower scope, using the union of all their grants (BR-IAM-05)', async () => {
    // NARROW holds iam.role.grant tenant-wide (rank 10) and iam.unit.manage with rank 80 only inside unit 2: UNIT_HELPER
    // (iam.unit.manage, rank 40) is grantable there although it is not grantable on the tenant scope.
    const reply = await get('/resources/role_definition?limit=200&grantable=true', NARROW);
    expect(reply.status).toBe(200);
    expect(codesOf(reply)).toContain('UNIT_HELPER');
    // Nothing above the caller's rank in any scope is offered.
    expect(codesOf(reply)).not.toContain('PERMS_HOLDER');
    expect(codesOf(reply)).not.toContain('TENANT_OWNER');
  });

  it('shows a reader who cannot grant anything an empty list, not a denial', async () => {
    const reply = await get('/resources/role_definition?limit=200', READER_ONLY);
    expect(reply.status).toBe(200);
    expect(itemsOf(reply)).toEqual([]);
    expect(reply.json.next_cursor).toBeNull();
  });

  it('denies a caller without role_grant.read with 403 SCOPE_DENIED', async () => {
    const reply = await get('/resources/role_definition', MEMBER);
    expect(reply.status).toBe(403);
    expect(reply.json.code).toBe('SCOPE_DENIED');
  });

  it('pages with a cursor without repeating or skipping a role, also when the list is filtered', async () => {
    const full = codesOf(await get('/resources/role_definition?limit=200', OWNER));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const reply: Reply = await get(`/resources/role_definition?limit=4${cursor === null ? '' : `&cursor=${cursor}`}`, OWNER);
      expect(itemsOf(reply).length).toBeLessThanOrEqual(4);
      seen.push(...codesOf(reply));
      cursor = reply.json.next_cursor as string | null;
    } while (cursor !== null);
    expect(seen).toEqual(full);

    const filteredFull = codesOf(await get('/resources/role_definition?limit=200&grantable=true', ADMIN));
    const filtered: string[] = [];
    cursor = null;
    do {
      const reply: Reply = await get(`/resources/role_definition?limit=1&grantable=true${cursor === null ? '' : `&cursor=${cursor}`}`, ADMIN);
      filtered.push(...codesOf(reply));
      cursor = reply.json.next_cursor as string | null;
    } while (cursor !== null);
    expect(filtered).toEqual(filteredFull);
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('rejects a malformed limit, cursor or grantable flag with 422 VALIDATION_FAILED', async () => {
    for (const query of ['limit=0', 'limit=abc', 'cursor=not-a-cursor', 'grantable=maybe']) {
      const reply = await get(`/resources/role_definition?${query}`, OWNER);
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('VALIDATION_FAILED');
    }
  });

  describe('detail', () => {
    it('returns a visible role and answers 404 for TENANT_OWNER to a non-owner and for a missing id', async () => {
      const found = await get(`/resources/role_definition/${roles.get('UNIT_ADMIN')}`, ADMIN);
      expect(found.status).toBe(200);
      expect(found.json).toMatchObject({ code: 'UNIT_ADMIN', rank: 70, is_system: true });
      const owner = await get(`/resources/role_definition/${roles.get('TENANT_OWNER')}`, ADMIN);
      expect(owner.status).toBe(404);
      expect(owner.json.code).toBe('RESOURCE_NOT_FOUND');
      const missing = await get('/resources/role_definition/00000000-0000-4000-8000-0000000000ff', ADMIN);
      expect(missing.status).toBe(404);
    });

    it('answers 404 without any trace of a role of another tenant', async () => {
      const betaRole = roleId(SECRET_BETA_ROLE);
      const reply = await get(`/resources/role_definition/${betaRole}`, OWNER);
      expect(reply.status).toBe(404);
      expect(reply.json.code).toBe('RESOURCE_NOT_FOUND');
      for (const marker of [betaRole, 'BETA_SECRET_ROLE', TENANT_B]) expect(reply.text).not.toContain(marker);
    });

    it('hides from a unit administrator a role it could not grant', async () => {
      const reply = await get(`/resources/role_definition/${roles.get('TENANT_ADMIN')}`, UNIT_ADMIN);
      expect(reply.status).toBe(404);
    });

    it('rejects a malformed id with 400/422 instead of reaching the database', async () => {
      const reply = await get('/resources/role_definition/not-a-uuid', OWNER);
      expect([400, 422]).toContain(reply.status);
    });
  });
});
