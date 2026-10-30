import { challengeRecordName, hashOf } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import type { ApprovalEffects } from '../src/approval-store';
import { ControlDatabase } from '../src/control-database';
import { MockCertificateAuthority, MockDomainProof } from '../src/domain-ports';
import { TenantDomainStore, tenantOfDomain, tenantOfDomainId } from '../src/tenant-domain-store';
import type { DomainRow } from '../src/tenant-domain-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B } from './support/authz-fixtures';

const store = new TenantDomainStore();
const PLACEMENT = '00000000-0000-4000-8000-0000000000b1';
const PLATFORM = 'machvon.vn';
const NOW = new Date('2026-10-30T03:00:00Z');
const day = (n: number, from = NOW): Date => new Date(from.getTime() + n * 86_400_000);

interface Recorded {
  audits: Array<{ action: string; resourceId: string; diff: unknown }>;
  events: Array<{ type: string; eventKey: string }>;
}

function recorder(): ApprovalEffects & Recorded {
  const audits: Recorded['audits'] = [];
  const events: Recorded['events'] = [];
  return {
    actor: '00000000-0000-4000-8000-0000000000c9',
    audits,
    events,
    audit: async (entry) => void audits.push({ action: entry.action, resourceId: entry.resourceId, diff: entry.diff }),
    emit: async (event) => void events.push({ type: event.type, eventKey: event.eventKey }),
  };
}

describe('the domains of a tenant (ST-SAS-017, SAS.md 3.4, BR-SAS-06)', () => {
  const harness = new AuthzHarness();
  let control: ControlDatabase;
  let controlPool: Pool;
  let counter = 0;
  let proof: MockDomainProof;
  let authority: MockCertificateAuthority;

  const inTenant = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(tenant, work);
  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const sqlError = async (text: string, params: unknown[] = []): Promise<{ code: string | undefined; message: string } | undefined> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    } finally {
      await client.end();
    }
  };

  const host = (name = 'portal'): string => {
    counter += 1;
    return `${name}${counter}.caobang.gov.vn`;
  };
  const add = (tenant: string, hostname: string, kind: 'CUSTOM' | 'PLATFORM_SUBDOMAIN' = 'CUSTOM', at = NOW, effects = recorder()) =>
    inTenant(tenant, (tx) => store.add(tx, effects, { tenantId: tenant, hostname, kind, platformDomain: PLATFORM }, at));
  const verify = (tenant: string, domainId: string, at = NOW, effects = recorder(), version?: number) => inTenant(tenant, (tx) => store.verify(tx, effects, domainId, version, { proof }, at));
  const sweep = (tenant: string, at = NOW, effects = recorder()) => inTenant(tenant, (tx) => store.sweep(tx, effects, { proof, certificates: authority }, at));
  const reload = async (tenant: string, domain: DomainRow): Promise<DomainRow> => (await inTenant(tenant, (tx) => store.find(tx, domain.id))) as DomainRow;
  const answer = (hostname: string, token: string): void => proof.publish(challengeRecordName(hostname), `"${token}"`);

  beforeEach(() => {
    proof = new MockDomainProof();
    authority = new MockCertificateAuthority();
  });

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 4 });
    controlPool.on('error', () => undefined);
    control = new ControlDatabase(controlPool);
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active') on conflict do nothing", [PLACEMENT]);
    for (const [id, code] of [[TENANT_A, 'tenant-a'], [TENANT_B, 'tenant-b']] as const) {
      await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', $3, 'vn-north') on conflict (id) do nothing", [id, code, PLACEMENT]);
    }
  }, 180_000);

  afterAll(async () => {
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  describe('adding a domain', () => {
    it('gives a custom domain a challenge: the token is shown once, only its hash is kept, and it lasts a week', async () => {
      const hostname = host();
      const effects = recorder();
      const { domain, token } = await add(TENANT_A, hostname.toUpperCase(), 'CUSTOM', NOW, effects);
      expect(domain).toMatchObject({ tenantId: TENANT_A, hostname, kind: 'CUSTOM', status: 'PendingVerification', tlsStatus: 'Pending', verifiedAt: null, version: 1 });
      expect(domain.challengeExpiresAt).toEqual(day(7));
      expect(token).toMatch(/^machvon-verify=/);
      const [kept] = await admin<{ txt_token_hash: string }>('select txt_token_hash from machvon.tenant_domain where id = $1', [domain.id]);
      expect(kept?.txt_token_hash).toBe(hashOf(token as string));
      expect(JSON.stringify(await admin('select * from machvon.tenant_domain where id = $1', [domain.id]))).not.toContain(token as string);
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.domain_added']);
      expect(await inTenant(TENANT_A, (tx) => tenantOfDomain(tx, hostname))).toBeUndefined();
    });

    it('proves nothing for a platform subdomain, which is the platform\'s own: it is Verified at once and waits for its certificate', async () => {
      const { domain, token } = await add(TENANT_A, `sub${counter + 1}.${PLATFORM}`, 'PLATFORM_SUBDOMAIN');
      counter += 1;
      expect(token).toBeUndefined();
      expect(domain).toMatchObject({ kind: 'PLATFORM_SUBDOMAIN', status: 'Verified', tlsStatus: 'Pending' });
      expect(domain.verifiedAt).toEqual(NOW);
    });

    it('is refused for a hostname another tenant holds, the same tenant already holds, or that is a name of the platform; the answer names nobody', async () => {
      const hostname = host();
      const held = await add(TENANT_A, hostname);
      await expect(add(TENANT_B, hostname.toUpperCase())).rejects.toMatchObject({ code: 'DOMAIN_TAKEN', status: 409 });
      // The tenant itself is refused once the domain is proved (until then it gets a new token instead).
      answer(hostname, held.token as string);
      await verify(TENANT_A, held.domain.id);
      await expect(add(TENANT_A, hostname.toUpperCase())).rejects.toMatchObject({ code: 'DOMAIN_TAKEN', status: 409 });
      for (const reserved of [`www.${PLATFORM}`, `portal.${PLATFORM}`, PLATFORM]) {
        await expect(add(TENANT_B, reserved, 'CUSTOM')).rejects.toMatchObject({ code: 'DOMAIN_TAKEN', status: 409 });
      }
      await expect(add(TENANT_B, `api.${PLATFORM}`, 'PLATFORM_SUBDOMAIN')).rejects.toMatchObject({ code: 'DOMAIN_TAKEN', status: 409 });
      await expect(add(TENANT_B, 'not a host')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'hostname' });
    });

    it('tells two claims on the same free name apart: one gets it, the other is DOMAIN_TAKEN and not a server error', async () => {
      const hostname = host();
      const claims = await Promise.allSettled([add(TENANT_A, hostname), add(TENANT_B, hostname)]);
      expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1);
      const lost = claims.find((claim) => claim.status === 'rejected');
      expect((lost as PromiseRejectedResult).reason).toMatchObject({ code: 'DOMAIN_TAKEN', status: 409 });
    });

    it('keeps the domains of a tenant out of sight of another tenant\'s own transaction, though the platform sees who holds a name', async () => {
      const hostname = host();
      const { domain } = await add(TENANT_A, hostname);
      expect(await harness.tenants.withTenant({ tenantId: TENANT_B, membershipId: '00000000-0000-4000-8000-000000000001', scopeVersion: 0 }, (tx) => store.find(tx, domain.id))).toBeUndefined();
      expect(await inTenant(TENANT_B, (tx) => tenantOfDomainId(tx, domain.id))).toBe(TENANT_A);
    });
  });

  describe('the proof', () => {
    it('finds the TXT record and makes the domain Verified: it then chooses the tenant at sign-in, and the platform is told', async () => {
      const hostname = host();
      const { domain, token } = await add(TENANT_A, hostname);
      const effects = recorder();
      const early = await verify(TENANT_A, domain.id, NOW, effects);
      expect(early).toMatchObject({ verified: false, domain: { status: 'PendingVerification', failureCode: 'TXT_NOT_FOUND' } });
      expect(early.domain.lastCheckedAt).toEqual(NOW);
      expect(await inTenant(TENANT_A, async (tx) => tenantOfDomain(tx, hostname))).toBeUndefined();
      answer(hostname, token as string);
      const done = await verify(TENANT_A, domain.id, day(1), effects);
      expect(done).toMatchObject({ verified: true, domain: { status: 'Verified', failureCode: null } });
      expect(done.domain.verifiedAt).toEqual(day(1));
      expect(effects.events.map((event) => event.type)).toEqual(['sas.domain.verified.v1']);
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.domain_unverified', 'tenant.domain_verified']);
      expect(await inTenant(TENANT_B, (tx) => tenantOfDomain(tx, hostname.toUpperCase()))).toBe(TENANT_A);
      // Asked again, it is answered as it is.
      expect(await verify(TENANT_A, domain.id, day(2))).toMatchObject({ verified: true, domain: { status: 'Verified' } });
    });

    it('is not satisfied by another token, by a record at another name, or once the week is over; a domain whose challenge ended Failed and can be asked for again', async () => {
      const hostname = host();
      const { domain, token } = await add(TENANT_A, hostname);
      proof.publish(challengeRecordName(hostname), 'machvon-verify=not-the-token');
      proof.publish(challengeRecordName('other.caobang.gov.vn'), token as string);
      expect((await verify(TENANT_A, domain.id)).verified).toBe(false);
      answer(hostname, token as string);
      const late = await verify(TENANT_A, domain.id, day(8));
      expect(late).toMatchObject({ verified: false, domain: { status: 'Failed', failureCode: 'CHALLENGE_EXPIRED' } });
      // The tenant that holds it asks again: a new token, a new week.
      const again = await add(TENANT_A, hostname, 'CUSTOM', day(9));
      expect(again.domain).toMatchObject({ id: domain.id, status: 'PendingVerification', failureCode: null });
      expect(again.domain.challengeExpiresAt).toEqual(day(16));
      expect(again.token).not.toBe(token);
      answer(hostname, again.token as string);
      expect((await verify(TENANT_A, domain.id, day(10))).verified).toBe(true);
    });

    it('refuses a stale version, a domain that does not exist and one that was released', async () => {
      const { domain } = await add(TENANT_A, host());
      await expect(verify(TENANT_A, domain.id, NOW, recorder(), 7)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      await expect(verify(TENANT_A, '00000000-0000-4000-8000-00000000dead')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await inTenant(TENANT_A, (tx) => store.remove(tx, recorder(), domain.id, 'No longer wanted by the province.', undefined, NOW));
      await expect(verify(TENANT_A, domain.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('releasing a domain', () => {
    it('stops it choosing the tenant, and holds the hostname for 90 days against anybody, the tenant that released it included', async () => {
      const hostname = host();
      const { domain, token } = await add(TENANT_A, hostname);
      answer(hostname, token as string);
      await verify(TENANT_A, domain.id);
      const effects = recorder();
      const released = await inTenant(TENANT_A, (tx) => store.remove(tx, effects, domain.id, 'No longer wanted by the province.', undefined, NOW));
      expect(released).toMatchObject({ status: 'Revoked' });
      expect(released.revokedAt).toEqual(NOW);
      expect(effects.events.map((event) => event.type)).toEqual(['sas.domain.revoked.v1']);
      expect(await inTenant(TENANT_A, (tx) => tenantOfDomain(tx, hostname))).toBeUndefined();
      for (const tenant of [TENANT_A, TENANT_B]) {
        await expect(add(tenant, hostname, 'CUSTOM', day(89))).rejects.toMatchObject({ code: 'DOMAIN_TAKEN', status: 409, extensions: { reason: 'RESERVED' } });
      }
      // After the 90 days the name is free for anybody.
      expect((await add(TENANT_B, hostname, 'CUSTOM', day(91))).domain).toMatchObject({ tenantId: TENANT_B, status: 'PendingVerification' });
    });

    it('is held by the table: what a domain is never changes, a released domain is final, nothing deletes one', async () => {
      const { domain } = await add(TENANT_A, host());
      for (const statement of [
        "update machvon.tenant_domain set hostname = 'else.caobang.gov.vn' where id = $1",
        "update machvon.tenant_domain set kind = 'PLATFORM_SUBDOMAIN' where id = $1",
        "update machvon.tenant_domain set status = 'Revoked' where id = $1",
        'delete from machvon.tenant_domain where id = $1',
      ]) {
        const error = await sqlError(statement, [domain.id]);
        // The release without a time is refused by the table too.
        expect(error?.code).toBe('23514');
      }
      await inTenant(TENANT_A, (tx) => store.remove(tx, recorder(), domain.id, 'No longer wanted by the province.', undefined, NOW));
      expect((await sqlError("update machvon.tenant_domain set status = 'Active' where id = $1", [domain.id]))?.code).toBe('23514');
    });
  });

  describe('the directory of hostnames and its migration', () => {
    it('is out of reach of the tenant plane: the application role can neither read nor write who holds a hostname', async () => {
      for (const text of ['select * from machvon.tenant_domain_directory', "update machvon.tenant_domain_directory set holder_tenant_id = holder_tenant_id", "delete from machvon.tenant_domain_directory", "insert into machvon.tenant_domain_directory (hostname, holder_tenant_id, domain_id, status) values ('x.example.vn', '00000000-0000-4000-8000-0000000000a1', gen_random_uuid(), 'Active')"]) {
        const client = new Client({ connectionString: harness.database.urlFor('machvon_app') });
        await client.connect();
        try {
          await expect(client.query(text)).rejects.toMatchObject({ code: '42501' });
        } finally {
          await client.end();
        }
      }
    });

    it('leaves the rule that a released domain has the time it was released validated, so an existing database is held to it', async () => {
      const [rule] = await admin<{ convalidated: boolean }>("select convalidated from pg_constraint where conname = 'tenant_domain_revoked_ck'");
      expect(rule?.convalidated).toBe(true);
    });
  });

  describe('listing and giving a failed domain another challenge', () => {
    it('pages through domains made within the same millisecond without skipping one, though the database keeps microseconds', async () => {
      const names = [host('page'), host('page'), host('page')];
      for (const [index, name] of names.entries()) {
        await admin(
          "insert into machvon.tenant_domain (tenant_id, id, hostname, kind, txt_token_hash, status, tls_status, created_at) values ($1, gen_random_uuid(), $2, 'CUSTOM', repeat('a', 64), 'PendingVerification', 'Pending', timestamptz '2027-01-01 00:00:00.123000+00' + make_interval(secs => $3::float / 1000000))",
          [TENANT_B, name, index * 100],
        );
      }
      const seen: string[] = [];
      let after: { createdAt: string; id: string } | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await inTenant(TENANT_B, (tx) => store.list(tx, { limit: 2, after }));
        const rows = page.filter((row) => row.createdAt.toISOString() === '2027-01-01T00:00:00.123Z');
        seen.push(...rows.map((row) => row.hostname));
        const last = page[page.length - 1];
        if (page.length < 2 || last === undefined) break;
        after = { createdAt: last.createdAt.toISOString(), id: last.id };
      }
      expect([...seen].sort()).toEqual([...names].sort());
    });

    it('gives the tenant a new token when it adds a domain that still waits for its proof (the answer with the first one was lost); the first token stops working and another tenant is still refused', async () => {
      const hostname = host();
      const first = await add(TENANT_A, hostname);
      const second = await add(TENANT_A, hostname);
      expect(second.domain.id).toBe(first.domain.id);
      expect(second.token).not.toBe(first.token);
      expect(second.domain).toMatchObject({ status: 'PendingVerification', version: first.domain.version + 1 });
      answer(hostname, first.token as string);
      expect((await verify(TENANT_A, first.domain.id)).verified).toBe(false);
      proof.unpublish(challengeRecordName(hostname));
      answer(hostname, second.token as string);
      expect((await verify(TENANT_A, first.domain.id)).verified).toBe(true);
      await expect(add(TENANT_B, hostname)).rejects.toMatchObject({ code: 'DOMAIN_TAKEN' });
      // A domain that is proved already is not given a new challenge.
      await expect(add(TENANT_A, hostname)).rejects.toMatchObject({ code: 'DOMAIN_TAKEN' });
    });

    it('answers DOMAIN_TAKEN, not a server error, when a domain is released while another request gives it a new challenge', async () => {
      const hostname = host();
      const { domain } = await add(TENANT_A, hostname);
      await admin("update machvon.tenant_domain set status = 'Failed', failure_code = 'TXT_NOT_FOUND' where id = $1", [domain.id]);
      const [added, released] = await Promise.allSettled([add(TENANT_A, hostname), inTenant(TENANT_A, (tx) => store.remove(tx, recorder(), domain.id, 'No longer wanted by the province.', undefined, NOW))]);
      // Whichever came first, the answer of the add is a success or the refusal of a name that is gone, never a server error.
      if (added.status === 'rejected') expect(added.reason).toMatchObject({ code: 'DOMAIN_TAKEN', status: 409 });
      expect(released.status === 'fulfilled' || (released.status === 'rejected' && (released.reason as { code?: string }).code === 'RESOURCE_NOT_FOUND')).toBe(true);
    });
  });

  describe('the lifecycle pass', () => {
    it('gives a Verified domain its certificate and makes it Active; a certificate that cannot be issued is tried again at the next pass', async () => {
      const hostname = host();
      const { domain, token } = await add(TENANT_A, hostname);
      answer(hostname, token as string);
      await verify(TENANT_A, domain.id);
      // The pass goes through every live domain of the tenant in id order: the authority fails for all of them, so the failure is this domain's whatever its place.
      authority.failNext(1000);
      const failed = await sweep(TENANT_A);
      authority.failNext(0);
      expect(failed.failed).toContain(domain.id);
      expect(failed.activated).not.toContain(domain.id);
      expect(await reload(TENANT_A, domain)).toMatchObject({ status: 'Verified', tlsStatus: 'Failed', failureCode: 'TLS_FAILED' });
      expect(failed.failing).toBeGreaterThanOrEqual(1);
      const done = await sweep(TENANT_A, day(1));
      expect(done.activated).toContain(domain.id);
      const active = await reload(TENANT_A, domain);
      expect(active).toMatchObject({ status: 'Active', tlsStatus: 'Issued', failureCode: null });
      expect(active.tlsExpiresAt).toEqual(day(91));
      expect(authority.issued).toContain(hostname);
      const quiet = await sweep(TENANT_A, day(2));
      expect([...quiet.activated, ...quiet.failed, ...quiet.renewed]).not.toContain(domain.id);
    });

    it('looks at the proof of an Active custom domain every week: with the record gone it is Failed and no longer chooses the tenant', async () => {
      const hostname = host();
      const { domain, token } = await add(TENANT_A, hostname);
      answer(hostname, token as string);
      await verify(TENANT_A, domain.id);
      await sweep(TENANT_A);
      const lookups = proof.lookups;
      await sweep(TENANT_A, day(3));
      expect(proof.lookups).toBe(lookups);
      proof.unpublish(challengeRecordName(hostname));
      const effects = recorder();
      expect((await sweep(TENANT_A, day(8), effects)).failed).toContain(domain.id);
      expect(await reload(TENANT_A, domain)).toMatchObject({ status: 'Failed', failureCode: 'TXT_NOT_FOUND' });
      expect(effects.audits.filter((entry) => entry.resourceId === domain.id).map((entry) => entry.action)).toEqual(['tenant.domain_failed']);
      expect(await inTenant(TENANT_A, (tx) => tenantOfDomain(tx, hostname))).toBeUndefined();
    });

    it('stops counting a domain once it is released, though its certificate had failed (the alert does not stay raised for a domain that is gone)', async () => {
      const hostname = host();
      const { domain, token } = await add(TENANT_B, hostname);
      answer(hostname, token as string);
      await verify(TENANT_B, domain.id);
      authority.failNext(1000);
      const before = await sweep(TENANT_B);
      authority.failNext(0);
      expect(before.failed).toContain(domain.id);
      await inTenant(TENANT_B, (tx) => store.remove(tx, recorder(), domain.id, 'No longer wanted by the province.', undefined, NOW));
      authority.failNext(1000);
      const after = await sweep(TENANT_B, day(1));
      authority.failNext(0);
      // What is counted is what is still live and failing; the released domain, whose certificate stays Failed in its row, is not.
      const [live] = await admin<{ n: string }>("select count(*)::text as n from machvon.tenant_domain where tenant_id = $1 and status <> 'Revoked' and (status = 'Failed' or tls_status = 'Failed')", [TENANT_B]);
      expect(after.failing).toBe(Number(live?.n));
      const [gone] = await admin<{ tls_status: string }>('select tls_status from machvon.tenant_domain where id = $1', [domain.id]);
      expect(gone?.tls_status).toBe('Failed');
      expect(after.failing).toBeLessThan(before.failing + 1);
    });

    it('keeps an Active domain as it is when the resolver does not answer: a lookup that failed says nothing about the proof, and the next pass looks again', async () => {
      const hostname = host();
      const { domain, token } = await add(TENANT_A, hostname);
      answer(hostname, token as string);
      await verify(TENANT_A, domain.id);
      await sweep(TENANT_A);
      const before = await reload(TENANT_A, domain);
      const broken = { txtRecords: () => Promise.reject(new Error('the resolver timed out')) };
      const effects = recorder();
      const outage = await inTenant(TENANT_A, (tx) => store.sweep(tx, effects, { proof: broken, certificates: authority }, day(8)));
      expect(outage.failed).not.toContain(domain.id);
      expect(effects.audits.filter((entry) => entry.resourceId === domain.id)).toEqual([]);
      const during = await reload(TENANT_A, domain);
      expect(during).toMatchObject({ status: 'Active', failureCode: null });
      expect(during.lastCheckedAt).toEqual(before.lastCheckedAt);
      expect(await inTenant(TENANT_A, (tx) => tenantOfDomain(tx, hostname))).toBe(TENANT_A);
      // The resolver is back: the record is there, the domain is looked at, and it stays Active.
      const back = await sweep(TENANT_A, day(8));
      expect(back.failed).not.toContain(domain.id);
      expect(await reload(TENANT_A, domain)).toMatchObject({ status: 'Active', lastCheckedAt: day(8) });
    });

    it('looks again at a custom domain that waits for its certificate too: a Verified domain whose proof is gone stops choosing the tenant even while the authority is down', async () => {
      const hostname = host();
      const { domain, token } = await add(TENANT_A, hostname);
      answer(hostname, token as string);
      await verify(TENANT_A, domain.id);
      authority.failNext(1000);
      await sweep(TENANT_A);
      authority.failNext(0);
      expect(await inTenant(TENANT_A, (tx) => tenantOfDomain(tx, hostname))).toBe(TENANT_A);
      proof.unpublish(challengeRecordName(hostname));
      authority.failNext(1000);
      const later = await sweep(TENANT_A, day(8));
      authority.failNext(0);
      expect(later.failed).toContain(domain.id);
      expect(await reload(TENANT_A, domain)).toMatchObject({ status: 'Failed', failureCode: 'TXT_NOT_FOUND' });
      expect(await inTenant(TENANT_A, (tx) => tenantOfDomain(tx, hostname))).toBeUndefined();
    });

    it('brings a domain the provisioning registered (Active, a certificate, no end on record) into the lifecycle: the pass records an end and renews it later', async () => {
      counter += 1;
      const name = `registered${counter}.${PLATFORM}`;
      await admin(
        "insert into machvon.tenant_domain (tenant_id, id, hostname, kind, status, tls_status, verified_at) values ($1, gen_random_uuid(), $2, 'PLATFORM_SUBDOMAIN', 'Active', 'Issued', now())",
        [TENANT_B, name],
      );
      const [row] = await admin<{ id: string }>('select id from machvon.tenant_domain where hostname = $1', [name]);
      const pass = await sweep(TENANT_B, NOW);
      expect(pass.activated).toContain(row?.id);
      const [kept] = await admin<{ tls_expires_at: Date }>('select tls_expires_at from machvon.tenant_domain where id = $1', [row?.id]);
      expect(kept?.tls_expires_at).toEqual(day(90));
      expect((await sweep(TENANT_B, day(77))).renewed).toContain(row?.id);
    });

    it('renews a certificate that has 14 days left, and a platform subdomain needs no proof to become Active', async () => {
      const hostname = host();
      const { domain, token } = await add(TENANT_A, hostname);
      answer(hostname, token as string);
      await verify(TENANT_A, domain.id);
      await sweep(TENANT_A);
      expect((await sweep(TENANT_A, day(75))).renewed).not.toContain(domain.id);
      const renewal = await sweep(TENANT_A, day(77));
      expect(renewal.renewed).toContain(domain.id);
      expect((await reload(TENANT_A, domain)).tlsExpiresAt).toEqual(day(167));
      const platform = await add(TENANT_B, `team${counter + 1}.${PLATFORM}`, 'PLATFORM_SUBDOMAIN');
      counter += 1;
      expect((await sweep(TENANT_B)).activated).toContain(platform.domain.id);
      expect(await reload(TENANT_B, platform.domain)).toMatchObject({ status: 'Active', tlsStatus: 'Issued' });
    });
  });
});
