import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { Controller, HttpCode, Post } from '@nestjs/common';
import { Client } from 'pg';
import { AuditWriter, EffectiveAccessStore, EntitlementStore, InMemoryAuthzCache, InMemoryEntitlementCache, LicenseStatusJob, LicenseStore, PLATFORM_TENANT_ID } from '@machvon/db';
import { seedSystemRoles } from '@machvon/db/src/system-roles';
import { STANDARD_FEATURES, loadErrorRegistry, signTenantContext, verifyLicenseToken } from '@machvon/kernel';
import type { FeatureEntry, LicenseSigner } from '@machvon/kernel';
import { AppModule } from '../../src/app.module';
import { StoreEntitlementGate } from '../../src/entitlements/entitlement-gate';
import { OperationId } from '../../src/operation-id.decorator';
import { Ed25519LicenseSigner } from '../../src/modules/sas/license-signer';
import type { LicenseKeyStore } from '../../src/modules/sas/license-signer';
import { DatabaseTenantRuntime } from '../../src/session/tenant-runtime';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { PLAN_PUBLISHED, ProvisioningHarness } from '../provisioning/provisioning-fixtures';
import { asObjects } from '../support/json';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';

/**
 * The licence and entitlement cases of the UAT run that had no script (UAT-AC40, UAT-AC41, UAT-AC42, UAT-LIC01, UAT-AC43, UAT-AC161, UAT-AC162; UAT-AC148, UAT-AC159 and UAT-AC174 are findings: their tests below carry no case id). One world: the whole application over a real database with the entitlement gate
 * of the plan and the licence in the policy guard, the control plane and the tenant plane, and a clock of the server that the cases move (the clock the policy guard and the entitlement store read; the client's `Date` header is sent wrong on purpose).
 * The two handlers that have no controller yet (`post_reports_id_submit`, `post_analysis_runs`) are stubs bound to the operation ids of the contract: only the decision of the gate is under test there.
 */
const SIGNING_KEY = randomBytes(32);
const CONTROL_MEMBER = '00000000-0000-4000-8000-0000000000c9';
const KEY_ID = 'kid-uatcase';
const REASON = 'The contract was terminated by the agency.';
const DAY_MS = 86_400_000;

/** The clock of the server: the real one until a case fixes it. */
const clock: { fixed: Date | undefined } = { fixed: undefined };
const nowOf = (): Date => clock.fixed ?? new Date();

@Controller()
class UnbuiltHandlers {
  @Post('reports/:id/submit')
  @HttpCode(200)
  @OperationId('post_reports_id_submit')
  submit(): { ok: true } {
    return { ok: true };
  }

  @Post('analysis-runs')
  @HttpCode(202)
  @OperationId('post_analysis_runs')
  analyse(): { accepted: true } {
    return { accepted: true };
  }
}

class TestKeys implements LicenseKeyStore {
  private readonly pair = generateKeyPairSync('ed25519');
  readonly signer: LicenseSigner = new Ed25519LicenseSigner(KEY_ID, this.pair.privateKey);
  readonly publicKeyDer = this.pair.publicKey.export({ format: 'der', type: 'spki' });
  readonly publicKeyPem = this.pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();

  current(): Promise<LicenseSigner> {
    return Promise.resolve(this.signer);
  }

  publicKeys(): Promise<ReadonlyMap<string, Uint8Array>> {
    return Promise.resolve(new Map([[KEY_ID, this.publicKeyDer]]));
  }
}

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Persona {
  tenantId: string;
  maker: string;
  spec: string;
  admin: string;
  owner: string;
}

/** The plan of the cases: reporting and export keep working in the grace period, the three features that cost something or reach other people do not. */
const FEATURES_ON: readonly FeatureEntry[] = STANDARD_FEATURES.map((entry) => ({ featureCode: entry.featureCode, limitKind: entry.limitKind, graceBehavior: entry.graceBehavior, expiredBehavior: entry.expiredBehavior }));

describe('licences and entitlements: the cases of the UAT run without a script', () => {
  const harness = new ProvisioningHarness();
  const entitlementCache = new InMemoryEntitlementCache();
  const authzCache = new InMemoryAuthzCache();
  const keys = new TestKeys();
  let entitlements: EntitlementStore;
  let store: LicenseStore;
  let app: RunningApp;
  let job: LicenseStatusJob;
  const logged: string[] = [];
  const restore: Array<() => void> = [];

  const iso = (instant: Date): string => instant.toISOString();

  async function send(context: { tenantId: string; membershipId: string }, claims: Record<string, unknown>, method: string, path: string, options: { payload?: unknown; ifMatch?: string; key?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      [TENANT_HEADER]: signTenantContext({ ...context, scopeVersion: 1 }, SIGNING_KEY),
      [CLAIMS_HEADER]: JSON.stringify(claims),
      'content-type': 'application/json',
      ...options.headers,
    };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      json = { unparsed: text };
    }
    return { status: response.status, json };
  }
  const control = (method: string, path: string, options: { roles?: string[]; payload?: unknown; ifMatch?: string; audience?: string } = {}): Promise<Reply> =>
    send({ tenantId: PLATFORM_TENANT_ID, membershipId: CONTROL_MEMBER }, { aud: options.audience ?? 'control', roles: options.roles ?? ['SystemAdmin'] }, method, path, options);
  /** A call of a person of the tenant, with the `Date` header of a client whose clock is three days ahead. */
  const asMember = (tenantId: string, membershipId: string, method: string, path: string, options: { payload?: unknown; ifMatch?: string } = {}): Promise<Reply> =>
    send({ tenantId, membershipId }, { aud: 'tenant' }, method, path, { ...options, headers: { date: new Date(Date.now() + 3 * DAY_MS).toUTCString() } });

  const ownerClient = async (tenantId: string): Promise<Client> => {
    const client = new Client({ connectionString: harness.database.urlFor('machvon_owner') });
    await client.connect();
    await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
    return client;
  };

  /** An Active tenant with the plan of the cases, the people of the fixture who matter here, and no licence yet. */
  async function tenant(features: readonly FeatureEntry[] = FEATURES_ON): Promise<Persona & { versionId: string }> {
    const created = await harness.request();
    const { tenantId } = created;
    await harness.registry.transition(tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(tenantId, 'Provisioning', 'Active');
    await harness.tenants.withTenant({ tenantId, membershipId: CONTROL_MEMBER, scopeVersion: 1 }, async (tx) => {
      await seedSystemRoles(tx, CONTROL_MEMBER);
      await entitlements.record(tx, { cause: 'PROVISIONING', planVersionId: PLAN_PUBLISHED, features });
    });
    const client = await ownerClient(tenantId);
    try {
      const unit = randomUUID();
      await client.query("insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, path, depth) values ($1, $2, 'U1', 'Unit 1', date '2026-01-01', '/u1/', 0)", [tenantId, unit]);
      const custom = async (code: string, permissions: readonly string[], rank = 50): Promise<string> => {
        const roleId = randomUUID();
        await client.query("insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, status, created_by) values ($1, $2, $3, $3, $4, $5, 'Active', $6)", [tenantId, roleId, code, permissions, rank, CONTROL_MEMBER]);
        return roleId;
      };
      const roles = {
        maker: await custom('UAT_MAKER', ['report.submit', 'report_revision.read', 'session.self']),
        spec: await custom('UAT_SPEC', ['ai.analyze', 'session.self']),
        admin: await custom('UAT_ADMIN', ['notification.campaign.manage', 'iam.member.invite', 'iam.role.manage', 'session.self'], 80),
        owner: ((await client.query<{ id: string }>("select id from machvon.role_definition where code = 'TENANT_OWNER'")).rows[0] as { id: string }).id,
      };
      const member = async (roleId: string): Promise<string> => {
        const membershipId = randomUUID();
        const userId = randomUUID();
        await client.query("insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, 'Member', 'Active')", [userId, `sub-${userId}`, `${userId}@example.test`]);
        await client.query("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Active', now())", [tenantId, membershipId, userId, unit]);
        await client.query(
          `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
           values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
          [tenantId, randomUUID(), membershipId, roleId, CONTROL_MEMBER],
        );
        return membershipId;
      };
      const people = { maker: await member(roles.maker), spec: await member(roles.spec), admin: await member(roles.admin), owner: await member(roles.owner) };
      const rows = await harness.admin((admin) => admin.query<{ id: string }>('select id from machvon.entitlement_version where tenant_id = $1 and version_no = 1', [tenantId]));
      return { tenantId, ...people, versionId: rows.rows[0]?.id ?? '' };
    } finally {
      await client.end();
    }
  }

  const issueBody = (world: { tenantId: string; versionId: string }, window: { from: Date; until: Date; grace: Date }, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    tenant_id: world.tenantId,
    edition: 'STANDARD',
    valid_from: iso(window.from),
    valid_until: iso(window.until),
    grace_until: iso(window.grace),
    entitlement_version_id: world.versionId,
    seats: 100,
    quota: { storage_gb: 100 },
    ...overrides,
  });
  const windowFrom = (from: Date): { from: Date; until: Date; grace: Date } => ({ from, until: new Date(from.getTime() + 365 * DAY_MS), grace: new Date(from.getTime() + 395 * DAY_MS) });
  async function issued(world: { tenantId: string; versionId: string }, window = windowFrom(new Date(Date.now() - DAY_MS)), overrides: Record<string, unknown> = {}): Promise<string> {
    const reply = await control('POST', '/licenses', { payload: issueBody(world, window, overrides) });
    assertStatus(reply, 201);
    return reply.json.resource_id as string;
  }

  const count = (sql: string, params: unknown[]): Promise<number> => harness.count(sql, params);
  const eventsOf = (tenantId: string, type: string): Promise<number> => count('select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = $2', [tenantId, type]);
  const licenseRow = async (id: string): Promise<{ status: string; version: string; signed_claims: string; seats: number } | undefined> =>
    (await harness.admin((client) => client.query('select status, version::text as version, signed_claims, seats from machvon.license_revision where id = $1', [id]))).rows[0];
  const at = (instant: Date): void => {
    clock.fixed = instant;
  };
  const submit = (world: Persona, id: string): Promise<Reply> => asMember(world.tenantId, world.maker, 'POST', `/reports/${id}/submit`);
  const modeOf = async (world: Persona, feature: string): Promise<{ license: string; mode: string }> => {
    const view = await asMember(world.tenantId, world.maker, 'GET', '/me/entitlements');
    assertStatus(view, 200);
    return { license: view.json.license_status as string, mode: asObjects(view.json.features).find((entry) => entry.feature_code === feature)?.mode as string };
  };

  beforeAll(async () => {
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      restore.push(() => {
        stream.write = original;
      });
    }
    await harness.start();
    entitlements = new EntitlementStore(harness.tenants, entitlementCache, { now: nowOf });
    store = new LicenseStore(entitlements);
    job = new LicenseStatusJob(new AuditWriter(harness.tenants));
    expect(
      await harness.control.withControl((tx) =>
        store.registerSigningKey(tx, { keyId: KEY_ID, publicKeyPem: keys.publicKeyPem, kmsKeyRef: 'test', notBefore: new Date(Date.now() - 30 * DAY_MS), notAfter: new Date(Date.now() + 730 * DAY_MS) }),
      ),
    ).toBe(true);
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, authzCache), entitlements: new StoreEntitlementGate(entitlements), now: nowOf },
          control: { database: harness.control, registry: harness.registry },
          licenses: { store, keys },
          entitlements: { store: entitlements, control: harness.control },
          tenantState: { runtime: new DatabaseTenantRuntime(harness.tenants), entitlementCache, authzCache },
        }),
      ],
      controllers: [UnbuiltHandlers],
    });
  }, 300_000);

  afterAll(async () => {
    for (const undo of restore) undo();
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  afterEach(() => {
    clock.fixed = undefined;
  });

  it('goes red on a wrong answer (negative control)', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403, 'ENTITLEMENT_DENIED'));
    expectCheckFails(() => assertStatus({ status: 403, json: { code: 'SCOPE_DENIED' } }, 403, 'ENTITLEMENT_DENIED'));
  });

  it('UAT-AC40: the licence is Issued, Active, Active, Grace, Grace, Expired at the six instants of its window by the clock of the server, whatever the client says, with one status event and one entitlement change for each move', async () => {
    const world = await tenant();
    const window = windowFrom(new Date(Date.now() + 10 * DAY_MS));
    const id = await issued(world, window);
    const ms = (instant: Date, delta: number): Date => new Date(instant.getTime() + delta);
    const steps: Array<[Date, string, string, number]> = [
      [ms(window.from, -1), 'Issued', 'EXPIRED', 0],
      [window.from, 'Active', 'FULL', 1],
      [ms(window.until, -1), 'Active', 'FULL', 1],
      [window.until, 'Grace', 'GRACE', 2],
      [ms(window.grace, -1), 'Grace', 'GRACE', 2],
      [window.grace, 'Expired', 'EXPIRED', 3],
    ];
    const moved = (): Promise<number> => eventsOf(world.tenantId, 'sas.license.status_changed.v1');
    const changed = (): Promise<number> => eventsOf(world.tenantId, 'sas.entitlement.changed.v1');
    for (const [instant, status, mode, transitions] of steps) {
      at(instant);
      await entitlementCache.invalidate(world.tenantId);
      const [movedBefore, changedBefore] = [await moved(), await changed()];
      await harness.control.withTenantOf(world.tenantId, (tx) => job.run(tx, CONTROL_MEMBER, instant));
      expect((await licenseRow(id))?.status).toBe(status);
      expect(await moved()).toBe(transitions);
      // One status event and one entitlement change for a pass that moved the licence, none for a pass that found nothing to move.
      const moves = (await moved()) - movedBefore;
      expect([moves, (await changed()) - changedBefore]).toEqual([moves, moves]);
      await entitlementCache.invalidate(world.tenantId);
      expect((await modeOf(world, 'reporting')).license).toBe(mode);
    }
    expect(await moved()).toBe(3);
  });

  it('UAT-LIC01: the licence is in force on [valid_from, valid_until) by the clock of the server: before it, reporting only reads; inside it everything the plan has; from valid_until the grace of each feature decides', async () => {
    const world = await tenant();
    const window = windowFrom(new Date(Date.now() + 5 * DAY_MS));
    await issued(world, window);
    const ms = (instant: Date, delta: number): Date => new Date(instant.getTime() + delta);
    const attempt = async (instant: Date): Promise<{ write: Reply; analysis: Reply }> => {
      at(instant);
      await entitlementCache.invalidate(world.tenantId);
      const spec = world.spec;
      return { write: await submit(world, 'R-LIC01'), analysis: await asMember(world.tenantId, spec, 'POST', '/analysis-runs') };
    };
    const before = await attempt(ms(window.from, -1));
    expect([before.write.status, before.write.json.code, before.write.json.detail]).toEqual([403, 'ENTITLEMENT_DENIED', 'LICENSE_EXPIRED']);
    const first = await attempt(window.from);
    expect([first.write.status, first.analysis.status]).toEqual([200, 202]);
    const last = await attempt(ms(window.until, -1));
    expect([last.write.status, last.analysis.status]).toEqual([200, 202]);
    const grace = await attempt(window.until);
    expect(grace.write.status).toBe(200);
    expect([grace.analysis.status, grace.analysis.json.code, grace.analysis.json.detail]).toEqual([403, 'ENTITLEMENT_DENIED', 'LICENSE_GRACE']);
  });

  it('UAT-AC41: in the grace period the plan decides: reporting and export go on, the AI analysis, the campaigns and the invitations are refused with LICENSE_GRACE, and the view says which feature is in which mode', async () => {
    const world = await tenant();
    const window = windowFrom(new Date(Date.now() + 2 * DAY_MS));
    await issued(world, window);
    at(new Date(window.until.getTime() + 5 * DAY_MS));
    await entitlementCache.invalidate(world.tenantId);
    const [exportsBefore, campaignsBefore, invitationsBefore] = [
      await count('select count(*) as n from machvon.tenant_export_job where tenant_id = $1', [world.tenantId]),
      await count('select count(*) as n from machvon.notification_campaign where tenant_id = $1', [world.tenantId]),
      await count('select count(*) as n from machvon.membership_invitation where tenant_id = $1', [world.tenantId]),
    ];

    assertStatus(await submit(world, 'R-41'), 200);
    const analysis = await asMember(world.tenantId, world.spec, 'POST', '/analysis-runs');
    assertStatus(analysis, 403, 'ENTITLEMENT_DENIED');
    expect(analysis.json.detail).toBe('LICENSE_GRACE');
    const campaign = await asMember(world.tenantId, world.admin, 'POST', '/notification-campaigns');
    const invitation = await asMember(world.tenantId, world.admin, 'POST', '/memberships/invitations');
    for (const refused of [campaign, invitation]) {
      assertStatus(refused, 403, 'ENTITLEMENT_DENIED');
      expect(refused.json.detail).toBe('LICENSE_GRACE');
    }
    const exported = await asMember(world.tenantId, world.owner, 'POST', `/tenants/${world.tenantId}/export`, { payload: { scope: 'FULL', reason: REASON }, ifMatch: '"0"' });
    assertStatus(exported, 202);

    expect(await modeOf(world, 'reporting')).toEqual({ license: 'GRACE', mode: 'FULL' });
    expect((await modeOf(world, 'export')).mode).toBe('FULL');
    for (const feature of ['ai.analysis', 'notification.campaign', 'member.invite']) expect((await modeOf(world, feature)).mode).toBe('DENIED');
    // The refused commands wrote nothing.
    expect([
      await count('select count(*) as n from machvon.tenant_export_job where tenant_id = $1', [world.tenantId]) - exportsBefore,
      await count('select count(*) as n from machvon.notification_campaign where tenant_id = $1', [world.tenantId]) - campaignsBefore,
      await count('select count(*) as n from machvon.membership_invitation where tenant_id = $1', [world.tenantId]) - invitationsBefore,
    ]).toEqual([1, 0, 0]);
  });

  it('UAT-AC42: once the licence is Expired the plan reads (reporting READ_ONLY, export EXPORT_ONLY): the read is 200, the submission is refused with LICENSE_EXPIRED, the export is 202, no record is lost and no purge is scheduled', async () => {
    const world = await tenant();
    const window = windowFrom(new Date(Date.now() + 2 * DAY_MS));
    const id = await issued(world, window);
    at(new Date(window.grace.getTime() + DAY_MS));
    await harness.control.withTenantOf(world.tenantId, (tx) => job.run(tx, CONTROL_MEMBER, nowOf()));
    expect((await licenseRow(id))?.status).toBe('Expired');
    await entitlementCache.invalidate(world.tenantId);
    const records = (): Promise<number[]> =>
      Promise.all(['membership', 'role_grant', 'role_definition', 'organization_unit', 'user_account'].map((table) => count(`select count(*) as n from machvon.${table}${table === 'user_account' ? '' : ' where tenant_id = $1'}`, table === 'user_account' ? [] : [world.tenantId])));
    const before = await records();

    assertStatus(await asMember(world.tenantId, world.maker, 'GET', '/resources/report_revision'), 200);
    const refused = await submit(world, 'R-42');
    assertStatus(refused, 403, 'ENTITLEMENT_DENIED');
    expect(refused.json.detail).toBe('LICENSE_EXPIRED');
    assertStatus(await asMember(world.tenantId, world.owner, 'POST', `/tenants/${world.tenantId}/export`, { payload: { scope: 'FULL', reason: REASON }, ifMatch: '"0"' }), 202);

    expect(await records()).toEqual(before);
    expect(await modeOf(world, 'reporting')).toEqual({ license: 'EXPIRED', mode: 'READ_ONLY' });
    expect((await modeOf(world, 'export')).mode).toBe('EXPORT_ONLY');
    // The licence running out schedules nothing that removes data: the tenant stays Active, and no event of the tenant is about purging, archiving or offboarding.
    expect(await count("select count(*) as n from machvon.tenant where id = $1 and status = 'Active'", [world.tenantId])).toBe(1);
    expect(await count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and (type ~* 'purge|archiv|offboard|delet')", [world.tenantId])).toBe(0);
  });

  it('UAT-AC162: a suspended licence refuses the submission with LICENSE_SUSPENDED at once, reinstating brings it back Active, and a revoked licence is never reinstated (409 LICENSE_STATE_INVALID)', async () => {
    const world = await tenant();
    const id = await issued(world);
    // Warm the cache of the tenant first: the suspension must reach the gate through the cache of the process.
    assertStatus(await submit(world, 'R-162'), 200);
    assertStatus(await control('POST', `/licenses/${id}/suspend`, { ifMatch: '"1"', payload: { reason: REASON } }), 200);
    const suspended = await submit(world, 'R-162');
    assertStatus(suspended, 403, 'ENTITLEMENT_DENIED');
    expect(suspended.json.detail).toBe('LICENSE_SUSPENDED');
    assertStatus(await control('POST', `/licenses/${id}/reinstate`, { ifMatch: '"2"', payload: { reason: REASON } }), 200);
    expect((await licenseRow(id))?.status).toBe('Active');
    assertStatus(await submit(world, 'R-162'), 200);
    assertStatus(await control('POST', `/licenses/${id}/revoke`, { ifMatch: '"3"', payload: { reason: REASON } }), 200);
    assertStatus(await control('POST', `/licenses/${id}/reinstate`, { ifMatch: '"4"', payload: { reason: REASON } }), 409, 'LICENSE_STATE_INVALID');
    expect((await licenseRow(id))?.status).toBe('Revoked');
    assertStatus(await submit(world, 'R-162'), 403, 'ENTITLEMENT_DENIED');
  });

  it('UAT-AC43: the administrator and the owner of the tenant cannot renew a licence (403 SCOPE_DENIED, audited as DENIED, the licence unchanged), and a role that carries system.license.manage is refused 422 SYSTEM_PERMISSION_NOT_GRANTABLE', async () => {
    const world = await tenant();
    const id = await issued(world);
    const body = { valid_until: iso(new Date(Date.now() + 730 * DAY_MS)), grace_until: iso(new Date(Date.now() + 760 * DAY_MS)), reason: REASON };
    const deniedBefore = await count("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action = 'authz.denied:renewLicense'", []);
    for (const person of [world.admin, world.owner]) {
      const reply = await asMember(world.tenantId, person, 'POST', `/licenses/${id}/renew`, { ifMatch: '"1"', payload: body });
      assertStatus(reply, 403, 'SCOPE_DENIED');
    }
    expect(await count("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action = 'authz.denied:renewLicense'", [])).toBe(deniedBefore + 2);
    const role = await asMember(world.tenantId, world.admin, 'POST', '/roles', { payload: { code: 'LICENSE_BOSS', name: 'Licence boss', permissions: ['system.license.manage'], rank: 50 } });
    assertStatus(role, 422, 'SYSTEM_PERMISSION_NOT_GRANTABLE');
    expect(await count("select count(*) as n from machvon.role_definition where tenant_id = $1 and code = 'LICENSE_BOSS'", [world.tenantId])).toBe(0);
    // Only revision 1 stands, still Active in its window, with its version as it was.
    expect(await count('select count(*) as n from machvon.license_revision where tenant_id = $1', [world.tenantId])).toBe(1);
    expect(await licenseRow(id)).toMatchObject({ version: '1' });
  });

  it('a tenant that is Active is refused resume, archive and the retry of its provisioning with 409 TENANT_STATE_INVALID naming the transition, and none of them is audited as a success', async () => {
    const world = await tenant();
    const version = async (): Promise<string> => String((await harness.admin((client) => client.query<{ version: string }>('select version::text as version from machvon.tenant where id = $1', [world.tenantId]))).rows[0]?.version);
    const successes = (): Promise<number> => count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'SUCCESS'", [world.tenantId]);
    const before = await successes();
    const resume = await control('POST', `/system/tenants/${world.tenantId}/resume`, { ifMatch: `"${await version()}"`, payload: { reason: REASON } });
    const archive = await control('POST', `/system/tenants/${world.tenantId}/archive`, { ifMatch: `"${await version()}"`, payload: { reason: REASON } });
    const retry = await control('POST', `/system/tenants/${world.tenantId}/provisioning/retry`, { ifMatch: `"${await version()}"`, payload: { reason: REASON } });
    for (const reply of [resume, archive, retry]) assertStatus(reply, 409, 'TENANT_STATE_INVALID');
    expect([resume, archive, retry].map((reply) => reply.json.detail)).toEqual(['Active->Active', 'Active->Archived', 'Active->Provisioning']);
    expect(await successes()).toBe(before);
    expect(await count("select count(*) as n from machvon.tenant where id = $1 and status = 'Active'", [world.tenantId])).toBe(1);
  });

  it('the platform operator with only the right to read lists the tenants (the summary has no governing body, the detail has) and is refused creating one (403 SCOPE_DENIED) with nothing written', async () => {
    const world = await tenant();
    const listed = await control('GET', '/system/tenants', { roles: ['PlatformOperator'] });
    assertStatus(listed, 200);
    const mine = asObjects(listed.json.items).find((item) => item.id === world.tenantId);
    expect(Object.keys(mine ?? {}).sort()).toEqual(['code', 'id', 'isolation_mode', 'name', 'status']);
    const detail = await control('GET', `/system/tenants/${world.tenantId}`, { roles: ['PlatformOperator'] });
    assertStatus(detail, 200);
    expect(detail.json.governing_body_type).toBe('PROVINCE');
    const before = await count('select count(*) as n from machvon.tenant', []);
    const created = await control('POST', '/system/tenants', {
      roles: ['PlatformOperator'],
      payload: { code: 'op-ops-attempt', name: 'Attempt', governing_body_type: 'PROVINCE', region: 'vn-north', isolation_mode: 'POOL', plan_version_id: PLAN_PUBLISHED, root_unit_name: 'Root', initial_owner_email: 'owner@example.org' },
    });
    assertStatus(created, 403, 'SCOPE_DENIED');
    expect(await count('select count(*) as n from machvon.tenant', [])).toBe(before);
  });

  it('a licence of no length is 422 LICENSE_RANGE_INVALID, the entitlement version of another tenant is 422 LICENSE_TENANT_MISMATCH, and no seat is 422 VALIDATION_FAILED naming seats; nothing is stored', async () => {
    const world = await tenant();
    const other = await tenant();
    const day = new Date(Date.now() + 30 * DAY_MS);
    assertStatus(await control('POST', '/licenses', { payload: issueBody(world, { from: day, until: day, grace: day }) }), 422, 'LICENSE_RANGE_INVALID');
    assertStatus(await control('POST', '/licenses', { payload: issueBody(world, windowFrom(day), { entitlement_version_id: other.versionId }) }), 422, 'LICENSE_TENANT_MISMATCH');
    const noSeat = await control('POST', '/licenses', { payload: issueBody(world, windowFrom(day), { seats: 0 }) });
    assertStatus(noSeat, 422, 'VALIDATION_FAILED');
    expect(noSeat.json.detail).toBe('seats');
    expect(await count('select count(*) as n from machvon.license_revision where tenant_id = $1', [world.tenantId])).toBe(0);
  });

  it('UAT-AC161: a licence a client edited (seats 999) fails the verification, the server never reads a licence from a client and answers from its own entitlement (seats 100), and no log line carries the claims', async () => {
    const world = await tenant();
    const id = await issued(world);
    const row = await licenseRow(id);
    const [header, claimsPart, signature] = (row?.signed_claims ?? '').split('.') as [string, string, string];
    expect(row?.seats).toBe(100);
    const forgedClaims = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8')) as Record<string, unknown>), seats: 999 })).toString('base64url');
    const forged = `${header}.${forgedClaims}.${signature}`;
    expect(verifyLicenseToken(row?.signed_claims ?? '', await keys.publicKeys(), world.tenantId).valid).toBe(true);
    expect(verifyLicenseToken(forged, await keys.publicKeys(), world.tenantId)).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });

    const plain = await asMember(world.tenantId, world.maker, 'GET', '/me/entitlements');
    const mark = logged.length;
    const sneaky = await send({ tenantId: world.tenantId, membershipId: world.maker }, { aud: 'tenant' }, 'GET', '/me/entitlements', { headers: { 'x-license': forged, 'x-license-claims': JSON.stringify({ seats: 999 }), authorization: `License ${forged}` } });
    expect(sneaky).toEqual(plain);
    const read = await control('GET', `/system/licenses/${id}`);
    assertStatus(read, 200);
    expect(JSON.stringify(read.json)).not.toContain(forgedClaims);
    expect(await count('select count(*) as n from machvon.license_revision where id = $1 and seats = 100', [id])).toBe(1);
    const lines = logged.slice(mark).join('');
    expect(lines).not.toContain(forged);
    expect(lines).not.toContain(forgedClaims);
    expect(lines).not.toContain('"seats":999');
  });
});
