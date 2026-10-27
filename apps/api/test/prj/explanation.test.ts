import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, PrjExplanationOverdueJob, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { dueMomentOf, loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { prjModule } from '../../src/modules/prj';
import { ExplanationAutoConsumer } from '../../src/modules/prj/explanation-auto.consumer';
import { ExplanationController } from '../../src/modules/prj/explanation.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // explanation.request and explanation.read over the whole tenant
const RESPONDER = 2; // respond, review and read over the whole tenant: may answer, and so must not conclude their own answer
const OUTSIDE = 3; // respond and read over another branch only
const REVIEWER = 4; // review and read over the whole tenant
const UNIT_REQUESTER = 5; // request and read over the department only
const STRANGER = 6; // no explanation permission at all
const DEPARTED = 7; // a member that is no longer active
const B_ADMIN = 1;
const ROOT = 1;
const HERE = 2;
const ELSEWHERE = 3;
const FAMILY = 0xab;
const NOW = new Date('2027-11-02T03:00:00Z');
const DAY = 86_400_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The explanation requests over HTTP, the job that makes them overdue and the job that asks for one by itself (ST-PRJ-006, PRJ-19, BR-PRJ-08). */
describe('the explanation requests (ST-PRJ-006)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const gauges: Array<{ name: string; value: number }> = [];

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function project(unit = HERE, tenant = TENANT_A): Promise<string> {
    counter += 1;
    const projectId = id(FAMILY, 100 + counter);
    await seed([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, projectId, `EX-${counter}`, unitId(unit), id(FAMILY, 30)],
      ],
    ]);
    return projectId;
  }

  /** A published rule with its open warning on a project, as the evaluation of a close snapshot leaves it. */
  async function warning(projectId: string, options: { auto?: boolean; status?: string } = {}): Promise<{ id: string; ruleCode: string; periodId: string }> {
    counter += 1;
    const periodId = id(FAMILY, 1000 + counter);
    const snapshotId = randomUUID();
    const ruleId = randomUUID();
    const warningId = randomUUID();
    const ruleCode = `EWT-${counter}`;
    await seed([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `EXW-${counter}`, new Date(Date.UTC(2041, 0, 2) + counter * 7 * DAY).toISOString().slice(0, 10), id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, '2027-10-31', '2027-10-31', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 0, $5, $5)`,
        [TENANT_A, snapshotId, periodId, NOW.toISOString(), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.early_warning_rule (tenant_id, id, rule_code, name, metric_code, comparator, threshold_json, severity, scope_kind, auto_explanation, legal_basis, effective_from, revision, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, 'Weekly report is missing', 'REPORT_OVERDUE', 'MISSING', '{}'::jsonb, 'WARNING', 'PROJECT', $4, 'Directive 162/CD-TTg', '2020-01-01', 1, 'PUBLISHED', $5, $6, $6)`,
        [TENANT_A, ruleId, ruleCode, options.auto === true, memberId(ADMIN), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.early_warning (tenant_id, id, rule_id, project_id, unit_id, period_id, snapshot_id, severity, observed_json, dedupe_key, status, created_by, updated_by)
         select $1, $2, $3, $4, p.owner_unit_id, $5, $6, 'WARNING', '{}'::jsonb, $7, $8, $9, $9 from machvon.project p where p.id = $4::uuid`,
        [TENANT_A, warningId, ruleId, projectId, periodId, snapshotId, `${ruleCode}|${projectId}|2027|${periodId}`, options.status ?? 'OPEN', WORKER_MEMBERSHIP_ID],
      ],
    ]);
    return { id: warningId, ruleCode, periodId };
  }

  const closeWarning = (warningId: string): Promise<unknown> =>
    rows(`update machvon.early_warning set status = 'DISMISSED', resolution_reason = 'Not needed any more', closed_at = now(), closed_by = $2::uuid where id = $1::uuid`, [warningId, memberId(ADMIN)]);
  const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString();
  const QUESTION = 'Explain why the weekly report of the project is still missing';
  const ANSWER = 'The contractor lost the site records in the flood; they were rebuilt and sent.';
  const ask = (projectId: string, extra: Record<string, unknown> = {}, member = ADMIN): Promise<Reply> =>
    call('POST', '/explanation-requests', {
      member,
      body: { subject_kind: 'PROJECT', project_id: projectId, trigger_code: `MANUAL-${randomUUID().slice(0, 8)}`, question: QUESTION, requested_from_membership_id: memberId(RESPONDER), due_at: inAnHour(), ...extra },
    });
  const answer = (requestId: string, version: number, member = RESPONDER, text = ANSWER): Promise<Reply> => call('POST', `/explanation-requests/${requestId}/response`, { member, ifMatch: version, body: { response_text: text } });
  const decide = (requestId: string, version: number, decision: string, member = REVIEWER, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/explanation-requests/${requestId}/decision`, { member, ifMatch: version, body: { decision, review_note: 'Reviewed against the site records', ...extra } });
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const stored = async (requestId: string) =>
    (await rows<{ status: string; version: string; is_late: boolean; due_at: string; original_due_at: string; reviewed_by: string | null; responded_by: string | null; warning_id: string | null }>(
      'select status, version::text as version, is_late, due_at::text as due_at, original_due_at::text as original_due_at, reviewed_by, responded_by, warning_id from machvon.explanation_request where id = $1::uuid',
      [requestId],
    ))[0]!;
  const warningOf = async (warningId: string) =>
    (await rows<{ status: string; explanation_request_id: string | null; resolution_reason: string | null }>('select status, explanation_request_id, resolution_reason from machvon.early_warning where id = $1::uuid', [warningId]))[0]!;
  /** Moves the due moment of a request into the past, as the clock of a few days does (the first date stays what it was asked for). */
  const pastDue = (requestId: string): Promise<unknown> =>
    rows(`update machvon.explanation_request set due_at = now() - interval '2 hours', original_due_at = now() - interval '2 hours' where id = $1::uuid`, [requestId]);

  const overdueJob = (): PrjExplanationOverdueJob => new PrjExplanationOverdueJob(new AuditWriter(harness.tenants as TenantDatabase), { increment: () => undefined, gauge: (name, value) => void gauges.push({ name, value }) });
  const runOverdue = async (now = new Date()): Promise<number> =>
    (await (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => overdueJob().run(tx, WORKER_MEMBERSHIP_ID, now))).overdue;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: HERE, path: `/${unitId(ROOT)}/${unitId(HERE)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [ADMIN, RESPONDER, OUTSIDE, REVIEWER, UNIT_REQUESTER, STRANGER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedMembership(TENANT_A, DEPARTED, ROOT, { status: 'Suspended' });
    await harness.seedRole(TENANT_A, 1, 'EXPLANATION_ASKER', ['explanation.request', 'explanation.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'EXPLANATION_RESPONDER', ['explanation.respond', 'explanation.review', 'explanation.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'EXPLANATION_OUTSIDE', ['explanation.respond', 'explanation.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'EXPLANATION_REVIEWER', ['explanation.review', 'explanation.read'], 30);
    await harness.seedRole(TENANT_A, 5, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'EXPLANATION_ASKER', ['explanation.request', 'explanation.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: RESPONDER, role: 2, kind: 'TENANT' },
      { n: 3, member: OUTSIDE, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: REVIEWER, role: 4, kind: 'TENANT' },
      { n: 5, member: UNIT_REQUESTER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(HERE)] },
      { n: 6, member: STRANGER, role: 5, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ExplanationController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of PRJ', () => {
    expect(prjModule.controllers).toContain(ExplanationController);
  });

  describe('the life of a request (AC-ST-PRJ-006-1 / UAT-AC212)', () => {
    it('AC-ST-PRJ-006-1: EW-01 is open, the leader asks, it passes its due date and becomes OVERDUE, the person asked answers late and it is told late, they cannot conclude their own answer, and another person accepts it and the warning is RESOLVED', async () => {
      const projectId = await project();
      const w = await warning(projectId);
      const asked = await ask(projectId, { warning_id: w.id, trigger_code: w.ruleCode, period_id: w.periodId });
      expect(asked).toMatchObject({ status: 200, json: { status: 'REQUESTED', resource_version: 1 } });
      const requestId = idOf(asked);
      expect(await warningOf(w.id)).toEqual({ status: 'EXPLANATION_REQUESTED', explanation_request_id: requestId, resolution_reason: null });
      expect(await rows(`select id from machvon.outbox_event where type = 'explanation.requested.v1' and aggregate_id = $1`, [requestId])).toHaveLength(1);
      const audit = await rows<{ safe_diff: Record<string, unknown>; actor_id: string }>(`select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_requested'`, [requestId]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor_id).toBe(memberId(ADMIN));
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain(QUESTION);

      // Before its moment nothing is overdue; after it the job marks it once.
      expect(await runOverdue()).toBe(0);
      await pastDue(requestId);
      expect(await runOverdue()).toBe(1);
      expect(await runOverdue()).toBe(0);
      expect(await stored(requestId)).toMatchObject({ status: 'OVERDUE', version: '2' });
      expect(gauges.at(-1)?.name).toBe('prj_explanation_overdue_gauge');
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_overdue'`, [requestId])).toHaveLength(1);

      // The answer is still taken, and told late against the date it was asked for.
      const answered = await answer(requestId, 2);
      expect(answered).toMatchObject({ status: 200, json: { status: 'RESPONDED', resource_version: 3 } });
      expect(await stored(requestId)).toMatchObject({ status: 'RESPONDED', is_late: true, responded_by: memberId(RESPONDER) });
      const responded = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_responded'`, [requestId]);
      expect(responded[0]?.safe_diff).toMatchObject({ is_late: true, from_status: 'OVERDUE' });
      expect(JSON.stringify(responded[0]?.safe_diff)).not.toContain(ANSWER);

      // The responder cannot conclude; the version is not even looked at first.
      expect(await decide(requestId, 3, 'ACCEPTED', RESPONDER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await decide(requestId, 3, 'ACCEPTED', STRANGER)).toMatchObject({ status: 403 });
      expect((await stored(requestId)).status).toBe('RESPONDED');

      const accepted = await decide(requestId, 3, 'ACCEPTED');
      expect(accepted).toMatchObject({ status: 200, json: { status: 'ACCEPTED', resource_version: 4 } });
      expect(await stored(requestId)).toMatchObject({ status: 'ACCEPTED', reviewed_by: memberId(REVIEWER) });
      expect(await warningOf(w.id)).toEqual({ status: 'RESOLVED', explanation_request_id: requestId, resolution_reason: 'EXPLANATION_ACCEPTED' });
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action = 'dis.warning_resolved_by_explanation'`, [w.id])).toHaveLength(1);
      expect(await rows(`select id from machvon.outbox_event where type = 'explanation.reviewed.v1' and aggregate_id = $1`, [requestId])).toHaveLength(1);
      // Nothing more is done to a request that was accepted.
      expect(await answer(requestId, 4)).toMatchObject({ status: 422, json: { code: 'EXPLANATION_ALREADY_SUBMITTED' } });
      expect(await decide(requestId, 4, 'RETURNED')).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    });

    it('takes an answer in time as in time (not late), and only from the person who was asked, under the version they saw, once', async () => {
      const projectId = await project();
      const requestId = idOf(await ask(projectId));
      expect(await answer(requestId, 1, OUTSIDE)).toMatchObject({ status: 403 });
      expect(await answer(requestId, 1, REVIEWER)).toMatchObject({ status: 403 });
      expect(await answer(requestId, 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await answer(requestId, 1, RESPONDER, 'too short')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'response_text' } });
      expect(await answer(requestId, 1)).toMatchObject({ status: 200, json: { status: 'RESPONDED' } });
      expect((await stored(requestId)).is_late).toBe(false);
      expect(await answer(requestId, 2)).toMatchObject({ status: 422, json: { code: 'EXPLANATION_ALREADY_SUBMITTED' } });
    });

    it('returns an answer with a note and a new due date: the first date is kept, the answer may be given again, and a returned request that passes the new date becomes overdue too', async () => {
      const projectId = await project();
      const requestId = idOf(await ask(projectId));
      const first = (await stored(requestId)).original_due_at;
      expect(await decide(requestId, 1, 'RETURNED')).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      await answer(requestId, 1);
      const later = new Date(Date.now() + 3 * DAY).toISOString();
      expect(await decide(requestId, 2, 'ACCEPTED', REVIEWER, { new_due_at: later })).toMatchObject({ status: 422, json: { detail: 'new_due_at' } });
      expect(await decide(requestId, 2, 'RETURNED', REVIEWER, { new_due_at: new Date(Date.now() - DAY).toISOString() })).toMatchObject({ status: 422, json: { detail: 'new_due_at' } });
      expect(await decide(requestId, 2, 'RETURNED', REVIEWER, { new_due_at: later, review_note: 'no' })).toMatchObject({ status: 422, json: { detail: 'review_note' } });
      expect(await decide(requestId, 2, 'MAYBE')).toMatchObject({ status: 422 });
      expect(await decide(requestId, 2, 'RETURNED', REVIEWER, { new_due_at: later })).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
      const returned = await stored(requestId);
      expect(returned.original_due_at).toBe(first);
      expect(new Date(returned.due_at).getTime()).toBeGreaterThan(new Date(first).getTime());
      expect(await answer(requestId, 3, RESPONDER, 'The missing records were rebuilt and attached now.')).toMatchObject({ status: 200, json: { status: 'RESPONDED' } });
      expect(await stored(requestId)).toMatchObject({ reviewed_by: null, is_late: false });
      // A returned request that nobody answers by the new date is overdue like the first one.
      const second = idOf(await ask(await project()));
      await answer(second, 1);
      await decide(second, 2, 'RETURNED');
      await pastDue(second);
      expect(await runOverdue()).toBe(1);
      expect((await stored(second)).status).toBe('OVERDUE');
    });

    it('gives a returned request a date earlier than the first one when the reviewer wants it sooner: the first date is kept, the new one is the one in force', async () => {
    const requestId = idOf(await ask(await project(), { due_at: new Date(Date.now() + 10 * DAY).toISOString() }));
    await answer(requestId, 1);
    const sooner = new Date(Date.now() + 2 * DAY).toISOString();
    expect(await decide(requestId, 2, 'RETURNED', REVIEWER, { new_due_at: sooner })).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
    const kept = await stored(requestId);
    expect(new Date(kept.due_at).getTime()).toBe(new Date(sooner).getTime());
    expect(new Date(kept.original_due_at).getTime()).toBeGreaterThan(new Date(kept.due_at).getTime());
  });

  it('leaves a request that was answered alone when the job runs', async () => {
      const answered = idOf(await ask(await project()));
      await answer(answered, 1);
      await pastDue(answered);
      expect(await runOverdue()).toBe(0);
      expect((await stored(answered)).status).toBe('RESPONDED');
    });
  });

  describe('asking (the scope, the subject, the person asked)', () => {
    it('refuses a second request open for the same subject, trigger and period, and a warning that already has one (409 EXPLANATION_ALREADY_OPEN); a settled request frees the trigger', async () => {
      const projectId = await project();
      const trigger = `T-${randomUUID().slice(0, 8)}`;
      const first = await ask(projectId, { trigger_code: trigger });
      expect(first.status).toBe(200);
      expect(await ask(projectId, { trigger_code: trigger })).toMatchObject({ status: 409, json: { code: 'EXPLANATION_ALREADY_OPEN' } });
      expect((await ask(projectId, { trigger_code: `${trigger}-2` })).status).toBe(200);
      const w = await warning(projectId);
      expect((await ask(projectId, { warning_id: w.id })).status).toBe(200);
      expect(await ask(projectId, { warning_id: w.id })).toMatchObject({ status: 409, json: { code: 'EXPLANATION_ALREADY_OPEN' } });
      await answer(idOf(first), 1);
      await decide(idOf(first), 2, 'ACCEPTED');
      expect((await ask(projectId, { trigger_code: trigger })).status).toBe(200);
    });

    it('asks only about what the caller may: a project or a unit outside their scope is 403, one that does not exist is 404, a subject is a project or a unit and not both', async () => {
      const here = await project(HERE);
      const elsewhere = await project(ELSEWHERE);
      expect((await ask(here, {}, UNIT_REQUESTER)).status).toBe(200);
      expect(await ask(elsewhere, {}, UNIT_REQUESTER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await ask(id(FAMILY, 9999))).toMatchObject({ status: 404 });
      const unitAsk = (unit: number, member: number): Promise<Reply> =>
        call('POST', '/explanation-requests', { member, body: { subject_kind: 'UNIT', unit_id: unitId(unit), trigger_code: `U-${randomUUID().slice(0, 8)}`, question: QUESTION, requested_from_membership_id: memberId(RESPONDER), due_at: inAnHour() } });
      expect((await unitAsk(HERE, UNIT_REQUESTER)).status).toBe(200);
      expect(await unitAsk(ELSEWHERE, UNIT_REQUESTER)).toMatchObject({ status: 403 });
      expect((await unitAsk(ELSEWHERE, ADMIN)).status).toBe(200);
      expect(await ask(here, { unit_id: unitId(HERE) })).toMatchObject({ status: 422, json: { detail: 'project_id' } });
      expect(await ask(here, { subject_kind: 'UNIT', project_id: undefined })).toMatchObject({ status: 422, json: { detail: 'unit_id' } });
      expect(await ask(here, { subject_kind: 'TEAM' })).toMatchObject({ status: 422 });
      expect(await call('POST', '/explanation-requests', { member: STRANGER, body: { subject_kind: 'PROJECT', project_id: here, trigger_code: 'X', question: QUESTION, requested_from_membership_id: memberId(RESPONDER), due_at: inAnHour() } })).toMatchObject({ status: 403 });
    });

    it('judges the request: a due moment in the future, a question of ten characters, a person asked who belongs to the tenant and is active, a warning of the same project that is open', async () => {
      const projectId = await project();
      expect(await ask(projectId, { due_at: new Date(Date.now() - 1000).toISOString() })).toMatchObject({ status: 422, json: { detail: 'due_at' } });
      expect(await ask(projectId, { due_at: 'tomorrow' })).toMatchObject({ status: 422 });
      expect(await ask(projectId, { question: 'Why?' })).toMatchObject({ status: 422 });
      expect(await ask(projectId, { requested_from_membership_id: memberId(DEPARTED) })).toMatchObject({ status: 422, json: { detail: 'requested_from_membership_id' } });
      expect(await ask(projectId, { requested_from_membership_id: memberId(99) })).toMatchObject({ status: 404 });
      const other = await project();
      const foreign = await warning(other);
      expect(await ask(projectId, { warning_id: foreign.id })).toMatchObject({ status: 422, json: { detail: 'warning_id' } });
      const closed = await warning(projectId);
      await closeWarning(closed.id);
      expect(await ask(projectId, { warning_id: closed.id })).toMatchObject({ status: 409, json: { code: 'WARNING_STATE_INVALID' } });
      expect(await ask(projectId, { warning_id: randomUUID() })).toMatchObject({ status: 404 });
      expect(await ask(projectId, { period_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'period_id' } });
    });

    it('concludes only what is in the scope of the reviewer, and not what belongs to another tenant', async () => {
      const requestId = idOf(await ask(await project(ELSEWHERE)));
      await answer(requestId, 1);
      const unitReviewer = await call('POST', `/explanation-requests/${requestId}/decision`, { member: OUTSIDE, ifMatch: 2, body: { decision: 'ACCEPTED', review_note: 'Reviewed against the site records' } });
      expect(unitReviewer.status).toBe(403);
      expect(await call('POST', `/explanation-requests/${requestId}/response`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: 2, body: { response_text: ANSWER } })).toMatchObject({ status: 403 });
      expect(await call('POST', `/explanation-requests/${randomUUID()}/decision`, { member: REVIEWER, ifMatch: 1, body: { decision: 'ACCEPTED', review_note: 'Reviewed against the site records' } })).toMatchObject({ status: 404 });
    });
  });

  describe('the list (PRJ-19)', () => {
    it('shows the requests in the scope of the reader and the ones addressed to them, filters by status and project, and pages newest first', async () => {
      const a = await project(HERE);
      const b = await project(ELSEWHERE);
      const one = idOf(await ask(a));
      const two = idOf(await ask(a, { requested_from_membership_id: memberId(OUTSIDE) }));
      const three = idOf(await ask(b));
      const all = await call('GET', '/explanation-requests?limit=200', { member: ADMIN });
      const ids = (all.json.items as Array<{ id: string }>).map((item) => item.id);
      expect(ids).toEqual(expect.arrayContaining([one, two, three]));
      expect(ids.indexOf(three)).toBeLessThan(ids.indexOf(two));
      expect(ids.indexOf(two)).toBeLessThan(ids.indexOf(one));
      const view = (all.json.items as Array<Record<string, unknown>>).find((item) => item.id === one) as Record<string, unknown>;
      expect(view).toMatchObject({ subject_kind: 'PROJECT', status: 'REQUESTED', is_late: false, version: 1, project: { id: a }, requested_from_membership_id: memberId(RESPONDER), unit: null, response_text: null });
      expect(Object.keys(view).sort()).toEqual(['created_at', 'created_by', 'due_at', 'id', 'is_late', 'original_due_at', 'period_id', 'project', 'question', 'requested_from_membership_id', 'responded_at', 'responded_by', 'response_document_id', 'response_text', 'review_note', 'reviewed_by', 'status', 'subject_kind', 'trigger_code', 'unit', 'version', 'warning_id']);
      // The person asked sees what is addressed to them though their grant reaches another branch only; that branch they see, the rest of the department they do not.
      const outside = (await call('GET', '/explanation-requests?limit=200', { member: OUTSIDE })).json.items as Array<{ id: string }>;
      expect(outside.map((item) => item.id)).toEqual(expect.arrayContaining([two, three]));
      expect(outside.map((item) => item.id)).not.toContain(one);
      const here = (await call('GET', '/explanation-requests?limit=200', { member: UNIT_REQUESTER })).json.items as Array<{ id: string }>;
      expect(here.map((item) => item.id)).toEqual(expect.arrayContaining([one, two]));
      expect(here.map((item) => item.id)).not.toContain(three);
      const byProject = (await call('GET', `/explanation-requests?project_id=${b}&limit=200`, { member: ADMIN })).json.items as Array<{ id: string }>;
      expect(byProject.map((item) => item.id)).toEqual([three]);
      expect(((await call('GET', '/explanation-requests?status=ACCEPTED&limit=200', { member: ADMIN })).json.items as Array<{ status: string }>).every((item) => item.status === 'ACCEPTED')).toBe(true);
      const page = await call('GET', '/explanation-requests?limit=2', { member: ADMIN });
      expect((page.json.items as unknown[]).length).toBe(2);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await call('GET', `/explanation-requests?limit=2&cursor=${page.json.next_cursor as string}`, { member: ADMIN });
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((page.json.items as Array<{ id: string }>)[0]?.id);
    });

    it('pages by the full timestamp: requests made within one millisecond are neither skipped nor shown twice', async () => {
      const subject = await project();
      const made: string[] = [];
      for (const micros of ['111', '222', '333', '444']) {
        const requestId = randomUUID();
        made.push(requestId);
        await seed([
          [
            `insert into machvon.explanation_request (tenant_id, id, subject_kind, project_id, trigger_code, question, requested_from_membership_id, due_at, original_due_at, status, created_at, created_by, updated_by)
             values ($1, $2, 'PROJECT', $3, $4, $5, $6, now() + interval '1 day', now() + interval '1 day', 'REQUESTED', timestamptz '2031-05-05 01:02:03.123' + interval '${micros} microseconds', $6, $6)`,
            [TENANT_A, requestId, subject, `PAGE-${micros}`, QUESTION, memberId(ADMIN)],
          ],
        ]);
      }
      const seen: string[] = [];
      let cursor = '';
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const reply = await call('GET', `/explanation-requests?project_id=${subject}&limit=1${cursor}`, { member: ADMIN });
        for (const item of reply.json.items as Array<{ id: string }>) seen.push(item.id);
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${reply.json.next_cursor as string}`;
      }
      expect(seen).toEqual([...made].reverse());
    });

    it('judges the query, shows nothing of another tenant, and is closed to a member with no right to read', async () => {
      expect(await call('GET', '/explanation-requests?project_id=nope', { member: ADMIN })).toMatchObject({ status: 422, json: { detail: 'project_id' } });
      expect(await call('GET', '/explanation-requests?limit=0', { member: ADMIN })).toMatchObject({ status: 422 });
      // A cursor that decodes but does not name an instant is a fault of the request, not of the server.
      const badCursor = Buffer.from(JSON.stringify(['not a time', randomUUID()])).toString('base64url');
      expect(await call('GET', `/explanation-requests?cursor=${badCursor}`, { member: ADMIN })).toMatchObject({ status: 422, json: { detail: 'cursor' } });
      expect((await call('GET', '/explanation-requests', { member: STRANGER })).status).toBe(403);
      const theirs = await call('GET', '/explanation-requests?limit=200', { member: B_ADMIN, tenantId: TENANT_B });
      expect(theirs.json.items).toEqual([]);
    });
  });

  describe('the request that a warning asks for by itself (AC-ST-PRJ-006-2 / UAT-AC253)', () => {
    const consumer = (at: Date = NOW): ExplanationAutoConsumer => new ExplanationAutoConsumer({ database: harness.tenants as TenantDatabase, security: { signingKey: SIGNING_KEY }, clock: () => at });
    const delivery = (warningId: string, extra: Record<string, unknown> = {}, eventId = randomUUID(), type = 'warning.opened.v1') => ({
      id: eventId,
      tenantId: TENANT_A,
      tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
      type,
      payload: { tenant_id: TENANT_A, warning_id: warningId, auto_explanation: true, explanation_due_days: 3, ...extra },
    });
    const leaderOf = (projectId: string, member = RESPONDER): Promise<unknown> =>
      seed([
        [
          `insert into machvon.project_accountability (tenant_id, id, project_id, leader_membership_id, accountability_role, valid_from, status, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, 'LEADER_IN_CHARGE', '2026-01-05', 'ACTIVE', $4, $4)`,
          [TENANT_A, projectId, memberId(member), memberId(ADMIN)],
        ],
      ]);
    /** The weekday that is `count` weekdays after a day, as the fallback counts them when the tenant has published no working calendar. */
    const weekdaysAfter = (date: string, count: number): string => {
      let day = date;
      let left = count;
      while (left > 0) {
        const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY);
        day = next.toISOString().slice(0, 10);
        if (next.getUTCDay() !== 0 && next.getUTCDay() !== 6) left -= 1;
      }
      return day;
    };

    it('AC-ST-PRJ-006-2: EW-02 has auto_explanation and the weekly report is missing: warning.opened.v1 makes one request to the leader in charge, due in three working days, and none again on a replay or a second delivery of the same warning', async () => {
      const projectId = await project();
      await leaderOf(projectId);
      const w = await warning(projectId, { auto: true });
      const first = delivery(w.id);
      expect(await consumer().handle(first)).toBe('processed');
      const made = await rows<{ id: string; requested_from_membership_id: string; trigger_code: string; due_at: string; status: string; subject_kind: string; period_id: string; created_by: string }>(
        'select id, requested_from_membership_id, trigger_code, to_char(due_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') as due_at, status, subject_kind, period_id, created_by from machvon.explanation_request where warning_id = $1::uuid',
        [w.id],
      );
      expect(made).toHaveLength(1);
      expect(made[0]).toMatchObject({ requested_from_membership_id: memberId(RESPONDER), trigger_code: w.ruleCode, status: 'REQUESTED', subject_kind: 'PROJECT', period_id: w.periodId, created_by: WORKER_MEMBERSHIP_ID });
      expect(made[0]?.due_at).toBe(dueMomentOf(weekdaysAfter(vietnamDateOf(NOW), 3)).toISOString());
      expect(await warningOf(w.id)).toMatchObject({ status: 'EXPLANATION_REQUESTED', explanation_request_id: made[0]?.id });
      expect(await rows(`select id from machvon.outbox_event where type = 'explanation.requested.v1' and aggregate_id = $1`, [made[0]?.id])).toHaveLength(1);
      const audit = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_requested'`, [made[0]?.id]);
      expect(audit[0]?.safe_diff).toMatchObject({ auto: true, calendar: 'WEEKDAYS_ASSUMED', event_id: first.id });
      // The same delivery again is a counted duplicate, another delivery of the same warning finds the request that is there.
      expect(await consumer().handle(first)).toBe('duplicate');
      expect(await consumer().handle(delivery(w.id))).toBe('processed');
      expect(await rows('select id from machvon.explanation_request where warning_id = $1::uuid', [w.id])).toHaveLength(1);
      expect(await rows(`select id from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_auto_skipped'`, [made[0]?.id])).toHaveLength(1);
    });

    it('counts the days the rule gave from the day the warning was opened, not from the day the event is read: five days from a Friday are the next Friday, even when the delivery is late', async () => {
      const projectId = await project();
      await leaderOf(projectId);
      const w = await warning(projectId, { auto: true });
      // The clock reads the event on the Tuesday 2027-11-02; the warning was opened on the Friday before.
      expect(await consumer().handle(delivery(w.id, { explanation_due_days: 5, occurred_at: '2027-10-29T03:00:00Z' }))).toBe('processed');
      const [made] = await rows<{ due_at: string }>("select to_char(due_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as due_at from machvon.explanation_request where warning_id = $1::uuid", [w.id]);
      expect(made?.due_at).toBe(dueMomentOf('2027-11-05').toISOString());
      // A figure that is not a whole number of days a month at most, and a moment that is not one, are left out: the three days from the clock.
      const other = await warning(await project(), { auto: true });
      await leaderOf((await rows<{ project_id: string }>('select project_id from machvon.early_warning where id = $1::uuid', [other.id]))[0]!.project_id);
      expect(await consumer().handle(delivery(other.id, { explanation_due_days: 0.5, occurred_at: 'yesterday' }))).toBe('processed');
      const [fallback] = await rows<{ due_at: string }>("select to_char(due_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as due_at from machvon.explanation_request where warning_id = $1::uuid", [other.id]);
      expect(fallback?.due_at).toBe(dueMomentOf(weekdaysAfter(vietnamDateOf(NOW), 3)).toISOString());
    });

    it('counts by the published calendar of a year (a holiday is not a working day) and by the week for a year that has none, day by day, and says so when any day was counted by the week', async () => {
      const projectId = await project();
      await leaderOf(projectId);
      const w = await warning(projectId, { auto: true });
      // A calendar of 2027 whose Monday 2027-11-01 is a holiday: from the Friday 2027-10-29, one working day is the Tuesday.
      await seed([
        [
          `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at, version)
           values ($1, gen_random_uuid(), 'DEFAULT', 2027, 1, '[1,2,3,4,5]'::jsonb, '[{"date":"2027-11-01","name":"Test holiday"}]'::jsonb, '[]'::jsonb, 'Decision of the test', 'Published', $2, $2, now(), 1)`,
          [TENANT_A, memberId(ADMIN)],
        ],
      ]);
      expect(await consumer().handle(delivery(w.id, { explanation_due_days: 1, occurred_at: '2027-10-29T03:00:00Z' }))).toBe('processed');
      const [made] = await rows<{ id: string; due_at: string }>("select id, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as due_at from machvon.explanation_request where warning_id = $1::uuid", [w.id]);
      expect(made?.due_at).toBe(dueMomentOf('2027-11-02').toISOString());
      const calendar = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_requested'`, [made?.id]);
      expect(calendar[0]?.safe_diff).toMatchObject({ calendar: 'WORKING_CALENDAR' });
      // Counting on into 2028, which has no calendar, goes on by the week and does not forget the holiday of 2027: 2027-12-30 + 3 working days crosses the new year.
      const next = await warning(await project(), { auto: true });
      await leaderOf((await rows<{ project_id: string }>('select project_id from machvon.early_warning where id = $1::uuid', [next.id]))[0]!.project_id);
      expect(await consumer(new Date('2028-01-10T03:00:00Z')).handle(delivery(next.id, { explanation_due_days: 3, occurred_at: '2027-12-30T03:00:00Z' }))).toBe('processed');
      const [across] = await rows<{ id: string; due_at: string }>("select id, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as due_at from machvon.explanation_request where warning_id = $1::uuid", [next.id]);
      // Friday 2027-12-31 is the first working day, Saturday and Sunday are not, Monday 2028-01-03 the second and Tuesday 2028-01-04 the third.
      expect(across?.due_at).toBe(dueMomentOf('2028-01-04').toISOString());
      const assumed = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_requested'`, [across?.id]);
      expect(assumed[0]?.safe_diff).toMatchObject({ calendar: 'WEEKDAYS_ASSUMED' });
    });

    it('skips, and does not fail the event, when a request of a person is already open for the same project, trigger and period', async () => {
      const projectId = await project();
      await leaderOf(projectId);
      const w = await warning(projectId, { auto: true });
      expect((await ask(projectId, { trigger_code: w.ruleCode, period_id: w.periodId })).status).toBe(200);
      expect(await consumer().handle(delivery(w.id))).toBe('processed');
      expect(await rows('select id from machvon.explanation_request where project_id = $1::uuid', [projectId])).toHaveLength(1);
      expect((await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_auto_skipped'`, [w.id]))[0]?.safe_diff).toMatchObject({ outcome: 'SKIPPED', reason: 'OPEN_REQUEST_EXISTS' });
      expect(await warningOf(w.id)).toMatchObject({ status: 'OPEN', explanation_request_id: null });
    });

    it('skips and says why when the project has no leader in charge or the warning is not open any more, and ignores an event that does not ask for it, is of another kind or of another tenant', async () => {
      const bare = await project();
      const noLeader = await warning(bare, { auto: true });
      expect(await consumer().handle(delivery(noLeader.id))).toBe('processed');
      expect(await rows('select id from machvon.explanation_request where warning_id = $1::uuid', [noLeader.id])).toHaveLength(0);
      const skipped = await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_auto_skipped'`, [noLeader.id]);
      expect(skipped[0]?.safe_diff).toMatchObject({ outcome: 'SKIPPED', reason: 'NO_LEADER_IN_CHARGE' });
      const led = await project();
      await leaderOf(led);
      const gone = await warning(led, { auto: true });
      await closeWarning(gone.id);
      expect(await consumer().handle(delivery(gone.id))).toBe('processed');
      expect((await rows<{ safe_diff: Record<string, unknown> }>(`select safe_diff from machvon.audit_event where resource_id = $1 and action = 'prj.explanation_auto_skipped'`, [gone.id]))[0]?.safe_diff).toMatchObject({ reason: 'WARNING_NOT_OPEN' });
      const quiet = await warning(led, { auto: true });
      await rows(`update machvon.early_warning set status = 'ACKNOWLEDGED', acknowledged_by = $2::uuid, acknowledged_at = now(), acknowledgement_note = 'seen' where id = $1::uuid`, [quiet.id, memberId(ADMIN)]);
      expect(await consumer().handle(delivery(quiet.id, { auto_explanation: false }))).toBe('ignored');
      expect(await consumer().handle(delivery(quiet.id, {}, randomUUID(), 'snapshot.frozen.v1'))).toBe('ignored');
      expect(await consumer().handle(delivery(quiet.id, { tenant_id: TENANT_B }))).toBe('ignored');
      await expect(consumer().handle(delivery('not-an-id'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await rows('select id from machvon.explanation_request where warning_id = $1::uuid', [quiet.id])).toHaveLength(0);
      expect(await consumer().handle(delivery(randomUUID()))).toBe('processed');
    });
  });
});
