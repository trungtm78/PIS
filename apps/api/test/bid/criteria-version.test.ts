import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { bidModule } from '../../src/modules/bid';
import { CriteriaVersionController, CriteriaVersionReadsController } from '../../src/modules/bid/criteria.controller';
import { MODULES } from '../../src/modules/registry';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const PLANNER = 1; // bid.criteria.manage, criteria_version.read over the tenant
const APPROVER = 2; // bid.criteria.approve, criteria_version.read over the tenant
const READER = 3; // criteria_version.read
const NOBODY = 4;
const DEPARTMENT_PLANNER = 5; // bid.criteria.manage, criteria_version.read over the department
const ELSEWHERE_PLANNER = 6; // the same over another branch
const SOLO = 7; // bid.criteria.manage and bid.criteria.approve over the tenant: may do both, never on the same version
const B_PLANNER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x95;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Item {
  id: string;
  status: string;
  revision: number;
  package: { id: string; code: string; project: { id: string } };
  criteria: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

const scored = (code: string, weight: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  code,
  name: `Criterion ${code}`,
  kind: 'SCORED',
  weight,
  max_score: 10,
  threshold: 5,
  mandatory: false,
  required_evidence: ['Audited statements'],
  ...extra,
});
const passFail = (code: string): Record<string, unknown> => ({ code, name: `Requirement ${code}`, kind: 'PASS_FAIL', mandatory: true });
const valid = (): Record<string, unknown> => ({ criteria: [scored('C1', 40), scored('C2', 30), scored('C3', 20), scored('C4', 10), passFail('R1')] });

describe('criteria versions commands and reads (ST-BID-003)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
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
  const itemsOf = (reply: Reply): Item[] => reply.json.items as Item[];

  async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // Foreign keys to the modules this story only reads are out of scope here, so the superuser seeds with them switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  interface Seeded {
    projectId: string;
    packageId: string;
  }

  /** A project of the unit with one package of an approved plan. */
  async function pack(options: { unit?: number; status?: string; tenant?: string } = {}): Promise<Seeded> {
    counter += 1;
    const tenant = options.tenant ?? TENANT_A;
    const [projectId, packageId] = [randomUUID(), randomUUID()];
    await seedAs([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Bridge project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, projectId, `PRJ-CV-${counter}`, unitId(options.unit ?? DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      ],
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title)
         values ($1, $2, $3, $4, 1000, 'OPEN_BIDDING', 1, $5, 'Construction package')`,
        [tenant, packageId, projectId, `GT-CV-${counter}`, options.status ?? 'PLANNED'],
      ],
    ]);
    return { projectId, packageId };
  }

  const body = (seeded: Seeded, criteria: unknown = valid(), extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    package_id: seeded.packageId,
    criteria_json: criteria,
    legal_basis: 'Luật Đấu thầu 22/2023/QH15',
    ...extra,
  });
  const create = (member: number, payload: Record<string, unknown>, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', '/criteria-versions', { member, body: payload, ...options });
  const approve = (member: number, criteriaId: string, version: number | string, tenantId?: string): Promise<Reply> =>
    call('POST', `/criteria-versions/${criteriaId}/approval`, { member, ifMatch: `"${version}"`, body: {}, ...(tenantId === undefined ? {} : { tenantId }) });
  const events = async (criteriaId: string): Promise<string[]> => (await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [criteriaId])).map((event) => event.type);
  const auditActions = async (criteriaId: string): Promise<string[]> => (await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [criteriaId])).map((event) => event.action);
  const statusOf = async (criteriaId: string): Promise<string | undefined> => (await rows<{ status: string }>('select status from machvon.criteria_version where id = $1', [criteriaId]))[0]?.status;
  const countFor = async (packageId: string): Promise<number> => (await rows('select 1 from machvon.criteria_version where package_id = $1', [packageId])).length;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [PLANNER, APPROVER, READER, NOBODY, DEPARTMENT_PLANNER, ELSEWHERE_PLANNER, SOLO]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'CRITERIA_MANAGER', ['bid.criteria.manage', 'criteria_version.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'CRITERIA_APPROVER', ['bid.criteria.approve', 'criteria_version.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'CRITERIA_READER', ['criteria_version.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'CRITERIA_SOLO', ['bid.criteria.manage', 'bid.criteria.approve', 'criteria_version.read'], 60);
    await harness.seedRole(TENANT_B, 1, 'CRITERIA_MANAGER', ['bid.criteria.manage', 'bid.criteria.approve', 'criteria_version.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: DEPARTMENT_PLANNER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 5, member: ELSEWHERE_PLANNER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 6, member: SOLO, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PLANNER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CriteriaVersionController, CriteriaVersionReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered once in the module registry with the controllers of the criteria', () => {
    expect(bidModule.code).toBe('BID');
    expect(bidModule.controllers).toEqual(expect.arrayContaining([CriteriaVersionController, CriteriaVersionReadsController]));
    expect(MODULES.filter((module) => module.code === 'BID')).toHaveLength(1);
  });

  describe('drafting and approving', () => {
    it('drafts a version, refuses its maker as approver and one without the right, and approves it with bid.criteria.approved.v1 (AC-ST-BID-003-1, -2)', async () => {
      const seeded = await pack();
      const made = await create(SOLO, body(seeded));
      expect(made.status).toBe(200);
      expect(made.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const criteriaId = idOf(made);
      expect(await rows('select revision, weights_sum, status, created_by, approved_by from machvon.criteria_version where id = $1', [criteriaId])).toEqual([
        { revision: 1, weights_sum: 100, status: 'DRAFT', created_by: memberId(SOLO), approved_by: null },
      ]);

      const own = await approve(SOLO, criteriaId, 1);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const noRight = await approve(PLANNER, criteriaId, 1);
      expect([noRight.status, noRight.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const stale = await approve(APPROVER, criteriaId, 5);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect(await statusOf(criteriaId)).toBe('DRAFT');

      const done = await approve(APPROVER, criteriaId, 1);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });
      expect(await rows('select status, approved_by from machvon.criteria_version where id = $1', [criteriaId])).toEqual([{ status: 'APPROVED', approved_by: memberId(APPROVER) }]);
      expect(await events(criteriaId)).toEqual(['bid.criteria.drafted.v1', 'bid.criteria.approved.v1']);
      const approvedEvent = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'bid.criteria.approved.v1'", [criteriaId]);
      expect(approvedEvent[0]?.payload).toMatchObject({ criteria_version_id: criteriaId, package_id: seeded.packageId, revision: 1, version: 2, weights_sum: 100, criteria_count: 5, superseded_id: null, actor_id: memberId(APPROVER) });
      expect(await auditActions(criteriaId)).toEqual(['criteria_version.drafted', 'criteria_version.approved']);
      expect(JSON.stringify(approvedEvent[0]?.payload)).not.toContain('Audited statements');

      // Approving again is refused; once an analysis run used the version it is locked by the run, and a revision is the only way forward.
      const again = await approve(APPROVER, criteriaId, 2);
      expect([again.status, again.json.code]).toEqual([409, 'CRITERIA_STATE_INVALID']);
      await seedAs([
        [
          `insert into machvon.analysis_run (tenant_id, id, proposal_id, criteria_version_id, profile_version_id, input_hash, status, budget_reservation_id)
           values ($1, $2, $3, $4, $5, repeat('b', 64), 'COMPLETED', $6)`,
          [TENANT_A, randomUUID(), randomUUID(), criteriaId, randomUUID(), randomUUID()],
        ],
      ]);
      const locked = await approve(APPROVER, criteriaId, 2);
      expect([locked.status, locked.json.code]).toEqual([409, 'CRITERIA_LOCKED_BY_RUN']);
      const next = await create(PLANNER, body(seeded, { criteria: [scored('C1', 60), scored('C2', 40)] }));
      expect(next.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const replaced = await approve(APPROVER, idOf(next), 1);
      expect(replaced.json).toMatchObject({ status: 'APPROVED' });
      expect(await statusOf(criteriaId)).toBe('SUPERSEDED');
      expect(await rows('select revision from machvon.criteria_version where id = $1', [idOf(next)])).toEqual([{ revision: 2 }]);
    });

    it('takes the place of the draft in work with the next revision', async () => {
      const seeded = await pack();
      const first = await create(PLANNER, body(seeded));
      const second = await create(PLANNER, body(seeded, { criteria: [passFail('R1')] }));
      expect(second.status).toBe(200);
      expect(await statusOf(idOf(first))).toBe('SUPERSEDED');
      expect(await statusOf(idOf(second))).toBe('DRAFT');
      expect(await rows('select weights_sum from machvon.criteria_version where id = $1', [idOf(second)])).toEqual([{ weights_sum: null }]);
      expect((await rows<{ diff: Record<string, unknown> }>("select safe_diff as diff from machvon.audit_event where resource_id = $1 and action = 'criteria_version.drafted'", [idOf(second)]))[0]?.diff).toMatchObject({
        revision: 2,
        replaced_draft_id: idOf(first),
        weights_sum: null,
        criteria_count: 1,
      });
    });

    it('answers a repeated request with the same key with the first answer and writes it once', async () => {
      const seeded = await pack();
      const key = `key-${randomUUID()}`;
      const first = await create(PLANNER, body(seeded), { key });
      const replay = await create(PLANNER, body(seeded), { key });
      expect(replay.json.resource_id).toBe(first.json.resource_id);
      expect(await countFor(seeded.packageId)).toBe(1);
    });

    it('refuses weights of 30/30/20/10 with their sum, and saves nothing (AC-ST-BID-003-1)', async () => {
      const seeded = await pack();
      const reply = await create(PLANNER, body(seeded, { criteria: [scored('C1', 30), scored('C2', 30), scored('C3', 20), scored('C4', 10)] }));
      expect([reply.status, reply.json.code]).toEqual([422, 'CRITERIA_WEIGHT_INVALID']);
      expect(reply.json).toMatchObject({ weights_sum: 90, expected: 100 });
      expect(await countFor(seeded.packageId)).toBe(0);
    });

    it('refuses a criterion about a local director or the gender of the representative with the rule and its legal basis, and saves nothing (AC-ST-BID-003-3)', async () => {
      const seeded = await pack();
      const reply = await create(PLANNER, body(seeded, { criteria: [scored('C1', 50, { name: 'Giám đốc là người địa phương' }), scored('C2', 50, { name: 'Giới tính người đại diện' })] }));
      expect([reply.status, reply.json.code]).toEqual([422, 'PROHIBITED_CRITERION']);
      expect(reply.json).toMatchObject({ criterion_code: 'C1', rule: 'LOCAL_PRESENCE', category: 'REGION', legal_basis: expect.stringContaining('22/2023/QH15') });
      expect(await countFor(seeded.packageId)).toBe(0);
      expect(await events(seeded.packageId)).toEqual([]);
    });

    it('takes only the fields of the contract and criteria of the right shape', async () => {
      const seeded = await pack();
      for (const extra of [{ status: 'APPROVED' }, { approved_by: memberId(PLANNER) }, { revision: 9 }, { weights_sum: 100 }, { tenant_id: TENANT_B }]) {
        const reply = await create(PLANNER, body(seeded, valid(), extra));
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      const member = await create(PLANNER, body(seeded, { criteria: [{ ...passFail('R1'), weighting: 1 }] }));
      expect([member.status, member.json.code, member.json.detail]).toEqual([400, 'FIELD_NOT_ALLOWED', 'criteria_json.criteria.0.weighting']);
      const shape = await create(PLANNER, body(seeded, { criteria: [{ ...passFail('R1'), kind: 'RANKED' }] }));
      expect([shape.status, shape.json.code, shape.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'criteria_json.criteria.0.kind']);
      expect((await create(PLANNER, body(seeded, { criteria: [] }))).status).toBe(422);
      expect((await create(PLANNER, body(seeded, 'x'))).status).toBeGreaterThanOrEqual(400);
      expect((await create(PLANNER, body(seeded, valid(), { legal_basis: ' ' }))).status).toBe(422);
      expect((await create(PLANNER, { criteria_json: valid(), legal_basis: 'Luật Đấu thầu' })).status).toBe(400);
      expect(await countFor(seeded.packageId)).toBe(0);
    });

    it('refuses a package whose plan is still in work (409 PACKAGE_STATE_INVALID)', async () => {
      for (const status of ['DRAFT', 'IN_REVIEW', 'CANCELLED']) {
        const seeded = await pack({ status });
        const reply = await create(PLANNER, body(seeded));
        expect([reply.status, reply.json.code, reply.json.package_status]).toEqual([409, 'PACKAGE_STATE_INVALID', status]);
      }
    });

    it('needs the right to draft or to approve, over the project of the package', async () => {
      const seeded = await pack({ unit: DEPARTMENT });
      for (const member of [READER, APPROVER, NOBODY]) {
        const reply = await create(member, body(seeded));
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      const elsewhere = await create(ELSEWHERE_PLANNER, body(seeded));
      expect([elsewhere.status, elsewhere.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const foreign = await create(B_PLANNER, body(seeded), { tenantId: TENANT_B });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const own = await create(DEPARTMENT_PLANNER, body(seeded));
      expect(own.status).toBe(200);
      const made = idOf(own);
      expect([(await approve(ELSEWHERE_PLANNER, made, 1)).status, (await approve(B_PLANNER, made, 1, TENANT_B)).status]).toEqual([403, 404]);
      expect((await create(PLANNER, body({ ...seeded, packageId: randomUUID() }))).status).toBe(404);
      expect(await countFor(seeded.packageId)).toBe(1);
    });

    it('needs the version in If-Match to approve', async () => {
      const seeded = await pack();
      const made = await create(PLANNER, body(seeded));
      expect((await call('POST', `/criteria-versions/${idOf(made)}/approval`, { member: APPROVER, body: {} })).status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(idOf(made))).toBe('DRAFT');
    });
  });

  describe('the reads', () => {
    it('lists the versions newest first with the package and the criteria; the draft is for those who draft and approve (BID-04)', async () => {
      const seeded = await pack();
      const first = await create(PLANNER, body(seeded));
      await approve(APPROVER, idOf(first), 1);
      const second = await create(PLANNER, body(seeded, { criteria: [scored('C1', 100)] }));

      const circle = await call('GET', `/resources/criteria_version?package_id=${seeded.packageId}`, { member: PLANNER });
      expect(circle.status).toBe(200);
      expect(itemsOf(circle).map((item) => [item.id, item.revision, item.status])).toEqual([
        [idOf(second), 2, 'DRAFT'],
        [idOf(first), 1, 'APPROVED'],
      ]);
      const line = itemsOf(circle)[1];
      expect(line).toMatchObject({
        package: { id: seeded.packageId, project: { id: seeded.projectId } },
        weights_sum: 100,
        legal_basis: 'Luật Đấu thầu 22/2023/QH15',
        version: 2,
      });
      expect(line?.criteria.map((criterion) => criterion.code)).toEqual(['C1', 'C2', 'C3', 'C4', 'R1']);
      expect(line?.criteria[0]).toMatchObject({ kind: 'SCORED', weight: 40, max_score: 10, threshold: 5, mandatory: false, required_evidence: ['Audited statements'] });
      expect(line?.approved_at).toMatch(/Z$/);
      // Who made and who approved a version is in the audit trail, not in the list.
      expect(JSON.stringify(circle.json)).not.toContain(memberId(PLANNER));
      expect(JSON.stringify(circle.json)).not.toContain(memberId(APPROVER));

      const reader = await call('GET', `/resources/criteria_version?package_id=${seeded.packageId}`, { member: READER });
      expect(itemsOf(reader).map((item) => item.id)).toEqual([idOf(first)]);
      expect((await call('GET', `/resources/criteria_version/${idOf(second)}`, { member: READER })).status).toBe(404);
      const detail = await call('GET', `/resources/criteria_version/${idOf(second)}`, { member: APPROVER });
      expect(detail.status).toBe(200);
      expect(detail.json).toMatchObject({ id: idOf(second), status: 'DRAFT', revision: 2 });
    });

    it('filters by status, pages with a cursor and keeps to the scope and the tenant of the caller', async () => {
      const seeded = await pack({ unit: DEPARTMENT });
      const first = await create(PLANNER, body(seeded));
      await approve(APPROVER, idOf(first), 1);
      const second = await create(PLANNER, body(seeded, { criteria: [scored('C1', 100)] }));
      const drafts = await call('GET', `/resources/criteria_version?package_id=${seeded.packageId}&status=DRAFT`, { member: PLANNER });
      expect(itemsOf(drafts).map((item) => item.id)).toEqual([idOf(second)]);
      const page1 = await call('GET', `/resources/criteria_version?package_id=${seeded.packageId}&limit=1`, { member: PLANNER });
      expect(itemsOf(page1)).toHaveLength(1);
      expect(typeof page1.json.next_cursor).toBe('string');
      const page2 = await call('GET', `/resources/criteria_version?package_id=${seeded.packageId}&limit=1&cursor=${encodeURIComponent(page1.json.next_cursor as string)}`, { member: PLANNER });
      expect(itemsOf(page2).map((item) => item.id)).toEqual([idOf(first)]);
      expect(page2.json.next_cursor).toBeNull();

      expect(itemsOf(await call('GET', `/resources/criteria_version?package_id=${seeded.packageId}`, { member: ELSEWHERE_PLANNER }))).toEqual([]);
      expect(itemsOf(await call('GET', '/resources/criteria_version', { member: B_PLANNER, tenantId: TENANT_B }))).toEqual([]);
      expect((await call('GET', `/resources/criteria_version/${idOf(first)}`, { member: B_PLANNER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', '/resources/criteria_version', { member: NOBODY })).status).toBe(403);
      for (const query of ['status=OPEN', 'package_id=not-an-id', 'limit=0']) {
        expect((await call('GET', `/resources/criteria_version?${query}`, { member: PLANNER })).status).toBe(422);
      }
      expect((await call('GET', '/resources/criteria_version/not-an-id', { member: PLANNER })).status).toBeGreaterThanOrEqual(400);
    });
  });
});
