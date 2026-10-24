import { randomUUID } from 'node:crypto';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { CtrContractStore, contractScope } from '../src/ctr-contract-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { CtrGuaranteeExpiry } from '../src/ctr-guarantee-expiry';
import { CtrGuaranteeStore, thresholdFor } from '../src/ctr-guarantee-store';
import type { GuaranteeMove, NewGuarantee } from '../src/ctr-guarantee-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedCtrWorld } from './support/ctr-fixtures';
import type { CtrWorld } from './support/ctr-fixtures';

const harness = new AuthzHarness();
const contracts = new CtrContractStore();
const guarantees = new CtrGuaranteeStore();
const OFFICER = 1; // registers and extends
const ACCOUNTANT = 2; // verifies and releases
const JOB = 9;
const MANAGE = 'guarantee.manage';
const VERIFY = 'guarantee.verify';
const RELEASE = 'guarantee.release';
const READ = 'guarantee.read';
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0x95;
const NOW = new Date('2026-10-24T03:00:00Z');
const TODAY_SCOPE_NOW = new Date();

let world: CtrWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = OFFICER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(OFFICER),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const scopesFor = (permission: string, scope: Scope = { kind: 'TENANT' }): ContractScopes => ({
  update: contractScope(grant(permission, scope), permission, TODAY_SCOPE_NOW),
  read: contractScope(grant(READ, { kind: 'TENANT' }), READ, TODAY_SCOPE_NOW),
});
const readScope = (scope: Scope = { kind: 'TENANT' }) => contractScope(grant(READ, scope), READ, TODAY_SCOPE_NOW);

async function draft(value = '10000000000'): Promise<string> {
  counter += 1;
  const created = await as((tx) =>
    contracts.create(
      tx,
      {
        projectId: world.project,
        packageId: world.packageId,
        contractorId: world.lead,
        code: `HD-G-${String(counter).padStart(3, '0')}`,
        title: 'Construction of the bridge',
        type: 'UNIT_PRICE',
        advanceCategory: 'CONSTRUCTION',
        contractValueVnd: value,
        documentVersionId: world.document,
      },
      memberId(OFFICER),
      '2026-10-24',
    ),
  );
  return created.id;
}

const newGuarantee = (extra: Partial<NewGuarantee> = {}): NewGuarantee => {
  counter += 1;
  return {
    kind: 'PERFORMANCE',
    issuer: 'Bank of the Province',
    guaranteeNo: `BL-${String(counter).padStart(4, '0')}`,
    amountVnd: '500000000',
    validFrom: '2026-10-01',
    expiresAt: '2028-12-31T16:59:00Z',
    documentVersionId: world.document,
    ...extra,
  };
};
const register = (contractId: string, extra: Partial<NewGuarantee> = {}, scopes = scopesFor(MANAGE), member = OFFICER, now = NOW) =>
  as((tx) => guarantees.register(tx, contractId, newGuarantee(extra), memberId(member), scopes, now), TENANT_A, member);
const verify = (id: string, version: number, outcome = 'VERIFIED', member = ACCOUNTANT, evidence = world.evidence, scopes = scopesFor(VERIFY)) =>
  as((tx) => guarantees.verify(tx, id, version, { outcome, method: 'Letter to the issuer, confirmed by phone', evidenceDocumentVersionId: evidence }, memberId(member), scopes, NOW), TENANT_A, member);
const extend = (id: string, version: number, extra: Partial<{ newExpiresAt: string; newGuaranteeNo: string; documentVersionId: string }> = {}, member = OFFICER) => {
  counter += 1;
  return as(
    (tx) =>
      guarantees.extend(tx, id, version, { newExpiresAt: '2029-06-30T16:59:00Z', newGuaranteeNo: `BL-X-${counter}`, documentVersionId: world.document, ...extra }, memberId(member), scopesFor(MANAGE), NOW),
    TENANT_A,
    member,
  );
};
const release = (id: string, version: number, evidence = world.evidence, member = ACCOUNTANT, now = NOW) =>
  as((tx) => guarantees.release(tx, id, version, { releaseEvidenceId: evidence, reason: 'Obligation completed' }, memberId(member), scopesFor(RELEASE), now), TENANT_A, member);
const active = async (contractId: string, extra: Partial<NewGuarantee> = {}): Promise<GuaranteeMove> => {
  const registered = await register(contractId, extra);
  return verify(registered.id, 1);
};
const row = async (id: string) => (await owner<Record<string, unknown>>('select * from machvon.guarantee where id = $1::uuid', [id]))[0];
const events = (id: string) => owner<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1::uuid order by created_at, id', [id]);

describe('CtrGuaranteeStore (guarantees: register, verify, extend by replacement, release, ST-CTR-003)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      for (const n of [OFFICER, ACCOUNTANT, JOB]) await harness.seedMembership(tenant, n, PROVINCE);
    }
    world = await seedCtrWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the lifecycle (AC-ST-CTR-003-1)', () => {
    it('refuses self-verification, verifies by another person, extends by replacement and releases only against evidence', async () => {
      const contract = await draft();
      const registered = await register(contract, { guaranteeNo: 'BL-A-002', expiresAt: '2026-12-31T16:59:00Z' });
      expect(registered).toMatchObject({ status: 'PENDING_VERIFICATION', version: 1, kind: 'PERFORMANCE', amountVnd: '500000000', expiresAt: '2026-12-31T16:59:00.000Z', fromStatus: null });
      expect(await row(registered.id)).toMatchObject({ status: 'PENDING_VERIFICATION', verification_status: 'UNVERIFIED', currency: 'VND', created_by: memberId(OFFICER), verified_by: null });

      expect(await refusal(verify(registered.id, 1, 'VERIFIED', OFFICER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await row(registered.id)).toMatchObject({ status: 'PENDING_VERIFICATION', version: '1' });

      const verified = await verify(registered.id, 1);
      expect(verified).toMatchObject({ status: 'ACTIVE', version: 2, fromStatus: 'PENDING_VERIFICATION' });
      expect(await row(registered.id)).toMatchObject({
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
        verified_by: memberId(ACCOUNTANT),
        verification_method: 'Letter to the issuer, confirmed by phone',
        verification_evidence_id: world.evidence,
      });

      const replacement = await extend(registered.id, 2);
      expect(replacement).toMatchObject({ status: 'PENDING_VERIFICATION', version: 1, supersededId: registered.id, expiresAt: '2029-06-30T16:59:00.000Z', amountVnd: '500000000', kind: 'PERFORMANCE' });
      expect(await row(registered.id)).toMatchObject({ status: 'SUPERSEDED', version: '3' });
      expect(new Date((await row(registered.id))?.expires_at as string).toISOString()).toBe('2026-12-31T16:59:00.000Z');
      expect(await row(replacement.id)).toMatchObject({ status: 'PENDING_VERIFICATION', extended_from_id: registered.id, guarantee_no: expect.stringMatching(/^BL-X-/), issuer: 'Bank of the Province', amount_vnd: '500000000' });

      await verify(replacement.id, 1, 'VERIFIED', ACCOUNTANT);
      // The evidence is what a release is: without it the release is refused and the guarantee stays as it was.
      expect(await refusal(release(replacement.id, 2, ''))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'release_evidence_id' });
      expect(await refusal(release(replacement.id, 2, randomUUID()))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'release_evidence_id' });
      expect(await row(replacement.id)).toMatchObject({ status: 'ACTIVE', released_at: null });
      // The person who registered the replacement is the officer who extended it: the accountant releases.
      const released = await release(replacement.id, 2);
      expect(released).toMatchObject({ status: 'RELEASED', version: 3, fromStatus: 'ACTIVE' });
      const final = await row(replacement.id);
      expect(final).toMatchObject({ status: 'RELEASED', release_evidence_id: world.evidence, released_by: memberId(ACCOUNTANT), release_reason: 'Obligation completed' });
      expect(final?.released_at).not.toBeNull();
    });

    it('refuses the release by the person who registered the guarantee, a state that cannot be released, and a stale version', async () => {
      const contract = await draft();
      const registered = await register(contract);
      await verify(registered.id, 1);
      expect(await refusal(release(registered.id, 2, world.evidence, OFFICER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(release(registered.id, 1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 2 } });
      const pending = await register(contract);
      expect(await refusal(release(pending.id, 1))).toEqual({ code: 'GUARANTEE_STATE_INVALID', status: 409 });
      const done = await release(registered.id, 2);
      expect(done.status).toBe('RELEASED');
      expect(await refusal(release(registered.id, 3))).toEqual({ code: 'GUARANTEE_STATE_INVALID', status: 409 });
      expect(await refusal(extend(registered.id, 3))).toEqual({ code: 'GUARANTEE_STATE_INVALID', status: 409 });
    });

    it('rejects a guarantee whose verification failed, once, and keeps the check with its method and evidence', async () => {
      const contract = await draft();
      const registered = await register(contract);
      const failed = await verify(registered.id, 1, 'FAILED');
      expect(failed).toMatchObject({ status: 'REJECTED', version: 2 });
      expect(await row(registered.id)).toMatchObject({ status: 'REJECTED', verification_status: 'FAILED', verified_by: memberId(ACCOUNTANT), verification_evidence_id: world.evidence });
      expect(await refusal(verify(registered.id, 2))).toEqual({ code: 'GUARANTEE_STATE_INVALID', status: 409 });
      expect(await refusal(verify(registered.id, 2, 'MAYBE'))).toEqual({ code: 'GUARANTEE_STATE_INVALID', status: 409 });
      const next = await register(contract);
      expect(await refusal(verify(next.id, 1, 'MAYBE'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'outcome' });
      expect(await refusal(verify(next.id, 1, 'VERIFIED', ACCOUNTANT, randomUUID()))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'evidence_document_version_id' });
      expect(await refusal(as((tx) => guarantees.verify(tx, next.id, 1, { outcome: 'VERIFIED', method: '  ', evidenceDocumentVersionId: world.evidence }, memberId(ACCOUNTANT), scopesFor(VERIFY), NOW), TENANT_A, ACCOUNTANT))).toEqual({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'method',
      });
    });

    it('lets one replacement stand for a guarantee, and a failed replacement frees the place only for a new registration', async () => {
      const contract = await draft();
      const first = await active(contract);
      const replacement = await extend(first.id, 2);
      expect(await refusal(extend(first.id, 3))).toEqual({ code: 'GUARANTEE_STATE_INVALID', status: 409 });
      await verify(replacement.id, 1, 'FAILED');
      expect(await row(replacement.id)).toMatchObject({ status: 'REJECTED' });
      expect(await row(first.id)).toMatchObject({ status: 'SUPERSEDED' });
    });

    it('refuses an extension that does not go beyond the expiry, a number the issuer already used, and a document that does not exist', async () => {
      const contract = await draft();
      const first = await active(contract, { guaranteeNo: 'BL-EXT-1', expiresAt: '2028-12-31T16:59:00Z' });
      expect(await refusal(extend(first.id, 2, { newExpiresAt: '2028-12-31T16:59:00Z' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_expires_at' });
      expect(await refusal(extend(first.id, 2, { newExpiresAt: '2028-12-01T00:00:00Z' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_expires_at' });
      expect(await refusal(extend(first.id, 2, { newExpiresAt: 'tomorrow' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_expires_at' });
      expect(await refusal(extend(first.id, 2, { newGuaranteeNo: 'BL-EXT-1' }))).toEqual({ code: 'GUARANTEE_DUPLICATE', status: 409, detail: 'guarantee_no' });
      expect(await refusal(extend(first.id, 2, { documentVersionId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'document_version_id' });
      expect(await refusal(extend(first.id, 2, { newGuaranteeNo: '  ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_guarantee_no' });
      expect(await row(first.id)).toMatchObject({ status: 'ACTIVE', version: '2' });
    });
  });

  describe('registering', () => {
    it('stores the guarantee as typed after trimming, in lower case ids, and refuses the same number of the same issuer', async () => {
      const contract = await draft();
      const registered = await register(contract, { issuer: '  Bank of the Province ', guaranteeNo: '  BL-TRIM-1  ', documentVersionId: world.document.toUpperCase(), amountVnd: '000500' });
      expect(await row(registered.id)).toMatchObject({ issuer: 'Bank of the Province', guarantee_no: 'BL-TRIM-1', amount_vnd: '500', document_version_id: world.document });
      expect(await refusal(register(contract, { guaranteeNo: 'BL-TRIM-1' }))).toEqual({ code: 'GUARANTEE_DUPLICATE', status: 409, detail: 'guarantee_no' });
      expect((await register(contract, { guaranteeNo: 'BL-TRIM-1', issuer: 'Another bank' })).status).toBe('PENDING_VERIFICATION');
    });

    it('refuses what is not a guarantee: a kind, an issuer, an amount, dates, a member that is not on the contract, a document that does not exist', async () => {
      const contract = await draft();
      const fault = async (extra: Partial<NewGuarantee>) => (await refusal(register(contract, extra))).detail;
      expect(await fault({ kind: 'BOND' })).toBe('kind');
      expect(await fault({ issuer: ' ' })).toBe('issuer');
      expect(await fault({ issuer: 'I'.repeat(301) })).toBe('issuer');
      expect(await fault({ guaranteeNo: 'N'.repeat(101) })).toBe('guarantee_no');
      expect(await fault({ amountVnd: '0' })).toBe('amount_vnd');
      expect(await fault({ amountVnd: '10.5' })).toBe('amount_vnd');
      expect(await fault({ amountVnd: '9'.repeat(25) })).toBe('amount_vnd');
      expect(await fault({ validFrom: '2026-02-30' })).toBe('valid_from');
      expect(await fault({ expiresAt: '2026-12-31' })).toBe('expires_at');
      expect(await fault({ expiresAt: '2026-13-31T00:00:00Z' })).toBe('expires_at');
      expect(await fault({ validFrom: '2027-01-01', expiresAt: '2026-12-31T16:59:00Z' })).toBe('expires_at');
      expect(await fault({ expiresAt: '2026-10-24T02:59:59Z' })).toBe('expires_at');
      expect(await fault({ partyId: randomUUID() })).toBe('party_id');
      expect(await fault({ documentVersionId: randomUUID() })).toBe('document_version_id');
      expect(await owner('select 1 from machvon.guarantee where contract_id = $1::uuid', [contract])).toEqual([]);
    });

    it('takes a member of the joint venture and keeps it on the guarantee and its replacement', async () => {
      const venture = (
        await as((tx) =>
          contracts.create(tx, { projectId: world.project, packageId: world.packageId, contractorId: world.lead, code: 'HD-G-JV', title: 'JV', type: 'UNIT_PRICE', advanceCategory: 'CONSTRUCTION', isJointVenture: true, contractValueVnd: '10000000000', documentVersionId: world.document }, memberId(OFFICER), '2026-10-24'),
        )
      ).id;
      const parties = await owner<{ id: string }>(
        `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'LEAD', 100, 10000000000, 'ACTIVE', date '2026-10-24', $4::uuid, $4::uuid) returning id`,
        [randomUUID(), venture, world.lead, memberId(OFFICER)],
      );
      const partyId = parties[0]?.id ?? '';
      const registered = await register(venture, { partyId: partyId.toUpperCase() });
      expect(await row(registered.id)).toMatchObject({ party_id: partyId });
      const done = await verify(registered.id, 1);
      const replacement = await extend(registered.id, done.version);
      expect(await row(replacement.id)).toMatchObject({ party_id: partyId });
      const listed = await as((tx) => guarantees.find(tx, replacement.id, readScope()));
      expect(listed).toMatchObject({ partyId, partyContractorId: world.lead, partyName: 'Lead Builders' });
    });

    it('refuses a contract that ended or never began, one outside the scope, and one of another tenant', async () => {
      const ended = await draft();
      await owner("update machvon.contract set status = 'CANCELLED' where id = $1::uuid", [ended]);
      expect(await refusal(register(ended))).toEqual({ code: 'CONTRACT_STATE_INVALID', status: 409 });
      const live = await draft();
      const elsewhere = scopesFor(MANAGE, { kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] });
      expect(await refusal(register(live, {}, elsewhere))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      const blind: ContractScopes = { update: elsewhere.update, read: readScope({ kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] }) };
      expect(await refusal(register(live, {}, blind))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => guarantees.register(tx, live, newGuarantee(), memberId(OFFICER), scopesFor(MANAGE), NOW), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(register(randomUUID()))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('releasing an advance guarantee while an advance is owed', () => {
    it('keeps it until the advance is recovered or another active advance guarantee covers what is owed (RELEASE_CONDITION_NOT_MET)', async () => {
      const contract = await draft('10000000000');
      await owner('update machvon.contract set advance_paid_vnd = 2000000000, advance_recovered_vnd = 750000000 where id = $1::uuid', [contract]);
      const advance = await active(contract, { kind: 'ADVANCE', amountVnd: '2000000000' });
      expect(await refusal(release(advance.id, 2))).toEqual({
        code: 'RELEASE_CONDITION_NOT_MET',
        status: 422,
        detail: 'advance_outstanding_vnd',
        extensions: { advance_outstanding_vnd: '1250000000' },
      });
      // A smaller guarantee does not cover what is owed; one that does, does.
      await active(contract, { kind: 'ADVANCE', amountVnd: '1000000000' });
      expect((await refusal(release(advance.id, 2))).code).toBe('RELEASE_CONDITION_NOT_MET');
      await active(contract, { kind: 'ADVANCE', amountVnd: '1250000000' });
      expect((await release(advance.id, 2)).status).toBe('RELEASED');
      const recovered = await draft('10000000000');
      const other = await active(recovered, { kind: 'ADVANCE' });
      expect((await release(other.id, 2)).status).toBe('RELEASED');
    });

    it('releases a performance guarantee of a contract in force, on evidence and by another person, and an expired one', async () => {
      const contract = await draft();
      const performance = await active(contract);
      expect((await release(performance.id, 2)).status).toBe('RELEASED');
      const lapsed = await active(contract, { expiresAt: '2026-10-25T16:59:00Z' });
      await as((tx) => new CtrGuaranteeExpiry(new AuditWriter(harness.tenants)).run(tx, memberId(JOB), new Date('2026-10-26T00:00:00Z')));
      expect(await row(lapsed.id)).toMatchObject({ status: 'EXPIRED' });
      expect((await release(lapsed.id, 3)).status).toBe('RELEASED');
    });
  });

  describe('the job guarantee-expiry (AC-ST-CTR-003-2)', () => {
    // 06:00 in Vietnam on the day is 23:00 UTC of the day before.
    const at = (day: string): Date => new Date(new Date(`${day}T06:00:00+07:00`).getTime());
    // The audit writer needs the database, which exists once the harness has started.
    const jobOf = (): CtrGuaranteeExpiry => new CtrGuaranteeExpiry(new AuditWriter(harness.tenants));
    const run = (day: string, tenant = TENANT_A) => as((tx) => jobOf().run(tx, memberId(JOB), at(day)), tenant, JOB);

    it('reminds an advance guarantee 3 times, once at 30, 15 and 7 days, expires it the day after, and opens the case for the issue once (AC-ST-CTR-003-2)', async () => {
      const contract = await draft('10000000000');
      await owner('update machvon.contract set advance_paid_vnd = 2000000000, advance_recovered_vnd = 750000000 where id = $1::uuid', [contract]);
      const advance = await active(contract, { kind: 'ADVANCE', amountVnd: '2000000000', guaranteeNo: 'BL-A-001', expiresAt: '2026-12-01T16:59:00Z' });
      const expiresBefore = (await row(advance.id))?.expires_at;

      expect(await run('2026-10-30')).toMatchObject({ alerted: 0, expired: 0 });
      const first = await run('2026-11-01');
      expect(first).toMatchObject({ alerted: 1, expired: 0, expiring: { 30: 1, 15: 0, 7: 0, 0: 0 }, advanceAtRisk: 1 });
      expect((await row(advance.id))?.last_alert_days).toBe(30);
      expect(await run('2026-11-16')).toMatchObject({ alerted: 1 });
      expect((await row(advance.id))?.last_alert_days).toBe(15);
      expect(await run('2026-11-24')).toMatchObject({ alerted: 1, expiring: { 30: 1, 15: 1, 7: 1, 0: 0 } });
      expect((await row(advance.id))?.last_alert_days).toBe(7);
      expect(await run('2026-11-24')).toMatchObject({ alerted: 0, expired: 0 });

      const reminders = (await events(advance.id)).filter((event) => event.type === 'ctr.guarantee.expiring.v1');
      expect(reminders.map((event) => event.payload.threshold_days)).toEqual([30, 15, 7]);
      expect(reminders.map((event) => event.payload.days_left)).toEqual([30, 15, 7]);
      expect(reminders[0]?.payload).toMatchObject({ guarantee_id: advance.id, contract_id: contract, kind: 'ADVANCE', expires_on: '2026-12-01', notification: { resource: { type: 'guarantee', id: advance.id, contractId: contract } } });
      expect(JSON.stringify(reminders[0]?.payload)).not.toContain('BL-A-001');
      // The status stays ACTIVE until the day is over, and the expiry is never moved.
      expect(await row(advance.id)).toMatchObject({ status: 'ACTIVE' });
      expect(await run('2026-12-01')).toMatchObject({ alerted: 1, expired: 0, expiring: { 30: 1, 15: 1, 7: 1, 0: 1 } });
      expect((await row(advance.id))?.last_alert_days).toBe(0);

      const lapsed = await run('2026-12-02');
      expect(lapsed).toMatchObject({ alerted: 0, expired: 1 });
      expect(await row(advance.id)).toMatchObject({ status: 'EXPIRED', verification_status: 'VERIFIED' });
      expect((await row(advance.id))?.expires_at).toEqual(expiresBefore);
      expect(await run('2026-12-02')).toMatchObject({ expired: 0 });
      const closing = (await events(advance.id)).filter((event) => event.type === 'ctr.guarantee.expired.v1');
      expect(closing).toHaveLength(1);
      expect(closing[0]?.payload).toMatchObject({ guarantee_id: advance.id, contract_id: contract, kind: 'ADVANCE', advance_outstanding_vnd: '1250000000', issue_required: true, source_module: 'CTR', source_reference: advance.id });
      expect(await owner("select action from machvon.audit_event where resource_id = $1::uuid and action = 'guarantee.expired'", [advance.id])).toHaveLength(1);
      // A new advance cannot lean on a guarantee that lapsed.
      expect(await as((tx) => guarantees.holdsActive(tx, contract, 'ADVANCE', at('2026-12-02')))).toBe(false);
    });

    it('sends the threshold the days left have reached, once, even when the job missed days, and does not touch a guarantee further than 30 days', async () => {
      const contract = await draft();
      const missed = await active(contract, { expiresAt: '2027-03-31T16:59:00Z' });
      const far = await active(contract, { expiresAt: '2027-06-30T16:59:00Z' });
      expect(await run('2027-03-20')).toMatchObject({ alerted: 1, expiring: { 30: 1, 15: 1, 7: 0, 0: 0 } });
      expect((await row(missed.id))?.last_alert_days).toBe(15);
      expect((await row(far.id))?.last_alert_days).toBeNull();
      expect(await run('2027-03-30')).toMatchObject({ alerted: 1 });
      expect((await row(missed.id))?.last_alert_days).toBe(7);
      expect(await run('2027-03-31')).toMatchObject({ alerted: 1 });
      expect((await row(missed.id))?.last_alert_days).toBe(0);
      expect(await run('2027-04-01')).toMatchObject({ expired: 1 });
      const closing = (await events(missed.id)).filter((event) => event.type === 'ctr.guarantee.expired.v1');
      expect(closing[0]?.payload).toMatchObject({ issue_required: false });
      expect((await events(far.id)).filter((event) => event.type.startsWith('ctr.guarantee.exp'))).toEqual([]);
    });

    it('leaves a guarantee that is not ACTIVE alone, keeps the version a reminder does not change, and sees only the tenant it runs for', async () => {
      const contract = await draft();
      const pending = await register(contract, { expiresAt: '2026-11-10T16:59:00Z' });
      const live = await active(contract, { expiresAt: '2026-11-10T16:59:00Z' });
      expect(await run('2026-11-05', TENANT_B)).toMatchObject({ alerted: 0, expired: 0 });
      expect(await row(live.id)).toMatchObject({ last_alert_days: null });
      await run('2026-11-05');
      expect(await row(live.id)).toMatchObject({ last_alert_days: 7, version: '2' });
      expect(await row(pending.id)).toMatchObject({ last_alert_days: null, status: 'PENDING_VERIFICATION' });
      await run('2026-11-12');
      expect(await row(pending.id)).toMatchObject({ status: 'PENDING_VERIFICATION' });
      expect(await row(live.id)).toMatchObject({ status: 'EXPIRED', version: '3' });
    });

    it('counts the day by the calendar of Vietnam: a guarantee that ends at 23:59 there is still ACTIVE on that day', async () => {
      const contract = await draft();
      const guarantee = await active(contract, { expiresAt: '2026-12-01T16:59:00Z' });
      await as((tx) => jobOf().run(tx, memberId(JOB), new Date('2026-12-01T16:30:00Z')), TENANT_A, JOB);
      expect(await row(guarantee.id)).toMatchObject({ status: 'ACTIVE' });
      await as((tx) => jobOf().run(tx, memberId(JOB), new Date('2026-12-01T17:30:00Z')), TENANT_A, JOB);
      expect(await row(guarantee.id)).toMatchObject({ status: 'EXPIRED' });
    });
  });

  describe('the thresholds', () => {
    it('are the smallest one the days left have reached', () => {
      expect([31, 30, 16, 15, 8, 7, 1, 0, -1].map((days) => thresholdFor(days))).toEqual([undefined, 30, 30, 15, 15, 7, 7, 0, 0]);
    });
  });

  describe('reading the guarantees', () => {
    it('lists them in the order of the contract and the expiry with a cursor, finds one, and shows what the scope allows', async () => {
      const contract = await draft();
      const early = await register(contract, { expiresAt: '2027-01-31T16:59:00Z', kind: 'WARRANTY' });
      const late = await register(contract, { expiresAt: '2027-02-28T16:59:00Z', kind: 'INSURANCE' });
      const all = await as((tx) => guarantees.list(tx, readScope(), { limit: 500, after: undefined }));
      const mine = all.filter((entry) => entry.contractId === contract);
      expect(mine.map((entry) => entry.id)).toEqual([early.id, late.id]);
      expect(mine[0]).toMatchObject({ kind: 'WARRANTY', status: 'PENDING_VERIFICATION', verificationStatus: 'UNVERIFIED', amountVnd: '500000000', expiresOn: '2027-01-31', validFrom: '2026-10-01', registeredBy: memberId(OFFICER), advanceOutstandingVnd: '0' });
      expect(mine[0]?.reach).toMatchObject({ contractId: contract, ownerUnit: { path: '/u1/u2/' } });
      const first = await as((tx) => guarantees.list(tx, readScope(), { limit: 1, after: undefined }));
      const rest = await as((tx) => guarantees.list(tx, readScope(), { limit: 500, after: { code: first[0]?.key ?? '', id: first[0]?.id ?? '' } }));
      expect(rest.some((entry) => entry.id === first[0]?.id)).toBe(false);
      expect(await as((tx) => guarantees.find(tx, early.id, readScope()))).toMatchObject({ id: early.id, contractCode: expect.stringMatching(/^HD-G-/) });
      const elsewhere = readScope({ kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] });
      expect(await as((tx) => guarantees.find(tx, early.id, elsewhere))).toBeUndefined();
      expect((await as((tx) => guarantees.list(tx, elsewhere, { limit: 500, after: undefined }))).filter((entry) => entry.contractId === contract)).toEqual([]);
      expect(await as((tx) => guarantees.find(tx, early.id, readScope()), TENANT_B)).toBeUndefined();
      const byContract = readScope({ kind: 'CONTRACT', refIds: [contract] });
      expect((await as((tx) => guarantees.list(tx, byContract, { limit: 500, after: undefined }))).map((entry) => entry.id)).toEqual([early.id, late.id]);
    });

    it('lists the ACTIVE guarantees that expire within the days asked, the soonest first, with the days left', async () => {
      const contract = await draft();
      const near = await active(contract, { expiresAt: '2026-11-03T16:59:00Z' });
      const middle = await active(contract, { expiresAt: '2026-11-20T16:59:00Z' });
      await active(contract, { expiresAt: '2027-05-20T16:59:00Z' });
      await register(contract, { expiresAt: '2026-11-04T16:59:00Z' });
      const within = (days: number) => as((tx) => guarantees.expiring(tx, readScope({ kind: 'CONTRACT', refIds: [contract] }), '2026-11-01', days, { limit: 100, after: undefined }));
      const thirty = await within(30);
      // 23:59 in Vietnam on the 3rd is two calendar days after the 1st.
      expect(thirty.map((entry) => [entry.id, entry.daysLeft])).toEqual([
        [near.id, 2],
        [middle.id, 19],
      ]);
      expect((await within(2)).map((entry) => entry.id)).toEqual([near.id]);
      expect(await within(1)).toEqual([]);
      const page = await as((tx) => guarantees.expiring(tx, readScope({ kind: 'CONTRACT', refIds: [contract] }), '2026-11-01', 30, { limit: 1, after: undefined }));
      const next = await as((tx) => guarantees.expiring(tx, readScope({ kind: 'CONTRACT', refIds: [contract] }), '2026-11-01', 30, { limit: 5, after: { code: page[0]?.key ?? '', id: page[0]?.id ?? '' } }));
      expect(next.map((entry) => entry.id)).toEqual([middle.id]);
      // Today counts as 0 days away, and yesterday is over.
      expect((await as((tx) => guarantees.expiring(tx, readScope({ kind: 'CONTRACT', refIds: [contract] }), '2026-11-03', 0, { limit: 5, after: undefined }))).map((entry) => entry.daysLeft)).toEqual([0]);
      expect(await as((tx) => guarantees.expiring(tx, readScope({ kind: 'CONTRACT', refIds: [contract] }), '2026-11-04', 0, { limit: 5, after: undefined }))).toEqual([]);
    });
  });

  describe('what the database holds whoever writes', () => {
    it('refuses to change what a guarantee says, a transition the register does not know, and a verification by the registrant', async () => {
      const contract = await draft();
      const registered = await register(contract);
      const verified = await verify(registered.id, 1);
      expect((await databaseRefusal(owner('update machvon.guarantee set amount_vnd = 1 where id = $1::uuid', [registered.id]))).message).toContain('never changes');
      expect((await databaseRefusal(owner("update machvon.guarantee set issuer = 'Elsewhere' where id = $1::uuid", [registered.id]))).message).toContain('never changes');
      expect((await databaseRefusal(owner("update machvon.guarantee set expires_at = expires_at + interval '1 day' where id = $1::uuid", [registered.id]))).message).toContain('never changes');
      expect(await databaseRefusal(owner("update machvon.guarantee set status = 'PENDING_VERIFICATION' where id = $1::uuid", [registered.id]))).toMatchObject({ sqlstate: '23514' });
      expect((await databaseRefusal(owner("update machvon.guarantee set verified_by = $2::uuid where id = $1::uuid", [registered.id, memberId(JOB)]))).message).toContain('final');
      const pending = await register(contract);
      expect((await databaseRefusal(owner("update machvon.guarantee set status = 'ACTIVE', verification_status = 'VERIFIED', verified_by = created_by, verified_at = now(), verification_method = 'x', verification_evidence_id = $2::uuid where id = $1::uuid", [pending.id, world.evidence]))).message).toContain('guarantee_verification_maker_checker_chk');
      expect((await databaseRefusal(owner("update machvon.guarantee set status = 'ACTIVE' where id = $1::uuid", [pending.id]))).message).toContain('guarantee_active_verified_chk');
      expect((await databaseRefusal(owner("update machvon.guarantee set verification_status = 'VERIFIED' where id = $1::uuid", [pending.id]))).message).toContain('guarantee_status_verification_chk');
      expect((await databaseRefusal(owner("update machvon.guarantee set status = 'RELEASED', released_at = now(), release_evidence_id = $2::uuid where id = $1::uuid", [verified.id, world.evidence]))).message).toContain('guarantee_release_decision_chk');
      expect((await databaseRefusal(owner("update machvon.guarantee set last_alert_days = 10 where id = $1::uuid", [verified.id]))).message).toContain('guarantee_alert_days_chk');
      await release(verified.id, 2);
      expect((await databaseRefusal(owner('update machvon.guarantee set release_reason = $2 where id = $1::uuid', [verified.id, 'Changed']))).message).toContain('final');
      expect((await databaseRefusal(owner("update machvon.guarantee set last_alert_days = 7 where id = $1::uuid", [verified.id]))).message).toBe('GUARANTEE_STATE_INVALID');
    });

    it('keeps a guarantee for good: the runtime role cannot delete it, and no guarantee is its own replacement', async () => {
      const contract = await draft();
      const registered = await register(contract);
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.guarantee where id = $1::uuid', [registered.id])))).sqlstate).toBe('42501');
      expect((await databaseRefusal(owner('update machvon.guarantee set extended_from_id = id where id = $1::uuid', [registered.id]))).message).toContain('never changes');
      const first = await active(contract);
      const replacement = await extend(first.id, 2);
      expect((await databaseRefusal(owner(
        `insert into machvon.guarantee (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, expires_at, verification_status, status, extended_from_id, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'PERFORMANCE', 'Bank of the Province', 'BL-SECOND', 1, now() + interval '90 days', 'UNVERIFIED', 'PENDING_VERIFICATION', $2::uuid, $3::uuid)`,
        [contract, first.id, memberId(OFFICER)],
      ))).sqlstate).toBe('23505');
      expect(replacement.supersededId).toBe(first.id);
    });
  });
});
