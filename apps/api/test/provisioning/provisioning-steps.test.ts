import { createHash, generateKeyPairSync } from 'node:crypto';
import { AuditWriter, EntitlementStore, InMemoryEntitlementCache, LicenseStore, PLATFORM_TENANT_ID, SYSTEM_ROLES, TenantBootstrapStore, ThemeStore, TRIAL_DAYS } from '@machvon/db';
import type { TenantRegistry } from '@machvon/db';
import { requestSchemaOf, validateRequestBody } from '@machvon/contracts';
import { DomainError, verifyLicenseToken } from '@machvon/kernel';
import type { LicenseSigner } from '@machvon/kernel';
import { MockInvitationMailer } from '../../src/modules/adm/invitation-mailer';
import { Ed25519LicenseSigner } from '../../src/modules/sas/license-signer';
import type { LicenseKeyStore } from '../../src/modules/sas/license-signer';
import { assertValidTheme } from '../../src/modules/sas/theme-validation';
import { defaultTenantTheme } from '../../src/provisioning/default-theme';
import { activationRecorder, createProvisioningSteps, provisioningStepDefinitions } from '../../src/provisioning/provisioning-steps';
import type { ProvisioningServices } from '../../src/provisioning/provisioning-steps';
import { ProvisioningSaga } from '../../src/provisioning/saga';
import { PROVISIONING_STEPS } from '@machvon/db';
import { Crash, FaultyPorts, ProvisioningHarness, REQUESTER } from './provisioning-fixtures';

const STANDARD_PLAN = '00000000-0000-4000-9000-000000000001';
const KEY_ID = 'kid-provisioning';
const DAY_MS = 86_400_000;
const LATER_STEPS = PROVISIONING_STEPS.slice(5);

/** Lets the first caller of `list` wait for a second one (up to a short time), so that two processes can be made to look at the licenses together. */
class MeetingLicenses extends LicenseStore {
  private arrivals = 0;
  private meet: () => void = () => undefined;
  private readonly meeting = new Promise<void>((resolve) => {
    this.meet = resolve;
  });

  override async list(...args: Parameters<LicenseStore['list']>): ReturnType<LicenseStore['list']> {
    const rows = await super.list(...args);
    this.arrivals += 1;
    if (this.arrivals === 2) this.meet();
    else if (this.arrivals === 1) await Promise.race([this.meeting, new Promise<void>((resolve) => setTimeout(resolve, 600))]);
    return rows;
  }
}

class TestKeys implements LicenseKeyStore {
  available = true;
  private readonly pair = generateKeyPairSync('ed25519');
  readonly signer: LicenseSigner = new Ed25519LicenseSigner(KEY_ID, this.pair.privateKey);
  readonly publicKeyDer = this.pair.publicKey.export({ format: 'der', type: 'spki' });
  readonly publicKeyPem = this.pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();

  current(): Promise<LicenseSigner> {
    return this.available ? Promise.resolve(this.signer) : Promise.reject(new DomainError('SIGNING_KEY_UNAVAILABLE', 503));
  }

  publicKeys(): Promise<ReadonlyMap<string, Uint8Array>> {
    return Promise.resolve(new Map([[KEY_ID, this.publicKeyDer]]));
  }
}

describe('ProvisioningSaga, steps 6 to 11 (ST-SAS-006)', () => {
  const harness = new ProvisioningHarness();
  const keys = new TestKeys();
  let mailer: MockInvitationMailer;
  let services: ProvisioningServices;
  let ports: FaultyPorts;
  let licenses: LicenseStore;
  let delays: number[];

  const saga = (overrides: { registry?: TenantRegistry; services?: ProvisioningServices; delay?: (seconds: number) => Promise<void> } = {}): ProvisioningSaga => {
    const used = overrides.services ?? services;
    return new ProvisioningSaga(overrides.registry ?? harness.registry, ports, {
      steps: createProvisioningSteps(used),
      onCompleted: activationRecorder(used),
      delay:
        overrides.delay ??
        ((seconds) => {
          delays.push(seconds);
          return Promise.resolve();
        }),
    });
  };

  const requested = (overrides: { rootUnitName?: string; initialOwnerEmail?: string } = {}) => harness.request({ planVersionId: STANDARD_PLAN, ...overrides });

  const count = (sql: string, tenantId: string): Promise<number> => harness.count(sql, [tenantId]);

  /** Everything a finished run leaves, as numbers: the same after a crash and a resume as after a clean run. */
  async function footprint(tenantId: string): Promise<Record<string, number>> {
    const table = (name: string): Promise<number> => count(`select count(*) as n from machvon.${name} where tenant_id = $1`, tenantId);
    return {
      versions: await table('entitlement_version'),
      subscriptions: await table('subscription'),
      licenses: await table('license_revision'),
      roles: await table('role_definition'),
      units: await table('organization_unit'),
      themes: await table('tenant_theme_version'),
      pointers: await table('tenant_theme_pointer'),
      memberships: await table('membership'),
      grants: await table('role_grant'),
      pending: await count("select count(*) as n from machvon.membership_invitation where tenant_id = $1 and status = 'Pending'", tenantId),
    };
  }

  const stepStatus = async (tenantId: string, step: string): Promise<{ status: string; attempts: number; error_code?: string | null } | undefined> =>
    (await harness.registry.loadRun(tenantId, 1))?.steps[step as (typeof PROVISIONING_STEPS)[number]];

  beforeAll(async () => {
    await harness.start();
    const entitlements = new EntitlementStore(harness.tenants, new InMemoryEntitlementCache());
    licenses = new LicenseStore(entitlements);
    await harness.control.withControl((tx) =>
      licenses.registerSigningKey(tx, { keyId: KEY_ID, publicKeyPem: keys.publicKeyPem, kmsKeyRef: 'test', notBefore: new Date(Date.now() - 30 * DAY_MS), notAfter: new Date(Date.now() + 730 * DAY_MS) }),
    );
    mailer = new MockInvitationMailer();
    services = {
      control: harness.control,
      entitlements,
      licenses,
      keys,
      themes: new ThemeStore(),
      bootstrap: new TenantBootstrapStore(),
      audit: new AuditWriter(harness.tenants),
      mailer,
    };
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  beforeEach(() => {
    delays = [];
    ports = new FaultyPorts();
    keys.available = true;
  });

  describe('a full run', () => {
    it('ends with the tenant Active and everything a new tenant needs, every step recorded, and nothing of it unrecorded (AC-ST-SAS-006-1)', async () => {
      const { tenantId } = await requested({ rootUnitName: 'Ủy ban nhân dân tỉnh Kiểm Thử', initialOwnerEmail: 'Owner.One@Example.org' });
      expect(await saga().run(tenantId, 1)).toBe('Completed');

      const detail = await harness.registry.getDetail(tenantId);
      expect(detail?.tenant.status).toBe('Active');
      expect(detail?.run).toMatchObject({ status: 'Succeeded' });
      for (const step of PROVISIONING_STEPS) expect(detail?.run?.steps[step]).toMatchObject({ status: 'DONE', attempts: 1 });
      expect(await harness.count('select count(*) as n from machvon.tenant where id = $1 and activated_at is not null', [tenantId])).toBe(1);

      const sql = <T extends object>(text: string): Promise<T[]> => harness.admin((client) => client.query<T>(text, [tenantId]).then((result) => result.rows));
      expect(await sql("select version_no::int as n, cause from machvon.entitlement_version where tenant_id = $1 order by version_no")).toEqual([
        { n: 1, cause: 'PROVISIONING' },
        { n: 2, cause: 'LICENSE_CHANGE' },
      ]);
      expect(await sql("select status, plan_version_id, trial_ends_at is not null as trial from machvon.subscription where tenant_id = $1")).toEqual([{ status: 'Trialing', plan_version_id: STANDARD_PLAN, trial: true }]);
      const [license] = await sql<{ id: string; edition: string; status: string; signed_claims: string; valid_from: Date; valid_until: Date; grace_until: Date; entitlement_version_id: string; issued_by: string }>(
        'select id, edition, status, signed_claims, valid_from, valid_until, grace_until, entitlement_version_id, issued_by from machvon.license_revision where tenant_id = $1',
      );
      expect(license).toMatchObject({ edition: 'PILOT', status: 'Issued', issued_by: REQUESTER });
      expect(Math.round(((license?.valid_until.getTime() ?? 0) - (license?.valid_from.getTime() ?? 0)) / DAY_MS)).toBe(TRIAL_DAYS);
      expect(Math.round(((license?.grace_until.getTime() ?? 0) - (license?.valid_until.getTime() ?? 0)) / DAY_MS)).toBe(30);
      expect(verifyLicenseToken(license?.signed_claims ?? '', await keys.publicKeys(), tenantId).valid).toBe(true);
      expect(await sql<{ n: number }>("select count(*)::int as n from machvon.role_definition where tenant_id = $1 and is_system")).toEqual([{ n: SYSTEM_ROLES.length }]);
      expect(await sql("select code, name, unit_type, depth, parent_id from machvon.organization_unit where tenant_id = $1")).toEqual([
        { code: 'ROOT', name: 'Ủy ban nhân dân tỉnh Kiểm Thử', unit_type: 'GOVERNING_BODY', depth: 0, parent_id: null },
      ]);
      expect(await sql("select version::int as version, config_json->>'name' as name from machvon.tenant_theme_version where tenant_id = $1")).toEqual([{ version: 1, name: detail?.tenant.name }]);
      expect(await sql("select current_version::int as v from machvon.tenant_theme_pointer where tenant_id = $1")).toEqual([{ v: 1 }]);

      // The owner: invited into the root unit with the grant, one pending invitation whose token went to the mailer and only its hash is stored.
      expect(await sql("select status from machvon.membership where tenant_id = $1")).toEqual([{ status: 'Invited' }]);
      expect(await sql("select r.code, g.status from machvon.role_grant g join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id where g.tenant_id = $1 and r.code = 'TENANT_OWNER'")).toEqual([{ code: 'TENANT_OWNER', status: 'Active' }]);
      const message = mailer.lastTo('owner.one@example.org');
      expect(message).toMatchObject({ tenantId });
      const stored = await sql<{ token_hash: string; status: string }>("select token_hash, status from machvon.membership_invitation where tenant_id = $1");
      expect(stored).toEqual([{ token_hash: createHash('sha256').update(message?.token ?? '').digest('hex'), status: 'Pending' }]);

      // The record: audit rows and events of the steps and of the activation, none with a token, a key or an email.
      expect((await sql<{ action: string }>("select action from machvon.audit_event where tenant_id = $1 and outcome = 'SUCCESS' order by occurred_at")).map((row) => row.action)).toEqual([
        'license.issued',
        'tenant.owner_assigned',
        'tenant.activated',
      ]);
      const types = (await sql<{ type: string }>('select type from machvon.outbox_event where tenant_id = $1 order by created_at, id')).map((row) => row.type);
      for (const wanted of ['sas.entitlement.changed.v1', 'sas.license.issued.v1', 'iam.role_grant.created.v1', 'iam.membership.invited.v1', 'iam.access.changed.v1', 'sas.tenant.status_changed.v1']) expect(types).toContain(wanted);
      expect(await sql("select payload from machvon.outbox_event where tenant_id = $1 and type = 'sas.tenant.status_changed.v1'")).toEqual([{ payload: { tenant_id: tenantId, from: 'Provisioning', to: 'Active' } }]);
      const dump = JSON.stringify(await sql("select to_jsonb(a) as doc from machvon.audit_event a where tenant_id = $1 union all select to_jsonb(e) from machvon.outbox_event e where tenant_id = $1"));
      expect(dump).not.toContain(message?.token ?? 'missing');
      expect(dump).not.toContain('owner.one@example.org');
      expect(dump).not.toContain(license?.signed_claims ?? 'missing');
    });

    it('UAT-AC145 a new province tenant goes Requested, then Active with all 11 steps DONE: one organisation of the identity provider, the DNS record of its subdomain, the storage prefix of its id, entitlement version 1, a PILOT license Issued, the system roles, the root unit, theme 1 with its pointer, one owner invitation, and the audit rows of the request and the activation', async () => {
      const request = { planVersionId: STANDARD_PLAN, code: 'minh-ha', name: 'UBND tỉnh Minh Hà', governingBodyType: 'PROVINCE', administrativeCode: '99', platformSubdomain: 'minhha', rootUnitName: 'UBND tỉnh Minh Hà', initialOwnerEmail: 'owner@minhha.gov.vn' };
      const { tenantId, runId } = await harness.request(request);
      expect(await harness.registry.getTenant(tenantId)).toMatchObject({ status: 'Requested', code: 'minh-ha' });
      expect(await saga().run(tenantId, 1)).toBe('Completed');
      const detail = await harness.registry.getDetail(tenantId);
      expect(detail?.tenant).toMatchObject({ status: 'Active', code: 'minh-ha' });
      expect(detail?.run).toMatchObject({ id: runId, status: 'Succeeded' });
      expect(PROVISIONING_STEPS).toHaveLength(11);
      for (const step of PROVISIONING_STEPS) expect(detail?.run?.steps[step]).toMatchObject({ status: 'DONE' });
      // The identity provider got one organisation for the tenant, DNS its subdomain under the platform domain, storage the prefix of the tenant id.
      expect([...ports.organizations]).toEqual(['minh-ha']);
      expect([...ports.records]).toEqual(['minhha.machvon.vn']);
      expect([...ports.prefixes]).toEqual([`${tenantId}/`]);
      const sql = <T extends object>(text: string): Promise<T[]> => harness.admin((client) => client.query<T>(text, [tenantId]).then((result) => result.rows));
      expect(await sql("select version_no::int as n, cause from machvon.entitlement_version where tenant_id = $1 and version_no = 1")).toEqual([{ n: 1, cause: 'PROVISIONING' }]);
      expect(await sql("select edition, status from machvon.license_revision where tenant_id = $1")).toEqual([{ edition: 'PILOT', status: 'Issued' }]);
      // The roles the product seeds as system roles (the design counted 12 of them; the product has grown to its own list, all of which are present).
      const roles = (await sql<{ code: string }>('select code from machvon.role_definition where tenant_id = $1 and is_system order by code')).map((row) => row.code);
      expect(roles).toEqual(SYSTEM_ROLES.map((role) => role.code).sort());
      expect(roles.length).toBeGreaterThanOrEqual(12);
      expect(await sql("select unit_type, parent_id from machvon.organization_unit where tenant_id = $1")).toEqual([{ unit_type: 'GOVERNING_BODY', parent_id: null }]);
      expect(await sql("select version::int as version from machvon.tenant_theme_version where tenant_id = $1")).toEqual([{ version: 1 }]);
      expect(await sql("select current_version::int as v from machvon.tenant_theme_pointer where tenant_id = $1")).toEqual([{ v: 1 }]);
      // One invitation went to the owner, once.
      expect(mailer.sent.filter((message) => message.tenantId === tenantId)).toHaveLength(1);
      expect(await sql("select status from machvon.membership_invitation where tenant_id = $1")).toEqual([{ status: 'Pending' }]);
      expect((await sql<{ action: string }>("select action from machvon.audit_event where tenant_id = $1 and outcome = 'SUCCESS' order by occurred_at")).map((row) => row.action)).toContain('tenant.activated');
      // The negative control: a check that wants the tenant to be Failed must fail on this record.
      expect(() => expect(detail?.tenant).toMatchObject({ status: 'Failed' })).toThrow();
    });

    it('treats a redelivery of a finished run as done: nothing runs again', async () => {
      const { tenantId } = await requested();
      await saga().run(tenantId, 1);
      const before = await footprint(tenantId);
      const sent = mailer.sent.length;
      expect(await saga().run(tenantId, 1)).toBe('Completed');
      expect(await footprint(tenantId)).toEqual(before);
      expect(mailer.sent).toHaveLength(sent);
    });

    it('never makes the tenant Active while a step is still to run: a saga with the first ten steps leaves it Provisioning', async () => {
      const { tenantId } = await requested();
      const partial = new ProvisioningSaga(harness.registry, ports, { steps: createProvisioningSteps(services).slice(0, 10), onCompleted: activationRecorder(services), delay: () => Promise.resolve() });
      expect(await partial.run(tenantId, 1)).toBe('Completed');
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Provisioning');
      expect((await harness.registry.loadRun(tenantId, 1))?.currentStep).toBe('OWNER_INVITE');
      expect(await stepStatus(tenantId, 'OWNER_INVITE')).toMatchObject({ status: 'PENDING' });
      expect(await saga().run(tenantId, 1)).toBe('Completed');
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Active');
    });
  });

  describe('two processes that resume the same run', () => {
    it('issue one pilot license and one entitlement version 1, and both finish', async () => {
      const baseline = await requested();
      await saga().run(baseline.tenantId, 1);
      const clean = await footprint(baseline.tenantId);

      const { tenantId } = await requested();
      // The tenant is Provisioning and the first step is DONE, as it is for a run that a restarted worker picks up.
      const opener = new ProvisioningSaga(harness.registry, ports, { steps: createProvisioningSteps(services).slice(0, 1), delay: () => Promise.resolve() });
      await opener.run(tenantId, 1);
      const meeting: ProvisioningServices = { ...services, licenses: new MeetingLicenses(new EntitlementStore(harness.tenants, new InMemoryEntitlementCache())) };
      const outcomes = await Promise.all([saga({ services: meeting }).run(tenantId, 1), saga({ services: meeting }).run(tenantId, 1)]);
      expect(outcomes).toEqual(['Completed', 'Completed']);
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Active');
      expect(await footprint(tenantId)).toEqual(clean);
    });
  });

  describe('a process that dies', () => {
    it.each(LATER_STEPS.map((step) => [step] as const))('after %s ran but before it was recorded: the resumed run finishes with exactly what a clean run leaves', async (step) => {
      const baseline = await requested();
      await saga().run(baseline.tenantId, 1);
      const clean = await footprint(baseline.tenantId);

      const { tenantId } = await requested();
      let armed = true;
      // The registry the dying runner uses loses the process while it records that `step` is DONE: its effects are in the database, the record is not.
      const dying = Object.create(harness.registry) as TenantRegistry;
      dying.updateStep = async (...args: Parameters<TenantRegistry['updateStep']>): Promise<void> => {
        if (armed && args[2] === step && args[3].status === 'DONE') {
          armed = false;
          throw new Error('the process died');
        }
        return harness.registry.updateStep(...args);
      };
      await expect(saga({ registry: dying, delay: () => Promise.reject(new Crash('runner killed')) }).run(tenantId, 1)).rejects.toBeInstanceOf(Crash);
      expect(await stepStatus(tenantId, step)).toMatchObject({ status: 'RUNNING' });
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Provisioning');

      expect(await saga().run(tenantId, 1)).toBe('Completed');
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Active');
      expect(await footprint(tenantId)).toEqual(clean);
      for (const each of PROVISIONING_STEPS) expect(await stepStatus(tenantId, each)).toMatchObject({ status: 'DONE' });
    });

    it('resumes from the first step that is not DONE when the runner stopped between two steps, and runs no finished step again', async () => {
      const { tenantId } = await requested();
      const first = new ProvisioningSaga(harness.registry, ports, { steps: createProvisioningSteps(services).slice(0, 8), delay: () => Promise.resolve() });
      await first.run(tenantId, 1);
      const licensesBefore = await count('select count(*) as n from machvon.license_revision where tenant_id = $1', tenantId);
      const versions = await count('select count(*) as n from machvon.entitlement_version where tenant_id = $1', tenantId);
      expect(await saga().run(tenantId, 1)).toBe('Completed');
      expect(await count('select count(*) as n from machvon.license_revision where tenant_id = $1', tenantId)).toBe(licensesBefore);
      expect(await count('select count(*) as n from machvon.entitlement_version where tenant_id = $1', tenantId)).toBe(versions);
      expect((await stepStatus(tenantId, 'ENTITLEMENT_V1'))?.attempts).toBe(1);
    });
  });

  describe('a step that fails', () => {
    const failing = (step: (typeof PROVISIONING_STEPS)[number], failure: () => Error): ProvisioningServices => ({
      ...services,
      bootstrap: Object.assign(Object.create(services.bootstrap) as TenantBootstrapStore, {
        ensureRootUnit: (...args: Parameters<TenantBootstrapStore['ensureRootUnit']>) => (step === 'ROOT_UNIT' ? Promise.reject(failure()) : services.bootstrap.ensureRootUnit(...args)),
      }),
    });

    it('stops at step 9 with the run and the tenant Failed, keeps steps 6 to 8, and a retry starts there without repeating them (AC-ST-SAS-006-2)', async () => {
      const { tenantId } = await requested();
      const outcome = await saga({ services: failing('ROOT_UNIT', () => new DomainError('VALIDATION_FAILED', 422, 'root_unit_name')) }).run(tenantId, 1);
      expect(outcome).toBe('Failed');
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Failed');
      expect(await stepStatus(tenantId, 'ROOT_UNIT')).toMatchObject({ status: 'FAILED', error_code: 'VALIDATION_FAILED' });
      for (const step of ['ENTITLEMENT_V1', 'LICENSE_PILOT', 'ROLE_SEED'] as const) expect(await stepStatus(tenantId, step)).toMatchObject({ status: 'DONE' });
      for (const step of ['THEME_V1', 'OWNER_INVITE'] as const) expect(await stepStatus(tenantId, step)).toMatchObject({ status: 'PENDING' });
      expect(mailer.lastTo((await harness.registry.getDetail(tenantId))?.run?.request.initial_owner_email ?? '')).toBeUndefined();

      const tenant = await harness.registry.getTenant(tenantId);
      const retry = await harness.control.withTenantOf(PLATFORM_TENANT_ID, (tx) => harness.registry.startRetryRun(tx, tenantId, tenant?.version ?? 0, REQUESTER, PLATFORM_TENANT_ID, () => Promise.resolve()));
      expect(retry.attempt).toBe(2);
      expect(await saga().run(tenantId, 2)).toBe('Completed');
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Active');
      expect(await count('select count(*) as n from machvon.license_revision where tenant_id = $1', tenantId)).toBe(1);
      expect(await count('select count(*) as n from machvon.role_definition where tenant_id = $1', tenantId)).toBe(SYSTEM_ROLES.length);
      const run = await harness.registry.loadRun(tenantId, 2);
      expect(run?.steps.ENTITLEMENT_V1.attempts).toBe(1);
      expect(run?.steps.ROOT_UNIT).toMatchObject({ status: 'DONE', attempts: 1 });
    });

    it('UAT-AC146 a DNS provider that is down stops the run at DNS_SUBDOMAIN with PROVIDER_UNAVAILABLE after its tries and the tenant is Failed, and the retry opens attempt 2 at DNS_SUBDOMAIN without repeating the identity provider step (still one organisation) and ends with the tenant Active', async () => {
      const { tenantId } = await harness.request({ planVersionId: STANDARD_PLAN, code: 'lam-son', name: 'UBND tỉnh Lam Sơn', platformSubdomain: 'lamson', initialOwnerEmail: 'owner@lamson.gov.vn' });
      // The DNS provider answers 503: the adapter reports it as a provider failure, which the saga retries after 10 s, 1 min and 5 min (the policy of SAS 3.1 step 5 is four tries, one more than the three of the design text).
      const dns = ports.dns as { ensureRecord: (hostname: string) => Promise<void> };
      const healthy = dns.ensureRecord;
      let providerDown = true;
      dns.ensureRecord = (hostname) => (providerDown ? Promise.reject(Object.assign(new Error('503 from the DNS provider'), { code: 'PROVIDER_UNAVAILABLE' })) : healthy(hostname));
      expect(await saga().run(tenantId, 1)).toBe('Failed');
      expect(delays).toEqual([10, 60, 300]);
      const failed = await harness.registry.getDetail(tenantId);
      expect(failed?.tenant.status).toBe('Failed');
      expect(failed?.run).toMatchObject({ status: 'Failed', errorCode: 'PROVIDER_UNAVAILABLE', currentStep: 'DNS_SUBDOMAIN' });
      expect(failed?.run?.steps.DNS_SUBDOMAIN).toMatchObject({ status: 'FAILED', attempts: 4, error_code: 'PROVIDER_UNAVAILABLE' });
      expect(failed?.run?.steps.IDP_ORG).toMatchObject({ status: 'DONE', attempts: 1 });
      expect([...ports.organizations]).toEqual(['lam-son']);
      // The provider is back; the operator retries (If-Match is the version read).
      providerDown = false;
      const tenant = await harness.registry.getTenant(tenantId);
      const retry = await harness.control.withTenantOf(PLATFORM_TENANT_ID, (tx) => harness.registry.startRetryRun(tx, tenantId, tenant?.version ?? 0, REQUESTER, PLATFORM_TENANT_ID, () => Promise.resolve()));
      expect(retry.attempt).toBe(2);
      const idpCalls = ports.callsTo('idp.ensureOrganization');
      expect(await saga().run(tenantId, 2)).toBe('Completed');
      // Attempt 2 starts at the failed step: the steps before it are carried over as DONE and the identity provider is not called again.
      expect(ports.callsTo('idp.ensureOrganization')).toBe(idpCalls);
      expect([...ports.organizations]).toEqual(['lam-son']);
      expect([...ports.records]).toEqual(['lamson.machvon.vn']);
      const second = await harness.registry.loadRun(tenantId, 2);
      expect(second?.steps.IDP_ORG).toMatchObject({ status: 'DONE', attempts: 1 });
      expect(second?.steps.DNS_SUBDOMAIN).toMatchObject({ status: 'DONE', attempts: 1 });
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Active');
      expect((await harness.registry.loadRun(tenantId, 1))?.status).toBe('Failed');
      // The negative control: a check that wants three tries must fail on the four that were made.
      expect(() => expect(failed?.run?.steps.DNS_SUBDOMAIN).toMatchObject({ attempts: 3 })).toThrow();
    });

    it('retries an infrastructure failure of the mailer after 10 s and sends one invitation that is pending', async () => {
      const { tenantId } = await requested({ initialOwnerEmail: 'retry.owner@example.org' });
      let failures = 1;
      const flaky: ProvisioningServices = {
        ...services,
        mailer: {
          send: (message) => {
            if (failures > 0) {
              failures -= 1;
              return Promise.reject(Object.assign(new Error('smtp down'), { code: 'MAIL_UNAVAILABLE' }));
            }
            return mailer.send(message);
          },
        },
      };
      expect(await saga({ services: flaky }).run(tenantId, 1)).toBe('Completed');
      expect(delays).toEqual([10]);
      expect((await stepStatus(tenantId, 'OWNER_INVITE'))?.attempts).toBe(2);
      expect((await footprint(tenantId)).pending).toBe(1);
      expect(await count("select count(*) as n from machvon.membership_invitation where tenant_id = $1 and status = 'Revoked'", tenantId)).toBe(1);
      expect(mailer.lastTo('retry.owner@example.org')).toBeDefined();
    });

    it('fails step 7 without a signing key, and finishes when a retry finds one', async () => {
      const { tenantId } = await requested();
      keys.available = false;
      expect(await saga().run(tenantId, 1)).toBe('Failed');
      expect(await stepStatus(tenantId, 'LICENSE_PILOT')).toMatchObject({ status: 'FAILED', error_code: 'SIGNING_KEY_UNAVAILABLE' });
      expect(await count('select count(*) as n from machvon.license_revision where tenant_id = $1', tenantId)).toBe(0);
      keys.available = true;
      const tenant = await harness.registry.getTenant(tenantId);
      await harness.control.withTenantOf(PLATFORM_TENANT_ID, (tx) => harness.registry.startRetryRun(tx, tenantId, tenant?.version ?? 0, REQUESTER, PLATFORM_TENANT_ID, () => Promise.resolve()));
      expect(await saga().run(tenantId, 2)).toBe('Completed');
      expect(await count('select count(*) as n from machvon.license_revision where tenant_id = $1', tenantId)).toBe(1);
    });
  });

  describe('the final activation', () => {
    const failingCompletion = (failures: number): TenantRegistry => {
      let remaining = failures;
      const flaky = Object.create(harness.registry) as TenantRegistry;
      flaky.completeRun = (...args: Parameters<TenantRegistry['completeRun']>): Promise<void> => {
        if (remaining > 0) {
          remaining -= 1;
          return Promise.reject(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
        }
        return harness.registry.completeRun(...args);
      };
      return flaky;
    };

    it('is retried like a step: a transient failure delays the tenant becoming Active by one back-off and nothing else', async () => {
      const { tenantId } = await requested();
      expect(await saga({ registry: failingCompletion(1) }).run(tenantId, 1)).toBe('Completed');
      expect(delays).toEqual([10]);
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Active');
      expect((await harness.registry.loadRun(tenantId, 1))?.status).toBe('Succeeded');
    });

    it('fails the run and the tenant when every retry failed, and a retry run activates the tenant without repeating a step', async () => {
      const { tenantId } = await requested();
      expect(await saga({ registry: failingCompletion(99) }).run(tenantId, 1)).toBe('Failed');
      expect(delays).toEqual([10, 60, 300]);
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Failed');
      expect(await harness.registry.loadRun(tenantId, 1)).toMatchObject({ status: 'Failed', errorCode: 'ACTIVATION_FAILED' });

      const tenant = await harness.registry.getTenant(tenantId);
      await harness.control.withTenantOf(PLATFORM_TENANT_ID, (tx) => harness.registry.startRetryRun(tx, tenantId, tenant?.version ?? 0, REQUESTER, PLATFORM_TENANT_ID, () => Promise.resolve()));
      expect(await saga().run(tenantId, 2)).toBe('Completed');
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Active');
      expect(await count('select count(*) as n from machvon.license_revision where tenant_id = $1', tenantId)).toBe(1);
    });

    it('does not retry a refusal of the system: a run that is no longer the running attempt leaves the tenant Provisioning', async () => {
      const { tenantId } = await requested();
      const stale = Object.create(harness.registry) as TenantRegistry;
      stale.completeRun = (tenant, run, hook) => harness.registry.completeRun(tenant, '00000000-0000-4000-8000-0000000fffee', hook);
      await expect(saga({ registry: stale }).run(tenantId, 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(delays).toEqual([]);
      expect((await harness.registry.getTenant(tenantId))?.status).toBe('Provisioning');
    });
  });

  describe('provisioning cancelled', () => {
    it('undoes the steps in reverse order: the owner invitation and the license are revoked, the rest stays with the tenant', async () => {
      const { tenantId } = await requested();
      await saga().run(tenantId, 1);
      const order: string[] = [];
      const watching = Object.create(harness.registry) as TenantRegistry;
      watching.updateStep = (...args: Parameters<TenantRegistry['updateStep']>): Promise<void> => {
        if (args[3].status === 'COMPENSATED') order.push(args[2]);
        return harness.registry.updateStep(...args);
      };
      await saga({ registry: watching }).compensate(tenantId, 1);
      expect(order).toEqual([...PROVISIONING_STEPS].reverse());
      expect(await harness.count("select count(*) as n from machvon.license_revision where tenant_id = $1 and status = 'Revoked'", [tenantId])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.membership_invitation where tenant_id = $1 and status = 'Pending'", [tenantId])).toBe(0);
      expect(await harness.count("select count(*) as n from machvon.membership where tenant_id = $1 and status = 'Ended'", [tenantId])).toBe(1);
      expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and action = 'license.revoked'", [tenantId])).toBe(1);
      expect(await footprint(tenantId)).toMatchObject({ roles: SYSTEM_ROLES.length, units: 1, themes: 1 });
    });

    it('leaves steps that never ran alone, and revokes nothing for a tenant that has no license yet', async () => {
      const { tenantId } = await requested();
      const partial = new ProvisioningSaga(harness.registry, ports, { steps: createProvisioningSteps(services).slice(0, 6), delay: () => Promise.resolve() });
      await partial.run(tenantId, 1);
      await saga().compensate(tenantId, 1);
      expect(await stepStatus(tenantId, 'LICENSE_PILOT')).toMatchObject({ status: 'PENDING' });
      expect(await stepStatus(tenantId, 'ENTITLEMENT_V1')).toMatchObject({ status: 'COMPENSATED' });
      expect(await harness.count('select count(*) as n from machvon.audit_event where tenant_id = $1', [tenantId])).toBe(0);
    });
  });

  describe('the owner step on its own', () => {
    it('sends nothing when the person already owns the tenant', async () => {
      const { tenantId } = await requested({ initialOwnerEmail: 'accepted.owner@example.org' });
      await saga().run(tenantId, 1);
      await harness.admin((client) => client.query("update machvon.membership set status = 'Active' where tenant_id = $1", [tenantId]));
      const detail = await harness.registry.getDetail(tenantId);
      const sent = mailer.sent.length;
      const step = provisioningStepDefinitions(services).find((definition) => definition.step === 'OWNER_INVITE');
      if (detail?.run === undefined || step === undefined) throw new Error('run or step missing');
      await step.execute({ tenant: detail.tenant, run: detail.run, ports, registry: harness.registry });
      expect(mailer.sent).toHaveLength(sent);
      expect((await footprint(tenantId)).memberships).toBe(1);
    });

    it('lets any other refusal of the step stand', async () => {
      const { tenantId } = await requested({ initialOwnerEmail: 'suspended.owner@example.org' });
      await saga().run(tenantId, 1);
      await harness.admin((client) => client.query("update machvon.membership set status = 'Suspended' where tenant_id = $1", [tenantId]));
      const detail = await harness.registry.getDetail(tenantId);
      const step = provisioningStepDefinitions(services).find((definition) => definition.step === 'OWNER_INVITE');
      if (detail?.run === undefined || step === undefined) throw new Error('run or step missing');
      await expect(step.execute({ tenant: detail.tenant, run: detail.run, ports, registry: harness.registry })).rejects.toMatchObject({ code: 'MEMBERSHIP_STATE_INVALID' });
    });

    it('seeds a first theme that fits the theme contract even when the tenant name is longer than any theme text', () => {
      const long = Array.from('Ủy ban nhân dân tỉnh Cao Bằng '.repeat(10)).slice(0, 255).join('');
      expect(Array.from(long)).toHaveLength(255);
      // The contract schema is the judge: a name of that length is refused as a theme text, so the seeded texts must be shorter.
      expect(requestSchemaOf('putSystemTenantThemeDraft')).toBeDefined();
      expect(validateRequestBody('putSystemTenantThemeDraft', { ...defaultTenantTheme('Cao Bằng'), name: long })).not.toEqual([]);
      const theme = defaultTenantTheme(long);
      expect(validateRequestBody('putSystemTenantThemeDraft', theme)).toEqual([]);
      expect(Array.from(theme.name ?? '').length).toBeLessThanOrEqual(160);
      expect(theme).toMatchObject({ name: theme.title, header: theme.title });
      expect(long.startsWith(theme.name ?? 'missing')).toBe(true);
      expect(() => assertValidTheme(theme as unknown as Parameters<typeof assertValidTheme>[0])).not.toThrow();
    });

    it('seeds a first theme that the theme validation accepts', () => {
      expect(() => assertValidTheme(defaultTenantTheme('Cao Bằng') as unknown as Parameters<typeof assertValidTheme>[0])).not.toThrow();
      expect(defaultTenantTheme('Cao Bằng')).toMatchObject({ name: 'Cao Bằng', header: 'Cao Bằng', logoAssetId: null });
    });
  });
});
