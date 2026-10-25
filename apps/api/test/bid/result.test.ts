import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { ResultController } from '../../src/modules/bid/result.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedBidPackage, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PROPOSER = 1; // bid.result.submit, bid.read over the tenant
const DEPARTMENT_PROPOSER = 2; // the same over the unit tree of the department
const ELSEWHERE_PROPOSER = 3; // the same over another branch
const APPROVER = 4; // bid.result.approve, bid.read, rank 50
const LOWER_APPROVER = 5; // the same at rank 40
const HIGHER_APPROVER = 6; // the same at rank 60
const READER = 7; // bid.read only
const NOBODY = 8;
const BOTH = 9; // bid.result.submit and bid.result.approve, rank 50: a proposer who may also approve
const B_PROPOSER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0xa6;
const MINUTES = id(FAMILY, 1);
const MINUTES_DRAFT = id(FAMILY, 2);
const DECISION = id(FAMILY, 3);
const DECISION_DRAFT = id(FAMILY, 4);
const BUDGET = '18000000000';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the result of the selection of a contractor over HTTP (ST-BID-006)', () => {
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
  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; reason: string | null; classification: string }>(
      'select safe_diff, outcome, actor_id, reason, classification from machvon.audit_event where resource_id = $1 and action = $2',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const stored = async (resultId: string) =>
    (
      await rows<{ status: string; outcome: string; award_price_vnd: string | null; decision_document_id: string | null; approved_by: string | null; submitted_by: string | null; version: string }>(
        'select status, outcome, award_price_vnd::text, decision_document_id, approved_by, submitted_by, version::text from machvon.procurement_result where id = $1::uuid',
        [resultId],
      )
    )[0];
  const packageStatus = async (packageId: string) => (await rows<{ status: string }>('select status from machvon.procurement_package where id = $1::uuid', [packageId]))[0]?.status;

  interface Setup {
    projectId: string;
    packageId: string;
    code: string;
    winner: string;
  }

  /** An approved package of 18 billion in a project of the department, and a verified contractor. */
  async function setup(options: { status?: string; unit?: number } = {}): Promise<Setup> {
    const seeded = await seedBidPackage(harness, { budgetVnd: BUDGET, ...(options.status === undefined ? {} : { status: options.status }), ...(options.unit === undefined ? {} : { unit: options.unit }) });
    return { projectId: seeded.projectId, packageId: seeded.packageId, code: seeded.packageCode, winner: await seedContractor(harness) };
  }

  const submit = (member: number, s: Setup, overrides: Record<string, unknown> = {}, extra: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/procurement-results', { member, ...extra, body: { package_id: s.packageId, outcome: 'AWARDED', winner_contractor_id: s.winner, award_price_vnd: '17650000000', evaluation_report_id: MINUTES, ...overrides } });
  const decide = (member: number, resultId: string, version: number | string, body: Record<string, unknown>, tenantId?: string): Promise<Reply> =>
    call('POST', `/procurement-results/${resultId}/decision`, { member, ifMatch: `"${version}"`, ...(tenantId === undefined ? {} : { tenantId }), body });
  const approve = (member: number, resultId: string, version: number | string = 1, extra: Record<string, unknown> = {}) => decide(member, resultId, version, { decision: 'APPROVE', decision_document_id: DECISION, ...extra });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [PROPOSER, DEPARTMENT_PROPOSER, ELSEWHERE_PROPOSER, APPROVER, LOWER_APPROVER, HIGHER_APPROVER, READER, NOBODY, BOTH]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PROPOSER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'BID_PROPOSER', ['bid.result.submit', 'bid.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'BID_APPROVER', ['bid.result.approve', 'bid.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'BID_LOWER_APPROVER', ['bid.result.approve', 'bid.read'], 40);
    await harness.seedRole(TENANT_A, 4, 'BID_HIGHER_APPROVER', ['bid.result.approve', 'bid.read'], 60);
    await harness.seedRole(TENANT_A, 5, 'BID_READER', ['bid.read'], 10);
    await harness.seedRole(TENANT_A, 6, 'BID_BOTH', ['bid.result.submit', 'bid.result.approve', 'bid.read'], 50);
    await harness.seedRole(TENANT_B, 1, 'BID_PROPOSER', ['bid.result.submit', 'bid.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PROPOSER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_PROPOSER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: ELSEWHERE_PROPOSER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 5, member: LOWER_APPROVER, role: 3, kind: 'TENANT' },
      { n: 6, member: HIGHER_APPROVER, role: 4, kind: 'TENANT' },
      { n: 7, member: READER, role: 5, kind: 'TENANT' },
      { n: 8, member: BOTH, role: 6, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PROPOSER, role: 1, kind: 'TENANT' }]);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, effect_status, symbol, issued_on, created_by, updated_by) values
           ($1, $2, 'REFERENCE', 'BB-DG', 'Evaluation minutes', 'INTERNAL', 'EFFECTIVE', 'BB-01', date '2026-10-01', $6, $6),
           ($1, $3, 'REFERENCE', 'BB-DG', 'Evaluation minutes (draft)', 'INTERNAL', 'PENDING', null, null, $6, $6),
           ($1, $4, 'REFERENCE', 'QD', 'Decision KQ-01', 'INTERNAL', 'EFFECTIVE', 'KQ-01', date '2026-10-20', $6, $6),
           ($1, $5, 'REFERENCE', 'QD', 'Decision (draft)', 'INTERNAL', 'PENDING', null, null, $6, $6)`,
        [TENANT_A, MINUTES, MINUTES_DRAFT, DECISION, DECISION_DRAFT, memberId(PROPOSER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ResultController],
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
    expect(bidModule.controllers).toContain(ResultController);
  });

  describe('submitProcurementResult and decideProcurementResult', () => {
    it('AC-ST-BID-006-1, UAT-AC455: refuses 18,500,000,000 (422 PRICE_EXCEEDS_PACKAGE_BUDGET), takes 17,650,000,000, refuses the proposer who approves it (403 SELF_APPROVAL_DENIED), and an approver approves it on the decision KQ-01', async () => {
      const s = await setup();
      const over = await submit(PROPOSER, s, { award_price_vnd: '18500000000' });
      expect(over).toMatchObject({ status: 422, json: { code: 'PRICE_EXCEEDS_PACKAGE_BUDGET', budget_vnd: BUDGET, award_price_vnd: '18500000000' } });
      expect(await rows('select 1 from machvon.procurement_result where package_id = $1::uuid', [s.packageId])).toEqual([]);

      const made = await submit(PROPOSER, s);
      expect(made).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 1 } });
      const resultId = String(made.json.resource_id);
      expect(await stored(resultId)).toMatchObject({ status: 'SUBMITTED', outcome: 'AWARDED', award_price_vnd: '17650000000', submitted_by: memberId(PROPOSER) });
      const [submitted] = await events(resultId, 'bid.result.submitted.v1');
      expect(submitted?.payload).toMatchObject({ result_id: resultId, package_id: s.packageId, project_id: s.projectId, outcome: 'AWARDED', winner_contractor_id: s.winner, award_price_vnd: '17650000000', actor_id: memberId(PROPOSER) });
      const [audit] = await audits(resultId, 'procurement_result.submitted');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PROPOSER), classification: 'CONFIDENTIAL', safe_diff: { code: s.code, outcome: 'AWARDED', award_price_vnd: '17650000000', budget_vnd: BUDGET } });

      expect(await approve(BOTH, resultId, 1)).toMatchObject({ status: 200 });
      const own = await submit(BOTH, await setup());
      expect(await approve(BOTH, String(own.json.resource_id))).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    });

    it('AC-ST-BID-006-1, UAT-AC455: the approval makes the package awarded and tells the contracts the package, the contractor, the price and the decision, and nothing of how it was evaluated', async () => {
      const s = await setup();
      const resultId = String((await submit(BOTH, s)).json.resource_id);
      expect(await approve(BOTH, resultId)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await stored(resultId))?.status).toBe('SUBMITTED');
      const done = await approve(APPROVER, resultId, 1, { comment: 'KQ-01' });
      expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2, resource_id: resultId } });
      expect(await stored(resultId)).toMatchObject({ status: 'APPROVED', decision_document_id: DECISION, approved_by: memberId(APPROVER), submitted_by: memberId(BOTH), version: '2' });
      expect(await packageStatus(s.packageId)).toBe('AWARDED');
      const [event] = await events(resultId, 'bid.result.approved.v1');
      expect(event?.payload).toMatchObject({
        tenant_id: TENANT_A,
        result_id: resultId,
        package_id: s.packageId,
        contractor_id: s.winner,
        award_price_vnd: '17650000000',
        decision_document_id: DECISION,
        outcome: 'AWARDED',
        actor_id: memberId(APPROVER),
      });
      expect(event?.aggregate_version).toBe('2');
      expect(JSON.stringify(event)).not.toMatch(/ai_|analysis|finding/i);
      const [audit] = await audits(resultId, 'procurement_result.approved');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(APPROVER), reason: 'KQ-01', safe_diff: { from_status: 'SUBMITTED', to_status: 'APPROVED', package_status: 'AWARDED', decision_document_id: DECISION } });
    });

    it('AC-ST-BID-006-2, UAT-AC446: refuses a winner under a restriction in force (422 CONTRACTOR_RESTRICTED) and one nobody verified, and stores nothing', async () => {
      const s = await setup();
      const restricted = await seedContractor(harness, { restricted: true });
      expect(await submit(PROPOSER, s, { winner_contractor_id: restricted })).toMatchObject({ status: 422, json: { code: 'CONTRACTOR_RESTRICTED' } });
      const unverified = await seedContractor(harness, { status: 'UNVERIFIED' });
      expect(await submit(PROPOSER, s, { winner_contractor_id: unverified })).toMatchObject({ status: 422, json: { code: 'CONTRACTOR_NOT_VERIFIED' } });
      expect(await rows('select 1 from machvon.procurement_result where package_id = $1::uuid', [s.packageId])).toEqual([]);
    });

    it('takes no acceptable bid and a cancellation with neither a winner nor a price, and gives the package the status of the outcome', async () => {
      for (const outcome of ['NO_ACCEPTABLE_BID', 'CANCELLED']) {
        const s = await setup();
        expect(await submit(PROPOSER, s, { outcome })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
        const made = await submit(PROPOSER, s, { outcome, winner_contractor_id: undefined, award_price_vnd: undefined });
        expect(made.status).toBe(200);
        expect((await approve(APPROVER, String(made.json.resource_id))).json.status).toBe('APPROVED');
        expect(await packageStatus(s.packageId)).toBe(outcome);
      }
    });

    it('is for a package whose plan is in force and an evaluation that was issued, and one result at a time', async () => {
      const draft = await setup({ status: 'IN_REVIEW' });
      expect(await submit(PROPOSER, draft)).toMatchObject({ status: 409, json: { code: 'PLAN_NOT_APPROVED' } });
      const s = await setup();
      expect(await submit(PROPOSER, s, { evaluation_report_id: MINUTES_DRAFT })).toMatchObject({ status: 409, json: { code: 'REPORT_NOT_ISSUED' } });
      expect(await submit(PROPOSER, s, { evaluation_report_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const first = await submit(PROPOSER, s);
      expect(await submit(PROPOSER, s)).toMatchObject({ status: 409, json: { code: 'RESULT_STATE_INVALID' } });
      expect(await decide(APPROVER, String(first.json.resource_id), 1, { decision: 'REJECT', comment: 'The evaluation does not support the price.' })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect((await submit(PROPOSER, s, { award_price_vnd: '17000000000' })).status).toBe(200);
    });

    it('answers the same request with the same key once', async () => {
      const s = await setup();
      const first = await submit(PROPOSER, s, {}, { key: 'result-once-for-this-key' });
      const again = await submit(PROPOSER, s, {}, { key: 'result-once-for-this-key' });
      expect(again).toEqual(first);
      expect(await rows('select 1 from machvon.procurement_result where package_id = $1::uuid', [s.packageId])).toHaveLength(1);
    });

    it('turns a result down with the reason in words, audits the reason and tells nobody it was awarded', async () => {
      const s = await setup();
      const resultId = String((await submit(BOTH, s)).json.resource_id);
      expect(await decide(APPROVER, resultId, 1, { decision: 'REJECT' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await decide(BOTH, resultId, 1, { decision: 'REJECT', comment: 'Withdrawn.' })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      const done = await decide(APPROVER, resultId, 1, { decision: 'REJECT', comment: 'The evaluation does not support the price.' });
      expect(done).toMatchObject({ status: 200, json: { status: 'REJECTED', resource_version: 2 } });
      expect(await packageStatus(s.packageId)).toBe('APPROVED');
      const [audit] = await audits(resultId, 'procurement_result.rejected');
      expect(audit).toMatchObject({ reason: 'The evaluation does not support the price.', safe_diff: { to_status: 'REJECTED' } });
      expect(await events(resultId, 'bid.result.approved.v1')).toEqual([]);
    });

    it('asks an approval for a decision document in force, and judges the version and the state', async () => {
      const s = await setup();
      const resultId = String((await submit(PROPOSER, s)).json.resource_id);
      expect(await decide(APPROVER, resultId, 1, { decision: 'APPROVE' })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_NOT_EFFECTIVE' } });
      expect(await approve(APPROVER, resultId, 1, { decision_document_id: DECISION_DRAFT })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_NOT_EFFECTIVE' } });
      expect(await approve(APPROVER, resultId, 1, { decision_document_id: MINUTES })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await approve(APPROVER, resultId, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await approve(APPROVER, resultId, 1, { status: 'APPROVED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await approve(APPROVER, resultId, 1)).toMatchObject({ status: 200 });
      expect(await approve(APPROVER, resultId, 2)).toMatchObject({ status: 409, json: { code: 'RESULT_STATE_INVALID' } });
    });

    it('judges the body: unknown fields, a missing evaluation, a price that is not whole VND', async () => {
      const s = await setup();
      expect(await submit(PROPOSER, s, { status: 'APPROVED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await submit(PROPOSER, s, { tenant_id: TENANT_B })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await submit(PROPOSER, s, { evaluation_report_id: undefined })).toMatchObject({ status: 400, json: { code: 'INVALID_REQUEST' } });
      expect([400, 422]).toContain((await submit(PROPOSER, s, { award_price_vnd: '17650000000.5' })).status);
      expect(await rows('select 1 from machvon.procurement_result where package_id = $1::uuid', [s.packageId])).toEqual([]);
    });

    it('rests on the permission and its scope: a reader and a member without a grant are refused, a proposer of another branch does not see the package, and tenant B does not either', async () => {
      const s = await setup();
      for (const member of [READER, NOBODY, APPROVER]) expect((await submit(member, s)).status).toBe(403);
      expect((await submit(ELSEWHERE_PROPOSER, s)).status).toBe(404);
      expect((await submit(B_PROPOSER, s, {}, { tenantId: TENANT_B })).status).toBe(404);
      expect((await submit(DEPARTMENT_PROPOSER, s)).status).toBe(200);
      const made = await submit(PROPOSER, await setup());
      const resultId = String(made.json.resource_id);
      for (const member of [READER, NOBODY, PROPOSER]) expect((await approve(member, resultId)).status).toBe(403);
      expect((await approve(B_PROPOSER, resultId, 1, {}).catch(() => ({ status: 0 }))).status).not.toBe(200);
      expect((await decide(B_PROPOSER, resultId, 1, { decision: 'APPROVE', decision_document_id: DECISION }, TENANT_B)).status).toBe(403);
      expect((await stored(resultId))?.status).toBe('SUBMITTED');
    });
  });

  describe('listProcurementResults', () => {
    it('lists the results of the package with the winner, the price, the evaluation and who submitted and decided, as an allowlist', async () => {
      const s = await setup();
      const first = await submit(PROPOSER, s);
      await decide(APPROVER, String(first.json.resource_id), 1, { decision: 'REJECT', comment: 'Too high.' });
      const second = await submit(PROPOSER, s, { award_price_vnd: '17000000000' });
      const listed = await call('GET', `/procurement-results?package_id=${s.packageId}`, { member: READER });
      expect(listed.status).toBe(200);
      const items = listed.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => [item.id, item.status])).toEqual([
        [second.json.resource_id, 'SUBMITTED'],
        [first.json.resource_id, 'REJECTED'],
      ]);
      expect(items[0]).toMatchObject({
        package: { id: s.packageId, code: s.code, budget_vnd: BUDGET },
        outcome: 'AWARDED',
        winner: { id: s.winner },
        award_price_vnd: '17000000000',
        evaluation_minutes: { document_id: MINUTES, title: 'Evaluation minutes' },
        submitted_by: { membership_id: memberId(PROPOSER) },
        decided_by: null,
        version: 1,
      });
      expect(items[1]).toMatchObject({ decided_by: { membership_id: memberId(APPROVER) }, comment: 'Too high.', version: 2 });
      expect(Object.keys(items[0] as object).sort()).toEqual(['award_price_vnd', 'comment', 'decided_at', 'decided_by', 'decision_document_id', 'evaluation_minutes', 'id', 'outcome', 'package', 'status', 'submitted_at', 'submitted_by', 'version', 'winner']);
    });

    it('lists every package when none is named, only what the caller reaches, and refuses a package that is not an identifier', async () => {
      const s = await setup();
      const made = await submit(PROPOSER, s);
      const all = await call('GET', '/procurement-results', { member: READER });
      expect((all.json.items as Array<{ id: string }>).map((item) => item.id)).toContain(made.json.resource_id);
      expect(await call('GET', '/procurement-results', { member: NOBODY })).toMatchObject({ status: 403 });
      expect(await call('GET', '/procurement-results?package_id=not-an-id', { member: READER })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(((await call('GET', `/procurement-results?package_id=${randomUUID()}`, { member: READER })).json.items as unknown[]).length).toBe(0);
    });
  });

  // Last: it publishes a matrix, and from then on the approval of a result is limited by it.
  describe('the delegation limit of the matrix (BID_RESULT)', () => {
    beforeAll(async () => {
      const matrix = id(FAMILY, 20);
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version)
           values ($1, $2, 900, 'Draft', date '2020-01-01', 'Fixture regulation on the approval of results', $3, $3, 1)`,
          [TENANT_A, matrix, memberId(PROPOSER)],
        ],
        [
          `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, position)
           values ($1, $2, $3, 'BID_RESULT', $4, true, 0, 20000000000, $5, 0), ($1, $6, $3, 'BID_RESULT', $4, true, 20000000000, null, $7, 1)`,
          [TENANT_A, id(FAMILY, 21), matrix, unitId(ROOT), roleId(2), id(FAMILY, 22), roleId(4)],
        ],
        ["update machvon.doa_matrix_version set status = 'PendingApproval' where id = $1", [matrix]],
        ["update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [matrix, memberId(APPROVER)]],
      ]);
    });

    it('refuses an approver below the band of the award (403 SCOPE_DENIED), and takes one at the band and one above it', async () => {
      const s = await setup();
      const resultId = String((await submit(PROPOSER, s)).json.resource_id);
      expect(await approve(LOWER_APPROVER, resultId)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await stored(resultId))?.status).toBe('SUBMITTED');
      expect(await approve(APPROVER, resultId)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    });

    it('reads the value of the award: above 20 billion the band is the province, and the approver of the lower band is refused', async () => {
      const s = await setup();
      await seedAs(harness, [['update machvon.procurement_package set budget_vnd = 30000000000 where id = $1::uuid', [s.packageId]]]);
      const resultId = String((await submit(PROPOSER, s, { award_price_vnd: '25000000000' })).json.resource_id);
      expect(await approve(APPROVER, resultId)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await approve(HIGHER_APPROVER, resultId)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    });

    it('limits a result with no award by the price of the package, and a rejection by the same band', async () => {
      const s = await setup();
      const resultId = String((await submit(PROPOSER, s, { outcome: 'CANCELLED', winner_contractor_id: undefined, award_price_vnd: undefined })).json.resource_id);
      expect(await decide(LOWER_APPROVER, resultId, 1, { decision: 'REJECT', comment: 'No.' })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await decide(APPROVER, resultId, 1, { decision: 'REJECT', comment: 'No.' })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    });
  });
});
