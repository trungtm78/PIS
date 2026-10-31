import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { qmsModule } from '../../src/modules/qms';
import { MaterialController, MaterialReadsController } from '../../src/modules/qms/material.controller';
import { NonconformanceController } from '../../src/modules/qms/nonconformance.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { asSuperuser } from '../../../../packages/db/test/support/ncr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb9;
const ROOT = 1;
const SUPERVISOR = 11; // material.manage, material.record: registers the samples and records the results
const LAB = 12; // material.record only
const NOBODY = 13;
const NARROW = 14; // the rights of the supervisor over another branch, material.manage over the tenant: sees the test and may not act on it
const ELSEWHERE = 15; // the rights of the supervisor over another branch and nothing else: does not see the test
const FOREIGN = 16; // a member of another tenant with every right over the materials of that tenant
const MEMBERS = [SUPERVISOR, LAB, NOBODY, NARROW, ELSEWHERE];
const OTHER_BRANCH = 5;
const DOCUMENT = id(FAMILY, 30);
const CLEAN = id(FAMILY, 31);
const PENDING = id(FAMILY, 32);
const TODAY = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the testing of materials over HTTP (ST-QMS-007, UAT-AC362)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';

  const tokenOf = (member: number, tenantId: string = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; key?: string; tenant?: string; version?: number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const stage = (sql: string, params: unknown[] = []): Promise<void> => asSuperuser(harness.database.adminUrl, sql, params);
  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const stored = async (testId: string) =>
    (
      await rows<{ status: string; version: string; result: string; tested_on: string | null; nonconformance_id: string | null; report_document_version_id: string | null; sampled_by: string; result_values: Record<string, unknown> }>(
        'select status, version::text, result, tested_on::text, nonconformance_id, report_document_version_id, sampled_by, result_values from machvon.material_test where id = $1::uuid',
        [testId],
      )
    )[0];
  const ncrOf = async (ncrId: string) =>
    (
      await rows<{ ncr_no: string; severity: string; source_kind: string; status: string; material_test_id: string | null; action_owner_id: string; title: string; due_at: string; blocks_acceptance: boolean; detected_on: string }>(
        'select ncr_no, severity, source_kind, status, material_test_id, action_owner_id, title, due_at::text, blocks_acceptance, detected_on::text from machvon.quality_nonconformance where id = $1::uuid',
        [ncrId],
      )
    )[0];

  interface Subject {
    contractId: string;
    projectId: string;
    boqItemId: string;
  }

  /** A contract being performed with one bill item. */
  async function subject(status = 'ACTIVE'): Promise<Subject> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const boqItemId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $8, 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000::numeric, $7, $7, date '2026-01-02', date '2026-01-03')`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, `HD-M-${String(counter).padStart(4, '0')}`, memberId(ROOT), status],
      ],
      [`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, $4, 'Concrete B02', 'M3', $5, $5)`, [TENANT_A, boqItemId, contractId, `BQ-${counter}`, memberId(ROOT)]],
    ]);
    return { contractId, projectId: line.projectId, boqItemId };
  }

  const register = (member: number, s: Subject, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', '/material-tests', {
      member,
      ...(key === undefined ? {} : { key }),
      body: { contract_id: s.contractId, sample_code: `BT-${randomUUID().slice(0, 8)}`, material_kind: 'Concrete B02', lab_name: 'Central laboratory', standard_ref: 'STD-BT-30', sampled_on: TODAY, ...overrides },
    });
  const record = (member: number, testId: string, version: number, overrides: Record<string, unknown> = {}) =>
    call('POST', `/material-tests/${testId}/result`, { member, version, body: { result: 'PASS', tested_on: TODAY, result_values: { strength_mpa: 31.2 }, report_document_version_id: CLEAN, ...overrides } });
  const registered = async (s: Subject, overrides: Record<string, unknown> = {}): Promise<string> => (await register(SUPERVISOR, s, overrides)).json.resource_id as string;

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, FOREIGN, ROOT);
    await harness.seedRole(TENANT_B, 601, 'QMS_MATERIAL', ['material.manage', 'material.record'], 60);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: FOREIGN, role: 601, kind: 'TENANT' }]);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'QMS_SUPERVISOR', ['material.manage', 'material.record', 'ncr.raise'], 40],
      [2, 'QMS_LAB', ['material.record'], 20],
      [3, 'QMS_MATERIAL_BRANCH', ['material.manage', 'material.record'], 30],
      [4, 'QMS_MATERIAL_READER', ['material.manage'], 10],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: SUPERVISOR, role: 101, kind: 'TENANT' },
      { n: 2, member: LAB, role: 102, kind: 'TENANT' },
      { n: 3, member: NARROW, role: 103, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
      { n: 4, member: NARROW, role: 104, kind: 'TENANT' },
      { n: 5, member: ELSEWHERE, role: 103, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    contractor = await seedContractor(harness);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(ROOT)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $4, 1, 'tenants/qms/lab-report.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $3, $4, 2, 'tenants/qms/pending.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN, PENDING, DOCUMENT],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [MaterialController, MaterialReadsController, NonconformanceController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the module of QMS', () => {
    expect(qmsModule.controllers).toEqual(expect.arrayContaining([MaterialController, MaterialReadsController]));
  });

  describe('registerMaterialTest', () => {
    it('registers a sample against a contract being performed, with its audit row and its event, answering the same key once', async () => {
      const s = await subject();
      const send = () => register(SUPERVISOR, s, { sample_code: 'BT-0601', boq_item_id: s.boqItemId }, 'register-once-for-this-key');
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'REGISTERED', resource_version: 1 } });
      expect(await send()).toEqual(first);
      const testId = first.json.resource_id as string;
      expect(await rows('select id from machvon.material_test where contract_id = $1::uuid', [s.contractId])).toHaveLength(1);
      expect(await stored(testId)).toMatchObject({ status: 'REGISTERED', version: '1', result: 'PENDING', tested_on: null, nonconformance_id: null, sampled_by: memberId(SUPERVISOR) });
      expect((await audits(testId, 'material_test.registered'))[0]).toMatchObject({
        actor_id: memberId(SUPERVISOR),
        safe_diff: { contract_id: s.contractId, project_id: s.projectId, sample_code: 'BT-0601', material_kind: 'Concrete B02', standard_ref: 'STD-BT-30', result: 'PENDING', from_status: null, to_status: 'REGISTERED' },
      });
      expect((await events(testId, 'qms.material_test.registered.v1'))[0]?.payload).toMatchObject({ material_test_id: testId, sample_code: 'BT-0601', status: 'REGISTERED', version: 1, actor_id: memberId(SUPERVISOR) });
    });

    it('UAT-AC362: refuses a sample code used before in the contract, and takes it in another contract', async () => {
      const s = await subject();
      expect((await register(SUPERVISOR, s, { sample_code: 'BT-0601' })).status).toBe(200);
      expect(await register(SUPERVISOR, s, { sample_code: 'BT-0601' })).toMatchObject({ status: 409, json: { code: 'SAMPLE_CODE_DUPLICATE' } });
      expect(await rows('select id from machvon.material_test where contract_id = $1::uuid', [s.contractId])).toHaveLength(1);
      expect((await register(SUPERVISOR, await subject(), { sample_code: 'BT-0601' })).status).toBe(200);
    });

    it('refuses a contract that is not being performed, a bill item of another contract, a day in the future and what is badly formed', async () => {
      const draft = await subject('DRAFT');
      expect(await register(SUPERVISOR, draft)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
      const s = await subject();
      const other = await subject();
      expect(await register(SUPERVISOR, s, { boq_item_id: other.boqItemId })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'boq_item_id', reason: 'NOT_IN_CONTRACT' } });
      expect(await register(SUPERVISOR, s, { sampled_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'sampled_on', reason: 'IN_THE_FUTURE' } });
      for (const [field, extra] of [
        ['sample_code', { sample_code: '   ' }],
        ['sample_code', { sample_code: 'x'.repeat(201) }],
        ['sampled_on', { sampled_on: '2026-02-30' }],
      ] as const) {
        const reply = await register(SUPERVISOR, s, extra);
        expect([reply.status, reply.json.code, reply.json.detail ?? reply.json.field]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      expect(await register(SUPERVISOR, s, { status: 'ACCEPTED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect((await register(SUPERVISOR, s, { contract_id: undefined })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('recordMaterialTestResult (AC-ST-QMS-007-1, UAT-AC362)', () => {
    it('UAT-AC362: refuses a failed result with no report, then takes it with the report and raises one major non-conformance of the test', async () => {
      const s = await subject();
      const testId = await registered(s, { sample_code: 'BT-0601' });
      const without = await call('POST', `/material-tests/${testId}/result`, { member: SUPERVISOR, version: 1, body: { result: 'FAIL', tested_on: TODAY, result_values: { strength_mpa: 18.5 } } });
      expect(without.status).toBeGreaterThanOrEqual(400);
      // The report is required by the shape of the request, before any rule of the test is judged.
      expect(['VALIDATION_FAILED', 'INVALID_REQUEST']).toContain(without.json.code);
      expect(await stored(testId)).toMatchObject({ status: 'REGISTERED', version: '1', result: 'PENDING', nonconformance_id: null });
      expect(await rows('select id from machvon.quality_nonconformance where contract_id = $1::uuid', [s.contractId])).toEqual([]);

      const done = await record(SUPERVISOR, testId, 1, { result: 'FAIL', result_values: { strength_mpa: 18.5, unit: 'MPa' } });
      expect(done).toMatchObject({ status: 200, json: { status: 'RESULT_RECORDED', resource_version: 2 } });
      const test = await stored(testId);
      expect(test).toMatchObject({ status: 'RESULT_RECORDED', version: '2', result: 'FAIL', tested_on: TODAY, report_document_version_id: CLEAN, result_values: { strength_mpa: 18.5, unit: 'MPa' } });
      expect(test?.nonconformance_id).not.toBeNull();
      const ncr = await ncrOf(test?.nonconformance_id as string);
      expect(ncr).toMatchObject({ ncr_no: 'NCR-001', severity: 'MAJOR', source_kind: 'MATERIAL_TEST', status: 'OPEN', material_test_id: testId, action_owner_id: memberId(SUPERVISOR), blocks_acceptance: false, detected_on: TODAY });
      expect(ncr?.title).toBe('Material test failed: BT-0601');
      expect(Date.parse(ncr?.due_at ?? '') - Date.now()).toBeGreaterThan(13 * 86_400_000);
      expect(await rows('select id from machvon.quality_nonconformance where contract_id = $1::uuid', [s.contractId])).toHaveLength(1);

      expect((await audits(testId, 'material_test.result_recorded'))[0]).toMatchObject({
        actor_id: memberId(SUPERVISOR),
        safe_diff: { sample_code: 'BT-0601', result: 'FAIL', tested_on: TODAY, nonconformance_id: test?.nonconformance_id, from_status: 'REGISTERED', to_status: 'RESULT_RECORDED' },
      });
      expect(JSON.stringify((await audits(testId, 'material_test.result_recorded'))[0])).not.toContain('18.5');
      expect((await events(testId, 'qms.material_test.result_recorded.v1'))[0]?.payload).toMatchObject({ material_test_id: testId, result: 'FAIL', status: 'RESULT_RECORDED', version: 2, nonconformance_id: test?.nonconformance_id });
      const nonconformanceId = test?.nonconformance_id as string;
      expect((await audits(nonconformanceId, 'nonconformance.raised'))[0]).toMatchObject({ reason: 'material_test_failed', safe_diff: { ncr_no: 'NCR-001', severity: 'MAJOR', source_kind: 'MATERIAL_TEST', material_test_id: testId, to_status: 'OPEN' } });
      expect((await events(nonconformanceId, 'qms.ncr.raised.v1'))[0]?.payload).toMatchObject({ nonconformance_id: nonconformanceId, severity: 'MAJOR', source_kind: 'MATERIAL_TEST', material_test_id: testId, blocks_acceptance: false });
    });

    it('UAT-AC362: a sample that passed raises no non-conformance', async () => {
      const s = await subject();
      const testId = await registered(s);
      expect(await record(SUPERVISOR, testId, 1)).toMatchObject({ status: 200, json: { status: 'RESULT_RECORDED', resource_version: 2 } });
      expect(await stored(testId)).toMatchObject({ result: 'PASS', nonconformance_id: null });
      expect(await rows('select id from machvon.quality_nonconformance where contract_id = $1::uuid', [s.contractId])).toEqual([]);
      expect(await events(testId, 'qms.ncr.raised.v1')).toEqual([]);
    });

    it('records the result of a laboratory member who holds only the right to record, and leaves the non-conformance to the person who took the sample', async () => {
      const s = await subject();
      const testId = await registered(s);
      expect((await record(LAB, testId, 1, { result: 'FAIL' })).status).toBe(200);
      const test = await stored(testId);
      expect((await ncrOf(test?.nonconformance_id as string))?.action_owner_id).toBe(memberId(SUPERVISOR));
      expect((await audits(testId, 'material_test.result_recorded'))[0]?.actor_id).toBe(memberId(LAB));
      // The person who took the sample has since left: the person who records the result answers for it.
      const second = await registered(s);
      await world.owner("update machvon.membership set status = 'Suspended' where id = $1::uuid", [memberId(SUPERVISOR)]);
      try {
        expect((await record(LAB, second, 1, { result: 'FAIL' })).status).toBe(200);
      } finally {
        await world.owner("update machvon.membership set status = 'Active' where id = $1::uuid", [memberId(SUPERVISOR)]);
      }
      expect((await ncrOf((await stored(second))?.nonconformance_id as string))?.action_owner_id).toBe(memberId(LAB));
    });

    it('numbers the non-conformances of failed results recorded at the same time one after the other: the contract is locked', async () => {
      const s = await subject();
      const tests = await Promise.all([registered(s), registered(s), registered(s)]);
      const replies = await Promise.all(tests.map((testId) => record(SUPERVISOR, testId, 1, { result: 'FAIL' })));
      expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200]);
      const numbers = await rows<{ ncr_no: string }>('select ncr_no from machvon.quality_nonconformance where contract_id = $1::uuid order by ncr_no', [s.contractId]);
      expect(numbers.map((row) => row.ncr_no)).toEqual(['NCR-001', 'NCR-002', 'NCR-003']);
    });

    it('does not wait for a manual non-conformance on the same test: the contract is locked before the test, in the order the manual one takes', async () => {
      const s = await subject();
      const testId = await registered(s);
      const manual = () =>
        call('POST', '/nonconformances', { member: SUPERVISOR, body: { contract_id: s.contractId, severity: 'MINOR', title: 'By hand', description: 'By hand', source_kind: 'MATERIAL_TEST', material_test_id: testId, action_owner_id: memberId(SUPERVISOR), due_at: '2999-01-01T00:00:00Z' } });
      const replies = await Promise.all([record(SUPERVISOR, testId, 1, { result: 'FAIL' }), manual(), record(SUPERVISOR, testId, 1, { result: 'PASS' })]);
      // Whatever the order they ran in, none was aborted by the database: the answers are answers of the rules.
      for (const reply of replies) expect([200, 403, 404, 409, 422]).toContain(reply.status);
      expect(replies.filter((reply) => reply.status >= 500)).toEqual([]);
    });

    it('records the result once, at the version the caller saw, and says the status of a test that has it', async () => {
      const s = await subject();
      const testId = await registered(s);
      expect(await record(SUPERVISOR, testId, 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await record(SUPERVISOR, testId, 1)).status).toBe(200);
      expect(await record(SUPERVISOR, testId, 2, { result: 'FAIL' })).toMatchObject({ status: 409, json: { code: 'MATERIAL_TEST_STATE_INVALID' } });
      expect(await stored(testId)).toMatchObject({ result: 'PASS', version: '2' });
      expect(await rows('select id from machvon.quality_nonconformance where contract_id = $1::uuid', [s.contractId])).toEqual([]);
    });

    it('refuses a report that is not clean or not a file, a day before the sample or in the future, values that are not an object, and a contract that is no longer performed', async () => {
      const s = await subject();
      const testId = await registered(s);
      expect(await record(SUPERVISOR, testId, 1, { report_document_version_id: PENDING })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
      expect(await record(SUPERVISOR, testId, 1, { report_document_version_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', reason: 'NOT_FOUND' } });
      expect(await record(SUPERVISOR, testId, 1, { tested_on: '2020-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'tested_on', reason: 'BEFORE_SAMPLE' } });
      expect(await record(SUPERVISOR, testId, 1, { tested_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'tested_on', reason: 'IN_THE_FUTURE' } });
      expect(await record(SUPERVISOR, testId, 1, { tested_on: '2026-02-30' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'tested_on' } });
      for (const extra of [{ result: 'MAYBE' }, { result: 'PENDING' }, { result_values: [1, 2] }, { result_values: 'x' }]) expect([400, 422]).toContain((await record(SUPERVISOR, testId, 1, extra)).status);
      expect(await stored(testId)).toMatchObject({ status: 'REGISTERED', version: '1' });
      const halted = await subject();
      const haltedTest = await registered(halted);
      await stage("update machvon.contract set status = 'SUSPENDED', status_reason = 'Works halted', status_decision_document_version_id = $2::uuid where id = $1::uuid", [halted.contractId, CLEAN]);
      expect(await record(SUPERVISOR, haltedTest, 1)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
      expect((await stored(haltedTest))?.status).toBe('REGISTERED');
    });
  });

  describe('who may', () => {
    it('registers for the holders of the right over the contract: one who holds it over another branch only does not see the contract (the right to register is the right to read)', async () => {
      const s = await subject();
      expect((await register(NOBODY, s)).status).toBe(403);
      expect((await register(LAB, s)).status).toBe(403);
      expect(await register(ELSEWHERE, s)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await register(SUPERVISOR, { ...s, contractId: randomUUID() })).toMatchObject({ status: 404 });
      expect(await rows('select id from machvon.material_test where contract_id = $1::uuid', [s.contractId])).toEqual([]);
    });

    it('records for the holders of the right to record, over the contract only', async () => {
      const s = await subject();
      const testId = await registered(s);
      expect((await record(NOBODY, testId, 1)).status).toBe(403);
      expect(await record(NARROW, testId, 1)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await record(ELSEWHERE, testId, 1)).toMatchObject({ status: 404 });
      expect(await record(SUPERVISOR, randomUUID(), 1)).toMatchObject({ status: 404 });
      expect((await stored(testId))?.status).toBe('REGISTERED');
    });

    it('does not reach the contract or the test of another tenant', async () => {
      const s = await subject();
      const testId = await registered(s);
      const other = { member: FOREIGN, tenant: TENANT_B };
      expect((await call('POST', '/material-tests', { ...other, body: { contract_id: s.contractId, sample_code: 'X-1', material_kind: 'Steel', lab_name: 'Lab', standard_ref: 'STD', sampled_on: TODAY } })).status).toBe(404);
      expect((await call('POST', `/material-tests/${testId}/result`, { ...other, version: 1, body: { result: 'PASS', tested_on: TODAY, result_values: {}, report_document_version_id: CLEAN } })).status).toBe(404);
      expect((await call('GET', '/material-tests', other)).json.items).toEqual([]);
    });
  });

  describe('listMaterialContracts (QMS-06)', () => {
    it('lists the contracts being performed that the caller can register on, by code, under the right to manage the tests', async () => {
      const a = await subject();
      const b = await subject();
      const draft = await subject('DRAFT');
      const reply = await call('GET', '/material-tests/contracts', { member: SUPERVISOR });
      expect(reply.status).toBe(200);
      const ids = (reply.json.items as Array<{ id: string }>).map((item) => item.id);
      expect(ids).toEqual(expect.arrayContaining([a.contractId, b.contractId]));
      expect(ids).not.toContain(draft.contractId);
      const codes = (reply.json.items as Array<{ code: string }>).map((item) => item.code);
      expect(codes).toEqual([...codes].sort());
      expect((reply.json.items as Array<Record<string, unknown>>).find((item) => item.id === a.contractId)).toMatchObject({ title: 'Contract', project_id: a.projectId });
      expect(Object.keys((reply.json.items as Array<Record<string, unknown>>)[0] ?? {}).sort()).toEqual(['code', 'id', 'project_id', 'title']);
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 30; page += 1) {
        const next = await call('GET', `/material-tests/contracts?limit=2${cursor}`, { member: SUPERVISOR });
        seen.push(...(next.json.items as Array<{ id: string }>).map((item) => item.id));
        if (next.json.next_cursor === null) break;
        cursor = `&cursor=${encodeURIComponent(next.json.next_cursor as string)}`;
      }
      expect(seen).toEqual(ids);
      expect((await call('GET', '/material-tests/contracts?limit=0', { member: SUPERVISOR })).status).toBeGreaterThanOrEqual(400);
      expect((await call('GET', '/material-tests/contracts?cursor=nope', { member: SUPERVISOR })).status).toBeGreaterThanOrEqual(400);
      expect((await call('GET', '/material-tests/contracts', { member: NARROW })).status).toBe(200);
      expect(((await call('GET', '/material-tests/contracts', { member: ELSEWHERE })).json.items as unknown[]).length).toBe(0);
      expect((await call('GET', '/material-tests/contracts', { member: LAB })).status).toBe(403);
      expect((await call('GET', '/material-tests/contracts', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/material-tests/contracts', { member: FOREIGN, tenant: TENANT_B })).json.items).toEqual([]);
    });
  });

  describe('listMaterialTests (QMS-06)', () => {
    it('lists the tests of a contract newest first with the result, the report and the non-conformance, a page at a time, and filters them', async () => {
      const s = await subject();
      const first = await registered(s, { sample_code: 'BT-1' });
      const second = await registered(s, { sample_code: 'BT-2' });
      const third = await registered(s, { sample_code: 'BT-3' });
      await record(SUPERVISOR, second, 1, { result: 'FAIL' });
      await record(SUPERVISOR, third, 1);
      const all = await call('GET', `/material-tests?contract_id=${s.contractId}`, { member: SUPERVISOR });
      expect(all.status).toBe(200);
      const items = all.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([third, second, first]);
      expect(items[0]).toMatchObject({ sample_code: 'BT-3', result: 'PASS', status: 'RESULT_RECORDED', nonconformance: null, report_document_version_id: CLEAN, allowed: { record: false }, version: 2 });
      expect(items[1]).toMatchObject({ sample_code: 'BT-2', result: 'FAIL', nonconformance: { ncr_no: 'NCR-001', severity: 'MAJOR', status: 'OPEN' }, result_values: { strength_mpa: 31.2 } });
      expect(items[2]).toMatchObject({ sample_code: 'BT-1', result: 'PENDING', status: 'REGISTERED', tested_on: null, report_document_version_id: null, allowed: { record: true }, version: 1 });
      expect(Object.keys(items[2] ?? {}).sort()).toEqual(
        ['allowed', 'boq_item_id', 'contract', 'created_at', 'id', 'lab_name', 'material_kind', 'nonconformance', 'project_id', 'report_document_version_id', 'result', 'result_values', 'sample_code', 'sampled_on', 'standard_ref', 'status', 'tested_on', 'version'].sort(),
      );
      const reader = (await call('GET', `/material-tests?contract_id=${s.contractId}`, { member: NARROW })).json.items as Array<Record<string, unknown>>;
      expect(reader.find((item) => item.id === first)).toMatchObject({ allowed: { record: false } });

      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page += 1) {
        const reply = await call('GET', `/material-tests?contract_id=${s.contractId}&limit=2${cursor}`, { member: SUPERVISOR });
        seen.push(...(reply.json.items as Array<{ id: string }>).map((item) => item.id));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${encodeURIComponent(reply.json.next_cursor as string)}`;
      }
      expect(seen).toEqual([third, second, first]);
      const idsOf = async (query: string) => ((await call('GET', `/material-tests?contract_id=${s.contractId}&${query}`, { member: SUPERVISOR })).json.items as Array<{ id: string }>).map((item) => item.id);
      expect(await idsOf('result=FAIL')).toEqual([second]);
      expect(await idsOf('result=PENDING')).toEqual([first]);
      expect(await idsOf('status=REGISTERED')).toEqual([first]);
      expect(await idsOf('status=RESULT_RECORDED')).toEqual([third, second]);
    });

    it('shows nothing of a contract outside the scope, is for the holders of the right and refuses what is badly formed', async () => {
      const s = await subject();
      await registered(s);
      expect((await call('GET', `/material-tests?contract_id=${s.contractId}`, { member: ELSEWHERE })).json.items).toEqual([]);
      expect((await call('GET', `/material-tests?contract_id=${s.contractId}`, { member: LAB })).status).toBe(403);
      expect((await call('GET', `/material-tests?contract_id=${s.contractId}`, { member: NOBODY })).status).toBe(403);
      for (const query of ['contract_id=nope', 'status=NOPE', 'result=NOPE', 'limit=0', 'limit=500', 'cursor=nope']) expect((await call('GET', `/material-tests?${query}`, { member: SUPERVISOR })).status).toBeGreaterThanOrEqual(400);
      expect((await call('GET', '/material-tests', { member: SUPERVISOR })).status).toBe(200);
    });
  });

  describe('is kept by the database as well', () => {
    const edit = async (sql: string, params: unknown[] = []): Promise<string> => {
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query(sql, params);
        return 'done';
      } catch (error) {
        return (error as Error).message;
      } finally {
        await client.end();
      }
    };

    it('does not let what a test says change, its status skip a step, a result with no day or report be written, a failed result be left without its non-conformance, nor the result be written twice', async () => {
      const s = await subject();
      const testId = await registered(s);
      expect(await edit("update machvon.material_test set sample_code = 'OTHER' where id = $1::uuid", [testId])).toMatch(/never changes/);
      expect(await edit("update machvon.material_test set standard_ref = 'OTHER' where id = $1::uuid", [testId])).toMatch(/never changes/);
      expect(await edit("update machvon.material_test set status = 'ACCEPTED' where id = $1::uuid", [testId])).toMatch(/not allowed/);
      expect(await edit("update machvon.material_test set status = 'RESULT_RECORDED', result = 'PASS' where id = $1::uuid", [testId])).toMatch(/material_test_result_chk/);
      expect(await edit("update machvon.material_test set status = 'RESULT_RECORDED', result = 'FAIL', tested_on = date '2999-01-01', report_document_version_id = $2::uuid where id = $1::uuid", [testId, CLEAN])).toMatch(/material_test_ncr_chk/);
      expect(await edit("update machvon.material_test set status = 'RESULT_RECORDED', result = 'PASS', tested_on = $2::date, report_document_version_id = $3::uuid, result_values = '[1]'::jsonb where id = $1::uuid", [testId, TODAY, CLEAN])).toMatch(/material_test_values_chk/);
      expect(await edit("update machvon.material_test set status = 'RESULT_RECORDED', result = 'PASS', tested_on = date '2000-01-01', report_document_version_id = $2::uuid where id = $1::uuid", [testId, CLEAN])).toMatch(/material_test_dates_chk/);
      expect(await stored(testId)).toMatchObject({ status: 'REGISTERED' });
      expect((await record(SUPERVISOR, testId, 1)).status).toBe(200);
      expect(await edit("update machvon.material_test set result = 'FAIL' where id = $1::uuid", [testId])).toMatch(/written once/);
      expect(await edit("update machvon.material_test set result_values = '{}'::jsonb where id = $1::uuid", [testId])).toMatch(/written once/);
      expect(await edit("update machvon.material_test set status = 'REGISTERED' where id = $1::uuid", [testId])).toMatch(/not allowed/);
      expect(await edit("update machvon.material_test set status = 'ACCEPTED' where id = $1::uuid", [testId])).toBe('done');
    });

    it('is never deleted by the application', async () => {
      const s = await subject();
      const testId = await registered(s);
      const appClient = new Client({ connectionString: harness.database.urlFor('machvon_app') });
      await appClient.connect();
      try {
        await appClient.query('begin');
        await appClient.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        await expect(appClient.query('delete from machvon.material_test where id = $1::uuid', [testId])).rejects.toThrow(/permission denied/);
      } finally {
        await appClient.end();
      }
      expect(await stored(testId)).toMatchObject({ status: 'REGISTERED' });
    });
  });
});
