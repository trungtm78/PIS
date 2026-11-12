import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { seedSystemRoles } from '@machvon/db/src/system-roles';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { CommandModule } from '../src/command.module';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { RoleGrantReadsController, RoleGrantsController } from '../src/role-grants.controller';
import { RolesController } from '../src/roles.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, grantId, id, memberId, roleId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const PROJECT_U2 = id(0x50, 1);
const PROJECT_U3 = id(0x50, 2);
const CONTRACT = id(0x51, 1);
const CONTRACT_OTHER = id(0x51, 2);
const CONTRACT_DRAFT = id(0x51, 3);
const CONTRACT_CLOSED = id(0x51, 4);
const CONTRACTOR = id(0x54, 1);
const OTHER_CONTRACTOR = id(0x54, 2);

const ADMIN = 1;
const UNIT_ADMIN = 2;
const RECIPIENT_A = 3;
const RECIPIENT_B = 4;
const GUEST = 5;
const OWNER_1 = 6;
const OWNER_2 = 7;
const SUSPENDED = 8;
const RECIPIENT_C = 9;
const HOLDER = 10;
const PROJECT_ADMIN = 11;
const RECIPIENT_D = 12;
const UNIT_ONLY_ADMIN = 13;
const MIXED_REVOKER = 14;
const LOW_ONLY_REVOKER = 15;
const RECIPIENT_E = 16;
const BORROWER = 17;
const RECIPIENT_F = 18;
const RECIPIENT_G = 19;
const RECIPIENT_H = 20;

// Custom roles used by the scenarios (ids from the fixture family 0x30).
const GRANT_READER = 50;
const UNIT_HELPER = 51;
const SYS_PATTERN = 52;
const HELD_ROLE = 53;
const NOTIFY_ROLE = 54;
const PROJECT_GRANTER = 55;
const PROJECT_LOW = 56;
const PROJECT_GRANTER_LOW = 57;
const PROJECT_MID = 58;
const AUDIT_HIGH = 59;
const PROJECT_GRANTER_TEN = 60;
const PROJECT_SEVENTY = 61;

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface Call {
  member: number;
  tenantId?: string;
  body?: unknown;
  key?: string;
  ifMatch?: string;
  aal2?: boolean;
}

describe('custom roles and role grants (ST-ADM-005 backend)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 100;
  const roles = new Map<string, string>();
  const nextGrant = (): number => (counter += 1);

  const call = async (method: string, path: string, options: Call): Promise<Reply> => {
    const token = signTenantContext(contextFor(options.tenantId ?? TENANT_A, memberId(options.member)), SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (options.aal2 === true) headers[CLAIMS_HEADER] = JSON.stringify({ aal: 'aal2', aal2At: new Date().toISOString() });
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  };

  const admin = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows as T[];
    } finally {
      await client.end();
    }
  };

  const scopeVersionOf = async (member: number, tenant = TENANT_A): Promise<number> =>
    Number((await admin<{ v: string }>('select scope_version::text as v from machvon.membership where tenant_id = $1 and id = $2', [tenant, memberId(member)]))[0]?.v);
  const auditCount = async (action: string, outcome: string, resourceType?: string): Promise<number> =>
    Number(
      (
        await admin<{ n: string }>(
          'select count(*) as n from machvon.audit_event where action = $1 and outcome = $2 and ($3::text is null or resource_type = $3)',
          [action, outcome, resourceType ?? null],
        )
      )[0]?.n,
    );
  const accessEvents = async (membership: number): Promise<number> =>
    Number(
      (
        await admin<{ n: string }>("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1' and aggregate_id = $1", [memberId(membership)])
      )[0]?.n,
    );

  async function giveRole(member: number, code: string, kind: string, refs: readonly string[] = []): Promise<string> {
    const grant = grantId(nextGrant());
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', $6, $7::uuid[], 'Active', $8, 'seed')`,
        [TENANT_A, grant, memberId(member), roles.get(code), JSON.stringify({ kind, ref_ids: refs }), kind, refs, ACTOR],
      ],
    ]);
    return grant;
  }

  async function seedProjectsAndContract(): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
         values ($1, $2, 'P1', 'Project 1', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1), ($1, $5, 'P2', 'Project 2', $6, $4, 'INTERNAL', 1000, 'CONCEPT', 1)`,
        [TENANT_A, PROJECT_U2, unitId(2), id(0x52, 1), PROJECT_U3, unitId(3)],
      );
      for (const [contractId, contractor, status, code] of [
        [CONTRACT, CONTRACTOR, 'ACTIVE', 'C1'],
        [CONTRACT_OTHER, OTHER_CONTRACTOR, 'ACTIVE', 'C2'],
        [CONTRACT_DRAFT, CONTRACTOR, 'DRAFT', 'C3'],
        [CONTRACT_CLOSED, CONTRACTOR, 'CLOSED', 'C4'],
      ] as const) {
        await client.query(
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from)
           values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, 1000, date '2026-01-01', date '2026-01-01')`,
          [TENANT_A, contractId, PROJECT_U2, id(0x53, 1), contractor, code, status],
        );
      }
      await client.query(
        `insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, 'sub-guest', 'guest@example.test', 'Guest', 'Active') on conflict do nothing`,
        [id(0x60, GUEST)],
      );
      await client.query(
        `insert into machvon.membership (tenant_id, id, user_id, organization_id, status, membership_type, contractor_id, valid_until)
         values ($1, $2, $3, $4, 'Active', 'GUEST_CONTRACTOR', $5, now() + interval '90 days')`,
        [TENANT_A, memberId(GUEST), id(0x60, GUEST), unitId(1), CONTRACTOR],
      );
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: '/u1/' },
        { n: 2, path: '/u1/u2/', parent: 1 },
        { n: 3, path: '/u1/u3/', parent: 1 },
        { n: 4, path: '/u1/u2/u4/', parent: 2 },
      ]);
      await harness.tenants.withTenant(contextFor(tenant, memberId(1)), (tx) => seedSystemRoles(tx, ACTOR));
    }
    for (const member of [ADMIN, UNIT_ADMIN, RECIPIENT_A, RECIPIENT_B, OWNER_1, OWNER_2, RECIPIENT_C, HOLDER, PROJECT_ADMIN, RECIPIENT_D, UNIT_ONLY_ADMIN, MIXED_REVOKER, LOW_ONLY_REVOKER, RECIPIENT_E, BORROWER, RECIPIENT_F, RECIPIENT_G, RECIPIENT_H]) {
      await harness.seedMembership(TENANT_A, member, 1);
    }
    await harness.seedMembership(TENANT_A, SUSPENDED, 1, { status: 'Suspended' });
    await harness.seedMembership(TENANT_B, 1, 1);
    await seedProjectsAndContract();
    await harness.seedRole(TENANT_A, GRANT_READER, 'GRANT_READER', ['role_grant.read'], 30);
    await harness.seedRole(TENANT_A, UNIT_HELPER, 'UNIT_HELPER', ['iam.unit.manage'], 40);
    await harness.seedRole(TENANT_A, HELD_ROLE, 'HELD_ROLE', ['iam.unit.manage'], 45);
    await harness.seedRole(TENANT_A, PROJECT_GRANTER, 'PROJECT_GRANTER', ['iam.role.grant', 'role_grant.read'], 80);
    await harness.seedRole(TENANT_A, PROJECT_LOW, 'PROJECT_LOW', ['report.read'], 20);
    await harness.seedRole(TENANT_A, PROJECT_GRANTER_LOW, 'PROJECT_GRANTER_LOW', ['iam.role.grant'], 20);
    await harness.seedRole(TENANT_A, PROJECT_MID, 'PROJECT_MID', ['report.read'], 40);
    await harness.seedRole(TENANT_A, AUDIT_HIGH, 'AUDIT_HIGH', ['audit.read'], 89);
    await harness.seedRole(TENANT_A, PROJECT_GRANTER_TEN, 'PROJECT_GRANTER_TEN', ['iam.role.grant'], 10);
    await harness.seedRole(TENANT_A, PROJECT_SEVENTY, 'PROJECT_SEVENTY', ['report.read'], 70);
    const found = await admin<{ id: string; code: string }>('select id, code from machvon.role_definition where tenant_id = $1', [TENANT_A]);
    for (const row of found) roles.set(row.code, row.id);
    await giveRole(ADMIN, 'TENANT_ADMIN', 'TENANT');
    await giveRole(ADMIN, 'GRANT_READER', 'TENANT');
    await giveRole(UNIT_ADMIN, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(2)]);
    await giveRole(RECIPIENT_A, 'GRANT_READER', 'TENANT');
    await giveRole(OWNER_1, 'TENANT_OWNER', 'TENANT');
    await giveRole(OWNER_2, 'TENANT_OWNER', 'TENANT');
    await giveRole(GUEST, 'GUEST_CONTRACTOR', 'CONTRACT', [CONTRACT]);
    await giveRole(HOLDER, 'HELD_ROLE', 'TENANT');
    await giveRole(UNIT_ADMIN, 'GRANT_READER', 'UNIT_SUBTREE', [unitId(2)]);
    await giveRole(PROJECT_ADMIN, 'PROJECT_GRANTER', 'PROJECT', [PROJECT_U2]);
    await giveRole(RECIPIENT_D, 'PROJECT_LOW', 'PROJECT', [PROJECT_U2]);
    await giveRole(UNIT_ONLY_ADMIN, 'PROJECT_GRANTER', 'UNIT_ONLY', [unitId(2)]);
    await giveRole(MIXED_REVOKER, 'PROJECT_GRANTER', 'UNIT_SUBTREE', [unitId(2)]);
    await giveRole(MIXED_REVOKER, 'PROJECT_GRANTER_LOW', 'PROJECT', [PROJECT_U2]);
    await giveRole(LOW_ONLY_REVOKER, 'PROJECT_GRANTER_LOW', 'PROJECT', [PROJECT_U2]);
    await giveRole(RECIPIENT_E, 'PROJECT_MID', 'PROJECT', [PROJECT_U2]);
    await giveRole(RECIPIENT_H, 'PROJECT_MID', 'PROJECT', [PROJECT_U2]);
    await giveRole(BORROWER, 'AUDIT_HIGH', 'UNIT_SUBTREE', [unitId(2)]);
    await giveRole(BORROWER, 'PROJECT_GRANTER_TEN', 'PROJECT', [PROJECT_U2]);
    await giveRole(RECIPIENT_F, 'PROJECT_SEVENTY', 'PROJECT', [PROJECT_U2]);

    const database = new TenantDatabase(harness.appPool);
    const access = new EffectiveAccessStore(database, new InMemoryAuthzCache());
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database }), PolicyModule.register({ database, access })],
      controllers: [RolesController, RoleGrantsController, RoleGrantReadsController],
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

  const grantBody = (member: number, role: string, kind = 'TENANT', refs: readonly string[] = []): Record<string, unknown> => ({
    membership_id: memberId(member),
    role_id: roles.get(role),
    scope_kind: kind,
    ...(refs.length > 0 ? { scope_ref_ids: refs } : {}),
    reason: 'needed for the programme',
  });

  describe('grantRole anti-escalation', () => {
    it('AC-ST-ADM-005-1: a TENANT_ADMIN of rank 90 cannot grant TENANT_ADMIN, but can grant UNIT_ADMIN', async () => {
      const before = await auditCount('command.denied:grantRole', 'DENIED');
      const denied = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: grantBody(RECIPIENT_A, 'TENANT_ADMIN') });
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('ROLE_ESCALATION_DENIED');
      expect(await auditCount('command.denied:grantRole', 'DENIED')).toBe(before + 1);

      const sv = await scopeVersionOf(RECIPIENT_A);
      const events = await accessEvents(RECIPIENT_A);
      const ok = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: grantBody(RECIPIENT_A, 'UNIT_ADMIN') });
      expect(ok.status).toBe(201);
      expect(ok.json).toMatchObject({ status: 'CREATED', resource_version: 1 });
      expect(await scopeVersionOf(RECIPIENT_A)).toBe(sv + 1);
      expect(await accessEvents(RECIPIENT_A)).toBe(events + 1);
      expect(await auditCount('grant.create', 'SUCCESS', 'role_grant')).toBeGreaterThanOrEqual(1);
    });

    it('AC-ST-ADM-005-2: nobody can grant a role to themselves, and the refusal is audited as DENIED', async () => {
      const before = await auditCount('command.denied:grantRole', 'DENIED');
      const reply = await call('POST', '/role-grants', { member: UNIT_ADMIN, aal2: true, body: grantBody(UNIT_ADMIN, 'LEADER', 'UNIT_SUBTREE', [unitId(2)]) });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SELF_GRANT_DENIED');
      expect(await auditCount('command.denied:grantRole', 'DENIED')).toBe(before + 1);
    });

    it('AC-ST-ADM-005-3, UAT-AC105: a UNIT_ADMIN of one department cannot grant in another, but can in their own subtree, on units and on projects', async () => {
      const other = await call('POST', '/role-grants', { member: UNIT_ADMIN, aal2: true, body: grantBody(RECIPIENT_B, 'UNIT_HELPER', 'UNIT_SUBTREE', [unitId(3)]) });
      expect(other.status).toBe(403);
      expect(other.json.code).toBe('SCOPE_OUT_OF_GRANTOR_RANGE');

      const own = await call('POST', '/role-grants', { member: UNIT_ADMIN, aal2: true, body: grantBody(RECIPIENT_B, 'UNIT_HELPER', 'UNIT_SUBTREE', [unitId(2)]) });
      expect(own.status).toBe(201);

      const projectOut = await call('POST', '/role-grants', { member: UNIT_ADMIN, aal2: true, body: grantBody(RECIPIENT_B, 'UNIT_HELPER', 'PROJECT', [PROJECT_U3]) });
      expect(projectOut.status).toBe(403);
      expect(projectOut.json.code).toBe('SCOPE_OUT_OF_GRANTOR_RANGE');
      const projectIn = await call('POST', '/role-grants', { member: UNIT_ADMIN, aal2: true, body: grantBody(RECIPIENT_B, 'UNIT_HELPER', 'PROJECT', [PROJECT_U2]) });
      expect(projectIn.status).toBe(201);
      const contractIn = await call('POST', '/role-grants', { member: UNIT_ADMIN, aal2: true, body: grantBody(RECIPIENT_B, 'UNIT_HELPER', 'CONTRACT', [CONTRACT]) });
      expect(contractIn.status).toBe(201);
    });

    it('refuses a role with more permissions than the grantor holds', async () => {
      const reply = await call('POST', '/role-grants', { member: UNIT_ADMIN, aal2: true, body: grantBody(RECIPIENT_C, 'LEADER', 'UNIT_SUBTREE', [unitId(2)]) });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('ROLE_ESCALATION_DENIED');
    });

    it('AC-ST-ADM-005-5: a role that carries a system permission cannot be granted, even if one existed before the database refused it', async () => {
      // V007 makes such a role impossible to store, so the API check is defence in depth: the constraint is lifted for this
      // test only, a role from before the constraint is planted, and the constraint is restored from its own definition.
      const constraint = 'role_definition_no_system_permission_ck';
      const [found] = await admin<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'machvon.role_definition'::regclass and conname = $1",
        [constraint],
      );
      const definition = found?.definition ?? '';
      expect(definition).toContain('system');
      await admin(`alter table machvon.role_definition drop constraint ${constraint}`);
      try {
        await harness.seedRole(TENANT_A, SYS_PATTERN, 'SYS_PATTERN', ['system.*'], 20);
        roles.set('SYS_PATTERN', roleId(SYS_PATTERN));
        const reply = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: grantBody(RECIPIENT_C, 'SYS_PATTERN') });
        expect(reply.status).toBe(422);
        expect(reply.json.code).toBe('SYSTEM_PERMISSION_NOT_GRANTABLE');
      } finally {
        await admin('delete from machvon.role_definition where tenant_id = $1 and code = $2', [TENANT_A, 'SYS_PATTERN']);
        roles.delete('SYS_PATTERN');
        await admin(`alter table machvon.role_definition add constraint ${constraint} ${definition}`);
      }
    });

    it('a TENANT_OWNER cannot be granted from the tenant plane, not even by another owner', async () => {
      const reply = await call('POST', '/role-grants', { member: OWNER_1, aal2: true, body: grantBody(RECIPIENT_C, 'TENANT_OWNER') });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('ROLE_ESCALATION_DENIED');
    });

    it('AC-ST-ADM-005-6: a guest contractor calling grantRole is refused by the policy guard with a DENIED audit row', async () => {
      const before = await auditCount('authz.denied:grantRole', 'DENIED');
      const reply = await call('POST', '/role-grants', { member: GUEST, aal2: true, body: grantBody(RECIPIENT_C, 'MEMBER') });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
      expect(await auditCount('authz.denied:grantRole', 'DENIED')).toBe(before + 1);
    });

    it('requires step-up: aal1 gets 403 MFA_REQUIRED and nothing is written', async () => {
      const sv = await scopeVersionOf(RECIPIENT_C);
      const reply = await call('POST', '/role-grants', { member: ADMIN, body: grantBody(RECIPIENT_C, 'UNIT_ADMIN') });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('MFA_REQUIRED');
      expect(await scopeVersionOf(RECIPIENT_C)).toBe(sv);
    });

    it('keeps a guest contractor to guest roles on contracts (BR-IAM-08)', async () => {
      const wrongRole = await call('POST', '/role-grants', { member: OWNER_1, aal2: true, body: grantBody(GUEST, 'SPECIALIST', 'CONTRACT', [CONTRACT]) });
      expect(wrongRole.status).toBe(422);
      expect(wrongRole.json.code).toBe('GUEST_SCOPE_INVALID');
      const wrongScope = await call('POST', '/role-grants', { member: OWNER_1, aal2: true, body: grantBody(GUEST, 'GUEST_CONTRACTOR') });
      expect(wrongScope.status).toBe(422);
      expect(wrongScope.json.code).toBe('GUEST_SCOPE_INVALID');
      const fine = await call('POST', '/role-grants', { member: OWNER_1, aal2: true, body: grantBody(GUEST, 'MEMBER', 'CONTRACT', [CONTRACT]) });
      expect(fine.status).toBe(201);
    });

    it('BR-IAM-08: a guest only receives contracts of their own contractor that are in force', async () => {
      const foreign = await call('POST', '/role-grants', { member: OWNER_1, aal2: true, body: grantBody(GUEST, 'MEMBER', 'CONTRACT', [CONTRACT_OTHER]) });
      expect(foreign.status).toBe(422);
      expect(foreign.json.code).toBe('GUEST_SCOPE_INVALID');
      const draft = await call('POST', '/role-grants', { member: OWNER_1, aal2: true, body: grantBody(GUEST, 'MEMBER', 'CONTRACT', [CONTRACT_DRAFT]) });
      expect(draft.status).toBe(422);
      expect(draft.json.code).toBe('CONTRACT_NOT_ACTIVE');
      const closed = await call('POST', '/role-grants', { member: OWNER_1, aal2: true, body: grantBody(GUEST, 'MEMBER', 'CONTRACT', [CONTRACT_CLOSED]) });
      expect(closed.status).toBe(422);
      expect(closed.json.code).toBe('CONTRACT_NOT_ACTIVE');
      const mixed = await call('POST', '/role-grants', { member: OWNER_1, aal2: true, body: grantBody(GUEST, 'MEMBER', 'CONTRACT', [CONTRACT, CONTRACT_OTHER]) });
      expect(mixed.json.code).toBe('GUEST_SCOPE_INVALID');
    });

    it('refuses a window that ends in the past without a start with 422 VALIDATION_FAILED and writes nothing', async () => {
      const sv = await scopeVersionOf(RECIPIENT_B);
      const reply = await call('POST', '/role-grants', {
        member: ADMIN,
        aal2: true,
        body: { ...grantBody(RECIPIENT_B, 'UNIT_ADMIN'), effective_until: '2000-01-01T00:00:00Z' },
      });
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('VALIDATION_FAILED');
      expect(await scopeVersionOf(RECIPIENT_B)).toBe(sv);
    });

    it('answers 404 for a recipient that does not exist or belongs to another tenant, and 403 for an inactive one', async () => {
      const unknown = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: { ...grantBody(RECIPIENT_C, 'UNIT_ADMIN'), membership_id: memberId(99) } });
      expect(unknown.status).toBe(404);
      const foreign = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: { ...grantBody(RECIPIENT_C, 'UNIT_ADMIN'), membership_id: memberId(1) } });
      expect(foreign.status).toBe(403); // member 1 of tenant A is the grantor itself: self grant, not a leak of tenant B
      const inactive = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: grantBody(SUSPENDED, 'UNIT_ADMIN') });
      expect(inactive.status).toBe(403);
      expect(inactive.json.code).toBe('MEMBERSHIP_INACTIVE');
    });

    it('refuses a duplicate Active grant with 409 ROLE_GRANT_EXISTS and invalid bodies with 400/422', async () => {
      const dup = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: grantBody(RECIPIENT_C, 'UNIT_HELPER') });
      expect(dup.status).toBe(201);
      const again = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: grantBody(RECIPIENT_C, 'UNIT_HELPER') });
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('ROLE_GRANT_EXISTS');
      const extra = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: { ...grantBody(RECIPIENT_C, 'UNIT_HELPER'), granted_by: memberId(1) } });
      expect(extra.json.code).toBe('FIELD_NOT_ALLOWED');
      const badKind = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: { ...grantBody(RECIPIENT_C, 'UNIT_HELPER'), scope_kind: 'GALAXY' } });
      expect(badKind.json.code).toBe('INVALID_REQUEST');
      const tenantWithRefs = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: { ...grantBody(RECIPIENT_C, 'UNIT_HELPER'), scope_ref_ids: [unitId(2)] } });
      expect(tenantWithRefs.json.code).toBe('INVALID_REQUEST');
      const unitWithoutRefs = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: { ...grantBody(RECIPIENT_C, 'UNIT_HELPER'), scope_kind: 'UNIT_ONLY' } });
      expect(unitWithoutRefs.json.code).toBe('INVALID_REQUEST');
      const unknownUnit = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body: grantBody(RECIPIENT_C, 'UNIT_HELPER', 'UNIT_ONLY', [unitId(77)]) });
      expect(unknownUnit.status).toBe(422);
      const backwards = await call('POST', '/role-grants', {
        member: ADMIN,
        aal2: true,
        body: { ...grantBody(RECIPIENT_C, 'UNIT_HELPER', 'UNIT_ONLY', [unitId(3)]), effective_from: '2031-01-01T00:00:00Z', effective_until: '2030-01-01T00:00:00Z' },
      });
      expect(backwards.status).toBe(422);
    });

    it('serialises two concurrent grants to one recipient: both commit and scope_version rises by two', async () => {
      const sv = await scopeVersionOf(RECIPIENT_C);
      const [one, two] = await Promise.all([
        call('POST', '/role-grants', { member: ADMIN, aal2: true, body: grantBody(RECIPIENT_C, 'UNIT_HELPER', 'UNIT_ONLY', [unitId(2)]) }),
        call('POST', '/role-grants', { member: ADMIN, aal2: true, body: grantBody(RECIPIENT_C, 'UNIT_HELPER', 'UNIT_ONLY', [unitId(3)]) }),
      ]);
      expect([one.status, two.status]).toEqual([201, 201]);
      expect(await scopeVersionOf(RECIPIENT_C)).toBe(sv + 2);
    });

    it('replays an identical grant request without granting twice', async () => {
      const key = `key-${randomUUID()}`;
      const body = grantBody(RECIPIENT_B, 'UNIT_HELPER', 'UNIT_ONLY', [unitId(3)]);
      const sv = await scopeVersionOf(RECIPIENT_B);
      // UNIT_ADMIN of u2 may not grant on u3, so use the admin.
      const first = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body, key });
      const second = await call('POST', '/role-grants', { member: ADMIN, aal2: true, body, key });
      expect(first.status).toBe(201);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(await scopeVersionOf(RECIPIENT_B)).toBe(sv + 1);
    });
  });

  describe('revokeRoleGrant', () => {
    const grantOf = async (member: number, roleCode: string): Promise<{ id: string; version: number }> => {
      const rows = await admin<{ id: string; version: string }>(
        "select id, version::text as version from machvon.role_grant where tenant_id = $1 and membership_id = $2 and role_id = $3 and status = 'Active' order by created_at desc limit 1",
        [TENANT_A, memberId(member), roles.get(roleCode)],
      );
      return { id: rows[0]?.id ?? '', version: Number(rows[0]?.version) };
    };

    it('revokes with the right version, bumps scope_version once, and refuses a second revocation', async () => {
      const target = await grantOf(RECIPIENT_A, 'UNIT_ADMIN');
      const sv = await scopeVersionOf(RECIPIENT_A);
      const missing = await call('POST', `/role-grants/${target.id}/revoke`, { member: ADMIN, aal2: true, body: { reason: 'no longer in this role' } });
      expect(missing.status).toBe(428);
      const stale = await call('POST', `/role-grants/${target.id}/revoke`, { member: ADMIN, aal2: true, ifMatch: `"${target.version + 5}"`, body: { reason: 'no longer in this role' } });
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      const ok = await call('POST', `/role-grants/${target.id}/revoke`, { member: ADMIN, aal2: true, ifMatch: `"${target.version}"`, body: { reason: 'no longer in this role' } });
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ status: 'REVOKED', resource_version: target.version + 1, resource_id: target.id });
      expect(await scopeVersionOf(RECIPIENT_A)).toBe(sv + 1);
      const again = await call('POST', `/role-grants/${target.id}/revoke`, { member: ADMIN, aal2: true, ifMatch: `"${target.version + 1}"`, body: { reason: 'revoking it a second time' } });
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('STAGE_TRANSITION_DENIED');
    });

    it('lets a higher rank revoke a grant of a role whose permissions it does not hold (BR-IAM-05 (c) is for granting only)', async () => {
      // ADMIN (TENANT_ADMIN, rank 90) holds iam.*, adm.*, audit.read and role_grant.read, but not notification.self.
      await harness.seedRole(TENANT_A, NOTIFY_ROLE, 'NOTIFY_ONLY', ['notification.self'], 20);
      roles.set('NOTIFY_ONLY', roleId(NOTIFY_ROLE));
      await giveRole(RECIPIENT_C, 'NOTIFY_ONLY', 'TENANT');
      const target = await grantOf(RECIPIENT_C, 'NOTIFY_ONLY');
      const sv = await scopeVersionOf(RECIPIENT_C);
      const reply = await call('POST', `/role-grants/${target.id}/revoke`, { member: ADMIN, aal2: true, ifMatch: `"${target.version}"`, body: { reason: 'removing a role that I do not hold myself' } });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'REVOKED', resource_id: target.id });
      expect(await scopeVersionOf(RECIPIENT_C)).toBe(sv + 1);
    });

    it('lets a project-scoped administrator revoke a lower-ranked grant on that project: the rank is judged on the scope that authorised the revoke', async () => {
      const target = await grantOf(RECIPIENT_D, 'PROJECT_LOW');
      const reply = await call('POST', `/role-grants/${target.id}/revoke`, {
        member: PROJECT_ADMIN,
        aal2: true,
        ifMatch: `"${target.version}"`,
        body: { reason: 'the project work is finished' },
      });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'REVOKED', resource_id: target.id });
    });

    const revoke = (member: number, target: { id: string; version: number }): Promise<Reply> =>
      call('POST', `/role-grants/${target.id}/revoke`, { member, aal2: true, ifMatch: `"${target.version}"`, body: { reason: 'the project work is finished' } });

    it('judges the revoker rank over every grant that covers the grant scope: a unit-subtree grant of rank 80 plus a project grant of rank 20 can revoke a rank-40 project grant', async () => {
      const target = await grantOf(RECIPIENT_E, 'PROJECT_MID');
      const reply = await revoke(MIXED_REVOKER, target);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'REVOKED', resource_id: target.id });
    });

    it('still refuses a revoker whose only grant is the rank-20 project grant against a rank-40 grant', async () => {
      const target = await grantOf(RECIPIENT_H, 'PROJECT_MID');
      const reply = await revoke(LOW_ONLY_REVOKER, target);
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('ROLE_ESCALATION_DENIED');
    });

    it('documented BR-IAM-05 (b): rank counts across all covering grants, even a rank-89 role that carries no iam.role.grant', async () => {
      // The revoker holds iam.role.grant only through a rank-10 project grant, and a rank-89 audit role on the owning unit.
      // BR-IAM-05 judges "the highest rank of the grantor within the scope", so the rank-89 grant counts and a rank-70 revoke is allowed.
      const target = await grantOf(RECIPIENT_F, 'PROJECT_SEVENTY');
      const reply = await revoke(BORROWER, target);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'REVOKED', resource_id: target.id });
    });

    it('refuses to revoke one own grant with 403 SELF_ACTION_DENIED and an audit row', async () => {
      const own = await grantOf(UNIT_ADMIN, 'UNIT_ADMIN');
      const before = await auditCount('command.denied:revokeRoleGrant', 'DENIED');
      const reply = await call('POST', `/role-grants/${own.id}/revoke`, { member: UNIT_ADMIN, aal2: true, ifMatch: `"${own.version}"`, body: { reason: 'trying to remove myself' } });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SELF_ACTION_DENIED');
      expect(await auditCount('command.denied:revokeRoleGrant', 'DENIED')).toBe(before + 1);
    });

    it('does not let a lower rank revoke a higher one, and does not let an owner revoke another owner', async () => {
      const adminGrant = await grantOf(ADMIN, 'TENANT_ADMIN');
      const low = await call('POST', `/role-grants/${adminGrant.id}/revoke`, { member: UNIT_ADMIN, aal2: true, ifMatch: `"${adminGrant.version}"`, body: { reason: 'removing the administrator' } });
      expect(low.status).toBe(403);
      const ownerGrant = await grantOf(OWNER_2, 'TENANT_OWNER');
      const peer = await call('POST', `/role-grants/${ownerGrant.id}/revoke`, { member: OWNER_1, aal2: true, ifMatch: `"${ownerGrant.version}"`, body: { reason: 'removing the other owner' } });
      expect(peer.status).toBe(403);
      expect(peer.json.code).toBe('ROLE_ESCALATION_DENIED');
    });

    it('answers 404 for an unknown grant', async () => {
      const reply = await call('POST', `/role-grants/${grantId(9999)}/revoke`, { member: ADMIN, aal2: true, ifMatch: '"1"', body: { reason: 'this grant does not exist' } });
      expect(reply.status).toBe(404);
    });
  });

  describe('custom roles', () => {
    it('AC-ST-ADM-005-4: rejects a system permission with 422, permissions the grantor lacks with 403 and rank 95 with 400', async () => {
      const system = await call('POST', '/roles', { member: ADMIN, body: { code: 'SYSTEMISH', name: 'Systemish', permissions: ['system.tenant.manage'], rank: 50 } });
      expect(system.status).toBe(422);
      expect(system.json.code).toBe('SYSTEM_PERMISSION_NOT_GRANTABLE');
      const lacking = await call('POST', '/roles', { member: ADMIN, body: { code: 'LACKING', name: 'Lacking', permissions: ['contract.read'], rank: 50 } });
      expect(lacking.status).toBe(403);
      expect(lacking.json.code).toBe('ROLE_ESCALATION_DENIED');
      const rank = await call('POST', '/roles', { member: ADMIN, body: { code: 'TOO_HIGH', name: 'Too high', permissions: ['iam.unit.manage'], rank: 95 } });
      expect(rank.status).toBe(400);
      expect(rank.json.code).toBe('INVALID_REQUEST');
      expect(Number((await admin<{ n: string }>("select count(*) as n from machvon.role_definition where code in ('SYSTEMISH','LACKING','TOO_HIGH')"))[0]?.n)).toBe(0);
    });

    it('creates a custom role, audits it, and refuses a duplicate code and unknown permission names', async () => {
      const created = await call('POST', '/roles', { member: ADMIN, body: { code: 'UNIT_CLERK', name: 'Unit clerk', permissions: ['iam.unit.manage'], rank: 35, guest_allowed: false } });
      expect(created.status).toBe(201);
      expect(created.json).toMatchObject({ status: 'CREATED', resource_version: 1 });
      expect(await auditCount('role.create', 'SUCCESS', 'role_definition')).toBeGreaterThanOrEqual(1);
      const dup = await call('POST', '/roles', { member: ADMIN, body: { code: 'UNIT_CLERK', name: 'Unit clerk', permissions: ['iam.unit.manage'], rank: 35 } });
      expect(dup.status).toBe(409);
      expect(dup.json.code).toBe('ROLE_CODE_TAKEN');
      for (const permissions of [['iam.nothing.here'], ['iam.unit.manage', 'iam.unit.manage'], ['nonsense.*'], ['Iam.Unit']]) {
        const unknown = await call('POST', '/roles', { member: ADMIN, body: { code: 'UNKNOWN_PERMS', name: 'Unknown', permissions, rank: 35 } });
        expect(unknown.status).toBe(422);
        expect(unknown.json.code).toBe('VALIDATION_FAILED');
      }
      const shapes: Array<[string, unknown]> = [
        ['code', { code: 'x', name: 'n', permissions: ['iam.unit.manage'], rank: 35 }],
        ['permissions', { code: 'GOOD_CODE', name: 'n', permissions: [], rank: 35 }],
        ['rank', { code: 'GOOD_CODE', name: 'n', permissions: ['iam.unit.manage'], rank: 0 }],
        ['guest_allowed', { code: 'GOOD_CODE', name: 'n', permissions: ['iam.unit.manage'], rank: 35, guest_allowed: 'yes' }],
      ];
      for (const [field, body] of shapes) {
        const reply = await call('POST', '/roles', { member: ADMIN, body });
        expect(reply.json).toMatchObject({ code: 'INVALID_REQUEST', detail: field });
      }
      const extra = await call('POST', '/roles', { member: ADMIN, body: { code: 'GOOD_CODE', name: 'n', permissions: ['iam.unit.manage'], rank: 35, is_system: true } });
      expect(extra.json.code).toBe('FIELD_NOT_ALLOWED');
    });

    it('is not available to a member without iam.role.manage', async () => {
      const reply = await call('POST', '/roles', { member: UNIT_ADMIN, body: { code: 'SNEAKY_ROLE', name: 'Sneaky', permissions: ['iam.unit.manage'], rank: 35 } });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('SCOPE_DENIED');
    });

    it('updates a held role: new permissions, version 2, scope_version of every holder raised, access event emitted', async () => {
      const role = roles.get('HELD_ROLE');
      const sv = await scopeVersionOf(HOLDER);
      const missing = await call('PUT', `/roles/${role}`, { member: ADMIN, body: { permissions: ['iam.unit.manage'], reason: 'tidy the role definition' } });
      expect(missing.status).toBe(428);
      const ok = await call('PUT', `/roles/${role}`, {
        member: ADMIN,
        ifMatch: '"1"',
        body: { name: 'Held role v2', permissions: ['iam.unit.manage', 'iam.member.manage'], reason: 'tidy the role definition' },
      });
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ status: 'UPDATED', resource_version: 2 });
      expect(await scopeVersionOf(HOLDER)).toBe(sv + 1);
      expect(Number((await admin<{ n: string }>("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1' and aggregate_id = $1", [role]))[0]?.n)).toBe(1);
      const stale = await call('PUT', `/roles/${role}`, { member: ADMIN, ifMatch: '"1"', body: { permissions: ['iam.unit.manage'], reason: 'second writer with the old version' } });
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 2 });
    });

    it('updates a role nobody holds without touching any scope_version and keeps its name', async () => {
      const created = await call('POST', '/roles', { member: ADMIN, body: { code: 'UNHELD_ROLE', name: 'Unheld', permissions: ['iam.unit.manage'], rank: 20 } });
      const roleIdValue = created.json.resource_id as string;
      const events = Number((await admin<{ n: string }>("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1'"))[0]?.n);
      const updated = await call('PUT', `/roles/${roleIdValue}`, { member: ADMIN, ifMatch: '"1"', body: { permissions: ['iam.unit.manage'], reason: 'nobody holds this role yet' } });
      expect(updated.status).toBe(200);
      expect(Number((await admin<{ n: string }>("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1'"))[0]?.n)).toBe(events);
      const stored = await admin<{ name: string; rank: number; version: string }>('select name, rank, version::text as version from machvon.role_definition where id = $1', [roleIdValue]);
      expect(stored[0]).toEqual({ name: 'Unheld', rank: 20, version: '2' });
    });

    it('refuses to change a system role, a role beyond the editor, and permissions the editor lacks', async () => {
      const system = await call('PUT', `/roles/${roles.get('TENANT_ADMIN')}`, { member: ADMIN, ifMatch: '"1"', body: { permissions: ['iam.unit.manage'], reason: 'trying to weaken the admin' } });
      expect(system.status).toBe(409);
      expect(system.json.code).toBe('SYSTEM_ROLE_IMMUTABLE');
      const lacking = await call('PUT', `/roles/${roles.get('UNIT_HELPER')}`, { member: ADMIN, ifMatch: '"1"', body: { permissions: ['contract.read'], reason: 'granting more than I hold' } });
      expect(lacking.status).toBe(403);
      expect(lacking.json.code).toBe('ROLE_ESCALATION_DENIED');
      const missingRole = await call('PUT', `/roles/${roleId(9999)}`, { member: ADMIN, ifMatch: '"1"', body: { permissions: ['iam.unit.manage'], reason: 'role does not exist' } });
      expect(missingRole.status).toBe(404);
    });
  });

  describe('without the policy guard', () => {
    it('refuses a command that needs the caller access with 401 SESSION_EXPIRED instead of acting anonymously', async () => {
      const database = new TenantDatabase(harness.appPool);
      const bare = await startTestApp({
        signingKey: SIGNING_KEY,
        imports: [CommandModule.register({ database })],
        controllers: [RolesController],
        providers: [{ provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
      });
      try {
        const token = signTenantContext(contextFor(TENANT_A, memberId(ADMIN)), SIGNING_KEY);
        const response = await fetch(`${bare.baseUrl}/roles`, {
          method: 'POST',
          headers: { [TENANT_HEADER]: token, 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}` },
          body: JSON.stringify({ code: 'ANON_ROLE', name: 'Anonymous', permissions: ['iam.unit.manage'], rank: 20 }),
        });
        expect(response.status).toBe(401);
        expect(((await response.json()) as { code: string }).code).toBe('SESSION_EXPIRED');
      } finally {
        await bare.close();
      }
    });
  });

  describe('reads', () => {
    it('lists every grant for a caller who holds iam.role.grant, in pages, and only their own for anyone else', async () => {
      const all = await call('GET', '/resources/role_grant?limit=3', { member: ADMIN });
      expect(all.status).toBe(200);
      const first = all.json.items as Array<{ id: string; membership_id: string }>;
      expect(first).toHaveLength(3);
      expect(typeof all.json.next_cursor).toBe('string');
      const next = await call('GET', `/resources/role_grant?limit=3&cursor=${all.json.next_cursor as string}`, { member: ADMIN });
      const second = next.json.items as Array<{ id: string }>;
      expect(second.length).toBeGreaterThan(0);
      expect(second.every((row) => !first.some((seen) => seen.id === row.id))).toBe(true);
      expect(new Set((all.json.items as Array<{ membership_id: string }>).map((row) => row.membership_id)).size).toBeGreaterThan(0);

      const mine = await call('GET', '/resources/role_grant?limit=200', { member: RECIPIENT_A });
      const rows = mine.json.items as Array<{ membership_id: string; role_code: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.membership_id === memberId(RECIPIENT_A))).toBe(true);
    });

    it('reads one grant, hides another member grant from an ordinary reader, and never shows another tenant', async () => {
      const adminGrant = (await admin<{ id: string }>("select id from machvon.role_grant where tenant_id = $1 and membership_id = $2 and role_id = $3 limit 1", [TENANT_A, memberId(ADMIN), roles.get('TENANT_ADMIN')]))[0]?.id;
      const asAdmin = await call('GET', `/resources/role_grant/${adminGrant}`, { member: ADMIN });
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.json).toMatchObject({ id: adminGrant, role_code: 'TENANT_ADMIN', scope_kind: 'TENANT', status: 'Active' });
      const asOther = await call('GET', `/resources/role_grant/${adminGrant}`, { member: RECIPIENT_A });
      expect(asOther.status).toBe(404);
      expect(asOther.json.code).toBe('RESOURCE_NOT_FOUND');
      const foreign = await call('GET', `/resources/role_grant/${adminGrant}`, { member: 1, tenantId: TENANT_B });
      expect(foreign.status).toBe(403);
    });

    it('shows a caller who holds iam.role.grant only inside one unit subtree just the grants inside it, applied before paging', async () => {
      const inside = await giveRole(OWNER_2, 'UNIT_HELPER', 'UNIT_SUBTREE', [unitId(2)]);
      const outside = await giveRole(OWNER_2, 'UNIT_HELPER', 'UNIT_ONLY', [unitId(3)]);
      const tenantWide = await giveRole(OWNER_2, 'HELD_ROLE', 'TENANT');

      const collect = async (member: number, pageSize: number): Promise<string[]> => {
        const ids: string[] = [];
        let cursor = '';
        for (let page = 0; page < 200; page += 1) {
          const reply = await call('GET', `/resources/role_grant?limit=${pageSize}${cursor}`, { member });
          expect(reply.status).toBe(200);
          ids.push(...(reply.json.items as Array<{ id: string }>).map((row) => row.id));
          if (reply.json.next_cursor === null) return ids;
          cursor = `&cursor=${reply.json.next_cursor as string}`;
        }
        throw new Error('the listing never ended');
      };

      for (const pageSize of [200, 1]) {
        const scoped = await collect(UNIT_ADMIN, pageSize);
        expect(scoped).toContain(inside);
        expect(scoped).not.toContain(outside);
        expect(scoped).not.toContain(tenantWide);
        const everything = await collect(ADMIN, pageSize);
        expect(everything).toEqual(expect.arrayContaining([inside, outside, tenantWide]));
      }
      expect((await call('GET', `/resources/role_grant/${inside}`, { member: UNIT_ADMIN })).status).toBe(200);
      for (const hidden of [outside, tenantWide]) {
        const reply = await call('GET', `/resources/role_grant/${hidden}`, { member: UNIT_ADMIN });
        expect(reply.status).toBe(404);
        expect(reply.json.code).toBe('RESOURCE_NOT_FOUND');
      }
    });

    it('shows a caller who holds iam.role.grant on exactly one unit the grants on that unit, not those of a sibling or a child unit', async () => {
      const onUnit = await giveRole(RECIPIENT_G, 'UNIT_HELPER', 'UNIT_ONLY', [unitId(2)]);
      const sibling = await giveRole(RECIPIENT_G, 'UNIT_HELPER', 'UNIT_ONLY', [unitId(3)]);
      const child = await giveRole(RECIPIENT_G, 'UNIT_HELPER', 'UNIT_ONLY', [unitId(4)]);
      const listed = await call('GET', '/resources/role_grant?limit=200', { member: UNIT_ONLY_ADMIN });
      expect(listed.status).toBe(200);
      const ids = (listed.json.items as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(onUnit);
      expect(ids).not.toContain(sibling);
      expect(ids).not.toContain(child);
      expect((await call('GET', `/resources/role_grant/${onUnit}`, { member: UNIT_ONLY_ADMIN })).status).toBe(200);
      for (const hidden of [sibling, child]) {
        const reply = await call('GET', `/resources/role_grant/${hidden}`, { member: UNIT_ONLY_ADMIN });
        expect(reply.status).toBe(404);
      }
    });

    it('rejects a malformed cursor and limit', async () => {
      const bad = await call('GET', '/resources/role_grant?limit=0', { member: ADMIN });
      expect(bad.status).toBe(422);
      const cursor = await call('GET', '/resources/role_grant?cursor=%%%', { member: ADMIN });
      expect(cursor.status).toBe(422);
    });
  });
});
