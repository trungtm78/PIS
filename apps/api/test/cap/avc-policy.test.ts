import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PrjProjectStore, TenantDatabase } from '@machvon/db';
import type { OutboxEventInput } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { capModule } from '../../src/modules/cap';
import { CapitalAvailabilityController } from '../../src/modules/cap/availability.controller';
import { AvcPolicyController } from '../../src/modules/cap/avc-policy.controller';
import { CapitalCommitments } from '../../src/modules/cap/commitment.port';
import { CapitalPlanApprovalController } from '../../src/modules/cap/plan-approval.controller';
import { CapitalPlanController, CapitalPlanLinesController } from '../../src/modules/cap/plan.controller';
import { CAP_METRICS } from '../../src/modules/cap/tokens';
import type { CommandScope } from '../../src/command-scope';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 2; // capital.plan.draft and capital.plan.submit on the whole tenant
const APPROVER = 3; // capital.plan.approve on the whole tenant
const PUBLISHER = 4; // plan.publish on the whole tenant
const POLICY_ADMIN = 5; // capital.avc.manage and capital.read on the whole tenant
const POLICY_APPROVER = 6; // capital.avc.approve and capital.read on the whole tenant
const UNIT_ADMIN = 7; // the same rights, but on the subtree of BQL1 only
const READER = 8; // capital.read on the whole tenant
const UNIT_READER = 9; // capital.read on the subtree of BQL2 only
const NOBODY = 10;
const SOLO = 11; // holds both the right to draft and the right to publish policies, so the server, not the screen, refuses their own
const ROOT = 1;
const BQL1 = 2;
const BQL2 = 3;
const MILLION = 1_000_000;
const TODAY = vietnamDateOf(new Date());
const PLAN_READS = ['capital.read', 'plan_version.read', 'allocation_line.read'];
const FOREVER = { effective_from: '2000-01-01', effective_until: '2099-12-31' };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the availability control policy and the capital left on a line over HTTP (ST-CAP-005)', () => {
  const harness = new AuthzHarness();
  const projects = new PrjProjectStore();
  const commitments = new CapitalCommitments();
  let app: RunningApp;
  let counter = 0;
  let yearCounter = 2100;
  const versions: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const millions = (n: number): string => String(n * MILLION);
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
  const itemsOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  async function document(): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
      [TENANT_A, id, `QD-${id.slice(0, 8)}`, memberId(PLANNER)],
    );
    return id;
  }

  async function project(unit: number, group = 'B'): Promise<string> {
    counter += 1;
    const code = `AVC-${counter}-${randomUUID().slice(0, 6)}`;
    const created = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PLANNER), scopeVersion: 1 }, (tx) =>
      projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: versions.area as string, totalInvestmentVnd: '500000000000' }, memberId(PLANNER), TODAY),
    );
    await rows('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, 'PIPELINE', group, String(9500000 + counter)]);
    return created.id;
  }

  async function seedMaster(name: string, masterType: string, attributes: Record<string, unknown>): Promise<{ versionId: string; key: string }> {
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
    return { versionId, key };
  }

  interface Funded {
    projectId: string;
    appropriationId: string;
    lineId: string;
    balanceId: string;
    fundKey: string;
  }

  /** A project of a unit with a line in a published plan (a new fund source of its own, so a policy that names it governs only this line). */
  async function funded(unit: number, allocated: string, options: { group?: string; appropriation?: string } = {}): Promise<Funded> {
    const year = freshYear();
    const fund = await seedMaster('FUND', 'FUND_SOURCE', { category: 'NSTW', relation: 'ADDITIVE' });
    const appropriationId = randomUUID();
    await rows(
      `insert into machvon.appropriation
         (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
       values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
      [TENANT_A, appropriationId, fund.versionId, year, options.appropriation ?? millions(10_000), await document(), memberId(APPROVER), memberId(PLANNER)],
    );
    const projectId = await project(unit, options.group);
    counter += 1;
    const created = await call('POST', '/capital-plans', {
      member: PLANNER,
      body: { plan_code: `AVC-${counter}-${randomUUID().slice(0, 6)}`, plan_kind: 'ANNUAL', plan_year: year, period_from_year: year, period_to_year: year, scope_unit_id: unitId(ROOT) },
    });
    expect(created.status).toBe(200);
    const planId = idOf(created);
    const drafted = await call('POST', `/capital-plans/${planId}/allocations`, {
      member: PLANNER,
      ifMatch: `"${versionOf(created)}"`,
      body: { lines: [{ project_id: projectId, appropriation_id: appropriationId, bucket: 'CURRENT_YEAR', source_year: year, amount_vnd: allocated }] },
    });
    expect(drafted.status).toBe(200);
    const submitted = await call('POST', `/capital-plans/${planId}/submit`, { member: PLANNER, ifMatch: `"${versionOf(drafted)}"`, body: {} });
    const decided = await call('POST', `/capital-plans/${planId}/decision`, { member: APPROVER, ifMatch: `"${versionOf(submitted)}"`, body: { decision: 'approve', reason: 'Reviewed against the decision' } });
    const published = await call('POST', `/plans/${planId}/publish`, { member: PUBLISHER, ifMatch: `"${versionOf(decided)}"`, body: { decision_document_id: await document(), effective_at: '2026-01-15T00:00:00Z' } });
    expect(published.status).toBe(200);
    const line = (await rows<{ id: string }>('select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid', [planId]))[0];
    const balance = (await rows<{ id: string }>('select id from machvon.allocation_balance where allocation_line_id = $1::uuid', [line?.id]))[0];
    return { projectId, appropriationId, lineId: line?.id as string, balanceId: balance?.id as string, fundKey: fund.key };
  }

  const policyBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return { policy_code: `AVC-API-${counter}`, scope_kind: 'TENANT', control_object: 'ALLOCATION_LINE', warn_pct: '90', block_pct: '100', legal_basis: 'Quyết định 12/QĐ-UBND', ...FOREVER, ...overrides };
  };
  const create = (payload: Record<string, unknown>, member = POLICY_ADMIN, key?: string): Promise<Reply> => call('POST', '/avc-policies', { member, body: payload, ...(key === undefined ? {} : { key }) });
  const publish = (id: string, version: number, member = POLICY_APPROVER): Promise<Reply> => call('POST', `/avc-policies/${id}/publish`, { member, ifMatch: `"${version}"`, body: {} });
  const published = async (payload: Record<string, unknown>): Promise<string> => {
    const draft = await create(payload);
    expect(draft.status).toBe(200);
    const done = await publish(idOf(draft), versionOf(draft));
    expect(done.status).toBe(200);
    return idOf(draft);
  };
  const availability = (query: string, member = READER): Promise<Reply> => call('GET', `/capital/availability${query}`, { member });
  const setFigures = (balanceId: string, figures: { reserved?: string; committed?: string; disbursed?: string }) =>
    rows('update machvon.allocation_balance set reserved_vnd = coalesce($2::numeric, reserved_vnd), committed_vnd = coalesce($3::numeric, committed_vnd), disbursed_vnd = coalesce($4::numeric, disbursed_vnd) where id = $1::uuid', [
      balanceId,
      figures.reserved ?? null,
      figures.committed ?? null,
      figures.disbursed ?? null,
    ]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BQL1, path: `/${unitId(ROOT)}/${unitId(BQL1)}/`, parent: ROOT },
        { n: BQL2, path: `/${unitId(ROOT)}/${unitId(BQL2)}/`, parent: ROOT },
      ]);
    }
    for (const n of [PLANNER, APPROVER, PUBLISHER, POLICY_ADMIN, POLICY_APPROVER, UNIT_ADMIN, READER, UNIT_READER, NOBODY, SOLO]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 2, 'PLANNER', ['capital.plan.draft', 'capital.plan.submit', ...PLAN_READS], 40);
    await harness.seedRole(TENANT_A, 3, 'APPROVER', ['capital.plan.approve', ...PLAN_READS], 50);
    await harness.seedRole(TENANT_A, 4, 'PUBLISHER', ['plan.publish', ...PLAN_READS], 50);
    await harness.seedRole(TENANT_A, 5, 'POLICY_ADMIN', ['capital.avc.manage', 'capital.read'], 40);
    await harness.seedRole(TENANT_A, 6, 'POLICY_APPROVER', ['capital.avc.approve', 'capital.read'], 50);
    await harness.seedRole(TENANT_A, 7, 'READER', ['capital.read'], 20);
    await harness.seedRole(TENANT_A, 8, 'POLICY_SOLO', ['capital.avc.manage', 'capital.avc.approve', 'capital.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 2, member: PLANNER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: PUBLISHER, role: 4, kind: 'TENANT' },
      { n: 5, member: POLICY_ADMIN, role: 5, kind: 'TENANT' },
      { n: 6, member: POLICY_APPROVER, role: 6, kind: 'TENANT' },
      { n: 7, member: UNIT_ADMIN, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(BQL1)] },
      { n: 8, member: READER, role: 7, kind: 'TENANT' },
      { n: 9, member: UNIT_READER, role: 7, kind: 'UNIT_SUBTREE', refs: [unitId(BQL2)] },
      { n: 10, member: SOLO, role: 8, kind: 'TENANT' },
    ]);
    versions.area = (await seedMaster('AREA', 'AREA', {})).versionId;
    const tenants = harness.tenants as TenantDatabase;
    const metrics: MetricsSink = { increment: () => undefined, gauge: () => undefined };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CapitalPlanController, CapitalPlanApprovalController, CapitalPlanLinesController, AvcPolicyController, CapitalAvailabilityController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: CAP_METRICS, useValue: metrics },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of CAP, with the port that commits capital', () => {
    expect(capModule.controllers).toEqual(expect.arrayContaining([AvcPolicyController, CapitalAvailabilityController]));
    expect(capModule.providers).toContain(CapitalCommitments);
  });

  describe('createAvcPolicyVersion and publishAvcPolicy (AC-ST-CAP-005-2)', () => {
    it('UAT-PLAN-03: refuses thresholds that warn after the block or block above 100 with 422 AVC_THRESHOLD_INVALID, and keeps nothing', async () => {
      const before = Number((await rows<{ n: string }>('select count(*)::text as n from machvon.avc_policy'))[0]?.n);
      for (const [warn, block, field] of [
        ['95', '90', 'warn_pct'],
        ['90', '101', 'block_pct'],
        ['90', '150', 'block_pct'],
      ] as const) {
        const reply = await create(policyBody({ warn_pct: warn, block_pct: block }));
        expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'AVC_THRESHOLD_INVALID', field]);
      }
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.avc_policy'))[0]?.n)).toBe(before);
    });

    it('UAT-PLAN-03: drafts a policy, which its creator cannot publish (403), and another person publishes once with the event and the audit rows', async () => {
      const key = `create-${randomUUID()}`;
      const payload = policyBody({ scope_kind: 'PROJECT_GROUP', scope_value: 'C', warn_pct: '85.5', block_pct: '95', include_reservations: false });
      const draft = await create(payload, SOLO, key);
      expect(draft.status).toBe(200);
      expect(draft.json).toMatchObject({ status: 'DRAFT', resource_version: 1, revision: 1, policy_code: payload.policy_code });
      const replay = await create(payload, SOLO, key);
      expect([replay.status, replay.json.operation_id]).toEqual([200, draft.json.operation_id]);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.avc_policy where policy_code = $1', [payload.policy_code]))[0]?.n)).toBe(1);

      const self = await publish(idOf(draft), 1, SOLO);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const stale = await publish(idOf(draft), 5);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const done = await publish(idOf(draft), 1);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'PUBLISHED', resource_version: 2, ended_policy_ids: [] });
      const again = await publish(idOf(draft), 2);
      expect([again.status, again.json.code]).toEqual([409, 'AVC_POLICY_STATE_INVALID']);

      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'capital.avc_policy_published.v1'", [idOf(draft)]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ policy_code: payload.policy_code, scope_kind: 'PROJECT_GROUP', scope_value: 'C', control_object: 'ALLOCATION_LINE', warn_pct: '85.50', block_pct: '95.00', include_reservations: false, actor_id: memberId(POLICY_APPROVER) });
      const audit = await rows<{ action: string; actor_id: string }>("select action, actor_id from machvon.audit_event where resource_id = $1::uuid and action like 'capital.avc_policy_%' order by occurred_at", [idOf(draft)]);
      expect(audit).toEqual([
        { action: 'capital.avc_policy_created', actor_id: memberId(SOLO) },
        { action: 'capital.avc_policy_published', actor_id: memberId(POLICY_APPROVER) },
      ]);
    });

    it('ends the earlier revision of a code and refuses an overlapping policy of the same scope, naming the other', async () => {
      const code = `AVC-API-REV-${(counter += 1)}`;
      const scope = { scope_kind: 'PROJECT_GROUP', scope_value: 'QTQG' };
      const first = await published(policyBody({ policy_code: code, ...scope, effective_from: '2026-01-01', effective_until: '2026-12-31' }));
      const second = await create(policyBody({ policy_code: code, ...scope, warn_pct: '80', effective_from: '2026-07-01', effective_until: '2026-12-31' }));
      expect(second.json.revision).toBe(2);
      const done = await publish(idOf(second), 1);
      expect(done.json.ended_policy_ids).toEqual([first]);
      const ended = (await rows<{ effective_until: string }>('select effective_until::text as effective_until from machvon.avc_policy where id = $1::uuid', [first]))[0];
      expect(ended?.effective_until).toBe('2026-06-30');
      const other = await create(policyBody({ ...scope, effective_from: '2026-09-01', effective_until: '2026-10-31' }));
      const clash = await publish(idOf(other), 1);
      expect([clash.status, clash.json.code, clash.json.conflicting_policy_id]).toEqual([409, 'AVC_POLICY_OVERLAP', idOf(second)]);
    });

    it('is a rule of the whole tenant: a grant on one unit neither writes nor publishes, and someone without the right is refused', async () => {
      const unit = await create(policyBody(), UNIT_ADMIN);
      expect([unit.status, unit.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const draft = await create(policyBody());
      expect((await publish(idOf(draft), 1, UNIT_ADMIN)).status).toBe(403);
      expect((await create(policyBody(), NOBODY)).status).toBe(403);
      expect((await publish(idOf(draft), 1, READER)).status).toBe(403);
      expect((await publish(randomUUID(), 1)).status).toBe(404);
      expect((await call('POST', '/avc-policies', { member: POLICY_ADMIN, body: policyBody({ block_pct: 'abc' }) })).status).toBe(422);
      expect((await create(policyBody({ scope_kind: 'UNIT' }))).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'scope_ref_id' });
    });
  });

  describe('listAvcPolicies and previewAvcPolicy (CAP-17, AC-ST-CAP-005-3)', () => {
    it('lists the policies newest first with the filters and the pages, to anyone who reads capital', async () => {
      const draft = await create(policyBody({ control_object: 'APPROPRIATION', scope_kind: 'FUND_SOURCE', scope_value: (await seedMaster('LISTFUND', 'FUND_SOURCE', {})).key }));
      const all = await call('GET', '/avc-policies?limit=3', { member: READER });
      expect(all.status).toBe(200);
      expect(itemsOf(all)[0]).toMatchObject({ id: idOf(draft), status: 'DRAFT', control_object: 'APPROPRIATION', revision: 1, version: 1 });
      expect(itemsOf(all)).toHaveLength(3);
      const next = await call('GET', `/avc-policies?limit=3&cursor=${encodeURIComponent(all.json.next_cursor as string)}`, { member: READER });
      expect(itemsOf(next).map((row) => row.id)).not.toContain(idOf(draft));
      const drafts = await call('GET', '/avc-policies?status=DRAFT&control_object=APPROPRIATION&limit=200', { member: UNIT_READER });
      expect(itemsOf(drafts).every((row) => row.status === 'DRAFT' && row.control_object === 'APPROPRIATION')).toBe(true);
      expect((await call('GET', '/avc-policies?status=NOPE', { member: READER })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect((await call('GET', '/avc-policies?control_object=NOPE', { member: READER })).json).toMatchObject({ detail: 'control_object' });
      expect((await call('GET', '/avc-policies', { member: NOBODY })).status).toBe(403);
    });

    it('shows the count of lines in WARN and BLOCK a policy would put, with the whole tenant as its base and only to the tenant authority', async () => {
      const ok = await funded(BQL1, '1000');
      const warn = await funded(BQL1, '1000');
      const block = await funded(BQL1, '1000');
      await setFigures(ok.balanceId, { committed: '100' });
      await setFigures(warn.balanceId, { committed: '950' });
      await setFigures(block.balanceId, { committed: '600', disbursed: '400' });
      const draft = await create(policyBody({ scope_kind: 'FUND_SOURCE', scope_value: warn.fundKey, warn_pct: '90', block_pct: '99' }));
      const preview = await call('GET', `/avc-policies/${idOf(draft)}/preview`, { member: POLICY_APPROVER });
      expect(preview.status).toBe(200);
      expect(preview.json).toMatchObject({ policy_id: idOf(draft), control_object: 'ALLOCATION_LINE', total: 1, ok: 0, warn: 1, block: 0 });
      expect(typeof preview.json.as_of).toBe('string');
      const tenantWide = await create(policyBody({ warn_pct: '90', block_pct: '99' }));
      const everything = await call('GET', `/avc-policies/${idOf(tenantWide)}/preview`, { member: POLICY_ADMIN });
      expect(everything.json).toMatchObject({ ok: expect.any(Number), warn: expect.any(Number), block: expect.any(Number) });
      expect(Number(everything.json.total)).toBe(Number(everything.json.ok) + Number(everything.json.warn) + Number(everything.json.block));
      expect(Number(everything.json.warn)).toBeGreaterThanOrEqual(1);
      expect(Number(everything.json.block)).toBeGreaterThanOrEqual(1);
      const unit = await call('GET', `/avc-policies/${idOf(draft)}/preview`, { member: UNIT_ADMIN });
      expect([unit.status, unit.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await call('GET', `/avc-policies/${randomUUID()}/preview`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/avc-policies/${idOf(draft)}/preview`, { member: NOBODY })).status).toBe(403);
    });
  });

  describe('getCapitalAvailability', () => {
    it('answers the figures of a line in its scope, the policy that governs it and the state, and the default of the tenant when none does', async () => {
      const line = await funded(BQL2, '1000');
      await setFigures(line.balanceId, { committed: '500', disbursed: '100', reserved: '200' });
      const reply = await availability(`?allocation_line_id=${line.lineId}`);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        allocation_line_id: line.lineId,
        appropriation_id: line.appropriationId,
        allocated_vnd: '1000',
        reserved_vnd: '200',
        committed_vnd: '500',
        disbursed_vnd: '100',
        available_vnd: '200',
        consumption_pct: '80.00',
        avc_state: 'OK',
      });
      expect(reply.json.avc_policy_id).toBeUndefined();
      const policyId = await published(policyBody({ scope_kind: 'FUND_SOURCE', scope_value: line.fundKey, warn_pct: '70', block_pct: '90' }));
      const governed = await availability(`?allocation_line_id=${line.lineId}`, UNIT_READER);
      expect(governed.json).toMatchObject({ avc_state: 'WARN', avc_policy_id: policyId, consumption_pct: '80.00' });
      const other = await funded(BQL1, '1000');
      expect((await availability(`?allocation_line_id=${other.lineId}`, UNIT_READER)).status).toBe(404);
    });

    it('says ZERO_ALLOCATION for a line allocated nothing, and judges an appropriation only when a policy controls it', async () => {
      const line = await funded(BQL1, '1000');
      await rows('update machvon.allocation_balance set allocated_vnd = 0 where id = $1::uuid', [line.balanceId]);
      expect((await availability(`?allocation_line_id=${line.lineId}`)).json).toMatchObject({ avc_state: 'BLOCK', avc_reason: 'ZERO_ALLOCATION', available_vnd: '0', consumption_pct: '0.00' });
      const none = await availability(`?appropriation_id=${line.appropriationId}`);
      expect(none.json).toMatchObject({ appropriation_id: line.appropriationId, allocated_vnd: millions(10_000), committed_vnd: '0' });
      expect(none.json.avc_state).toBeUndefined();
      await published(policyBody({ scope_kind: 'FUND_SOURCE', scope_value: line.fundKey, control_object: 'APPROPRIATION', warn_pct: '50', block_pct: '60' }));
      expect((await availability(`?appropriation_id=${line.appropriationId}`)).json).toMatchObject({ avc_state: 'OK', available_vnd: millions(10_000) });
    });

    it('wants exactly one of the line and the appropriation, a real id, something that exists, and the right to read capital', async () => {
      const line = await funded(BQL1, '1000');
      for (const query of ['', `?allocation_line_id=${line.lineId}&appropriation_id=${line.appropriationId}`]) expect((await availability(query)).status).toBe(422);
      expect((await availability('?allocation_line_id=not-a-uuid')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'allocation_line_id' });
      expect((await availability('?appropriation_id=not-a-uuid')).json).toMatchObject({ detail: 'appropriation_id' });
      expect((await availability(`?allocation_line_id=${randomUUID()}`)).status).toBe(404);
      expect((await availability(`?appropriation_id=${randomUUID()}`)).status).toBe(404);
      expect((await availability(`?allocation_line_id=${line.lineId}`, NOBODY)).status).toBe(403);
    });
  });

  describe('the port that commits capital (AC-ST-CAP-005-1)', () => {
    interface Recorder {
      scope: CommandScope;
      audits: Array<Record<string, unknown>>;
      events: Array<Omit<OutboxEventInput, 'correlationId'>>;
    }

    const scopeOf = (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]): Recorder => {
      const audits: Array<Record<string, unknown>> = [];
      const events: Array<Omit<OutboxEventInput, 'correlationId'>> = [];
      const scope = {
        tx,
        tenant: contextFor(TENANT_A, memberId(PLANNER)),
        requestId: randomUUID(),
        correlationId: randomUUID(),
        expectedVersion: null,
        audit: async (entry: Record<string, unknown>) => {
          audits.push(entry);
          return randomUUID();
        },
        emit: async (event: Omit<OutboxEventInput, 'correlationId'>) => {
          events.push(event);
          return { id: randomUUID(), duplicate: false };
        },
        afterCommit: () => undefined,
      } as unknown as CommandScope;
      return { scope, audits, events };
    };

    it('commits through the port with the audit row and the event, and a refusal leaves nothing behind', async () => {
      const line = await funded(BQL1, '1000');
      const sourceId = randomUUID();
      const recorded = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(PLANNER)), async (tx) => {
        const recorder = scopeOf(tx);
        const result = await commitments.checkAndCommit(recorder.scope, { allocationLineId: line.lineId, amountVnd: '400', sourceKind: 'CONTRACT', sourceId, acknowledgeWarning: false });
        return { recorder, result };
      });
      expect(recorded.result).toMatchObject({ amountVnd: '400', replayed: false, line: { state: 'OK', consumptionPct: '40.00' } });
      expect(recorded.recorder.audits).toEqual([expect.objectContaining({ action: 'capital.commitment_posted', resourceType: 'allocation_line', resourceId: line.lineId, diff: expect.objectContaining({ amount_vnd: '400', avc_state: 'OK', source_ref_id: sourceId }) })]);
      expect(recorded.recorder.events).toHaveLength(1);
      expect(recorded.recorder.events[0]).toMatchObject({
        type: 'capital.commitment_posted.v1',
        aggregateType: 'allocation_line',
        aggregateId: line.lineId,
        eventKey: `allocation_line:${line.lineId}:commit:CONTRACT:${sourceId}`,
        payload: { tenant_id: TENANT_A, allocation_line_id: line.lineId, appropriation_id: line.appropriationId, project_id: line.projectId, amount_vnd: '400', source_ref_kind: 'CONTRACT', source_ref_id: sourceId, avc_state: 'OK', warning_acknowledged: false },
      });
      // The same fact again: what was done is answered, and neither an audit row nor an event is written.
      const replay = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(PLANNER)), async (tx) => {
        const recorder = scopeOf(tx);
        const result = await commitments.checkAndCommit(recorder.scope, { allocationLineId: line.lineId, amountVnd: '400', sourceKind: 'CONTRACT', sourceId, acknowledgeWarning: false });
        return { recorder, result };
      });
      expect([replay.result.replayed, replay.recorder.audits.length, replay.recorder.events.length]).toEqual([true, 0, 0]);
      // A refusal rolls the transaction back: no entry, no balance moved.
      await expect(
        harness.tenants.withTenant(contextFor(TENANT_A, memberId(PLANNER)), (tx) => commitments.checkAndCommit(scopeOf(tx).scope, { allocationLineId: line.lineId, amountVnd: '700', sourceKind: 'CONTRACT', sourceId: randomUUID(), acknowledgeWarning: true })),
      ).rejects.toMatchObject({ code: 'AVC_BLOCKED' });
      expect((await rows<{ committed: string }>('select committed_vnd::text as committed from machvon.allocation_balance where id = $1::uuid', [line.balanceId]))[0]?.committed).toBe('400');
      expect(Number((await rows<{ n: string }>("select count(*)::text as n from machvon.capital_ledger_entry where allocation_line_id = $1::uuid and entry_type = 'COMMIT'", [line.lineId]))[0]?.n)).toBe(1);
    });

    it('asks for the acknowledgement of a warning and records that it was given', async () => {
      const line = await funded(BQL1, '1000');
      const ask = (acknowledgeWarning: boolean) =>
        harness.tenants.withTenant(contextFor(TENANT_A, memberId(PLANNER)), async (tx) => {
          const recorder = scopeOf(tx);
          const result = await commitments.checkAndCommit(recorder.scope, { allocationLineId: line.lineId, amountVnd: '950', sourceKind: 'CONTRACT', sourceId: '00000000-0000-4000-8000-0000000000aa', acknowledgeWarning });
          return { recorder, result };
        });
      await expect(ask(false)).rejects.toMatchObject({ code: 'AVC_WARNING_ACK_REQUIRED', extensions: { consumption_pct: '95.00' } });
      const done = await ask(true);
      expect(done.result.warningAcknowledged).toBe(true);
      expect(done.recorder.events[0]?.payload).toMatchObject({ avc_state: 'WARN', warning_acknowledged: true, consumption_pct: '95.00' });
    });
  });
});
