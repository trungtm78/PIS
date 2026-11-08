import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { FieldCipher, loadErrorRegistry, signTenantContext, staticKeyProvider } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { VENDOR_CIPHER } from '../../src/modules/bid/tokens';
import { VendorInvestigationController } from '../../src/modules/bid/vendor-investigation.controller';
import { VendorInvestigationReadsController } from '../../src/modules/bid/vendor-investigation-reads.controller';
import { VendorReadsController } from '../../src/modules/bid/vendor-reads.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const FIRST = 1;
const SECOND = 2;
const DRAFTER = 3;
const READER = 4;
const NOBODY = 5;
const CLERK = 6;
const APPROVER = 7;
const SUBTREE = 8;
const B_ADMIN = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0x9d;
const LEAD = ['vnd.read', 'vnd.lead.read', 'vnd.lead.review', 'vnd.lead.scan', 'vnd.trace.write', 'vnd.screening.read', 'vnd.screening.run', 'vnd.screening.decide', 'vnd.screening.import'];
const CONFIRM = ['vnd.read', 'vnd.lead.read', 'vnd.lead.confirm'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the investigation and the screening of contractors (VND-3: VND-13 to VND-15)', () => {
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
      [TENANT_A, documentId, memberId(FIRST)],
    );
    return documentId;
  }

  async function contractor(name: string, taxId?: string, keys: { rep?: string; address?: string; phone?: string } = {}): Promise<string> {
    counter += 1;
    const contractorId = randomUUID();
    await rows(
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis, legal_rep_key, address_key, phone_key, phone, phone_set_at)
       values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $8, 'EVIDENCE_DOCUMENT', $9, $10, $11, case when $11::text is null then null else '0912345678' end, case when $11::text is null then null else now() end)`,
      [TENANT_A, contractorId, taxId ?? `07${String(counter).padStart(8, '0')}`, name, await document(), memberId(FIRST), memberId(SECOND), await document(), keys.rep ?? null, keys.address ?? null, keys.phone ?? null],
    );
    return contractorId;
  }

  async function closedPackage(code: string, bids: Array<{ contractor: string; price: string }>, drafter: number): Promise<{ packageId: string; proposals: string[] }> {
    const projectId = randomUUID();
    const packageId = randomUUID();
    await rows(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, 'Investigation project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, projectId, `P-${code}`, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
    );
    await rows(
      `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by) values ($1, $2, $3, $4, 5000000000, 'OPEN_BIDDING', 1, 'AWARDED', 'Package', $5)`,
      [TENANT_A, packageId, projectId, code, memberId(drafter)],
    );
    const proposals: string[] = [];
    for (const bid of bids) {
      const proposalId = randomUUID();
      proposals.push(proposalId);
      await rows(
        `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, bid_price_vnd, submitted_at, access_released_at, created_by)
         values ($1, $2, $3, $4, $5, '[]'::jsonb, 1, 'RECEIVED', $6::numeric, now() - interval '20 days', now() - interval '20 days', $7)`,
        [TENANT_A, proposalId, projectId, packageId, bid.contractor, bid.price, memberId(CLERK)],
      );
    }
    await rows(
      `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, decision_document_id, outcome, status, submitted_by, approved_by, approved_at, created_by, updated_by)
       values ($1, $2, $3, $4, 1000, $5, 'AWARDED', 'APPROVED', $6, $7, now() - interval '10 days', $6, $6)`,
      [TENANT_A, randomUUID(), packageId, bids[0]?.contractor, await document(), memberId(CLERK), memberId(APPROVER)],
    );
    return { packageId, proposals };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [FIRST, SECOND, DRAFTER, READER, NOBODY, CLERK, APPROVER, SUBTREE]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'AUDITOR_FIRST', LEAD, 50);
    await harness.seedRole(TENANT_A, 2, 'AUDITOR_SECOND', [...LEAD, ...CONFIRM], 40);
    await harness.seedRole(TENANT_A, 3, 'VND_READER', ['vnd.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'AUDITOR_FIRST', LEAD, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: FIRST, role: 1, kind: 'TENANT' },
      { n: 2, member: SECOND, role: 2, kind: 'TENANT' },
      { n: 3, member: DRAFTER, role: 1, kind: 'TENANT' },
      { n: 4, member: READER, role: 3, kind: 'TENANT' },
      { n: 5, member: SUBTREE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    for (const year of [2026, 2027, 2028]) {
      await rows(
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(FIRST)],
      );
    }
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [VendorInvestigationController, VendorInvestigationReadsController, VendorReadsController],
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
    for (const controller of [VendorInvestigationController, VendorInvestigationReadsController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('the scan and the review of leads', () => {
    it('scans for auditors only, audits as confidential, announces ids only, and refuses a reader, a nobody and a grant on a subtree', async () => {
      const a = await contractor('Cty Dieu Tra A', undefined, { rep: 'a'.repeat(64), address: 'b'.repeat(64), phone: 'c'.repeat(64) });
      const b = await contractor('Cty Dieu Tra B', undefined, { rep: 'a'.repeat(64), address: 'b'.repeat(64), phone: 'c'.repeat(64) });
      const scan = await call('POST', '/vendor/link-scans', { member: FIRST, body: { note: 'first scan' } });
      expect(scan).toMatchObject({ status: 200, json: { status: 'SCANNED', resource_version: 1 } });
      const scanId = scan.json.resource_id as string;
      const [audit] = await audits(scanId, 'vnd.lead_scanned');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(FIRST), safe_diff: { scan_id: scanId, links: 1, clusters: 1, leads_new: 1 } });
      const [event] = await events(scanId, 'vnd.lead.scanned.v1');
      expect(event?.payload).toMatchObject({ resource_id: scanId, leads_new: 1 });
      expect(JSON.stringify(event?.payload)).not.toContain('a'.repeat(64));
      expect((await call('POST', '/vendor/link-scans', { member: READER })).status).toBe(403);
      expect((await call('POST', '/vendor/link-scans', { member: NOBODY })).status).toBe(403);
      expect(await call('POST', '/vendor/link-scans', { member: SUBTREE })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      const list = await call('GET', `/vendor/leads?kind=LINK_CLUSTER&contractor_id=${a}`, { member: FIRST });
      expect(list.status).toBe(200);
      expect(list.json).toMatchObject({ items: [{ kind: 'LINK_CLUSTER', rank: 88, status: 'NEW', is_conclusion: false, contractor_names: expect.arrayContaining(['Cty Dieu Tra A', 'Cty Dieu Tra B']) }], policies: { investigation: { code: 'VENDOR_INVESTIGATION', unverified: true } } });
      expect(JSON.stringify(list.json)).not.toContain('a'.repeat(64));
      expect((await call('GET', '/vendor/leads', { member: READER })).status).toBe(403);
      expect((await call('GET', '/vendor/leads?status=SOMETIMES', { member: FIRST })).status).toBe(422);
      expect((await call('GET', '/vendor/leads?cursor=abc', { member: FIRST })).status).toBe(422);
      const graph = await call('GET', `/vendor/contractors/${a}/links`, { member: FIRST });
      expect(graph.json).toMatchObject({ focus_id: a, links: [{ strength: 88, status: 'ACTIVE' }], nodes: expect.arrayContaining([expect.objectContaining({ id: b })]), policy: { code: 'VENDOR_LINK_RULE' } });
      expect((await call('GET', `/vendor/contractors/${randomUUID()}/links`, { member: FIRST })).status).toBe(404);
    });

    it('takes a lead through two auditors, with a stale version, a short reason and the same person refused', async () => {
      const found = (await call('GET', '/vendor/leads?kind=LINK_CLUSTER', { member: FIRST })).json.items as Array<{ id: string; version: number }>;
      const lead = found[0] as { id: string; version: number };
      const detail = await call('GET', `/vendor/leads/${lead.id}`, { member: FIRST });
      expect(detail.json).toMatchObject({ lead: { id: lead.id, is_conclusion: false }, may_take: true, may_confirm_dismissal: false, trace_coverage: { bids: 0 } });
      const taken = await call('POST', `/vendor/leads/${lead.id}/take`, { member: FIRST, ifMatch: lead.version });
      expect(taken).toMatchObject({ status: 200, json: { status: 'IN_REVIEW', resource_version: lead.version + 1 } });
      expect((await call('POST', `/vendor/leads/${lead.id}/take`, { member: FIRST, ifMatch: lead.version })).json).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect((await call('POST', `/vendor/leads/${lead.id}/propose-dismissal`, { member: FIRST, ifMatch: lead.version + 1, body: { reason: 'no' } })).status).toBe(422);
      const proposed = await call('POST', `/vendor/leads/${lead.id}/propose-dismissal`, { member: FIRST, ifMatch: lead.version + 1, body: { reason: 'the shared address is a public accounting office' } });
      expect(proposed.json).toMatchObject({ status: 'DISMISS_PROPOSED' });
      const [audit] = await audits(lead.id, 'vnd.lead_dismissal_proposed');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', reason: 'the shared address is a public accounting office' });
      expect((await call('POST', `/vendor/leads/${lead.id}/confirm-dismissal`, { member: FIRST, ifMatch: lead.version + 2 })).status).toBe(403);
      expect((await call('POST', `/vendor/leads/${lead.id}/confirm-dismissal`, { member: SECOND, ifMatch: lead.version + 2 })).json).toMatchObject({ status: 'DISMISSED' });
      expect((await call('POST', `/vendor/leads/${lead.id}/referral`, { member: SECOND, ifMatch: lead.version + 3, body: { reason: 'send it to the inspectorate' } })).json).toMatchObject({ code: 'LEAD_STATE_INVALID' });
      const figures = await call('GET', '/vendor/investigation/figures', { member: FIRST });
      expect(figures.json).toMatchObject({ leads: { dismissed: 1, precision_pct: 0 }, last_scan: { links: 1 }, indicators: expect.arrayContaining([expect.objectContaining({ code: 'VENDOR_LEAD_PRECISION', unverified: true })]) });
    });

    it('answers the same idempotency key with the same result and does not run the scan twice', async () => {
      const key = `replay-${randomUUID()}`;
      const first = await call('POST', '/vendor/link-scans', { member: FIRST, key, body: { note: 'replay' } });
      const second = await call('POST', '/vendor/link-scans', { member: FIRST, key, body: { note: 'replay' } });
      expect(second.json.resource_id).toBe(first.json.resource_id);
      expect(await rows('select 1 from machvon.vendor_link_scan where id = $1', [first.json.resource_id])).toHaveLength(1);
    });

    it('hides the lead of a package from the people who drafted it, and from another tenant', async () => {
      const x = await contractor('Cty Cover X');
      const y = await contractor('Cty Cover Y');
      const z = await contractor('Cty Cover Z');
      const made = await closedPackage('GT-API-COVER', [{ contractor: x, price: '1000000000' }, { contractor: y, price: '1003000000' }, { contractor: z, price: '1500000000' }], DRAFTER);
      expect((await call('POST', '/vendor/link-scans', { member: FIRST })).status).toBe(200);
      const mine = (await call('GET', '/vendor/leads?kind=COVER_BID', { member: FIRST })).json.items as Array<{ id: string; package_ids: string[] }>;
      const lead = mine.find((item) => item.package_ids.includes(made.packageId));
      expect(lead).toBeDefined();
      const theirs = (await call('GET', '/vendor/leads?kind=COVER_BID', { member: DRAFTER })).json.items as Array<{ id: string }>;
      expect(theirs.some((item) => item.id === lead?.id)).toBe(false);
      expect((await call('GET', `/vendor/leads/${lead?.id}`, { member: DRAFTER })).status).toBe(404);
      expect((await call('POST', `/vendor/leads/${lead?.id}/take`, { member: DRAFTER, ifMatch: 1 })).status).toBe(404);
      expect((await call('GET', `/vendor/leads/${lead?.id}`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', '/vendor/leads', { member: B_ADMIN, tenantId: TENANT_B })).json.items).toEqual([]);
    });

    it('records the trace of a submission once and refuses an empty one, a reader and another tenant', async () => {
      const p = await contractor('Cty Trace P');
      const made = await closedPackage('GT-API-TRACE', [{ contractor: p, price: '2000000000' }], DRAFTER);
      const proposalId = made.proposals[0] as string;
      expect((await call('POST', `/vendor/proposals/${proposalId}/submission-trace`, { member: FIRST, body: {} })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      const done = await call('POST', `/vendor/proposals/${proposalId}/submission-trace`, { member: FIRST, body: { origin: '203.0.113.9', device: 'device-1', agent: 'Mozilla/5.0' } });
      expect(done).toMatchObject({ status: 200, json: { status: 'RECORDED' } });
      const [audit] = await audits(done.json.resource_id as string, 'vnd.submission_trace_recorded');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', safe_diff: { proposal_id: proposalId } });
      expect(JSON.stringify(audit)).not.toContain('203.0.113.9');
      expect((await call('POST', `/vendor/proposals/${proposalId}/submission-trace`, { member: FIRST, body: { origin: '203.0.113.9' } })).json).toMatchObject({ code: 'SUBMISSION_TRACE_EXISTS' });
      expect((await call('POST', `/vendor/proposals/${proposalId}/submission-trace`, { member: READER, body: { origin: 'x-origin' } })).status).toBe(403);
      expect((await call('POST', `/vendor/proposals/${proposalId}/submission-trace`, { member: B_ADMIN, tenantId: TENANT_B, body: { origin: 'x-origin' } })).status).toBe(404);
    });
  });

  describe('the screening', () => {
    it('imports a list once, holds the contractor it names, makes the gate refuse, and lifts the hold when a person dismisses the hit with a reason', async () => {
      const id = await contractor('Cty Sang Loc Mot', '0800000001');
      const body = { source: 'WORLD_BANK', as_of: '2026-11-01', reference: 'WB list of 2026-11-01', entries: [{ ref: 'WB-API-1', name: 'Sang Loc Mot Construction', tax_code: '0800000001' }] };
      expect((await call('POST', '/vendor/screening/list-imports', { member: READER, body })).status).toBe(403);
      expect((await call('POST', '/vendor/screening/list-imports', { member: FIRST, body: { ...body, entries: [] } })).status).toBe(422);
      const imported = await call('POST', '/vendor/screening/list-imports', { member: FIRST, body });
      expect(imported).toMatchObject({ status: 200, json: { status: 'IMPORTED' } });
      const [audit] = await audits(imported.json.resource_id as string, 'vnd.screening_list_imported');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', safe_diff: { entries: 1, withdrawn: 0, replayed: false } });
      expect((await call('POST', '/vendor/screening/list-imports', { member: FIRST, body })).json).toMatchObject({ status: 'UNCHANGED' });
      const overview = await call('GET', `/vendor/screening?contractor_id=${id}`, { member: FIRST });
      expect(overview.json).toMatchObject({ hits: [{ contractor_id: id, source: 'WORLD_BANK', score: 100, hold: true, status: 'PENDING' }], policy: { code: 'VENDOR_SCREENING', unverified: true }, sources: expect.arrayContaining([expect.objectContaining({ source: 'WORLD_BANK', entries: 1 })]) });
      const hit = (overview.json.hits as Array<{ id: string; version: number }>)[0] as { id: string; version: number };
      const check = await call('GET', `/vendor/gate-check?contractor_id=${id}&action=BID_SUBMISSION`, { member: READER });
      expect(check.json).toMatchObject({ allowed: false, refusal_code: 'CONTRACTOR_SCREENING_HOLD' });
      const detail = await call('GET', `/vendor/screening/hits/${hit.id}`, { member: FIRST });
      expect(detail.json).toMatchObject({ hit: { id: hit.id, in_force: true, clock: 'ON_TIME' }, events: [{ move: 'FOUND' }], may_confirm: true, may_dismiss: true });
      expect((await call('POST', `/vendor/screening/hits/${hit.id}/dismiss`, { member: FIRST, ifMatch: hit.version, body: { reason: 'too short' } })).status).toBe(422);
      expect((await call('POST', `/vendor/screening/hits/${hit.id}/dismiss`, { member: FIRST, ifMatch: hit.version + 5, body: { reason: 'a different company: other founders and other address' } })).json).toMatchObject({ code: 'VERSION_CONFLICT' });
      const dismissed = await call('POST', `/vendor/screening/hits/${hit.id}/dismiss`, { member: FIRST, ifMatch: hit.version, body: { reason: 'a different company: other founders and other address' } });
      expect(dismissed.json).toMatchObject({ status: 'DISMISSED' });
      expect((await audits(hit.id, 'vnd.screening_hit_dismissed'))[0]).toMatchObject({ classification: 'CONFIDENTIAL', reason: 'a different company: other founders and other address' });
      expect((await call('GET', `/vendor/gate-check?contractor_id=${id}&action=BID_SUBMISSION`, { member: READER })).json).toMatchObject({ allowed: true });
      expect((await call('POST', `/vendor/screening/hits/${hit.id}/confirm`, { member: FIRST, ifMatch: hit.version + 1, body: {} })).json).toMatchObject({ code: 'SCREENING_HIT_STATE_INVALID' });
    });

    it('runs the screening by hand, refuses a reader, and finds nothing in another tenant', async () => {
      expect(await call('POST', '/vendor/screening/runs', { member: FIRST })).toMatchObject({ status: 200, json: { status: 'FINISHED' } });
      expect((await call('POST', '/vendor/screening/runs', { member: READER })).status).toBe(403);
      expect((await call('GET', '/vendor/screening', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/vendor/screening', { member: B_ADMIN, tenantId: TENANT_B })).json).toMatchObject({ hits: [], counts: { pending: 0, holds: 0 } });
      expect((await call('GET', `/vendor/screening/hits/${randomUUID()}`, { member: FIRST })).status).toBe(404);
      expect((await call('POST', `/vendor/screening/hits/${randomUUID()}/confirm`, { member: FIRST, ifMatch: 1, body: {} })).status).toBe(404);
    });
  });
});
