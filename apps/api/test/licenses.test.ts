import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import {
  EffectiveAccessStore,
  EntitlementStore,
  InMemoryAuthzCache,
  InMemoryEntitlementCache,
  LicenseStore,
  PLATFORM_TENANT_ID,
} from '@machvon/db';
import { DomainError, STANDARD_FEATURES, loadErrorRegistry, signTenantContext, verifyLicenseToken } from '@machvon/kernel';
import type { LicenseSigner } from '@machvon/kernel';
import { AppModule } from '../src/app.module';
import { Ed25519LicenseSigner } from '../src/modules/sas/license-signer';
import type { LicenseKeyStore } from '../src/modules/sas/license-signer';
import { DatabaseTenantRuntime } from '../src/session/tenant-runtime';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { CONTROL_OPERATIONS, controlCasesFor } from './authz/control-matrix';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const CONTROL_MEMBER = '00000000-0000-4000-8000-0000000000c9';
const PLAN = '00000000-0000-4000-9000-000000000001';
const KEY_ID = 'kid-http';
const REASON = 'The contract was terminated by the agency.';
const DAY_MS = 86_400_000;

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

/** A key store of the test: one Ed25519 key, which can be taken away to see what the commands do without one. */
class TestKeys implements LicenseKeyStore {
  available = true;
  private readonly pair = generateKeyPairSync('ed25519');
  readonly signer: LicenseSigner = new Ed25519LicenseSigner(KEY_ID, this.pair.privateKey);
  readonly privateKeyBase64 = this.pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  readonly publicKeyDer = this.pair.publicKey.export({ format: 'der', type: 'spki' });
  readonly publicKeyPem = this.pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();

  current(): Promise<LicenseSigner> {
    return this.available ? Promise.resolve(this.signer) : Promise.reject(new DomainError('SIGNING_KEY_UNAVAILABLE', 503));
  }

  publicKeys(): Promise<ReadonlyMap<string, Uint8Array>> {
    return Promise.resolve(new Map([[KEY_ID, this.publicKeyDer]]));
  }
}

describe('license commands over HTTP (ST-SAS-003)', () => {
  const harness = new ProvisioningHarness();
  const entitlementCache = new InMemoryEntitlementCache();
  const authzCache = new InMemoryAuthzCache();
  const keys = new TestKeys();
  const dropped = { entitlements: [] as string[], authz: [] as string[] };
  let entitlements: EntitlementStore;
  let store: LicenseStore;
  let app: RunningApp;
  const captured: string[] = [];
  const restore: Array<() => void> = [];

  const iso = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();

  async function call(
    method: string,
    path: string,
    options: { roles?: string[]; audience?: string; payload?: unknown; key?: string; ifMatch?: string } = {},
  ): Promise<Reply> {
    const token = signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: CONTROL_MEMBER, scopeVersion: 0 }, SIGNING_KEY);
    const headers: Record<string, string> = {
      [TENANT_HEADER]: token,
      [CLAIMS_HEADER]: JSON.stringify({ aud: options.audience ?? 'control', roles: options.roles ?? ['SystemAdmin'] }),
      'content-type': 'application/json',
    };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async function activeTenant(): Promise<{ tenantId: string; versionId: string }> {
    const created = await harness.request();
    await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(created.tenantId, 'Provisioning', 'Active');
    await harness.tenants.withTenant({ tenantId: created.tenantId, membershipId: CONTROL_MEMBER, scopeVersion: 1 }, (tx) =>
      entitlements.record(tx, { cause: 'PROVISIONING', planVersionId: PLAN, features: STANDARD_FEATURES }),
    );
    const rows = await harness.admin((client) => client.query<{ id: string }>('select id from machvon.entitlement_version where tenant_id = $1 and version_no = 1', [created.tenantId]));
    return { tenantId: created.tenantId, versionId: rows.rows[0]?.id ?? '' };
  }

  const issueBody = (tenantId: string, versionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    tenant_id: tenantId,
    edition: 'STANDARD',
    valid_from: iso(-1),
    valid_until: iso(364),
    grace_until: iso(394),
    entitlement_version_id: versionId,
    seats: 50,
    quota: { storage_gb: 100 },
    ...overrides,
  });

  const issue = (tenantId: string, versionId: string, overrides: Record<string, unknown> = {}, options: { roles?: string[]; key?: string; audience?: string } = {}): Promise<Reply> =>
    call('POST', '/licenses', { ...options, payload: issueBody(tenantId, versionId, overrides) });

  const revoke = (id: string, options: { ifMatch?: string; roles?: string[]; audience?: string; payload?: unknown } = {}): Promise<Reply> =>
    call('POST', `/licenses/${id}/revoke`, { payload: { reason: REASON }, ...options });

  const suspend = (id: string, options: { ifMatch?: string; roles?: string[]; audience?: string; payload?: unknown; key?: string } = {}): Promise<Reply> =>
    call('POST', `/licenses/${id}/suspend`, { payload: { reason: REASON }, ...options });

  const reinstate = (id: string, options: { ifMatch?: string; roles?: string[]; audience?: string; payload?: unknown; key?: string } = {}): Promise<Reply> =>
    call('POST', `/licenses/${id}/reinstate`, { payload: { reason: REASON }, ...options });

  const renew = (id: string, options: { ifMatch?: string; roles?: string[]; audience?: string; payload?: unknown; key?: string } = {}): Promise<Reply> =>
    call('POST', `/licenses/${id}/renew`, { payload: { valid_until: iso(729), grace_until: iso(759), reason: REASON }, ...options });

  const licenseRow = async (id: string): Promise<{ status: string; status_reason: string | null; version: string; signed_claims: string; tenant_id: string } | undefined> =>
    (await harness.admin((client) => client.query('select status, status_reason, version::text as version, signed_claims, tenant_id from machvon.license_revision where id = $1', [id]))).rows[0];

  const licenseCount = async (tenantId: string): Promise<number> => harness.count('select count(*) as n from machvon.license_revision where tenant_id = $1', [tenantId]);

  beforeAll(async () => {
    // Everything the process writes to the console while the tests run is looked at for key material at the end.
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      restore.push(() => {
        stream.write = original;
      });
    }
    await harness.start();
    entitlements = new EntitlementStore(harness.tenants, entitlementCache);
    store = new LicenseStore(entitlements);
    const entitlementInvalidate = entitlementCache.invalidate.bind(entitlementCache);
    entitlementCache.invalidate = (tenantId: string): Promise<void> => {
      dropped.entitlements.push(tenantId);
      return entitlementInvalidate(tenantId);
    };
    const authzInvalidate = authzCache.invalidateTenant.bind(authzCache);
    authzCache.invalidateTenant = (tenantId: string): Promise<void> => {
      dropped.authz.push(tenantId);
      return authzInvalidate(tenantId);
    };
    const registered = await harness.control.withControl((tx) =>
      store.registerSigningKey(tx, { keyId: KEY_ID, publicKeyPem: keys.publicKeyPem, kmsKeyRef: 'test', notBefore: new Date(Date.now() - 30 * DAY_MS), notAfter: new Date(Date.now() + 730 * DAY_MS) }),
    );
    expect(registered).toBe(true);
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, authzCache) },
          control: { database: harness.control, registry: harness.registry },
          licenses: { store, keys },
          tenantState: { runtime: new DatabaseTenantRuntime(harness.tenants), entitlementCache, authzCache },
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    for (const undo of restore) undo();
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('post_licenses', () => {
    it('answers 201 with the CommandResult, stores the signed revision as Issued, and the signature verifies with the public key', async () => {
      const { tenantId, versionId } = await activeTenant();
      const reply = await issue(tenantId, versionId);
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'ISSUED', resource_version: 1 });
      const id = reply.json.resource_id as string;
      const row = await licenseRow(id);
      expect(row).toMatchObject({ status: 'Issued', version: '1', tenant_id: tenantId });
      const verified = verifyLicenseToken(row?.signed_claims ?? '', await keys.publicKeys(), tenantId);
      expect(verified.valid).toBe(true);
      // The license of this tenant is no license of another.
      expect(verifyLicenseToken(row?.signed_claims ?? '', await keys.publicKeys(), PLATFORM_TENANT_ID)).toEqual({ valid: false, reason: 'TENANT_MISMATCH' });
    });

    it('writes the audit row and both events on the tenant of the license, and has dropped the caches of the tenant when the answer arrives', async () => {
      const { tenantId, versionId } = await activeTenant();
      dropped.entitlements.length = 0;
      dropped.authz.length = 0;
      const reply = await issue(tenantId, versionId);
      const id = reply.json.resource_id as string;
      const audit = await harness.admin((client) =>
        client.query<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where tenant_id = $1 and action = 'license.issued' and outcome = 'SUCCESS' and resource_id = $2", [tenantId, id]),
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.safe_diff).toMatchObject({ revision: 1, edition: 'STANDARD', key_id: KEY_ID, seats: 50 });
      const events = await harness.admin((client) =>
        client.query<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where tenant_id = $1 and type in ('sas.license.issued.v1', 'sas.entitlement.changed.v1') order by type", [tenantId]),
      );
      expect(events.rows.map((row) => row.type)).toEqual(['sas.entitlement.changed.v1', 'sas.entitlement.changed.v1', 'sas.license.issued.v1']);
      expect(events.rows[2]?.payload).toMatchObject({ tenant_id: tenantId, license_id: id, revision: 1, edition: 'STANDARD', key_id: KEY_ID });
      expect(dropped.entitlements).toContain(tenantId);
      expect(dropped.authz).toContain(tenantId);
      // The entitlement snapshot now follows the license: inside its window it is FULL.
      expect((await entitlements.allowedFromDatabase({ tenantId, membershipId: CONTROL_MEMBER, scopeVersion: 1 }, 'reporting', 'write')).allowed).toBe(true);
    });

    it('keeps the signed claims, the private key and every key out of the audit row, the events and the log output', async () => {
      const { tenantId, versionId } = await activeTenant();
      const reply = await issue(tenantId, versionId);
      const row = await licenseRow(reply.json.resource_id as string);
      keys.available = false;
      await issue(tenantId, versionId, { valid_from: iso(500), valid_until: iso(600), grace_until: iso(600) });
      keys.available = true;
      const dump = await harness.admin(async (client) => {
        const audit = await client.query<{ doc: string }>('select to_jsonb(a)::text as doc from machvon.audit_event a where tenant_id = $1', [tenantId]);
        const events = await client.query<{ doc: string }>('select to_jsonb(e)::text as doc from machvon.outbox_event e where tenant_id = $1', [tenantId]);
        return [...audit.rows, ...events.rows].map((entry) => entry.doc).join('\n');
      });
      expect(dump).not.toContain(row?.signed_claims ?? 'missing');
      expect(dump).not.toContain(keys.privateKeyBase64);
      expect(dump).not.toContain('PRIVATE KEY');
      const log = captured.join('');
      expect(log).not.toContain(keys.privateKeyBase64);
      expect(log).not.toContain('PRIVATE KEY');
      expect(log).not.toContain(row?.signed_claims ?? 'missing');
    });

    it('replays the same key and body with the same revision and creates one license', async () => {
      const { tenantId, versionId } = await activeTenant();
      const key = `key-${randomUUID()}`;
      const body = { valid_from: iso(-1), valid_until: iso(364), grace_until: iso(394) };
      const first = await issue(tenantId, versionId, body, { key });
      const second = await issue(tenantId, versionId, body, { key });
      expect(second.status).toBe(201);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(await licenseCount(tenantId)).toBe(1);
    });

    it.each([
      ['valid_from not before valid_until', { valid_from: iso(400) }, 422, 'LICENSE_RANGE_INVALID'],
      ['grace_until before valid_until', { grace_until: iso(300) }, 422, 'LICENSE_RANGE_INVALID'],
      ['a window that ended already', { valid_from: iso(-400), valid_until: iso(-10), grace_until: iso(-10) }, 422, 'LICENSE_RANGE_INVALID'],
      ['no seat', { seats: 0 }, 422, 'VALIDATION_FAILED'],
      ['an edition that is not in the contract', { edition: 'GOLD' }, 422, 'VALIDATION_FAILED'],
      ['claims sent by the client', { claims: { seats: 9999 } }, 400, 'FIELD_NOT_ALLOWED'],
    ] as const)('refuses %s with %s %s and stores nothing (AC-ST-SAS-003-7)', async (_label, overrides, status, code) => {
      const { tenantId, versionId } = await activeTenant();
      const reply = await issue(tenantId, versionId, overrides);
      expect([reply.status, reply.json.code]).toEqual([status, code]);
      expect(await licenseCount(tenantId)).toBe(0);
    });

    it('refuses a window that overlaps a license that is not revoked, and accepts it again after the revocation', async () => {
      const { tenantId, versionId } = await activeTenant();
      const first = await issue(tenantId, versionId);
      const overlapping = await issue(tenantId, versionId, { valid_from: iso(100), valid_until: iso(700), grace_until: iso(700) });
      expect([overlapping.status, overlapping.json.code]).toEqual([422, 'LICENSE_RANGE_INVALID']);
      expect((await revoke(first.json.resource_id as string, { ifMatch: '"1"' })).status).toBe(200);
      expect((await issue(tenantId, versionId, { valid_from: iso(100), valid_until: iso(700), grace_until: iso(700) })).status).toBe(201);
    });

    it('refuses the entitlement version of another tenant with 422 LICENSE_TENANT_MISMATCH (AC-ST-SAS-003-7)', async () => {
      const a = await activeTenant();
      const b = await activeTenant();
      const reply = await issue(a.tenantId, b.versionId);
      expect([reply.status, reply.json.code]).toEqual([422, 'LICENSE_TENANT_MISMATCH']);
      expect(await licenseCount(a.tenantId)).toBe(0);
      expect(await licenseCount(b.tenantId)).toBe(0);
    });

    it('refuses a Requested tenant with 409 TENANT_STATE_INVALID and an unknown tenant with 404', async () => {
      const requested = await harness.request();
      const refused = await issue(requested.tenantId, randomUUID());
      expect([refused.status, refused.json.code]).toEqual([409, 'TENANT_STATE_INVALID']);
      const missing = await issue('00000000-0000-4000-8000-00000000f998', randomUUID());
      expect(missing.status).toBe(404);
    });

    it('answers 503 SIGNING_KEY_UNAVAILABLE when no key can sign, and stores nothing', async () => {
      const { tenantId, versionId } = await activeTenant();
      keys.available = false;
      try {
        const reply = await issue(tenantId, versionId);
        expect([reply.status, reply.json.code]).toEqual([503, 'SIGNING_KEY_UNAVAILABLE']);
      } finally {
        keys.available = true;
      }
      expect(await licenseCount(tenantId)).toBe(0);
      expect(await harness.count("select count(*) as n from machvon.entitlement_version where tenant_id = $1 and cause = 'LICENSE_CHANGE'", [tenantId])).toBe(0);
    });
  });

  describe('post_licenses_id_revoke', () => {
    async function issued(): Promise<{ tenantId: string; id: string }> {
      const { tenantId, versionId } = await activeTenant();
      const reply = await issue(tenantId, versionId);
      return { tenantId, id: reply.json.resource_id as string };
    }

    it('revokes the license: 200 with the CommandResult, the reason on the row, an audit row with the reason and the events, and no feature is allowed afterwards (AC-ST-SAS-003-6)', async () => {
      const { tenantId, id } = await issued();
      dropped.entitlements.length = 0;
      const reply = await revoke(id, { ifMatch: '"1"' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'REVOKED', resource_version: 2, resource_id: id });
      expect(await licenseRow(id)).toMatchObject({ status: 'Revoked', status_reason: REASON, version: '2' });
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and action = 'license.revoked' and outcome = 'SUCCESS' and reason = $2", [tenantId, REASON])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.license.revoked.v1'", [tenantId])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.entitlement_version where tenant_id = $1 and cause = 'LICENSE_CHANGE'", [tenantId])).toBe(2);
      expect(dropped.entitlements).toContain(tenantId);
      const context = { tenantId, membershipId: CONTROL_MEMBER, scopeVersion: 1 };
      expect(await entitlements.allowedFromDatabase(context, 'reporting', 'read')).toEqual({ allowed: false, reason: 'LICENSE_SUSPENDED' });
      expect((await entitlements.current(context)).licenseMode).toBe('REVOKED');
    });

    it('answers 409 LICENSE_STATE_INVALID for a second revocation', async () => {
      const { id } = await issued();
      await revoke(id, { ifMatch: '"1"' });
      const again = await revoke(id, { ifMatch: '"2"' });
      expect([again.status, again.json.code]).toEqual([409, 'LICENSE_STATE_INVALID']);
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT with the current version for a stale one, 404 for an unknown license and 422 for a short reason', async () => {
      const { id } = await issued();
      expect((await revoke(id)).status).toBe(428);
      const stale = await revoke(id, { ifMatch: '"7"' });
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', 1]);
      expect((await revoke(randomUUID(), { ifMatch: '"1"' })).status).toBe(404);
      const short = await revoke(id, { ifMatch: '"1"', payload: { reason: 'too short' } });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await licenseRow(id))?.status).toBe('Issued');
    });

    it('replays the same key with the stored answer and revokes once', async () => {
      const { tenantId, id } = await issued();
      const key = `key-${randomUUID()}`;
      const send = (): Promise<Reply> => call('POST', `/licenses/${id}/revoke`, { ifMatch: '"1"', key, payload: { reason: REASON } });
      const first = await send();
      const second = await send();
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.license.revoked.v1'", [tenantId])).toBe(1);
    });
  });

  describe('suspendLicense and reinstateLicense', () => {
    async function issued(): Promise<{ tenantId: string; id: string }> {
      const { tenantId, versionId } = await activeTenant();
      const reply = await issue(tenantId, versionId);
      return { tenantId, id: reply.json.resource_id as string };
    }

    it('suspends: 200 with the CommandResult, the reason on the row, an audit row with the reason, the event, and the tenant is denied afterwards (AC-ST-SAS-014-2)', async () => {
      const { tenantId, id } = await issued();
      dropped.entitlements.length = 0;
      const reply = await suspend(id, { ifMatch: '"1"' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'SUSPENDED', resource_version: 2, resource_id: id });
      expect(await licenseRow(id)).toMatchObject({ status: 'Suspended', status_reason: REASON, version: '2' });
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and action = 'license.suspended' and outcome = 'SUCCESS' and reason = $2", [tenantId, REASON])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.license.suspended.v1'", [tenantId])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.entitlement_version where tenant_id = $1 and cause = 'LICENSE_CHANGE'", [tenantId])).toBe(2);
      expect(dropped.entitlements).toContain(tenantId);
      const context = { tenantId, membershipId: CONTROL_MEMBER, scopeVersion: 1 };
      expect(await entitlements.allowedFromDatabase(context, 'reporting', 'read')).toEqual({ allowed: false, reason: 'LICENSE_SUSPENDED' });
      expect((await entitlements.current(context)).licenseMode).toBe('SUSPENDED');
    });

    it('reinstates: the tenant is allowed again, a second reinstatement is 409 LICENSE_STATE_INVALID, and the cycle can repeat with its own events (AC-ST-SAS-014-2)', async () => {
      const { tenantId, id } = await issued();
      await suspend(id, { ifMatch: '"1"' });
      const back = await reinstate(id, { ifMatch: '"2"' });
      expect(back.json).toMatchObject({ status: 'REINSTATED', resource_version: 3, resource_id: id });
      expect(await licenseRow(id)).toMatchObject({ status: 'Active', status_reason: null, version: '3' });
      const context = { tenantId, membershipId: CONTROL_MEMBER, scopeVersion: 1 };
      expect((await entitlements.allowedFromDatabase(context, 'reporting', 'read')).allowed).toBe(true);
      expect((await entitlements.current(context)).licenseMode).toBe('FULL');
      const again = await reinstate(id, { ifMatch: '"3"' });
      expect([again.status, again.json.code]).toEqual([409, 'LICENSE_STATE_INVALID']);
      expect((await suspend(id, { ifMatch: '"3"' })).status).toBe(200);
      expect((await reinstate(id, { ifMatch: '"4"' })).status).toBe(200);
      expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.license.suspended.v1'", [tenantId])).toBe(2);
      expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.license.reinstated.v1'", [tenantId])).toBe(2);
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and action = 'license.reinstated' and reason = $2", [tenantId, REASON])).toBe(2);
    });

    it('never brings a revoked license back, and refuses to suspend a license that is suspended or revoked (AC-ST-SAS-014-2)', async () => {
      const { id } = await issued();
      expect((await suspend(id, { ifMatch: '"1"' })).status).toBe(200);
      const twice = await suspend(id, { ifMatch: '"2"' });
      expect([twice.status, twice.json.code]).toEqual([409, 'LICENSE_STATE_INVALID']);
      expect((await revoke(id, { ifMatch: '"2"' })).status).toBe(200);
      const back = await reinstate(id, { ifMatch: '"3"' });
      expect([back.status, back.json.code]).toEqual([409, 'LICENSE_STATE_INVALID']);
      const suspendRevoked = await suspend(id, { ifMatch: '"3"' });
      expect([suspendRevoked.status, suspendRevoked.json.code]).toEqual([409, 'LICENSE_STATE_INVALID']);
      expect((await licenseRow(id))?.status).toBe('Revoked');
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT for a stale one, 404 for an unknown license and 422 for a short reason', async () => {
      const { id } = await issued();
      expect((await suspend(id)).status).toBe(428);
      const stale = await suspend(id, { ifMatch: '"7"' });
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', 1]);
      expect((await suspend(randomUUID(), { ifMatch: '"1"' })).status).toBe(404);
      const short = await suspend(id, { ifMatch: '"1"', payload: { reason: 'too short' } });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await reinstate(randomUUID(), { ifMatch: '"1"' })).status).toBe(404);
      expect((await licenseRow(id))?.status).toBe('Issued');
    });

    it('replays the same key with the stored answer and suspends once', async () => {
      const { tenantId, id } = await issued();
      const key = `key-${randomUUID()}`;
      const first = await suspend(id, { ifMatch: '"1"', key });
      const second = await suspend(id, { ifMatch: '"1"', key });
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.license.suspended.v1'", [tenantId])).toBe(1);
    });

    it('refuses a tenant-plane token with 403 SCOPE_DENIED and changes nothing (AC-ST-SAS-003-5)', async () => {
      const { id } = await issued();
      const reply = await suspend(id, { ifMatch: '"1"', audience: 'tenant', roles: ['TENANT_ADMIN', 'SystemAdmin'] });
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await licenseRow(id))?.status).toBe('Issued');
    });
  });

  describe('renewLicense (ST-SAS-014)', () => {
    async function issued(): Promise<{ tenantId: string; versionId: string; id: string }> {
      const { tenantId, versionId } = await activeTenant();
      const reply = await issue(tenantId, versionId);
      return { tenantId, versionId, id: reply.json.resource_id as string };
    }

    const read = async (id: string): Promise<Record<string, unknown>> => (await call('GET', `/system/licenses/${id}`)).json;

    it('AC-ST-SAS-014-1, UAT-AC160: revision 2 supersedes revision 1, which becomes Superseded, and both signatures verify', async () => {
      const { tenantId, id } = await issued();
      dropped.entitlements.length = 0;
      const reply = await renew(id, { ifMatch: '"1"' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'RENEWED', resource_version: 1 });
      const next = reply.json.resource_id as string;
      expect(next).not.toBe(id);
      const first = await read(id);
      const second = await read(next);
      expect(first).toMatchObject({ revision: 1, status: 'Superseded', signature_check: 'VALID', version: 2 });
      expect(second).toMatchObject({ revision: 2, status: 'Active', signature_check: 'VALID', supersedes_id: id, serial: first.serial, edition: 'STANDARD', seats: 50, quota: { storage_gb: 100 }, entitlement_version_id: first.entitlement_version_id });
      // The term is seamless: the new revision starts with the renewal and ends where the request says.
      expect(Date.parse(second.valid_from as string)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(second.valid_until as string)).toBeGreaterThan(Date.parse(first.valid_until as string));
      expect(await harness.count("select count(*) as n from machvon.license_revision where tenant_id = $1 and serial = $2 and status in ('Issued','Active','Grace','Suspended')", [tenantId, first.serial as string])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and action = 'license.renewed' and outcome = 'SUCCESS' and reason = $2 and resource_id = $3", [tenantId, REASON, next])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.license.renewed.v1' and aggregate_id = $2", [tenantId, next])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.entitlement_version where tenant_id = $1 and cause = 'LICENSE_CHANGE'", [tenantId])).toBe(2);
      expect(dropped.entitlements).toContain(tenantId);
      // The tenant goes on being allowed, by the new revision.
      const context = { tenantId, membershipId: CONTROL_MEMBER, scopeVersion: 1 };
      expect((await entitlements.allowedFromDatabase(context, 'reporting', 'read')).allowed).toBe(true);
      expect((await entitlements.current(context)).licenseMode).toBe('FULL');
      // The list of the tenant shows the chain.
      const listed = (await call('GET', `/system/tenants/${tenantId}/licenses`)).json.items as Array<Record<string, unknown>>;
      expect(listed.map((item) => [item.revision, item.status, item.supersedes_id ?? null])).toEqual([
        [1, 'Superseded', null],
        [2, 'Active', id],
      ]);
    });

    it('keeps the claims, the keys and the signature out of the audit row and the event of the renewal', async () => {
      const { tenantId, id } = await issued();
      const reply = await renew(id, { ifMatch: '"1"' });
      const next = reply.json.resource_id as string;
      const audit = await harness.admin((client) => client.query('select safe_diff from machvon.audit_event where tenant_id = $1 and action = $2 and resource_id = $3', [tenantId, 'license.renewed', next]));
      const event = await harness.admin((client) => client.query('select payload from machvon.outbox_event where tenant_id = $1 and type = $2 and aggregate_id = $3', [tenantId, 'sas.license.renewed.v1', next]));
      const text = JSON.stringify([audit.rows, event.rows]);
      expect(text).toContain('supersedes_id');
      expect(text).not.toContain((await licenseRow(next))?.signed_claims ?? 'x');
      expect(text).not.toMatch(/signed_claims|PRIVATE KEY|public_key/);
    });

    it('renews with other seats and another entitlement version of the same tenant, and refuses the version of another tenant with 422 LICENSE_TENANT_MISMATCH', async () => {
      const { tenantId, versionId, id } = await issued();
      const other = await activeTenant();
      const mismatch = await renew(id, { ifMatch: '"1"', payload: { valid_until: iso(729), grace_until: iso(759), seats: 80, entitlement_version_id: other.versionId, reason: REASON } });
      expect([mismatch.status, mismatch.json.code]).toEqual([422, 'LICENSE_TENANT_MISMATCH']);
      expect((await licenseRow(id))?.status).toBe('Issued');
      const reply = await renew(id, { ifMatch: '"1"', payload: { valid_until: iso(729), grace_until: iso(759), seats: 80, entitlement_version_id: versionId, reason: REASON } });
      expect(reply.status).toBe(200);
      expect(await read(reply.json.resource_id as string)).toMatchObject({ seats: 80, entitlement_version_id: versionId, tenant_id: tenantId });
    });

    it('refuses an end that is not later than the current one or a grace period before the end with 422 LICENSE_RANGE_INVALID, and changes nothing', async () => {
      const { id } = await issued();
      const earlier = await renew(id, { ifMatch: '"1"', payload: { valid_until: iso(100), grace_until: iso(130), reason: REASON } });
      expect([earlier.status, earlier.json.code, earlier.json.detail]).toEqual([422, 'LICENSE_RANGE_INVALID', 'valid_until']);
      const grace = await renew(id, { ifMatch: '"1"', payload: { valid_until: iso(729), grace_until: iso(700), reason: REASON } });
      expect([grace.status, grace.json.code, grace.json.detail]).toEqual([422, 'LICENSE_RANGE_INVALID', 'grace_until']);
      const seats = await renew(id, { ifMatch: '"1"', payload: { valid_until: iso(729), grace_until: iso(759), seats: 0, reason: REASON } });
      expect(seats.status).toBe(422);
      expect((await licenseRow(id))?.status).toBe('Issued');
    });

    it('answers 409 LICENSE_STATE_INVALID for a license that is suspended, revoked or already replaced', async () => {
      const suspended = await issued();
      await suspend(suspended.id, { ifMatch: '"1"' });
      const onHold = await renew(suspended.id, { ifMatch: '"2"' });
      expect([onHold.status, onHold.json.code]).toEqual([409, 'LICENSE_STATE_INVALID']);
      const revoked = await issued();
      await revoke(revoked.id, { ifMatch: '"1"' });
      const gone = await renew(revoked.id, { ifMatch: '"2"' });
      expect([gone.status, gone.json.code]).toEqual([409, 'LICENSE_STATE_INVALID']);
      const replaced = await issued();
      expect((await renew(replaced.id, { ifMatch: '"1"' })).status).toBe(200);
      const twice = await renew(replaced.id, { ifMatch: '"2"' });
      expect([twice.status, twice.json.code]).toEqual([409, 'LICENSE_STATE_INVALID']);
    });

    it('answers 428 without If-Match, 409 VERSION_CONFLICT with the current version for a stale one, 404 for an unknown license and 422 for a short reason', async () => {
      const { id } = await issued();
      expect((await renew(id)).status).toBe(428);
      const stale = await renew(id, { ifMatch: '"7"' });
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', 1]);
      expect((await renew(randomUUID(), { ifMatch: '"1"' })).status).toBe(404);
      const short = await renew(id, { ifMatch: '"1"', payload: { valid_until: iso(729), grace_until: iso(759), reason: 'too short' } });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await licenseRow(id))?.status).toBe('Issued');
    });

    it('replays the same key with the stored answer and renews once', async () => {
      const { tenantId, id } = await issued();
      const key = `key-${randomUUID()}`;
      const payload = { valid_until: iso(729), grace_until: iso(759), reason: REASON };
      const first = await renew(id, { ifMatch: '"1"', key, payload });
      const second = await renew(id, { ifMatch: '"1"', key, payload });
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('idempotency-replayed')).toBe('true');
      expect(await licenseCount(tenantId)).toBe(2);
    });

    it('refuses a tenant-plane token with 403 SCOPE_DENIED and changes nothing', async () => {
      const { tenantId, id } = await issued();
      const reply = await renew(id, { ifMatch: '"1"', audience: 'tenant', roles: ['TENANT_ADMIN', 'SystemAdmin'] });
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await licenseRow(id))?.status).toBe('Issued');
      expect(await licenseCount(tenantId)).toBe(1);
    });
  });

  describe('getSystemLicense and listSystemTenantLicenses', () => {
    it('reads one license of any tenant with a signature check that is VALID, and never the signed claims', async () => {
      const { tenantId, versionId } = await activeTenant();
      const created = await issue(tenantId, versionId);
      const id = created.json.resource_id as string;
      const reply = await call('GET', `/system/licenses/${id}`);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ id, tenant_id: tenantId, edition: 'STANDARD', status: 'Active', seats: 50, key_id: KEY_ID, signature_check: 'VALID', version: 1 });
      expect(reply.json).not.toHaveProperty('signed_claims');
      expect(reply.json.expiring).toBe(false);
    });

    it('says CLAIMS_MISMATCH when the row was edited after it was signed, and 404 for an unknown id', async () => {
      const { tenantId, versionId } = await activeTenant();
      const id = (await issue(tenantId, versionId)).json.resource_id as string;
      await harness.admin((client) => client.query("update machvon.license_revision set edition = 'ENTERPRISE' where id = $1", [id]));
      expect((await call('GET', `/system/licenses/${id}`)).json.signature_check).toBe('CLAIMS_MISMATCH');
      expect((await call('GET', `/system/licenses/${randomUUID()}`)).status).toBe(404);
      expect((await call('GET', '/system/licenses/not-a-uuid')).status).toBe(422);
    });

    it('shows the suspension and its reason, and the state of the clock for the rest', async () => {
      const { tenantId, versionId } = await activeTenant();
      const id = (await issue(tenantId, versionId, { valid_from: iso(5), valid_until: iso(400), grace_until: iso(430) })).json.resource_id as string;
      expect((await call('GET', `/system/licenses/${id}`)).json.status).toBe('Scheduled');
      await suspend(id, { ifMatch: '"1"' });
      expect((await call('GET', `/system/licenses/${id}`)).json).toMatchObject({ status: 'Suspended', status_reason: REASON, version: 2 });
    });

    it('lists the revisions of one tenant in keyset pages, an empty page for a tenant without license, and 404 for an unknown tenant', async () => {
      const { tenantId, versionId } = await activeTenant();
      const first = (await issue(tenantId, versionId)).json.resource_id as string;
      const second = (await issue(tenantId, versionId, { valid_from: iso(500), valid_until: iso(600), grace_until: iso(630) })).json.resource_id as string;
      const page1 = await call('GET', `/system/tenants/${tenantId}/licenses?limit=1`);
      expect((page1.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([first]);
      expect(typeof page1.json.next_cursor).toBe('string');
      const page2 = await call('GET', `/system/tenants/${tenantId}/licenses?limit=1&cursor=${encodeURIComponent(page1.json.next_cursor as string)}`);
      expect((page2.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second]);
      expect(page2.json.next_cursor).toBeNull();
      const other = await activeTenant();
      expect((await call('GET', `/system/tenants/${other.tenantId}/licenses`)).json).toEqual({ items: [], next_cursor: null });
      expect((await call('GET', `/system/tenants/${randomUUID()}/licenses`)).status).toBe(404);
    });

    it('lets a platform operator read, and refuses a tenant-plane token and a support operator', async () => {
      const { tenantId, versionId } = await activeTenant();
      const id = (await issue(tenantId, versionId)).json.resource_id as string;
      for (const path of [`/system/licenses/${id}`, `/system/tenants/${tenantId}/licenses`]) {
        const tenantToken = await call('GET', path, { audience: 'tenant', roles: ['TENANT_ADMIN', 'SystemAdmin'] });
        expect([tenantToken.status, tenantToken.json.code]).toEqual([403, 'SCOPE_DENIED']);
        expect((await call('GET', path, { roles: ['PlatformOperator'] })).status).toBe(200);
        const support = await call('GET', path, { roles: ['SupportOperator'] });
        expect([support.status, support.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
    });
  });

  describe('who may', () => {
    it('refuses a tenant-plane token on both commands with 403 SCOPE_DENIED, whatever its roles (AC-ST-SAS-003-5)', async () => {
      const { tenantId, versionId } = await activeTenant();
      const issuing = await issue(tenantId, versionId, {}, { audience: 'tenant', roles: ['TENANT_ADMIN', 'SystemAdmin'] });
      expect([issuing.status, issuing.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const created = await issue(tenantId, versionId);
      const revoking = await revoke(created.json.resource_id as string, { ifMatch: '"1"', audience: 'tenant', roles: ['TENANT_ADMIN', 'SystemAdmin'] });
      expect([revoking.status, revoking.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await licenseRow(created.json.resource_id as string))?.status).toBe('Issued');
      expect(await licenseCount(tenantId)).toBe(1);
    });

    describe('generated matrix: every license operation against every realm role', () => {
      const operations = CONTROL_OPERATIONS.filter((operation) => operation.path.includes('licenses'));
      const cases = controlCasesFor(operations);

      it('lists the seven license operations of the registry', () => {
        expect(operations.map((operation) => operation.operationId).sort()).toEqual([
          'getSystemLicense',
          'listSystemTenantLicenses',
          'post_licenses',
          'post_licenses_id_revoke',
          'reinstateLicense',
          'renewLicense',
          'suspendLicense',
        ]);
      });

      it.each(cases.map((matrixCase) => [matrixCase.id, matrixCase] as const))('%s', async (_id, matrixCase) => {
        const operation = operations.find((candidate) => candidate.operationId === matrixCase.operationId);
        if (operation === undefined) throw new Error('operation of the case is not listed');
        const { tenantId, versionId } = await activeTenant();
        const needsLicense = operation.operationId !== 'post_licenses' && operation.operationId !== 'listSystemTenantLicenses';
        const existing = needsLicense ? ((await issue(tenantId, versionId)).json.resource_id as string) : undefined;
        // A reinstatement starts from a suspended license.
        if (operation.operationId === 'reinstateLicense' && existing !== undefined) await suspend(existing, { ifMatch: '"1"' });
        const startVersion = operation.operationId === 'reinstateLicense' ? '"2"' : '"1"';
        const startStatus = operation.operationId === 'reinstateLicense' ? 'Suspended' : 'Issued';
        const deniedBefore = await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`]);
        const roles = [matrixCase.role];
        let reply: Reply;
        if (operation.operationId === 'post_licenses') reply = await issue(tenantId, versionId, {}, { roles });
        else if (operation.operationId === 'post_licenses_id_revoke') reply = await revoke(existing ?? '', { ifMatch: startVersion, roles });
        else if (operation.operationId === 'renewLicense') reply = await renew(existing ?? '', { ifMatch: startVersion, roles });
        else if (operation.operationId === 'suspendLicense') reply = await suspend(existing ?? '', { ifMatch: startVersion, roles });
        else if (operation.operationId === 'reinstateLicense') reply = await reinstate(existing ?? '', { ifMatch: startVersion, roles });
        else if (operation.operationId === 'getSystemLicense') reply = await call('GET', `/system/licenses/${existing ?? ''}`, { roles });
        else reply = await call('GET', `/system/tenants/${tenantId}/licenses`, { roles });
        if (matrixCase.expected === 'allow') {
          expect(reply.status).toBeLessThan(300);
          return;
        }
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
        if (operation.method === 'POST') {
          expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`])).toBe(deniedBefore + 1);
        }
        if (existing === undefined) expect(await licenseCount(tenantId)).toBe(0);
        else expect((await licenseRow(existing))?.status).toBe(startStatus);
      });
    });
  });
});
