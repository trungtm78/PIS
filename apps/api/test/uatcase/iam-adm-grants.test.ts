import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { seedSystemRoles } from '@machvon/db/src/system-roles';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { RoleGrantReadsController, RoleGrantsController } from '../../src/role-grants.controller';
import { RolesController } from '../../src/roles.controller';
import { AuthzHarness, TENANT_A, contextFor, grantId, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

/**
 * UAT cases of the role grant rules of FX-PLAT (IAM.md BR-IAM-05, BR-IAM-06): the anti-escalation rules of the people who grant. The tenant "minh-ha" has the units
 * A-ROOT, A-STC, A-BQLGT and A-BQLGT/PKT, and the people u.admin (TENANT_ADMIN 90), u.unitadmin (UNIT_ADMIN 70 on the subtree of A-BQLGT), u.spec and u.maker.
 */
const SIGNING_KEY = randomBytes(32);
const ACTOR = '00000000-0000-4000-8000-0000000000f0';

const ADMIN = 1;
const UNIT_ADMIN = 2;
const SPEC = 3;
const MAKER = 4;

const A_ROOT = 1;
const A_BQLGT = 2;
const A_STC = 3;
const A_BQLGT_PKT = 4;

describe('role grant rules of the platform fixture (BR-IAM-05, BR-IAM-06)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 100;
  const roles = new Map<string, string>();

  async function call(method: string, path: string, options: { member: number; body?: unknown; key: string; aal2?: boolean }): Promise<Reply> {
    const token = signTenantContext(contextFor(TENANT_A, memberId(options.member)), SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json', 'idempotency-key': options.key };
    if (options.aal2 === true) headers[CLAIMS_HEADER] = JSON.stringify({ aal: 'aal2', aal2At: new Date().toISOString() });
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const admin = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const countOf = async (sql: string, params: unknown[] = []): Promise<number> => Number((await admin<{ n: string }>(sql, params))[0]?.n);
  const grantsOf = (member: number): Promise<number> => countOf('select count(*) as n from machvon.role_grant where tenant_id = $1 and membership_id = $2', [TENANT_A, memberId(member)]);
  const deniedAudits = (): Promise<number> => countOf("select count(*) as n from machvon.audit_event where action = 'command.denied:grantRole' and outcome = 'DENIED'");
  const accessEvents = (member: number): Promise<number> =>
    countOf("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1' and aggregate_id = $1", [memberId(member)]);

  async function giveRole(member: number, code: string, kind: string, refs: readonly string[] = []): Promise<void> {
    counter += 1;
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', $6, $7::uuid[], 'Active', $8, 'seed')`,
        [TENANT_A, grantId(counter), memberId(member), roles.get(code), JSON.stringify({ kind, ref_ids: refs }), kind, refs, ACTOR],
      ],
    ]);
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: A_ROOT, path: '/u1/' },
      { n: A_BQLGT, path: '/u1/u2/', parent: A_ROOT },
      { n: A_STC, path: '/u1/u3/', parent: A_ROOT },
      { n: A_BQLGT_PKT, path: '/u1/u2/u4/', parent: A_BQLGT },
    ]);
    await harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => seedSystemRoles(tx, ACTOR));
    for (const member of [ADMIN, UNIT_ADMIN, SPEC, MAKER]) await harness.seedMembership(TENANT_A, member, A_ROOT);
    for (const row of await admin<{ id: string; code: string }>('select id, code from machvon.role_definition where tenant_id = $1', [TENANT_A])) roles.set(row.code, row.id);
    await giveRole(ADMIN, 'TENANT_ADMIN', 'TENANT');
    await giveRole(UNIT_ADMIN, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(A_BQLGT)]);
    const database = new TenantDatabase(harness.appPool);
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database }), PolicyModule.register({ database, access: new EffectiveAccessStore(database, new InMemoryAuthzCache()) })],
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

  const grant = (member: number, role: string, kind: string, refs: readonly string[] = []): Record<string, unknown> => ({
    membership_id: memberId(member),
    role_id: roles.get(role),
    scope_kind: kind,
    ...(refs.length > 0 ? { scope_ref_ids: refs } : {}),
    reason: 'Bổ sung quản trị viên',
  });

  it('UAT-AC103: a TENANT_ADMIN of rank 90 is refused TENANT_ADMIN with nothing written and a DENIED audit row, and is let grant UNIT_ADMIN (rank 70) on A-BQLGT, recorded as granted by them', async () => {
    const grantsBefore = await grantsOf(SPEC);
    const deniedBefore = await deniedAudits();
    const refused = await call('POST', '/role-grants', { member: ADMIN, aal2: true, key: 'uat-ac103-step-1-key', body: grant(SPEC, 'TENANT_ADMIN', 'TENANT') });
    assertStatus(refused, 403, 'ROLE_ESCALATION_DENIED');
    expect(await grantsOf(SPEC)).toBe(grantsBefore);
    expect(await deniedAudits()).toBe(deniedBefore + 1);

    const eventsBefore = await accessEvents(SPEC);
    const granted = await call('POST', '/role-grants', { member: ADMIN, aal2: true, key: 'uat-ac103-step-2-key', body: grant(SPEC, 'UNIT_ADMIN', 'UNIT_SUBTREE', [unitId(A_BQLGT)]) });
    assertStatus(granted, 201);
    const rows = await admin<{ status: string; granted_by: string; scope_kind: string; scope_ref_ids: string[] }>(
      'select status, granted_by, scope_kind, scope_ref_ids from machvon.role_grant where id = $1',
      [granted.json.resource_id],
    );
    expect(rows).toEqual([{ status: 'Active', granted_by: memberId(ADMIN), scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [unitId(A_BQLGT)] }]);
    expect(await accessEvents(SPEC)).toBe(eventsBefore + 1);
  });

  it('UAT-AC104: a UNIT_ADMIN who grants a role to their own membership is refused SELF_GRANT_DENIED, no grant is written and the refusal is audited as DENIED', async () => {
    const grantsBefore = await grantsOf(UNIT_ADMIN);
    const deniedBefore = await deniedAudits();
    const refused = await call('POST', '/role-grants', { member: UNIT_ADMIN, aal2: true, key: 'uat-ac104-step-1-key', body: grant(UNIT_ADMIN, 'LEADER', 'UNIT_SUBTREE', [unitId(A_BQLGT)]) });
    assertStatus(refused, 403, 'SELF_GRANT_DENIED');
    expect(await grantsOf(UNIT_ADMIN)).toBe(grantsBefore);
    expect(await deniedAudits()).toBe(deniedBefore + 1);
    const audit = await admin<{ actor_id: string; resource_type: string; outcome: string }>(
      "select actor_id, resource_type, outcome from machvon.audit_event where action = 'command.denied:grantRole' order by occurred_at desc limit 1",
    );
    // The product names the refusal of a command after the operation: `command.denied:<operationId>`, on the resource type `command`.
    expect(audit).toEqual([{ actor_id: memberId(UNIT_ADMIN), resource_type: 'command', outcome: 'DENIED' }]);
  });

  it('UAT-AC106: a custom role with a system permission is 422 SYSTEM_PERMISSION_NOT_GRANTABLE and the database refuses it too, one with a permission the creator lacks is 403 ROLE_ESCALATION_DENIED, one of rank 95 is 400 INVALID_REQUEST, and none is stored', async () => {
    const roleCount = (): Promise<number> => countOf('select count(*) as n from machvon.role_definition where tenant_id = $1 and is_system = false', [TENANT_A]);
    const before = await roleCount();
    const theme = await call('POST', '/roles', { member: ADMIN, key: 'uat-ac106-step-1-key', body: { code: 'THEME_EDITOR', name: 'Theme editor', permissions: ['system.theme.manage'], rank: 50 } });
    assertStatus(theme, 422, 'SYSTEM_PERMISSION_NOT_GRANTABLE');
    const publisher = await call('POST', '/roles', { member: ADMIN, key: 'uat-ac106-step-2-key', body: { code: 'AI_PUB', name: 'Publisher', permissions: ['contract.read'], rank: 50 } });
    assertStatus(publisher, 403, 'ROLE_ESCALATION_DENIED');
    const rank = await call('POST', '/roles', { member: ADMIN, key: 'uat-ac106-step-3-key', body: { code: 'VIEWER_X', name: 'Viewer', permissions: ['report.read'], rank: 95 } });
    assertStatus(rank, 400, 'INVALID_REQUEST');
    expect(await roleCount()).toBe(before);

    // The same system permission written straight to the table, past the service, is stopped by the CHECK of the table.
    await expect(
      admin(
        `insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by)
         values ($1, $2, 'THEME_EDITOR', 'Theme editor', '{system.theme.manage}', 50, 'Active', $3)`,
        [TENANT_A, randomUUID(), ACTOR],
      ),
    ).rejects.toThrow(/role_definition_no_system_permission_ck/);
    expect(await roleCount()).toBe(before);
  });

  it('SEC05: a custom role of the tenant cannot be given a system permission, new or by editing it: the API refuses with 422, the role stays as it was, nothing is announced and no role of any tenant holds one', async () => {
    const made = await call('POST', '/roles', { member: ADMIN, key: 'sec05-make-role-key-01', body: { code: 'DIEU_PHOI', name: 'Điều phối', permissions: ['iam.unit.manage'], rank: 30 } });
    assertStatus(made, 201);
    const roleId = made.json.resource_id as string;
    const roleCount = (): Promise<number> => countOf('select count(*) as n from machvon.role_definition where is_system = false');
    const before = await roleCount();
    const eventsBefore = await countOf("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1'");

    // The permissions of the platform that the tenant plane must never hand out (the catalogue names the theme and the licence ones system.theme.manage and system.license.manage).
    for (const permission of ['system.theme.manage', 'system.license.manage']) {
      assertStatus(await call('POST', '/roles', { member: ADMIN, key: `sec05-new-${permission}-key`, body: { code: 'SYS_NEW', name: 'System', permissions: [permission], rank: 30 } }), 422, 'SYSTEM_PERMISSION_NOT_GRANTABLE');
      const edited = await fetch(`${app.baseUrl}/roles/${roleId}`, {
        method: 'PUT',
        headers: {
          [TENANT_HEADER]: signTenantContext(contextFor(TENANT_A, memberId(ADMIN)), SIGNING_KEY),
          'content-type': 'application/json',
          'idempotency-key': `sec05-edit-${permission}-key`,
          'if-match': '"1"',
        },
        body: JSON.stringify({ permissions: ['iam.unit.manage', permission], reason: 'Bổ sung quyền cho vai trò điều phối' }),
      });
      expect([edited.status, ((await edited.json()) as Record<string, unknown>).code]).toEqual([422, 'SYSTEM_PERMISSION_NOT_GRANTABLE']);
    }
    // A name the catalogue does not have is refused as well, so no spelling gets past the check.
    for (const permission of ['system.theme.write', 'system.license.issue']) {
      assertStatus(await call('POST', '/roles', { member: ADMIN, key: `sec05-unknown-${permission}-key`, body: { code: 'SYS_UNKNOWN', name: 'System', permissions: [permission], rank: 30 } }), 422, 'VALIDATION_FAILED');
    }

    expect(await roleCount()).toBe(before);
    expect(await admin('select permissions, version::text as version from machvon.role_definition where id = $1', [roleId])).toEqual([{ permissions: ['iam.unit.manage'], version: '1' }]);
    expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'iam.access.changed.v1'")).toBe(eventsBefore);
    expect(await countOf("select count(*) as n from machvon.audit_event where action in ('role.update', 'role.create') and resource_id <> $1 and outcome = 'SUCCESS' and safe_diff::text like '%system.%'", [roleId])).toBe(0);
    expect(await countOf("select count(*) as n from machvon.role_definition where is_system = false and exists (select 1 from unnest(permissions) p where p like 'system.%')")).toBe(0);
  });

  it('the checks of this suite can go red: a check fed the wrong answer throws', () => {
    expectCheckFails(() => assertStatus({ status: 201, json: {} }, 403, 'ROLE_ESCALATION_DENIED'));
    expectCheckFails(() => assertStatus({ status: 403, json: { code: 'SCOPE_DENIED' } }, 403, 'SELF_GRANT_DENIED'));
  });
});
