import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { audModule } from '../../src/modules/aud';
import { AuditConclusionController, AuditConclusionReadsController } from '../../src/modules/aud/conclusion.controller';
import { AuditEngagementController, AuditEngagementReadsController } from '../../src/modules/aud/engagement.controller';
import { AuditRecommendationController, AuditRecommendationReadsController } from '../../src/modules/aud/recommendation.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // registers the engagement and records its conclusion, findings and recommendations
const LEADER = 2; // aud.recommendation.assign and aud.read over the subtree of unit 2
const OWNER = 3; // aud.recommendation.execute and aud.read over the subtree of unit 2
const UNIT_MATE = 4; // the same, another person of the same unit
const VERIFIER = 5; // aud.recommendation.verify and aud.read over the whole tenant
const READER = 6; // aud.read over the whole tenant, nothing more
const OUTSIDER = 7; // assign, execute and verify over another branch, where the engagement is not
const OWNER_VERIFIER = 8; // both execute and verify: the owner who tries to verify their own work
const NOBODY = 9;
const B_MANAGER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x96;
const PROJECT = id(FAMILY, 1);
const DECISION = id(FAMILY, 10);
const CONCLUSION_DOCUMENT = id(FAMILY, 11);
const EVIDENCE = id(FAMILY, 12);
const EVIDENCE_PENDING = id(FAMILY, 13);
const EXPLANATION = id(FAMILY, 14);
const AUTHORITY_OPINION = id(FAMILY, 15);
const AUTHORITY_ATTACHMENT = id(FAMILY, 16);
const BASIS = id(FAMILY, 17);
const PERIOD = { period_from: '2025-01-01', period_to: '2025-12-31' };
const DEADLINE = '2099-12-31';
const REASON = 'The volumes were accepted on site by the supervisor of the works.';
const WORDS = [REASON, 'The evidence does not show the second payment.', 'Checked on site by the verifier.'];

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

describe('assignment, remediation, dispute and verification over HTTP (ST-AUD-003, AUD-06, AUD-07)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const today = vietnamDateOf(new Date());

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // The projects and documents belong to other modules: the superuser seeds them with the foreign keys switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** An engagement that is followed up with a conclusion of 1,250,000,000 due 2099-12-31 and the recommendations asked for (as ids, in order). */
  async function followed(types: Array<{ type?: string; amount?: string }> = [{ type: 'PROCESS_CORRECTION' }]): Promise<{ engagementId: string; conclusionId: string; ids: string[] }> {
    counter += 1;
    const made = await call('POST', '/audit-engagements', {
      member: MANAGER,
      body: {
        engagement_code: `RM-2026-${String(counter).padStart(3, '0')}`,
        engagement_type: 'STATE_AUDIT',
        authority_kind: 'STATE_AUDIT_OFFICE',
        authority_name: 'State Audit Office',
        decision_document_id: DECISION,
        title: 'Audit of the investment in the bridge',
        ...PERIOD,
        coordinator_user_id: memberId(MANAGER),
        scope: [{ kind: 'PROJECT', id: PROJECT }],
      },
    });
    const engagementId = idOf(made);
    await call('POST', `/audit-engagements/${engagementId}/start`, { member: MANAGER, ifMatch: '"1"', body: { started_on: '2026-10-20', place_legal_hold: false } });
    const conclusion = await call('POST', `/audit-engagements/${engagementId}/conclusions`, {
      member: MANAGER,
      ifMatch: '"2"',
      body: {
        conclusion_kind: 'AUDIT_REPORT',
        conclusion_document_id: CONCLUSION_DOCUMENT,
        issued_on: '2026-10-10',
        received_on: '2026-10-15',
        implementation_due_on: DEADLINE,
        summary: 'The audit found payments above the approved volumes.',
        total_financial_vnd: '1250000000',
      },
    });
    const conclusionId = idOf(conclusion);
    const ids: string[] = [];
    for (const item of types) {
      counter += 1;
      const type = item.type ?? 'PROCESS_CORRECTION';
      const created = await call('POST', `/audit-conclusions/${conclusionId}/recommendations`, {
        member: MANAGER,
        body: { rec_code: `R-${counter}`, rec_type: type, description: 'Correct the process of payment of the works.', ...(type.startsWith('FINANCIAL') ? { amount_vnd: item.amount ?? '400000000' } : {}) },
      });
      ids.push(idOf(created));
    }
    return { engagementId, conclusionId, ids };
  }

  const version = async (recommendationId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.audit_recommendation where id = $1', [recommendationId]))[0]?.version);
  const status = async (recommendationId: string): Promise<string> => (await rows<{ status: string }>('select status from machvon.audit_recommendation where id = $1', [recommendationId]))[0]?.status as string;
  const on = async (recommendationId: string, member: number, action: string, body: Record<string, unknown> = {}, extra: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/audit-recommendations/${recommendationId}/${action}`, { member, ifMatch: `"${await version(recommendationId)}"`, body, ...extra });
  const assign = (recommendationId: string, member = LEADER, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}) =>
    on(recommendationId, member, 'assignment', { owner_unit_id: unitId(DEPARTMENT), owner_user_id: memberId(OWNER), due_on: today, ...extra }, options);
  const plan = (recommendationId: string, member = OWNER, code = 'A-1') => on(recommendationId, member, 'actions', { action_code: code, description: 'Correct the process of payment.', planned_on: today });
  const complete = (actionId: string, member = OWNER, evidence = EVIDENCE, completedOn = today, ifMatch = '"1"') =>
    call('POST', `/audit-remediation-actions/${actionId}/completion`, { member, ifMatch, body: { completed_on: completedOn, evidence_document_id: evidence } });
  const submit = (recommendationId: string, member = OWNER) => on(recommendationId, member, 'verification-request', {}, {});
  const verify = (recommendationId: string, member: number, decision: 'CLOSE' | 'RETURN', extra: Record<string, unknown> = {}) => on(recommendationId, member, 'verification', { decision, ...extra });
  const dispute = (recommendationId: string, member = OWNER, extra: Record<string, unknown> = {}) => on(recommendationId, member, 'dispute', { dispute_reason: REASON, dispute_document_id: EXPLANATION, ...extra });
  const decide = (recommendationId: string, member = VERIFIER, outcome = 'ACCEPTED_BY_AUTHORITY', document = AUTHORITY_OPINION) =>
    on(recommendationId, member, 'dispute-decision', { outcome, authority_document_id: document });
  const attach = (member: number, ownerKind: string, ownerId: string, documentId = EVIDENCE, extra: Partial<CallOptions> = {}) =>
    call('POST', '/audit-evidence', { member, body: { owner_kind: ownerKind, owner_id: ownerId, document_id: documentId, note: 'A working document.' }, ...extra });
  const trail = (resourceId: string): Promise<Array<{ action: string; classification: string; safe_diff: Record<string, unknown> }>> =>
    rows('select action, classification, safe_diff from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [resourceId]);
  const events = (aggregateId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> =>
    rows('select type, payload from machvon.outbox_event where aggregate_id::text = $1 order by created_at, id', [aggregateId]);

  /** A recommendation given to the owner, in progress with an action, as ids. */
  async function working(type = 'PROCESS_CORRECTION', amount?: string): Promise<{ engagementId: string; conclusionId: string; recommendationId: string; actionId: string }> {
    const made = await followed([{ type, amount }]);
    const recommendationId = made.ids[0] as string;
    expect((await assign(recommendationId)).status).toBe(200);
    const planned = await plan(recommendationId);
    expect(planned.status).toBe(200);
    return { ...made, recommendationId, actionId: idOf(planned) };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MANAGER, LEADER, OWNER, UNIT_MATE, VERIFIER, READER, OUTSIDER, OWNER_VERIFIER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MANAGER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'AUD_MANAGER', ['aud.engagement.manage', 'aud.conclusion.record', 'aud.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'AUD_LEADER', ['aud.recommendation.assign', 'aud.read'], 40);
    await harness.seedRole(TENANT_A, 3, 'AUD_OWNER', ['aud.recommendation.execute', 'aud.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'AUD_VERIFIER', ['aud.recommendation.verify', 'aud.read'], 40);
    await harness.seedRole(TENANT_A, 5, 'AUD_READER', ['aud.read'], 20);
    await harness.seedRole(TENANT_A, 6, 'AUD_ALL', ['aud.recommendation.assign', 'aud.recommendation.execute', 'aud.recommendation.verify', 'aud.read'], 40);
    await harness.seedRole(TENANT_A, 7, 'AUD_OWNER_VERIFIER', ['aud.recommendation.execute', 'aud.recommendation.verify', 'aud.read'], 40);
    await harness.seedRole(TENANT_B, 1, 'AUD_ALL', ['aud.engagement.manage', 'aud.conclusion.record', 'aud.recommendation.assign', 'aud.recommendation.execute', 'aud.recommendation.verify', 'aud.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: LEADER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: OWNER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 4, member: UNIT_MATE, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 5, member: VERIFIER, role: 4, kind: 'TENANT' },
      { n: 6, member: READER, role: 5, kind: 'TENANT' },
      { n: 7, member: OUTSIDER, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 8, member: OWNER_VERIFIER, role: 7, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MANAGER, role: 1, kind: 'TENANT' }]);
    await seedAs([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-A-001', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, unitId(DEPARTMENT), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, document_number, number_year, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/QD-KTNN', '2026-01-15', 'EFFECTIVE', 'INTERNAL', null, null, $10, $10),
                ($1, $3, 'INCOMING', 'KL', 'Audit report on the bridge', '88/BC-KTNN', '2026-10-10', 'EFFECTIVE', 'INTERNAL', 88, 2026, $10, $10),
                ($1, $4, 'ATTACHMENT', 'BC', 'Evidence of the correction', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $10, $10),
                ($1, $5, 'ATTACHMENT', 'BC', 'Evidence not in force', null, null, 'PENDING', 'INTERNAL', null, null, $10, $10),
                ($1, $6, 'ATTACHMENT', 'BC', 'Explanation of the owner', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $10, $10),
                ($1, $7, 'INCOMING', 'KL', 'Opinion of the authority', '91/CV-KTNN', '2026-10-20', 'EFFECTIVE', 'INTERNAL', 91, 2026, $10, $10),
                ($1, $8, 'ATTACHMENT', 'BC', 'An attachment, not an opinion', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $10, $10),
                ($1, $9, 'ATTACHMENT', 'BC', 'Basis of closure', null, null, 'EFFECTIVE', 'INTERNAL', null, null, $10, $10)`,
        [TENANT_A, DECISION, CONCLUSION_DOCUMENT, EVIDENCE, EVIDENCE_PENDING, EXPLANATION, AUTHORITY_OPINION, AUTHORITY_ATTACHMENT, BASIS, memberId(MANAGER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [
        AuditEngagementController,
        AuditEngagementReadsController,
        AuditConclusionController,
        AuditConclusionReadsController,
        AuditRecommendationController,
        AuditRecommendationReadsController,
      ],
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

  it('serves the recommendation controllers in the module of AUD', () => {
    expect(audModule.controllers.slice(4, 6)).toEqual([AuditRecommendationController, AuditRecommendationReadsController]);
  });

  describe('assignAuditRecommendation (AC-ST-AUD-003-1)', () => {
    it('AC-ST-AUD-003-1 / UAT-AC435: 200 ASSIGNED for an owner in scope, 422 OWNER_OUT_OF_SCOPE for a unit outside it, 404 for a unit of another tenant and 422 DUE_AFTER_CONCLUSION_DEADLINE for a day after the deadline', async () => {
      const made = await followed([{}, {}, {}, {}]);
      const [inScope, outOfScope, foreign, late] = made.ids as [string, string, string, string];
      const ok = await assign(inScope, LEADER, { due_on: DEADLINE });
      expect(ok).toMatchObject({ status: 200, json: { status: 'ASSIGNED' } });
      expect(await status(inScope)).toBe('ASSIGNED');
      expect(await assign(outOfScope, LEADER, { owner_unit_id: unitId(ELSEWHERE) })).toMatchObject({ status: 422, json: { code: 'OWNER_OUT_OF_SCOPE' } });
      expect(await assign(foreign, LEADER, { owner_unit_id: randomUUID() })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await assign(late, LEADER, { due_on: '2100-01-01' })).toMatchObject({ status: 422, json: { code: 'DUE_AFTER_CONCLUSION_DEADLINE', implementation_due_on: DEADLINE } });
      expect(await assign(late, LEADER, { due_on: '2020-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      for (const untouched of [outOfScope, foreign, late]) expect(await status(untouched)).toBe('OPEN');
      const event = (await events(inScope)).find((candidate) => candidate.type === 'aud.recommendation.assigned.v1');
      expect(event).toMatchObject({ type: 'aud.recommendation.assigned.v1', payload: { recommendation_id: inScope, owner_unit_id: unitId(DEPARTMENT), owner_user_id: memberId(OWNER), due_on: DEADLINE } });
      const entry = (await trail(inScope)).find((candidate) => candidate.action === 'aud.recommendation_assigned');
      expect(entry).toMatchObject({ action: 'aud.recommendation_assigned', classification: 'CONFIDENTIAL', safe_diff: { from_status: 'OPEN', to_status: 'ASSIGNED' } });
    });

    it('answers a replay with the first body, refuses a stale version (409), and a person who is not a member (422)', async () => {
      const made = await followed();
      const recommendationId = made.ids[0] as string;
      const first = await assign(recommendationId, LEADER, {}, { key: 'assign-replay-key', ifMatch: '"1"' });
      const again = await assign(recommendationId, LEADER, {}, { key: 'assign-replay-key', ifMatch: '"1"' });
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(again.json).toEqual(first.json);
      expect((await assign(recommendationId, LEADER, {}, { ifMatch: '"1"' })).json.code).toBe('VERSION_CONFLICT');
      expect(await assign(recommendationId, LEADER, { owner_user_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await assign(recommendationId, LEADER, { create_issue: true })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    });

    it('refuses a recommendation that is already in progress (409), and a reader, an owner and nobody (403), and does not find it outside the scope (404)', async () => {
      const work = await working();
      expect(await assign(work.recommendationId)).toMatchObject({ status: 409, json: { code: 'RECOMMENDATION_STATE_INVALID' } });
      const made = await followed();
      for (const member of [READER, OWNER, VERIFIER, NOBODY]) expect((await assign(made.ids[0] as string, member)).status).toBe(403);
      expect((await assign(made.ids[0] as string, OUTSIDER)).status).toBe(404);
      expect((await call('POST', `/audit-recommendations/${made.ids[0]}/assignment`, { member: B_MANAGER, tenantId: TENANT_B, ifMatch: '"1"', body: { owner_unit_id: unitId(DEPARTMENT), due_on: today } })).status).toBe(404);
    });

    it('does not let an engagement that is closed move its recommendations (409 ENGAGEMENT_STATE_INVALID)', async () => {
      const made = await followed();
      await rows("update machvon.audit_engagement set status = 'CLOSED', closed_on = '2026-10-26' where id = $1", [made.engagementId]);
      expect(await assign(made.ids[0] as string)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
    });
  });

  describe('the owner does the work (AC-ST-AUD-003-2)', () => {
    it('AC-ST-AUD-003-2 / UAT-AC436: 422 EVIDENCE_REQUIRED without evidence in force, DONE with it, PENDING_VERIFICATION, 403 SELF_APPROVAL_DENIED for the owner and CLOSED with verified_by for a verifier', async () => {
      const work = await working();
      expect(await complete(work.actionId, OWNER, EVIDENCE_PENDING)).toMatchObject({ status: 422, json: { code: 'EVIDENCE_REQUIRED' } });
      expect(await complete(work.actionId, OWNER, randomUUID())).toMatchObject({ status: 422, json: { code: 'EVIDENCE_REQUIRED' } });
      const done = await complete(work.actionId);
      expect(done).toMatchObject({ status: 200, json: { status: 'DONE', resource_version: 2 } });
      expect((await events(work.actionId))[0]).toMatchObject({ type: 'aud.action.completed.v1', payload: { action_id: work.actionId, evidence_document_id: EVIDENCE, completed_on: today } });
      const submitted = await submit(work.recommendationId);
      expect(submitted).toMatchObject({ status: 200, json: { status: 'PENDING_VERIFICATION' } });
      expect(await status(work.recommendationId)).toBe('PENDING_VERIFICATION');
      // the owner holds the permission to verify too: the separation of duties is what stops them
      await rows('update machvon.audit_recommendation set owner_user_id = $2 where id = $1', [work.recommendationId, memberId(OWNER_VERIFIER)]);
      await rows('update machvon.audit_recommendation set submitted_by = $2 where id = $1', [work.recommendationId, memberId(OWNER_VERIFIER)]);
      expect(await verify(work.recommendationId, OWNER_VERIFIER, 'CLOSE')).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await verify(work.recommendationId, OWNER, 'CLOSE')).toMatchObject({ status: 403 });
      const closed = await verify(work.recommendationId, VERIFIER, 'CLOSE', { comment: WORDS[2] });
      expect(closed).toMatchObject({ status: 200, json: { status: 'CLOSED' } });
      expect(await rows('select status, verified_by from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([{ status: 'CLOSED', verified_by: memberId(VERIFIER) }]);
      const types = (await events(work.recommendationId)).map((event) => event.type);
      expect(types).toEqual(['aud.recommendation.created.v1', 'aud.recommendation.assigned.v1', 'aud.action.planned.v1', 'aud.recommendation.submitted.v1', 'aud.recommendation.closed.v1']);
    });

    it('is the owner only: another person of the unit is 422 NOT_OWNER when a person was named, anyone of the unit may when none was, a reader and an outsider cannot', async () => {
      const made = await followed([{}, {}]);
      const [named, byUnit] = made.ids as [string, string];
      await assign(named);
      await assign(byUnit, LEADER, { owner_user_id: undefined });
      expect(await plan(named, UNIT_MATE)).toMatchObject({ status: 422, json: { code: 'NOT_OWNER' } });
      expect(await plan(byUnit, UNIT_MATE, 'A-1')).toMatchObject({ status: 200 });
      expect(await plan(byUnit, OWNER, 'A-2')).toMatchObject({ status: 200 });
      expect((await plan(named, READER)).status).toBe(403);
      expect((await plan(named, OUTSIDER)).status).toBe(404);
      expect((await plan(named, LEADER)).status).toBe(403);
      expect(await status(named)).toBe('ASSIGNED');
      expect(await plan(named, OWNER)).toMatchObject({ status: 200 });
      expect(await status(named)).toBe('IN_PROGRESS');
    });

    it('refuses the report while an action is planned (422 OPEN_ACTIONS_REMAIN) and a financial one until it is recovered (422 RECOVERY_INCOMPLETE with the figures)', async () => {
      const work = await working('FINANCIAL_RECOVERY', '400000000');
      expect(await submit(work.recommendationId)).toMatchObject({ status: 422, json: { code: 'OPEN_ACTIONS_REMAIN' } });
      await complete(work.actionId);
      await rows('update machvon.audit_recommendation set recovered_vnd = 300000000 where id = $1', [work.recommendationId]);
      expect(await submit(work.recommendationId)).toMatchObject({ status: 422, json: { code: 'RECOVERY_INCOMPLETE', amount_vnd: '400000000', recovered_vnd: '300000000', remaining_vnd: '100000000' } });
      await rows('update machvon.audit_recommendation set recovered_vnd = 400000000 where id = $1', [work.recommendationId]);
      expect(await submit(work.recommendationId)).toMatchObject({ status: 200 });
    });

    it('answers a duplicate action code (409), a stale version of the action (409) and a second completion (409 ACTION_STATE_INVALID)', async () => {
      const work = await working();
      expect(await plan(work.recommendationId, OWNER, 'A-1')).toMatchObject({ status: 409, json: { code: 'ACTION_CODE_DUPLICATE' } });
      expect(await complete(work.actionId, OWNER, EVIDENCE, today, '"7"')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await complete(work.actionId, OWNER, EVIDENCE, '2999-01-01')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      await complete(work.actionId);
      expect(await complete(work.actionId, OWNER, EVIDENCE, today, '"2"')).toMatchObject({ status: 409, json: { code: 'ACTION_STATE_INVALID' } });
    });

    it('does not find an action of another tenant or outside the scope (404)', async () => {
      const work = await working();
      expect((await complete(work.actionId, OUTSIDER)).status).toBe(404);
      expect((await call('POST', `/audit-remediation-actions/${work.actionId}/completion`, { member: B_MANAGER, tenantId: TENANT_B, ifMatch: '"1"', body: { completed_on: today, evidence_document_id: EVIDENCE } })).status).toBe(404);
      expect((await complete(randomUUID())).status).toBe(404);
    });
  });

  describe('verifying and returning', () => {
    it('sends the work back with the words of the verifier (422 without them) and the owner reports it again; a verifier of another branch does not find it (404)', async () => {
      const work = await working();
      await complete(work.actionId);
      await submit(work.recommendationId);
      expect(await verify(work.recommendationId, OUTSIDER, 'RETURN', { comment: WORDS[1] })).toMatchObject({ status: 404 });
      expect(await verify(work.recommendationId, VERIFIER, 'RETURN', { comment: 'short' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await verify(work.recommendationId, VERIFIER, 'RETURN', { comment: WORDS[1] })).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
      expect((await events(work.recommendationId)).at(-1)).toMatchObject({ type: 'aud.recommendation.returned.v1', payload: { decision: 'RETURN' } });
      expect(await submit(work.recommendationId)).toMatchObject({ status: 200 });
      expect(await verify(work.recommendationId, READER, 'CLOSE')).toMatchObject({ status: 403 });
      expect(await verify(work.recommendationId, VERIFIER, 'CLOSE', { closure_basis_document_id: EVIDENCE_PENDING })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_EFFECTIVE' } });
      expect(await verify(work.recommendationId, VERIFIER, 'CLOSE', { closure_basis_document_id: BASIS })).toMatchObject({ status: 200, json: { status: 'CLOSED' } });
    });

    it('lets one verifier close it when two try at the same time: the other finds it closed (409)', async () => {
      const work = await working();
      await complete(work.actionId);
      await submit(work.recommendationId);
      const expected = await version(work.recommendationId);
      const replies = await Promise.all([0, 1].map(() => call('POST', `/audit-recommendations/${work.recommendationId}/verification`, { member: VERIFIER, ifMatch: `"${expected}"`, body: { decision: 'CLOSE' } })));
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(await status(work.recommendationId)).toBe('CLOSED');
    });
  });

  describe('disputing (AC-ST-AUD-003-3)', () => {
    it('AC-ST-AUD-003-3 / UAT-AC441: a financial recommendation of 400,000,000 with 300,000,000 recovered closes once the authority accepted the dispute; the decision without a document of the authority in force is 422 DECISION_DOCUMENT_NOT_EFFECTIVE', async () => {
      const work = await working('FINANCIAL_RECOVERY', '400000000');
      await rows('update machvon.audit_recommendation set recovered_vnd = 300000000 where id = $1', [work.recommendationId]);
      expect(await dispute(work.recommendationId, OWNER, { dispute_reason: 'too short' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await dispute(work.recommendationId, OWNER, { dispute_document_id: EVIDENCE_PENDING })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_EFFECTIVE' } });
      expect(await dispute(work.recommendationId)).toMatchObject({ status: 200, json: { status: 'DISPUTED' } });
      for (const document of [AUTHORITY_ATTACHMENT, EVIDENCE_PENDING, randomUUID()]) {
        expect(await decide(work.recommendationId, VERIFIER, 'ACCEPTED_BY_AUTHORITY', document)).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_NOT_EFFECTIVE' } });
      }
      expect(await decide(work.recommendationId, OWNER)).toMatchObject({ status: 403 });
      expect(await decide(work.recommendationId)).toMatchObject({ status: 200, json: { status: 'PENDING_VERIFICATION' } });
      expect(await verify(work.recommendationId, VERIFIER, 'CLOSE')).toMatchObject({ status: 200, json: { status: 'CLOSED' } });
      expect(await rows('select status, recovered_vnd::text as recovered, dispute_outcome from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([
        { status: 'CLOSED', recovered: '300000000', dispute_outcome: 'ACCEPTED_BY_AUTHORITY' },
      ]);
      const types = (await events(work.recommendationId)).map((event) => event.type);
      expect(types).toEqual(['aud.recommendation.created.v1', 'aud.recommendation.assigned.v1', 'aud.action.planned.v1', 'aud.recommendation.disputed.v1', 'aud.recommendation.dispute_decided.v1', 'aud.recommendation.closed.v1']);
    });

    it('sends the recommendation back to work when the authority rejects the dispute, and keeps the old day', async () => {
      const work = await working();
      await dispute(work.recommendationId);
      expect(await plan(work.recommendationId, OWNER, 'A-2')).toMatchObject({ status: 409, json: { code: 'RECOMMENDATION_STATE_INVALID' } });
      expect(await decide(work.recommendationId, VERIFIER, 'REJECTED_BY_AUTHORITY')).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
      expect(await rows('select due_on::text as due_on, dispute_outcome from machvon.audit_recommendation where id = $1', [work.recommendationId])).toEqual([{ due_on: today, dispute_outcome: 'REJECTED_BY_AUTHORITY' }]);
      expect(await dispute(work.recommendationId, UNIT_MATE)).toMatchObject({ status: 422, json: { code: 'NOT_OWNER' } });
    });
  });

  describe('attachAuditEvidence', () => {
    it('puts a document in force in the register of an engagement, a recommendation or an action, once; the owner of the work only for the work', async () => {
      const work = await working();
      expect(await attach(OWNER, 'ENGAGEMENT', work.engagementId)).toMatchObject({ status: 200, json: { status: 'ATTACHED' } });
      const again = await attach(OWNER, 'ENGAGEMENT', work.engagementId);
      expect(again.status).toBe(200);
      expect((await rows<{ n: string }>('select count(*) as n from machvon.audit_evidence where owner_id = $1', [work.engagementId]))[0]?.n).toBe('1');
      expect(await attach(OWNER, 'ACTION', work.actionId)).toMatchObject({ status: 200 });
      expect(await attach(OWNER, 'RECOMMENDATION', work.recommendationId)).toMatchObject({ status: 200 });
      expect(await attach(UNIT_MATE, 'RECOMMENDATION', work.recommendationId)).toMatchObject({ status: 422, json: { code: 'NOT_OWNER' } });
      expect(await rows("select audit_evidence.owner_kind from machvon.audit_evidence where owner_id = any($1::uuid[]) order by owner_kind", [[work.actionId, work.recommendationId]])).toEqual([
        { owner_kind: 'ACTION' },
        { owner_kind: 'RECOMMENDATION' },
      ]);
      const [entry] = await trail((await rows<{ id: string }>('select id from machvon.audit_evidence where owner_id = $1', [work.actionId]))[0]?.id as string);
      expect(entry).toMatchObject({ action: 'aud.evidence_attached', classification: 'CONFIDENTIAL', safe_diff: { owner_kind: 'ACTION', document_id: EVIDENCE } });
    });

    it('refuses a document that is not in force (422), the owner of an object it does not own (422 NOT_OWNER), a reader (403), and does not find an object of another tenant or outside the scope (404)', async () => {
      const work = await working();
      await rows('update machvon.audit_recommendation set owner_user_id = $2 where id = $1', [work.recommendationId, memberId(OWNER)]);
      expect(await attach(OWNER, 'RECOMMENDATION', work.recommendationId, EVIDENCE_PENDING)).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_EFFECTIVE' } });
      expect(await attach(UNIT_MATE, 'ACTION', work.actionId)).toMatchObject({ status: 422, json: { code: 'NOT_OWNER' } });
      expect((await attach(READER, 'ENGAGEMENT', work.engagementId)).status).toBe(403);
      expect((await attach(READER, 'RECOMMENDATION', work.recommendationId)).status).toBe(403);
      expect((await attach(OUTSIDER, 'ENGAGEMENT', work.engagementId)).status).toBe(404);
      expect((await attach(B_MANAGER, 'ENGAGEMENT', work.engagementId, EVIDENCE, { tenantId: TENANT_B })).status).toBe(404);
      expect((await attach(OWNER, 'FINDING', randomUUID())).status).toBe(404);
      expect((await attach(OWNER, 'ACTION', randomUUID())).status).toBe(404);
    });
  });

  describe('what the trail and the events keep, and who reads what', () => {
    it('keeps the words of the owner, the verifier and the authority out of the trail and the events', async () => {
      const work = await working();
      await dispute(work.recommendationId);
      await decide(work.recommendationId, VERIFIER, 'REJECTED_BY_AUTHORITY');
      await complete(work.actionId);
      await submit(work.recommendationId);
      await verify(work.recommendationId, VERIFIER, 'RETURN', { comment: WORDS[1] });
      await submit(work.recommendationId);
      await verify(work.recommendationId, VERIFIER, 'CLOSE', { comment: WORDS[2] });
      const trails = await rows<{ action: string; classification: string; safe_diff: unknown }>(
        "select action, classification, safe_diff from machvon.audit_event where action like 'aud.recommendation_%' and resource_id::text = $1 or action like 'aud.action_%' and safe_diff ->> 'recommendation_id' = $1 or action = 'aud.action_planned' and resource_id::text = $1",
        [work.recommendationId],
      );
      expect(trails.length).toBeGreaterThanOrEqual(8);
      expect(trails.every((entry) => entry.classification === 'CONFIDENTIAL')).toBe(true);
      const emitted = await rows<{ payload: unknown }>("select payload from machvon.outbox_event where type like 'aud.%' and (aggregate_id::text = $1 or payload ->> 'recommendation_id' = $1)", [work.recommendationId]);
      expect(emitted.length).toBeGreaterThanOrEqual(8);
      for (const text of [JSON.stringify(trails), JSON.stringify(emitted)]) for (const words of WORDS) expect(text).not.toContain(words);
    });

    it('lists the recommendations with the owner, the day and the actions to whoever reads in the scope, filters them, and answers nothing to an outsider or another tenant', async () => {
      const work = await working();
      await complete(work.actionId);
      const listed = await call('GET', `/audit-recommendations?conclusion_id=${work.conclusionId}`, { member: READER });
      expect(listed.json.items).toEqual([
        expect.objectContaining({
          id: work.recommendationId,
          engagement: expect.objectContaining({ id: work.engagementId }),
          owner_unit: expect.objectContaining({ id: unitId(DEPARTMENT) }),
          owner_user: { id: memberId(OWNER), display_name: expect.any(String) },
          due_on: today,
          status: 'IN_PROGRESS',
          is_overdue: false,
          evidence_count: 1,
          actions: [expect.objectContaining({ id: work.actionId, action_code: 'A-1', status: 'DONE', completed_on: today, evidence_document_id: EVIDENCE, version: 2 })],
        }),
      ]);
      expect((await call('GET', `/audit-recommendations?conclusion_id=${work.conclusionId}&status=IN_PROGRESS&owner_unit_id=${unitId(DEPARTMENT)}&overdue=false`, { member: OWNER })).json.items).toHaveLength(1);
      expect((await call('GET', `/audit-recommendations?conclusion_id=${work.conclusionId}&status=CLOSED`, { member: OWNER })).json.items).toEqual([]);
      expect((await call('GET', `/audit-recommendations?conclusion_id=${work.conclusionId}`, { member: OUTSIDER })).json.items).toEqual([]);
      expect((await call('GET', `/audit-recommendations?conclusion_id=${work.conclusionId}`, { member: B_MANAGER, tenantId: TENANT_B })).json.items).toEqual([]);
      expect((await call('GET', '/audit-recommendations', { member: NOBODY })).status).toBe(403);
    });
  });
});
