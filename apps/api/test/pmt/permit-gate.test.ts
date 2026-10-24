import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { pmtModule } from '../../src/modules/pmt';
import { PermitGateController } from '../../src/modules/pmt/gate.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // permit.gate.manage on the whole tenant
const SUBTREE_MANAGER = 2; // permit.gate.manage on the department only
const READER = 3; // permit.read on the department (unit 2)
const TENANT_READER = 4; // permit.read on the whole tenant
const OTHER_BRANCH_READER = 5; // permit.read on another branch (unit 3)
const NOBODY = 6;
const B_MANAGER = 1; // of tenant B
const FAMILY = 0x97;
const DAY_MS = 86_400_000;
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);

const PROJECT = id(FAMILY, 1);
const PROJECT_BRANCH = id(FAMILY, 2);
const FOREIGN_PROJECT = id(FAMILY, 3);
const DOSSIER = id(FAMILY, 11);
const TYPE_BUILDING = id(FAMILY, 31);
const TYPE_ENV = id(FAMILY, 32);
const FOREIGN_TYPE = id(FAMILY, 33);
const DOCUMENT = id(FAMILY, 41);
const DOCUMENT_ROW = id(FAMILY, 42);
const BASIS = 'Luật Xây dựng 135/2025, điều 41';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the gate rules and the evaluation of the gates over HTTP (ST-PMT-004)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const rule = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    gate_code: 'START_CONSTRUCTION',
    project_milestone_code: 'START_CONSTRUCTION',
    permit_type_id: TYPE_BUILDING,
    requirement: 'VALID_OR_EXEMPT',
    applies_to_rule: {},
    legal_basis: BASIS,
    effective_from: '2026-01-01',
    ...overrides,
  });
  const publish = (body: Record<string, unknown>, member = MANAGER, options: { key?: string; tenantId?: string } = {}) =>
    call('POST', '/permit-gate-rules', { member, body, ...(options.key === undefined ? {} : { key: options.key }), ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }) });
  const clear = () => harness.owner(TENANT_A, [['delete from machvon.permit_gate_rule', []]]);
  const itemsOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const gatesOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.gates as Array<Record<string, unknown>>;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: '/u1/' },
        { n: 2, path: '/u1/u2/', parent: 1 },
        { n: 3, path: '/u3/' },
      ]);
    }
    for (const n of [MANAGER, SUBTREE_MANAGER, READER, TENANT_READER, OTHER_BRANCH_READER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, B_MANAGER, 1);
    await harness.seedRole(TENANT_A, 1, 'GATE_MANAGER', ['permit.gate.manage', 'permit.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'PERMIT_READER', ['permit.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'GATE_MANAGER', ['permit.gate.manage', 'permit.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: SUBTREE_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 3, member: READER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 4, member: TENANT_READER, role: 2, kind: 'TENANT' },
      { n: 5, member: OTHER_BRANCH_READER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(3)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      const project = (tenant: string, projectId: string, code: string, owner: number) =>
        admin.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, 'B')`,
          [tenant, projectId, code, `Name of ${code}`, unitId(owner), unitId(1), id(FAMILY, 90)],
        );
      await project(TENANT_A, PROJECT, 'PRJ-G-001', 2);
      await project(TENANT_A, PROJECT_BRANCH, 'PRJ-G-002', 3);
      await project(TENANT_B, FOREIGN_PROJECT, 'PRJ-G-FOREIGN', 2);
      for (const [typeId, code, tenant] of [[TYPE_BUILDING, 'BUILDING', TENANT_A], [TYPE_ENV, 'ENV_PERMIT', TENANT_A], [FOREIGN_TYPE, 'BUILDING', TENANT_B]] as const) {
        await admin.query(
          `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
           values ($1, $2, $3, $4, 'OTHER', 'The authority', 'Fixture legal basis', date '2025-01-01', '{}'::jsonb, 'PUBLISHED', $5, $5)`,
          [tenant, typeId, code, `Name of ${code}`, memberId(MANAGER)],
        );
      }
      await admin.query(
        `insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5)`,
        [TENANT_A, DOSSIER, PROJECT, unitId(2), memberId(MANAGER)],
      );
      await admin.query(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'GP', 'Permit scan', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT_ROW, memberId(MANAGER)]);
      await admin.query(
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/pmt/a.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, DOCUMENT, DOCUMENT_ROW],
      );
      // The project has its building permit, valid today; it has none of the environmental permit.
      await admin.query(
        `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, permit_type_code, status, permit_no, authority_name, issued_on, valid_from, valid_until, document_version_id, is_required, created_by, updated_by)
         values ($1, $2, $3, $4, 'BUILDING', 'ISSUED', 'GP-GATE-1', 'Department of Construction', $5::date, $5::date, $6::date, $7, true, $8, $8)`,
        [TENANT_A, id(FAMILY, 21), DOSSIER, TYPE_BUILDING, inDays(-30), inDays(300), DOCUMENT, memberId(MANAGER)],
      );
    } finally {
      await admin.end();
    }
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PermitGateController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  beforeEach(async () => {
    await clear();
  });

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of PMT', () => {
    expect(pmtModule.controllers).toContain(PermitGateController);
  });

  describe('publishPermitGateRule', () => {
    it('publishes a rule: the next one takes over, one audit row with the legal basis and pmt.gate_rule.published.v1 once, also when the key is replayed', async () => {
      const key = `gate-${randomUUID()}`;
      const first = await publish(rule(), MANAGER, { key });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'PUBLISHED', resource_version: 1 });
      const replay = await publish(rule(), MANAGER, { key });
      expect([replay.status, replay.json.operation_id]).toEqual([200, first.json.operation_id]);
      const ruleId = first.json.resource_id as string;
      const audit = await rows<{ diff: Record<string, unknown>; actor_id: string }>("select safe_diff as diff, actor_id from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.gate_rule_published'", [ruleId]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: memberId(MANAGER), diff: { gate_code: 'START_CONSTRUCTION', permit_type_code: 'BUILDING', requirement: 'VALID_OR_EXEMPT', revision: 1, legal_basis: BASIS, effective_from: '2026-01-01' } });
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.gate_rule.published.v1'", [ruleId]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ gate_rule_id: ruleId, gate_code: 'START_CONSTRUCTION', permit_type_code: 'BUILDING', revision: 1, superseded_gate_rule_id: null });
      const second = await publish(rule({ effective_from: inDays(30), legal_basis: 'Nghị định 217/2026, điều 12', requirement: 'VALID_PERMIT' }));
      expect(second.status).toBe(200);
      const stored = await rows<{ revision: number; status: string; effective_until: string | null }>("select revision, status, effective_until::text from machvon.permit_gate_rule order by revision", []);
      expect(stored.map((row) => [row.revision, row.status])).toEqual([
        [1, 'RETIRED'],
        [2, 'PUBLISHED'],
      ]);
      expect(stored[0]?.effective_until).toBe(inDays(29));
    });

    it('refuses a rule that overlaps (409 GATE_RULE_OVERLAP), a blank legal basis (422 LEGAL_BASIS_REQUIRED), a permit type of another tenant (422) and a body that is not one (400)', async () => {
      expect((await publish(rule({ effective_from: inDays(10), effective_until: inDays(100) }))).status).toBe(200);
      const overlapping = await publish(rule({ effective_from: inDays(50) }));
      expect([overlapping.status, overlapping.json.code]).toEqual([409, 'GATE_RULE_OVERLAP']);
      const blank = await publish(rule({ gate_code: 'HANDOVER', legal_basis: '   ' }));
      expect([blank.status, blank.json.code]).toEqual([422, 'LEGAL_BASIS_REQUIRED']);
      expect((await publish(rule({ gate_code: 'HANDOVER', permit_type_id: FOREIGN_TYPE }))).status).toBe(422);
      expect((await publish(rule({ gate_code: 'NOT_A_GATE' }))).status).toBe(422);
      expect((await publish({ ...rule(), legal_basis: undefined })).status).toBe(400);
      expect((await publish({ ...rule(), unknown: true })).status).toBe(400);
      expect((await rows('select 1 from machvon.permit_gate_rule', [])).length).toBe(1);
    });

    it('is for those who manage the gates on the whole tenant: a manager of one subtree, a reader and a stranger get 403, and another tenant never touches the rules of this one', async () => {
      for (const member of [SUBTREE_MANAGER, READER, NOBODY]) expect([member, (await publish(rule(), member)).status]).toEqual([member, 403]);
      expect((await rows('select 1 from machvon.permit_gate_rule', [])).length).toBe(0);
      const foreign = await publish(rule({ permit_type_id: FOREIGN_TYPE }), B_MANAGER, { tenantId: TENANT_B });
      expect(foreign.status).toBe(200);
      expect((await rows('select 1 from machvon.permit_gate_rule', [])).length).toBe(0);
      await harness.owner(TENANT_B, [['delete from machvon.permit_gate_rule', []]]);
    });
  });

  describe('retirePermitGateRule', () => {
    it('ends a rule: audit and pmt.gate_rule.retired.v1 once; asking for the end it has is audited and changes nothing; a rule of another tenant is not there', async () => {
      const published = await publish(rule());
      const ruleId = published.json.resource_id as string;
      const ended = await call('POST', `/permit-gate-rules/${ruleId}/retire`, { member: MANAGER, body: { effective_until: inDays(60) } });
      expect(ended.status).toBe(200);
      expect(ended.json).toMatchObject({ status: 'RETIRED', resource_version: 2 });
      const again = await call('POST', `/permit-gate-rules/${ruleId}/retire`, { member: MANAGER, body: { effective_until: inDays(60) } });
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ resource_version: 2 });
      const audits = await rows<{ diff: Record<string, unknown> }>("select safe_diff as diff from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.gate_rule_retired' order by occurred_at", [ruleId]);
      expect(audits.map((entry) => entry.diff.changed)).toEqual([true, false]);
      const events = await rows('select 1 from machvon.outbox_event where aggregate_id = $1::uuid and type = $2', [ruleId, 'pmt.gate_rule.retired.v1']);
      expect(events).toHaveLength(1);
      const later = await call('POST', `/permit-gate-rules/${ruleId}/retire`, { member: MANAGER, body: { effective_until: inDays(90) } });
      expect(later.status).toBe(422);
      expect((await call('POST', `/permit-gate-rules/${ruleId}/retire`, { member: B_MANAGER, tenantId: TENANT_B, body: { effective_until: inDays(10) } })).status).toBe(404);
      for (const member of [SUBTREE_MANAGER, READER, NOBODY]) expect((await call('POST', `/permit-gate-rules/${ruleId}/retire`, { member, body: { effective_until: inDays(10) } })).status).toBe(403);
    });
  });

  describe('get_resources_permit_gate_rule', () => {
    it('shows every version of the rules to anyone who may read permits, whatever the scope of the grant, newest first, and none of another tenant', async () => {
      await publish(rule());
      await publish(rule({ gate_code: 'HANDOVER', requirement: 'SUBMITTED_ONLY', permit_type_id: TYPE_ENV }));
      for (const member of [MANAGER, READER, TENANT_READER, OTHER_BRANCH_READER]) {
        const reply = await call('GET', '/resources/permit_gate_rule', { member });
        expect([member, reply.status]).toEqual([member, 200]);
        expect(itemsOf(reply).map((item) => item.gate_code)).toEqual(['HANDOVER', 'START_CONSTRUCTION']);
      }
      const first = itemsOf(await call('GET', '/resources/permit_gate_rule', { member: TENANT_READER }))[0] as Record<string, unknown>;
      expect(first).toEqual({
        id: expect.any(String),
        gate_code: 'HANDOVER',
        project_milestone_code: 'START_CONSTRUCTION',
        permit_type_id: TYPE_ENV,
        permit_type_code: 'ENV_PERMIT',
        requirement: 'SUBMITTED_ONLY',
        applies_to_rule: {},
        legal_basis: BASIS,
        effective_from: '2026-01-01',
        effective_until: null,
        revision: 1,
        status: 'PUBLISHED',
        version: 1,
      });
      expect((await call('GET', '/resources/permit_gate_rule', { member: NOBODY })).status).toBe(403);
      expect(itemsOf(await call('GET', '/resources/permit_gate_rule', { member: B_MANAGER, tenantId: TENANT_B }))).toEqual([]);
      const page = await call('GET', '/resources/permit_gate_rule?limit=1', { member: TENANT_READER });
      expect(itemsOf(page)).toHaveLength(1);
      expect(typeof page.json.next_cursor).toBe('string');
    });
  });

  describe('evaluatePermitGates', () => {
    it('answers BLOCKED while a permit the rule asks for is missing, PASSED once it is there, with the legal basis, the permit that satisfies and the rules that block (AC-ST-PMT-004-1)', async () => {
      await publish(rule({ requirement: 'VALID_PERMIT' }));
      await publish(rule({ permit_type_id: TYPE_ENV, requirement: 'VALID_PERMIT', legal_basis: 'Luật Bảo vệ môi trường 2020, điều 41' }));
      const blocked = await call('GET', `/projects/${PROJECT}/permit-gates?gate_code=START_CONSTRUCTION`, { member: READER });
      expect(blocked.status).toBe(200);
      expect(blocked.json).toMatchObject({ project_id: PROJECT, as_of: inDays(0) });
      const [gate] = gatesOf(blocked);
      expect(gate).toMatchObject({ gate_code: 'START_CONSTRUCTION', status: 'BLOCKED' });
      const verdicts = gate?.rules as Array<Record<string, unknown>>;
      expect(verdicts.map((verdict) => [verdict.permit_type_code, verdict.outcome])).toEqual([
        ['BUILDING', 'SATISFIED'],
        ['ENV_PERMIT', 'BLOCKING'],
      ]);
      expect(verdicts[0]).toMatchObject({ legal_basis: BASIS, permit: { permit_no: 'GP-GATE-1', status: 'ISSUED' }, waiver: null, project_milestone_code: 'START_CONSTRUCTION' });
      expect(verdicts[1]).toMatchObject({ legal_basis: 'Luật Bảo vệ môi trường 2020, điều 41', permit: null });
      // The building permit alone passes: the environmental rule is for another gate.
      await clear();
      await publish(rule({ requirement: 'VALID_PERMIT' }));
      const passed = await call('GET', `/projects/${PROJECT}/permit-gates?gate_code=START_CONSTRUCTION`, { member: TENANT_READER });
      expect(gatesOf(passed)[0]).toMatchObject({ status: 'PASSED' });
      // As of a day before the permit began, the same rule blocks.
      const before = await call('GET', `/projects/${PROJECT}/permit-gates?gate_code=START_CONSTRUCTION&as_of=${inDays(-60)}`, { member: READER });
      expect(gatesOf(before)[0]).toMatchObject({ status: 'BLOCKED' });
      expect(before.json.as_of).toBe(inDays(-60));
    });

    it('reads all five gates when none is named, and a gate with no rule in force passes', async () => {
      await publish(rule({ gate_code: 'HANDOVER', permit_type_id: TYPE_ENV, requirement: 'VALID_PERMIT' }));
      const all = await call('GET', `/projects/${PROJECT}/permit-gates`, { member: READER });
      expect(gatesOf(all).map((gate) => [gate.gate_code, gate.status])).toEqual([
        ['CONTRACT_ACTIVATION', 'PASSED'],
        ['START_CONSTRUCTION', 'PASSED'],
        ['ACCEPTANCE_COMPLETION', 'PASSED'],
        ['HANDOVER', 'BLOCKED'],
        ['ADVANCE_DISBURSEMENT', 'PASSED'],
      ]);
    });

    it('does not know a project outside the scope of the caller or of another tenant (404), and refuses a caller without permit.read (403), a gate or a day that is not one (422)', async () => {
      expect((await call('GET', `/projects/${PROJECT_BRANCH}/permit-gates`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/projects/${PROJECT_BRANCH}/permit-gates`, { member: OTHER_BRANCH_READER })).status).toBe(200);
      expect((await call('GET', `/projects/${PROJECT}/permit-gates`, { member: OTHER_BRANCH_READER })).status).toBe(404);
      expect((await call('GET', `/projects/${FOREIGN_PROJECT}/permit-gates`, { member: TENANT_READER })).status).toBe(404);
      expect((await call('GET', `/projects/${randomUUID()}/permit-gates`, { member: TENANT_READER })).status).toBe(404);
      expect((await call('GET', `/projects/${PROJECT}/permit-gates`, { member: B_MANAGER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/projects/${PROJECT}/permit-gates`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/projects/${PROJECT}/permit-gates?gate_code=NOT_A_GATE`, { member: READER })).status).toBe(422);
      expect((await call('GET', `/projects/${PROJECT}/permit-gates?as_of=yesterday`, { member: READER })).status).toBe(422);
      expect((await call('GET', `/projects/${PROJECT}/permit-gates?as_of=2026-02-30`, { member: READER })).status).toBe(422);
      expect((await call('GET', `/projects/not-an-id/permit-gates`, { member: READER })).status).toBe(422);
    });
  });
});
