import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { VendorSecurityController, VendorSecurityReadsController } from '../../src/modules/bid/vendor-security.controller';
import { VendorSubcontractController, VendorSubcontractReadsController } from '../../src/modules/bid/vendor-subcontract.controller';
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
const B_ADMIN = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0x9b;
const ALL = ['vnd.read', 'vnd.security.write', 'vnd.security.confirm', 'vnd.security.forfeit.propose', 'vnd.security.forfeit.decide', 'vnd.subcontract.write', 'vnd.subcontract.approve', 'vnd.subcontract.pay'];
const CHECK = ['vnd.read', 'vnd.security.confirm', 'vnd.security.forfeit.decide', 'vnd.subcontract.approve'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the bid security register and the subcontracts (VND-2: VND-09 and VND-10)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string; classification: string }>('select safe_diff, reason, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [aggregateId, type]);

  async function document(): Promise<string> {
    const documentId = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)`,
      [TENANT_A, documentId, memberId(ADMIN)],
    );
    return documentId;
  }

  async function contractor(name: string): Promise<string> {
    counter += 1;
    const contractorId = randomUUID();
    await rows(
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis)
       values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $8, 'EVIDENCE_DOCUMENT')`,
      [TENANT_A, contractorId, `08${String(counter).padStart(8, '0')}`, name, await document(), memberId(ADMIN), memberId(CHECKER), await document()],
    );
    return contractorId;
  }

  async function seedWorld(primeId: string): Promise<{ packageId: string; contractId: string; projectId: string }> {
    const projectId = randomUUID();
    const packageId = randomUUID();
    const contractId = randomUUID();
    const revisionId = randomUUID();
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Vendor control project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `PRJ-C${projectId.slice(0, 6)}`, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      );
      await client.query(
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version) values ($1, $2, $3, $4, 100000000, 'OPEN_BIDDING', 1, 'AWARDED', 'Package', $5, 1)`,
        [TENANT_A, packageId, projectId, `GT-C${packageId.slice(0, 6)}`, memberId(ADMIN)],
      );
      await client.query(
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by, signed_on, effective_from, current_revision_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'OTHER', false, false, 10000000, $7, $7, date '2026-01-01', date '2026-01-02', $8)`,
        [TENANT_A, contractId, projectId, packageId, primeId, `HD-C${contractId.slice(0, 6)}`, memberId(ADMIN), revisionId],
      );
      await client.query(
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, 10000000, $4, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $5, $5, $5, now())`,
        [TENANT_A, revisionId, contractId, randomUUID(), memberId(ADMIN)],
      );
      await client.query(
        `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by) values ($1, gen_random_uuid(), $2, $3, 'SOLE', 100, 10000000, 'ACTIVE', date '2026-01-02', $4, $4)`,
        [TENANT_A, contractId, primeId, memberId(ADMIN)],
      );
    } finally {
      await client.end();
    }
    return { packageId, contractId, projectId };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, CHECKER, READER, UNIT_ADMIN, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
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
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [VendorSecurityController, VendorSecurityReadsController, VendorSubcontractController, VendorSubcontractReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of BID', () => {
    for (const controller of [VendorSecurityController, VendorSecurityReadsController, VendorSubcontractController, VendorSubcontractReadsController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('the bid security (VND-09)', () => {
    it('receives once per idempotency key, confirms by another person, audits and announces with ids only, and judges the amount the package asks', async () => {
      const prime = await contractor('Cty Security API');
      const world = await seedWorld(prime);
      await rows('insert into machvon.vendor_package_control (tenant_id, package_id, security_base_amount, bid_valid_until, created_by, updated_by) values ($1, $2, 1000, $3::date, $4, $4)', [TENANT_A, world.packageId, '2026-12-31', memberId(ADMIN)]);
      const body = { package_id: world.packageId, contractor_id: prime, kind: 'BANK_GUARANTEE', issuer: 'Vietcombank', security_no: 'BL-API-1', amount: 1000, issued_on: '2026-11-01', valid_until: '2027-03-01' };
      const key = `key-${randomUUID()}`;
      const received = await call('POST', '/vendor/bid-securities', { member: ADMIN, body, key });
      expect(received).toMatchObject({ status: 200, json: { status: 'RECEIVED', resource_version: 1 } });
      const securityId = received.json.resource_id as string;
      const replay = await call('POST', '/vendor/bid-securities', { member: ADMIN, body, key });
      expect(replay.json.resource_id).toBe(securityId);
      expect(await rows('select 1 from machvon.vendor_bid_security where package_id = $1', [world.packageId])).toHaveLength(1);
      const [audit] = await audits(securityId, 'vnd.bid_security_received');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(ADMIN), safe_diff: { package_id: world.packageId, contractor_id: prime, state: 'RECEIVED', required_amount: 1000 } });
      const [event] = await events(securityId, 'vnd.bid_security.changed.v1');
      expect(event?.payload).toMatchObject({ resource_id: securityId, move: 'RECEIVE', actor_id: memberId(ADMIN) });
      expect(JSON.stringify(event?.payload)).not.toContain('Vietcombank');

      const listed = await call('GET', `/vendor/bid-securities?package_id=${world.packageId}&contractor_id=${prime}`, { member: READER });
      expect(listed.status).toBe(200);
      expect(listed.json).toMatchObject({
        items: [{ id: securityId, state: 'RECEIVED', required_amount: 1000, factor_applied: 1, may_confirm: false }],
        standing: { required_amount: 1000, factor: 1, satisfied: false, gaps: ['NOT_CONFIRMED'], enforcement: 'BLOCK' },
        policy: { code: 'VENDOR_BID_SECURITY', unverified: true },
      });

      // The receiver cannot confirm their own security; a reader and a grant on a unit cannot confirm at all.
      expect(await call('POST', `/vendor/bid-securities/${securityId}/confirm`, { member: ADMIN, ifMatch: 1, body: { issuer_reference: 'VCB-REF-1' } })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await call('POST', `/vendor/bid-securities/${securityId}/confirm`, { member: READER, ifMatch: 1, body: { issuer_reference: 'VCB-REF-1' } })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await call('POST', `/vendor/bid-securities/${securityId}/confirm`, { member: UNIT_ADMIN, ifMatch: 1, body: { issuer_reference: 'VCB-REF-1' } })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await call('POST', `/vendor/bid-securities/${securityId}/confirm`, { member: NOBODY, ifMatch: 1, body: { issuer_reference: 'VCB-REF-1' } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/vendor/bid-securities/${securityId}/confirm`, { member: CHECKER, ifMatch: 7, body: { issuer_reference: 'VCB-REF-1' } })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const confirmed = await call('POST', `/vendor/bid-securities/${securityId}/confirm`, { member: CHECKER, ifMatch: 1, body: { issuer_reference: 'VCB-REF-1' } });
      expect(confirmed).toMatchObject({ status: 200, json: { status: 'CONFIRMED', resource_version: 2 } });
      expect(await call('POST', `/vendor/bid-securities/${securityId}/confirm`, { member: CHECKER, ifMatch: 2, body: { issuer_reference: 'VCB-REF-2' } })).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });

      const detail = await call('GET', `/vendor/bid-securities/${securityId}`, { member: READER });
      expect(detail.json).toMatchObject({ security: { id: securityId, state: 'CONFIRMED', issuer_reference: 'VCB-REF-1' }, standing: { satisfied: true, enforcement: 'NONE' } });
      expect((detail.json.events as Array<{ move: string }>).map((one) => one.move)).toEqual(['RECEIVE', 'CONFIRM']);

      // A tenant of another kind sees nothing, and a filter or an id that is not valid is refused.
      expect((await call('GET', `/vendor/bid-securities/${securityId}`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', '/vendor/bid-securities', { member: B_ADMIN, tenantId: TENANT_B })).json).toMatchObject({ items: [] });
      expect(await call('GET', '/vendor/bid-securities?state=NOPE', { member: READER })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await call('GET', '/vendor/bid-securities?package_id=abc', { member: READER })).toMatchObject({ status: 422 });
      expect((await call('GET', '/vendor/bid-securities', { member: NOBODY })).status).toBe(403);
    });

    it('moves a forfeiture through a proposal and the decision of another person on a paper, and announces the behaviour of the ledger of bid conduct', async () => {
      const prime = await contractor('Cty Forfeit API');
      const world = await seedWorld(prime);
      const received = await call('POST', '/vendor/bid-securities', { member: ADMIN, body: { package_id: world.packageId, contractor_id: prime, kind: 'INSURANCE_BOND', issuer: 'Bao Viet', security_no: 'BV-API-1', amount: 500, issued_on: '2026-11-01', valid_until: '2027-03-01' } });
      const securityId = received.json.resource_id as string;
      await call('POST', `/vendor/bid-securities/${securityId}/confirm`, { member: CHECKER, ifMatch: 1, body: { issuer_reference: 'BV-REF-1' } });
      expect(await call('POST', `/vendor/bid-securities/${securityId}/propose-forfeiture`, { member: ADMIN, ifMatch: 2, body: { reason_code: 'REFUSED_TO_SIGN', reason: 'short' } })).toMatchObject({ status: 422, json: { code: 'REASON_REQUIRED' } });
      expect(await call('POST', `/vendor/bid-securities/${securityId}/propose-forfeiture`, { member: CHECKER, ifMatch: 2, body: { reason_code: 'REFUSED_TO_SIGN', reason: 'The winner refused to sign the contract in the window' } })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      const proposed = await call('POST', `/vendor/bid-securities/${securityId}/propose-forfeiture`, { member: ADMIN, ifMatch: 2, body: { reason_code: 'REFUSED_TO_SIGN', reason: 'The winner refused to sign the contract in the window' } });
      expect(proposed).toMatchObject({ status: 200, json: { status: 'FORFEIT_PROPOSED', resource_version: 3 } });
      const decision = { decision: 'FORFEIT', reason: 'Confirmed against the contract file by the board', decision_document_id: await document() };
      expect(await call('POST', `/vendor/bid-securities/${securityId}/decide-forfeiture`, { member: ADMIN, ifMatch: 3, body: decision })).toMatchObject({ status: 403 });
      expect(await call('POST', `/vendor/bid-securities/${securityId}/decide-forfeiture`, { member: CHECKER, ifMatch: 3, body: { decision: 'FORFEIT', reason: decision.reason } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const forfeited = await call('POST', `/vendor/bid-securities/${securityId}/decide-forfeiture`, { member: CHECKER, ifMatch: 3, body: decision });
      expect(forfeited).toMatchObject({ status: 200, json: { status: 'FORFEITED', resource_version: 4 } });
      const [audit] = await audits(securityId, 'vnd.bid_security_forfeited');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(CHECKER), reason: decision.reason });
      const [event] = (await events(securityId, 'vnd.bid_security.changed.v1')).slice(-1);
      expect(event?.payload).toMatchObject({ move: 'DECIDE_FORFEIT', state: 'FORFEITED', conduct_behaviour: 'WINNING_WITHOUT_SIGNING' });
      expect(await call('POST', `/vendor/bid-securities/${securityId}/release`, { member: ADMIN, ifMatch: 4, body: { reason: 'Released by mistake' } })).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    });

    it('rejects, withdraws and releases', async () => {
      const prime = await contractor('Cty Security Other');
      const world = await seedWorld(prime);
      const make = async (no: string): Promise<string> => (await call('POST', '/vendor/bid-securities', { member: ADMIN, body: { package_id: world.packageId, contractor_id: prime, kind: 'CASH_DEPOSIT', issuer: 'Treasury', security_no: no, amount: 100, issued_on: '2026-11-01', valid_until: '2027-03-01' } })).json.resource_id as string;
      const first = await make('CD-1');
      expect(await call('POST', `/vendor/bid-securities/${first}/reject`, { member: CHECKER, ifMatch: 1, body: { reason: 'Not known to the issuer, no such deposit' } })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      const second = await make('CD-2');
      await call('POST', `/vendor/bid-securities/${second}/confirm`, { member: CHECKER, ifMatch: 1, body: { issuer_reference: 'CD-REF-2' } });
      const proposed = await call('POST', `/vendor/bid-securities/${second}/propose-forfeiture`, { member: ADMIN, ifMatch: 2, body: { reason_code: 'NO_PERFORMANCE_SECURITY', reason: 'No performance security was lodged in 28 days' } });
      expect(proposed.status).toBe(200);
      expect(await call('POST', `/vendor/bid-securities/${second}/withdraw-forfeiture`, { member: CHECKER, ifMatch: 3, body: {} })).toMatchObject({ status: 403 });
      expect(await call('POST', `/vendor/bid-securities/${second}/withdraw-forfeiture`, { member: ADMIN, ifMatch: 3, body: {} })).toMatchObject({ status: 200, json: { status: 'CONFIRMED' } });
      expect(await call('POST', `/vendor/bid-securities/${second}/release`, { member: ADMIN, ifMatch: 4, body: { reason: 'The contract was signed with another bidder', expired: false } })).toMatchObject({ status: 200, json: { status: 'RELEASED' } });
      const listed = await call('GET', `/vendor/bid-securities?package_id=${world.packageId}&state=RELEASED`, { member: READER });
      expect((listed.json.items as unknown[]).length).toBe(1);
    });
  });

  describe('the subcontracts (VND-10)', () => {
    it('declares the bid, proposes, approves by another person with a reasoned exception, and keeps the foreign contract out', async () => {
      const prime = await contractor('Cty Prime API');
      const named = await contractor('Cty Sub Named API');
      const unnamed = await contractor('Cty Sub Unnamed API');
      const world = await seedWorld(prime);
      const declared = await call('POST', '/vendor/bid-declarations', { member: ADMIN, body: { package_id: world.packageId, contractor_id: prime, declared_share_pct: '30', subcontractor_ids: [named] } });
      expect(declared).toMatchObject({ status: 200, json: { status: 'DECLARED' } });
      expect(await call('POST', '/vendor/bid-declarations', { member: ADMIN, body: { package_id: world.packageId, contractor_id: prime, declared_share_pct: '130', subcontractor_ids: [named] } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const proposed = await call('POST', '/vendor/subcontracts', { member: ADMIN, body: { contract_id: world.contractId, subcontractor_id: named, scope: 'Earth works of the north wing', value: 2000000, share_pct: '20' } });
      expect(proposed).toMatchObject({ status: 200, json: { status: 'PROPOSED', resource_version: 1 } });
      const subId = proposed.json.resource_id as string;
      expect(await call('POST', `/vendor/subcontracts/${subId}/approve`, { member: ADMIN, ifMatch: 1, body: {} })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await call('POST', `/vendor/subcontracts/${subId}/approve`, { member: READER, ifMatch: 1, body: {} })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      const approved = await call('POST', `/vendor/subcontracts/${subId}/approve`, { member: CHECKER, ifMatch: 1, body: {} });
      expect(approved).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2 } });
      const [audit] = await audits(subId, 'vnd.subcontract_approved');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(CHECKER) });
      const [event] = await events(subId, 'vnd.subcontract.changed.v1');
      expect(event?.payload).toMatchObject({ resource_id: subId });
      expect(JSON.stringify(event?.payload)).not.toContain('Earth works');

      const second = await call('POST', '/vendor/subcontracts', { member: ADMIN, body: { contract_id: world.contractId, subcontractor_id: unnamed, scope: 'Painting of the facades', value: 1500000, share_pct: '15' } });
      const secondId = second.json.resource_id as string;
      expect(await call('POST', `/vendor/subcontracts/${secondId}/approve`, { member: CHECKER, ifMatch: 1, body: {} })).toMatchObject({ status: 422, json: { code: 'REASON_REQUIRED' } });
      expect(await call('POST', `/vendor/subcontracts/${secondId}/approve`, { member: CHECKER, ifMatch: 1, body: { exception_reason: 'The investor agreed to the extra subcontractor in writing' } })).toMatchObject({ status: 200, json: { status: 'APPROVED' } });

      const listed = await call('GET', `/vendor/subcontracts?contract_id=${world.contractId}`, { member: READER });
      expect(listed.status).toBe(200);
      expect(listed.json).toMatchObject({ contract_value: 10000000, total_share_pct: 35, prime_share_pct: 65, prime_min_share_pct: 51, declaration: { declared_share_pct: 30 }, policy: { code: 'VENDOR_SUBCONTRACT', unverified: true } });
      expect((listed.json.items as Array<{ id: string; findings: string[]; exception_approved: boolean }>).find((one) => one.id === secondId)).toMatchObject({ exception_approved: true, findings: ['NOT_NAMED_IN_BID', 'OVER_DECLARED_SHARE'] });

      expect(await call('POST', `/vendor/subcontracts/${secondId}/terminate`, { member: CHECKER, ifMatch: 2, body: { reason: 'The painting works were taken back' } })).toMatchObject({ status: 200, json: { status: 'TERMINATED' } });
      expect((await call('GET', `/vendor/subcontracts?contract_id=${world.contractId}`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect(await call('GET', '/vendor/subcontracts', { member: READER })).toMatchObject({ status: 422 });
      expect((await call('GET', `/vendor/subcontracts?contract_id=${world.contractId}`, { member: NOBODY })).status).toBe(403);
      expect(await call('POST', `/vendor/subcontracts/${subId}/approve`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: 2, body: {} })).toMatchObject({ status: 404 });
    });

    it('records what the prime paid after a payment request and refuses a subcontract that is not approved', async () => {
      const prime = await contractor('Cty Prime Payments');
      const sub = await contractor('Cty Sub Payments');
      const world = await seedWorld(prime);
      await call('POST', '/vendor/bid-declarations', { member: ADMIN, body: { package_id: world.packageId, contractor_id: prime, declared_share_pct: '20', subcontractor_ids: [sub] } });
      const proposed = await call('POST', '/vendor/subcontracts', { member: ADMIN, body: { contract_id: world.contractId, subcontractor_id: sub, scope: 'Roofing works of all the halls', value: 2000000, share_pct: '20' } });
      const subId = proposed.json.resource_id as string;
      expect(await call('POST', `/vendor/subcontracts/${subId}/payments`, { member: ADMIN, body: { paid_amount: 100, paid_on: '2026-11-02', reference: 'UNC-API-1' } })).toMatchObject({ status: 409, json: { code: 'SUBCONTRACT_STATE_INVALID' } });
      await call('POST', `/vendor/subcontracts/${subId}/approve`, { member: CHECKER, ifMatch: 1, body: {} });
      expect(await call('POST', `/vendor/subcontracts/${subId}/payments`, { member: CHECKER, body: { paid_amount: 100, paid_on: '2026-11-02', reference: 'UNC-API-1' } })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await call('POST', `/vendor/subcontracts/${subId}/payments`, { member: ADMIN, body: { paid_amount: 0, paid_on: '2026-11-02', reference: 'UNC-API-1' } })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const paid = await call('POST', `/vendor/subcontracts/${subId}/payments`, { member: ADMIN, body: { paid_amount: 1500000, paid_on: '2026-11-02', reference: 'UNC-API-1' } });
      expect(paid).toMatchObject({ status: 200, json: { status: 'RECORDED' } });
      const [event] = await events(subId, 'vnd.subcontract_payment.recorded.v1');
      expect(event?.payload).toMatchObject({ resource_id: subId, paid_amount: 1500000 });
      const listed = await call('GET', `/vendor/subcontracts?contract_id=${world.contractId}`, { member: READER });
      expect((listed.json.items as Array<{ paid_total: number; over_paid: number; payments: unknown[] }>)[0]).toMatchObject({ paid_total: 1500000, over_paid: 0 });
    });
  });
});
