import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { FieldCipher, loadErrorRegistry, signTenantContext, staticKeyProvider } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { VENDOR_CIPHER } from '../../src/modules/bid/tokens';
import { VendorController } from '../../src/modules/bid/vendor.controller';
import { VendorReadsController } from '../../src/modules/bid/vendor-reads.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1;
const CHECKER = 2;
const READER = 3;
const UNIT_ADMIN = 4;
const NOBODY = 5;
const SECOND = 6;
const B_ADMIN = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0x98;
const ALL = ['vnd.read', 'vnd.profile.write', 'vnd.duplicate.decide', 'vnd.bank.request', 'vnd.bank.approve', 'vnd.bank.callback', 'vnd.qualification.write', 'vnd.qualification.verify', 'vnd.restriction.propose', 'vnd.restriction.decide', 'vnd.reputation.write', 'vnd.reputation.post', 'vnd.venture.write'];
const CHECK = ['vnd.read', 'vnd.duplicate.decide', 'vnd.bank.approve', 'vnd.bank.callback', 'vnd.qualification.verify', 'vnd.restriction.decide', 'vnd.reputation.post'];
const PHONE = '0912000111';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the management of contractors and suppliers (VND-1: VND-01 to VND-06)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string; classification: string }>('select safe_diff, reason, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [aggregateId, type]);

  async function document(effective = true): Promise<string> {
    const documentId = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', $3, $4, $4)`,
      [TENANT_A, documentId, effective ? 'EFFECTIVE' : 'PENDING', memberId(ADMIN)],
    );
    return documentId;
  }

  async function contractor(name: string, extra: { phone?: boolean } = {}): Promise<string> {
    counter += 1;
    const contractorId = randomUUID();
    await rows(
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis)
       values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $8, 'EVIDENCE_DOCUMENT')`,
      [TENANT_A, contractorId, `06${String(counter).padStart(8, '0')}`, name, await document(), memberId(ADMIN), memberId(CHECKER), await document(false)],
    );
    if (extra.phone === true) await rows("update machvon.contractor set phone = $2::text, phone_key = encode(sha256(convert_to($2::text, 'UTF8')), 'hex'), phone_set_at = now() - interval '30 days' where id = $1", [contractorId, PHONE]);
    return contractorId;
  }

  async function seedPackage(): Promise<string> {
    const projectId = randomUUID();
    const packageId = randomUUID();
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Vendor project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `PRJ-V${projectId.slice(0, 6)}`, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      );
      await client.query(
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version) values ($1, $2, $3, $4, 1000, 'OPEN_BIDDING', 1, 'PLANNED', 'Package', $5, 1)`,
        [TENANT_A, packageId, projectId, `GT-V${packageId.slice(0, 6)}`, memberId(ADMIN)],
      );
    } finally {
      await client.end();
    }
    return packageId;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, CHECKER, READER, UNIT_ADMIN, NOBODY, SECOND]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'VND_ADMIN', ALL, 50);
    await harness.seedRole(TENANT_A, 2, 'VND_CHECKER', CHECK, 40);
    await harness.seedRole(TENANT_A, 3, 'VND_READER', ['vnd.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'VND_ADMIN', ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 5, member: SECOND, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    for (const year of [2026, 2027, 2028]) {
      await rows(
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(ADMIN)],
      );
    }
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [VendorController, VendorReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: VENDOR_CIPHER, useValue: new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]]))) },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of BID', () => {
    for (const controller of [VendorController, VendorReadsController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('the profile (VND-02)', () => {
    it('keeps the profile with its keys, audits it as personal data, announces it with ids only, and shows what is missing and what the caller may do', async () => {
      const contractorId = await contractor('Cty Vendor Profile');
      const before = await call('GET', `/vendor/contractors/${contractorId}`, { member: READER });
      expect(before.status).toBe(200);
      expect(before.json).toMatchObject({
        profile: { contractor_id: contractorId, version: 1, legal_rep_name: null, owner_count: 0 },
        tax_check: { format: 'VALID', checksum_legal_status: 'UNVERIFIED' },
        coverage: { complete: false, missing: ['LEGAL_REPRESENTATIVE', 'REGISTERED_ADDRESS', 'CONTACT', 'OWNERSHIP'], coverage_pct: 0 },
        payee_verdict: { allowed: true, warnings: ['PAYEE_ACCOUNT_NOT_REGISTERED'] },
        bid_security: { multiplier: 1, until: null },
        escalation: { decisions_in_force: 0, suggestion: 'NONE' },
        actions: { update_profile: false, request_payee_change: false, propose_restriction: false },
      });
      expect((before.json.policies as { profile: Record<string, unknown> }).profile).toMatchObject({ code: 'VENDOR_PROFILE', version: 'builtin', unverified: true });
      const update = await call('POST', `/vendor/contractors/${contractorId}/profile`, { member: ADMIN, ifMatch: 1, body: { legal_rep_name: 'Nguyen Van A', registered_address: '12 Le Loi, Quan 1', phone: PHONE, email: 'Contact@Firm.VN', business_registration_no: '0101-001' } });
      expect(update).toMatchObject({ status: 200, json: { status: 'UPDATED', resource_version: 2, resource_id: contractorId } });
      const [audit] = await audits(contractorId, 'vnd.profile_updated');
      expect(audit).toMatchObject({ classification: 'PERSONAL', actor_id: memberId(ADMIN), safe_diff: { contractor_id: contractorId, policy_version: 'builtin' } });
      const [event] = await events(contractorId, 'vnd.profile.updated.v1');
      expect(event?.payload).toMatchObject({ resource_id: contractorId, version: 2, actor_id: memberId(ADMIN) });
      expect(JSON.stringify(event?.payload)).not.toContain('Nguyen');
      const after = await call('GET', `/vendor/contractors/${contractorId}`, { member: ADMIN });
      expect(after.json).toMatchObject({ profile: { legal_rep_name: 'Nguyen Van A', phone: PHONE, email: 'contact@firm.vn', version: 2 }, coverage: { missing: ['OWNERSHIP'], coverage_pct: 75 }, actions: { update_profile: true, request_payee_change: true, propose_restriction: true } });
    });

    it('refuses a stale version, a bad field, a caller without the permission, one with it only on a subtree, and another tenant', async () => {
      const contractorId = await contractor('Cty Vendor Refusals');
      expect((await call('POST', `/vendor/contractors/${contractorId}/profile`, { member: ADMIN, ifMatch: 7, body: { legal_rep_name: 'Tran Thi B' } })).json).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect((await call('POST', `/vendor/contractors/${contractorId}/profile`, { member: ADMIN, ifMatch: 1, body: { phone: '12' } })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'phone' });
      expect((await call('POST', `/vendor/contractors/${contractorId}/profile`, { member: READER, ifMatch: 1, body: { legal_rep_name: 'Tran Thi B' } })).status).toBe(403);
      expect(await call('POST', `/vendor/contractors/${contractorId}/profile`, { member: UNIT_ADMIN, ifMatch: 1, body: { legal_rep_name: 'Tran Thi B' } })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await call('GET', `/vendor/contractors/${contractorId}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/vendor/contractors/${contractorId}`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
    });

    it('lists owners that make sense and keeps the history of the ones that ended', async () => {
      const contractorId = await contractor('Cty Vendor Owners');
      const added = await call('POST', `/vendor/contractors/${contractorId}/owners`, { member: ADMIN, body: { owner_kind: 'PERSON', owner_name: 'Le Van C', identity_number: '012345678901', share_pct: '60', beneficial_owner: true } });
      expect(added.status).toBe(200);
      const ownerId = added.json.resource_id as string;
      expect((await call('POST', `/vendor/contractors/${contractorId}/owners`, { member: ADMIN, body: { owner_kind: 'PERSON', owner_name: 'Pham D', share_pct: '50', beneficial_owner: false } })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owners.share_pct' });
      const view = await call('GET', `/vendor/contractors/${contractorId}`, { member: ADMIN });
      expect(view.json).toMatchObject({ owners: [{ id: ownerId, owner_name: 'Le Van C', share_pct: '60.00', has_identity_key: true, ended_on: null }], profile: { ownership_declaration: 'OWNERS_LISTED' } });
      expect(JSON.stringify(view.json)).not.toContain('012345678901');
      expect((await call('POST', `/vendor/owners/${ownerId}/end`, { member: ADMIN, body: { reason: 'sold the whole holding' } })).json).toMatchObject({ status: 'ENDED' });
      expect(((await call('GET', `/vendor/contractors/${contractorId}`, { member: ADMIN })).json.owners as Array<{ ended_on: string | null }>)[0]?.ended_on).not.toBeNull();
      const other = await contractor('Cty Vendor Declared');
      expect((await call('POST', `/vendor/contractors/${other}/ownership-declaration`, { member: ADMIN, ifMatch: 1, body: {} })).json).toMatchObject({ status: 'DECLARED' });
    });

    it('finds contractors that share keys, shows them as suggestions and sends one to the merge of master data without merging', async () => {
      const a = await contractor('Cty Dup A');
      const b = await contractor('Cty Dup B');
      for (const target of [a, b]) {
        const done = await call('POST', `/vendor/contractors/${target}/profile`, { member: ADMIN, ifMatch: 1, body: { registered_address: '77 Nguyen Hue, Quan 1', phone: '0988777666' } });
        expect(done.status).toBe(200);
      }
      const scan = await call('POST', `/vendor/contractors/${a}/duplicate-scan`, { member: ADMIN });
      expect(scan.status).toBe(200);
      const found = (scan.json.items as Array<{ id: string; signals: string[]; status: string; version: number; contractor_a_id: string; contractor_b_id: string }>).find((item) => [item.contractor_a_id, item.contractor_b_id].includes(b));
      expect(found).toMatchObject({ status: 'OPEN', signals: expect.arrayContaining(['ADDRESS', 'PHONE']) });
      expect((await call('POST', `/vendor/duplicates/${found?.id}/decision`, { member: READER, ifMatch: found?.version, body: { decision: 'DISMISSED', reason: 'two branches of one firm' } })).status).toBe(403);
      const decided = await call('POST', `/vendor/duplicates/${found?.id}/decision`, { member: CHECKER, ifMatch: found?.version, body: { decision: 'MERGE_REQUESTED', reason: 'one firm, sent to master data' } });
      expect(decided.json).toMatchObject({ status: 'MERGE_REQUESTED' });
      const [event] = await events(found?.id as string, 'vnd.duplicate.decided.v1');
      expect(event?.payload).toMatchObject({ decision: 'MERGE_REQUESTED', contractor_a_id: found?.contractor_a_id });
      expect((await call('GET', '/vendor/duplicates?status=MERGE_REQUESTED', { member: READER })).json.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: found?.id })]));
    });

    it('lists the register with filters and a cursor', async () => {
      await contractor('Cty Register Search Unique');
      const page = await call('GET', '/vendor/register?q=Register%20Search%20Unique&limit=5', { member: READER });
      expect(page.status).toBe(200);
      expect(page.json).toMatchObject({ items: [{ legal_name: 'Cty Register Search Unique', restricted: false, open_cases: 0, coverage: { complete: false } }], next_cursor: null, profile_policy: { code: 'VENDOR_PROFILE' } });
      expect((await call('GET', '/vendor/register?coverage=COMPLETE&q=Register%20Search%20Unique', { member: READER })).json.items).toEqual([]);
      expect((await call('GET', '/vendor/register?coverage=SOMETIMES', { member: READER })).status).toBe(422);
      expect((await call('GET', '/vendor/register', { member: NOBODY })).status).toBe(403);
      const tenantB = await call('GET', '/vendor/register?q=Cty', { member: B_ADMIN, tenantId: TENANT_B });
      expect(tenantB.json.items).toEqual([]);
    });
  });

  describe('the accounts a contractor is paid into (VND-04)', () => {
    it('takes a change through two approvals and a call-back over the API, never shows the number, and blocks the payment until the waiting period ends', async () => {
      const contractorId = await contractor('Cty Vendor Payee', { phone: true });
      const evidence = await document(false);
      const requested = await call('POST', `/vendor/contractors/${contractorId}/payee-changes`, { member: ADMIN, body: { bank_name: 'Vietcombank', account_holder: 'CTY VENDOR PAYEE', account_number: '0011 0022 3344', reason: 'the bank closed the old account', evidence_document_id: evidence } });
      expect(requested).toMatchObject({ status: 200, json: { status: 'REQUESTED', resource_version: 1 } });
      const changeId = requested.json.resource_id as string;
      expect((await audits(changeId, 'vnd.bank_change_requested'))[0]).toMatchObject({ classification: 'PERSONAL', safe_diff: { account_no_masked: '********3344' } });
      const [ev] = await events(changeId, 'vnd.bank.changed.v1');
      expect(JSON.stringify(ev?.payload)).not.toContain('00110022');
      expect((await call('POST', `/vendor/payee-changes/${changeId}/approval`, { member: ADMIN, ifMatch: 1, body: { role: 'CONTRACT_MATCH' } })).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect((await call('POST', `/vendor/payee-changes/${changeId}/approval`, { member: CHECKER, ifMatch: 1, body: { role: 'CONTRACT_MATCH', note: 'matches contract 12' } })).json).toMatchObject({ status: 'REQUESTED', resource_version: 2 });
      expect((await call('POST', `/vendor/payee-changes/${changeId}/approval`, { member: CHECKER, ifMatch: 2, body: { role: 'ACCOUNT_MATCH' } })).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect((await call('POST', `/vendor/payee-changes/${changeId}/callback`, { member: CHECKER, ifMatch: 2, body: { outcome: 'CONFIRMED', called_number: '0999999999', used_number_on_file: true } })).json).toMatchObject({ code: 'BANK_CHANGE_CALLBACK_INVALID', reason: 'NUMBER_NOT_ON_FILE' });
      const queue = await call('GET', `/vendor/payee-changes?status=REQUESTED&contractor_id=${contractorId}`, { member: CHECKER });
      expect(queue.json.items).toEqual([expect.objectContaining({ id: changeId, remaining: ['ACCOUNT_MATCH', 'CALLBACK'], may_approve_account_match: false, may_callback: true, may_cancel: false, may_reject: true })]);
      expect((await call('GET', `/vendor/payee-changes?status=REQUESTED&contractor_id=${contractorId}`, { member: ADMIN })).json.items).toEqual([expect.objectContaining({ may_cancel: true, may_callback: false, may_reject: false })]);
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.contractor_bank_account where contractor_id = $1', [contractorId]))[0]?.n).toBe('0');
      // The reader holds no right to approve.
      expect((await call('POST', `/vendor/payee-changes/${changeId}/approval`, { member: READER, ifMatch: 2, body: { role: 'ACCOUNT_MATCH' } })).status).toBe(403);
      expect((await call('POST', `/vendor/payee-changes/${changeId}/cancel`, { member: ADMIN, ifMatch: 2, body: { reason: 'asked by mistake for the wrong contractor' } })).json).toMatchObject({ status: 'CANCELLED' });
      const view = await call('GET', `/vendor/contractors/${contractorId}`, { member: READER });
      expect(JSON.stringify(view.json)).not.toContain('0011');
      expect(view.json).toMatchObject({ accounts: [], payee_changes: [{ status: 'CANCELLED', account_no_masked: '********3344' }] });
    });

    it('activates the account when the third step is done, blocks the payment in the waiting period, and closes an account on a reason', async () => {
      const contractorId = await contractor('Cty Vendor Payee Two', { phone: true });
      const evidence = await document(false);
      const changeId = (await call('POST', `/vendor/contractors/${contractorId}/payee-changes`, { member: ADMIN, body: { bank_name: 'ACB', account_holder: 'Cty Vendor Payee Two', account_number: '9900 1234', reason: 'new account of the contractor', evidence_document_id: evidence } })).json.resource_id as string;
      expect((await call('POST', `/vendor/payee-changes/${changeId}/approval`, { member: CHECKER, ifMatch: 1, body: { role: 'CONTRACT_MATCH' } })).json.resource_version).toBe(2);
      expect((await call('POST', `/vendor/payee-changes/${changeId}/approval`, { member: SECOND, ifMatch: 2, body: { role: 'ACCOUNT_MATCH' } })).json.resource_version).toBe(3);
      const called = await call('POST', `/vendor/payee-changes/${changeId}/callback`, { member: SECOND, ifMatch: 3, body: { outcome: 'CONFIRMED', called_number: PHONE, used_number_on_file: true, note: 'spoke to the director' } });
      expect(called.json).toMatchObject({ status: 'ACTIVATED' });
      const view = await call('GET', `/vendor/contractors/${contractorId}`, { member: READER });
      expect(view.json).toMatchObject({
        accounts: [{ state: 'ACTIVE', valid_now: false, account_no_masked: '****1234', holder_matches_legal_name: true }],
        payee_verdict: { allowed: false, reason: 'IN_WAITING_PERIOD' },
        payee_changes: [{ status: 'ACTIVATED', callback_outcome: 'CONFIRMED', callback_number_last4: '0111', remaining: [] }],
      });
      expect((view.json.bank_events as Array<{ action: string }>).map((event) => event.action).reverse()).toEqual(['REQUESTED', 'CONTRACT_MATCHED', 'ACCOUNT_MATCHED', 'CALLBACK_CONFIRMED', 'ACTIVATED']);
      expect(JSON.stringify(view.json)).not.toContain('99001234');
      expect(await call('GET', `/vendor/gate-check?contractor_id=${contractorId}&action=PAYMENT`, { member: READER })).toMatchObject({ json: { allowed: false, refusal_code: 'PAYEE_ACCOUNT_NOT_VALID', refusal_extensions: { reason: 'IN_WAITING_PERIOD' } } });
      expect((await call('GET', `/vendor/gate-check?contractor_id=${contractorId}&action=BID_SUBMISSION`, { member: READER })).json).toMatchObject({ allowed: true });
      const accountId = (view.json.accounts as Array<{ id: string; version: number }>)[0] as { id: string; version: number };
      expect((await call('POST', `/vendor/payee-accounts/${accountId.id}/close`, { member: CHECKER, ifMatch: accountId.version, body: { reason: 'the bank closed the account' } })).json).toMatchObject({ status: 'CLOSED' });
      expect((await call('GET', `/vendor/contractors/${contractorId}`, { member: READER })).json).toMatchObject({ payee_verdict: { allowed: false, reason: 'NO_VALID_ACCOUNT' } });
      expect((await call('POST', `/vendor/payee-changes/${changeId}/cancel`, { member: ADMIN, ifMatch: 4, body: { reason: 'too late, already active' } })).json).toMatchObject({ code: 'BANK_CHANGE_STATE_INVALID' });
    });

    it('refuses a holder that is not the contractor and a contractor without a number on file', async () => {
      const contractorId = await contractor('Cty Vendor Payee Three', { phone: true });
      const evidence = await document(false);
      expect((await call('POST', `/vendor/contractors/${contractorId}/payee-changes`, { member: ADMIN, body: { bank_name: 'ACB', account_holder: 'Somebody Else', account_number: '9900 1234', reason: 'new account of the contractor', evidence_document_id: evidence } })).json).toMatchObject({ code: 'PAYEE_ACCOUNT_NAME_MISMATCH' });
      const noPhone = await contractor('Cty Vendor Payee Four');
      expect((await call('POST', `/vendor/contractors/${noPhone}/payee-changes`, { member: ADMIN, body: { bank_name: 'ACB', account_holder: 'Cty Vendor Payee Four', account_number: '9900 1234', reason: 'new account of the contractor', evidence_document_id: evidence } })).json).toMatchObject({ code: 'BANK_CHANGE_CALLBACK_INVALID' });
      expect((await call('POST', `/vendor/contractors/${contractorId}/payee-changes`, { member: READER, body: { bank_name: 'ACB', account_holder: 'Cty Vendor Payee Three', account_number: '9900 1234', reason: 'new account of the contractor', evidence_document_id: evidence } })).status).toBe(403);
    });
  });

  describe('the certificates and the key staff (VND-05)', () => {
    it('verifies by another person, watches the expiry and sets what a package asks', async () => {
      const contractorId = await contractor('Cty Vendor Cert');
      const doc = await document(false);
      const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
      const added = await call('POST', `/vendor/contractors/${contractorId}/qualifications`, { member: ADMIN, body: { kind: 'CONSTRUCTION_ACTIVITY', certificate_no: 'CCHN-9', grade: 'II', scope: 'Civil works', issuer: 'Ministry of Construction', issued_on: '2024-01-01', expires_on: soon, document_id: doc } });
      expect(added.status).toBe(200);
      const certId = added.json.resource_id as string;
      expect((await call('POST', `/vendor/qualifications/${certId}/verification`, { member: ADMIN, ifMatch: 1 })).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect((await call('POST', `/vendor/qualifications/${certId}/verification`, { member: CHECKER, ifMatch: 1 })).json).toMatchObject({ status: 'VERIFIED', resource_version: 2 });
      // A certificate is not a member of the key staff: the other route does not find it.
      expect((await call('POST', `/vendor/key-staff/${certId}/verification`, { member: CHECKER, ifMatch: 2 })).status).toBe(404);
      const staff = await call('POST', `/vendor/contractors/${contractorId}/key-staff`, { member: ADMIN, body: { staff_role: 'PROJECT_MANAGER', person_name: 'Hoang Van F', qualification_title: 'Class I manager', issued_on: '2024-01-01', expires_on: soon, document_id: doc } });
      expect(staff.status).toBe(200);
      const expiries = await call('GET', '/vendor/expiries', { member: READER });
      expect((expiries.json.items as Array<{ id: string; state: string; subject: string }>).filter((item) => [certId, staff.json.resource_id].includes(item.id)).map((item) => [item.subject, item.state]).sort()).toEqual([['KEY_STAFF', 'EXPIRING_SECOND'], ['QUALIFICATION', 'EXPIRING_SECOND']]);
      const view = await call('GET', `/vendor/contractors/${contractorId}`, { member: CHECKER });
      expect(view.json.qualifications).toEqual([expect.objectContaining({ id: certId, state: 'EXPIRING_SECOND', may_verify: false, verified_by_name: expect.any(String) })]);
      const packageId = await seedPackage();
      expect((await call('POST', `/vendor/packages/${packageId}/requirements`, { member: ADMIN, body: { requirements: [{ kind: 'CONSTRUCTION_ACTIVITY', min_grade: 'II', scope_keyword: 'civil' }] } })).json).toMatchObject({ status: 'SET' });
      expect((await call('GET', `/vendor/packages/${packageId}/requirements`, { member: READER })).json).toMatchObject({ package_id: packageId, requirements: [{ kind: 'CONSTRUCTION_ACTIVITY', min_grade: 'II', scope_keyword: 'civil' }] });
      expect((await call('GET', `/vendor/packages/${randomUUID()}/requirements`, { member: READER })).status).toBe(404);
      expect((await call('POST', `/vendor/key-staff/${staff.json.resource_id}/revocation`, { member: ADMIN, ifMatch: 1, body: { reason: 'the person left the contractor' } })).json).toMatchObject({ status: 'REVOKED' });
    });
  });

  describe('the debarment case and the joint venture (VND-03, VND-06)', () => {
    it('runs a case from the proposal to the legal record, in the order the law gives, by two people, and shows the gate refusing the contractor', async () => {
      const contractorId = await contractor('Cty Vendor Case');
      const opened = await call('POST', '/vendor/restriction-cases', { member: ADMIN, body: { subject_kind: 'CONTRACTOR', contractor_id: contractorId, trigger_kind: 'INVESTOR_PROPOSAL', trigger_ref: 'proposal-1', violation_groups: ['GROUP_2'], violation_summary: 'The contractor did not carry out the signed contract within the agreed time', violation_on: '2026-10-01' } });
      expect(opened).toMatchObject({ status: 200, json: { status: 'PROPOSED', resource_version: 1 } });
      const caseId = opened.json.resource_id as string;
      expect((await audits(caseId, 'vnd.restriction_case_opened'))[0]).toMatchObject({ classification: 'CONFIDENTIAL' });
      const detail = await call('GET', `/vendor/restriction-cases/${caseId}`, { member: ADMIN });
      expect(detail.json).toMatchObject({ case: { status: 'PROPOSED', clock: expect.stringMatching(/ON_TIME|DUE_SOON/), contractor_id: contractorId }, escalation: { suggestion: 'NONE' }, may_advance: true, may_decide: false, policy: { code: 'VENDOR_DEBARMENT', unverified: true } });
      expect((detail.json.periods as Record<string, { min_months: number }>).GROUP_2?.min_months).toBe(12);
      expect((await call('POST', `/vendor/restriction-cases/${caseId}/moves`, { member: ADMIN, ifMatch: 1, body: { move: 'SEND_NOTICE' } })).json).toMatchObject({ status: 'NOTICE_SENT' });
      expect((await call('POST', `/vendor/restriction-cases/${caseId}/moves`, { member: ADMIN, ifMatch: 2, body: { move: 'CLOSE_NO_RESPONSE' } })).json).toMatchObject({ code: 'RESTRICTION_RESPONSE_WINDOW_OPEN' });
      expect((await call('POST', `/vendor/restriction-cases/${caseId}/moves`, { member: ADMIN, ifMatch: 2, body: { move: 'RECORD_RESPONSE' } })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'summary' });
      expect((await call('POST', `/vendor/restriction-cases/${caseId}/moves`, { member: ADMIN, ifMatch: 2, body: { move: 'RECORD_RESPONSE', summary: 'The contractor says the investor caused the delay' } })).json).toMatchObject({ status: 'RESPONSE_RECEIVED' });
      const decisionDoc = await document(true);
      const ban = { decision: 'BAN', reason: 'the delay is proved by the minutes', scope: 'TENANT', ban_months: 24, effective_from: new Date().toISOString().slice(0, 10), decision_document_id: decisionDoc };
      expect((await call('POST', `/vendor/restriction-cases/${caseId}/decision`, { member: ADMIN, ifMatch: 3, body: ban })).status).toBe(403);
      expect((await call('POST', `/vendor/restriction-cases/${caseId}/decision`, { member: CHECKER, ifMatch: 3, body: { ...ban, ban_months: 3 } })).json).toMatchObject({ code: 'RESTRICTION_BAN_PERIOD_INVALID', min_months: 12, max_months: 36 });
      expect((await call('POST', `/vendor/restriction-cases/${caseId}/decision`, { member: CHECKER, ifMatch: 3, body: ban })).json).toMatchObject({ status: 'DECIDED', resource_version: 4 });
      const decided = await call('GET', `/vendor/restriction-cases/${caseId}`, { member: CHECKER });
      expect(decided.json).toMatchObject({ case: { decision: 'BAN', ban_months: 24, decided_late: false }, may_put_into_effect: true, may_lift: true });
      const effect = await call('POST', `/vendor/restriction-cases/${caseId}/effect`, { member: CHECKER, ifMatch: 4 });
      expect(effect.json).toMatchObject({ status: 'EFFECTIVE' });
      const [legal] = await events((await rows<{ id: string }>('select id from machvon.contractor_restriction where case_id = $1', [caseId]))[0]?.id as string, 'vnd.restriction.effective.v1');
      expect(legal?.payload).toMatchObject({ contractor_id: contractorId, case_id: caseId, kind: 'DEBARMENT' });
      const gate = await call('GET', `/vendor/gate-check?contractor_id=${contractorId}&action=PAYMENT`, { member: READER });
      expect(gate.json).toMatchObject({ allowed: false, refusal_code: 'CONTRACTOR_RESTRICTED', action: 'PAYMENT', checks: ['RESTRICTION', 'PAYEE'] });
      const profile = await call('GET', `/vendor/contractors/${contractorId}`, { member: READER });
      expect(profile.json).toMatchObject({ restrictions: [{ kind: 'DEBARMENT', in_force: true, lifted: false, case_id: caseId }], escalation: { decisions_in_force: 1, suggestion: 'NONE' } });
      expect(await call('POST', `/vendor/restriction-cases/${caseId}/lift`, { member: CHECKER, ifMatch: 5, body: { reason: 'the court annulled the decision on appeal' } })).toMatchObject({ json: { status: 'LIFTED' } });
      expect((await call('GET', `/vendor/gate-check?contractor_id=${contractorId}&action=BID_SUBMISSION`, { member: READER })).json).toMatchObject({ allowed: true, warnings: [{ code: 'PROFILE_INCOMPLETE' }] });
      const list = await call('GET', `/vendor/restriction-cases?contractor_id=${contractorId}`, { member: READER });
      expect(list.json).toMatchObject({ items: [{ id: caseId, status: 'LIFTED' }], policy: { code: 'VENDOR_DEBARMENT' } });
    });

    it('opens a case from a record of the national network and a joint venture reaches its members', async () => {
      const contractorId = await contractor('Cty Vendor Egp');
      const importId = randomUUID();
      await rows(`insert into machvon.file_import (tenant_id, id, connector_code, format_version, file_sha256, file_object_key, status, rows_total, rows_applied, imported_by, completed_at) values ($1, $2, 'EGP_RESTRICTION_FILE', 'WORKING-ASSUMPTION-2026.2', $3, 'tenants/x/import/y', 'APPLIED', 1, 1, $4, now())`, [TENANT_A, importId, 'c'.repeat(64), memberId(ADMIN)]);
      const recordId = randomUUID();
      const target = (await rows<{ tax_identifier: string }>('select tax_identifier from machvon.contractor where id = $1', [contractorId]))[0]?.tax_identifier as string;
      await rows(`insert into machvon.egp_record (tenant_id, id, kind, business_key, layout_version, import_id, line, row_hash, record, applied_by) values ($1, $2, 'RESTRICTION', 'R-42', 'WORKING-ASSUMPTION-2026.2', $3, 1, $4, $5::jsonb, $6)`, [
        TENANT_A,
        recordId,
        importId,
        'd'.repeat(64),
        JSON.stringify({ restrictionCode: 'R-42', contractorTaxCode: target, contractorName: null, restrictionKind: 'DEBARMENT', scope: 'NATIONWIDE', validFrom: '2026-10-01', validUntil: '2029-09-30', decisionNo: '42/QD', decisionDate: '2026-09-20', legalBasis: 'Dieu 133' }),
        memberId(ADMIN),
      ]);
      const opened = await call('POST', '/vendor/restriction-cases/from-egp-record', { member: ADMIN, body: { egp_record_id: recordId, violation_groups: ['GROUP_1'] } });
      expect(opened).toMatchObject({ status: 200, json: { status: 'PROPOSED' } });
      const detail = await call('GET', `/vendor/restriction-cases/${opened.json.resource_id}`, { member: READER });
      expect(detail.json).toMatchObject({ case: { trigger_kind: 'EGP_IMPORT', egp_record_id: recordId, contractor_id: contractorId, violation_on: '2026-09-20' } });
      expect((await call('POST', '/vendor/restriction-cases/from-egp-record', { member: ADMIN, body: { egp_record_id: randomUUID(), violation_groups: ['GROUP_1'] } })).status).toBe(404);
      expect((await call('POST', '/vendor/restriction-cases/from-egp-record', { member: READER, body: { egp_record_id: recordId, violation_groups: ['GROUP_1'] } })).status).toBe(403);

      const lead = await contractor('Cty Vendor Lead');
      const member = await contractor('Cty Vendor Member');
      const venture = await call('POST', '/vendor/joint-ventures', { member: ADMIN, body: { name: 'JV Vendor', members: [{ contractor_id: lead, share_pct: '60', lead: true }, { contractor_id: member, share_pct: '40', lead: false }] } });
      expect(venture).toMatchObject({ status: 200, json: { status: 'ACTIVE' } });
      expect((await call('POST', '/vendor/joint-ventures', { member: ADMIN, body: { name: 'JV Bad', members: [{ contractor_id: lead, share_pct: '60', lead: true }, { contractor_id: member, share_pct: '20', lead: false }] } })).json).toMatchObject({ code: 'JOINT_VENTURE_SHARES_INVALID' });
      const list = await call('GET', `/vendor/joint-ventures?contractor_id=${member}`, { member: READER });
      expect(list.json.items).toEqual([expect.objectContaining({ name: 'JV Vendor', members: [expect.objectContaining({ lead: true, share_pct: '60.00' }), expect.objectContaining({ lead: false, share_pct: '40.00' })] })]);
      expect((await call('POST', `/vendor/joint-ventures/${venture.json.resource_id}/end`, { member: ADMIN, ifMatch: 1, body: { reason: 'the package was cancelled' } })).json).toMatchObject({ status: 'ENDED' });
    });
  });

  describe('the ledger of events of bid conduct (VND-06) and the figures (VND-01)', () => {
    it('counts the posting on the calendar, posts by another person and raises the bid security', async () => {
      const contractorId = await contractor('Cty Vendor Event');
      const today = new Date().toISOString().slice(0, 10);
      const recorded = await call('POST', '/vendor/reputation-events', { member: ADMIN, body: { contractor_id: contractorId, behaviour_code: 'NO_BID_SECURITY', event_on: today, description: 'The contractor did not pay the bid security before the opening' } });
      expect(recorded).toMatchObject({ status: 200, json: { status: 'RECORDED' } });
      const eventId = recorded.json.resource_id as string;
      const list = await call('GET', `/vendor/reputation-events?contractor_id=${contractorId}`, { member: CHECKER });
      expect(list.json).toMatchObject({ items: [{ id: eventId, clock: 'ON_TIME', may_post: true, may_retract: true, deadline_policy_version: 'builtin' }], deadline_policy: { code: 'REPUTATION_EVENT', unverified: true } });
      expect((await call('POST', `/vendor/reputation-events/${eventId}/posting`, { member: ADMIN, ifMatch: 1, body: { receipt: 'MSC-2026-0042' } })).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect((await call('POST', `/vendor/reputation-events/${eventId}/posting`, { member: CHECKER, ifMatch: 1, body: { receipt: 'MSC-2026-0042' } })).json).toMatchObject({ status: 'POSTED' });
      const view = await call('GET', `/vendor/contractors/${contractorId}`, { member: READER });
      expect(view.json).toMatchObject({ bid_security: { multiplier: 3, event_ids: [eventId] } });
      expect((await call('POST', '/vendor/reputation-events', { member: ADMIN, body: { contractor_id: contractorId, behaviour_code: 'NO_BID_SECURITY', event_on: '2999-01-01', description: 'An event in the future cannot be recorded' } })).json).toMatchObject({ detail: 'event_on' });
    });

    it('gives the figures of the register with the formula, source and legal status of each indicator', async () => {
      const figures = await call('GET', '/vendor/figures', { member: READER });
      expect(figures.status).toBe(200);
      expect(figures.json).toMatchObject({ profile_coverage: { total: expect.any(Number) }, debarment: { open: expect.any(Number) }, reputation: { posted_in_time: expect.any(Number) }, payee: { changes_requested: expect.any(Number) } });
      const indicators = figures.json.indicators as Array<{ code: string; unverified: boolean; formula: string }>;
      expect(indicators.map((item) => item.code)).toEqual(['VENDOR_PROFILE_COVERAGE', 'VENDOR_DEBARMENT_IN_TIME', 'VENDOR_REPUTATION_POSTED_IN_TIME', 'VENDOR_ACCOUNT_CHANGES']);
      expect(indicators.every((item) => item.unverified && item.formula.length > 10)).toBe(true);
      expect((await call('GET', '/vendor/figures', { member: NOBODY })).status).toBe(403);
    });

    it('answers the gate check for each action and refuses a bad request', async () => {
      const contractorId = await contractor('Cty Vendor Gate');
      for (const action of ['BID_SUBMISSION', 'RESULT', 'CONTRACT_ACTIVATION', 'SUBCONTRACT', 'PAYMENT']) {
        const reply = await call('GET', `/vendor/gate-check?contractor_id=${contractorId}&action=${action}`, { member: READER });
        expect(reply).toMatchObject({ status: 200, json: { action, allowed: true } });
      }
      expect((await call('GET', `/vendor/gate-check?contractor_id=${contractorId}&action=NOTHING`, { member: READER })).status).toBe(422);
      expect((await call('GET', `/vendor/gate-check?contractor_id=${randomUUID()}&action=PAYMENT`, { member: READER })).status).toBe(404);
    });
  });
});
