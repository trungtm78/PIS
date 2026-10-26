import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { audModule } from '../../src/modules/aud';
import { AuditRecoveryController, AuditRecoveryReadsController } from '../../src/modules/aud/recovery.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const ACCOUNTANT = 1; // aud.recovery.record and aud.read over the whole tenant
const ACCOUNTANT_TWO = 2;
const READER = 3; // aud.read over the whole tenant
const OUTSIDER = 4; // record and read over another branch, where the engagement is not
const NOBODY = 5;
const B_ACCOUNTANT = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x99;
const PROJECT = id(FAMILY, 1);
const DECISION = id(FAMILY, 10);
const EVIDENCE = id(FAMILY, 11);
const EVIDENCE_PENDING = id(FAMILY, 12);
const REASON = 'The voucher of the Treasury was entered twice by mistake.';

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

/** The ledger of the recoveries over HTTP (ST-AUD-004, AUD-08, AUD-01): the accountant links what PAY does not report and puts a mistake right by a line of the opposite sign. */
describe('the ledger of recoveries over HTTP (ST-AUD-004, AUD-08, AUD-01)', () => {
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
      // The project and the documents belong to other modules: the superuser seeds them with the foreign keys switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** An engagement that is followed up with its conclusion, and one recommendation of the kind, the amount and the status asked for. */
  async function seed(options: { type?: string; amount?: string | null; closed?: boolean; cancelled?: boolean } = {}): Promise<{ engagementId: string; recommendationId: string }> {
    counter += 1;
    const engagementId = randomUUID();
    const conclusionId = randomUUID();
    const recommendationId = randomUUID();
    const amount = options.amount === undefined ? '800000000' : options.amount;
    await rows(
      `insert into machvon.audit_engagement (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on, classification, created_by, updated_by, version)
       values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'State Audit Office', $4, 'Audit of the bridge', date '2025-01-01', date '2025-12-31', $5, 'FOLLOW_UP', date '2026-10-01', 'CONFIDENTIAL', $5, $5, 3)`,
      [TENANT_A, engagementId, `RV-${counter}`, DECISION, memberId(ACCOUNTANT)],
    );
    await rows(
      `insert into machvon.audit_scope_item (tenant_id, id, engagement_id, scope_kind, project_id, added_by) values ($1, gen_random_uuid(), $2, 'PROJECT', $3, $4)`,
      [TENANT_A, engagementId, PROJECT, memberId(ACCOUNTANT)],
    );
    await rows(
      `insert into machvon.audit_conclusion (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, summary, total_financial_vnd, status, created_by, updated_by, version)
       values ($1, $2, $3, 'AUDIT_REPORT', $4, 1, date '2026-10-10', date '2026-10-15', 'The audit found payments above the approved volumes.', 2000000000, 'RECEIVED', $5, $5, 1)`,
      [TENANT_A, conclusionId, engagementId, DECISION, memberId(ACCOUNTANT)],
    );
    await rows(
      `insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, status, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, 'Recover what was paid above the volume.', $6::numeric, 'OPEN', $7, $7, 1)`,
      [TENANT_A, recommendationId, conclusionId, `R-${counter}`, options.type ?? 'FINANCIAL_RECOVERY', amount, memberId(ACCOUNTANT)],
    );
    if (options.closed === true) {
      await rows("update machvon.audit_recommendation set status = 'ASSIGNED', owner_unit_id = $2, due_on = date '2026-12-01' where id = $1", [recommendationId, unitId(DEPARTMENT)]);
      await rows("update machvon.audit_recommendation set status = 'IN_PROGRESS' where id = $1", [recommendationId]);
      await rows("update machvon.audit_recommendation set status = 'PENDING_VERIFICATION', submitted_by = $2 where id = $1", [recommendationId, memberId(ROOT + 5)]);
      await rows("update machvon.audit_recommendation set status = 'CLOSED', verified_by = $2, verified_at = now() where id = $1", [recommendationId, memberId(ROOT + 6)]);
    }
    if (options.cancelled === true) await rows("update machvon.audit_recommendation set status = 'CANCELLED' where id = $1", [recommendationId]);
    return { engagementId, recommendationId };
  }

  const version = async (recommendationId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.audit_recommendation where id = $1', [recommendationId]))[0]?.version);
  const state = async (recommendationId: string) => (await rows<{ status: string; recovered: string }>('select status, recovered_vnd::text as recovered from machvon.audit_recommendation where id = $1', [recommendationId]))[0] as { status: string; recovered: string };
  const lines = (recommendationId: string) => rows<{ amount: string; source_kind: string; reversal_of_id: string | null }>('select amount_vnd::text as amount, source_kind, reversal_of_id from machvon.audit_recovery_link where recommendation_id = $1 order by recorded_at, id', [recommendationId]);
  const ledger = (recommendationId: string, amount: string, sourceKind = 'PAY_RECOVERY') =>
    rows(
      `insert into machvon.audit_recovery_link (tenant_id, id, recommendation_id, source_kind, source_id, amount_vnd, recorded_on, recorded_by) values ($1, gen_random_uuid(), $2::uuid, $3, gen_random_uuid(), $4::numeric, date '2026-10-01', $5::uuid)`,
      [TENANT_A, recommendationId, sourceKind, amount, memberId(ACCOUNTANT)],
    );

  const link = async (recommendationId: string, member = ACCOUNTANT, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/audit-recommendations/${recommendationId}/recoveries`, {
      member,
      ifMatch: `"${await version(recommendationId)}"`,
      body: { source_kind: 'MANUAL_EVIDENCE', amount_vnd: '300000000', recorded_on: today, evidence_document_id: EVIDENCE, ...extra },
      ...options,
    });
  const reverse = (linkId: string, member = ACCOUNTANT, reason: string | undefined = REASON, options: Partial<CallOptions> = {}) =>
    call('POST', `/audit-recovery-links/${linkId}/reversal`, { member, body: { reason }, ...options });
  const trail = (resourceId: string) => rows<{ action: string; classification: string; safe_diff: Record<string, unknown> }>('select action, classification, safe_diff from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [resourceId]);
  const events = (aggregateId: string) => rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id::text = $1 order by created_at, id', [aggregateId]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [ACCOUNTANT, ACCOUNTANT_TWO, READER, OUTSIDER, NOBODY, 6, 7]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ACCOUNTANT, ROOT);
    await harness.seedRole(TENANT_A, 1, 'AUD_ACCOUNTANT', ['aud.recovery.record', 'aud.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'AUD_READER', ['aud.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'AUD_ACCOUNTANT', ['aud.recovery.record', 'aud.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ACCOUNTANT, role: 1, kind: 'TENANT' },
      { n: 2, member: ACCOUNTANT_TWO, role: 1, kind: 'TENANT' },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
      { n: 4, member: OUTSIDER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ACCOUNTANT, role: 1, kind: 'TENANT' }]);
    await seedAs([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-A-001', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, unitId(DEPARTMENT), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/QD-KTNN', '2026-01-15', 'EFFECTIVE', 'INTERNAL', $5, $5),
                ($1, $3, 'ATTACHMENT', 'BC', 'The voucher of the Treasury', null, null, 'EFFECTIVE', 'INTERNAL', $5, $5),
                ($1, $4, 'ATTACHMENT', 'BC', 'A voucher not in force', null, null, 'PENDING', 'INTERNAL', $5, $5)`,
        [TENANT_A, DECISION, EVIDENCE, EVIDENCE_PENDING, memberId(ACCOUNTANT)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AuditRecoveryController, AuditRecoveryReadsController],
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

  it('serves the controllers of the ledger in the module of AUD', () => {
    expect(audModule.controllers.slice(-4, -2)).toEqual([AuditRecoveryController, AuditRecoveryReadsController]);
  });

  describe('linkAuditRecovery', () => {
    it('AC-ST-AUD-004-1 / UAT-AC437: 500,000,000 from PAY and 300,000,000 linked by hand make 800,000,000; the summary shows nothing left to recover and the rate with its numerator and denominator', async () => {
      const made = await seed();
      await ledger(made.recommendationId, '500000000');
      const done = await link(made.recommendationId);
      expect(done).toMatchObject({ status: 200, json: { status: 'LINKED' } });
      expect(await state(made.recommendationId)).toEqual({ status: 'OPEN', recovered: '800000000' });
      const summary = await call('GET', `/audit-engagements/${made.engagementId}/recovery-summary`, { member: READER });
      expect(summary).toMatchObject({
        status: 200,
        json: {
          engagement_id: made.engagementId,
          amount_vnd: '800000000',
          recovered_vnd: '800000000',
          remaining_vnd: '0',
          money_rate: { numerator: '800000000', denominator: '800000000', percent: '100.00' },
          count_rate: { numerator: '0', denominator: '1', percent: '0.00' },
          exceptions: [],
        },
      });
      expect(summary.json.recommendations).toEqual([expect.objectContaining({ recommendation_id: made.recommendationId, amount_vnd: '800000000', recovered_vnd: '800000000', remaining_vnd: '0', line_count: 2 })]);
      const [event] = await events(idOf(done));
      expect(event).toMatchObject({ type: 'aud.recovery.linked.v1', payload: { recommendation_id: made.recommendationId, source_kind: 'MANUAL_EVIDENCE', amount_vnd: '300000000', recovered_vnd: '800000000', remaining_vnd: '0', evidence_document_id: EVIDENCE } });
      expect((await trail(idOf(done)))[0]).toMatchObject({ action: 'aud.recovery_linked', classification: 'CONFIDENTIAL', safe_diff: { amount_vnd: '300000000', recovered_vnd: '800000000' } });
    });

    it('answers a replay with the first body, refuses a stale version (409), and does not link the same source twice (409 RECOVERY_SOURCE_ALREADY_LINKED)', async () => {
      const made = await seed();
      const key = 'link-replay-key-0001';
      const options = { key, ifMatch: `"${await version(made.recommendationId)}"` };
      const first = await link(made.recommendationId, ACCOUNTANT, { amount_vnd: '100000000' }, options);
      const again = await link(made.recommendationId, ACCOUNTANT, { amount_vnd: '100000000' }, options);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(again.json).toEqual(first.json);
      expect((await lines(made.recommendationId)).length).toBe(1);
      expect((await link(made.recommendationId, ACCOUNTANT, {}, { ifMatch: '"1"' })).json.code).toBe('VERSION_CONFLICT');
      const source = randomUUID();
      expect(await link(made.recommendationId, ACCOUNTANT, { source_kind: 'TREASURY_REMITTANCE', source_id: source, amount_vnd: '50000000' })).toMatchObject({ status: 200 });
      expect(await link(made.recommendationId, ACCOUNTANT, { source_kind: 'TREASURY_REMITTANCE', source_id: source, amount_vnd: '50000000' })).toMatchObject({ status: 409, json: { code: 'RECOVERY_SOURCE_ALREADY_LINKED' } });
    });

    it('refuses what the ledger cannot take: a recommendation that is not financial or was cancelled, a source of PAY, no evidence in force, a zero amount, a day to come, an engagement that is closed', async () => {
      const process = await seed({ type: 'PROCESS_CORRECTION', amount: null });
      expect(await link(process.recommendationId)).toMatchObject({ status: 422, json: { code: 'RECOMMENDATION_NOT_FINANCIAL' } });
      const cancelled = await seed({ cancelled: true });
      expect(await link(cancelled.recommendationId)).toMatchObject({ status: 409, json: { code: 'RECOMMENDATION_STATE_INVALID' } });
      const made = await seed();
      expect(await link(made.recommendationId, ACCOUNTANT, { source_kind: 'PAY_RECOVERY', source_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      for (const evidence of [EVIDENCE_PENDING, randomUUID()]) expect(await link(made.recommendationId, ACCOUNTANT, { evidence_document_id: evidence })).toMatchObject({ status: 422, json: { code: 'EVIDENCE_REQUIRED' } });
      expect(await link(made.recommendationId, ACCOUNTANT, { evidence_document_id: undefined })).toMatchObject({ status: 422, json: { code: 'EVIDENCE_REQUIRED' } });
      expect(await link(made.recommendationId, ACCOUNTANT, { amount_vnd: '0' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await link(made.recommendationId, ACCOUNTANT, { recorded_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await link(made.recommendationId, ACCOUNTANT, { status: 'CLOSED' })).status).toBe(400);
      await rows("update machvon.audit_engagement set status = 'CLOSED', closed_on = date '2026-10-26' where id = $1", [made.engagementId]);
      expect(await link(made.recommendationId)).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
      expect((await lines(made.recommendationId)).length).toBe(0);
    });

    it('AC-ST-AUD-004-2 / UAT-AC439: 80,000,000 posted by two accountants at once on 400,000,000 with 300,000,000 recovered: exactly one is 409 RECOVERY_EXCEEDS_RECOMMENDATION with the figures', async () => {
      const made = await seed({ amount: '400000000' });
      await ledger(made.recommendationId, '300000000');
      const expected = await version(made.recommendationId);
      const replies = await Promise.all([ACCOUNTANT, ACCOUNTANT_TWO].map((member) => call('POST', `/audit-recommendations/${made.recommendationId}/recoveries`, { member, ifMatch: `"${expected}"`, body: { source_kind: 'MANUAL_EVIDENCE', amount_vnd: '80000000', recorded_on: today, evidence_document_id: EVIDENCE } })));
      // one of them loses the race for the version, or finds the money gone: either way the recovered amount never passes the amount recommended
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect((await state(made.recommendationId)).recovered).toBe('380000000');
      const over = await link(made.recommendationId, ACCOUNTANT_TWO, { amount_vnd: '80000000' });
      expect(over).toMatchObject({ status: 409, json: { code: 'RECOVERY_EXCEEDS_RECOMMENDATION', amount_vnd: '400000000', recovered_vnd: '380000000', line_vnd: '80000000', remaining_vnd: '20000000', excess_vnd: '60000000' } });
    });

    it('is for an accountant who sees the engagement: a reader and nobody are 403, another branch and another tenant are 404', async () => {
      const made = await seed();
      expect((await link(made.recommendationId, READER)).status).toBe(403);
      expect((await link(made.recommendationId, NOBODY)).status).toBe(403);
      expect((await link(made.recommendationId, OUTSIDER)).status).toBe(404);
      expect((await call('POST', `/audit-recommendations/${made.recommendationId}/recoveries`, { member: B_ACCOUNTANT, tenantId: TENANT_B, ifMatch: '"1"', body: { source_kind: 'MANUAL_EVIDENCE', amount_vnd: '1', recorded_on: today, evidence_document_id: EVIDENCE } })).status).toBe(404);
      expect((await lines(made.recommendationId)).length).toBe(0);
    });
  });

  describe('reverseAuditRecovery', () => {
    it('AC-ST-AUD-004-2 / UAT-AC439: a reversal adds a line of -80,000,000 and deletes nothing, the same line is not reversed twice (409), and the money is free again', async () => {
      const made = await seed({ amount: '400000000' });
      await ledger(made.recommendationId, '300000000');
      const added = await link(made.recommendationId, ACCOUNTANT, { amount_vnd: '80000000' });
      const done = await reverse(idOf(added));
      expect(done).toMatchObject({ status: 200, json: { status: 'REVERSED' } });
      expect((await lines(made.recommendationId)).map((line) => [line.amount, line.reversal_of_id === idOf(added)])).toEqual([
        ['300000000', false],
        ['80000000', false],
        ['-80000000', true],
      ]);
      expect((await state(made.recommendationId)).recovered).toBe('300000000');
      expect(await reverse(idOf(added), ACCOUNTANT_TWO)).toMatchObject({ status: 409, json: { code: 'RECOVERY_ALREADY_REVERSED' } });
      expect(await reverse(idOf(done))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await link(made.recommendationId, ACCOUNTANT_TWO, { amount_vnd: '100000000' })).toMatchObject({ status: 200 });
      const [event] = (await events(idOf(done))).filter((entry) => entry.type === 'aud.recovery.reversed.v1');
      expect(event).toMatchObject({ payload: { reversed_link_id: idOf(added), amount_vnd: '80000000', recovered_vnd: '300000000', reopened: false } });
    });

    it('asks for the reason in words (422), keeps the words out of the trail and the events, and does not find a line of another branch or tenant (404)', async () => {
      const made = await seed({ amount: '400000000' });
      const added = await link(made.recommendationId, ACCOUNTANT, { amount_vnd: '80000000' });
      expect(await reverse(idOf(added), ACCOUNTANT, 'short')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await reverse(idOf(added), READER)).status).toBe(403);
      expect((await reverse(idOf(added), OUTSIDER)).status).toBe(404);
      expect((await reverse(idOf(added), B_ACCOUNTANT, REASON, { tenantId: TENANT_B })).status).toBe(404);
      expect((await reverse(randomUUID())).status).toBe(404);
      const done = await reverse(idOf(added));
      expect(done.status).toBe(200);
      expect(await rows('select note from machvon.audit_recovery_link where id = $1', [idOf(done)])).toEqual([{ note: REASON }]);
      const text = JSON.stringify([await trail(idOf(done)), await events(idOf(done))]);
      expect(text).not.toContain(REASON);
      expect((await trail(idOf(done)))[0]).toMatchObject({ action: 'aud.recovery_reversed', classification: 'CONFIDENTIAL' });
    });

    it('AC-ST-AUD-004-3: a closed recommendation that is no longer recovered in full goes back to IN_PROGRESS with an event', async () => {
      const made = await seed({ closed: true });
      const first = await link(made.recommendationId, ACCOUNTANT, { amount_vnd: '500000000' });
      await link(made.recommendationId, ACCOUNTANT, { amount_vnd: '300000000' });
      expect(await state(made.recommendationId)).toEqual({ status: 'CLOSED', recovered: '800000000' });
      expect(await reverse(idOf(first))).toMatchObject({ status: 200 });
      expect(await state(made.recommendationId)).toEqual({ status: 'IN_PROGRESS', recovered: '300000000' });
      expect((await events(made.recommendationId)).map((event) => event.type)).toEqual(['aud.recommendation.reopened.v1']);
      expect((await trail(made.recommendationId)).map((entry) => entry.action)).toEqual(['aud.recommendation_reopened']);
    });

    it('does not move the recommendations of an engagement that is closed (409 ENGAGEMENT_STATE_INVALID)', async () => {
      const made = await seed();
      const added = await link(made.recommendationId);
      await rows("update machvon.audit_engagement set status = 'CLOSED', closed_on = date '2026-10-26' where id = $1", [made.engagementId]);
      expect(await reverse(idOf(added))).toMatchObject({ status: 409, json: { code: 'ENGAGEMENT_STATE_INVALID' } });
    });
  });

  describe('the reads (AUD-08, AUD-01)', () => {
    it('lists the lines of an engagement with the recovered amount up to each and what is left after it, and the reversed one marked', async () => {
      const made = await seed({ amount: '400000000' });
      const first = await link(made.recommendationId, ACCOUNTANT, { amount_vnd: '100000000' });
      await link(made.recommendationId, ACCOUNTANT, { amount_vnd: '50000000' });
      await reverse(idOf(first));
      const listed = await call('GET', `/audit-engagements/${made.engagementId}/recovery-links`, { member: READER });
      expect((listed.json.items as Array<Record<string, unknown>>).map((line) => [line.amount_vnd, line.cumulative_vnd, line.remaining_vnd, line.reversed, line.reversal_of_id === null])).toEqual([
        ['100000000', '100000000', '300000000', true, true],
        ['50000000', '150000000', '250000000', false, true],
        ['-100000000', '50000000', '350000000', false, false],
      ]);
      expect((listed.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ rec_code: expect.any(String), source_kind: 'MANUAL_EVIDENCE', evidence_document_id: EVIDENCE, recorded_by: memberId(ACCOUNTANT) });
    });

    it('answers 404 for an engagement outside the scope or of another tenant, and 403 to nobody, for the summary and the lines', async () => {
      const made = await seed();
      for (const path of [`/audit-engagements/${made.engagementId}/recovery-summary`, `/audit-engagements/${made.engagementId}/recovery-links`]) {
        expect((await call('GET', path, { member: OUTSIDER })).status).toBe(404);
        expect((await call('GET', path, { member: B_ACCOUNTANT, tenantId: TENANT_B })).status).toBe(404);
        expect((await call('GET', path, { member: NOBODY })).status).toBe(403);
        expect((await call('GET', path, { member: READER })).status).toBe(200);
      }
      expect((await call('GET', `/audit-engagements/${randomUUID()}/recovery-summary`, { member: READER })).status).toBe(404);
    });

    it('gives the overview to whoever reads: the figures over the engagements of the scope, and nothing from another tenant or outside it', async () => {
      await seed();
      const all = await call('GET', '/audit-overview', { member: READER });
      expect(all.status).toBe(200);
      expect(all.json).toMatchObject({
        engagements_follow_up: expect.any(Number),
        engagements_ongoing: expect.any(Number),
        recommendations_open: expect.any(Number),
        recommendations_overdue: expect.any(Number),
        amount_vnd: expect.stringMatching(/^[0-9]+$/),
        recovered_vnd: expect.stringMatching(/^[0-9]+$/),
        remaining_vnd: expect.stringMatching(/^[0-9]+$/),
        exceptions_open: expect.any(Number),
      });
      expect(Number(all.json.recommendations_open)).toBeGreaterThan(0);
      expect(all.json.engagements).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.any(String), engagement_code: expect.any(String), recommendations_open: 1, recommendations_overdue: 0, amount_vnd: '800000000', recovered_vnd: '0' })]));
      expect((await call('GET', '/audit-overview', { member: OUTSIDER })).json.engagements).toEqual([]);
      expect(all.json.money_rate).toMatchObject({ numerator: all.json.recovered_vnd, denominator: all.json.amount_vnd });
      expect(all.json.count_rate).toEqual(expect.objectContaining({ numerator: expect.any(String), denominator: expect.any(String) }));
      expect((await call('GET', '/audit-overview', { member: OUTSIDER })).json).toMatchObject({ recommendations_open: 0, amount_vnd: '0', money_rate: { percent: null } });
      expect((await call('GET', '/audit-overview', { member: B_ACCOUNTANT, tenantId: TENANT_B })).json).toMatchObject({ recommendations_open: 0, amount_vnd: '0' });
      expect((await call('GET', '/audit-overview', { member: NOBODY })).status).toBe(403);
    });
  });
});
