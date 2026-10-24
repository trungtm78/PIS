import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ContractController, ContractReadsController, ContractRevisionReadsController } from '../../src/modules/ctr/contract.controller';
import { ExpiringGuaranteesController, GuaranteeController, GuaranteeReadsController } from '../../src/modules/ctr/guarantee.controller';
import { ctrModule } from '../../src/modules/ctr';
import { MODULES } from '../../src/modules/registry';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedCtrWorld } from '../../../../packages/db/test/support/ctr-fixtures';
import type { CtrWorld } from '../../../../packages/db/test/support/ctr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const OFFICER = 1; // creates the contract, registers and extends; also holds the rights to verify and release, to show that the registrant is refused
const ACCOUNTANT = 2; // verifies, extends and reads the ledger
const READER = 3; // guarantee.read
const ELSEWHERE = 4; // guarantee.verify and guarantee.release over another branch, guarantee.read over the tenant
const NOBODY = 5;
const GUEST = 6; // a guest of one contract
const SECOND_ACCOUNTANT = 7; // verifies and releases
const DEPARTMENT_OFFICER = 8; // guarantee.manage and guarantee.read over the department
const B_OFFICER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0x96;
const DAY = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

/** An instant `days` days from now, as the ISO text the commands take; the guarantee is then that many calendar days from expiring. */
const inDays = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

describe('guarantee commands and reads (ST-CTR-003)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let world: CtrWorld;
  let contractId = '';
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  const guaranteeBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return {
      kind: 'PERFORMANCE',
      issuer: 'Bank of the Province',
      guarantee_no: `BL-A-${String(counter).padStart(3, '0')}`,
      amount_vnd: '500000000',
      valid_from: '2026-03-01',
      expires_at: inDays(200),
      document_version_id: world.document,
      ...extra,
    };
  };
  const register = (member: number, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}, contract = contractId): Promise<Reply> =>
    call('POST', `/contracts/${contract}/guarantees`, { member, body: guaranteeBody(extra), ...options });
  const verify = (member: number, id: string, version: number | string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/guarantees/${id}/verify`, { member, ifMatch: `"${version}"`, body: { outcome: 'VERIFIED', method: 'Confirmation letter from the issuer', evidence_document_version_id: world.evidence, ...extra } });
  const extend = (member: number, id: string, version: number | string, extra: Record<string, unknown> = {}): Promise<Reply> => {
    counter += 1;
    return call('POST', `/guarantees/${id}/extend`, { member, ifMatch: `"${version}"`, body: { new_expires_at: inDays(400), new_guarantee_no: `BL-X-${counter}`, document_version_id: world.document, ...extra } });
  };
  const release = (member: number, id: string, version: number | string, body: Record<string, unknown> = { release_evidence_id: world.evidence, reason: 'Obligation completed' }): Promise<Reply> =>
    call('POST', `/guarantees/${id}/release`, { member, ifMatch: `"${version}"`, body });
  const row = async (id: string) => (await rows<Record<string, unknown>>('select * from machvon.guarantee where id = $1', [id]))[0];
  const events = async (id: string): Promise<string[]> => (await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [id])).map((event) => event.type);
  const auditActions = async (id: string): Promise<string[]> => (await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [id])).map((event) => event.action);

  async function contract(code: string): Promise<string> {
    const made = await call('POST', '/contracts', {
      member: OFFICER,
      body: {
        project_id: world.project,
        package_id: world.packageId,
        contractor_id: world.lead,
        code,
        title: 'Construction of the bridge',
        type: 'UNIT_PRICE',
        advance_category: 'CONSTRUCTION',
        contract_value_vnd: '10000000000',
        document_version_id: world.document,
      },
    });
    expect(made.status).toBe(200);
    return idOf(made);
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      ]);
    }
    for (const n of [OFFICER, ACCOUNTANT, READER, ELSEWHERE, NOBODY, GUEST, SECOND_ACCOUNTANT, DEPARTMENT_OFFICER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_OFFICER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'CONTRACT_OFFICER', ['contract.create', 'contract.update', 'contract.read', 'guarantee.manage', 'guarantee.verify', 'guarantee.release', 'guarantee.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'CHIEF_ACCOUNTANT', ['guarantee.verify', 'guarantee.release', 'guarantee.manage', 'guarantee.read', 'ledger.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'GUARANTEE_READER', ['guarantee.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'ELSEWHERE_ACCOUNTANT', ['guarantee.verify', 'guarantee.release'], 30);
    await harness.seedRole(TENANT_A, 5, 'SECOND_ACCOUNTANT', ['guarantee.verify', 'guarantee.release', 'guarantee.read'], 50);
    await harness.seedRole(TENANT_A, 6, 'DEPARTMENT_OFFICER', ['guarantee.manage', 'guarantee.read'], 30);
    await harness.seedRole(TENANT_A, 7, 'GUEST_GUARANTEE', ['guarantee.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'CONTRACT_OFFICER', ['contract.create', 'guarantee.manage', 'guarantee.verify', 'guarantee.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'TENANT' },
      { n: 2, member: ACCOUNTANT, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: ELSEWHERE, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
      { n: 5, member: ELSEWHERE, role: 3, kind: 'TENANT' },
      { n: 6, member: SECOND_ACCOUNTANT, role: 5, kind: 'TENANT' },
      { n: 7, member: DEPARTMENT_OFFICER, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_OFFICER, role: 1, kind: 'TENANT' }]);
    world = await seedCtrWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, ROOT);
    await harness.owner(TENANT_A, [
      ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1 and tenant_id = $3", [memberId(GUEST), world.lead, TENANT_A]],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ContractController, ContractReadsController, ContractRevisionReadsController, GuaranteeController, ExpiringGuaranteesController, GuaranteeReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    contractId = await contract('HD-A-001');
    await harness.seedGrants(TENANT_A, [{ n: 20, member: GUEST, role: 7, kind: 'CONTRACT', refs: [contractId] }]);
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered once in the module of the register with the three controllers of the guarantees', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([GuaranteeController, ExpiringGuaranteesController, GuaranteeReadsController]));
    expect(MODULES.filter((module) => module.code === 'CTR')).toHaveLength(1);
  });

  describe('the lifecycle (AC-ST-CTR-003-1)', () => {
    it('refuses the registrant as verifier, verifies by another person, replaces on extension, and releases only with evidence', async () => {
      const registered = await register(OFFICER, { guarantee_no: 'BL-A-002', amount_vnd: '500000000', expires_at: '2099-12-31T16:59:00Z' });
      expect(registered).toMatchObject({ status: 200, json: { status: 'PENDING_VERIFICATION', resource_version: 1 } });
      const id = idOf(registered);

      const own = await verify(OFFICER, id, 1);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await row(id)).toMatchObject({ status: 'PENDING_VERIFICATION', verified_by: null });

      const verified = await verify(ACCOUNTANT, id, 1);
      expect(verified.json).toMatchObject({ status: 'ACTIVE', resource_version: 2 });
      expect(await row(id)).toMatchObject({ status: 'ACTIVE', verification_status: 'VERIFIED', verified_by: memberId(ACCOUNTANT), verification_evidence_id: world.evidence });

      const expiryBefore = new Date((await row(id))?.expires_at as string).toISOString();
      const extended = await extend(ACCOUNTANT, id, 2, { new_expires_at: '2100-06-30T16:59:00Z' });
      expect(extended.json).toMatchObject({ status: 'PENDING_VERIFICATION', resource_version: 1 });
      const replacement = idOf(extended);
      expect(replacement).not.toBe(id);
      expect(await row(id)).toMatchObject({ status: 'SUPERSEDED' });
      expect(new Date((await row(id))?.expires_at as string).toISOString()).toBe(expiryBefore);
      expect(await row(replacement)).toMatchObject({ status: 'PENDING_VERIFICATION', extended_from_id: id, verification_status: 'UNVERIFIED', issuer: 'Bank of the Province' });
      expect(new Date((await row(replacement))?.expires_at as string).toISOString()).toBe('2100-06-30T16:59:00.000Z');

      expect((await verify(SECOND_ACCOUNTANT, replacement, 1)).json).toMatchObject({ status: 'ACTIVE' });
      const withoutEvidence = await release(SECOND_ACCOUNTANT, replacement, 2, { reason: 'Obligation completed' });
      expect([withoutEvidence.status, withoutEvidence.json.code, withoutEvidence.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'release_evidence_id']);
      expect((await release(SECOND_ACCOUNTANT, replacement, 2, { release_evidence_id: randomUUID(), reason: 'Obligation completed' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'release_evidence_id' });
      expect(await row(replacement)).toMatchObject({ status: 'ACTIVE', released_at: null });
      const registrant = await release(ACCOUNTANT, replacement, 2);
      expect([registrant.status, registrant.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);

      const released = await release(SECOND_ACCOUNTANT, replacement, 2);
      expect(released.json).toMatchObject({ status: 'RELEASED', resource_version: 3 });
      expect(await row(replacement)).toMatchObject({ status: 'RELEASED', release_evidence_id: world.evidence, released_by: memberId(SECOND_ACCOUNTANT), release_reason: 'Obligation completed' });
      expect((await row(replacement))?.released_at).not.toBeNull();

      expect(await events(id)).toEqual(['ctr.guarantee.registered.v1', 'ctr.guarantee.verified.v1']);
      expect(await events(replacement)).toEqual(['ctr.guarantee.extended.v1', 'ctr.guarantee.verified.v1', 'ctr.guarantee.released.v1']);
      expect(await auditActions(id)).toEqual(['guarantee.registered', 'guarantee.verified']);
      expect(await auditActions(replacement)).toEqual(['guarantee.extended', 'guarantee.verified', 'guarantee.released']);
    });

    it('keeps the number and the issuer out of the events and the audit trail, and tells the figures only', async () => {
      const registered = await register(OFFICER, { guarantee_no: 'SECRET-NO-77', issuer: 'Private Issuer Bank' });
      const id = idOf(registered);
      const event = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1', [id]);
      expect(event[0]?.payload).toMatchObject({ guarantee_id: id, contract_id: contractId, kind: 'PERFORMANCE', amount_vnd: '500000000', status: 'PENDING_VERIFICATION', actor_id: memberId(OFFICER), version: 1 });
      const trail = await rows<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where resource_id = $1', [id]);
      for (const text of [JSON.stringify(event[0]?.payload), JSON.stringify(trail[0]?.safe_diff)]) {
        expect(text).not.toContain('SECRET-NO-77');
        expect(text).not.toContain('Private Issuer Bank');
      }
    });

    it('answers a replay of the same key with the first answer and a different body with a conflict, and refuses the same number of the same issuer', async () => {
      const key = `K-GUARANTEE-${randomUUID()}`;
      const body = { guarantee_no: 'BL-REPLAY-1', expires_at: '2099-01-01T00:00:00Z' };
      const first = await register(OFFICER, body, { key });
      const again = await register(OFFICER, body, { key });
      expect(first.status).toBe(200);
      expect(again.json).toEqual(first.json);
      const changed = await call('POST', `/contracts/${contractId}/guarantees`, { member: OFFICER, key, body: { ...guaranteeBody(body), amount_vnd: '1' } });
      expect([changed.status, changed.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      const duplicate = await register(OFFICER, body);
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'GUARANTEE_DUPLICATE']);
      expect(await rows('select id from machvon.guarantee where guarantee_no = $1', ['BL-REPLAY-1'])).toEqual([{ id: idOf(first) }]);
    });

    it('rejects a guarantee that fails its verification, and refuses a second decision', async () => {
      const id = idOf(await register(OFFICER));
      const failed = await verify(ACCOUNTANT, id, 1, { outcome: 'FAILED', method: 'The issuer does not know this guarantee' });
      expect(failed.json).toMatchObject({ status: 'REJECTED', resource_version: 2 });
      expect(await row(id)).toMatchObject({ status: 'REJECTED', verification_status: 'FAILED' });
      expect(await verify(ACCOUNTANT, id, 2)).toMatchObject({ status: 409, json: { code: 'GUARANTEE_STATE_INVALID' } });
    });
  });

  describe('what the commands take', () => {
    it('takes only the fields of the contract of each command: a status, a verification, a tenant or a release is refused', async () => {
      for (const extra of [{ status: 'ACTIVE' }, { verification_status: 'VERIFIED' }, { tenant_id: TENANT_B }, { released_at: '2026-01-01T00:00:00Z' }, { extended_from_id: randomUUID() }]) {
        const reply = await register(OFFICER, extra);
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      const id = idOf(await register(OFFICER));
      expect((await verify(ACCOUNTANT, id, 1, { verified_by: memberId(ACCOUNTANT) })).json).toMatchObject({ code: 'FIELD_NOT_ALLOWED' });
      expect((await extend(OFFICER, id, 1, { amount_vnd: '1' })).json).toMatchObject({ code: 'FIELD_NOT_ALLOWED' });
      expect((await release(ACCOUNTANT, id, 1, { release_evidence_id: world.evidence, reason: 'x', status: 'RELEASED' })).json).toMatchObject({ code: 'FIELD_NOT_ALLOWED' });
      expect(await row(id)).toMatchObject({ status: 'PENDING_VERIFICATION' });
    });

    it('names the field of a fault of the request', async () => {
      const fault = async (extra: Record<string, unknown>) => (await register(OFFICER, extra)).json;
      expect(await fault({ amount_vnd: '0' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await fault({ amount_vnd: '12.5' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await fault({ kind: 'BOND' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'kind' });
      expect(await fault({ expires_at: '2020-01-01T00:00:00Z' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'expires_at' });
      expect(await fault({ party_id: randomUUID() })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'party_id' });
      expect(await fault({ document_version_id: randomUUID() })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_version_id' });
      expect((await fault({ issuer: undefined })).code).toBe('INVALID_REQUEST');
      const id = idOf(await register(OFFICER));
      expect((await verify(ACCOUNTANT, id, 1, { outcome: 'MAYBE' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'outcome' });
      expect((await verify(ACCOUNTANT, id, 1, { evidence_document_version_id: randomUUID() })).json).toMatchObject({ detail: 'evidence_document_version_id' });
      expect(await verify(ACCOUNTANT, id, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT', current_version: 1 } });
      expect((await call('POST', `/guarantees/${id}/verify`, { member: ACCOUNTANT, body: { outcome: 'VERIFIED', method: 'x', evidence_document_version_id: world.evidence } })).status).toBeGreaterThanOrEqual(400);
    });

    it('refuses an advance guarantee release while an advance is owed, and a contract that has ended', async () => {
      const owing = await contract('HD-A-OWING');
      await rows('update machvon.contract set advance_paid_vnd = 2000000000, advance_recovered_vnd = 750000000 where id = $1', [owing]);
      const advance = idOf(await register(OFFICER, { kind: 'ADVANCE', amount_vnd: '2000000000' }, {}, owing));
      await verify(ACCOUNTANT, advance, 1);
      const refused = await release(SECOND_ACCOUNTANT, advance, 2);
      expect(refused.status).toBe(422);
      expect(refused.json).toMatchObject({ code: 'RELEASE_CONDITION_NOT_MET', advance_outstanding_vnd: '1250000000' });
      expect(await row(advance)).toMatchObject({ status: 'ACTIVE' });
      await rows("update machvon.contract set status = 'CANCELLED' where id = $1", [owing]);
      expect(await register(OFFICER, {}, {}, owing)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
    });
  });

  describe('who may do what', () => {
    it('judges each command by its own permission over the contract', async () => {
      expect((await register(READER)).status).toBe(403);
      expect((await register(NOBODY)).status).toBe(403);
      expect(await register(ELSEWHERE)).toMatchObject({ status: 403 });
      expect((await register(DEPARTMENT_OFFICER)).status).toBe(200);
      const id = idOf(await register(OFFICER));
      expect((await verify(OFFICER, id, 1)).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await verify(ELSEWHERE, id, 1)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await verify(READER, id, 1)).status).toBe(403);
      expect((await verify(DEPARTMENT_OFFICER, id, 1)).status).toBe(403);
      expect((await extend(READER, id, 1)).status).toBe(403);
      expect((await release(DEPARTMENT_OFFICER, id, 1)).status).toBe(403);
      expect((await release(OFFICER, id, 1)).json).toMatchObject({ code: 'GUARANTEE_STATE_INVALID' });
    });

    it('finds nothing in another tenant, for a command or a read', async () => {
      const id = idOf(await register(OFFICER));
      expect(await call('POST', `/contracts/${contractId}/guarantees`, { member: B_OFFICER, tenantId: TENANT_B, body: guaranteeBody() })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await call('POST', `/guarantees/${id}/verify`, { member: B_OFFICER, tenantId: TENANT_B, ifMatch: '"1"', body: { outcome: 'VERIFIED', method: 'x', evidence_document_version_id: world.evidence } })).toMatchObject({ status: 404 });
      expect((await call('GET', `/resources/guarantee/${id}`, { member: B_OFFICER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', '/resources/guarantee', { member: B_OFFICER, tenantId: TENANT_B })).json.items).toEqual([]);
      expect((await call('POST', `/guarantees/${randomUUID()}/verify`, { member: ACCOUNTANT, ifMatch: '"1"', body: { outcome: 'VERIFIED', method: 'x', evidence_document_version_id: world.evidence } })).status).toBe(404);
    });
  });

  describe('reads', () => {
    let activeId = '';
    let advanceId = '';

    beforeAll(async () => {
      activeId = idOf(await register(OFFICER, { guarantee_no: 'BL-READ-1', expires_at: inDays(10) }));
      await verify(ACCOUNTANT, activeId, 1);
      advanceId = idOf(await register(OFFICER, { guarantee_no: 'BL-READ-2', kind: 'ADVANCE', expires_at: inDays(25) }));
      await verify(ACCOUNTANT, advanceId, 1);
      await rows('update machvon.contract set advance_paid_vnd = 2000000000, advance_recovered_vnd = 750000000 where id = $1', [contractId]);
    });

    it('lists the guarantees with the verification status, the expiry and the alert level, pages by cursor and reads one by id', async () => {
      const list = await call('GET', '/resources/guarantee?limit=200', { member: READER });
      expect(list.status).toBe(200);
      const items = list.json.items as Array<Record<string, unknown>>;
      const mine = items.find((item) => item.id === activeId);
      expect(mine).toMatchObject({
        contract_id: contractId,
        contract_code: 'HD-A-001',
        kind: 'PERFORMANCE',
        issuer: 'Bank of the Province',
        guarantee_no: 'BL-READ-1',
        amount_vnd: '500000000',
        currency: 'VND',
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
        last_alert_days: null,
        version: 2,
      });
      expect(Object.keys(mine ?? {}).sort()).toEqual(expect.arrayContaining(['expires_at', 'expires_on', 'extended_from_id', 'valid_from']));
      const page = await call('GET', '/resources/guarantee?limit=2', { member: READER });
      const next = await call('GET', `/resources/guarantee?limit=2&cursor=${page.json.next_cursor as string}`, { member: READER });
      const ids = [...(page.json.items as Array<{ id: string }>), ...(next.json.items as Array<{ id: string }>)].map((item) => item.id);
      expect(new Set(ids).size).toBe(4);
      const one = await call('GET', `/resources/guarantee/${activeId}`, { member: DEPARTMENT_OFFICER });
      expect(one.json).toMatchObject({ id: activeId, guarantee_no: 'BL-READ-1' });
      expect((await call('GET', `/resources/guarantee/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', '/resources/guarantee', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/resources/guarantee?cursor=nope', { member: READER })).status).toBe(422);
    });

    it('shows the staff how the guarantee was checked and by whom, a reader and a guest contractor only the paper and its status, and the advance owed only to the ledger', async () => {
      const staff = await call('GET', `/resources/guarantee/${activeId}`, { member: OFFICER });
      expect(staff.json).toMatchObject({ registered_by: memberId(OFFICER), verified_by: memberId(ACCOUNTANT), verification_method: 'Confirmation letter from the issuer', verification_evidence_id: world.evidence });
      const guest = await call('GET', `/resources/guarantee/${activeId}`, { member: GUEST });
      expect(guest.status).toBe(200);
      for (const hidden of ['registered_by', 'verified_by', 'verification_method', 'verification_evidence_id', 'release_evidence_id', 'document_version_id', 'advance_outstanding_vnd']) expect(guest.json).not.toHaveProperty(hidden);
      expect(guest.json).toMatchObject({ status: 'ACTIVE', verification_status: 'VERIFIED' });
      const guestList = await call('GET', '/resources/guarantee?limit=200', { member: GUEST });
      expect((guestList.json.items as Array<{ contract_id: string }>).every((item) => item.contract_id === contractId)).toBe(true);
      expect((await call('GET', `/resources/guarantee/${advanceId}`, { member: OFFICER })).json).not.toHaveProperty('advance_outstanding_vnd');
      expect((await call('GET', `/resources/guarantee/${advanceId}`, { member: ACCOUNTANT })).json).toMatchObject({ advance_outstanding_vnd: '1250000000' });
      expect((await call('GET', `/resources/guarantee/${activeId}`, { member: ACCOUNTANT })).json).not.toHaveProperty('advance_outstanding_vnd');
    });

    it('lists the ACTIVE guarantees about to expire, the soonest first, with the days left, and takes within_days from 0 to 365', async () => {
      const soon = await call('GET', '/guarantees/expiring?within_days=30', { member: READER });
      expect(soon.status).toBe(200);
      expect(soon.json).toMatchObject({ within_days: 30 });
      const items = soon.json.items as Array<Record<string, unknown>>;
      const today = vietnamDateOf(new Date());
      const mine = items.filter((item) => item.contract_id === contractId);
      expect(mine.map((item) => item.id)).toEqual([activeId, advanceId]);
      expect(mine.map((item) => item.days_left)).toEqual([daysBetween(today, mine[0]?.expires_on as string), daysBetween(today, mine[1]?.expires_on as string)]);
      expect(mine[0]?.days_left).toBeGreaterThanOrEqual(9);
      expect(mine[0]?.days_left).toBeLessThanOrEqual(11);
      expect(mine[1]?.days_left).toBeGreaterThanOrEqual(24);
      expect(mine[1]?.days_left).toBeLessThanOrEqual(26);
      expect(mine.every((item) => item.status === 'ACTIVE')).toBe(true);
      const narrow = await call('GET', '/guarantees/expiring?within_days=14', { member: READER });
      expect((narrow.json.items as Array<{ id: string }>).filter((item) => item.id === advanceId)).toEqual([]);
      expect(((await call('GET', '/guarantees/expiring', { member: READER })).json as { within_days: number }).within_days).toBe(30);
      for (const bad of ['-1', '366', 'x', '1.5', '']) expect((await call('GET', `/guarantees/expiring?within_days=${bad}`, { member: READER })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'within_days' });
      expect((await call('GET', '/guarantees/expiring', { member: NOBODY })).status).toBe(403);
      expect(((await call('GET', '/guarantees/expiring', { member: B_OFFICER, tenantId: TENANT_B })).json as { items: unknown[] }).items).toEqual([]);
      const first = await call('GET', '/guarantees/expiring?limit=1', { member: READER });
      const second = await call('GET', `/guarantees/expiring?limit=1&cursor=${first.json.next_cursor as string}`, { member: READER });
      expect((first.json.items as Array<{ id: string }>)[0]?.id).not.toBe((second.json.items as Array<{ id: string }>)[0]?.id);
    });
  });
});
