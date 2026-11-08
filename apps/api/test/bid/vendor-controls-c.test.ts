import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { VendorPerformanceController, VendorPerformanceReadsController } from '../../src/modules/bid/vendor-performance.controller';
import { VendorRiskController, VendorRiskReadsController } from '../../src/modules/bid/vendor-risk.controller';
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
const FAMILY = 0x9a;
const ALL = ['vnd.read', 'vnd.risk.assess', 'vnd.risk.decide', 'vnd.performance.publish'];
const CHECK = ['vnd.read', 'vnd.risk.decide', 'vnd.performance.publish'];
const TODAY = new Date().toISOString().slice(0, 10);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the risk grade and the performance of a contractor (VND-2: VND-11 and VND-12)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  let projectId = '';
  let packageId = '';

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

  async function contractor(name: string): Promise<string> {
    counter += 1;
    const contractorId = randomUUID();
    const profile = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)`,
      [TENANT_A, profile, memberId(ADMIN)],
    );
    await rows(
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis)
       values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $5, 'EVIDENCE_DOCUMENT')`,
      [TENANT_A, contractorId, `07${String(counter).padStart(8, '0')}`, name, profile, memberId(ADMIN), memberId(CHECKER)],
    );
    return contractorId;
  }

  /** An adopted rating (or one only told to the contractor) of a contract that ended on the day given; adopted by the ADMIN member, so the ADMIN may not post it. */
  async function rated(contractorId: string, code: string, endedOn: string, state: 'ADOPTED' | 'NOTIFIED' = 'ADOPTED'): Promise<string> {
    const contract = randomUUID();
    const evaluation = randomUUID();
    const proposal = randomUUID();
    await rows(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, signed_on, effective_from, contract_value_vnd, terminated_on)
       values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', 'ACTIVE', 1, date '2025-01-01', date '2025-01-01', 1000000, $7::date)`,
      [TENANT_A, contract, projectId, packageId, contractorId, code, endedOn],
    );
    if (state === 'ADOPTED') {
      await rows(
        `insert into machvon.contractor_performance (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, score_quality, score_schedule, score_safety_env, score_cooperation, score_financial, overall_score, rating, status, evaluated_by, approved_by, approved_at, created_by, updated_by)
         values ($1, $2, $3, $4, 'COMPLETION', 'FINAL', 40, 40, 40, 40, 40, 40, 'POOR', 'APPROVED', $5, $6, now(), $5, $5)`,
        [TENANT_A, evaluation, contract, contractorId, memberId(CHECKER), memberId(ADMIN)],
      );
    }
    await rows(
      `insert into machvon.contract_rating_proposal
         (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, as_of_date, rule_version, rule_source, reasons, readings, covered, overall_score, rating, inputs_sha256, state, proposed_by,
          notified_by, notified_at, response_due_at, adopted_by, adopted_at, evaluation_id, created_by, updated_by)
       values ($1, $2, $3, $4, 'COMPLETION', 'FINAL', $5::date, 0, 'DEFAULT', '{}'::jsonb, '{}'::jsonb, 5, 40, 'POOR', $6, $7, $8, $9, now(), now() + interval '20 days', $10, $11, $12, $8, $8)`,
      [TENANT_A, proposal, contract, contractorId, endedOn, 'b'.repeat(64), state, memberId(CHECKER), memberId(READER), state === 'ADOPTED' ? memberId(ADMIN) : null, state === 'ADOPTED' ? new Date().toISOString() : null, state === 'ADOPTED' ? evaluation : null],
    );
    return proposal;
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
    projectId = randomUUID();
    packageId = randomUUID();
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-VND2C-API', 'Vendor project', $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      );
      await client.query(
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version) values ($1, $2, $3, 'GT-VND2C-API', 1000, 'OPEN_BIDDING', 1, 'PLANNED', 'Package', $4, 1)`,
        [TENANT_A, packageId, projectId, memberId(ADMIN)],
      );
    } finally {
      await client.end();
    }
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [VendorRiskController, VendorRiskReadsController, VendorPerformanceController, VendorPerformanceReadsController],
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
    for (const controller of [VendorRiskController, VendorRiskReadsController, VendorPerformanceController, VendorPerformanceReadsController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('the risk grade (VND-11)', () => {
    it('assesses, keeps one proposal waiting, shows the explanation and confirms; audits and announces with ids only', async () => {
      const contractorId = await contractor('Cty Risk Api');
      const before = await call('GET', `/vendor/contractors/${contractorId}/risk`, { member: READER });
      expect(before.status).toBe(200);
      expect(before.json).toMatchObject({ contractor_id: contractorId, tier: null, confirmed: null, pending: null, live: { tier: 'LOW', score: 15, dual_check: false, reasons: ['PROFILE_GAP', 'FINANCE_BELOW'] } });
      expect((before.json.live as { factors: unknown[] }).factors).toHaveLength(11);
      expect(before.json.policy).toMatchObject({ code: 'VENDOR_RISK', version: 'builtin', unverified: true });
      expect(typeof (before.json.policy as { formula: string }).formula).toBe('string');

      const assessed = await call('POST', `/vendor/contractors/${contractorId}/risk-assessments`, { member: ADMIN });
      expect(assessed).toMatchObject({ status: 200, json: { status: 'PROPOSED', resource_version: 1 } });
      const assessmentId = assessed.json.resource_id as string;
      const [audit] = await audits(assessmentId, 'vnd.risk_assessed');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(ADMIN), safe_diff: { contractor_id: contractorId, tier: 'LOW', score: 15 } });
      const [event] = await events(assessmentId, 'vnd.risk.assessed.v1');
      expect(event?.payload).toMatchObject({ contractor_id: contractorId, tier: 'LOW', actor_id: memberId(ADMIN) });
      expect(JSON.stringify(event?.payload)).not.toContain('Cty Risk Api');

      expect((await call('POST', `/vendor/contractors/${contractorId}/risk-assessments`, { member: ADMIN })).json).toMatchObject({ code: 'RISK_ASSESSMENT_STATE_INVALID' });
      const waiting = await call('GET', `/vendor/contractors/${contractorId}/risk`, { member: CHECKER });
      expect(waiting.json).toMatchObject({ pending: { id: assessmentId, state: 'PROPOSED', can_decide: true } });
      expect((await call('GET', `/vendor/contractors/${contractorId}/risk`, { member: READER })).json).toMatchObject({ pending: { can_decide: false } });

      expect((await call('POST', `/vendor/risk-assessments/${assessmentId}/decide`, { member: ADMIN, ifMatch: 5, body: { decision: 'CONFIRM' } })).json).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect((await call('POST', `/vendor/risk-assessments/${assessmentId}/decide`, { member: ADMIN, ifMatch: 1, body: { decision: 'MAYBE' } })).status).toBe(422);
      const confirmed = await call('POST', `/vendor/risk-assessments/${assessmentId}/decide`, { member: ADMIN, ifMatch: 1, body: { decision: 'CONFIRM' } });
      expect(confirmed).toMatchObject({ status: 200, json: { status: 'CONFIRMED', resource_version: 2 } });
      const [decided] = await audits(assessmentId, 'vnd.risk_confirmed');
      expect(decided).toMatchObject({ safe_diff: { contractor_id: contractorId, tier: 'LOW', state: 'CONFIRMED' } });
      expect((await events(assessmentId, 'vnd.risk.decided.v1'))[0]?.payload).toMatchObject({ decision: 'CONFIRM', state: 'CONFIRMED' });

      const after = await call('GET', `/vendor/contractors/${contractorId}/risk`, { member: READER });
      expect(after.json).toMatchObject({ tier: 'LOW', confirmed: { id: assessmentId, state: 'CONFIRMED', decided_by: memberId(ADMIN) }, pending: null });
      const register = await call('GET', '/vendor/risk-grades?tier=LOW&q=Risk%20Api', { member: READER });
      expect(register.status).toBe(200);
      expect((register.json.items as Array<{ contractor_id: string; tier: string }>).map((one) => [one.contractor_id, one.tier])).toEqual([[contractorId, 'LOW']]);
      expect(register.json.policy).toMatchObject({ code: 'VENDOR_RISK' });
      expect((register.json.figures as Array<{ code: string }>).map((one) => one.code)).toEqual(['VENDOR_RISK_REVIEW_IN_TIME', 'VENDOR_HIGH_RISK_CONTRACTORS']);
      expect((await call('GET', '/vendor/risk-grades?tier=SEVERE', { member: READER })).status).toBe(422);
    });

    it('asks a second person for a high grade and lets the same key replay a command without doing it twice', async () => {
      const contractorId = await contractor('Cty Risk Dual');
      await rows(
        `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, effective_until, decision_document_id, created_by, updated_by)
         values ($1, $2, $3, 'DEBARMENT', 'DECISION', date '2026-01-01', date '2099-01-01', (select profile_document_id from machvon.contractor where id = $3), $4, $4)`,
        [TENANT_A, randomUUID(), contractorId, memberId(ADMIN)],
      );
      const key = `replay-${randomUUID()}`;
      const first = await call('POST', `/vendor/contractors/${contractorId}/risk-assessments`, { member: ADMIN, key });
      const again = await call('POST', `/vendor/contractors/${contractorId}/risk-assessments`, { member: ADMIN, key });
      expect(first.status).toBe(200);
      expect(again).toMatchObject({ status: 200, json: { resource_id: first.json.resource_id } });
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.vendor_risk_assessment where contractor_id = $1', [contractorId]))[0]?.n).toBe('1');
      const assessmentId = first.json.resource_id as string;
      const view = await call('GET', `/vendor/contractors/${contractorId}/risk`, { member: ADMIN });
      expect(view.json).toMatchObject({ pending: { tier: 'HIGH', dual_check: true, can_decide: false } });
      expect((await call('POST', `/vendor/risk-assessments/${assessmentId}/decide`, { member: ADMIN, ifMatch: 1, body: { decision: 'CONFIRM' } })).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect((await call('POST', `/vendor/risk-assessments/${assessmentId}/decide`, { member: CHECKER, ifMatch: 1, body: { decision: 'REJECT', reason: 'short' } })).json).toMatchObject({ code: 'REASON_REQUIRED' });
      const confirmed = await call('POST', `/vendor/risk-assessments/${assessmentId}/decide`, { member: CHECKER, ifMatch: 1, body: { decision: 'CONFIRM' } });
      expect(confirmed).toMatchObject({ status: 200, json: { status: 'CONFIRMED' } });
      expect((await rows<{ risk_tier: string }>('select risk_tier from machvon.contractor where id = $1', [contractorId]))[0]?.risk_tier).toBe('HIGH');
      expect((await call('POST', `/vendor/risk-assessments/${assessmentId}/decide`, { member: CHECKER, ifMatch: 2, body: { decision: 'CONFIRM' } })).json).toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
    });

    it('refuses a caller without the right, one with a grant on a unit only, and another tenant; unknown ids are 404', async () => {
      const contractorId = await contractor('Cty Risk Refused');
      for (const member of [READER, NOBODY]) expect((await call('POST', `/vendor/contractors/${contractorId}/risk-assessments`, { member })).status).toBe(403);
      expect(await call('POST', `/vendor/contractors/${contractorId}/risk-assessments`, { member: UNIT_ADMIN })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await call('GET', `/vendor/contractors/${contractorId}/risk`, { member: UNIT_ADMIN })).status).toBe(403);
      expect((await call('GET', `/vendor/contractors/${contractorId}/risk`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/vendor/contractors/${contractorId}/risk`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('POST', `/vendor/contractors/${contractorId}/risk-assessments`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      const own = await call('POST', `/vendor/contractors/${contractorId}/risk-assessments`, { member: ADMIN });
      expect((await call('POST', `/vendor/risk-assessments/${own.json.resource_id as string}/decide`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: 1, body: { decision: 'CONFIRM' } })).status).toBe(404);
      expect((await call('GET', `/vendor/contractors/${randomUUID()}/risk`, { member: ADMIN })).status).toBe(404);
      expect((await call('POST', `/vendor/risk-assessments/${randomUUID()}/decide`, { member: ADMIN, ifMatch: 1, body: { decision: 'CONFIRM' } })).status).toBe(404);
      expect((await call('GET', '/vendor/risk-grades', { member: UNIT_ADMIN })).status).toBe(403);
      expect((await call('GET', '/vendor/risk-grades', { member: B_ADMIN, tenantId: TENANT_B })).json.items).toEqual([]);
    });
  });

  describe('the performance and its publication (VND-12)', () => {
    it('shows the clocks, lets another person than the adopter post once, audits it and announces it with ids only', async () => {
      const contractorId = await contractor('Cty Perf Api');
      const proposalId = await rated(contractorId, 'HD-API-1', '2026-01-31');
      const view = await call('GET', `/vendor/contractors/${contractorId}/performance`, { member: CHECKER });
      expect(view.status).toBe(200);
      expect(view.json).toMatchObject({ contractor_id: contractorId, streak: 1, suggestion: 'NONE', policy: { code: 'VENDOR_PERFORMANCE', unverified: true } });
      const line = (view.json.lines as Array<Record<string, unknown>>)[0];
      expect(line).toMatchObject({ proposal_id: proposalId, contract_code: 'HD-API-1', rating: 'POOR', ended_on: '2026-01-31', publication_due_on: '2026-07-31', publication_clock: 'OVERDUE', publication: null, response_review: 'NOT_ANSWERED', can_post: true });
      expect((await call('GET', `/vendor/contractors/${contractorId}/performance`, { member: ADMIN })).json.lines).toMatchObject([{ can_post: false }]);
      expect((await call('GET', `/vendor/contractors/${contractorId}/performance`, { member: READER })).json.lines).toMatchObject([{ can_post: false }]);

      expect((await call('POST', `/vendor/rating-proposals/${proposalId}/publication`, { member: ADMIN, body: { kind: 'INITIAL', receipt: 'MSC-API-0001' } })).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect((await call('POST', `/vendor/rating-proposals/${proposalId}/publication`, { member: CHECKER, body: { kind: 'LATER', receipt: 'MSC-API-0001' } })).status).toBe(422);
      expect((await call('POST', `/vendor/rating-proposals/${proposalId}/publication`, { member: CHECKER, body: { kind: 'INITIAL', receipt: 'x' } })).status).toBe(422);
      const posted = await call('POST', `/vendor/rating-proposals/${proposalId}/publication`, { member: CHECKER, body: { kind: 'INITIAL', receipt: 'MSC-API-0001' } });
      expect(posted).toMatchObject({ status: 200, json: { status: 'POSTED', resource_version: 1 } });
      const publicationId = posted.json.resource_id as string;
      const [audit] = await audits(publicationId, 'vnd.performance_published');
      expect(audit).toMatchObject({ classification: 'INTERNAL', actor_id: memberId(CHECKER), safe_diff: { rating_proposal_id: proposalId, kind: 'INITIAL', clock: 'MET_LATE' } });
      const [event] = await events(publicationId, 'vnd.performance.published.v1');
      expect(event?.payload).toMatchObject({ contractor_id: contractorId, kind: 'INITIAL' });
      expect(JSON.stringify(event?.payload)).not.toContain('MSC-API-0001');
      expect((await call('POST', `/vendor/rating-proposals/${proposalId}/publication`, { member: CHECKER, body: { kind: 'INITIAL', receipt: 'MSC-API-0002' } })).json).toMatchObject({ code: 'PERFORMANCE_PUBLICATION_DUPLICATE' });
      expect((await call('POST', `/vendor/rating-proposals/${proposalId}/publication`, { member: CHECKER, body: { kind: 'UPDATE_AFTER_WARRANTY', receipt: 'MSC-API-0003' } })).status).toBe(200);

      const posts = await call('GET', `/vendor/performance-publications?state=POSTED&contractor_id=${contractorId}`, { member: READER });
      expect(posts.status).toBe(200);
      expect((posts.json.items as Array<{ proposal_id: string; updates: unknown[] }>).map((one) => [one.proposal_id, one.updates.length])).toEqual([[proposalId, 1]]);
      expect((posts.json.figures as Array<{ code: string }>).map((one) => one.code)).toEqual(['VENDOR_PERFORMANCE_PUBLISHED_IN_TIME', 'VENDOR_RESPONSE_REVIEWED_IN_TIME']);
      expect((await call('GET', `/vendor/performance-publications?state=OVERDUE&contractor_id=${contractorId}`, { member: READER })).json.items).toEqual([]);
      expect((await call('GET', '/vendor/performance-publications?state=SOON', { member: READER })).status).toBe(422);
      expect((await call('GET', '/vendor/performance-publications?contractor_id=not-a-uuid', { member: READER })).status).toBe(422);
      expect((await call('GET', '/vendor/performance-publications?limit=0', { member: READER })).status).toBe(422);
    });

    it('refuses a rating that is not adopted, a caller without the right or on a unit only, and another tenant', async () => {
      const contractorId = await contractor('Cty Perf Refused');
      const open = await rated(contractorId, 'HD-API-2', '2026-02-28', 'NOTIFIED');
      expect((await call('POST', `/vendor/rating-proposals/${open}/publication`, { member: CHECKER, body: { kind: 'INITIAL', receipt: 'MSC-API-0010' } })).json).toMatchObject({ code: 'RATING_NOT_ADOPTED' });
      const adopted = await rated(contractorId, 'HD-API-3', '2026-02-28');
      for (const member of [READER, NOBODY]) expect((await call('POST', `/vendor/rating-proposals/${adopted}/publication`, { member, body: { kind: 'INITIAL', receipt: 'MSC-API-0011' } })).status).toBe(403);
      expect(await call('POST', `/vendor/rating-proposals/${adopted}/publication`, { member: UNIT_ADMIN, body: { kind: 'INITIAL', receipt: 'MSC-API-0011' } })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await call('POST', `/vendor/rating-proposals/${adopted}/publication`, { member: B_ADMIN, tenantId: TENANT_B, body: { kind: 'INITIAL', receipt: 'MSC-API-0012' } })).status).toBe(404);
      expect((await call('POST', `/vendor/rating-proposals/${randomUUID()}/publication`, { member: CHECKER, body: { kind: 'INITIAL', receipt: 'MSC-API-0013' } })).status).toBe(404);
      expect((await call('GET', `/vendor/contractors/${contractorId}/performance`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/vendor/contractors/${contractorId}/performance`, { member: UNIT_ADMIN })).status).toBe(403);
      expect((await call('GET', '/vendor/performance-publications', { member: B_ADMIN, tenantId: TENANT_B })).json.items).toEqual([]);
      expect(TODAY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
