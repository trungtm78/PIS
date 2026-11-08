import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { FieldCipher, foldForMatch, loadErrorRegistry, matchKeyOf, signTenantContext, staticKeyProvider } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { VENDOR_CIPHER } from '../../src/modules/bid/tokens';
import { VendorIndependenceController } from '../../src/modules/bid/vendor-independence.controller';
import { VendorIndependenceReadsController } from '../../src/modules/bid/vendor-independence-reads.controller';
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
const DECLARER = 6;
const B_ADMIN = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0x98;
const ALL = ['vnd.read', 'vnd.independence.read', 'vnd.interest.declare', 'vnd.independence.run', 'vnd.independence.decide', 'vnd.finance.write', 'vnd.finance.verify', 'vnd.package.controls'];
const DECLARE = ['vnd.interest.declare', 'vnd.independence.read'];
const CHECK = ['vnd.read', 'vnd.independence.read', 'vnd.independence.decide', 'vnd.finance.verify'];
const nameKey = (name: string): string => matchKeyOf(foldForMatch(name));

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the independence, the finance and the load of contractors (VND-2: VND-07, VND-08)', () => {
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

  async function contractor(name: string, keys: { address?: string; rep?: string } = {}): Promise<string> {
    counter += 1;
    const contractorId = randomUUID();
    await rows(
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis, address_key, legal_rep_key)
       values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $5, 'EVIDENCE_DOCUMENT', $8, $9)`,
      [TENANT_A, contractorId, `07${String(counter).padStart(8, '0')}`, name, await document(), memberId(ADMIN), memberId(CHECKER), keys.address === undefined ? null : nameKey(keys.address), keys.rep === undefined ? null : nameKey(keys.rep)],
    );
    return contractorId;
  }

  async function seedPackage(): Promise<{ projectId: string; packageId: string }> {
    const projectId = randomUUID();
    const packageId = randomUUID();
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Vendor project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `PRJ-A${projectId.slice(0, 6)}`, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      );
      await client.query(
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version) values ($1, $2, $3, $4, 1200000, 'OPEN_BIDDING', 1, 'PLANNED', 'Package', $5, 1)`,
        [TENANT_A, packageId, projectId, `GT-A${packageId.slice(0, 6)}`, memberId(ADMIN)],
      );
    } finally {
      await client.end();
    }
    return { projectId, packageId };
  }

  async function bid(projectId: string, packageId: string, contractorId: string): Promise<void> {
    await rows(
      `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, access_released_at, created_by)
       values ($1, $2, $3, $4, $5, '[]'::jsonb, 1, 'RECEIVED', now(), now() + interval '1 day', $6)`,
      [TENANT_A, randomUUID(), projectId, packageId, contractorId, memberId(ADMIN)],
    );
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, CHECKER, READER, UNIT_ADMIN, NOBODY, DECLARER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'VND_ADMIN', ALL, 50);
    await harness.seedRole(TENANT_A, 2, 'VND_CHECKER', CHECK, 40);
    await harness.seedRole(TENANT_A, 3, 'VND_READER', ['vnd.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'VND_DECLARER', DECLARE, 20);
    await harness.seedRole(TENANT_B, 1, 'VND_ADMIN', ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 5, member: DECLARER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [VendorIndependenceController, VendorIndependenceReadsController],
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
    for (const controller of [VendorIndependenceController, VendorIndependenceReadsController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('independence (VND-07)', () => {
    it('declares an interest for oneself only, runs the check, shows the findings with the rule, and lets another person decide once', async () => {
      const { projectId, packageId } = await seedPackage();
      const a = await contractor('Cty API A', { address: '5 Hai Ba Trung', rep: 'Pham Van D' });
      const b = await contractor('Cty API B', { address: '5 Hai Ba Trung', rep: 'Pham Van D' });
      await bid(projectId, packageId, a);
      await bid(projectId, packageId, b);

      // The caller declares about themselves; naming another member needs the right to decide findings.
      const declared = await call('POST', '/vendor/person-interests', { member: DECLARER, body: { kind: 'RELATIVE', related_name: 'Le Thi E', related_identity_number: '079123456789', relation: 'brother' } });
      expect(declared).toMatchObject({ status: 200, json: { status: 'CREATED', resource_version: 1 } });
      const interestId = declared.json.resource_id as string;
      expect((await call('POST', '/vendor/person-interests', { member: DECLARER, body: { membership_id: memberId(ADMIN), kind: 'ADVISORY', tax_code: '0101234567' } })).status).toBe(403);
      expect((await call('POST', '/vendor/person-interests', { member: CHECKER, body: { kind: 'ADVISORY', tax_code: '0101234567' } })).status).toBe(403);
      const [audit] = await audits(interestId, 'vnd.person_interest_declared');
      expect(audit).toMatchObject({ classification: 'PERSONAL', actor_id: memberId(DECLARER) });
      const [event] = await events(interestId, 'vnd.person_interest.declared.v1');
      expect(JSON.stringify(event?.payload)).not.toContain('Le Thi E');
      expect(JSON.stringify(event?.payload)).not.toContain('079123456789');
      const listed = await call('GET', `/vendor/person-interests?membership_id=${memberId(DECLARER)}`, { member: DECLARER });
      expect(listed.status).toBe(200);
      expect((listed.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: interestId, kind: 'RELATIVE', has_related_identity: true, related_name: 'Le Thi E' });
      expect(JSON.stringify(listed.json)).not.toContain('079123456789');

      // Before any run the package is not blocked.
      const before = await call('GET', `/vendor/packages/${packageId}/independence`, { member: CHECKER });
      expect(before.json).toMatchObject({ check: null, findings: [], gate: { checked: false, open: true }, policy: { code: 'VENDOR_INDEPENDENCE', unverified: true } });

      const key = `key-${randomUUID()}`;
      const run = await call('POST', `/vendor/packages/${packageId}/independence-checks`, { member: ADMIN, key, body: { panel_membership_ids: [memberId(DECLARER)], staff_membership_ids: [] } });
      expect(run).toMatchObject({ status: 200, json: { status: 'CHECKED' } });
      const replay = await call('POST', `/vendor/packages/${packageId}/independence-checks`, { member: ADMIN, key, body: { panel_membership_ids: [memberId(DECLARER)], staff_membership_ids: [] } });
      expect(replay.json.resource_id).toBe(run.json.resource_id);
      expect(await rows('select 1 from machvon.vendor_independence_check where package_id = $1', [packageId])).toHaveLength(1);
      // The same facts under another key: nothing new is written.
      const same = await call('POST', `/vendor/packages/${packageId}/independence-checks`, { member: ADMIN, body: { panel_membership_ids: [memberId(DECLARER)], staff_membership_ids: [] } });
      expect(same.json).toMatchObject({ status: 'UNCHANGED', resource_id: run.json.resource_id });
      expect(await rows('select 1 from machvon.vendor_independence_check where package_id = $1', [packageId])).toHaveLength(1);
      expect((await events(run.json.resource_id as string, 'vnd.independence.checked.v1'))[0]?.payload).toMatchObject({ package_id: packageId, bidders: 2, findings: 2, strong: 1, gate_open: false });

      const view = await call('GET', `/vendor/packages/${packageId}/independence`, { member: CHECKER });
      const findings = view.json.findings as Array<Record<string, unknown>>;
      expect(findings.map((one) => `${one.kind}:${one.strength}`).sort()).toEqual(['BIDDERS_SHARE_ADDRESS:MEDIUM', 'BIDDERS_SHARE_REPRESENTATIVE:STRONG']);
      expect(view.json.gate).toMatchObject({ checked: true, open: false, undecided_strong: 1 });
      const strong = findings.find((one) => one.strength === 'STRONG') as Record<string, unknown>;
      expect(strong).toMatchObject({ allowed_decisions: ['CLEARED', 'BLOCKED'], can_decide: true, decision: null });
      expect(((view.json.check as Record<string, unknown>).run_by)).toBe(memberId(ADMIN));

      const decisionUrl = `/vendor/independence-findings/${strong.id as string}/decide`;
      const reason = 'the representative is the same person on both registrations';
      expect((await call('POST', decisionUrl, { member: ADMIN, ifMatch: 1, body: { decision: 'BLOCKED', reason } })).status).toBe(403);
      expect((await call('POST', decisionUrl, { member: CHECKER, ifMatch: 1, body: { decision: 'BLOCKED', reason: 'short' } })).status).toBe(422);
      expect((await call('POST', decisionUrl, { member: CHECKER, ifMatch: 1, body: { decision: 'RECUSED', reason } })).json).toMatchObject({ code: 'INDEPENDENCE_DECISION_INVALID' });
      expect((await call('POST', decisionUrl, { member: CHECKER, ifMatch: 9, body: { decision: 'BLOCKED', reason } })).status).toBe(409);
      const decided = await call('POST', decisionUrl, { member: CHECKER, ifMatch: 1, body: { decision: 'BLOCKED', reason } });
      expect(decided).toMatchObject({ status: 200, json: { status: 'BLOCKED', resource_version: 2 } });
      expect((await audits(strong.id as string, 'vnd.independence_decided'))[0]).toMatchObject({ classification: 'CONFIDENTIAL', reason, actor_id: memberId(CHECKER) });
      expect((await call('POST', decisionUrl, { member: CHECKER, ifMatch: 2, body: { decision: 'CLEARED', reason } })).status).toBe(409);

      // The caller who may not read independence, and a caller with a grant on a unit only, are refused; so is a stranger.
      expect((await call('GET', `/vendor/packages/${packageId}/independence`, { member: READER })).status).toBe(403);
      expect((await call('GET', `/vendor/packages/${packageId}/independence`, { member: UNIT_ADMIN })).json).toMatchObject({ code: 'SCOPE_DENIED' });
      expect((await call('POST', `/vendor/packages/${packageId}/independence-checks`, { member: UNIT_ADMIN, body: { panel_membership_ids: [], staff_membership_ids: [] } })).status).toBe(403);
      expect((await call('GET', `/vendor/packages/${packageId}/independence`, { member: NOBODY })).status).toBe(403);
      // A foreign package is not found.
      expect((await call('GET', `/vendor/packages/${packageId}/independence`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('POST', decisionUrl, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: 1, body: { decision: 'BLOCKED', reason } })).status).toBe(404);

      // The declaration ends once, by its owner.
      expect((await call('POST', `/vendor/person-interests/${interestId}/end`, { member: ADMIN, ifMatch: 1, body: { reason: 'the relative left the bidder' } })).status).toBe(200);
      expect((await call('POST', `/vendor/person-interests/${interestId}/end`, { member: ADMIN, ifMatch: 2, body: { reason: 'again and again' } })).status).toBe(409);
    });
  });

  describe('finance and load (VND-08)', () => {
    const period = (year: number, document_id?: string) => ({ fiscal_year: year, revenue: 1_000_000, total_assets: 2_000_000, current_assets: 1_200_000, current_liabilities: 800_000, total_debt: 900_000, equity: 1_100_000, ebit: 300_000, interest_expense: 100_000, ...(document_id === undefined ? {} : { document_id }) });

    it('records a year, verifies it by another person with a paper, shows the ratios with their rule and refuses a duplicate', async () => {
      const contractorId = await contractor('Cty API Finance');
      const paper = await document();
      const recorded = await call('POST', `/vendor/contractors/${contractorId}/financial-periods`, { member: ADMIN, body: period(2025, paper) });
      expect(recorded).toMatchObject({ status: 200, json: { status: 'CREATED', resource_version: 1 } });
      const periodId = recorded.json.resource_id as string;
      expect((await call('POST', `/vendor/contractors/${contractorId}/financial-periods`, { member: ADMIN, body: period(2025, paper) })).json).toMatchObject({ code: 'FINANCIAL_PERIOD_DUPLICATE' });
      expect((await call('POST', `/vendor/contractors/${contractorId}/financial-periods`, { member: ADMIN, body: { ...period(2024), current_assets: 9_000_000 } })).status).toBe(422);
      expect((await call('POST', `/vendor/financial-periods/${periodId}/verify`, { member: ADMIN, ifMatch: 1 })).status).toBe(403);
      expect((await call('POST', `/vendor/financial-periods/${periodId}/verify`, { member: CHECKER, ifMatch: 4 })).status).toBe(409);
      expect((await call('POST', `/vendor/financial-periods/${periodId}/verify`, { member: CHECKER, ifMatch: 1 })).json).toMatchObject({ status: 'VERIFIED', resource_version: 2 });
      expect((await audits(periodId, 'vnd.financial_period_verified'))[0]).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(CHECKER) });

      const view = await call('GET', `/vendor/contractors/${contractorId}/finance`, { member: READER });
      expect(view.status).toBe(200);
      expect(view.json).toMatchObject({ overall: 'INSUFFICIENT_DATA', verified_years: 1, average_revenue: 1_000_000, policy: { code: 'VENDOR_FINANCE', unverified: true } });
      expect((view.json.periods as Array<Record<string, unknown>>)[0]).toMatchObject({ fiscal_year: 2025, verified: true, ratios: { current_ratio: 1.5, interest_cover: 3 } });

      const capacity = await call('GET', `/vendor/contractors/${contractorId}/capacity`, { member: READER });
      expect(capacity.json).toMatchObject({ status: 'WITHIN', load: 0, facts: { open_contract_count: 0, average_annual_revenue: 1_000_000 }, capacity_policy: { code: 'VENDOR_CAPACITY' }, finance_policy: { code: 'VENDOR_FINANCE' } });
      expect((await call('GET', `/vendor/contractors/${contractorId}/finance?package_id=not-a-uuid`, { member: READER })).status).toBe(422);
      expect((await call('GET', `/vendor/contractors/${contractorId}/finance`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('POST', `/vendor/contractors/${contractorId}/financial-periods`, { member: READER, body: period(2023) })).status).toBe(403);
    });

    it('sets the controls of a package under a version and judges a contractor against them', async () => {
      const { packageId } = await seedPackage();
      const contractorId = await contractor('Cty API Package');
      const paper = await document();
      const empty = await call('GET', `/vendor/packages/${packageId}/controls`, { member: READER });
      expect(empty.json).toMatchObject({ package_id: packageId, security_base_amount: null, budget_vnd: 1_200_000, version: 0 });
      const set = await call('POST', `/vendor/packages/${packageId}/controls`, { member: ADMIN, ifMatch: 0, body: { security_base_amount: 50_000, bid_valid_until: '2026-12-31', estimated_value: 200_000, duration_months: 12 } });
      expect(set).toMatchObject({ status: 200, json: { status: 'UPDATED', resource_version: 1 } });
      expect((await call('POST', `/vendor/packages/${packageId}/controls`, { member: ADMIN, ifMatch: 0, body: { security_base_amount: 1 } })).status).toBe(409);
      expect((await call('POST', `/vendor/packages/${packageId}/controls`, { member: ADMIN, ifMatch: 1, body: { bid_valid_until: '2026-13-45' } })).status).toBe(422);
      expect((await call('POST', `/vendor/packages/${packageId}/controls`, { member: READER, ifMatch: 1, body: {} })).status).toBe(403);
      for (const year of [2024, 2025]) {
        const made = await call('POST', `/vendor/contractors/${contractorId}/financial-periods`, { member: ADMIN, body: period(year, paper) });
        await call('POST', `/vendor/financial-periods/${made.json.resource_id as string}/verify`, { member: CHECKER, ifMatch: 1 });
      }
      const judged = await call('GET', `/vendor/contractors/${contractorId}/finance?package_id=${packageId}`, { member: READER });
      expect(judged.json).toMatchObject({ overall: 'MEETS', required_revenue: 400_000, requirement: { package_id: packageId, package_value: 200_000, duration_months: 12, value_from: 'ESTIMATED_VALUE' } });
      expect((judged.json.results as Array<Record<string, unknown>>).map((one) => `${one.test}:${one.status}`)).toEqual(['CURRENT_RATIO:PASS', 'DEBT_TO_ASSETS:PASS', 'INTEREST_COVER:PASS', 'AVERAGE_REVENUE:PASS']);
    });
  });
});
