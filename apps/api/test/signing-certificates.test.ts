import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../src/command.module';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { SigningCertificateReadsController, SigningCertificatesController } from '../src/modules/adm/certificates.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { certificatePem } from '../../../packages/kernel/test/support/x509';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;
const DAY = 86_400_000;

// Members of tenant A.
const ADMIN = 1; // adm.signature.manage and read on the whole tenant
const READER = 2; // adm.signature.read on the whole tenant
const UNIT_ADMIN = 3; // manage and read on the subtree of unit 2 only
const NOBODY = 4; // no grant
const HOLDER = 5; // the person a personal certificate belongs to

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const validPem = (days = 365): string => certificatePem({ validFrom: new Date(Date.now() - 30 * DAY), validUntil: new Date(Date.now() + days * DAY), serial: 9 });

describe('signing certificate commands and reads (ST-ADM-008)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  async function call(
    method: 'GET' | 'POST',
    url: string,
    options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string },
  ): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const register = (member: number, pem: string = validPem(), extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', '/signing-certificates', {
      member,
      body: { kind: 'PERSONAL', holder_membership_id: memberId(HOLDER), certificate_pem: pem, provider_code: 'VNPT-CA', ...extra },
    });
  const revoke = (member: number, certificateId: string, ifMatch = '"1"'): Promise<Reply> =>
    call('POST', `/signing-certificates/${certificateId}/revoke`, { member, ifMatch, body: { reason: 'Key compromise reported by the holder' } });
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const countOf = async (sql: string, params: unknown[] = []): Promise<number> => Number((await harness.owner<{ n: string }>(TENANT_A, [[sql, params]]))[0]?.n);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: path(1) },
      { n: 2, path: path(1, 2), parent: 1 },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: path(1) }]);
    for (const n of [ADMIN, READER, UNIT_ADMIN, NOBODY, HOLDER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, 1, 1);
    await harness.seedRole(TENANT_A, 1, 'CERT_ADMIN', ['adm.signature.manage', 'adm.signature.read'], 60);
    await harness.seedRole(TENANT_A, 2, 'CERT_READER', ['adm.signature.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [SigningCertificatesController, SigningCertificateReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    await harness.owner(TENANT_A, [
      ['delete from machvon.signing_certificate', []],
      ["delete from machvon.audit_event where resource_type = 'signing_certificate'", []],
    ]);
  });

  describe('registerSigningCertificate', () => {
    it('registers a personal certificate from its public PEM, audits the fingerprint and announces it', async () => {
      const reply = await register(ADMIN);
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'REGISTERED', resource_version: 1 });
      const certificateId = idOf(reply);
      const stored = await harness.owner<{ status: string; certificate_serial: string; fingerprint_sha256: string }>(TENANT_A, [
        ['select status, certificate_serial, fingerprint_sha256 from machvon.signing_certificate where id = $1', [certificateId]],
      ]);
      expect(stored[0]).toMatchObject({ status: 'Active', certificate_serial: '09' });
      const audit = await harness.owner<{ safe_diff: Record<string, unknown>; outcome: string }>(TENANT_A, [
        ["select safe_diff, outcome from machvon.audit_event where action = 'signing_certificate.register' and resource_id = $1", [certificateId]],
      ]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff).toMatchObject({ fingerprint_sha256: stored[0]?.fingerprint_sha256, kind: 'PERSONAL' });
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('BEGIN CERTIFICATE');
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'adm.signing_certificate.registered.v1' and aggregate_id = $1", [certificateId])).toBe(1);
    });

    it('registers an organisation certificate for a unit of the tenant', async () => {
      const reply = await call('POST', '/signing-certificates', {
        member: ADMIN,
        body: { kind: 'ORGANIZATION', organization_unit_id: unitId(2), certificate_pem: validPem(), provider_code: 'VNPT-CA' },
      });
      expect(reply.status).toBe(201);
    });

    it('refuses a private key with 422 CERTIFICATE_INVALID, stores nothing and leaves no key text in the database, audit or outbox (AC-ST-ADM-008-1)', async () => {
      // The marker is written in two pieces so that a scan for committed keys does not mistake this dummy text for one.
      const key = '-----BEGIN PRIVATE' + ' KEY-----\nMC4CAQAwBQYDK2VwBCIEIPRIVATEKEYMATERIAL0123456789abcdefghijklmnop\n-----END PRIVATE KEY-----\n';
      const bundle = validPem() + key;
      for (const pem of [key, bundle]) {
        const reply = await register(ADMIN, pem);
        expect(reply.status).toBe(422);
        expect(reply.json.code).toBe('CERTIFICATE_INVALID');
        expect(JSON.stringify(reply.json)).not.toContain('PRIVATEKEYMATERIAL');
      }
      expect(await countOf('select count(*) as n from machvon.signing_certificate')).toBe(0);
      expect(await countOf("select count(*) as n from machvon.audit_event where safe_diff::text ilike '%PRIVATEKEYMATERIAL%' or safe_diff::text ilike '%PRIVATE KEY%'")).toBe(0);
      expect(await countOf("select count(*) as n from machvon.outbox_event where payload::text ilike '%PRIVATEKEYMATERIAL%'")).toBe(0);
      expect(await countOf("select count(*) as n from machvon.idempotency_record where response_ref::text ilike '%PRIVATEKEYMATERIAL%'")).toBe(0);
    });

    it('refuses an expired certificate with 422 CERTIFICATE_EXPIRED and text that is not a certificate with 422 CERTIFICATE_INVALID (AC-ST-ADM-008-1)', async () => {
      const expired = await register(ADMIN, certificatePem({ validFrom: new Date(Date.now() - 400 * DAY), validUntil: new Date(Date.now() - DAY) }));
      expect(expired.status).toBe(422);
      expect(expired.json.code).toBe('CERTIFICATE_EXPIRED');
      const garbage = await register(ADMIN, 'this is not a certificate at all');
      expect(garbage.status).toBe(422);
      expect(garbage.json.code).toBe('CERTIFICATE_INVALID');
      expect(await countOf('select count(*) as n from machvon.signing_certificate')).toBe(0);
    });

    it('refuses the same certificate twice with 409 CERTIFICATE_DUPLICATE (AC-ST-ADM-008-1)', async () => {
      const pem = validPem();
      expect((await register(ADMIN, pem)).status).toBe(201);
      const second = await register(ADMIN, pem);
      expect(second.status).toBe(409);
      expect(second.json.code).toBe('CERTIFICATE_DUPLICATE');
      expect(await countOf('select count(*) as n from machvon.signing_certificate')).toBe(1);
    });

    it('refuses a holder or a unit that does not exist in the tenant, and a holder of another tenant, with 422', async () => {
      const missing = await register(ADMIN, validPem(), { holder_membership_id: memberId(99) });
      expect(missing.status).toBe(422);
      const foreign = await register(ADMIN, validPem(), { holder_membership_id: memberId(1), kind: 'ORGANIZATION', organization_unit_id: unitId(77) });
      expect(foreign.status).toBe(422);
      expect(await countOf('select count(*) as n from machvon.signing_certificate')).toBe(0);
    });

    it('refuses a caller without the permission, one who can only read and one whose authority covers a unit subtree (audited as DENIED)', async () => {
      expect((await register(NOBODY)).status).toBe(403);
      expect((await register(READER)).status).toBe(403);
      const unitAdmin = await register(UNIT_ADMIN);
      expect(unitAdmin.status).toBe(403);
      expect(unitAdmin.json.code).toBe('SCOPE_DENIED');
      expect(await countOf("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action like '%registerSigningCertificate%'")).toBeGreaterThanOrEqual(1);
      expect(await countOf('select count(*) as n from machvon.signing_certificate')).toBe(0);
    });
  });

  describe('revokeSigningCertificate', () => {
    it('revokes with the reason, bumps the version, audits and announces it', async () => {
      const certificateId = idOf(await register(ADMIN));
      const reply = await revoke(ADMIN, certificateId);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'REVOKED', resource_version: 2 });
      expect((await call('GET', `/resources/signing_certificate/${certificateId}`, { member: ADMIN })).json).toMatchObject({ status: 'Revoked', status_reason: 'Key compromise reported by the holder', version: 2 });
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'adm.signing_certificate.revoked.v1' and aggregate_id = $1", [certificateId])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'signing_certificate.revoke' and resource_id = $1", [certificateId])).toBe(1);
    });

    it('answers 409 STAGE_TRANSITION_DENIED for a second revocation, 409 VERSION_CONFLICT for a stale version and 404 for an unknown certificate', async () => {
      const certificateId = idOf(await register(ADMIN));
      const stale = await revoke(ADMIN, certificateId, '"9"');
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      expect((await revoke(ADMIN, certificateId)).status).toBe(200);
      const again = await revoke(ADMIN, certificateId, '"2"');
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('STAGE_TRANSITION_DENIED');
      expect((await revoke(ADMIN, randomUUID())).status).toBe(404);
    });

    it('refuses a revocation by a caller without manage authority on the whole tenant', async () => {
      const certificateId = idOf(await register(ADMIN));
      expect((await revoke(READER, certificateId)).status).toBe(403);
      expect((await revoke(UNIT_ADMIN, certificateId)).status).toBe(403);
      expect((await call('GET', `/resources/signing_certificate/${certificateId}`, { member: ADMIN })).json.status).toBe('Active');
    });
  });

  describe('reads', () => {
    it('lists the certificates that end soonest first and pages with a cursor', async () => {
      const far = idOf(await register(ADMIN, validPem(300)));
      const near = idOf(await register(ADMIN, validPem(20)));
      const middle = idOf(await register(ADMIN, validPem(100)));
      const page = await call('GET', '/resources/signing_certificate?limit=2', { member: READER });
      expect(page.status).toBe(200);
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([near, middle]);
      expect(typeof page.json.next_cursor).toBe('string');
      const rest = await call('GET', `/resources/signing_certificate?limit=2&cursor=${encodeURIComponent(page.json.next_cursor as string)}`, { member: READER });
      expect((rest.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([far]);
      expect(rest.json.next_cursor).toBeNull();
    });

    it('shows public facts only: no PEM, no key field', async () => {
      const certificateId = idOf(await register(ADMIN));
      const view = (await call('GET', `/resources/signing_certificate/${certificateId}`, { member: READER })).json;
      expect(view).toMatchObject({ kind: 'PERSONAL', holder_membership_id: memberId(HOLDER), certificate_serial: '09', provider_code: 'VNPT-CA', status: 'Active' });
      expect(Object.keys(view).filter((key) => /pem|private|key_material|secret/.test(key))).toEqual([]);
      expect(JSON.stringify(view)).not.toContain('BEGIN');
    });

    it('shows nothing to a caller who holds the read permission only on a subtree, refuses one without it, and shows nothing of another tenant', async () => {
      const certificateId = idOf(await register(ADMIN));
      expect((await call('GET', '/resources/signing_certificate', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/resources/signing_certificate', { member: UNIT_ADMIN })).json.items).toEqual([]);
      expect((await call('GET', `/resources/signing_certificate/${certificateId}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/resources/signing_certificate/${certificateId}`, { member: UNIT_ADMIN })).status).toBe(404);
      expect([403, 404]).toContain((await call('GET', `/resources/signing_certificate/${certificateId}`, { member: 1, tenantId: TENANT_B })).status);
    });

    it('reports an Active certificate whose validity has ended as Expired', async () => {
      const certificateId = idOf(await register(ADMIN, validPem(1)));
      await harness.owner(TENANT_A, [["alter table machvon.signing_certificate disable trigger signing_certificate_guard", []], ["update machvon.signing_certificate set valid_until = now() - interval '1 minute' where id = $1", [certificateId]], ['alter table machvon.signing_certificate enable trigger signing_certificate_guard', []]]);
      expect((await call('GET', `/resources/signing_certificate/${certificateId}`, { member: ADMIN })).json.status).toBe('Expired');
    });
  });
});
