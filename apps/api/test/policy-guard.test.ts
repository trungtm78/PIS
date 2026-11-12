import { randomBytes, randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import type { TestDatabase } from '@machvon/db/src/test-database';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { CommandModule } from '../src/command.module';
import { Command, Scope } from '../src/command.decorator';
import type { CommandScope } from '../src/command-scope';
import { OperationId } from '../src/operation-id.decorator';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { Public } from '../src/public.decorator';
import { InMemorySessionDenyList } from '../src/session-deny-list';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startIsolationDatabase, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const family = (prefix: number, n: number): string => `00000000-0000-4000-${prefix.toString(16).padStart(4, '0')}-${n.toString(16).padStart(12, '0')}`;
const unitId = (n: number): string => family(0x10, n);
const memberId = (n: number): string => family(0x20, n);
const roleId = (n: number): string => family(0x30, n);
const grantId = (n: number): string => family(0x40, n);

const FULL = 1; // holds test.* on the whole tenant
const READ_ONLY = 2; // holds test.read only
const NONE = 3; // no grant at all
const OTHER_TENANT_MEMBER = 4; // a member of tenant B only

const EXTRA_OPERATIONS = {
  test_guarded_command: { permission: 'test.guarded.do', plane: 'tenant' },
  test_stepup_command: { permission: 'test.stepup.do', plane: 'tenant', stepUp: 'aal2' },
  test_control_command: { permission: 'system.tenant.read', plane: 'control' },
  test_read: { permission: 'test.read', plane: 'tenant' },
} as const;

@Controller('policy')
class PolicySampleController {
  @Post('guarded')
  @HttpCode(200)
  @OperationId('test_guarded_command')
  @Command({ operation: 'guardedCommand' })
  async guarded(@Scope() scope: CommandScope): Promise<{ ok: true }> {
    await scope.audit({ action: 'policy.guarded', resourceType: 'sample', resourceId: randomUUID(), diff: {} });
    return { ok: true };
  }

  @Post('stepup')
  @HttpCode(200)
  @OperationId('test_stepup_command')
  @Command({ operation: 'stepUpCommand' })
  async stepUp(@Scope() scope: CommandScope): Promise<{ ok: true }> {
    await scope.audit({ action: 'policy.stepup', resourceType: 'sample', resourceId: randomUUID(), diff: {} });
    return { ok: true };
  }

  @Post('control')
  @HttpCode(200)
  @OperationId('test_control_command')
  @Command({ operation: 'controlCommand' })
  async control(@Scope() scope: CommandScope): Promise<{ ok: true }> {
    await scope.audit({ action: 'policy.control', resourceType: 'sample', resourceId: randomUUID(), diff: {} });
    return { ok: true };
  }

  @Get('read')
  @OperationId('test_read')
  read(): { ok: true } {
    return { ok: true };
  }

  @Get('open')
  @Public()
  open(): { open: true } {
    return { open: true };
  }

  @Post('echo')
  @HttpCode(200)
  @Public()
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller('unmapped')
class UnmappedController {
  @Get()
  @OperationId('test_operation_without_policy')
  list(): never[] {
    return [];
  }
}

@Controller('bare')
class BareController {
  @Get()
  list(): never[] {
    return [];
  }
}

// Handlers defined on a base class are routes of every controller that extends it.
class BaseHandlers {
  @Get('inherited')
  inherited(): never[] {
    return [];
  }
}

@Controller('inheriting')
class InheritingController extends BaseHandlers {}

@Controller('overriding')
class OverridingController extends BaseHandlers {
  // The override carries no route metadata, so Nest does not route it and the guard has nothing to protect.
  override inherited(): never[] {
    return [];
  }
}

class RecordingMetrics implements MetricsSink {
  readonly counts = new Map<string, number>();

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = `${name}|${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',')}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  gauge(): void {
    return undefined;
  }
}

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface Caller {
  tenantId?: string;
  member: number;
  scopeVersion?: number;
  claims?: Record<string, unknown>;
}

describe('policy guard (ST-IAM-004)', () => {
  const metrics = new RecordingMetrics();
  const denyList = new InMemorySessionDenyList();
  let entitled = true;
  let database: TestDatabase;
  let admin: Pool;
  let appPool: Pool;
  let app: RunningApp;
  let store: EffectiveAccessStore;
  const extraApps: RunningApp[] = [];

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

  const seedTenant = async (tenantId: string, members: readonly number[]): Promise<void> => {
    const statements: Array<[string, unknown[]?]> = [
      [
        "insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, path, depth) values ($1, $2, 'ROOT', 'Root', date '2026-01-01', $3, 0)",
        [tenantId, unitId(1), `/${unitId(1)}/`],
      ],
    ];
    for (const n of members) {
      statements.push(
        ["insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, $4, 'Active') on conflict do nothing", [family(0x60, n), `sub-${n}`, `u${n}@example.test`, `User ${n}`]],
        ["insert into machvon.membership (tenant_id, id, user_id, organization_id, status) values ($1, $2, $3, $4, 'Active')", [tenantId, memberId(n), family(0x60, n), unitId(1)]],
      );
    }
    await owner(tenantId, statements);
  };

  const seedRoleAndGrant = (tenantId: string, member: number, role: number, code: string, permissions: string[], grant: number): Promise<void> =>
    owner(tenantId, [
      ["insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, $3, $3, $4, 40, 'Active', $5)", [tenantId, roleId(role), code, permissions, ACTOR]],
      [
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
        [tenantId, grantId(grant), memberId(member), roleId(role), ACTOR],
      ],
    ]);

  async function call(method: 'GET' | 'POST', path: string, caller: Caller): Promise<Reply> {
    const token = signTenantContext(
      { tenantId: caller.tenantId ?? TENANT_A, membershipId: memberId(caller.member), scopeVersion: caller.scopeVersion ?? 1 },
      SIGNING_KEY,
    );
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (caller.claims !== undefined) headers[CLAIMS_HEADER] = JSON.stringify(caller.claims);
    if (method === 'POST') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'POST' ? '{}' : undefined });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n);
  }

  const deniedRows = (operationId: string): Promise<number> =>
    count("select count(*) as n from machvon.audit_event where action = $1 and outcome = 'DENIED'", [`authz.denied:${operationId}`]);

  function policyModule() {
    return PolicyModule.register({
      database: new TenantDatabase(appPool),
      access: store,
      denyList,
      metrics,
      entitled: () => entitled,
      extraOperations: EXTRA_OPERATIONS,
    });
  }

  beforeAll(async () => {
    database = await startIsolationDatabase();
    admin = new Pool({ connectionString: database.adminUrl, max: 2 });
    appPool = new Pool({ connectionString: database.urlFor('machvon_app'), max: 8 });
    await seedTenant(TENANT_A, [FULL, READ_ONLY, NONE]);
    await seedTenant(TENANT_B, [OTHER_TENANT_MEMBER]);
    await seedRoleAndGrant(TENANT_A, FULL, 1, 'SAMPLE_FULL', ['test.*'], 1);
    await seedRoleAndGrant(TENANT_A, READ_ONLY, 2, 'SAMPLE_READ', ['test.read'], 2);
    store = new EffectiveAccessStore(new TenantDatabase(appPool), new InMemoryAuthzCache(), { metrics });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: new TenantDatabase(appPool) }), policyModule()],
      controllers: [PolicySampleController],
      providers: [{ provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await Promise.all(extraApps.map((extra) => extra.close()));
    if (app) await app.close();
    await Promise.all([appPool?.end(), admin?.end()]);
    if (database) await database.stop();
  }, 60_000);

  it('answers 403 SCOPE_DENIED with a DENIED audit row for a command the caller lacks, and 200 with a SUCCESS row for one they hold (AC-ST-IAM-004-1)', async () => {
    const before = await deniedRows('test_guarded_command');
    for (const member of [READ_ONLY, NONE]) {
      const denied = await call('POST', '/policy/guarded', { member });
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('SCOPE_DENIED');
    }
    expect(await deniedRows('test_guarded_command')).toBe(before + 2);
    const allowed = await call('POST', '/policy/guarded', { member: FULL });
    expect(allowed.status).toBe(200);
    expect(await count("select count(*) as n from machvon.audit_event where action = 'policy.guarded' and outcome = 'SUCCESS'")).toBe(1);
  });

  it('shares the correlation id of a denied command with its audit row', async () => {
    const denied = await call('POST', '/policy/guarded', { member: NONE });
    const { rows } = await admin.query<{ correlation_id: string }>(
      "select correlation_id from machvon.audit_event where action = 'authz.denied:test_guarded_command' order by seq desc limit 1",
    );
    expect(rows[0]?.correlation_id).toBe(denied.json.correlation_id);
  });

  it('denies a read without writing an audit row, and keeps the tenant boundary for a member of another tenant', async () => {
    const before = await count("select count(*) as n from machvon.audit_event where action like 'authz.denied:test_read'");
    expect((await call('GET', '/policy/read', { member: NONE })).status).toBe(403);
    expect((await call('GET', '/policy/read', { member: READ_ONLY })).status).toBe(200);
    expect(await count("select count(*) as n from machvon.audit_event where action like 'authz.denied:test_read'")).toBe(before);
    // Tenant B's member holds nothing in tenant A, and tenant A's FULL member holds nothing in tenant B.
    expect((await call('GET', '/policy/read', { member: OTHER_TENANT_MEMBER, tenantId: TENANT_A })).status).toBe(403);
    expect((await call('GET', '/policy/read', { member: FULL, tenantId: TENANT_B })).status).toBe(403);
  });

  it('audits a read that an operator of the control plane makes on the tenant plane, because the plane is wrong whatever it asks (AC-ST-IAM-007-2)', async () => {
    const before = await count("select count(*) as n from machvon.audit_event where action = 'authz.denied:test_read' and outcome = 'DENIED'");
    const denied = await call('GET', '/policy/read', { member: FULL, claims: { aud: 'control', roles: ['SupportOperator'] } });
    expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
    expect(await count("select count(*) as n from machvon.audit_event where action = 'authz.denied:test_read' and outcome = 'DENIED'")).toBe(before + 1);
  });

  it('requires aal2 within 15 minutes for a step-up command (AC-ST-IAM-004-2)', async () => {
    const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
    const aal1 = await call('POST', '/policy/stepup', { member: FULL });
    expect(aal1.status).toBe(403);
    expect(aal1.json.code).toBe('MFA_REQUIRED');
    expect((await call('POST', '/policy/stepup', { member: FULL, claims: { aal: 'aal2', aal2At: minutesAgo(14) } })).status).toBe(200);
    const stale = await call('POST', '/policy/stepup', { member: FULL, claims: { aal: 'aal2', aal2At: minutesAgo(16) } });
    expect(stale.status).toBe(403);
    expect(stale.json.code).toBe('MFA_REQUIRED');
  });

  it('lets the database scope_version win over a token that is still valid (AC-ST-IAM-004-3)', async () => {
    const member = 5;
    await seedTenantMember(member);
    await seedRoleAndGrant(TENANT_A, member, 5, 'SAMPLE_REVOKED', ['test.read'], 5);
    metrics.counts.clear();
    expect((await call('GET', '/policy/read', { member })).status).toBe(200);
    expect((await call('GET', '/policy/read', { member })).status).toBe(200);
    expect(metrics.counts.get('authz_cache_hit_total|')).toBe(1);

    await owner(TENANT_A, [
      ["update machvon.role_grant set status = 'Revoked', revoked_at = now(), revoked_by = $2, revoke_reason = 'test revoke' where id = $1", [grantId(5), ACTOR]],
      ['update machvon.membership set scope_version = scope_version + 1 where id = $1', [memberId(member)]],
    ]);
    const stale = await call('GET', '/policy/read', { member, scopeVersion: 1 });
    expect(stale.status).toBe(403);
    expect(stale.json.code).toBe('SCOPE_DENIED');
    expect(metrics.counts.get('authz_decision_total|outcome=deny,reason=STALE_SCOPE_VERSION')).toBe(1);
  });

  async function seedTenantMember(n: number): Promise<void> {
    await owner(TENANT_A, [
      ["insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, $4, 'Active') on conflict do nothing", [family(0x60, n), `sub-${n}`, `u${n}@example.test`, `User ${n}`]],
      ["insert into machvon.membership (tenant_id, id, user_id, organization_id, status) values ($1, $2, $3, $4, 'Active')", [TENANT_A, memberId(n), family(0x60, n), unitId(1)]],
    ]);
  }

  it('refuses a tenant-plane token on a control-plane operation (AC-ST-IAM-004-4) and accepts a control-plane token', async () => {
    const denied = await call('POST', '/policy/control', { member: FULL });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('SCOPE_DENIED');
    expect(await deniedRows('test_control_command')).toBe(1);
    // A control operation is judged on the realm roles of the token; tenant grants never stand in for them.
    expect((await call('POST', '/policy/control', { member: FULL, claims: { aud: 'control', roles: ['SystemAdmin'] } })).status).toBe(200);
    const withoutRoles = await call('POST', '/policy/control', { member: FULL, claims: { aud: 'control' } });
    expect(withoutRoles.status).toBe(403);
    expect(withoutRoles.json.code).toBe('SCOPE_DENIED');
  });

  it('answers 401 SESSION_EXPIRED for a revoked session and for a malformed principal', async () => {
    denyList.revoke('revoked-session');
    const revoked = await call('GET', '/policy/read', { member: FULL, claims: { sid: 'revoked-session' } });
    expect(revoked.status).toBe(401);
    expect(revoked.json.code).toBe('SESSION_EXPIRED');
    for (const claims of [{ aud: 'moon' }, { aal: 'aal3' }, { aal2At: 'not a date' }, { sid: '' }, { sid: 'x'.repeat(129) }]) {
      const reply = await call('GET', '/policy/read', { member: FULL, claims });
      expect(reply.status).toBe(401);
    }
  });

  it('answers 403 ENTITLEMENT_DENIED when the tenant is not entitled to the permission', async () => {
    entitled = false;
    try {
      const reply = await call('GET', '/policy/read', { member: FULL });
      expect(reply.status).toBe(403);
      expect(reply.json.code).toBe('ENTITLEMENT_DENIED');
    } finally {
      entitled = true;
    }
  });

  it('lets @Public routes through without any grant, and counts every decision', async () => {
    metrics.counts.clear();
    expect((await call('GET', '/policy/open', { member: NONE })).status).toBe(200);
    expect(metrics.counts.size).toBe(0);
    await call('GET', '/policy/read', { member: FULL });
    await call('GET', '/policy/read', { member: NONE });
    expect(metrics.counts.get('authz_decision_total|outcome=allow,reason=ALLOWED')).toBe(1);
    expect(metrics.counts.get('authz_decision_total|outcome=deny,reason=NO_PERMISSION')).toBe(1);
  });

  it('refuses to start when a route has an operationId without a policy or no operationId at all', async () => {
    const start = (controller: new () => object) =>
      startTestApp({ signingKey: SIGNING_KEY, imports: [policyModule()], controllers: [controller as never] }).then((extra) => {
        extraApps.push(extra);
      });
    await expect(start(UnmappedController)).rejects.toThrow(/operationId test_operation_without_policy has no policy/);
    await expect(start(BareController)).rejects.toThrow(/neither @OperationId nor @Public/);
  }, 60_000);

  it('refuses to start when an inherited route handler has no policy, but not when a subclass overrides it', async () => {
    const start = (controller: new () => object) =>
      startTestApp({ signingKey: SIGNING_KEY, imports: [policyModule()], controllers: [controller as never] }).then((extra) => {
        extraApps.push(extra);
      });
    await expect(start(InheritingController)).rejects.toThrow(/InheritingController.inherited has neither @OperationId nor @Public/);
    await expect(start(OverridingController)).resolves.toBeUndefined();
  }, 60_000);

  it('never lets an extra operation replace a design operation', () => {
    expect(() =>
      PolicyModule.register({
        database: new TenantDatabase(appPool),
        access: store,
        extraOperations: { grantRole: { permission: 'anything', plane: 'tenant' } },
      }),
    ).toThrow(/grantRole is already defined/);
  });

});
