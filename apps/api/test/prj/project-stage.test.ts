import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { prjModule } from '../../src/modules/prj';
import { InMemoryPipelineCache } from '../../src/modules/prj/pipeline-cache';
import { PlanPublishedConsumer } from '../../src/modules/prj/plan-published.consumer';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { ProjectLifecycleReadsController, ProjectStageController } from '../../src/modules/prj/stage.controller';
import { PRJ_METRICS, PRJ_PIPELINE_CACHE } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(120_000);

const SIGNING_KEY = randomBytes(32);
const RELAY_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const MANAGER = 1; // every stage permission and project.read on the whole tenant
const DEPARTMENT_MANAGER = 2; // the same on the subtree of the department
const READER = 3; // project.read on the whole tenant
const NOBODY = 4;
const IMPLEMENTER = 5; // project.read and project.stage.implement on the whole tenant
const NARROW_ACTOR = 6; // project.read on the whole tenant, every stage permission on the department only
const B_MANAGER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const WORKER = WORKER_MEMBERSHIP_ID;
const STAGE_PERMISSIONS = ['project.stage.implement', 'project.stage.suspend', 'project.stage.complete', 'project.stage.close', 'project.stage.cancel'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the guarded lifecycle transitions and the project bank (ST-PRJ-002)', () => {
  const harness = new AuthzHarness();
  const increments: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  const metrics: MetricsSink = { increment: (name, labels) => void increments.push({ name, labels }), gauge: () => undefined };
  const cache = new InMemoryPipelineCache();
  let app: RunningApp;
  let counter = 0;
  const versions: Record<string, string> = {};

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const row = async (projectId: string, tenant = TENANT_A): Promise<Record<string, unknown>> =>
    (await rows<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [projectId], tenant))[0] as Record<string, unknown>;

  async function seedVersion(tenant: string, masterType: string, key: string): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(tenant, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [tenant, recordId, masterType, key, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $4, '{}'::jsonb, '2020-01-01', null, 'EFFECTIVE', $5, now(), $6, $6)`,
        [tenant, versionId, masterType, key, recordId, memberId(1)],
      ],
    ]);
    return versionId;
  }

  async function document(status = 'EFFECTIVE', tenant = TENANT_A): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
      [tenant, id, `QD-${id.slice(0, 8)}/2026`, status, memberId(1)],
      tenant,
    );
    return id;
  }

  /** A project made through the register, then left in a stage by the stories that come before this one (the owner stands in for them). */
  async function project(status: string, options: { unit?: number; nationalCode?: string | null; tenant?: string; group?: string; score?: string } = {}): Promise<{ id: string; version: number }> {
    counter += 1;
    const tenant = options.tenant ?? TENANT_A;
    const made = await call('POST', '/projects', {
      member: MANAGER,
      tenantId: tenant,
      body: { code: `ST-${counter}-${randomUUID().slice(0, 6)}`, name: 'Dự án cầu Thủ Thiêm 4', owner_unit_id: unitId(options.unit ?? DEPARTMENT), area_master_version_id: tenant === TENANT_A ? versions.area : versions.areaB, total_investment_vnd: '500000000000' },
    });
    expect(made.status).toBe(200);
    const id = made.json.resource_id as string;
    await rows(
      `update machvon.project set status = $2, project_group = $3, national_project_code = $4, appraisal_score = $5::numeric where id = $1::uuid`,
      [id, status, options.group ?? 'B', options.nationalCode === undefined ? String(8000000 + counter) : options.nationalCode, options.score ?? null],
      tenant,
    );
    return { id, version: 1 };
  }

  const stageCall = (member: number, operationPath: string, target: { id: string; version: number }, body: Record<string, unknown>, extra: { key?: string; version?: number | string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', `/projects/${target.id}/${operationPath}`, { member, ifMatch: `"${extra.version ?? target.version}"`, body: { reason: 'A reason for the move', ...body }, ...(extra.key === undefined ? {} : { key: extra.key }), ...(extra.tenantId === undefined ? {} : { tenantId: extra.tenantId }) });

  const history = (projectId: string, tenant = TENANT_A) =>
    rows<Record<string, unknown>>('select project_version::text as project_version, from_stage, to_stage, operation, actor_kind, actor_id, decision_document_id, reason from machvon.project_stage_change where project_id = $1::uuid order by project_version', [projectId], tenant);
  const stageEvents = (projectId: string) => rows<{ payload: Record<string, unknown> }>(`select payload from machvon.outbox_event where aggregate_id = $1 and type = 'project.stage_changed.v1' order by aggregate_version`, [projectId]);

  /** A capital plan with one funded line for the project, and the balance of the line. */
  async function fund(target: { id: string }, balance: { committed?: string; disbursed?: string } = {}, status = 'PUBLISHED'): Promise<{ planId: string; documentId: string }> {
    counter += 1;
    const planId = randomUUID();
    const versionId = randomUUID();
    const lineId = randomUUID();
    const documentId = await document();
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
         values ($1, $2, $3, 'ANNUAL', 2026, 2026, 2026, $4, 1, $5, $6, now(), $7, $7)`,
        [TENANT_A, planId, `CP-${counter}-${planId.slice(0, 6)}`, unitId(ROOT), status, documentId, memberId(1)],
      ],
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id, created_by, updated_by)
         values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now(), $5, $6, $6)`,
        [TENANT_A, versionId, target.id, randomUUID(), planId, memberId(1)],
      ],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, created_by, updated_by)
         values ($1, $2, $3, $4, 'CURRENT_YEAR', 2026, 1000000, 0, $5, $6, $6)`,
        [TENANT_A, lineId, versionId, versions.area, target.id, memberId(1)],
      ],
      [
        `insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, committed_vnd, disbursed_vnd) values ($1, $2, $3, 1000000, $4::numeric, $5::numeric)`,
        [TENANT_A, randomUUID(), lineId, balance.committed ?? '0', balance.disbursed ?? '0'],
      ],
    ]);
    return { planId, documentId };
  }

  async function deliveryOf(planId: string, projectIds: string[], overrides: Partial<OutboxDelivery> = {}): Promise<OutboxDelivery> {
    return {
      id: randomUUID(),
      tenantId: TENANT_A,
      tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, RELAY_KEY),
      type: 'capital.plan_published.v1',
      schemaVersion: 1,
      aggregateType: 'capital_plan',
      aggregateId: planId,
      aggregateVersion: 1,
      payload: { tenant_id: TENANT_A, capital_plan_id: planId, revision: 1, plan_year: 2026, effective_at: new Date().toISOString(), decision_document_id: randomUUID(), project_ids: projectIds },
      eventKey: `capital_plan:${planId}:1`,
      correlationId: randomUUID(),
      attempts: 0,
      ...overrides,
    };
  }

  const consumer = (extra: { metrics?: MetricsSink } = {}) => new PlanPublishedConsumer({ database: harness.tenants as TenantDatabase, security: { signingKey: RELAY_KEY }, cache, ...extra });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    for (const n of [MANAGER, DEPARTMENT_MANAGER, READER, NOBODY, IMPLEMENTER, NARROW_ACTOR]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    const manager = ['project.create', 'project.read', ...STAGE_PERMISSIONS];
    await harness.seedRole(TENANT_A, 1, 'STAGE_MANAGER', manager, 40);
    await harness.seedRole(TENANT_A, 2, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'IMPLEMENTER', ['project.read', 'project.stage.implement'], 30);
    await harness.seedRole(TENANT_A, 4, 'STAGE_ONLY', STAGE_PERMISSIONS, 30);
    await harness.seedRole(TENANT_B, 1, 'STAGE_MANAGER', manager, 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
      { n: 4, member: IMPLEMENTER, role: 3, kind: 'TENANT' },
      { n: 5, member: NARROW_ACTOR, role: 2, kind: 'TENANT' },
      { n: 6, member: NARROW_ACTOR, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    versions.area = await seedVersion(TENANT_A, 'AREA', 'TINH-P');
    versions.areaB = await seedVersion(TENANT_B, 'AREA', 'TINH-P');
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: PRJ_METRICS, useValue: metrics },
        { provide: PRJ_PIPELINE_CACHE, useValue: cache },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of PRJ with the controllers of the stage commands and of the reads', () => {
    expect(prjModule.controllers).toEqual(expect.arrayContaining([ProjectStageController, ProjectLifecycleReadsController]));
  });

  describe('the transition table over HTTP', () => {
    it('answers 409 STAGE_TRANSITION_DENIED to implementation-start and closure of a CONCEPT project and leaves it as it was (AC-ST-PRJ-002-1)', async () => {
      const concept = await project('CONCEPT');
      const before = await row(concept.id);
      const start = await stageCall(MANAGER, 'implementation-start', concept, { investment_decision_document_id: await document() });
      expect([start.status, start.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      const closure = await stageCall(MANAGER, 'closure', concept, {});
      expect([closure.status, closure.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect(await row(concept.id)).toEqual(before);
      expect(await history(concept.id)).toEqual([]);
      expect(await stageEvents(concept.id)).toEqual([]);
    });

    it('refuses every command from every stage the table does not give it, the closed, rejected and cancelled stages included, and emits nothing (AC-ST-PRJ-002-2, UAT-AC205)', async () => {
      const commands: Array<[string, string]> = [
        ['implementation-start', 'BUDGETED'],
        ['suspension', 'IMPLEMENTATION'],
        ['resumption', 'SUSPENDED'],
        ['completion', 'IMPLEMENTATION'],
        ['closure', 'SETTLED'],
        ['cancellation', 'CONCEPT'],
      ];
      const stages = ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED'];
      const allowedFrom: Record<string, string[]> = {
        'implementation-start': ['BUDGETED'],
        suspension: ['IMPLEMENTATION'],
        resumption: ['SUSPENDED'],
        completion: ['IMPLEMENTATION'],
        closure: ['SETTLED'],
        cancellation: ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED'],
      };
      let refused = 0;
      for (const stage of stages) {
        const target = await project(stage);
        for (const [path] of commands) {
          if (allowedFrom[path]?.includes(stage)) continue;
          const reply = await stageCall(MANAGER, path, target, { decision_document_id: await document(), investment_decision_document_id: path === 'implementation-start' ? await document() : undefined });
          expect([path, stage, reply.status, reply.json.code]).toEqual([path, stage, 409, 'STAGE_TRANSITION_DENIED']);
          refused += 1;
        }
        expect(await row(target.id)).toMatchObject({ status: stage, version: '1' });
      }
      expect(refused).toBe(66 - 9);
    });

    it('moves a project by each command, audits and announces it with the stages and the decision, and counts it (AC-ST-PRJ-002-2)', async () => {
      const cases: Array<{ path: string; from: string; to: string; ground: 'investment' | 'decision' }> = [
        { path: 'implementation-start', from: 'BUDGETED', to: 'IMPLEMENTATION', ground: 'investment' },
        { path: 'suspension', from: 'IMPLEMENTATION', to: 'SUSPENDED', ground: 'decision' },
        { path: 'resumption', from: 'SUSPENDED', to: 'IMPLEMENTATION', ground: 'decision' },
        { path: 'completion', from: 'IMPLEMENTATION', to: 'COMPLETED', ground: 'decision' },
        { path: 'closure', from: 'SETTLED', to: 'CLOSED', ground: 'decision' },
        { path: 'cancellation', from: 'PIPELINE', to: 'CANCELLED', ground: 'decision' },
      ];
      for (const item of cases) {
        const target = await project(item.from);
        const decision = await document();
        const reply = await stageCall(MANAGER, item.path, target, { [item.ground === 'investment' ? 'investment_decision_document_id' : 'decision_document_id']: decision, effective_date: '2026-11-01' });
        expect(reply.status).toBe(200);
        expect(reply.json).toMatchObject({ status: item.to, resource_version: 2, resource_id: target.id });
        expect(await row(target.id)).toMatchObject({ status: item.to, version: '2', updated_by: memberId(MANAGER) });
        expect(await history(target.id)).toMatchObject([{ project_version: '2', from_stage: item.from, to_stage: item.to, actor_kind: 'USER', actor_id: memberId(MANAGER), decision_document_id: decision, reason: 'A reason for the move' }]);
        const audit = await rows<{ action: string; reason: string; safe_diff: Record<string, unknown>; outcome: string }>(`select action, reason, safe_diff, outcome from machvon.audit_event where resource_id = $1 and action = 'project.stage_changed'`, [target.id]);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', reason: 'A reason for the move', safe_diff: { from: item.from, to: item.to, decision_document_id: decision, effective_date: '2026-11-01', national_code_warning: false } });
        const events = await stageEvents(target.id);
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual(expect.objectContaining({ tenant_id: TENANT_A, project_id: target.id, version: 2, actor_id: memberId(MANAGER), from: item.from, to: item.to, decision_document_id: decision }));
        expect(JSON.stringify(events[0]?.payload)).not.toContain('A reason');
        expect(increments).toContainEqual({ name: 'prj_stage_transition_total', labels: { to: item.to } });
      }
    });

    it('stores the investment decision with the project when implementation starts', async () => {
      const budgeted = await project('BUDGETED');
      const decision = await document('PENDING');
      expect((await stageCall(MANAGER, 'implementation-start', budgeted, { investment_decision_document_id: decision.toUpperCase() })).status).toBe(200);
      expect(await row(budgeted.id)).toMatchObject({ investment_decision_document_id: decision });
    });

    it('replays the answer of a repeated request with the same Idempotency-Key and moves the project once', async () => {
      const running = await project('IMPLEMENTATION');
      const body = { decision_document_id: await document() };
      const key = `key-${randomUUID()}`;
      const first = await stageCall(MANAGER, 'suspension', running, body, { key });
      const again = await stageCall(MANAGER, 'suspension', running, body, { key });
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(again.json).toEqual(first.json);
      expect(await history(running.id)).toHaveLength(1);
      expect(await stageEvents(running.id)).toHaveLength(1);
    });
  });

  describe('the guards over HTTP', () => {
    it('answers 422 DECISION_REQUIRED without the document of the decision, 422 NATIONAL_CODE_REQUIRED without the national code the rule requires', async () => {
      const budgeted = await project('BUDGETED', { nationalCode: null });
      const noDocument = await stageCall(MANAGER, 'implementation-start', budgeted, {});
      expect([noDocument.status, noDocument.json.code, noDocument.json.detail]).toEqual([422, 'DECISION_REQUIRED', 'investment_decision_document_id']);
      const noCode = await stageCall(MANAGER, 'implementation-start', budgeted, { investment_decision_document_id: await document() });
      expect([noCode.status, noCode.json.code, noCode.json.detail]).toEqual([422, 'NATIONAL_CODE_REQUIRED', 'national_project_code']);
      const recalled = await stageCall(MANAGER, 'implementation-start', budgeted, { investment_decision_document_id: await document('RECALLED') });
      expect([recalled.status, recalled.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      const foreign = await stageCall(MANAGER, 'implementation-start', budgeted, { investment_decision_document_id: await document('EFFECTIVE', TENANT_B) });
      expect([foreign.status, foreign.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      const suspended = await project('IMPLEMENTATION');
      expect((await stageCall(MANAGER, 'suspension', suspended, {})).json.code).toBe('DECISION_REQUIRED');
      expect(await row(budgeted.id)).toMatchObject({ status: 'BUDGETED', version: '1' });
    });

    it('answers 409 OPEN_OBLIGATIONS_EXIST to the cancellation of a project that holds committed capital, and cancels it once the capital is gone', async () => {
      const held = await project('BUDGETED');
      await fund(held, { committed: '500' });
      const refused = await stageCall(MANAGER, 'cancellation', held, { decision_document_id: await document() });
      expect([refused.status, refused.json.code]).toEqual([409, 'OPEN_OBLIGATIONS_EXIST']);
      expect(await row(held.id)).toMatchObject({ status: 'BUDGETED', version: '1' });
      await rows('update machvon.allocation_balance set committed_vnd = 0 where allocation_line_id in (select id from machvon.allocation_line where project_id = $1::uuid)', [held.id]);
      expect((await stageCall(MANAGER, 'cancellation', held, { decision_document_id: await document() })).status).toBe(200);
    });

    it('refuses a body outside the allowlist, a short reason and a document sent to a command that does not take it', async () => {
      const running = await project('IMPLEMENTATION');
      const decision = await document();
      const extra = await stageCall(MANAGER, 'suspension', running, { decision_document_id: decision, status: 'CLOSED' });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const short = await stageCall(MANAGER, 'suspension', running, { decision_document_id: decision, reason: 'no' });
      expect(short.status).toBe(422);
      const wrong = await stageCall(MANAGER, 'suspension', running, { decision_document_id: decision, investment_decision_document_id: await document() });
      expect([wrong.status, wrong.json.code, wrong.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'investment_decision_document_id']);
      const badDate = await stageCall(MANAGER, 'suspension', running, { decision_document_id: decision, effective_date: '2026-02-30' });
      expect([badDate.status, badDate.json.detail]).toEqual([422, 'effective_date']);
      expect(await row(running.id)).toMatchObject({ status: 'IMPLEMENTATION', version: '1' });
    });

    it('refuses a stale If-Match with 409 VERSION_CONFLICT and a request without one', async () => {
      const running = await project('IMPLEMENTATION');
      const body = { decision_document_id: await document() };
      const stale = await stageCall(MANAGER, 'suspension', running, body, { version: 9 });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const missing = await call('POST', `/projects/${running.id}/suspension`, { member: MANAGER, body: { reason: 'A reason for the move', ...body } });
      expect(missing.status).toBeGreaterThanOrEqual(400);
      expect(await row(running.id)).toMatchObject({ status: 'IMPLEMENTATION', version: '1' });
    });
  });

  describe('who may move a project', () => {
    it('gives each command its own permission: a caller without it is 403 and the project does not move (TK-PRJ-002-6)', async () => {
      const running = await project('IMPLEMENTATION');
      const body = { decision_document_id: await document() };
      for (const member of [READER, NOBODY, IMPLEMENTER]) {
        const denied = await stageCall(member, 'suspension', running, body);
        expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      const budgeted = await project('BUDGETED');
      expect((await stageCall(IMPLEMENTER, 'implementation-start', budgeted, { investment_decision_document_id: await document() })).status).toBe(200);
      expect(await row(running.id)).toMatchObject({ status: 'IMPLEMENTATION', version: '1' });
      const denials = await rows<{ n: string }>(`select count(*)::text as n from machvon.audit_event where outcome = 'DENIED' and action = 'authz.denied:suspendProject'`);
      expect(Number(denials[0]?.n)).toBe(3);
    });

    it('judges the scope of the permission of the command: out of sight is 404, readable but not within the scope of the command is 403 (TK-PRJ-002-6)', async () => {
      const inDepartment = await project('IMPLEMENTATION', { unit: DEPARTMENT });
      const inRoot = await project('IMPLEMENTATION', { unit: ROOT });
      expect((await stageCall(DEPARTMENT_MANAGER, 'suspension', inDepartment, { decision_document_id: await document() })).status).toBe(200);
      const hidden = await stageCall(DEPARTMENT_MANAGER, 'suspension', inRoot, { decision_document_id: await document() });
      expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const readable = await stageCall(NARROW_ACTOR, 'suspension', inRoot, { decision_document_id: await document() });
      expect([readable.status, readable.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await row(inRoot.id)).toMatchObject({ status: 'IMPLEMENTATION', version: '1' });
      const missing = await stageCall(MANAGER, 'suspension', { id: randomUUID(), version: 1 }, { decision_document_id: await document() });
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });

    it('does not reach a project of another tenant', async () => {
      const foreign = await project('IMPLEMENTATION', { tenant: TENANT_B });
      const reply = await stageCall(MANAGER, 'suspension', foreign, { decision_document_id: await document() });
      expect([reply.status, reply.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(await row(foreign.id, TENANT_B)).toMatchObject({ status: 'IMPLEMENTATION', version: '1' });
      expect(await history(foreign.id, TENANT_B)).toEqual([]);
    });
  });

  describe('getProjectLifecycle', () => {
    it('answers the history of the stage and the moves open now, with the permission, whether the caller holds it and the state of each guard', async () => {
      const waiting = await project('PIPELINE', { nationalCode: null });
      const plan = await fund(waiting);
      const delivery = await deliveryOf(plan.planId, [waiting.id]);
      expect(await consumer().handle(delivery)).toBe('processed');
      const read = await call('GET', `/projects/${waiting.id}/lifecycle`, { member: MANAGER });
      expect(read.status).toBe(200);
      expect(Object.keys(read.json).sort()).toEqual(['as_of', 'code', 'history', 'national_project_code', 'next', 'project_group', 'project_id', 'status', 'status_changed_at', 'version']);
      expect(read.json).toMatchObject({ project_id: waiting.id, status: 'BUDGETED', version: 2, national_project_code: null });
      expect(read.json.history).toEqual([
        expect.objectContaining({ from: 'PIPELINE', to: 'BUDGETED', version: 2, actor_kind: 'SYSTEM', actor_name: null, decision_document_id: plan.documentId, reason: null }),
      ]);
      expect(Object.keys((read.json.history as Array<Record<string, unknown>>)[0] ?? {}).sort()).toEqual(['actor_kind', 'actor_name', 'decision_document_id', 'effective_date', 'from', 'occurred_at', 'operation', 'reason', 'to', 'version']);
      expect(read.json.next).toEqual([
        { operation: 'startProjectImplementation', to: 'IMPLEMENTATION', permission: 'project.stage.implement', allowed: true, guards: [{ key: 'INVESTMENT_DECISION_DOCUMENT', state: 'INPUT_REQUIRED' }, { key: 'NATIONAL_CODE', state: 'UNMET' }] },
        { operation: 'cancelProject', to: 'CANCELLED', permission: 'project.stage.cancel', allowed: true, guards: [{ key: 'DECISION_DOCUMENT', state: 'INPUT_REQUIRED' }, { key: 'OPEN_OBLIGATIONS', state: 'MET' }] },
      ]);
      const asReader = await call('GET', `/projects/${waiting.id}/lifecycle`, { member: READER });
      expect((asReader.json.next as Array<{ allowed: boolean }>).map((entry) => entry.allowed)).toEqual([false, false]);
      const asImplementer = await call('GET', `/projects/${waiting.id}/lifecycle`, { member: IMPLEMENTER });
      expect((asImplementer.json.next as Array<{ operation: string; allowed: boolean }>).map((entry) => [entry.operation, entry.allowed])).toEqual([['startProjectImplementation', true], ['cancelProject', false]]);
    });

    it('names the member who made a move', async () => {
      const running = await project('IMPLEMENTATION');
      await stageCall(MANAGER, 'suspension', running, { decision_document_id: await document() });
      const read = await call('GET', `/projects/${running.id}/lifecycle`, { member: READER });
      expect(read.json.history).toEqual([expect.objectContaining({ from: 'IMPLEMENTATION', to: 'SUSPENDED', actor_kind: 'USER', actor_name: 'User 1', reason: 'A reason for the move' })]);
    });

    it('is 404 outside the scope of the caller and in another tenant, and 403 without project.read', async () => {
      const inRoot = await project('IMPLEMENTATION', { unit: ROOT });
      expect((await call('GET', `/projects/${inRoot.id}/lifecycle`, { member: DEPARTMENT_MANAGER })).status).toBe(404);
      expect((await call('GET', `/projects/${inRoot.id}/lifecycle`, { member: B_MANAGER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/projects/${inRoot.id}/lifecycle`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/projects/${randomUUID()}/lifecycle`, { member: MANAGER })).status).toBe(404);
      expect((await call('GET', '/projects/not-a-uuid/lifecycle', { member: MANAGER })).status).toBe(422);
    });
  });

  describe('listProjectPipeline', () => {
    it('lists the cards of a stage in the order of the project bank with the total, and pages with a cursor', async () => {
      const group = 'QTQG';
      const made: string[] = [];
      for (const score of ['40.00', '90.00', '65.00']) made.push((await project('PIPELINE', { group, score })).id);
      const first = await call('GET', `/project-pipeline?stage=PIPELINE&project_group=${group}&limit=2`, { member: READER });
      expect(first.status).toBe(200);
      expect(first.json.total).toBe(3);
      expect(items(first).map((card) => card.id)).toEqual([made[1], made[2]]);
      expect(first.json.next_cursor).toEqual(expect.any(String));
      const second = await call('GET', `/project-pipeline?stage=PIPELINE&project_group=${group}&limit=2&cursor=${first.json.next_cursor as string}`, { member: READER });
      expect(items(second).map((card) => card.id)).toEqual([made[0]]);
      expect(second.json.next_cursor).toBeNull();
      expect(items(first)[0]).toMatchObject({ status: 'PIPELINE', project_group: group, appraisal_score: '90.00', total_investment_vnd: '500000000000', capital_ready: true, leader_in_charge: null, owner_unit_name: 'Unit 2' });
      expect(Object.keys(items(first)[0] ?? {}).sort()).toEqual(
        ['appraisal_score', 'capital_ready', 'code', 'id', 'investor_unit_name', 'leader_in_charge', 'name', 'national_project_code', 'owner_unit_name', 'project_group', 'status', 'status_changed_at', 'total_investment_vnd', 'version'],
      );
    });

    it('shows only the projects in the unit tree of the caller, and counts only those', async () => {
      const group = 'A';
      const here = await project('COMPLETED', { unit: DEPARTMENT, group });
      const there = await project('COMPLETED', { unit: ELSEWHERE, group });
      const scoped = await call('GET', `/project-pipeline?stage=COMPLETED&project_group=${group}&limit=200`, { member: DEPARTMENT_MANAGER });
      expect(items(scoped).map((card) => card.id)).toContain(here.id);
      expect(items(scoped).map((card) => card.id)).not.toContain(there.id);
      const all = await call('GET', `/project-pipeline?stage=COMPLETED&project_group=${group}&limit=200`, { member: MANAGER });
      expect(items(all).map((card) => card.id)).toEqual(expect.arrayContaining([here.id, there.id]));
      expect(all.json.total).toBe((scoped.json.total as number) + 1);
      expect((await call('GET', '/project-pipeline?stage=COMPLETED', { member: B_MANAGER, tenantId: TENANT_B })).json).toMatchObject({ items: [], total: 0 });
      expect((await call('GET', '/project-pipeline', { member: NOBODY })).status).toBe(403);
    });

    it('refuses a stage, a group, a limit or a cursor that does not exist with 422 naming the parameter', async () => {
      for (const [query, field] of [['stage=LIMBO', 'stage'], ['project_group=Z', 'project_group'], ['limit=0', 'limit'], ['cursor=nope', 'cursor'], ['stage=A&stage=B', 'stage'], ['stage=', 'stage']]) {
        const reply = await call('GET', `/project-pipeline?${query}`, { member: MANAGER });
        expect([query, reply.status, reply.json.detail]).toEqual([query, 422, field]);
      }
    });

    it('serves a page from the cache of the tenant under the stage for 60 seconds, apart for each scope, and drops it when a project moves (TK-PRJ-002-2)', async () => {
      const group = 'C';
      const cached = await project('SUSPENDED', { group, score: '12.00' });
      const url = `/project-pipeline?stage=SUSPENDED&project_group=${group}`;
      const first = await call('GET', url, { member: MANAGER });
      expect(items(first).map((card) => card.id)).toEqual([cached.id]);
      expect(cache.keys().filter((key) => key.startsWith(`t:${TENANT_A}:prj:pipeline:SUSPENDED:`)).length).toBeGreaterThan(0);
      // A change behind the back of the commands is not seen until the entry expires: this is the time to live at work.
      await rows(`update machvon.project set project_group = 'B' where id = $1::uuid`, [cached.id]);
      expect((await call('GET', url, { member: MANAGER })).json).toEqual(first.json);
      // Another scope does not share the entry.
      expect((await call('GET', url, { member: DEPARTMENT_MANAGER })).json).not.toEqual(first.json);
      // A move of any project of the tenant clears the pages of the tenant.
      const running = await project('IMPLEMENTATION');
      await stageCall(MANAGER, 'suspension', running, { decision_document_id: await document() });
      expect(cache.keys().filter((key) => key.startsWith(`t:${TENANT_A}:prj:pipeline:`))).toEqual([]);
      expect(items(await call('GET', url, { member: MANAGER }))).toEqual([]);
    });
  });

  describe('capital.plan_published.v1 (AC-ST-PRJ-002-3)', () => {
    it('makes the project BUDGETED once with one stage_changed event, however often the event is delivered, in the name of the system (TX02)', async () => {
      const waiting = await project('PIPELINE');
      const plan = await fund(waiting);
      const delivery = await deliveryOf(plan.planId, [waiting.id.toUpperCase().toLowerCase()]);
      const seen: string[] = [];
      const counting = consumer({ metrics: { increment: (name, labels) => void seen.push(`${name}:${labels?.to}`), gauge: () => undefined } });
      expect(await counting.handle(delivery)).toBe('processed');
      expect(await counting.handle(delivery)).toBe('duplicate');
      expect(await counting.handle(delivery)).toBe('duplicate');
      // The same plan published again under another event id finds the project already BUDGETED and moves nothing.
      expect(await counting.handle({ ...delivery, id: randomUUID() })).toBe('processed');
      expect(await row(waiting.id)).toMatchObject({ status: 'BUDGETED', version: '2', updated_by: WORKER });
      expect(await history(waiting.id)).toMatchObject([{ from_stage: 'PIPELINE', to_stage: 'BUDGETED', actor_kind: 'SYSTEM', actor_id: WORKER, decision_document_id: plan.documentId, reason: null }]);
      const events = await stageEvents(waiting.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ project_id: waiting.id, version: 2, from: 'PIPELINE', to: 'BUDGETED', actor_id: WORKER, decision_document_id: plan.documentId });
      const audit = await rows<{ actor_id: string; reason: string | null; outcome: string }>(`select actor_id, reason, outcome from machvon.audit_event where resource_id = $1 and action = 'project.stage_changed'`, [waiting.id]);
      expect(audit).toEqual([{ actor_id: WORKER, reason: null, outcome: 'SUCCESS' }]);
      const caused = await rows<{ causation_id: string }>(`select causation_id from machvon.outbox_event where aggregate_id = $1 and type = 'project.stage_changed.v1'`, [waiting.id]);
      expect(caused).toEqual([{ causation_id: delivery.id }]);
      expect(seen).toEqual(['prj_stage_transition_total:BUDGETED']);
    });

    it('leaves a project that is not in the pipeline or has no funded line, and drops the pages of the project bank only when something moved', async () => {
      const inConcept = await project('CONCEPT');
      const plan = await fund(inConcept);
      await cache.set(TENANT_A, 'all', 'probe', 'x');
      expect(await consumer().handle(await deliveryOf(plan.planId, [inConcept.id]))).toBe('processed');
      expect(await row(inConcept.id)).toMatchObject({ status: 'CONCEPT', version: '1' });
      expect(await cache.get(TENANT_A, 'all', 'probe')).toBe('x');
      const funded = await project('PIPELINE');
      const unfunded = await project('PIPELINE');
      const moving = await fund(funded);
      expect(await consumer().handle(await deliveryOf(moving.planId, [funded.id, unfunded.id]))).toBe('processed');
      expect(await cache.get(TENANT_A, 'all', 'probe')).toBeUndefined();
      expect(await row(funded.id)).toMatchObject({ status: 'BUDGETED' });
      expect(await row(unfunded.id)).toMatchObject({ status: 'PIPELINE', version: '1' });
    });

    it('does nothing for a plan that was not published, ignores other events and a payload of another tenant, and fails on a payload it cannot read', async () => {
      const waiting = await project('PIPELINE');
      const draft = await fund(waiting, {}, 'APPROVED');
      const delivery = await deliveryOf(draft.planId, [waiting.id]);
      expect(await consumer().handle(delivery)).toBe('processed');
      expect(await row(waiting.id)).toMatchObject({ status: 'PIPELINE', version: '1' });
      expect(await consumer().handle({ ...delivery, type: 'capital.plan_submitted.v1' })).toBe('ignored');
      expect(await consumer().handle({ ...delivery, payload: { ...delivery.payload, tenant_id: TENANT_B } })).toBe('ignored');
      for (const payload of [{ ...delivery.payload, capital_plan_id: 'nope' }, { ...delivery.payload, project_ids: 'all' }, { ...delivery.payload, project_ids: [waiting.id, 7] }]) {
        await expect(consumer().handle({ ...delivery, id: randomUUID(), payload })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      }
      await expect(consumer().handle({ ...delivery, id: randomUUID(), tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, randomBytes(32)) })).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    });
  });
});
