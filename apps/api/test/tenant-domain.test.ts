import { randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, sharedMockDomainPorts } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { AppModule } from '../src/app.module';
import { TenantDomainJob } from '../src/modules/sas/tenant-domain.job';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const ADMIN = '00000000-0000-4000-8000-0000000000f2';
const REASON = 'The customer changed its name and gave the domain back.';
const DAY = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the domains of a tenant over HTTP (ST-SAS-017)', () => {
  const harness = new ProvisioningHarness();
  const ports = sharedMockDomainPorts();
  let app: RunningApp;
  let counter = 0;

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function send(roles: string[] | undefined, method: string, path: string, options: { payload?: unknown; ifMatch?: number; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      [TENANT_HEADER]: signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: ADMIN, scopeVersion: 1 }, SIGNING_KEY),
      [CLAIMS_HEADER]: JSON.stringify({ aud: 'control', roles: roles ?? ['SystemAdmin'] }),
      'content-type': 'application/json',
    };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const asAdmin = (method: string, path: string, options: { payload?: unknown; ifMatch?: number; roles?: string[]; key?: string } = {}) => send(options.roles, method, path, options);

  /** An Active tenant: the platform sees it and acts as it. */
  async function tenant(): Promise<string> {
    const created = await harness.request();
    await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(created.tenantId, 'Provisioning', 'Active');
    return created.tenantId;
  }

  const host = (): string => `portal-${(counter += 1)}-${randomUUID().slice(0, 8)}.example.vn`;
  const add = (tenantId: string, hostname: string, kind: 'CUSTOM' | 'PLATFORM_SUBDOMAIN' = 'CUSTOM', roles?: string[]) =>
    asAdmin('POST', `/system/tenants/${tenantId}/domains`, { payload: { hostname, kind }, roles });
  const listed = async (tenantId: string): Promise<Array<Record<string, unknown>>> => (await asAdmin('GET', `/system/tenants/${tenantId}/domains`)).json.items as Array<Record<string, unknown>>;
  const verify = (domainId: string, version: number) => asAdmin('POST', `/system/tenant-domains/${domainId}/verify`, { payload: { reason: REASON }, ifMatch: version });
  const remove = (domainId: string, version: number) => asAdmin('POST', `/system/tenant-domains/${domainId}/remove`, { payload: { reason: REASON }, ifMatch: version });
  const lifecycle = (tenantId: string, now = new Date()) =>
    harness.control.withTenantOf(tenantId, (tx) => new TenantDomainJob(new AuditWriter(harness.tenants), ports).run(tx, ADMIN, now));

  beforeAll(async () => {
    await harness.start();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()) },
          control: { database: harness.control, registry: harness.registry },
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('AC-ST-SAS-017-1 UAT-AC152: a custom domain is proved by a TXT record, then Verified with a certificate; a hostname of another tenant, or one released lately, is DOMAIN_TAKEN', async () => {
    const a = await tenant();
    const b = await tenant();
    const hostname = host();
    const added = await add(a, hostname);
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ txt_record_name: `_machvon-verify.${hostname}` });
    const token = added.json.txt_record_value as string;
    expect(token).toMatch(/^machvon-verify=[A-Za-z0-9_-]{32,}$/);
    const domainId = added.json.domain_id as string;
    // The token is given once: the platform keeps its hash only, and the list does not show it.
    const [pending] = await listed(a);
    expect(pending).toMatchObject({ id: domainId, hostname, kind: 'CUSTOM', status: 'PendingVerification', tls_status: 'Pending', txt_record_name: `_machvon-verify.${hostname}` });
    expect(JSON.stringify(pending)).not.toContain(token);
    expect((await admin<{ txt_token_hash: string }>('select txt_token_hash from machvon.tenant_domain where id = $1', [domainId]))[0]?.txt_token_hash).not.toBe(token);

    // Nothing published yet: refused, and the check is remembered.
    const refused = await verify(domainId, 1);
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe('DOMAIN_UNVERIFIED');
    const [checked] = await listed(a);
    expect(checked?.status).toBe('PendingVerification');
    expect(checked?.last_checked_at).not.toBeNull();

    // The record is published: Verified, and the pass gives the certificate.
    ports.proof.publish(`_machvon-verify.${hostname}`, token);
    const version = checked?.version as number;
    const done = await verify(domainId, version);
    expect(done.status).toBe(202);
    expect(done.json).toMatchObject({ status: 'VERIFIED', resource_id: domainId });
    await lifecycle(a);
    const [active] = await listed(a);
    expect(active).toMatchObject({ status: 'Active', tls_status: 'Issued', txt_record_name: null });
    expect(active?.tls_expires_at).not.toBeNull();
    expect(ports.certificates.issued).toContain(hostname);

    // Another tenant cannot have the hostname (the contract takes it in lower case only).
    expect((await add(b, hostname.toUpperCase())).status).toBe(422);
    const taken = await add(b, hostname);
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe('DOMAIN_TAKEN');
    expect(await listed(b)).toEqual([]);

    // Released, it is held for 90 days: nobody gets it, not even another tenant straight away.
    const released = await remove(domainId, active?.version as number);
    expect(released.status).toBe(200);
    expect(released.json).toMatchObject({ status: 'REVOKED' });
    const [gone] = await listed(a);
    expect(gone?.status).toBe('Revoked');
    expect(new Date(gone?.reserved_until as string).getTime() - new Date(gone?.revoked_at as string).getTime()).toBe(90 * DAY);
    const reserved = await add(b, hostname);
    expect(reserved.status).toBe(409);
    expect(reserved.json.code).toBe('DOMAIN_TAKEN');
    expect(reserved.json.reason).toBe('RESERVED');
  });

  it('a platform subdomain needs no proof, is under the platform domain only, and a name of the platform itself is refused', async () => {
    const t = await tenant();
    const name = `t-${randomUUID().slice(0, 8)}.machvon.vn`;
    const added = await add(t, name, 'PLATFORM_SUBDOMAIN');
    expect(added.status).toBe(201);
    expect(added.json.txt_record_value).toBe('');
    expect((await listed(t))[0]).toMatchObject({ hostname: name, kind: 'PLATFORM_SUBDOMAIN', txt_record_name: null });
    expect((await add(t, host(), 'PLATFORM_SUBDOMAIN')).status).toBe(422);
    for (const reserved of ['machvon.vn', 'www.machvon.vn', 'api.machvon.vn']) {
      const reply = await add(t, reserved, 'CUSTOM');
      expect([409, 422]).toContain(reply.status);
    }
  });

  it('refuses a hostname that is not a name, an unknown tenant and an unknown domain', async () => {
    const t = await tenant();
    for (const bad of ['', 'not a host', 'http://a.example.vn', '10.0.0.1', 'a'.repeat(260) + '.vn', 'localhost']) {
      const reply = await add(t, bad);
      expect(reply.status).toBe(422);
    }
    expect((await add(randomUUID(), host())).status).toBe(404);
    expect((await asAdmin('GET', `/system/tenants/${randomUUID()}/domains`)).status).toBe(404);
    expect((await verify(randomUUID(), 1)).status).toBe(404);
    expect((await remove(randomUUID(), 1)).status).toBe(404);
  });

  it('answers a stale version with 409 VERSION_CONFLICT, and a released domain cannot be verified or released again', async () => {
    const t = await tenant();
    const added = await add(t, host());
    const domainId = added.json.domain_id as string;
    const stale = await remove(domainId, 99);
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('VERSION_CONFLICT');
    expect((await remove(domainId, 1)).status).toBe(200);
    expect((await remove(domainId, 2)).status).toBe(404);
    expect((await verify(domainId, 2)).status).toBe(404);
  });

  it('lets SystemAdmin write and PlatformOperator read; nobody else, and nobody without a role, touches the domains', async () => {
    const t = await tenant();
    const added = await add(t, host());
    expect(added.status).toBe(201);
    const domainId = added.json.domain_id as string;
    expect((await asAdmin('GET', `/system/tenants/${t}/domains`, { roles: ['PlatformOperator'] })).status).toBe(200);
    expect((await asAdmin('GET', `/system/tenants/${t}/domains`, { roles: ['SupportOperator'] })).status).toBe(403);
    for (const roles of [['PlatformOperator'], ['BillingOperator'], ['SupportOperator'], []]) {
      expect((await add(t, host(), 'CUSTOM', roles)).status).toBe(403);
      const verified = await asAdmin('POST', `/system/tenant-domains/${domainId}/verify`, { payload: { reason: REASON }, ifMatch: 1, roles });
      expect(verified.status).toBe(403);
    }
    // Nothing was written by the refusals.
    expect(await listed(t)).toHaveLength(1);
  });

  it('never stores the token it shows once: the answer kept for the idempotency key has no value, and a replay says so', async () => {
    const t = await tenant();
    const hostname = host();
    const key = `key-${randomUUID()}`;
    const first = await asAdmin('POST', `/system/tenants/${t}/domains`, { payload: { hostname, kind: 'CUSTOM' }, key });
    expect(first.status).toBe(201);
    const token = first.json.txt_record_value as string;
    expect(token).toMatch(/^machvon-verify=/);
    const kept = await admin<{ response_ref: unknown }>('select response_ref from machvon.idempotency_record where resource_id = $1', [first.json.domain_id]);
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept)).not.toContain(token);
    expect(JSON.stringify(kept)).toContain(first.json.domain_id as string);
    const replay = await asAdmin('POST', `/system/tenants/${t}/domains`, { payload: { hostname, kind: 'CUSTOM' }, key });
    expect(replay.status).toBe(201);
    expect(replay.json).toMatchObject({ domain_id: first.json.domain_id, txt_record_name: first.json.txt_record_name, txt_record_value: '' });
    expect(await listed(t)).toHaveLength(1);
  });

  it('writes an audit entry and an outbox event for each change, in the name of the tenant, with no token in them', async () => {
    const t = await tenant();
    const hostname = host();
    const added = await add(t, hostname);
    const domainId = added.json.domain_id as string;
    const token = added.json.txt_record_value as string;
    ports.proof.publish(`_machvon-verify.${hostname}`, token);
    const current = (await listed(t))[0];
    expect((await verify(domainId, current?.version as number)).status).toBe(202);
    const audits = await admin<{ action: string; safe_diff: unknown }>("select action, safe_diff from machvon.audit_event where resource_id = $1 order by id", [domainId]);
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(['tenant.domain_added', 'tenant.domain_verified']));
    expect(JSON.stringify(audits)).not.toContain(token);
    const events = await admin<{ type: string; payload: unknown }>('select type, payload from machvon.outbox_event where aggregate_id = $1', [domainId]);
    expect(events.map((row) => row.type)).toContain('sas.domain.verified.v1');
    expect(JSON.stringify(events)).not.toContain(token);
  });
});
