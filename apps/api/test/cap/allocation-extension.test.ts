import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { capModule } from '../../src/modules/cap';
import { AllocationExtensionController, AllocationExtensionReadsController } from '../../src/modules/cap/allocation-extension.controller';
import { CapitalAvailabilityController } from '../../src/modules/cap/availability.controller';
import { CapitalPlanApprovalController } from '../../src/modules/cap/plan-approval.controller';
import { CapitalPlanController, CapitalPlanLinesController } from '../../src/modules/cap/plan.controller';
import { CAP_METRICS } from '../../src/modules/cap/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 2; // capital.plan.draft, capital.plan.submit and capital.extension.request on the whole tenant
const APPROVER = 3; // capital.plan.approve
const PUBLISHER = 4; // plan.publish
const EXTENSION_APPROVER = 5; // capital.extension.approve and capital.read
const UNIT_PLANNER = 6; // the right to ask for an extension, but on the subtree of BQL1 only (the plans of the test belong to the root unit)
const READER = 7; // capital.read
const NOBODY = 8;
const SOLO = 9; // holds both the right to ask and the right to decide, so the server, not the screen, refuses their own request
const OTHER_PLANNER = 10; // another planner of the tenant: asks for a second extension
const ROOT = 1;
const BQL1 = 2;
const BILLION = 1_000_000_000;
const TODAY = vietnamDateOf(new Date());
const PLAN_READS = ['capital.read', 'plan_version.read', 'allocation_line.read'];
const REASON = 'Approved on the strength of the decision on the carry-over of capital';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the extension of the disbursement of capital over HTTP (ST-CAP-007)', () => {
  const harness = new AuthzHarness();
  const projects = new PrjProjectStore();
  let app: RunningApp;
  let counter = 0;
  let yearCounter = 2090;
  const versions: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const money = (billions: number): string => String(billions * BILLION);
  const freshYear = (): number => {
    yearCounter -= 1;
    return yearCounter;
  };

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;

  async function document(): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, issuer_name, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', 'Ủy ban nhân dân tỉnh', $4, $4)`,
      [TENANT_A, id, `QD-${id.slice(0, 8)}`, memberId(PLANNER)],
    );
    return id;
  }

  async function seedMaster(name: string, masterType: string, attributes: Record<string, unknown>): Promise<string> {
    counter += 1;
    const recordId = randomUUID();
    const versionId = randomUUID();
    const key = `${name}-${counter}`;
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, key, memberId(PLANNER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $5, $6::jsonb, '2020-01-01', 'EFFECTIVE', $7, now(), $8, $8)`,
        [TENANT_A, versionId, masterType, key, `Label ${key}`, JSON.stringify(attributes), recordId, memberId(PLANNER)],
      ],
    ]);
    return versionId;
  }

  interface Funded {
    year: number;
    projectId: string;
    appropriationId: string;
    lineId: string;
    balanceId: string;
    planId: string;
  }

  /** A project with a line of `allocated` VND in a published plan of a year of its own, made through the API the way a planner does. */
  async function funded(allocated: string): Promise<Funded> {
    const year = freshYear();
    const fund = await seedMaster('FUND', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    const appropriationId = randomUUID();
    await rows(
      `insert into machvon.appropriation
         (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
       values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
      [TENANT_A, appropriationId, fund, year, money(100), await document(), memberId(APPROVER), memberId(PLANNER)],
    );
    counter += 1;
    const code = `EXT-${counter}-${randomUUID().slice(0, 6)}`;
    const created = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PLANNER), scopeVersion: 1 }, (tx) =>
      projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(BQL1), areaMasterVersionId: versions.area as string, totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY),
    );
    await rows('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, 'PIPELINE', 'B', String(9600000 + counter)]);
    const plan = await call('POST', '/capital-plans', {
      member: PLANNER,
      body: { plan_code: `EXT-${counter}-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: year, period_from_year: year, period_to_year: year, scope_unit_id: unitId(ROOT) },
    });
    expect(plan.status).toBe(200);
    const planId = idOf(plan);
    const drafted = await call('POST', `/capital-plans/${planId}/allocations`, {
      member: PLANNER,
      ifMatch: `"${versionOf(plan)}"`,
      body: { lines: [{ project_id: created.id, appropriation_id: appropriationId, bucket: 'CURRENT_YEAR', source_year: year, amount_vnd: allocated }] },
    });
    expect(drafted.status).toBe(200);
    const submitted = await call('POST', `/capital-plans/${planId}/submit`, { member: PLANNER, ifMatch: `"${versionOf(drafted)}"`, body: {} });
    const decided = await call('POST', `/capital-plans/${planId}/decision`, { member: APPROVER, ifMatch: `"${versionOf(submitted)}"`, body: { decision: 'approve', reason: 'Reviewed against the decision' } });
    const published = await call('POST', `/plans/${planId}/publish`, { member: PUBLISHER, ifMatch: `"${versionOf(decided)}"`, body: { decision_document_id: await document(), effective_at: '2026-01-15T00:00:00Z' } });
    expect(published.status).toBe(200);
    const line = (await rows<{ id: string }>('select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [planId]))[0];
    const balance = (await rows<{ id: string }>('select id from machvon.allocation_balance where allocation_line_id = $1::uuid', [line?.id]))[0];
    return { year, projectId: created.id, appropriationId, lineId: line?.id as string, balanceId: balance?.id as string, planId };
  }

  const askBody = (line: Funded, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    amount_vnd: money(3),
    extended_to: `${line.year + 1}-01-31`,
    reason_code: 'GPMB_CHAM',
    justification: 'Mặt bằng chưa bàn giao do vướng hộ dân',
    ...overrides,
  });
  const ask = (line: Funded, overrides: Record<string, unknown> = {}, member = PLANNER, key?: string): Promise<Reply> =>
    call('POST', `/allocation-lines/${line.lineId}/extensions`, { member, body: askBody(line, overrides), ...(key === undefined ? {} : { key }) });
  const decide = async (id: string, version: number, body: Record<string, unknown> | undefined, member = EXTENSION_APPROVER): Promise<Reply> =>
    call('POST', `/allocation-extensions/${id}/decision`, { member, ifMatch: `"${version}"`, body: body ?? { decision: 'approve', reason: REASON, approving_document_id: await document() } });
  const listOf = (query = '', member = READER): Promise<Reply> => call('GET', `/allocation-extensions${query}`, { member });
  const itemsOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const extensionRow = async (id: string) =>
    (await rows<{ status: string; version: string; new_allocation_line_id: string | null; new_appropriation_id: string | null; decided_by: string | null }>(
      'select status, version::text as version, new_allocation_line_id, new_appropriation_id, decided_by from machvon.allocation_extension where id = $1::uuid',
      [id],
    ))[0];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
      ]);
    }
    for (const n of [PLANNER, APPROVER, PUBLISHER, EXTENSION_APPROVER, UNIT_PLANNER, READER, NOBODY, SOLO, OTHER_PLANNER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, EXTENSION_APPROVER, ROOT);
    await harness.seedRole(TENANT_A, 2, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', 'capital.extension.request', ...PLAN_READS], 40);
    await harness.seedRole(TENANT_A, 3, 'APPROVER', ['capital.plan.approve', ...PLAN_READS], 50);
    await harness.seedRole(TENANT_A, 4, 'PUBLISHER', ['plan.publish', ...PLAN_READS], 50);
    await harness.seedRole(TENANT_A, 5, 'EXTENSION_APPROVER', ['capital.extension.approve', 'capital.read'], 50);
    await harness.seedRole(TENANT_A, 6, 'EXTENSION_PLANNER', ['capital.extension.request', 'capital.read'], 40);
    await harness.seedRole(TENANT_A, 7, 'READER', ['capital.read'], 20);
    await harness.seedRole(TENANT_A, 8, 'EXTENSION_SOLO', ['capital.extension.request', 'capital.extension.approve', 'capital.read'], 50);
    await harness.seedRole(TENANT_B, 5, 'EXTENSION_APPROVER', ['capital.extension.request', 'capital.extension.approve', 'capital.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 2, member: PLANNER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: PUBLISHER, role: 4, kind: 'TENANT' },
      { n: 5, member: EXTENSION_APPROVER, role: 5, kind: 'TENANT' },
      { n: 6, member: UNIT_PLANNER, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(BQL1)] },
      { n: 7, member: READER, role: 7, kind: 'TENANT' },
      { n: 8, member: SOLO, role: 8, kind: 'TENANT' },
      { n: 9, member: OTHER_PLANNER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 5, member: EXTENSION_APPROVER, role: 5, kind: 'TENANT' }]);
    versions.area = await seedMaster('AREA', 'AREA', {});
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CapitalPlanController, CapitalPlanApprovalController, CapitalPlanLinesController, CapitalAvailabilityController, AllocationExtensionController, AllocationExtensionReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: CAP_METRICS, useValue: { increment: () => undefined, gauge: () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of CAP', () => {
    expect(capModule.controllers).toEqual(expect.arrayContaining([AllocationExtensionController, AllocationExtensionReadsController]));
  });

  describe('requestAllocationExtension', () => {
    it('writes a request that waits for a decision, with the audit row, and replays the answer of the same idempotency key', async () => {
      const line = await funded(money(3));
      const key = `ask-${randomUUID()}`;
      const first = await ask(line, {}, PLANNER, key);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'REQUESTED', resource_version: 1 });
      const replayed = await ask(line, {}, PLANNER, key);
      expect(replayed.json).toEqual(first.json);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.allocation_extension where allocation_line_id = $1::uuid', [line.lineId]))[0]?.n)).toBe(1);
      const audit = await rows<{ action: string; actor_id: string }>("select action, actor_id from machvon.audit_event where resource_id = $1::uuid and action like 'capital.allocation_extension_%'", [idOf(first)]);
      expect(audit).toEqual([{ action: 'capital.allocation_extension_requested', actor_id: memberId(PLANNER) }]);
    });

    it('refuses more than what is left with 422 AMOUNT_EXCEEDS_UNDISBURSED, and a bad form with 422 VALIDATION_FAILED naming the field (AC-ST-CAP-007-3, UAT-PLAN-61)', async () => {
      const line = await funded(money(3));
      await rows('update machvon.allocation_balance set committed_vnd = $2::numeric, disbursed_vnd = $3::numeric where id = $1::uuid', [line.balanceId, money(1), '500000000']);
      const over = await ask(line, { amount_vnd: money(2) });
      expect([over.status, over.json.code, over.json.detail]).toEqual([422, 'AMOUNT_EXCEEDS_UNDISBURSED', 'amount_vnd']);
      expect(over.json).toMatchObject({ undisbursed_vnd: '1500000000' });
      const late = await ask(line, { extended_to: `${line.year + 2}-01-01` });
      expect([late.status, late.json.code, late.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'extended_to']);
      const other = await ask(line, { reason_code: 'KHAC', justification: undefined });
      expect([other.status, other.json.code, other.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'justification']);
      const surprise = await ask(line, { surprise: 1 });
      expect(surprise.status).toBe(400);
      expect(await rows('select 1 from machvon.allocation_extension where allocation_line_id = $1::uuid', [line.lineId])).toEqual([]);
    });

    it('answers 404 for a line that is not there or is another tenant\'s, and 403 to a member without the right or outside the scope of the plan', async () => {
      const line = await funded(money(3));
      expect((await call('POST', `/allocation-lines/${randomUUID()}/extensions`, { member: PLANNER, body: askBody(line) })).status).toBe(404);
      expect((await call('POST', `/allocation-lines/${line.lineId}/extensions`, { member: EXTENSION_APPROVER, tenantId: TENANT_B, body: askBody(line) })).status).toBe(404);
      expect((await ask(line, {}, READER)).status).toBe(403);
      expect((await ask(line, {}, NOBODY)).status).toBe(403);
      // The plan belongs to the root unit: the right on the subtree of one of its children does not reach it.
      const scoped = await ask(line, {}, UNIT_PLANNER);
      expect([scoped.status, scoped.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select 1 from machvon.allocation_extension where allocation_line_id = $1::uuid', [line.lineId])).toEqual([]);
    });
  });

  describe('decideAllocationExtension (UAT-AC229, UAT-AC239)', () => {
    it('carries the capital over: a CARRYOVER line of the next year with its source year and last day, the plan year not increased, two ledger entries of one extension and the event (AC-ST-CAP-007-1)', async () => {
      const line = await funded(money(3));
      const asked = await ask(line, { extended_to: `${line.year + 1}-01-31` });
      const sourceAppropriation = (await rows<{ amount_vnd: string; allocated_total_vnd: string }>('select amount_vnd::text, allocated_total_vnd::text from machvon.appropriation where id = $1::uuid', [line.appropriationId]))[0];
      const documentId = await document();
      const decided = await decide(idOf(asked), versionOf(asked), { decision: 'approve', reason: REASON, approving_document_id: documentId });
      expect(decided.status).toBe(200);
      expect(decided.json).toMatchObject({ status: 'APPLIED', resource_version: 2 });
      const row = await extensionRow(idOf(asked));
      expect(row).toMatchObject({ status: 'APPLIED', version: '2', decided_by: memberId(EXTENSION_APPROVER) });
      const carried = (
        await rows<{ bucket: string; source_year: number; is_extended: boolean; extended_to: string; extension_document_id: string; amount_vnd: string; origin: string; appropriation_id: string }>(
          'select bucket, source_year, is_extended, extended_to::text as extended_to, extension_document_id, amount_vnd::text as amount_vnd, origin, appropriation_id from machvon.allocation_line where id = $1::uuid',
          [row?.new_allocation_line_id],
        )
      )[0];
      expect(carried).toMatchObject({ bucket: 'CARRYOVER', source_year: line.year, is_extended: true, extended_to: `${line.year + 1}-01-31`, extension_document_id: documentId, amount_vnd: money(3), origin: 'CARRYOVER', appropriation_id: row?.new_appropriation_id });
      const appropriation = (await rows<{ origin: string; plan_year: number; source_year: number; status: string; amount_vnd: string; issuing_authority: string }>('select origin, plan_year, source_year, status, amount_vnd::text, issuing_authority from machvon.appropriation where id = $1::uuid', [row?.new_appropriation_id]))[0];
      expect(appropriation).toMatchObject({ origin: 'CARRYOVER', plan_year: line.year + 1, source_year: line.year, status: 'PUBLISHED', amount_vnd: money(3), issuing_authority: 'Ủy ban nhân dân tỉnh' });
      expect((await rows<{ amount_vnd: string; allocated_total_vnd: string }>('select amount_vnd::text, allocated_total_vnd::text from machvon.appropriation where id = $1::uuid', [line.appropriationId]))[0]).toEqual(sourceAppropriation);
      const entries = await rows<{ entry_type: string; source_ref_kind: string; amount_vnd: string }>("select entry_type, source_ref_kind, amount_vnd::text from machvon.capital_ledger_entry where source_ref_id = $1::uuid order by entry_type", [idOf(asked)]);
      expect(entries).toEqual([
        { entry_type: 'EXTEND_IN', source_ref_kind: 'EXTENSION', amount_vnd: money(3) },
        { entry_type: 'EXTEND_OUT', source_ref_kind: 'EXTENSION', amount_vnd: money(3) },
      ]);
      // What the availability control reads: the old line gave the capital up, the new one holds it.
      const oldLine = await call('GET', `/capital/availability?allocation_line_id=${line.lineId}`, { member: READER });
      const newLine = await call('GET', `/capital/availability?allocation_line_id=${row?.new_allocation_line_id}`, { member: READER });
      expect(oldLine.json).toMatchObject({ allocated_vnd: '0' });
      expect(newLine.json).toMatchObject({ allocated_vnd: money(3), committed_vnd: '0', disbursed_vnd: '0' });
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'capital.allocation_extended.v1'", [idOf(asked)]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ extension_id: idOf(asked), allocation_line_id: line.lineId, new_allocation_line_id: row?.new_allocation_line_id, from_plan_year: line.year, to_plan_year: line.year + 1, amount_vnd: money(3), approving_document_id: documentId });
      const audit = await rows<{ action: string; actor_id: string }>("select action, actor_id from machvon.audit_event where resource_id = $1::uuid and action like 'capital.allocation_extension_%' order by occurred_at", [idOf(asked)]);
      expect(audit).toEqual([
        { action: 'capital.allocation_extension_requested', actor_id: memberId(PLANNER) },
        { action: 'capital.allocation_extension_applied', actor_id: memberId(EXTENSION_APPROVER) },
      ]);
    });

    it('refuses the person who asked with 403 SELF_APPROVAL_DENIED, and a member without the right with 403', async () => {
      const line = await funded(money(3));
      const asked = await ask(line, {}, SOLO);
      const self = await decide(idOf(asked), versionOf(asked), undefined, SOLO);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await decide(idOf(asked), versionOf(asked), undefined, PLANNER)).status).toBe(403);
      expect((await decide(idOf(asked), versionOf(asked), undefined, READER)).status).toBe(403);
      expect((await extensionRow(idOf(asked)))?.status).toBe('REQUESTED');
    });

    it('needs the document that allows it: 422 EXTENSION_DOCUMENT_REQUIRED, and the database refuses a carry-over line without its document (AC-ST-CAP-007-2)', async () => {
      const line = await funded(money(3));
      const asked = await ask(line);
      const without = await decide(idOf(asked), versionOf(asked), { decision: 'approve', reason: REASON });
      expect([without.status, without.json.code, without.json.detail]).toEqual([422, 'EXTENSION_DOCUMENT_REQUIRED', 'approving_document_id']);
      const unknown = await decide(idOf(asked), versionOf(asked), { decision: 'approve', reason: REASON, approving_document_id: randomUUID() });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'EXTENSION_DOCUMENT_REQUIRED']);
      await expect(
        rows(
          `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, is_extended, created_by, updated_by)
           select tenant_id, gen_random_uuid(), plan_version_id, fund_source_version_id, 'CARRYOVER', source_year, 1, 0, appropriation_id, project_id, budget_level, 'CARRYOVER', true, created_by, updated_by from machvon.allocation_line where id = $1::uuid`,
          [line.lineId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await rows('select 1 from machvon.capital_ledger_entry where source_ref_id = $1::uuid', [idOf(asked)])).toEqual([]);
    });

    it('rejects with a reason, and answers 428 without If-Match, 409 VERSION_CONFLICT to a stale version and 409 STAGE_TRANSITION_DENIED to a request already decided', async () => {
      const line = await funded(money(3));
      const asked = await ask(line);
      const noMatch = await call('POST', `/allocation-extensions/${idOf(asked)}/decision`, { member: EXTENSION_APPROVER, body: { decision: 'reject', reason: REASON } });
      expect([noMatch.status, noMatch.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      const stale = await decide(idOf(asked), 9, { decision: 'reject', reason: REASON });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const rejected = await decide(idOf(asked), versionOf(asked), { decision: 'reject', reason: 'The decision does not allow it' });
      expect([rejected.status, rejected.json.status, rejected.json.resource_version]).toEqual([200, 'REJECTED', 2]);
      const again = await decide(idOf(asked), 2, { decision: 'reject', reason: REASON });
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect((await extensionRow(idOf(asked)))?.new_allocation_line_id).toBeNull();
      expect(await rows('select 1 from machvon.capital_ledger_entry where source_ref_id = $1::uuid', [idOf(asked)])).toEqual([]);
      expect((await call('POST', `/allocation-extensions/${randomUUID()}/decision`, { member: EXTENSION_APPROVER, ifMatch: '"1"', body: { decision: 'reject', reason: REASON } })).status).toBe(404);
    });

    it('does not decide the request of another tenant: 404', async () => {
      const line = await funded(money(3));
      const asked = await ask(line);
      const foreign = await call('POST', `/allocation-extensions/${idOf(asked)}/decision`, { member: EXTENSION_APPROVER, tenantId: TENANT_B, ifMatch: '"1"', body: { decision: 'reject', reason: REASON } });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });

    it('does not carry over what was committed since the request: 422 AMOUNT_EXCEEDS_UNDISBURSED and nothing is written', async () => {
      const line = await funded(money(3));
      const asked = await ask(line);
      await rows('update machvon.allocation_balance set committed_vnd = $2::numeric where id = $1::uuid', [line.balanceId, money(1)]);
      const decided = await decide(idOf(asked), versionOf(asked), undefined);
      expect([decided.status, decided.json.code]).toEqual([422, 'AMOUNT_EXCEEDS_UNDISBURSED']);
      expect(await rows('select 1 from machvon.capital_ledger_entry where source_ref_id = $1::uuid', [idOf(asked)])).toEqual([]);
      expect((await extensionRow(idOf(asked)))?.status).toBe('REQUESTED');
    });
  });

  describe('listAllocationExtensions', () => {
    it('lists the requests of the tenant, the latest first, by keyset, with a filter on the state or the line', async () => {
      const line = await funded(money(3));
      const first = await ask(line, { amount_vnd: money(1) });
      const second = await ask(line, { amount_vnd: money(1) }, OTHER_PLANNER);
      await decide(idOf(second), versionOf(second), { decision: 'reject', reason: REASON });
      const all = await listOf(`?allocation_line_id=${line.lineId}`);
      expect(itemsOf(all).map((item) => item.id)).toEqual([idOf(second), idOf(first)]);
      expect(itemsOf(all)[0]).toMatchObject({ allocation_line_id: line.lineId, project_id: line.projectId, from_plan_year: line.year, amount_vnd: money(1), status: 'REJECTED', requested_by: memberId(OTHER_PLANNER), decided_by: memberId(EXTENSION_APPROVER), decision_reason: REASON, version: 2 });
      const page = await listOf(`?allocation_line_id=${line.lineId}&limit=1`);
      expect(itemsOf(page).map((item) => item.id)).toEqual([idOf(second)]);
      expect(typeof page.json.next_cursor).toBe('string');
      const rest = await listOf(`?allocation_line_id=${line.lineId}&limit=1&cursor=${encodeURIComponent(page.json.next_cursor as string)}`);
      expect(itemsOf(rest).map((item) => item.id)).toEqual([idOf(first)]);
      expect(rest.json.next_cursor).toBeNull();
      const waiting = await listOf(`?allocation_line_id=${line.lineId}&status=REQUESTED`);
      expect(itemsOf(waiting).map((item) => item.id)).toEqual([idOf(first)]);
      expect(itemsOf(await listOf('', READER)).length).toBeGreaterThan(0);
    });

    it('refuses a filter that is not one (422), a member without the right (403), and shows nothing of another tenant', async () => {
      expect((await listOf('?status=WHIM')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect((await listOf('?allocation_line_id=nope')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'allocation_line_id' });
      expect((await listOf('', NOBODY)).status).toBe(403);
      expect(itemsOf(await call('GET', '/allocation-extensions', { member: EXTENSION_APPROVER, tenantId: TENANT_B }))).toEqual([]);
    });
  });
});
