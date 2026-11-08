import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { DEFAULT_SEVERITY_RULES, EffectiveAccessStore, HomeWorkStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { PackageWorkflowController, PackageWorkflowReadsController } from '../../src/modules/bid/workflow.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedBidPackage } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // every workflow permission over the tenant
const WORKER = 2; // bid.workflow.work, bid.read
const ADVANCER = 3; // bid.workflow.advance, bid.read
const APPROVER = 4; // bid.workflow.approve, bid.read
const READER = 5; // bid.read only
const NOBODY = 6;
const DEPARTMENT_MANAGER = 7; // every workflow permission over the department
const ELSEWHERE_MANAGER = 8; // every workflow permission over another branch
const B_MANAGER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The members of the bodies that this suite looks into: the replies are JSON read back as they came, so each shape names only what the assertions use. */
interface ItemBody {
  id: string;
  code: string;
  status: string;
  completed_via?: string;
  completed_by: string | null;
  evidence: unknown[];
}
interface WorkflowBody {
  id: string;
  version: number;
  status: string;
  step?: { code: string };
  blockers: Array<{ reason: string }>;
  owner: unknown;
  exceptions: Array<{ id: string; status: string; kind: string }>;
  checklist: ItemBody[];
  timeline: { days: unknown };
}
interface BoardBody {
  columns: Array<{ code: string; cards: Array<{ actions: { advance: boolean } }> }>;
}
interface WholeBody {
  actions: unknown;
  workflow: { links: unknown };
}
interface StatisticsBody {
  steps: unknown;
  stuck: unknown[];
  kpis: unknown;
}
interface ExportBody {
  content_base64: string;
  content_type: string;
  size_bytes: number;
}
interface SummaryBody {
  top_steps: unknown;
}

const dayFromToday = (offset: number): string => new Date(Date.now() + 7 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);

/** Three steps with standard days 2, 3 and 2 (weight 7). The second is maker-checker and asks for a decision; the third is carried by the milestone CONTRACT_SIGNED. */
const DEFINITION = {
  method: 'OPEN_BIDDING',
  name: 'Quy trình thử của kiểm thử',
  stalled_after_working_days: 3,
  checklist_warn_days: 1,
  steps: [
    {
      code: 'PLAN_STEP',
      name: 'Lập kế hoạch',
      entry_condition: 'Gói có kế hoạch được duyệt',
      exit_condition: 'Có hồ sơ kế hoạch',
      responsible_role: 'PROCUREMENT_OFFICER',
      standard_working_days: 2,
      evidence_kinds: ['DOCUMENT'],
      maker_checker: false,
      checklist: [
        { code: 'PLAN_DOC', name: 'Hồ sơ kế hoạch', required: true, owner_role: 'PROCUREMENT_OFFICER', due_offset_working_days: 1, evidence_kinds: ['DOCUMENT'], evidence_required: true },
        { code: 'PLAN_NOTE', name: 'Ghi chú tùy chọn', required: false, owner_role: 'PROCUREMENT_OFFICER', due_offset_working_days: 1, evidence_kinds: [], evidence_required: false },
      ],
    },
    {
      code: 'APPROVE_STEP',
      name: 'Phê duyệt',
      entry_condition: 'Có hồ sơ kế hoạch',
      exit_condition: 'Có quyết định',
      responsible_role: 'DECISION_AUTHORITY',
      standard_working_days: 3,
      evidence_kinds: ['DECISION_DOCUMENT'],
      maker_checker: true,
      checklist: [
        { code: 'DECISION', name: 'Quyết định phê duyệt', required: true, owner_role: 'DECISION_AUTHORITY', due_offset_working_days: 2, evidence_kinds: ['DECISION_DOCUMENT'], evidence_required: true },
        { code: 'CHECKED', name: 'Đã rà soát', required: true, owner_role: 'DECISION_AUTHORITY', due_offset_working_days: 2, evidence_kinds: [], evidence_required: false },
      ],
    },
    {
      code: 'SIGN_STEP',
      name: 'Ký hợp đồng',
      entry_condition: 'Có quyết định',
      exit_condition: 'Hợp đồng đã ký',
      responsible_role: 'DECISION_AUTHORITY',
      standard_working_days: 2,
      evidence_kinds: ['MILESTONE'],
      milestone_kind: 'CONTRACT_SIGNED',
      maker_checker: false,
      checklist: [{ code: 'SIGNED', name: 'Hợp đồng đã ký', required: true, owner_role: 'DECISION_AUTHORITY', due_offset_working_days: 2, evidence_kinds: ['MILESTONE', 'DOCUMENT'], evidence_required: true, milestone_kind: 'CONTRACT_SIGNED' }],
    },
  ],
};

describe('the workflow of a procurement package over HTTP (PRC-1)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

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
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string }>('select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);

  const paper = async (): Promise<string> => {
    const documentId = randomUUID();
    await seedAs(harness, [[`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CV', 'Paper', 'INTERNAL', $3, $3)`, [TENANT_A, documentId, memberId(MANAGER)]]]);
    return documentId;
  };

  const newPackage = async (projectId?: string, unit?: number) => seedBidPackage(harness, { ...(projectId === undefined ? {} : { projectId }), ...(unit === undefined ? {} : { unit }) });
  const start = (packageId: string, member = MANAGER, body: Record<string, unknown> = {}, key?: string): Promise<Reply> => call('POST', `/procurement-packages/${packageId}/workflow`, { member, body, ...(key === undefined ? {} : { key }) });
  const detail = (packageId: string, member = MANAGER, tenantId?: string): Promise<Reply> => call('GET', `/procurement-packages/${packageId}/workflow`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const workflowOf = async (packageId: string): Promise<WorkflowBody> => ((await detail(packageId)).json.workflow ?? {}) as WorkflowBody;
  const versionOf = async (packageId: string): Promise<number> => Number((await workflowOf(packageId)).version);
  const itemOf = async (packageId: string, code: string): Promise<ItemBody> => (await workflowOf(packageId)).checklist.find((one) => one.code === code) as ItemBody;
  const complete = async (packageId: string, code: string, member: number, evidence: unknown[] = []): Promise<Reply> => call('POST', `/package-checklist-items/${(await itemOf(packageId, code)).id}/completion`, { member, body: { evidence } });
  const advance = async (packageId: string, member: number, body: Record<string, unknown> = {}): Promise<Reply> => call('POST', `/package-workflows/${(await workflowOf(packageId)).id}/advance`, { member, ifMatch: `"${await versionOf(packageId)}"`, body });
  const post = async (packageId: string, path: string, member: number, body: Record<string, unknown>, versioned = true): Promise<Reply> =>
    call('POST', `/package-workflows/${(await workflowOf(packageId)).id}/${path}`, { member, ...(versioned ? { ifMatch: `"${await versionOf(packageId)}"` } : {}), body });
  const doc = async (): Promise<Record<string, unknown>> => ({ kind: 'DOCUMENT', document_id: await paper() });
  const decisionDoc = async (): Promise<Record<string, unknown>> => ({ kind: 'DECISION_DOCUMENT', document_id: await paper() });

  /** Walks a package to the third step: the first item with a document, the maker of the second step is the WORKER, the one who leaves it the ADVANCER. */
  const walkToSign = async (packageId: string): Promise<void> => {
    expect((await start(packageId)).status).toBe(200);
    expect((await complete(packageId, 'PLAN_DOC', WORKER, [await doc()])).status).toBe(200);
    expect((await advance(packageId, ADVANCER)).status).toBe(200);
    expect((await complete(packageId, 'DECISION', WORKER, [await decisionDoc()])).status).toBe(200);
    expect((await complete(packageId, 'CHECKED', WORKER)).status).toBe(200);
    expect((await advance(packageId, ADVANCER)).status).toBe(200);
  };

  const seedMilestone = async (packageId: string, kind: string, actual: string): Promise<void> => {
    await seedAs(harness, [[`insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, actual_at, source, created_by, updated_by, version) values ($1, $2, $3, $4, $5::timestamptz, 'MANUAL', $6, $6, 1)`, [TENANT_A, randomUUID(), packageId, kind, actual, memberId(MANAGER)]]]);
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MANAGER, WORKER, ADVANCER, APPROVER, READER, NOBODY, DEPARTMENT_MANAGER, ELSEWHERE_MANAGER, 9]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    const all = ['bid.workflow.manage', 'bid.workflow.work', 'bid.workflow.advance', 'bid.workflow.approve', 'bid.read'];
    await harness.seedRole(TENANT_A, 1, 'PRC_MANAGER', all, 30);
    await harness.seedRole(TENANT_A, 2, 'PRC_WORKER', ['bid.workflow.work', 'bid.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'PRC_ADVANCER', ['bid.workflow.advance', 'bid.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'PRC_APPROVER', ['bid.workflow.approve', 'bid.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'BID_READER', ['bid.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'PRC_MANAGER', all, 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: WORKER, role: 2, kind: 'TENANT' },
      { n: 3, member: ADVANCER, role: 3, kind: 'TENANT' },
      { n: 4, member: APPROVER, role: 4, kind: 'TENANT' },
      { n: 5, member: READER, role: 5, kind: 'TENANT' },
      { n: 7, member: DEPARTMENT_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 8, member: ELSEWHERE_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 9, member: 9, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    // The working calendar the due days are counted on (Monday to Friday, no holidays) for the years a test can reach.
    const year = Number(dayFromToday(0).slice(0, 4));
    await harness.owner(
      TENANT_A,
      [year - 1, year, year + 1, year + 2, year + 3].map((one): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, one, memberId(MANAGER)],
      ]),
    );
    // The tenant approved its own definition for open bidding: three steps (maker, submitter and approver are three different people).
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, 'PROCUREMENT_WORKFLOW', 'OPEN_BIDDING', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'Quy trình thử cho kiểm thử', $3, $4, now(), $5, now())`,
        [TENANT_A, JSON.stringify(DEFINITION), memberId(MANAGER), memberId(WORKER), memberId(ADVANCER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PackageWorkflowController, PackageWorkflowReadsController],
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
    expect(bidModule.controllers).toEqual(expect.arrayContaining([PackageWorkflowController, PackageWorkflowReadsController]));
  });

  describe('startPackageWorkflow', () => {
    it('freezes the definition of the method into the package, opens its first step with the checklist, audits it, announces it, and answers the same key once', async () => {
      const pkg = await newPackage();
      const first = await start(pkg.packageId, MANAGER, { owner_id: memberId(WORKER) }, 'start-once-for-this-key');
      expect(first).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS', resource_version: 1 } });
      expect(await start(pkg.packageId, MANAGER, { owner_id: memberId(WORKER) }, 'start-once-for-this-key')).toEqual(first);
      const id = first.json.resource_id as string;
      const [stored] = await rows<{ definition_rule_version: number; definition_hash: string; current_step_code: string; owner_membership_id: string; definition: { steps: unknown[] } }>('select definition_rule_version, definition_hash, current_step_code, owner_membership_id, definition from machvon.package_workflow where id = $1::uuid', [id]);
      expect(stored).toMatchObject({ definition_rule_version: 1, current_step_code: 'PLAN_STEP', owner_membership_id: memberId(WORKER) });
      expect(stored?.definition_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored?.definition.steps).toHaveLength(3);
      expect(await rows('select id from machvon.package_step where workflow_id = $1::uuid', [id])).toHaveLength(1);
      expect(await rows('select item_code from machvon.package_checklist_item where workflow_id = $1::uuid order by item_code', [id])).toEqual([{ item_code: 'PLAN_DOC' }, { item_code: 'PLAN_NOTE' }]);
      const [audit] = await audits(id, 'workflow.started');
      expect(audit).toMatchObject({ actor_id: memberId(MANAGER), safe_diff: { package_id: pkg.packageId, to_step: 'PLAN_STEP', definition_rule_version: 1, from_status: null, to_status: 'IN_PROGRESS' } });
      const [event] = await events(id, 'bid.workflow.started.v1');
      expect(event?.payload).toMatchObject({ workflow_id: id, package_id: pkg.packageId, project_id: pkg.projectId, status: 'IN_PROGRESS', version: 1, actor_id: memberId(MANAGER) });
    });

    it('refuses a package whose plan is not approved, a second start, a method with no definition, an owner who is no member, and a shape that is not one', async () => {
      const draft = await seedBidPackage(harness, { status: 'DRAFT' });
      expect(await start(draft.packageId)).toMatchObject({ status: 409, json: { code: 'PACKAGE_STATE_INVALID' } });
      const pkg = await newPackage();
      expect((await start(pkg.packageId)).status).toBe(200);
      expect(await start(pkg.packageId)).toMatchObject({ status: 409, json: { code: 'PACKAGE_WORKFLOW_STATE_INVALID', reason: 'ALREADY_STARTED' } });
      const odd = await newPackage();
      await seedAs(harness, [[`update machvon.procurement_package set method = 'UNHEARD_OF' where id = $1`, [odd.packageId]]]);
      expect(await start(odd.packageId)).toMatchObject({ status: 422, json: { code: 'PACKAGE_WORKFLOW_METHOD_UNSUPPORTED' } });
      const third = await newPackage();
      expect(await start(third.packageId, MANAGER, { owner_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await start(third.packageId, MANAGER, { surprise: true })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await rows('select id from machvon.package_workflow where package_id = $1::uuid', [third.packageId])).toHaveLength(0);
    });

    it('is for whoever holds the permission over the project: a package outside the scope does not exist', async () => {
      const pkg = await newPackage();
      expect((await start(pkg.packageId, READER)).status).toBe(403);
      expect((await start(pkg.packageId, NOBODY)).status).toBe(403);
      expect((await start(pkg.packageId, ELSEWHERE_MANAGER)).status).toBe(404);
      expect((await call('POST', `/procurement-packages/${pkg.packageId}/workflow`, { member: B_MANAGER, tenantId: TENANT_B, body: {} })).status).toBe(404);
      expect((await start(randomUUID())).status).toBe(404);
      expect((await start(pkg.packageId, DEPARTMENT_MANAGER)).status).toBe(200);
    });
  });

  describe('the checklist and the step', () => {
    it('keeps a package in its step while a required item is open and says which; completes an item only with evidence of an allowed kind that points at something', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      expect(await advance(pkg.packageId, ADVANCER)).toMatchObject({ status: 409, json: { code: 'PACKAGE_WORKFLOW_BLOCKED', step_code: 'PLAN_STEP', coverable_by_exception: true } });
      const blocked = (await advance(pkg.packageId, ADVANCER)).json.blockers as Array<{ code: string; subject: string }>;
      expect(blocked).toEqual(expect.arrayContaining([{ code: 'REQUIRED_ITEM_OPEN', subject: 'PLAN_DOC' }, { code: 'STEP_EVIDENCE_MISSING', subject: 'DOCUMENT' }]));
      expect(await complete(pkg.packageId, 'PLAN_DOC', WORKER, [])).toMatchObject({ status: 422, json: { code: 'CHECKLIST_EVIDENCE_REQUIRED' } });
      expect(await complete(pkg.packageId, 'PLAN_DOC', WORKER, [{ kind: 'ATTESTATION', note: 'Tôi xác nhận đã có hồ sơ' }])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await complete(pkg.packageId, 'PLAN_DOC', WORKER, [{ kind: 'DOCUMENT' }])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await complete(pkg.packageId, 'PLAN_DOC', WORKER, [{ kind: 'DOCUMENT', document_id: randomUUID() }])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await complete(pkg.packageId, 'PLAN_DOC', WORKER, [{ kind: 'NOT_A_KIND' }])).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await itemOf(pkg.packageId, 'PLAN_DOC')).status).toBe('OPEN');
      const done = await complete(pkg.packageId, 'PLAN_DOC', WORKER, [await doc()]);
      expect(done).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
      expect(await complete(pkg.packageId, 'PLAN_DOC', WORKER, [await doc()])).toMatchObject({ status: 409, json: { code: 'PACKAGE_WORKFLOW_STATE_INVALID' } });
      const [audit] = await audits((await workflowOf(pkg.packageId)).id, 'workflow.item_completed');
      expect(audit).toMatchObject({ actor_id: memberId(WORKER), safe_diff: { item_code: 'PLAN_DOC', evidence_count: 1, evidence_kinds: ['DOCUMENT'] } });
    });

    it('moves on only when the version is the current one, answers the same key once, and records the visit that ended and the one that began', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      await complete(pkg.packageId, 'PLAN_DOC', WORKER, [await doc()]);
      const id = (await workflowOf(pkg.packageId)).id as string;
      const version = await versionOf(pkg.packageId);
      expect(await call('POST', `/package-workflows/${id}/advance`, { member: ADVANCER, ifMatch: `"${version - 1}"`, body: {} })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const first = await call('POST', `/package-workflows/${id}/advance`, { member: ADVANCER, ifMatch: `"${version}"`, body: { note: 'Đủ hồ sơ để phê duyệt' }, key: 'advance-once-for-this-key' });
      expect(first).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS', resource_version: version + 1 } });
      expect(await call('POST', `/package-workflows/${id}/advance`, { member: ADVANCER, ifMatch: `"${version}"`, body: { note: 'Đủ hồ sơ để phê duyệt' }, key: 'advance-once-for-this-key' })).toEqual(first);
      const visits = await rows<{ visit: number; step_code: string; exit_kind: string | null; entry_kind: string; exited_by: string | null; due_on: string | null; due_basis: string }>('select visit, step_code, exit_kind, entry_kind, exited_by, due_on::text, due_basis from machvon.package_step where workflow_id = $1::uuid order by visit', [id]);
      expect(visits).toHaveLength(2);
      expect(visits[0]).toMatchObject({ step_code: 'PLAN_STEP', exit_kind: 'ADVANCE', exited_by: memberId(ADVANCER), entry_kind: 'START' });
      expect(visits[1]).toMatchObject({ step_code: 'APPROVE_STEP', exit_kind: null, entry_kind: 'ADVANCE', due_basis: 'WORKING_DAYS' });
      expect(visits[1]?.due_on).not.toBeNull();
      expect((await audits(id, 'workflow.step_advanced'))[0]?.safe_diff).toMatchObject({ from_step: 'PLAN_STEP', to_step: 'APPROVE_STEP' });
      expect((await events(id, 'bid.workflow.step_advanced.v1'))[0]?.payload).toMatchObject({ from_step: 'PLAN_STEP', to_step: 'APPROVE_STEP' });
    });

    it('keeps maker and approver apart on a maker-checker step: who completed an item cannot leave the step (403), another person can', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      await complete(pkg.packageId, 'PLAN_DOC', MANAGER, [await doc()]);
      expect((await advance(pkg.packageId, MANAGER)).status).toBe(200); // PLAN_STEP is not maker-checker
      await complete(pkg.packageId, 'DECISION', MANAGER, [await decisionDoc()]);
      await complete(pkg.packageId, 'CHECKED', WORKER);
      expect(await advance(pkg.packageId, MANAGER)).toMatchObject({ status: 403, json: { code: 'WORKFLOW_MAKER_IS_APPROVER' } });
      expect((await workflowOf(pkg.packageId)).step?.code).toBe('APPROVE_STEP');
      expect((await advance(pkg.packageId, ADVANCER)).status).toBe(200);
      const [closed] = await rows<{ approved_by: string | null }>(`select approved_by from machvon.package_step where package_id = $1::uuid and step_code = 'APPROVE_STEP'`, [pkg.packageId]);
      expect(closed?.approved_by).toBe(memberId(ADVANCER));
    });

    it('counts a milestone that has an actual date as the evidence of its item, completes the workflow at the last step and makes it final', async () => {
      const pkg = await newPackage();
      await seedMilestone(pkg.packageId, 'CONTRACT_SIGNED', new Date(Date.now() - 86_400_000).toISOString());
      await walkToSign(pkg.packageId);
      const signed = await itemOf(pkg.packageId, 'SIGNED');
      expect(signed).toMatchObject({ status: 'DONE', completed_via: 'MILESTONE', completed_by: null });
      expect(signed.evidence).toEqual([expect.objectContaining({ kind: 'MILESTONE', milestone_kind: 'CONTRACT_SIGNED' })]);
      const done = await advance(pkg.packageId, ADVANCER);
      expect(done).toMatchObject({ status: 200, json: { status: 'COMPLETED' } });
      const finished = (await detail(pkg.packageId)).json.workflow as WorkflowBody;
      expect(finished).toMatchObject({ status: 'COMPLETED', step: null, progress: { percent: 100 } });
      expect(await post(pkg.packageId, 'hold', MANAGER, { reason: 'Không còn gì để dừng' })).toMatchObject({ status: 409, json: { code: 'PACKAGE_WORKFLOW_STATE_INVALID' } });
      expect((await events(finished.id, 'bid.workflow.completed.v1'))[0]?.payload).toMatchObject({ status: 'COMPLETED', from_step: 'SIGN_STEP' });
    });

    it('holds with a reason (a held package cannot move or take items), resumes, returns to an earlier step only, and cancels with a reason', async () => {
      const pkg = await newPackage();
      await walkToSign(pkg.packageId);
      expect(await post(pkg.packageId, 'hold', MANAGER, { reason: 'ừ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await post(pkg.packageId, 'hold', MANAGER, { reason: 'Chờ ý kiến của cấp trên' })).toMatchObject({ status: 200, json: { status: 'ON_HOLD' } });
      const held = await workflowOf(pkg.packageId);
      expect(held).toMatchObject({ status: 'ON_HOLD', hold_reason: 'Chờ ý kiến của cấp trên' });
      expect(held.blockers.map((one: { reason: string }) => one.reason)).toContain('ON_HOLD');
      expect(await advance(pkg.packageId, ADVANCER)).toMatchObject({ status: 409, json: { code: 'PACKAGE_WORKFLOW_STATE_INVALID' } });
      expect(await post(pkg.packageId, 'hold', MANAGER, { reason: 'Dừng lần nữa không được' })).toMatchObject({ status: 409 });
      expect(await post(pkg.packageId, 'resume', MANAGER, {})).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
      expect(await post(pkg.packageId, 'resume', MANAGER, {})).toMatchObject({ status: 409 });
      expect(await post(pkg.packageId, 'return', MANAGER, { to_step: 'SIGN_STEP', reason: 'Không phải bước trước' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await post(pkg.packageId, 'return', MANAGER, { to_step: 'PLAN_STEP', reason: 'Thiếu hồ sơ kỹ thuật' })).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
      const back = await workflowOf(pkg.packageId);
      expect(back.step?.code).toBe('PLAN_STEP');
      expect(back.checklist.map((one: { status: string }) => one.status)).toEqual(['OPEN', 'OPEN']);
      expect((await rows('select visit from machvon.package_step where package_id = $1::uuid', [pkg.packageId])).length).toBe(4);
      expect(await post(pkg.packageId, 'cancel', APPROVER, { reason: 'Đấu thầu không thành' })).toMatchObject({ status: 200, json: { status: 'CANCELLED' } });
      expect(await workflowOf(pkg.packageId)).toMatchObject({ status: 'CANCELLED', step: null, end_reason: 'Đấu thầu không thành' });
      expect(await post(pkg.packageId, 'cancel', APPROVER, { reason: 'Hủy lần nữa không được' })).toMatchObject({ status: 409 });
    });

    it('gives a package an owner, reassigns it only with a reason, and refuses someone who is no member', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      expect((await workflowOf(pkg.packageId)).blockers.map((one: { reason: string }) => one.reason)).toContain('NO_OWNER');
      expect(await post(pkg.packageId, 'owner', MANAGER, { owner_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await post(pkg.packageId, 'owner', MANAGER, { owner_id: memberId(WORKER) })).toMatchObject({ status: 200 });
      expect((await workflowOf(pkg.packageId)).owner).toMatchObject({ id: memberId(WORKER) });
      expect(await post(pkg.packageId, 'owner', MANAGER, { owner_id: memberId(ADVANCER) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await post(pkg.packageId, 'owner', MANAGER, { owner_id: memberId(ADVANCER), reason: 'Người cũ chuyển công tác' })).toMatchObject({ status: 200 });
      const [reassigned] = await audits((await workflowOf(pkg.packageId)).id, 'workflow.owner_assigned');
      expect(reassigned).toBeDefined();
      const log = await rows<{ kind: string }>('select kind from machvon.package_workflow_log where package_id = $1::uuid order by at, id', [pkg.packageId]);
      expect(log.map((one) => one.kind)).toEqual(['ASSIGN_OWNER', 'REASSIGN_OWNER']);
    });
  });

  describe('the exceptions of a step', () => {
    it('lets a package leave a step with an item open only when ANOTHER person approved an exception for it; the open item is then waived, not done', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      const id = (await workflowOf(pkg.packageId)).id as string;
      const asked = await post(pkg.packageId, 'exceptions', WORKER, { kind: 'SKIP_ITEMS', reason: 'Hồ sơ nộp sau, đã có cam kết' }, false);
      expect(asked).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
      const exceptionId = asked.json.resource_id as string;
      expect(await post(pkg.packageId, 'exceptions', WORKER, { kind: 'SKIP_ITEMS', reason: 'Xin lần hai khi đã có một cái mở' }, false)).toMatchObject({ status: 409, json: { code: 'STEP_EXCEPTION_STATE_INVALID', reason: 'ALREADY_OPEN' } });
      expect(await call('POST', `/package-step-exceptions/${exceptionId}/decision`, { member: MANAGER, body: { decision: 'APPROVE' } })).toMatchObject({ status: 200 });
      // The manager was not the one who asked; the worker asking and deciding is refused.
      const own = await newPackage();
      await start(own.packageId);
      const ownAsked = await post(own.packageId, 'exceptions', MANAGER, { kind: 'SKIP_ITEMS', reason: 'Tự xin và tự duyệt không được' }, false);
      expect(await call('POST', `/package-step-exceptions/${ownAsked.json.resource_id}/decision`, { member: MANAGER, body: { decision: 'APPROVE' } })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await rows<{ status: string }>('select status from machvon.package_step_exception where id = $1::uuid', [ownAsked.json.resource_id]))[0]?.status).toBe('REQUESTED');

      expect(await advance(pkg.packageId, ADVANCER)).toMatchObject({ status: 409, json: { code: 'PACKAGE_WORKFLOW_BLOCKED' } });
      const moved = await advance(pkg.packageId, ADVANCER, { exception_id: exceptionId });
      expect(moved).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
      expect((await workflowOf(pkg.packageId)).step?.code).toBe('APPROVE_STEP');
      expect(await rows('select status, completed_via from machvon.package_checklist_item where workflow_id = $1::uuid and item_code = $2', [id, 'PLAN_DOC'])).toEqual([{ status: 'WAIVED', completed_via: 'EXCEPTION' }]);
      expect((await rows<{ status: string; decided_by: string }>('select status, decided_by from machvon.package_step_exception where id = $1::uuid', [exceptionId]))[0]).toMatchObject({ status: 'USED', decided_by: memberId(MANAGER) });
      expect(await advance(pkg.packageId, ADVANCER, { exception_id: exceptionId })).toMatchObject({ status: 409 });
    });

    it('does not let an exception cover the maker-checker rule, and refuses an exception that was rejected, was decided twice, or is for a step the package left', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      const asked = await post(pkg.packageId, 'exceptions', WORKER, { kind: 'SKIP_ITEMS', reason: 'Bỏ qua mục hồ sơ kế hoạch' }, false);
      const exceptionId = asked.json.resource_id as string;
      expect(await call('POST', `/package-step-exceptions/${exceptionId}/decision`, { member: APPROVER, body: { decision: 'REJECT', note: 'Chưa đủ lý do' } })).toMatchObject({ status: 200 });
      expect(await call('POST', `/package-step-exceptions/${exceptionId}/decision`, { member: APPROVER, body: { decision: 'APPROVE' } })).toMatchObject({ status: 409, json: { code: 'STEP_EXCEPTION_STATE_INVALID', reason: 'NOT_WAITING' } });
      expect(await advance(pkg.packageId, ADVANCER, { exception_id: exceptionId })).toMatchObject({ status: 409, json: { code: 'STEP_EXCEPTION_STATE_INVALID' } });
      expect(await call('POST', `/package-step-exceptions/${exceptionId}/decision`, { member: WORKER, body: { decision: 'APPROVE' } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/package-step-exceptions/${exceptionId}/decision`, { member: APPROVER, body: { decision: 'MAYBE' } })).toMatchObject({ status: 422 });
    });

    it('takes a package back one step when it was moved by mistake (CORRECT_BACK, decided by another person); the wrong visit ends as CORRECTED and nothing is erased', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      await complete(pkg.packageId, 'PLAN_DOC', WORKER, [await doc()]);
      await advance(pkg.packageId, ADVANCER);
      expect(await post(pkg.packageId, 'exceptions', WORKER, { kind: 'CORRECT_BACK', reason: 'Chuyển nhầm gói thầu' }, false)).toMatchObject({ status: 200 });
      const waiting = (await workflowOf(pkg.packageId)).exceptions as Array<{ id: string; status: string; kind: string }>;
      expect(waiting).toEqual([expect.objectContaining({ kind: 'CORRECT_BACK', status: 'REQUESTED' })]);
      expect(await call('POST', `/package-step-exceptions/${waiting[0]?.id}/decision`, { member: APPROVER, body: { decision: 'APPROVE', note: 'Đúng là chuyển nhầm' } })).toMatchObject({ status: 200 });
      const back = await workflowOf(pkg.packageId);
      expect(back.step?.code).toBe('PLAN_STEP');
      expect(back.exceptions[0]).toMatchObject({ status: 'USED' });
      const visits = await rows<{ visit: number; step_code: string; exit_kind: string | null; entry_kind: string }>('select visit, step_code, exit_kind, entry_kind from machvon.package_step where package_id = $1::uuid order by visit', [pkg.packageId]);
      expect(visits).toEqual([
        { visit: 1, step_code: 'PLAN_STEP', exit_kind: 'ADVANCE', entry_kind: 'START' },
        { visit: 2, step_code: 'APPROVE_STEP', exit_kind: 'CORRECTED', entry_kind: 'ADVANCE' },
        { visit: 3, step_code: 'PLAN_STEP', exit_kind: null, entry_kind: 'CORRECTION' },
      ]);
      const kinds = ((back.timeline.days as Array<{ entries: Array<{ kind: string }> }>).flatMap((day) => day.entries)).map((entry) => entry.kind);
      expect(kinds).toEqual(expect.arrayContaining(['START', 'STATE_CHANGE', 'CORRECTION', 'EXCEPTION']));
    });
  });

  describe('the history is append-only', () => {
    it('refuses the application role an update of a closed visit, a delete of any history row, and an update of the evidence or the log', async () => {
      const pkg = await newPackage();
      await walkToSign(pkg.packageId);
      const tenants = harness.tenants as TenantDatabase;
      const attempt = (sql: string, params: unknown[] = []): Promise<unknown> => tenants.withTenant(contextFor(TENANT_A, memberId(MANAGER)), (tx) => tx.query(sql, params));
      await expect(attempt(`update machvon.package_step set note = 'rewritten' where package_id = $1::uuid and visit = 1`, [pkg.packageId])).rejects.toThrow(/never changes|permission denied/);
      await expect(attempt(`delete from machvon.package_step where package_id = $1::uuid`, [pkg.packageId])).rejects.toThrow(/never deleted|permission denied/);
      await expect(attempt(`delete from machvon.package_workflow where package_id = $1::uuid`, [pkg.packageId])).rejects.toThrow(/never deleted|permission denied/);
      await expect(attempt(`update machvon.package_checklist_evidence set note = 'x' where workflow_id = (select id from machvon.package_workflow where package_id = $1::uuid)`, [pkg.packageId])).rejects.toThrow(/permission denied/);
      await expect(attempt(`delete from machvon.package_workflow_log where package_id = $1::uuid`, [pkg.packageId])).rejects.toThrow(/permission denied/);
      await expect(attempt(`update machvon.package_checklist_item set name = 'rewritten' where package_id = $1::uuid`, [pkg.packageId])).rejects.toThrow(/never changes/);
    });
  });

  describe('the reads', () => {
    interface Node {
      id: string;
      count: number;
      value_vnd: string;
      late_count: number;
      path: string[];
      median_days: number | null;
    }
    const treeOf = async (projectId: string, member = MANAGER, extra = ''): Promise<{ nodes: Node[]; edges: Array<{ from: string; to: string; kind: string; count: number }>; total: { count: number; value_vnd: string } }> =>
      (await call('GET', `/package-workflows/process-tree?project_id=${projectId}${extra}`, { member })).json as never;

    it('counts every package once in the tree, gives the same packages for a node as its count, and keeps packages outside the scope out of the numbers', async () => {
      const first = await newPackage();
      const projectId = first.projectId;
      const second = await seedBidPackage(harness, { projectId });
      const third = await seedBidPackage(harness, { projectId });
      const fourth = await seedBidPackage(harness, { projectId });
      await start(second.packageId); // step 1
      await start(third.packageId);
      await complete(third.packageId, 'PLAN_DOC', WORKER, [await doc()]);
      await advance(third.packageId, ADVANCER); // step 2
      await start(fourth.packageId);
      await post(fourth.packageId, 'hold', MANAGER, { reason: 'Chờ phê duyệt ngân sách' }); // on hold in step 1
      const tree = await treeOf(projectId);
      expect(tree.total.count).toBe(4);
      const node = (id: string): Node => tree.nodes.find((one) => one.id === id) as Node;
      expect(node('ROOT').count).toBe(4);
      expect(node('M:OPEN_BIDDING').count).toBe(4);
      expect(node('T:OPEN_BIDDING:NOT_STARTED').count).toBe(1);
      expect(node('S:OPEN_BIDDING:PLAN_STEP').count).toBe(2);
      expect(node('S:OPEN_BIDDING:PLAN_STEP:ON_HOLD').count).toBe(1);
      expect(node('S:OPEN_BIDDING:PLAN_STEP:ON_TRACK').count).toBe(1);
      expect(node('S:OPEN_BIDDING:APPROVE_STEP').count).toBe(1);
      expect(node('S:OPEN_BIDDING:APPROVE_STEP').path).toEqual(['ROOT', 'M:OPEN_BIDDING', 'S:OPEN_BIDDING:APPROVE_STEP']);
      expect(node('ROOT').value_vnd).toBe('400000000');
      expect(tree.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'S:OPEN_BIDDING:PLAN_STEP', to: 'S:OPEN_BIDDING:APPROVE_STEP', kind: 'ADVANCE', count: 1 }), expect.objectContaining({ from: 'S:OPEN_BIDDING:PLAN_STEP', to: 'S:OPEN_BIDDING:PLAN_STEP:ON_HOLD', kind: 'HOLD', count: 1 })]));
      for (const one of tree.nodes) {
        const packages = (await call('GET', `/package-workflows/process-tree/packages?project_id=${projectId}&node_id=${encodeURIComponent(one.id)}`, { member: MANAGER })).json.items as unknown[];
        expect(packages).toHaveLength(one.count);
      }
      // A caller who reads another branch sees none of it, not even a count.
      const hidden = await treeOf(projectId, ELSEWHERE_MANAGER);
      expect(hidden.total.count).toBe(0);
      expect((await call('GET', `/package-workflows/process-tree/packages?project_id=${projectId}&node_id=ROOT`, { member: ELSEWHERE_MANAGER })).json.items).toEqual([]);
      expect((await detail(second.packageId, ELSEWHERE_MANAGER)).status).toBe(404);
      expect((await call('GET', `/package-workflows/process-tree?project_id=${projectId}`, { member: NOBODY })).status).toBe(403);
      // A caller of another tenant reads nothing of tenant A.
      expect((await call('GET', `/package-workflows/process-tree?project_id=${projectId}`, { member: B_MANAGER, tenantId: TENANT_B })).json.total).toMatchObject({ count: 0 });
    });

    it('pages the packages of a node by code, filters the list, builds the board and refuses a node id or a filter that is not one', async () => {
      const first = await newPackage();
      const projectId = first.projectId;
      for (let index = 0; index < 2; index += 1) await start((await seedBidPackage(harness, { projectId })).packageId);
      await start(first.packageId);
      const page = await call('GET', `/package-workflows/process-tree/packages?project_id=${projectId}&node_id=S:OPEN_BIDDING:PLAN_STEP&limit=2`, { member: READER });
      expect(page.status).toBe(200);
      expect(page.json.items).toHaveLength(2);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await call('GET', `/package-workflows/process-tree/packages?project_id=${projectId}&node_id=S:OPEN_BIDDING:PLAN_STEP&limit=2&cursor=${page.json.next_cursor}`, { member: READER });
      expect(next.json.items).toHaveLength(1);
      expect(next.json.next_cursor).toBeNull();
      const codes = [...(page.json.items as Array<{ package_code: string }>), ...(next.json.items as Array<{ package_code: string }>)].map((one) => one.package_code);
      expect(new Set(codes).size).toBe(3);
      expect(codes).toEqual([...codes].sort());
      const list = await call('GET', `/package-workflows?project_id=${projectId}&step=PLAN_STEP`, { member: READER });
      expect(list.json.items).toHaveLength(3);
      expect((list.json.items as unknown[])[0]).toMatchObject({ status: 'IN_PROGRESS', step: { code: 'PLAN_STEP', order: 1, of: 3 }, actions: { advance: false, start: false } });
      expect(((await call('GET', `/package-workflows?project_id=${projectId}&no_owner=true`, { member: READER })).json.items as unknown[]).length).toBe(3);
      const board = (await call('GET', `/package-workflows/board?project_id=${projectId}&method=OPEN_BIDDING`, { member: MANAGER })).json as unknown as BoardBody;
      expect(board.columns.map((one: { code: string }) => one.code)).toEqual(['NOT_STARTED', 'PLAN_STEP', 'APPROVE_STEP', 'SIGN_STEP', 'COMPLETED', 'CANCELLED']);
      expect(board.columns[1]).toMatchObject({ count: 3, value_vnd: '300000000' });
      expect(board.columns[1]?.cards[0]?.actions.advance).toBe(true);
      for (const bad of ['node_id=nope', 'node_id=S:OPEN_BIDDING:PLAN_STEP:SLEEPING', 'node_id=']) expect((await call('GET', `/package-workflows/process-tree/packages?${bad}`, { member: READER })).status).toBe(422);
      expect((await call('GET', '/package-workflows?method=SPACESHIP', { member: READER })).status).toBe(422);
      expect((await call('GET', '/package-workflows?late_only=maybe', { member: READER })).status).toBe(422);
      expect((await call('GET', '/package-workflows/process-tree?from=2026-02-30', { member: READER })).status).toBe(422);
      expect((await call('GET', '/package-workflows?limit=0', { member: READER })).status).toBe(422);
    });

    it('tells the story of a package day by day from the history alone, with the filters, the summary and the planned-versus-actual bars', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      await complete(pkg.packageId, 'PLAN_DOC', WORKER, [await doc()]);
      await post(pkg.packageId, 'hold', MANAGER, { reason: 'Chờ ý kiến của cấp trên' });
      await post(pkg.packageId, 'resume', MANAGER, {});
      await advance(pkg.packageId, ADVANCER);
      const reply = await call('GET', `/procurement-packages/${pkg.packageId}/workflow/timeline`, { member: READER });
      expect(reply.status).toBe(200);
      const days = reply.json.days as Array<{ day: string; entries: Array<{ kind: string; actor: { id: string; name: string } | null; from_step: string | null; to_step: string | null; state_change: boolean }>; state_changes: number }>;
      expect(days).toHaveLength(1);
      expect(days[0]?.day).toBe(dayFromToday(0));
      const kinds = days[0]?.entries.map((entry) => entry.kind) ?? [];
      expect(kinds).toEqual(expect.arrayContaining(['START', 'CHECKLIST_DONE', 'HOLD', 'RESUME', 'STATE_CHANGE']));
      expect(days[0]?.entries.find((entry) => entry.kind === 'STATE_CHANGE')).toMatchObject({ from_step: 'PLAN_STEP', to_step: 'APPROVE_STEP', actor: { id: memberId(ADVANCER) } });
      expect(days[0]?.state_changes).toBe(4);
      const only = (await call('GET', `/procurement-packages/${pkg.packageId}/workflow/timeline?only_state_changes=true`, { member: READER })).json.days as Array<{ entries: Array<{ kind: string }> }>;
      expect(only[0]?.entries.map((entry) => entry.kind)).not.toContain('CHECKLIST_DONE');
      const byWorker = (await call('GET', `/procurement-packages/${pkg.packageId}/workflow/timeline?actor_id=${memberId(WORKER)}`, { member: READER })).json.days as Array<{ entries: Array<{ kind: string }> }>;
      expect(byWorker[0]?.entries.map((entry) => entry.kind)).toEqual(['CHECKLIST_DONE']);
      expect(((await call('GET', `/procurement-packages/${pkg.packageId}/workflow/timeline?from=${dayFromToday(1)}`, { member: READER })).json as { empty: boolean }).empty).toBe(true);
      expect(reply.json.summary).toEqual(expect.arrayContaining([expect.objectContaining({ step_code: 'PLAN_STEP', standard_working_days: 2 })]));
      const gantt = reply.json.gantt as Array<{ step_code: string; planned: { start_on: string } | null; actual: { start_on: string } | null }>;
      expect(gantt.map((bar) => bar.step_code)).toEqual(['PLAN_STEP', 'APPROVE_STEP', 'SIGN_STEP']);
      expect(gantt[0]?.planned?.start_on).toBe(dayFromToday(0));
      expect(gantt[2]?.actual).toBeNull();
      const whole = (await detail(pkg.packageId, READER)).json as unknown as WholeBody;
      expect(whole.actions).toMatchObject({ advance: false, work: false, start: false });
      expect(whole.workflow.links).toMatchObject({ petitions: { total: 0 }, result: null });
      expect((await call('GET', `/procurement-packages/${pkg.packageId}/workflow/timeline?order=sideways`, { member: READER })).status).toBe(422);
      const feed = (await call('GET', `/package-workflows/process-tree/feed?project_id=${pkg.projectId}&node_id=ROOT&limit=3`, { member: READER })).json.items as Array<{ package_code: string; entry: { state_change: boolean } }>;
      expect(feed.length).toBeGreaterThan(0);
      expect(feed.every((one) => one.entry.state_change && one.package_code === pkg.packageCode)).toBe(true);
    });

    it('gives the bottleneck statistics, the export file and the summary of the dashboard card; a failing source is not reported as none', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      await complete(pkg.packageId, 'PLAN_DOC', WORKER, [await doc()]);
      await advance(pkg.packageId, ADVANCER);
      const stats = (await call('GET', `/package-workflows/statistics?project_id=${pkg.projectId}&from=${dayFromToday(-1)}&to=${dayFromToday(1)}`, { member: READER })).json as unknown as StatisticsBody;
      expect(stats.steps).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'OPEN_BIDDING', step_code: 'PLAN_STEP', completed_visits: 1, median_days: 0, on_time_share: 1 }), expect.objectContaining({ step_code: 'APPROVE_STEP', open_visits: 1 })]));
      expect(stats.stuck[0]).toMatchObject({ package_id: pkg.packageId, step_code: 'APPROVE_STEP' });
      expect(stats.kpis).toMatchObject({ completed_visits: 1, on_time_share: 1 });
      const exported = (await call('GET', `/package-workflows/statistics/export?project_id=${pkg.projectId}&format=csv`, { member: READER })).json as unknown as ExportBody;
      const csv = Buffer.from(exported.content_base64, 'base64').toString('utf8');
      expect(exported.content_type).toContain('text/csv');
      expect(csv).toContain('PLAN_STEP');
      expect(csv).toContain('chưa được kiểm chứng');
      const xlsx = (await call('GET', `/package-workflows/statistics/export?project_id=${pkg.projectId}`, { member: READER })).json as unknown as ExportBody;
      expect(Buffer.from(xlsx.content_base64, 'base64').subarray(0, 2).toString()).toBe('PK');
      expect(xlsx.size_bytes).toBe(Buffer.from(xlsx.content_base64, 'base64').length);
      expect((await call('GET', '/package-workflows/statistics/export?format=pdf', { member: READER })).status).toBe(422);
      const summary = (await call('GET', `/package-workflows/summary?project_id=${pkg.projectId}`, { member: READER })).json as unknown as SummaryBody;
      expect(summary).toMatchObject({ total: 1, running: 1, late: 0, no_owner: 1, on_hold: 0 });
      expect(summary.top_steps).toEqual([expect.objectContaining({ node_id: 'S:OPEN_BIDDING:APPROVE_STEP', count: 1 })]);
    });
  });

  describe('the alerts of the monitoring', () => {
    it('raises PRC_NO_OWNER, PRC_STEP_OVERDUE and PRC_CHECKLIST_DUE from the tables of the workflow, each with its consequence, and none for a package outside the scope', async () => {
      const pkg = await newPackage();
      await start(pkg.packageId);
      // The step fell due three days ago and the required item two days ago; nobody holds the package.
      await seedAs(harness, [
        [`update machvon.package_step set entered_on = $2::date, due_on = $3::date where package_id = $1::uuid`, [pkg.packageId, dayFromToday(-8), dayFromToday(-3)]],
        [`update machvon.package_checklist_item set due_on = $2::date where package_id = $1::uuid and item_code = 'PLAN_DOC'`, [pkg.packageId, dayFromToday(-2)]],
      ]);
      const tenants = harness.tenants as TenantDatabase;
      const everything = { sql: 'true', params: [] as unknown[] };
      const nothing = { sql: 'false', params: [] as unknown[] };
      const collect = (scope: { sql: string; params: unknown[] }) =>
        tenants.withTenant(contextFor(TENANT_A, memberId(MANAGER)), (tx) =>
          new HomeWorkStore().collect(tx, { membershipId: memberId(MANAGER), now: new Date(), today: dayFromToday(0), view: 'scope', unitScope: () => scope, projectScope: () => scope, rules: DEFAULT_SEVERITY_RULES, mode: 'rows' }),
        );
      const seen = await collect(everything);
      const mine = seen.rows.filter((item) => item.target.id === pkg.packageId);
      expect(mine.map((item) => item.kind).sort()).toEqual(['PRC_CHECKLIST_DUE', 'PRC_NO_OWNER', 'PRC_STEP_OVERDUE']);
      for (const item of mine) {
        expect(item.consequence).not.toBeNull();
        expect(item.severity).toBe('ACTION');
      }
      expect(seen.unavailableSources).not.toContain('PROCUREMENT_WORKFLOW');
      const hidden = await collect(nothing);
      expect(hidden.rows.filter((item) => item.target.id === pkg.packageId)).toEqual([]);
    });
  });
});
