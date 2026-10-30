import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ctrModule } from '../../src/modules/ctr';
import { ScorecardController, ScorecardReadsController } from '../../src/modules/ctr/scorecard.controller';
import { TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import { adminStatement } from '../../../../packages/db/test/support/settled-payment';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(600_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const MAKER = 81; // evaluates, records, and holds the rights to approve and confirm too (to be refused as the author)
const LEADER = 82; // approves and confirms
const ANALYST = 83; // evaluates and records only
const READER = 84; // reads the scorecard only
const NOBODY = 85;
const ELSEWHERE = 86; // evaluates and approves over another project, reads nothing of this one
const GUEST = 87; // a guest contractor, whatever the grant
const SPLIT = 88; // reads the whole tenant but evaluates and records only over another project
const FOREIGN = 89; // another tenant, every right over the scorecards of that tenant
const MEMBERS = [MAKER, LEADER, ANALYST, READER, NOBODY, ELSEWHERE, GUEST, SPLIT];
const REMARKS = 'Nhà thầu giữ đúng tiến độ nhưng hồ sơ an toàn còn thiếu';
const NOTE = 'Đồng ý với đánh giá của phòng hợp đồng';
const WORDS = 'Chậm bàn giao mặt bằng thi công đợt hai ba mươi ngày';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface EvaluationRow {
  id: string;
  status: string;
  revision: number;
  overall_score: string;
  rating: string;
  version: string;
  approved_by: string | null;
  approval_note: string | null;
  supersedes_id: string | null;
  weights_rule_version_id: string | null;
}

interface ViolationRow {
  id: string;
  status: string;
  version: string;
  penalty_kind: string;
  penalty_amount_vnd: string;
  decision_document_version_id: string | null;
  confirmed_by: string | null;
}

const SCORES = { score_quality: 80, score_schedule: 70, score_safety_env: 90, score_cooperation: 60, score_financial: 100 };

describe('the scorecard of a contractor and the log of its violations over HTTP (ST-CTR-014, AC-ST-CTR-014-1, AC-ST-CTR-014-2, UAT-AC315, UAT-PLAN-17)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  let app: RunningApp;
  let contractId = '';
  let otherContractId = '';
  let otherProject = '';
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string; tenant?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const evaluationOf = async (id: string): Promise<EvaluationRow> =>
    (
      await rows<EvaluationRow>(
        'select id, status, revision, overall_score::text as overall_score, rating, version::text as version, approved_by, approval_note, supersedes_id, weights_rule_version_id from machvon.contractor_performance where id = $1::uuid',
        [id],
      )
    )[0] as EvaluationRow;
  const violationOf = async (id: string): Promise<ViolationRow> =>
    (
      await rows<ViolationRow>(
        'select id, status, version::text as version, penalty_kind, penalty_amount_vnd::text as penalty_amount_vnd, decision_document_version_id, confirmed_by from machvon.contractor_violation where id = $1::uuid',
        [id],
      )
    )[0] as ViolationRow;

  const period = (): string => `2026-P${(counter += 1)}`;
  const evaluate = (member: number, body: Record<string, unknown> = {}, target = contractId) =>
    call('POST', `/contracts/${target}/performance-evaluations`, { member, body: { evaluation_kind: 'PERIODIC', period_label: '2026-Q3', ...SCORES, ...body } });
  const approve = (member: number, id: string, version: number | string, body: Record<string, unknown> = {}) => call('POST', `/performance-evaluations/${id}/approve`, { member, ifMatch: `"${version}"`, body });
  const record = (member: number, body: Record<string, unknown> = {}, target = contractId) =>
    call('POST', `/contracts/${target}/violations`, { member, body: { violation_kind: 'DELAY', severity: 'MAJOR', occurred_on: '2026-09-01', description: WORDS, ...body } });
  const confirm = (member: number, id: string, version: number | string, body: Record<string, unknown> = {}) => call('POST', `/violations/${id}/confirm`, { member, ifMatch: `"${version}"`, body: { penalty_kind: 'NONE', ...body } });
  const scorecard = (member: number, query = '', contractor = fixtures.contractorId, tenant?: string) => call('GET', `/contractors/${contractor}/scorecard${query}`, { member, ...(tenant === undefined ? {} : { tenant }) });
  const auditsOf = (resourceId: string) => rows<{ action: string; safe_diff: Record<string, unknown>; actor_id: string }>('select action, safe_diff, actor_id from machvon.audit_event where resource_id = $1 order by occurred_at, id', [resourceId]);
  const eventsOf = (aggregateId: string) => rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [aggregateId]);
  const setStatus = (id: string, status: string) => adminStatement(fixtures, 'update machvon.contract set status = $2 where id = $1::uuid', [id, status]);
  const complete = (id: string) =>
    adminStatement(fixtures, "update machvon.contract set status = 'COMPLETED', completed_on = date '2027-08-01', completion_quality_acceptance_id = gen_random_uuid(), completed_by = $2::uuid where id = $1::uuid", [id, memberId(MAKER)]);

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 801, 'SC_MAKER', ['contractor.performance.evaluate', 'contractor.performance.approve', 'contractor.violation.record', 'contractor.violation.confirm', 'contractor.performance.read'], 40);
    await harness.seedRole(TENANT_A, 802, 'SC_LEADER', ['contractor.performance.approve', 'contractor.violation.confirm', 'contractor.performance.read'], 40);
    await harness.seedRole(TENANT_A, 803, 'SC_ANALYST', ['contractor.performance.evaluate', 'contractor.violation.record', 'contractor.performance.read'], 30);
    await harness.seedRole(TENANT_A, 804, 'SC_READER', ['contractor.performance.read'], 20);
    await harness.seedRole(TENANT_A, 805, 'SC_SPLIT_READ', ['contractor.performance.read'], 20);
    await fixtures.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [
      memberId(GUEST),
      fixtures.contractorId,
    ]);
    await adminStatement(fixtures, "update machvon.project set status = 'IMPLEMENTATION', project_group = 'B' where id = $1::uuid", [fixtures.projectId]);
    const other = await fixtures.world.publishedLine({ allocated: '1000000000' });
    otherProject = other.projectId;
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 801, kind: 'TENANT' },
      { n: 2, member: LEADER, role: 802, kind: 'TENANT' },
      { n: 3, member: ANALYST, role: 803, kind: 'TENANT' },
      { n: 4, member: READER, role: 804, kind: 'TENANT' },
      { n: 5, member: ELSEWHERE, role: 801, kind: 'PROJECT', refs: [otherProject] },
      { n: 6, member: GUEST, role: 801, kind: 'TENANT' },
      { n: 7, member: SPLIT, role: 805, kind: 'TENANT' },
      { n: 8, member: SPLIT, role: 803, kind: 'PROJECT', refs: [otherProject] },
    ]);
    contractId = (await fixtures.seedContract()).contractId;
    otherContractId = (await fixtures.seedContract({ projectId: otherProject })).contractId;
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, FOREIGN, ROOT);
    await harness.seedRole(TENANT_B, 801, 'SC_MAKER', ['contractor.performance.evaluate', 'contractor.performance.approve', 'contractor.violation.record', 'contractor.violation.confirm', 'contractor.performance.read'], 40);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: FOREIGN, role: 801, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ScorecardController, ScorecardReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 600_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  it('is registered in the module of CTR', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([ScorecardController, ScorecardReadsController]));
  });

  describe('the evaluation (AC-ST-CTR-014-1, UAT-AC315)', () => {
    it('AC-ST-CTR-014-1 UAT-AC315: weights 80/70/90/60/100 into 80.50 and GOOD, refuses the author as approver, and the leader approves', async () => {
      const made = await evaluate(MAKER, { remarks: REMARKS });
      expect(made).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 1 } });
      const id = made.json.resource_id as string;
      expect(await evaluationOf(id)).toMatchObject({ status: 'SUBMITTED', revision: 1, overall_score: '80.50', rating: 'GOOD', version: '1', approved_by: null, weights_rule_version_id: null });
      const own = await approve(MAKER, id, 1);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await evaluationOf(id)).toMatchObject({ status: 'SUBMITTED' });
      const done = await approve(LEADER, id, 1, { note: NOTE });
      expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2 } });
      expect(await evaluationOf(id)).toMatchObject({ status: 'APPROVED', approved_by: memberId(LEADER), approval_note: NOTE, version: '2' });
      // The trail and the events carry the figures and ids and none of the words of the people.
      const trail = await auditsOf(id);
      expect(trail.map((row) => row.action)).toEqual(['ctr.contractor_evaluation.submitted', 'ctr.contractor_evaluation.approved']);
      expect(trail[1]?.safe_diff).toMatchObject({ status: 'APPROVED', overall_score: '80.50', rating: 'GOOD', period_label: '2026-Q3', evaluation_kind: 'PERIODIC', revision: 1 });
      expect(JSON.stringify(trail)).not.toContain('tiến độ');
      expect(JSON.stringify(trail)).not.toContain('đồng ý');
      const events = await eventsOf(id);
      expect(events.map((event) => event.type)).toEqual(['ctr.contractor_evaluation.submitted.v1', 'ctr.contractor_evaluation.approved.v1']);
      expect(JSON.stringify(events)).not.toContain('tiến độ');
    });

    it('is 409 EVALUATION_DUPLICATE while one waits for the same kind and period, and a new revision once it is approved: approving it supersedes the first', async () => {
      const label = period();
      const first = (await evaluate(ANALYST, { period_label: label })).json.resource_id as string;
      const duplicate = await evaluate(MAKER, { period_label: label, score_quality: 10 });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'EVALUATION_DUPLICATE']);
      expect((await approve(LEADER, first, 1)).status).toBe(200);
      const second = await evaluate(ANALYST, { period_label: label, score_quality: 90, score_schedule: 90, score_safety_env: 90, score_cooperation: 90, score_financial: 90 });
      expect(second.status).toBe(200);
      const secondId = second.json.resource_id as string;
      expect(await evaluationOf(secondId)).toMatchObject({ revision: 2, status: 'SUBMITTED', overall_score: '90.00', rating: 'EXCELLENT', supersedes_id: first });
      // The first still stands until the second is approved: one is approved for a period at a time.
      expect(await evaluationOf(first)).toMatchObject({ status: 'APPROVED' });
      expect((await approve(LEADER, secondId, 1)).status).toBe(200);
      expect(await evaluationOf(first)).toMatchObject({ status: 'SUPERSEDED', version: '3' });
      expect(await evaluationOf(secondId)).toMatchObject({ status: 'APPROVED' });
      const again = await evaluate(MAKER, { period_label: label });
      expect(await evaluationOf(again.json.resource_id as string)).toMatchObject({ revision: 3, supersedes_id: secondId });
    });

    it('refuses an approval that is stale or of one that was approved already, and one by someone who may not approve', async () => {
      const id = (await evaluate(ANALYST, { period_label: period() })).json.resource_id as string;
      const stale = await approve(LEADER, id, 9);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await approve(ANALYST, id, 1)).status).toBe(403);
      expect((await approve(READER, id, 1)).status).toBe(403);
      expect((await approve(LEADER, id, 1, { note: '   ' })).json.code).toBe('VALIDATION_FAILED');
      expect((await approve(LEADER, id, 1)).status).toBe(200);
      const again = await approve(LEADER, id, 2);
      expect([again.status, again.json.code]).toEqual([409, 'EVALUATION_STATE_INVALID']);
      expect((await approve(LEADER, randomUUID(), 1)).status).toBe(404);
    });

    it('judges the kind of evaluation by the contract: a completion one on an active contract, and any one on a draft, are 409 CONTRACT_STATE_INVALID', async () => {
      const completion = await evaluate(MAKER, { evaluation_kind: 'COMPLETION', period_label: period() });
      expect([completion.status, completion.json.code]).toEqual([409, 'CONTRACT_STATE_INVALID']);
      const draft = (await fixtures.seedContract()).contractId;
      await setStatus(draft, 'DRAFT');
      expect((await evaluate(MAKER, {}, draft)).json.code).toBe('CONTRACT_STATE_INVALID');
      expect((await record(MAKER, {}, draft)).json.code).toBe('CONTRACT_STATE_INVALID');
      const done = (await fixtures.seedContract()).contractId;
      await complete(done);
      expect((await evaluate(MAKER, { evaluation_kind: 'COMPLETION', period_label: 'final' }, done)).status).toBe(200);
      expect((await evaluate(MAKER, { evaluation_kind: 'TERMINATION', period_label: 'final' }, done)).json.code).toBe('CONTRACT_STATE_INVALID');
    });

    it('refuses what is not an evaluation: scores out of the range, a kind it does not know, a period that is empty', async () => {
      for (const body of [{ score_quality: 101 }, { score_financial: -1 }, { evaluation_kind: 'ANNUAL' }, { period_label: '' }, { remarks: '' }]) {
        const refused = await evaluate(MAKER, { period_label: period(), ...body });
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      // A figure that is not a whole number, or a field the operation does not have, is turned back by the shape of the request before the rule.
      for (const body of [{ score_schedule: 70.5 }, { surprise: 1 }]) expect((await evaluate(MAKER, { period_label: period(), ...body })).status).toBe(400);
    });

    it('is the scope of the permission that decides: no right is 403, a contract that cannot be read is 404, and one that is read but not evaluated is 403 SCOPE_DENIED', async () => {
      expect((await evaluate(NOBODY)).status).toBe(403);
      expect((await evaluate(READER)).status).toBe(403);
      // A contract that is named in the path is judged by the guard before the handler, which answers 403 for one outside the scope of the permission.
      expect((await evaluate(ELSEWHERE)).status).toBe(404);
      const split = await evaluate(SPLIT);
      expect([split.status, split.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await evaluate(SPLIT, { period_label: period() }, otherContractId)).status).toBe(200);
      expect((await evaluate(MAKER, {}, randomUUID())).status).toBe(404);
      const foreign = await call('POST', `/contracts/${contractId}/performance-evaluations`, { member: FOREIGN, tenant: TENANT_B, body: { evaluation_kind: 'PERIODIC', period_label: period(), ...SCORES } });
      expect(foreign.status).toBe(404);
    });
  });

  describe('the violation (AC-ST-CTR-014-2, UAT-PLAN-17)', () => {
    it('AC-ST-CTR-014-2 UAT-PLAN-17: a sanction is not confirmed without the document that decides it, and with it the violation is CONFIRMED and in the scorecard', async () => {
      const made = await record(ANALYST);
      expect(made).toMatchObject({ status: 200, json: { status: 'RECORDED', resource_version: 1 } });
      const id = made.json.resource_id as string;
      const without = await confirm(LEADER, id, 1, { penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd: '150000000' });
      expect([without.status, without.json.code]).toEqual([422, 'DECISION_DOCUMENT_REQUIRED']);
      expect(await violationOf(id)).toMatchObject({ status: 'RECORDED', penalty_kind: 'NONE', version: '1' });
      const infected = await fixtures.documentVersion('INFECTED');
      expect((await confirm(LEADER, id, 1, { penalty_kind: 'WARNING', decision_document_version_id: infected.id })).json.code).toBe('DECISION_DOCUMENT_REQUIRED');
      expect((await confirm(LEADER, id, 1, { penalty_kind: 'WARNING', decision_document_version_id: randomUUID() })).json.code).toBe('DECISION_DOCUMENT_REQUIRED');
      const decision = await fixtures.documentVersion();
      const done = await confirm(LEADER, id, 1, { penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd: '150000000', decision_document_version_id: decision.id });
      expect(done).toMatchObject({ status: 200, json: { status: 'CONFIRMED', resource_version: 2 } });
      expect(await violationOf(id)).toMatchObject({ status: 'CONFIRMED', penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd: '150000000', decision_document_version_id: decision.id, confirmed_by: memberId(LEADER) });
      const card = await scorecard(READER);
      const line = (card.json.violations as Array<Record<string, unknown>>).find((entry) => entry.id === id);
      expect(line).toMatchObject({ status: 'CONFIRMED', violation_kind: 'DELAY', severity: 'MAJOR', penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd: '150000000', allowed: { confirm: false } });
      expect((card.json.summary as { confirmed_violations: Record<string, number> }).confirmed_violations.MAJOR).toBeGreaterThanOrEqual(1);
      const trail = await auditsOf(id);
      expect(trail.map((row) => row.action)).toEqual(['ctr.violation.recorded', 'ctr.violation.confirmed']);
      expect(trail[1]?.safe_diff).toMatchObject({ penalty_kind: 'LIQUIDATED_DAMAGES', penalty_amount_vnd: '150000000', decision_document_version_id: decision.id });
      expect(JSON.stringify(trail)).not.toContain('bàn giao');
      expect(JSON.stringify(await eventsOf(id))).not.toContain('bàn giao');
      expect((await eventsOf(id)).map((event) => event.type)).toEqual(['ctr.violation.recorded.v1', 'ctr.violation.confirmed.v1']);
    });

    it('confirms a violation with no sanction without a document, once, and not by the one who recorded it', async () => {
      const id = (await record(MAKER, { severity: 'MINOR' })).json.resource_id as string;
      const own = await confirm(MAKER, id, 1);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const stale = await confirm(LEADER, id, 7);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await confirm(ANALYST, id, 1)).status).toBe(403);
      expect(await confirm(LEADER, id, 1)).toMatchObject({ status: 200, json: { status: 'CONFIRMED' } });
      const again = await confirm(LEADER, id, 2);
      expect([again.status, again.json.code]).toEqual([409, 'VIOLATION_STATE_INVALID']);
      expect((await confirm(LEADER, randomUUID(), 1)).status).toBe(404);
    });

    it('takes the document that a violation was recorded with: a suggestion that a termination made rests on its document and is confirmed with it', async () => {
      const decision = await fixtures.documentVersion();
      const id = randomUUID();
      await adminStatement(
        fixtures,
        `insert into machvon.contractor_violation
           (tenant_id, id, contract_id, contractor_id, violation_kind, severity, occurred_on, description, penalty_kind, penalty_amount_vnd, decision_document_version_id, source_module, source_ref_id, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'ABANDONMENT', 'CRITICAL', date '2026-09-10', 'Suggested by the termination', 'TERMINATION', 0, $5, 'CTR', $3, 'RECORDED', $6, $6)`,
        [TENANT_A, id, contractId, fixtures.contractorId, decision.id, memberId(ANALYST)],
      );
      expect(await confirm(LEADER, id, 1, { penalty_kind: 'TERMINATION' })).toMatchObject({ status: 200, json: { status: 'CONFIRMED' } });
      expect(await violationOf(id)).toMatchObject({ penalty_kind: 'TERMINATION', decision_document_version_id: decision.id });
    });

    it('refuses what is not a violation: a day to come, a kind it does not know, an evidence that is not clean, a source with no record', async () => {
      const infected = await fixtures.documentVersion('INFECTED');
      for (const [body, code, detail] of [
        [{ occurred_on: '2099-01-01' }, 'VALIDATION_FAILED', 'occurred_on'],
        [{ occurred_on: '2026-02-30' }, 'VALIDATION_FAILED', 'occurred_on'],
        [{ violation_kind: 'THEFT' }, 'VALIDATION_FAILED', 'violation_kind'],
        [{ severity: 'HIGH' }, 'VALIDATION_FAILED', 'severity'],
        [{ description: '' }, 'VALIDATION_FAILED', 'description'],
        [{ source_module: 'ISS' }, 'VALIDATION_FAILED', 'source_ref_id'],
        [{ evidence_document_version_id: randomUUID() }, 'VALIDATION_FAILED', 'evidence_document_version_id'],
        [{ evidence_document_version_id: infected.id }, 'DOCUMENT_NOT_CLEAN', 'evidence_document_version_id'],
      ] as const) {
        const refused = await record(MAKER, body);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, code, detail]);
      }
      const clean = await fixtures.documentVersion();
      const noted = await record(MAKER, { source_module: 'ISS', source_ref_id: randomUUID(), evidence_document_version_id: clean.id });
      expect(noted.status).toBe(200);
      for (const [body, detail] of [
        [{ penalty_kind: 'FINE' }, 'penalty_kind'],
        [{ penalty_kind: 'LIQUIDATED_DAMAGES' }, 'penalty_amount_vnd'],
        [{ penalty_kind: 'WARNING', penalty_amount_vnd: '5' }, 'penalty_amount_vnd'],
      ] as const) {
        const refused = await confirm(LEADER, noted.json.resource_id as string, 1, body);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', detail]);
      }
    });

    it('is the scope that decides: no right is 403, a contract that cannot be read is 404, one that is read but not recorded on is 403 SCOPE_DENIED', async () => {
      expect((await record(NOBODY)).status).toBe(403);
      expect((await record(READER)).status).toBe(403);
      expect((await record(ELSEWHERE)).status).toBe(404);
      expect((await record(SPLIT)).json.code).toBe('SCOPE_DENIED');
      expect((await record(SPLIT, {}, otherContractId)).status).toBe(200);
      const id = (await record(MAKER)).json.resource_id as string;
      expect((await confirm(ELSEWHERE, id, 1)).status).toBe(404);
      expect((await call('POST', `/violations/${id}/confirm`, { member: FOREIGN, tenant: TENANT_B, ifMatch: '"1"', body: { penalty_kind: 'NONE' } })).status).toBe(404);
    });
  });

  describe('the scorecard (CTR-23)', () => {
    it('lists the contracts, the evaluations with their weights and the log, and what the caller may do on each', async () => {
      const own = (await evaluate(ANALYST, { period_label: period() })).json.resource_id as string;
      const violation = (await record(ANALYST)).json.resource_id as string;
      const card = await scorecard(LEADER);
      expect(card.status).toBe(200);
      expect(card.json).toMatchObject({
        contractor: { id: fixtures.contractorId },
        rule: { key: 'CTR.SCORECARD', weights_pct: { quality: 30, schedule: 25, safety_env: 20, cooperation: 10, financial: 15 }, awaiting_confirmation: true, thresholds: [{ min: 90, rating: 'EXCELLENT' }, { min: 75, rating: 'GOOD' }, { min: 60, rating: 'FAIR' }] },
      });
      expect((card.json.contracts as Array<{ id: string; allowed: Record<string, boolean> }>).find((contract) => contract.id === contractId)).toMatchObject({ allowed: { evaluate: false, record_violation: false } });
      const evaluation = (card.json.evaluations as Array<{ id: string; allowed: { approve: boolean }; scores: Record<string, number>; overall_score: string }>).find((entry) => entry.id === own);
      expect(evaluation).toMatchObject({ scores: { quality: 80, schedule: 70, safety_env: 90, cooperation: 60, financial: 100 }, overall_score: '80.50', allowed: { approve: true } });
      expect((card.json.violations as Array<{ id: string; allowed: { confirm: boolean } }>).find((entry) => entry.id === violation)?.allowed).toEqual({ confirm: true });
      const analyst = await scorecard(ANALYST);
      expect((analyst.json.contracts as Array<{ id: string; allowed: Record<string, boolean> }>).find((contract) => contract.id === contractId)?.allowed).toEqual({ evaluate: true, record_violation: true });
      expect((analyst.json.evaluations as Array<{ id: string; allowed: { approve: boolean } }>).find((entry) => entry.id === own)?.allowed).toEqual({ approve: false });
      expect((analyst.json.violations as Array<{ id: string; allowed: { confirm: boolean } }>).find((entry) => entry.id === violation)?.allowed).toEqual({ confirm: false });
    });

    it('averages the approved evaluations that stand, to the hundredth, and counts the confirmed violations by severity', async () => {
      const contractor = (await rows<{ id: string }>('select id from machvon.contractor where id = $1::uuid', [fixtures.contractorId]))[0];
      expect(contractor).toBeDefined();
      const card = await scorecard(READER);
      const approved = (card.json.evaluations as Array<{ status: string; overall_score: string }>).filter((entry) => entry.status === 'APPROVED');
      const hundredths = approved.reduce((sum, entry) => sum + Number(entry.overall_score.replace('.', '')), 0);
      const expected = Math.floor((hundredths * 2 + approved.length) / (approved.length * 2));
      expect(card.json.summary).toMatchObject({ approved_count: approved.length, average_overall_score: `${Math.floor(expected / 100)}.${String(expected % 100).padStart(2, '0')}` });
      const confirmed = (card.json.violations as Array<{ status: string; severity: string }>).filter((entry) => entry.status === 'CONFIRMED');
      const bySeverity = (severity: string) => confirmed.filter((entry) => entry.severity === severity).length;
      expect((card.json.summary as { confirmed_violations: Record<string, number> }).confirmed_violations).toEqual({ MINOR: bySeverity('MINOR'), MAJOR: bySeverity('MAJOR'), CRITICAL: bySeverity('CRITICAL') });
    });

    it('counts the summary over everything in scope, not over the rows the lists hold: more than 500 approved evaluations are all in the count and the average', async () => {
      const many = (await fixtures.seedContract()).contractId;
      await adminStatement(
        fixtures,
        `insert into machvon.contractor_performance
           (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, revision, score_quality, score_schedule, score_safety_env, score_cooperation, score_financial, overall_score, rating, status, evaluated_by, approved_by, approved_at, created_by, updated_by)
         select $1, gen_random_uuid(), $2, $3, 'PERIODIC', 'BULK-' || n, 1, 50, 50, 50, 50, 50, 50.00, 'POOR', 'APPROVED', $4, $5, now(), $4, $4 from generate_series(1, 520) n`,
        [TENANT_A, many, fixtures.contractorId, memberId(MAKER), memberId(LEADER)],
      );
      try {
        const card = await scorecard(READER);
        expect((card.json.evaluations as unknown[]).length).toBe(500);
        const summary = card.json.summary as { approved_count: number; evaluation_count: number };
        expect(summary.evaluation_count).toBeGreaterThanOrEqual(520);
        const approvedBefore = (await rows<{ n: string }>("select count(*)::text as n from machvon.contractor_performance where contractor_id = $1::uuid and status = 'APPROVED'", [fixtures.contractorId]))[0]?.n;
        expect(summary.approved_count).toBe(Number(approvedBefore));
        const average = (await rows<{ a: string }>("select round(avg(overall_score), 2)::text as a from machvon.contractor_performance where contractor_id = $1::uuid and status = 'APPROVED'", [fixtures.contractorId]))[0]?.a;
        expect((card.json.summary as { average_overall_score: string }).average_overall_score).toBe(average);
      } finally {
        await adminStatement(fixtures, "delete from machvon.contractor_performance where contract_id = $1::uuid", [many]);
      }
    });

    it('lists the contractors that hold a contract the caller reads, by the permission of the scorecard alone: one who reads over another project sees the contractors of that project, a guest and a stranger see none', async () => {
      const list = await call('GET', '/contractor-scorecards', { member: READER });
      expect(list.status).toBe(200);
      const mine = (list.json.items as Array<{ id: string; legal_name: string; contract_count: number }>).find((item) => item.id === fixtures.contractorId);
      expect(mine?.contract_count).toBeGreaterThanOrEqual(2);
      const elsewhere = await call('GET', '/contractor-scorecards', { member: ELSEWHERE });
      expect((elsewhere.json.items as Array<{ id: string; contract_count: number }>).find((item) => item.id === fixtures.contractorId)?.contract_count).toBe(1);
      expect((await call('GET', '/contractor-scorecards', { member: GUEST })).status).toBe(403);
      expect((await call('GET', '/contractor-scorecards', { member: NOBODY })).status).toBe(403);
      const foreign = await call('GET', '/contractor-scorecards', { member: FOREIGN, tenant: TENANT_B });
      expect(foreign.json.items).toEqual([]);
    });

    it('limits the evaluations by the day they were made and the violations by the day they happened', async () => {
      const all = await scorecard(READER);
      const total = (all.json.violations as unknown[]).length;
      const none = await scorecard(READER, '?from=2000-01-01&to=2000-12-31');
      expect([none.json.evaluations, none.json.violations]).toEqual([[], []]);
      expect(none.json.summary).toMatchObject({ approved_count: 0, average_overall_score: null, confirmed_violations: { MINOR: 0, MAJOR: 0, CRITICAL: 0 } });
      const september = await scorecard(READER, '?from=2026-09-01&to=2026-09-30');
      expect((september.json.violations as unknown[]).length).toBeGreaterThan(0);
      expect((september.json.violations as unknown[]).length).toBeLessThanOrEqual(total);
      expect((await scorecard(READER, '?from=2026-09-30&to=2026-09-01')).json.code).toBe('VALIDATION_FAILED');
      expect((await scorecard(READER, '?from=yesterday')).json.code).toBe('VALIDATION_FAILED');
      expect((await scorecard(READER, '?to=2026-02-30')).json.code).toBe('VALIDATION_FAILED');
    });

    it('does not tell who a contractor is to one who reads none of its contracts: it is 404, and the name never leaves', async () => {
      const lone = randomUUID();
      await adminStatement(fixtures, "insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0999999999', 'Nhà thầu chỉ ở dự án khác', 'VERIFIED', gen_random_uuid())", [TENANT_A, lone]);
      const lent = (await fixtures.seedContract()).contractId;
      await adminStatement(fixtures, 'update machvon.contract set contractor_id = $2::uuid where id = $1::uuid', [lent, lone]);
      const seen = await scorecard(READER, '', lone);
      expect([seen.status, (seen.json.contractor as { legal_name: string }).legal_name]).toEqual([200, 'Nhà thầu chỉ ở dự án khác']);
      const hidden = await scorecard(ELSEWHERE, '', lone);
      expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(JSON.stringify(hidden.json)).not.toContain('Nhà thầu');
      expect((await scorecard(READER, '', randomUUID())).status).toBe(404);
    });

    it('shows only the contracts the caller reads, never to a guest contractor, to a stranger, or across tenants', async () => {
      expect((await scorecard(NOBODY)).status).toBe(403);
      expect((await scorecard(GUEST)).status).toBe(403);
      // Over another project, the caller reads the contracts of that project and nothing of this one.
      const elsewhere = await scorecard(ELSEWHERE);
      expect(elsewhere.status).toBe(200);
      expect((elsewhere.json.contracts as Array<{ id: string }>).map((contract) => contract.id)).toEqual([otherContractId]);
      for (const line of [...(elsewhere.json.evaluations as Array<{ contract_id: string }>), ...(elsewhere.json.violations as Array<{ contract_id: string }>)]) expect(line.contract_id).toBe(otherContractId);
      expect((await scorecard(READER, '', randomUUID())).status).toBe(404);
      expect((await scorecard(FOREIGN, '', fixtures.contractorId, TENANT_B)).status).toBe(404);
      const split = await scorecard(SPLIT);
      expect((split.json.contracts as Array<{ id: string; allowed: Record<string, boolean> }>).map((contract) => [contract.id === otherContractId, contract.allowed.evaluate])).toEqual(
        expect.arrayContaining([[true, true], [false, false]]),
      );
    });
  });

  describe('what the table keeps', () => {
    it('does not let what an evaluation says or what a violation says change, and never deletes either', async () => {
      const id = (await evaluate(MAKER, { period_label: period() })).json.resource_id as string;
      await expect(rows('update machvon.contractor_performance set score_quality = 10 where id = $1::uuid', [id])).rejects.toThrow('what an evaluation says never changes');
      await expect(rows("update machvon.contractor_performance set status = 'DRAFT' where id = $1::uuid", [id])).rejects.toThrow('this move of the status of an evaluation is not allowed');
      const violation = (await record(MAKER)).json.resource_id as string;
      await expect(rows("update machvon.contractor_violation set description = 'Other' where id = $1::uuid", [violation])).rejects.toThrow('what a violation says never changes');
      await expect(rows("update machvon.contractor_violation set status = 'CONFIRMED' where id = $1::uuid", [violation])).rejects.toThrow();
      expect((await rows<{ privilege: string }>("select privilege_type as privilege from information_schema.role_table_grants where grantee = 'machvon_app' and table_name in ('contractor_performance', 'contractor_violation') and privilege_type in ('DELETE', 'TRUNCATE')")).length).toBe(0);
    });
  });
});
