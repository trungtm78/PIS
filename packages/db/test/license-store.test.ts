import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { STANDARD_FEATURES } from '@machvon/kernel';
import type { LicenseSigner } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import type { PoolClient } from 'pg';
import { AuditWriter } from '../src/audit-writer';
import { ControlDatabase, PLATFORM_TENANT_ID } from '../src/control-database';
import { InMemoryEntitlementCache } from '../src/entitlement-cache';
import { EntitlementStore } from '../src/entitlement-store';
import { LicenseStatusJob, nextLicenseStatus } from '../src/license-status-job';
import { LicenseStore } from '../src/license-store';
import type { IssueLicenseInput, LicenseRow, RenewLicenseInput, RenewedLicense } from '../src/license-store';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import { TenantDatabase } from '../src/tenant-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PLACEMENT = '00000000-0000-4000-8000-0000000000b8';
const PLAN = '00000000-0000-4000-9000-000000000001';
const ACTOR = '00000000-0000-4000-8000-0000000000c9';
const NOW = new Date('2026-10-23T03:00:00Z');
const FROM = new Date('2026-10-01T00:00:00Z');
const UNTIL = new Date('2027-10-01T00:00:00Z');
const GRACE = new Date('2027-10-31T00:00:00Z');
const REASON = 'The contract was terminated by the agency.';
let counter = 0;

describe('licenses in the control plane (ST-SAS-003)', () => {
  let database: TestDatabase;
  let controlPool: Pool;
  let appPool: Pool;
  let control: ControlDatabase;
  let tenants: TenantDatabase;
  let entitlements: EntitlementStore;
  let store: LicenseStore;
  const pair = generateKeyPairSync('ed25519');
  const privateKeyBase64 = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKeyDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  const signer: LicenseSigner = { keyId: 'kid-2026', sign: (payload) => Promise.resolve(sign(null, payload, pair.privateKey)) };
  const keys = new Map([['kid-2026', publicKeyDer]]);

  async function asAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: database.adminUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  async function seedTenant(status = 'Active'): Promise<{ tenantId: string; versionId: string }> {
    counter += 1;
    const tenantId = `00000000-0000-4000-8000-${(0xe000 + counter).toString(16).padStart(12, '0')}`;
    await asAdmin((client) =>
      client.query("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, $3, $4, 'vn-north')", [tenantId, `license-${counter}`, status, PLACEMENT]),
    );
    await tenants.withTenant({ tenantId, membershipId: ACTOR, scopeVersion: 1 }, (tx) =>
      entitlements.record(tx, { cause: 'PROVISIONING', planVersionId: PLAN, features: STANDARD_FEATURES }),
    );
    const rows = await asAdmin((client) => client.query<{ id: string }>('select id from machvon.entitlement_version where tenant_id = $1 and version_no = 1', [tenantId]));
    return { tenantId, versionId: rows.rows[0]?.id ?? '' };
  }

  const input = (tenantId: string, versionId: string, overrides: Partial<IssueLicenseInput> = {}): IssueLicenseInput => ({
    tenantId,
    edition: 'STANDARD',
    validFrom: FROM,
    validUntil: UNTIL,
    graceUntil: GRACE,
    entitlementVersionId: versionId,
    seats: 50,
    quota: { storage_gb: 100 },
    issuedBy: ACTOR,
    restoreTenantId: PLATFORM_TENANT_ID,
    ...overrides,
  });

  const issue = (
    tenantId: string,
    versionId: string,
    overrides: Partial<IssueLicenseInput> = {},
    whileActing: (license: LicenseRow) => Promise<void> = () => Promise.resolve(),
    signerOf: () => Promise<LicenseSigner> = () => Promise.resolve(signer),
  ): Promise<LicenseRow> => control.withTenantOf(PLATFORM_TENANT_ID, (tx) => store.issue(tx, input(tenantId, versionId, overrides), signerOf, whileActing, NOW));

  const revoke = (licenseId: string, expectedVersion: number, reason = REASON, whileActing: (license: LicenseRow) => Promise<void> = () => Promise.resolve()): Promise<LicenseRow> =>
    control.withTenantOf(PLATFORM_TENANT_ID, (tx) => store.revoke(tx, { licenseId, reason, expectedVersion, restoreTenantId: PLATFORM_TENANT_ID }, whileActing));

  const licensesOf = (tenantId: string): Promise<LicenseRow[]> => tenants.withTenant({ tenantId, membershipId: ACTOR, scopeVersion: 1 }, (tx) => store.list(tx, { limit: 50, after: undefined }));
  const versionCount = async (tenantId: string): Promise<number> =>
    Number((await asAdmin((client) => client.query<{ n: string }>('select count(*) as n from machvon.entitlement_version where tenant_id = $1', [tenantId]))).rows[0]?.n);

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    controlPool = new Pool({ connectionString: database.urlFor('machvon_control'), max: 6 });
    controlPool.on('error', () => undefined);
    appPool = new Pool({ connectionString: database.urlFor('machvon_app'), max: 4 });
    appPool.on('error', () => undefined);
    control = new ControlDatabase(controlPool);
    tenants = new TenantDatabase(appPool);
    entitlements = new EntitlementStore(tenants, new InMemoryEntitlementCache());
    store = new LicenseStore(entitlements);
    await asAdmin((client) =>
      client.query("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'north-8', 'kms-8', 'Active')", [PLACEMENT]),
    );
    const registered = await control.withControl((tx) =>
      store.registerSigningKey(tx, {
        keyId: 'kid-2026',
        publicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        kmsKeyRef: 'env:LICENSE_SIGNING_KEY_PEM_PATH',
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2028-01-01T00:00:00Z'),
      }),
    );
    expect(registered).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([controlPool?.end(), appPool?.end()]);
    if (database) await database.stop();
  }, 60_000);

  describe('issuing', () => {
    it('stores revision 1 as Issued, signed with the active key, and records a new entitlement version for the tenant', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      expect(license).toMatchObject({ tenantId, revision: 1, edition: 'STANDARD', status: 'Issued', seats: 50, quota: { storage_gb: 100 }, keyId: 'kid-2026', version: 1, issuer: 'machvon-platform', issuedBy: ACTOR });
      expect(license.serial).toMatch(/^LIC-20261023-0001$/);
      expect(license.validFrom).toEqual(FROM);
      expect(license.validUntil).toEqual(UNTIL);
      expect(license.graceUntil).toEqual(GRACE);
      expect(store.verifySignature(license, keys)).toBe('VALID');
      expect(await versionCount(tenantId)).toBe(2);
      const recorded = await asAdmin((client) => client.query<{ cause: string }>('select cause from machvon.entitlement_version where tenant_id = $1 and version_no = 2', [tenantId]));
      expect(recorded.rows[0]?.cause).toBe('LICENSE_CHANGE');
      expect(await asAdmin((client) => client.query("select 1 from machvon.outbox_event where tenant_id = $1 and type = 'sas.entitlement.changed.v1' and (payload->>'version_no')::int = 2", [tenantId]))).toMatchObject({ rowCount: 1 });
    });

    it('signs the entitlement hash of the version named, the window, the seats and the quota, and the claims name no secret', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId, { deploymentBinding: 'cluster-north-1' });
      const claims = JSON.parse(Buffer.from(license.signedClaims.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
      const hash = (await asAdmin((client) => client.query<{ entitlements_hash: string }>('select entitlements_hash from machvon.entitlement_version where id = $1', [versionId]))).rows[0]?.entitlements_hash;
      expect(claims).toMatchObject({
        iss: 'machvon-platform',
        tenant_id: tenantId,
        license_id: license.id,
        serial: license.serial,
        revision: 1,
        edition: 'STANDARD',
        valid_from: FROM.toISOString(),
        valid_until: UNTIL.toISOString(),
        grace_until: GRACE.toISOString(),
        entitlements_hash: hash,
        seats: 50,
        quota: { storage_gb: 100 },
        deployment_binding: 'cluster-north-1',
        kid: 'kid-2026',
      });
      expect(JSON.stringify(claims)).not.toContain(privateKeyBase64);
    });

    it('keeps the private key out of every table it touched', async () => {
      const { tenantId, versionId } = await seedTenant();
      await issue(tenantId, versionId);
      const dump = await asAdmin(async (client) => {
        const revisions = await client.query<{ doc: string }>('select to_jsonb(l)::text as doc from machvon.license_revision l');
        const signingKeys = await client.query<{ doc: string }>('select to_jsonb(k)::text as doc from machvon.license_signing_key k');
        const events = await client.query<{ doc: string }>('select to_jsonb(e)::text as doc from machvon.outbox_event e');
        return [...revisions.rows, ...signingKeys.rows, ...events.rows].map((row) => row.doc).join('\n');
      });
      expect(dump).not.toContain(privateKeyBase64);
      expect(dump).not.toContain('PRIVATE KEY');
    });

    it('fails verification after one byte of the signed payload changes, and after the row is edited (AC-ST-SAS-003-8)', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      const [header, payload, signature] = license.signedClaims.split('.') as [string, string, string];
      const flipped = Buffer.from(payload, 'base64url');
      flipped[10] = (flipped[10] ?? 0) ^ 0x01;
      expect(store.verifySignature({ ...license, signedClaims: `${header}.${flipped.toString('base64url')}.${signature}` }, keys)).not.toBe('VALID');
      expect(store.verifySignature({ ...license, validUntil: new Date(UNTIL.getTime() + 86_400_000) }, keys)).toBe('CLAIMS_MISMATCH');
      expect(store.verifySignature({ ...license, tenantId: PLATFORM_TENANT_ID }, keys)).toBe('CLAIMS_MISMATCH');
      expect(store.verifySignature(license, new Map())).toBe('UNKNOWN_KEY');
      expect(store.verifySignature({ ...license, signedClaims: 'garbage' }, keys)).toBe('MALFORMED');
    });

    it('fails verification when the seats, the quota, the binding, the offline lease or the issuer of the row differ from the signed claims', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId, { edition: 'PRIVATE', seats: 5, quota: { storage_gb: 100, projects: 3 }, deploymentBinding: 'cluster-a', offlineLeaseDays: 10 });
      expect(store.verifySignature(license, keys)).toBe('VALID');
      // The database hands the quota back with its keys in its own order; the same members are still the same quota.
      expect(store.verifySignature({ ...license, quota: { projects: 3, storage_gb: 100 } }, keys)).toBe('VALID');
      expect(store.verifySignature({ ...license, seats: 5000 }, keys)).toBe('CLAIMS_MISMATCH');
      expect(store.verifySignature({ ...license, seats: null }, keys)).toBe('CLAIMS_MISMATCH');
      expect(store.verifySignature({ ...license, quota: { storage_gb: 100_000, projects: 3 } }, keys)).toBe('CLAIMS_MISMATCH');
      expect(store.verifySignature({ ...license, deploymentBinding: 'cluster-b' }, keys)).toBe('CLAIMS_MISMATCH');
      expect(store.verifySignature({ ...license, deploymentBinding: null }, keys)).toBe('CLAIMS_MISMATCH');
      expect(store.verifySignature({ ...license, offlineLeaseUntil: new Date((license.offlineLeaseUntil?.getTime() ?? 0) + 86_400_000) }, keys)).toBe('CLAIMS_MISMATCH');
      expect(store.verifySignature({ ...license, offlineLeaseUntil: null }, keys)).toBe('CLAIMS_MISMATCH');
      expect(store.verifySignature({ ...license, issuer: 'someone-else' }, keys)).toBe('CLAIMS_MISMATCH');
    });

    it('signs the tenant id in the form the database stores, so a request in capitals still verifies', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId.toUpperCase(), versionId);
      expect(license.tenantId).toBe(tenantId);
      expect(store.verifySignature(license, keys)).toBe('VALID');
    });

    it('acts as the tenant while the hook runs and returns to the platform tenant afterwards', async () => {
      const { tenantId, versionId } = await seedTenant();
      const seen: string[] = [];
      await control.withTenantOf(PLATFORM_TENANT_ID, async (tx) => {
        const current = async (): Promise<string> => (await tx.query<{ tenant: string }>("select current_setting('app.tenant_id') as tenant"))[0]?.tenant ?? '';
        await store.issue(tx, input(tenantId, versionId), () => Promise.resolve(signer), async () => void seen.push(await current()), NOW);
        seen.push(await current());
      });
      expect(seen).toEqual([tenantId, PLATFORM_TENANT_ID]);
    });

    it.each([
      ['valid_from equal to valid_until', { validFrom: UNTIL }, 'valid_until'],
      ['valid_from after valid_until', { validFrom: new Date('2028-01-01T00:00:00Z') }, 'valid_until'],
      ['grace_until before valid_until', { graceUntil: new Date('2027-09-30T00:00:00Z') }, 'grace_until'],
      ['a window that ended already', { validFrom: new Date('2025-01-01T00:00:00Z'), validUntil: new Date('2026-10-22T00:00:00Z'), graceUntil: new Date('2026-10-22T00:00:00Z') }, 'valid_until'],
      ['an offline lease on a license that is not PRIVATE', { offlineLeaseDays: 10 }, 'offline_lease_days'],
      ['an offline lease of more than 30 days', { edition: 'PRIVATE', offlineLeaseDays: 31 }, 'offline_lease_days'],
      ['an offline lease that outlives the grace period', { edition: 'PRIVATE', offlineLeaseDays: 30, validUntil: new Date('2026-10-28T00:00:00Z'), graceUntil: new Date('2026-11-05T00:00:00Z') }, 'offline_lease_days'],
    ] as const)('refuses %s with 422 LICENSE_RANGE_INVALID on %s and stores nothing', async (_label, overrides, field) => {
      const { tenantId, versionId } = await seedTenant();
      await expect(issue(tenantId, versionId, overrides as Partial<IssueLicenseInput>)).rejects.toMatchObject({ code: 'LICENSE_RANGE_INVALID', status: 422, detail: field });
      expect(await licensesOf(tenantId)).toHaveLength(0);
      expect(await versionCount(tenantId)).toBe(1);
    });

    it('refuses fewer than one seat (AC-ST-SAS-003-7)', async () => {
      const { tenantId, versionId } = await seedTenant();
      await expect(issue(tenantId, versionId, { seats: 0 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'seats' });
    });

    it('accepts a private deployment with an offline lease inside the grace period', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId, { edition: 'PRIVATE', offlineLeaseDays: 30, deploymentBinding: 'site-1' });
      expect(license.offlineLeaseUntil).toEqual(new Date(NOW.getTime() + 30 * 86_400_000));
      expect(license.deploymentBinding).toBe('site-1');
    });

    it('refuses a window that overlaps a revision that is not revoked, and accepts the window right after it and one after a revocation', async () => {
      const { tenantId, versionId } = await seedTenant();
      const first = await issue(tenantId, versionId);
      await expect(issue(tenantId, versionId, { validFrom: new Date('2027-06-01T00:00:00Z'), validUntil: new Date('2028-06-01T00:00:00Z'), graceUntil: new Date('2028-06-30T00:00:00Z') })).rejects.toMatchObject({
        code: 'LICENSE_RANGE_INVALID',
        detail: 'valid_from',
      });
      await expect(issue(tenantId, versionId, { validFrom: new Date('2026-09-01T00:00:00Z'), validUntil: new Date('2026-10-02T00:00:00Z'), graceUntil: new Date('2026-10-02T00:00:00Z') })).rejects.toMatchObject({ code: 'LICENSE_RANGE_INVALID' });
      const next = await issue(tenantId, versionId, { validFrom: UNTIL, validUntil: new Date('2028-10-01T00:00:00Z'), graceUntil: new Date('2028-10-31T00:00:00Z') });
      expect(next.serial).not.toBe(first.serial);
      await revoke(next.id, 1);
      await revoke(first.id, 1);
      const again = await issue(tenantId, versionId);
      expect(again.status).toBe('Issued');
      expect((await licensesOf(tenantId)).map((license) => license.status).sort()).toEqual(['Issued', 'Revoked', 'Revoked']);
    });

    it('lets exactly one of two concurrent issues for the same window win', async () => {
      const { tenantId, versionId } = await seedTenant();
      const results = await Promise.allSettled([issue(tenantId, versionId), issue(tenantId, versionId)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'LICENSE_RANGE_INVALID' } });
      expect(await licensesOf(tenantId)).toHaveLength(1);
    });

    it('refuses the entitlement version of another tenant, and one that does not exist, with 422 LICENSE_TENANT_MISMATCH', async () => {
      const a = await seedTenant();
      const b = await seedTenant();
      await expect(issue(a.tenantId, b.versionId)).rejects.toMatchObject({ code: 'LICENSE_TENANT_MISMATCH', status: 422, detail: 'entitlement_version_id' });
      await expect(issue(a.tenantId, randomUUID())).rejects.toMatchObject({ code: 'LICENSE_TENANT_MISMATCH', status: 422 });
      expect(await licensesOf(a.tenantId)).toHaveLength(0);
      expect(await licensesOf(b.tenantId)).toHaveLength(0);
    });

    it.each(['Requested', 'Archived'])('refuses a %s tenant with 409 TENANT_STATE_INVALID', async (status) => {
      const { tenantId, versionId } = await seedTenant(status);
      await expect(issue(tenantId, versionId)).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID', status: 409 });
    });

    it.each(['Provisioning', 'Active', 'Suspended', 'Offboarding'])('issues for a %s tenant', async (status) => {
      const { tenantId, versionId } = await seedTenant(status);
      expect((await issue(tenantId, versionId)).status).toBe('Issued');
    });

    it('answers 404 for a tenant that does not exist', async () => {
      await expect(issue('00000000-0000-4000-8000-00000000f999', randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it.each([
      ['a key that is not registered', { keyId: 'kid-unknown' }],
      ['a key outside its window', { keyId: 'kid-expired' }],
      ['a retiring key', { keyId: 'kid-retiring' }],
    ])('refuses %s with 503 SIGNING_KEY_UNAVAILABLE and stores nothing', async (_label, patch) => {
      await asAdmin(async (client) => {
        await client.query(
          `insert into machvon.license_signing_key (id, algorithm, public_key_pem, kms_key_ref, status, not_before, not_after) values
             ('kid-expired', 'EdDSA', 'pem', 'ref', 'Active', '2020-01-01', '2021-01-01'), ('kid-retiring', 'EdDSA', 'pem', 'ref', 'Retiring', '2026-01-01', '2028-01-01')
           on conflict do nothing`,
        );
      });
      const { tenantId, versionId } = await seedTenant();
      await expect(issue(tenantId, versionId, {}, undefined, () => Promise.resolve({ ...signer, ...patch }))).rejects.toMatchObject({ code: 'SIGNING_KEY_UNAVAILABLE', status: 503 });
      expect(await licensesOf(tenantId)).toHaveLength(0);
      expect(await versionCount(tenantId)).toBe(1);
    });

    it('does not ask for the signing key when an earlier check already refused, and passes on the refusal of the key store', async () => {
      const { tenantId, versionId } = await seedTenant();
      let asked = 0;
      const missing = (): Promise<LicenseSigner> => {
        asked += 1;
        return Promise.reject(Object.assign(new Error('no key'), { code: 'SIGNING_KEY_UNAVAILABLE' }));
      };
      await expect(issue(tenantId, versionId, { validFrom: UNTIL }, undefined, missing)).rejects.toMatchObject({ code: 'LICENSE_RANGE_INVALID' });
      expect(asked).toBe(0);
      await expect(issue(tenantId, versionId, {}, undefined, missing)).rejects.toThrow('no key');
      expect(asked).toBe(1);
    });

    it('rolls everything back when the hook fails', async () => {
      const { tenantId, versionId } = await seedTenant();
      await expect(issue(tenantId, versionId, {}, () => Promise.reject(new Error('audit failed')))).rejects.toThrow('audit failed');
      expect(await licensesOf(tenantId)).toHaveLength(0);
      expect(await versionCount(tenantId)).toBe(1);
    });
  });

  describe('revoking', () => {
    it('ends the license: status Revoked, the reason and a new version, a new entitlement version, and the hook saw the revoked row', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      const seen: LicenseRow[] = [];
      const revoked = await revoke(license.id, 1, `  ${REASON}  `, (row) => Promise.resolve(void seen.push(row)));
      expect(revoked).toMatchObject({ id: license.id, status: 'Revoked', statusReason: REASON, version: 2, revision: 1 });
      expect(seen).toHaveLength(1);
      expect(store.statusAt(revoked, new Date('2027-03-01T00:00:00Z'))).toBe('Revoked');
      expect(await versionCount(tenantId)).toBe(3);
      // The signed claims were not touched: the signature of a revoked license still verifies.
      expect(store.verifySignature(revoked, keys)).toBe('VALID');
    });

    it('refuses a second revocation, a draft and a superseded license with 409 LICENSE_STATE_INVALID', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      await revoke(license.id, 1);
      await expect(revoke(license.id, 2)).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID', status: 409 });
      for (const status of ['Superseded', 'Draft', 'Expired']) {
        const other = await seedTenant();
        const row = await issue(other.tenantId, other.versionId);
        await asAdmin((client) => client.query('update machvon.license_revision set status = $1 where id = $2', [status, row.id]));
        await expect(revoke(row.id, 1)).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID', status: 409 });
      }
    });

    it('revokes a license that is Active, in Grace or Suspended', async () => {
      for (const status of ['Active', 'Grace', 'Suspended']) {
        const { tenantId, versionId } = await seedTenant();
        const row = await issue(tenantId, versionId);
        await asAdmin((client) => client.query("update machvon.license_revision set status = $1, status_reason = 'Suspended for the review of the contract.' where id = $2", [status, row.id]));
        expect((await revoke(row.id, 1)).status).toBe('Revoked');
      }
    });

    it('refuses a stale version with 409 VERSION_CONFLICT that names the current one', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      await expect(revoke(license.id, 7)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      expect((await licensesOf(tenantId))[0]?.status).toBe('Issued');
    });

    it('answers 404 for a license that does not exist and 422 for a reason that is too short', async () => {
      await expect(revoke(randomUUID(), 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      await expect(revoke(license.id, 1, '          ')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      await expect(revoke(license.id, 1, 'too short')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    });

    it('lets exactly one of two concurrent revocations win', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      const results = await Promise.allSettled([revoke(license.id, 1), revoke(license.id, 1)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    });

    it('rolls the revocation back when the hook fails', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      await expect(revoke(license.id, 1, REASON, () => Promise.reject(new Error('audit failed')))).rejects.toThrow('audit failed');
      expect((await licensesOf(tenantId))[0]).toMatchObject({ status: 'Issued', version: 1 });
    });
  });

  describe('suspending and reinstating', () => {
    const suspend = (licenseId: string, expectedVersion: number, reason = REASON, whileActing: (license: LicenseRow) => Promise<void> = () => Promise.resolve(), now = NOW): Promise<LicenseRow> =>
      control.withTenantOf(PLATFORM_TENANT_ID, (tx) => store.suspend(tx, { licenseId, reason, expectedVersion, restoreTenantId: PLATFORM_TENANT_ID }, whileActing, now));
    const reinstate = (licenseId: string, expectedVersion: number, reason = REASON, whileActing: (license: LicenseRow) => Promise<void> = () => Promise.resolve(), now = NOW): Promise<LicenseRow> =>
      control.withTenantOf(PLATFORM_TENANT_ID, (tx) => store.reinstate(tx, { licenseId, reason, expectedVersion, restoreTenantId: PLATFORM_TENANT_ID }, whileActing, now));

    it('suspends a live license with the reason, a new version and a new entitlement version, and the hook saw the suspended row', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      const seen: LicenseRow[] = [];
      const suspended = await suspend(license.id, 1, `  ${REASON}  `, (row) => Promise.resolve(void seen.push(row)));
      expect(suspended).toMatchObject({ id: license.id, status: 'Suspended', statusReason: REASON, version: 2 });
      expect(seen.map((row) => row.status)).toEqual(['Suspended']);
      expect(await versionCount(tenantId)).toBe(3);
      // The signed claims were not touched.
      expect(store.verifySignature(suspended, keys)).toBe('VALID');
    });

    it('suspends a license that is Active or in Grace, and refuses one that is already suspended, revoked, a draft, superseded or past its grace period', async () => {
      for (const status of ['Active', 'Grace']) {
        const { tenantId, versionId } = await seedTenant();
        const row = await issue(tenantId, versionId);
        await asAdmin((client) => client.query('update machvon.license_revision set status = $1 where id = $2', [status, row.id]));
        expect((await suspend(row.id, 1)).status).toBe('Suspended');
      }
      for (const status of ['Suspended', 'Revoked', 'Draft', 'Superseded']) {
        const { tenantId, versionId } = await seedTenant();
        const row = await issue(tenantId, versionId);
        await asAdmin((client) => client.query("update machvon.license_revision set status = $1, status_reason = 'Set for the review of the contract.' where id = $2", [status, row.id]));
        await expect(suspend(row.id, 1)).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID', status: 409 });
      }
      const ended = await seedTenant();
      const row = await issue(ended.tenantId, ended.versionId);
      await expect(suspend(row.id, 1, REASON, () => Promise.resolve(), new Date('2028-01-01T00:00:00Z'))).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID', status: 409 });
    });

    it('reinstates a suspended license to the state of the clock and records the reason in a new version', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      await suspend(license.id, 1);
      const context = { tenantId, membershipId: ACTOR, scopeVersion: 1 };
      expect((await entitlements.allowedFromDatabase(context, 'reporting', 'read')).allowed).toBe(false);
      const seen: LicenseRow[] = [];
      const reinstated = await reinstate(license.id, 2, `  ${REASON}  `, (row) => Promise.resolve(void seen.push(row)));
      expect(reinstated).toMatchObject({ status: 'Active', statusReason: null, version: 3 });
      expect(seen).toHaveLength(1);
      expect(store.statusAt(reinstated, NOW)).toBe('Active');
      expect(await versionCount(tenantId)).toBe(4);
      expect((await entitlements.allowedFromDatabase(context, 'reporting', 'read')).allowed).toBe(true);
    });

    it('reinstates a license that has not started as Issued, and one past its grace period as Expired by the clock', async () => {
      const early = await seedTenant();
      const scheduled = await issue(early.tenantId, early.versionId, { validFrom: new Date('2026-12-01T00:00:00Z') });
      await suspend(scheduled.id, 1);
      const back = await reinstate(scheduled.id, 2);
      expect(back.status).toBe('Issued');
      expect(store.statusAt(back, NOW)).toBe('Scheduled');
      const late = await seedTenant();
      const row = await issue(late.tenantId, late.versionId);
      await suspend(row.id, 1);
      const later = await reinstate(row.id, 2, REASON, () => Promise.resolve(), new Date('2028-01-01T00:00:00Z'));
      expect(store.statusAt(later, new Date('2028-01-01T00:00:00Z'))).toBe('Expired');
    });

    it('refuses to reinstate a license that is not suspended: live, revoked (for good), superseded or a draft', async () => {
      const { tenantId, versionId } = await seedTenant();
      const live = await issue(tenantId, versionId);
      await expect(reinstate(live.id, 1)).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID', status: 409 });
      for (const status of ['Revoked', 'Superseded', 'Draft']) {
        const other = await seedTenant();
        const row = await issue(other.tenantId, other.versionId);
        await asAdmin((client) => client.query("update machvon.license_revision set status = $1, status_reason = 'Set for the review of the contract.' where id = $2", [status, row.id]));
        await expect(reinstate(row.id, 1)).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID', status: 409 });
      }
    });

    it('refuses a stale version, an unknown license and a reason that is too short, for both transitions', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      await expect(suspend(license.id, 7)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      await expect(suspend(randomUUID(), 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await expect(suspend(license.id, 1, 'too short')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      await suspend(license.id, 1);
      await expect(reinstate(license.id, 1)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 2 } });
      await expect(reinstate(randomUUID(), 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await expect(reinstate(license.id, 2, '          ')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect((await licensesOf(tenantId))[0]).toMatchObject({ status: 'Suspended', version: 2 });
    });

    it('lets exactly one of two concurrent suspensions win, and rolls a transition back when the hook fails', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      const results = await Promise.allSettled([suspend(license.id, 1), suspend(license.id, 1)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
      await expect(reinstate(license.id, 2, REASON, () => Promise.reject(new Error('audit failed')))).rejects.toThrow('audit failed');
      expect((await licensesOf(tenantId))[0]).toMatchObject({ status: 'Suspended', version: 2 });
    });

    it('revokes a suspended license and keeps a revoked one revoked', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      await suspend(license.id, 1);
      expect((await revoke(license.id, 2)).status).toBe('Revoked');
      await expect(reinstate(license.id, 3)).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID', status: 409 });
    });
  });

  describe('renewing (ST-SAS-014)', () => {
    const NEW_UNTIL = new Date('2028-10-01T00:00:00Z');
    const NEW_GRACE = new Date('2028-10-31T00:00:00Z');
    const renew = (
      licenseId: string,
      expectedVersion: number,
      overrides: Partial<RenewLicenseInput> = {},
      whileActing: (renewed: RenewedLicense) => Promise<void> = () => Promise.resolve(),
      now = NOW,
      signerOf: () => Promise<LicenseSigner> = () => Promise.resolve(signer),
    ): Promise<RenewedLicense> =>
      control.withTenantOf(PLATFORM_TENANT_ID, (tx) =>
        store.renew(tx, { licenseId, reason: REASON, expectedVersion, validUntil: NEW_UNTIL, graceUntil: NEW_GRACE, issuedBy: ACTOR, restoreTenantId: PLATFORM_TENANT_ID, ...overrides }, signerOf, whileActing, now),
      );

    it('AC-ST-SAS-014-1: revision 2 takes the place of revision 1, which becomes Superseded with its claims untouched, and both signatures verify', async () => {
      const { tenantId, versionId } = await seedTenant();
      const first = await issue(tenantId, versionId);
      const seen: RenewedLicense[] = [];
      const renewed = await renew(first.id, 1, {}, (row) => Promise.resolve(void seen.push(row)));
      expect(renewed.superseded).toMatchObject({ id: first.id, revision: 1, status: 'Superseded', version: 2, statusReason: null, signedClaims: first.signedClaims });
      expect(renewed.license).toMatchObject({ revision: 2, serial: first.serial, status: 'Issued', supersedesId: first.id, edition: 'STANDARD', seats: 50, quota: { storage_gb: 100 }, version: 1, issuedBy: ACTOR, entitlementVersionId: versionId });
      expect(seen).toHaveLength(1);
      expect(store.verifySignature(renewed.superseded, keys)).toBe('VALID');
      expect(store.verifySignature(renewed.license, keys)).toBe('VALID');
      // Renewed before the end: the new revision starts with the renewal, so the term has no gap, and it ends where the request says.
      expect(renewed.license.validFrom).toEqual(NOW);
      expect(renewed.license.validUntil).toEqual(NEW_UNTIL);
      expect(renewed.license.graceUntil).toEqual(NEW_GRACE);
      expect(await versionCount(tenantId)).toBe(3);
      expect((await licensesOf(tenantId)).map((row) => [row.revision, row.status])).toEqual([
        [1, 'Superseded'],
        [2, 'Issued'],
      ]);
    });

    it('starts the renewed revision at the end of the old one when the renewal comes in the grace period, so the days since the end are covered', async () => {
      const { tenantId, versionId } = await seedTenant();
      const first = await issue(tenantId, versionId);
      const inGrace = new Date('2027-10-10T00:00:00Z');
      const renewed = await renew(first.id, 1, {}, undefined, inGrace);
      expect(renewed.license.validFrom).toEqual(UNTIL);
      expect(store.verifySignature(renewed.license, keys)).toBe('VALID');
    });

    it('can be renewed again: the chain grows by one revision each time and one revision of the serial is current', async () => {
      const { tenantId, versionId } = await seedTenant();
      const first = await issue(tenantId, versionId);
      const second = await renew(first.id, 1);
      const third = await renew(second.license.id, 1, { validUntil: new Date('2029-10-01T00:00:00Z'), graceUntil: new Date('2029-10-31T00:00:00Z') }, undefined, new Date('2026-12-01T00:00:00Z'));
      expect(third.license).toMatchObject({ revision: 3, supersedesId: second.license.id });
      expect((await licensesOf(tenantId)).map((row) => [row.revision, row.status])).toEqual([
        [1, 'Superseded'],
        [2, 'Superseded'],
        [3, 'Issued'],
      ]);
    });

    it('changes the seats and the entitlement version when the request says so, keeps the lease of a private deployment while it lasts and never past the new grace period', async () => {
      const { tenantId, versionId } = await seedTenant();
      const second = await tenants.withTenant({ tenantId, membershipId: ACTOR, scopeVersion: 1 }, (tx) => entitlements.record(tx, { cause: 'LICENSE_CHANGE', planVersionId: PLAN, features: STANDARD_FEATURES }));
      const next = await asAdmin((client) => client.query<{ id: string }>('select id from machvon.entitlement_version where tenant_id = $1 and id <> $2 order by version_no desc limit 1', [tenantId, versionId]));
      const newVersion = next.rows[0]?.id ?? '';
      expect(second).toBeDefined();
      const first = await issue(tenantId, versionId, { edition: 'PRIVATE', deploymentBinding: 'cluster-a', offlineLeaseDays: 20 });
      const renewed = await renew(first.id, 1, { seats: 75, entitlementVersionId: newVersion });
      expect(renewed.license).toMatchObject({ seats: 75, entitlementVersionId: newVersion, edition: 'PRIVATE', deploymentBinding: 'cluster-a' });
      expect(renewed.license.offlineLeaseUntil).toEqual(first.offlineLeaseUntil);
      expect(store.verifySignature(renewed.license, keys)).toBe('VALID');
    });

    it('lets the offline lease go when it has run out, and keeps no lease for an edition that has none', async () => {
      const { tenantId, versionId } = await seedTenant();
      const first = await issue(tenantId, versionId, { edition: 'PRIVATE', offlineLeaseDays: 5 });
      const later = new Date('2026-12-01T00:00:00Z');
      expect((await renew(first.id, 1, {}, undefined, later)).license.offlineLeaseUntil).toBeNull();
      const plain = await seedTenant();
      const standard = await issue(plain.tenantId, plain.versionId);
      expect((await renew(standard.id, 1)).license.offlineLeaseUntil).toBeNull();
    });

    it('refuses a revision that is not live, a stale version, an unknown license and a reason that is too short', async () => {
      for (const status of ['Suspended', 'Revoked', 'Draft', 'Superseded']) {
        const { tenantId, versionId } = await seedTenant();
        const row = await issue(tenantId, versionId);
        await asAdmin((client) => client.query("update machvon.license_revision set status = $1, status_reason = 'Set for the review of the contract.' where id = $2", [status, row.id]));
        await expect(renew(row.id, 1)).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID', status: 409 });
      }
      const ended = await seedTenant();
      const old = await issue(ended.tenantId, ended.versionId);
      await expect(renew(old.id, 1, {}, undefined, new Date('2028-01-01T00:00:00Z'))).rejects.toMatchObject({ code: 'LICENSE_STATE_INVALID', status: 409 });
      const { tenantId, versionId } = await seedTenant();
      const row = await issue(tenantId, versionId);
      await expect(renew(row.id, 5)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await expect(renew('00000000-0000-4000-8000-0000000000ff', 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await expect(renew(row.id, 1, { reason: 'too short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      await expect(renew(row.id, 1, { seats: 0 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      expect((await licensesOf(tenantId)).map((r) => r.status)).toEqual(['Issued']);
    });

    it('refuses an end that is not later than the current one, a grace period before the end, and a window that overlaps another revision', async () => {
      const { tenantId, versionId } = await seedTenant();
      const first = await issue(tenantId, versionId);
      await expect(renew(first.id, 1, { validUntil: UNTIL })).rejects.toMatchObject({ code: 'LICENSE_RANGE_INVALID', status: 422, detail: 'valid_until' });
      await expect(renew(first.id, 1, { graceUntil: new Date('2028-09-01T00:00:00Z') })).rejects.toMatchObject({ code: 'LICENSE_RANGE_INVALID', detail: 'grace_until' });
      // A revision of another serial that starts inside the window of the renewal.
      await asAdmin(async (client) => {
        await client.query(
          `insert into machvon.license_revision (tenant_id, id, serial, revision, entitlement_version_id, valid_from, valid_until, grace_until, status, signed_claims, key_id, edition, issuer, version)
           select tenant_id, gen_random_uuid(), 'LIC-OTHER-0001', 1, entitlement_version_id, timestamptz '2028-01-01', timestamptz '2028-06-01', timestamptz '2028-06-30', 'Issued', signed_claims, key_id, edition, issuer, 1
             from machvon.license_revision where id = $1`,
          [first.id],
        );
      });
      await expect(renew(first.id, 1)).rejects.toMatchObject({ code: 'LICENSE_RANGE_INVALID', status: 422, detail: 'valid_until' });
      expect((await licensesOf(tenantId)).filter((row) => row.serial === first.serial).map((row) => row.status)).toEqual(['Issued']);
    });

    it('refuses the entitlement version of another tenant, and asks for the key last', async () => {
      const { tenantId, versionId } = await seedTenant();
      const other = await seedTenant();
      const first = await issue(tenantId, versionId);
      await expect(renew(first.id, 1, { entitlementVersionId: other.versionId })).rejects.toMatchObject({ code: 'LICENSE_TENANT_MISMATCH', status: 422 });
      const unavailable: LicenseSigner = { keyId: 'kid-unknown', sign: () => Promise.resolve(new Uint8Array(64)) };
      await expect(renew(first.id, 1, {}, undefined, NOW, () => Promise.resolve(unavailable))).rejects.toMatchObject({ code: 'SIGNING_KEY_UNAVAILABLE', status: 503 });
      expect((await licensesOf(tenantId)).map((row) => row.status)).toEqual(['Issued']);
    });

    it('lets exactly one of two concurrent renewals win, and rolls the renewal back when the hook fails', async () => {
      const { tenantId, versionId } = await seedTenant();
      const first = await issue(tenantId, versionId);
      const results = await Promise.allSettled([renew(first.id, 1), renew(first.id, 1)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const failing = await seedTenant();
      const row = await issue(failing.tenantId, failing.versionId);
      await expect(renew(row.id, 1, {}, () => Promise.reject(new Error('hook failed')))).rejects.toThrow('hook failed');
      expect((await licensesOf(failing.tenantId)).map((r) => [r.revision, r.status])).toEqual([[1, 'Issued']]);
    });
  });

  describe('reading as the control plane', () => {
    const readOne = (licenseId: string): Promise<LicenseRow | undefined> => control.withTenantOf(PLATFORM_TENANT_ID, (tx) => store.findAny(tx, licenseId, PLATFORM_TENANT_ID));
    const readOf = (tenantId: string, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<LicenseRow[] | undefined> =>
      control.withTenantOf(PLATFORM_TENANT_ID, (tx) => store.listOf(tx, tenantId, request, PLATFORM_TENANT_ID));

    it('finds a license of any tenant by its id with the signed claims, and returns to the platform tenant', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      const found = await control.withTenantOf(PLATFORM_TENANT_ID, async (tx) => ({ row: await store.findAny(tx, license.id, PLATFORM_TENANT_ID), setting: (await tx.query<{ t: string }>("select current_setting('app.tenant_id') as t"))[0]?.t }));
      expect(found.row).toMatchObject({ id: license.id, tenantId, signedClaims: license.signedClaims, keyId: 'kid-2026' });
      expect(found.setting).toBe(PLATFORM_TENANT_ID);
      expect(await readOne(randomUUID())).toBeUndefined();
    });

    it('lists the revisions of one tenant in keyset pages, and tells an unknown tenant from a tenant without licenses', async () => {
      const { tenantId, versionId } = await seedTenant();
      const first = await issue(tenantId, versionId);
      const second = await issue(tenantId, versionId, { validFrom: UNTIL, validUntil: new Date('2028-10-01T00:00:00Z'), graceUntil: new Date('2028-10-31T00:00:00Z') });
      expect((await readOf(tenantId, { limit: 1, after: undefined }))?.map((row) => row.id)).toEqual([first.id]);
      expect((await readOf(tenantId, { limit: 5, after: { code: first.serial, id: first.id } }))?.map((row) => row.id)).toEqual([second.id]);
      const empty = await seedTenant();
      expect(await readOf(empty.tenantId, { limit: 5, after: undefined })).toEqual([]);
      expect(await readOf(randomUUID(), { limit: 5, after: undefined })).toBeUndefined();
    });
  });

  describe('reading', () => {
    it('lists the revisions of the tenant by serial and revision in keyset pages, and finds one by id', async () => {
      const { tenantId, versionId } = await seedTenant();
      const first = await issue(tenantId, versionId);
      const second = await issue(tenantId, versionId, { validFrom: UNTIL, validUntil: new Date('2028-10-01T00:00:00Z'), graceUntil: new Date('2028-10-31T00:00:00Z') });
      const context = { tenantId, membershipId: ACTOR, scopeVersion: 1 };
      const page1 = await tenants.withTenant(context, (tx) => store.list(tx, { limit: 1, after: undefined }));
      expect(page1.map((row) => row.id)).toEqual([first.id]);
      const page2 = await tenants.withTenant(context, (tx) => store.list(tx, { limit: 5, after: { code: first.serial, id: first.id } }));
      expect(page2.map((row) => row.id)).toEqual([second.id]);
      expect((await tenants.withTenant(context, (tx) => store.find(tx, second.id)))?.serial).toBe(second.serial);
    });

    it('never shows the license of one tenant to another', async () => {
      const a = await seedTenant();
      const b = await seedTenant();
      const license = await issue(a.tenantId, a.versionId);
      expect(await licensesOf(b.tenantId)).toHaveLength(0);
      expect(await tenants.withTenant({ tenantId: b.tenantId, membershipId: ACTOR, scopeVersion: 1 }, (tx) => store.find(tx, license.id))).toBeUndefined();
    });
  });

  describe('what the database allows', () => {
    it('lets the application role read licenses and nothing else: it cannot insert, update or delete a revision', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      const asTenant = <T>(work: (client: PoolClient) => Promise<T>): Promise<T> =>
        appPool.connect().then(async (client) => {
          try {
            await client.query('begin');
            await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
            return await work(client);
          } finally {
            await client.query('rollback');
            client.release();
          }
        });
      expect(await asTenant((client) => client.query('select id from machvon.license_revision'))).toMatchObject({ rowCount: 1 });
      await expect(asTenant((client) => client.query("update machvon.license_revision set status = 'Revoked' where id = $1", [license.id]))).rejects.toThrow('permission denied');
      await expect(asTenant((client) => client.query('delete from machvon.license_revision where id = $1', [license.id]))).rejects.toThrow('permission denied');
      await expect(
        asTenant((client) =>
          client.query(
            `insert into machvon.license_revision (tenant_id, id, serial, revision, entitlement_version_id, valid_from, valid_until, grace_until, status, signed_claims, key_id)
             values ($1, gen_random_uuid(), 'X', 1, $2, now(), now() + interval '1 day', now() + interval '1 day', 'Issued', 'x', 'kid-2026')`,
            [tenantId, versionId],
          ),
        ),
      ).rejects.toThrow('permission denied');
      await expect(asTenant((client) => client.query('select id from machvon.license_signing_key'))).rejects.toThrow('permission denied');
    });

    it('lets the control role change only the status, the reason and the version of a revision, never delete it', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      const asControl = (sql: string, params: unknown[]): Promise<unknown> => control.withTenantOf(tenantId, (tx) => tx.query(sql, params));
      await expect(asControl('update machvon.license_revision set valid_until = valid_until + interval \'1 year\' where id = $1', [license.id])).rejects.toThrow('permission denied');
      await expect(asControl("update machvon.license_revision set signed_claims = 'forged' where id = $1", [license.id])).rejects.toThrow('permission denied');
      await expect(asControl('delete from machvon.license_revision where id = $1', [license.id])).rejects.toThrow('permission denied');
      await expect(asControl("update machvon.license_signing_key set status = 'Revoked' where id = 'kid-2026'", [])).rejects.toThrow('permission denied');
    });

    it('finds the tenant of a license for the control role only, and leaves the tenant setting as it found it', async () => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId);
      const found = await control.withTenantOf(PLATFORM_TENANT_ID, async (tx) => {
        const owner = (await tx.query<{ tenant_id: string | null }>('select machvon.license_tenant_of($1::uuid) as tenant_id', [license.id]))[0]?.tenant_id;
        const setting = (await tx.query<{ tenant: string }>("select current_setting('app.tenant_id') as tenant"))[0]?.tenant;
        const none = (await tx.query<{ tenant_id: string | null }>('select machvon.license_tenant_of($1::uuid) as tenant_id', [randomUUID()]))[0]?.tenant_id;
        return { owner, setting, none };
      });
      expect(found).toEqual({ owner: tenantId, setting: PLATFORM_TENANT_ID, none: null });
      const client = await appPool.connect();
      try {
        await expect(client.query('select machvon.license_tenant_of($1::uuid)', [license.id])).rejects.toThrow('permission denied');
      } finally {
        client.release();
      }
    });

    it('registers a key once: a second registration of the same key id changes nothing', async () => {
      const again = await control.withControl((tx) =>
        store.registerSigningKey(tx, { keyId: 'kid-2026', publicKeyPem: 'other', kmsKeyRef: 'other', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2029-01-01T00:00:00Z') }),
      );
      expect(again).toBe(false);
      const stored = await asAdmin((client) => client.query<{ public_key_pem: string }>("select public_key_pem from machvon.license_signing_key where id = 'kid-2026'"));
      expect(stored.rows[0]?.public_key_pem).toContain('BEGIN PUBLIC KEY');
    });

    it('has registered the license reminder as a notification event type with a payload schema', async () => {
      const rows = await asAdmin((client) =>
        client.query<{ owning_module: string; status: string; allowed_purposes: string[]; payload_schema: { required: string[] } }>(
          "select owning_module, status, allowed_purposes, payload_schema from machvon.notification_event_type where event_type = 'sas.license.expiring.v1' and schema_version = 1",
        ),
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ owning_module: 'SAS', status: 'Active', allowed_purposes: ['REMINDER', 'OPERATIONAL'] });
      expect(rows.rows[0]?.payload_schema.required).toEqual(['tenant_id', 'license_id', 'serial', 'valid_until', 'days_left']);
    });
  });

  describe('the status job (AC-ST-SAS-003-1, UAT-AC40)', () => {
    const START = new Date('2026-11-01T00:00:00Z');
    const END = new Date('2026-12-01T00:00:00Z');
    const GRACE_END = new Date('2026-12-31T00:00:00Z');
    const at = (base: Date, seconds: number): Date => new Date(base.getTime() + seconds * 1000);

    let job: LicenseStatusJob;
    beforeAll(() => {
      job = new LicenseStatusJob(new AuditWriter(tenants));
    });

    const run = (tenantId: string, now: Date) => control.withTenantOf(tenantId, (tx) => job.run(tx, ACTOR, now));
    const statusOf = async (licenseId: string): Promise<{ status: string; version: string }> =>
      (await asAdmin((client) => client.query<{ status: string; version: string }>('select status, version::text from machvon.license_revision where id = $1', [licenseId]))).rows[0] ?? { status: '', version: '' };
    const eventsOf = async (licenseId: string): Promise<Array<{ from: string; to: string }>> =>
      (
        await asAdmin((client) =>
          client.query<{ payload: { from: string; to: string } }>("select payload from machvon.outbox_event where type = 'sas.license.status_changed.v1' and aggregate_id = $1 order by created_at, id", [licenseId]),
        )
      ).rows.map((row) => ({ from: row.payload.from, to: row.payload.to }));
    const windowed = async (graceUntil = GRACE_END) => {
      const { tenantId, versionId } = await seedTenant();
      const license = await issue(tenantId, versionId, { validFrom: START, validUntil: END, graceUntil });
      return { tenantId, license };
    };

    it('AC-ST-SAS-003-1 / UAT-AC40: moves Issued, Active, Active, Grace, Grace, Expired at the boundaries of [from, until) by the clock it is given, one event for each move', async () => {
      const { tenantId, license } = await windowed();
      const steps: Array<[Date, string, number]> = [
        [at(START, -1), 'Issued', 0],
        [START, 'Active', 1],
        [at(END, -1), 'Active', 1],
        [END, 'Grace', 2],
        [at(GRACE_END, -1), 'Grace', 2],
        [GRACE_END, 'Expired', 3],
      ];
      for (const [now, expected, events] of steps) {
        await run(tenantId, now);
        expect((await statusOf(license.id)).status).toBe(expected);
        expect(await eventsOf(license.id)).toHaveLength(events);
      }
      expect(await eventsOf(license.id)).toEqual([
        { from: 'Issued', to: 'Active' },
        { from: 'Active', to: 'Grace' },
        { from: 'Grace', to: 'Expired' },
      ]);
      expect((await statusOf(license.id)).version).toBe('4');
    });

    it('changes nothing when it runs again at the same time, and leaves the license alone before its window', async () => {
      const { tenantId, license } = await windowed();
      expect((await run(tenantId, START)).changes).toHaveLength(1);
      const again = await run(tenantId, START);
      expect(again.changes).toEqual([]);
      expect(await eventsOf(license.id)).toHaveLength(1);
      const early = await windowed();
      expect((await run(early.tenantId, at(START, -3600))).changes).toEqual([]);
      expect((await statusOf(early.license.id)).status).toBe('Issued');
    });

    it('tells every step when the pass finds a license several steps behind, and the tenant gets one entitlement version for each cause', async () => {
      const { tenantId, license } = await windowed();
      const before = await versionCount(tenantId);
      const result = await run(tenantId, at(GRACE_END, 60));
      expect(result.changes.map((change) => `${change.from}>${change.to}`)).toEqual(['Issued>Active', 'Active>Grace', 'Grace>Expired']);
      expect(await eventsOf(license.id)).toHaveLength(3);
      expect(await versionCount(tenantId)).toBe(before + 2);
      const causes = await asAdmin((client) => client.query<{ cause: string }>('select cause from machvon.entitlement_version where tenant_id = $1 order by version_no desc limit 2', [tenantId]));
      expect(causes.rows.map((row) => row.cause).sort()).toEqual(['EXPIRY', 'LICENSE_CHANGE']);
    });

    it('goes from Active straight to Expired when the license has no grace', async () => {
      const { tenantId, license } = await windowed(END);
      await run(tenantId, START);
      await run(tenantId, END);
      expect((await statusOf(license.id)).status).toBe('Expired');
      expect(await eventsOf(license.id)).toEqual([
        { from: 'Issued', to: 'Active' },
        { from: 'Active', to: 'Expired' },
      ]);
    });

    it('leaves a suspended license and a revoked one as the people left them, whatever the clock says', async () => {
      const held = await windowed();
      await asAdmin((client) => client.query("update machvon.license_revision set status = 'Suspended', status_reason = 'Held for a check of the contract.' where id = $1", [held.license.id]));
      const ended = await windowed();
      await revoke(ended.license.id, ended.license.version);
      expect((await run(held.tenantId, at(GRACE_END, 60))).changes).toEqual([]);
      expect((await run(ended.tenantId, at(GRACE_END, 60))).changes).toEqual([]);
      expect((await statusOf(held.license.id)).status).toBe('Suspended');
      expect((await statusOf(ended.license.id)).status).toBe('Revoked');
    });

    it('reads the next step of a status from the window alone, and none for a status the clock does not move', () => {
      const window = { valid_from: START, valid_until: END, grace_until: GRACE_END };
      expect(nextLicenseStatus({ status: 'Issued', ...window }, END)).toBe('Active');
      expect(nextLicenseStatus({ status: 'Expired', ...window }, GRACE_END)).toBeUndefined();
      expect(nextLicenseStatus({ status: 'Revoked', ...window }, GRACE_END)).toBeUndefined();
      expect(nextLicenseStatus({ status: 'Suspended', ...window }, GRACE_END)).toBeUndefined();
    });

    it('writes one audit row for each move, with the statuses and no signed claims', async () => {
      const { tenantId, license } = await windowed();
      await run(tenantId, END);
      const rows = await asAdmin((client) =>
        client.query<{ diff: Record<string, unknown> }>("select safe_diff as diff from machvon.audit_event where tenant_id = $1 and action = 'sas.license_status_changed' and resource_id = $2 order by occurred_at", [tenantId, license.id]),
      );
      expect(rows.rows.map((row) => row.diff)).toEqual([
        { serial: license.serial, revision: 1, from_status: 'Issued', to_status: 'Active' },
        { serial: license.serial, revision: 1, from_status: 'Active', to_status: 'Grace' },
      ]);
    });
  });
});
