import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { AuditWriter, DgvIncidentSweepJob, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { DgvCatalogController, DgvDatasetController } from '../../src/modules/dgv/dgv-dataset.controller';
import { DgvIncidentCommandsController, QualityExceptionReadsController, QualityIncidentReadsController } from '../../src/modules/dgv/dgv-incident.controller';
import { DgvQualityCommandsController, DgvScorecardController, QualityRuleReadsController, QualityRunReadsController } from '../../src/modules/dgv/dgv-quality.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedFinishedRun, seedWorkingContract } from '../../../../packages/db/test/support/dgv-quality-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const STEWARD = 1; // triages and verifies
const OWNER = 2; // owns the datasets and the exceptions; may review
const ENG = 3; // works incidents and may also verify (to try to verify their own work)
const ENG_TWO = 4; // works incidents, nothing else
const REVIEWER = 5; // decides on exceptions
const OUTSIDER = 6; // reads incidents and exceptions, sees no dataset of the other rights
const NOBODY = 7;
const UNIT_TRIAGER = 8; // triage on a unit subtree only
const OTHER_TENANT = 9;
const HOUR = 3_600_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('quality incidents and exceptions over HTTP (ST-DGV-003)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let tenants: TenantDatabase;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  const assign = (member: number, id: string, version: number, body: Record<string, unknown>) => call('POST', `/dgv/quality-incidents/${id}/assignment`, { member, ifMatch: `"${version}"`, body });
  const transition = (member: number, id: string, version: number, body: Record<string, unknown>) => call('POST', `/dgv/quality-incidents/${id}/transition`, { member, ifMatch: `"${version}"`, body });
  const verify = (member: number, id: string, version: number, body: Record<string, unknown>) => call('POST', `/dgv/quality-incidents/${id}/verification`, { member, ifMatch: `"${version}"`, body });
  const decide = (member: number, id: string, version: number, body: Record<string, unknown>) => call('POST', `/quality-exceptions/${id}/decision`, { member, ifMatch: `"${version}"`, body });
  const incident = (member: number, id: string, tenantId?: string) => call('GET', `/resources/quality_incident/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const stored = async (id: string) =>
    (await rows<{ status: string; version: string; assignee_user_id: string | null; verified_by: string | null; reopened_count: number; root_cause: string | null; sla_breached_at: string | null }>(
      'select status, version::text, assignee_user_id, verified_by, reopened_count, root_cause, sla_breached_at::text from machvon.quality_incident where id = $1',
      [id],
    ))[0];
  const events = (id: string) => rows<{ event_kind: string; actor_user_id: string | null; from_status: string | null; to_status: string | null }>('select event_kind, actor_user_id, from_status, to_status from machvon.quality_incident_event where incident_id = $1 order by occurred_at, id', [id]);
  const outbox = (id: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);

  interface World {
    datasetId: string;
    contractId: string;
    ruleId: string;
    runId: string;
    code: string;
  }

  /** A dataset of the DIS module with its working contract, an approved rule on it and a finished run: what an incident is about. */
  async function world(extra: Record<string, unknown> = {}, allowedRoles?: string[]): Promise<World> {
    counter += 1;
    const code = `DS-INC-${counter}-${randomUUID().slice(0, 5)}`.toUpperCase();
    const created = await call('POST', '/dgv/datasets', {
      member: STEWARD,
      body: { dataset_code: code, title: `Incident dataset ${counter}`, domain: 'DISBURSEMENT', grain: 'one row per project', producer_module: 'DIS', owner_user_id: memberId(OWNER), steward_user_id: memberId(STEWARD), classification: 'INTERNAL', is_critical: true, freshness_slo_seconds: 86_400, ...extra },
    });
    expect(created.status).toBe(200);
    const datasetId = created.json.resource_id as string;
    if (allowedRoles !== undefined) await rows('update machvon.dataset set allowed_role_codes = $2::text[] where id = $1', [datasetId, allowedRoles]);
    const contractId = await seedWorkingContract(harness, TENANT_A, datasetId, code, OWNER);
    const rule = await call('POST', '/dgv/quality-rules', {
      member: STEWARD,
      body: { contract_id: contractId, code: 'R-UNIQ', dimension: 'COMPLETENESS', expression_ast: { op: 'not_null', field: 'project_id' }, severity: 'HIGH', threshold_json: { min_pass_rate_pct: '99.5' }, action_on_fail: 'HARD_BLOCK', criticality_weight: 3 },
    });
    expect(rule.status).toBe(200);
    const ruleId = rule.json.resource_id as string;
    expect((await call('POST', `/dgv/quality-rules/${ruleId}/approval`, { member: OWNER, ifMatch: '"1"', body: {} })).status).toBe(200);
    const runId = await seedFinishedRun(harness, TENANT_A, { datasetId, contractId, ageHours: 2, overall: 'FAILED', score: '70' });
    return { datasetId, contractId, ruleId, runId, code };
  }

  /** An incident as the run leaves it: OPEN, owned by the owner of the dataset, due `dueInHours` from now (negative: already late). */
  async function openIncident(w: World, options: { severity?: string; dueInHours?: number; status?: string; assignee?: number; rootCause?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const status = options.status ?? 'OPEN';
    const resolved = ['RESOLVED_PENDING_VERIFICATION', 'CLOSED'].includes(status);
    await rows(
      `insert into machvon.quality_incident (tenant_id, id, rule_id, dataset_version_id, affected_refs, severity, owner_id, status, due_at, title, run_id, sla_hours, assignee_user_id, root_cause, remediation, resolved_at, verified_by, verified_at, closed_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, '[]'::jsonb, $4, $5::uuid, $6, now() + $7::numeric * interval '1 hour', $8, $9::uuid, 24, $10::uuid,
               case when $11 then 'Trùng khóa do nhập hai lần.' end, case when $11 then 'Thêm ràng buộc duy nhất ở nguồn.' end, case when $11 then now() end,
               case when $6 = 'CLOSED' then $12::uuid end, case when $6 = 'CLOSED' then now() end, case when $6 = 'CLOSED' then now() end)`,
      [id, w.ruleId, randomUUID(), options.severity ?? 'HIGH', memberId(OWNER), status, options.dueInHours ?? 24, `${w.code} / R-UNIQ`, w.runId, options.assignee === undefined ? null : memberId(options.assignee), resolved, memberId(STEWARD)],
    );
    await rows("insert into machvon.quality_incident_event (tenant_id, id, incident_id, event_kind, to_status) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'CREATED', 'OPEN')", [id]);
    return id;
  }

  /** A run of the dataset finished now, with the result of the rule in it. */
  async function rerun(w: World, result: 'PASS' | 'WARN' | 'FAIL' | 'ERROR', ageHours = 0): Promise<void> {
    const runId = await seedFinishedRun(harness, TENANT_A, { datasetId: w.datasetId, contractId: w.contractId, ageHours, overall: result === 'PASS' ? 'PASSED' : 'FAILED', score: result === 'PASS' ? '100' : '60' });
    await rows(
      `insert into machvon.quality_rule_result (tenant_id, id, run_id, rule_version_id, evaluated_count, passed_count, failed_count, quarantined_count, measured_value, threshold_snapshot, result)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 100, $3, $4, 0, $5, '{"min_pass_rate_pct":"99.5"}'::jsonb, $6)`,
      [runId, w.ruleId, result === 'PASS' ? 100 : 90, result === 'PASS' ? 0 : 10, result === 'PASS' ? 100 : 90, result],
    );
  }

  /** An exception of a run, OPEN, owned by the owner of the dataset. */
  async function exception(w: World, options: { incidentId?: string; record?: Record<string, unknown> } = {}): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.quality_exception (tenant_id, id, run_id, record_reference, owner_id, reason, status, evidence, rule_version_id, incident_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::jsonb, $4::uuid, 'Trùng khóa ở dòng này', 'OPEN', '{"rule_code":"R-UNIQ"}'::jsonb, $5::uuid, $6::uuid)`,
      [id, w.runId, JSON.stringify(options.record ?? { row_id: randomUUID() }), memberId(OWNER), w.ruleId, options.incidentId ?? null],
    );
    return id;
  }

  const sweep = (now: Date) =>
    tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => new DgvIncidentSweepJob(new AuditWriter(tenants)).run(tx, WORKER_MEMBERSHIP_ID, now));

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [STEWARD, OWNER, ENG, ENG_TWO, REVIEWER, OUTSIDER, NOBODY, UNIT_TRIAGER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, 1);
    const reads = ['data.catalog.read', 'data.quality.read', 'quality_incident.read', 'quality_exception.read', 'quality_rule_version.read', 'quality_run.read'];
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', ['data.catalog.manage', 'data.quality.manage', 'data.quality.run', 'data.quality.triage', ...reads], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_OWNER', ['data.quality.approve', 'data.quality.review', ...reads], 30);
    await harness.seedRole(TENANT_A, 3, 'DATA_ENGINEER_LEAD', ['data.quality.remediate', 'data.quality.triage', ...reads], 25);
    await harness.seedRole(TENANT_A, 4, 'DATA_ENGINEER', ['data.quality.remediate', ...reads], 20);
    await harness.seedRole(TENANT_A, 5, 'DATA_REVIEWER', ['data.quality.review', ...reads], 20);
    await harness.seedRole(TENANT_A, 6, 'OUTSIDE_READER', ['quality_incident.read', 'quality_exception.read'], 10);
    await harness.seedRole(TENANT_A, 7, 'UNIT_TRIAGER', ['data.quality.triage', 'data.quality.review', ...reads], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: ENG, role: 3, kind: 'TENANT' },
      { n: 4, member: ENG_TWO, role: 4, kind: 'TENANT' },
      { n: 5, member: REVIEWER, role: 5, kind: 'TENANT' },
      { n: 6, member: OUTSIDER, role: 6, kind: 'TENANT' },
      { n: 7, member: UNIT_TRIAGER, role: 7, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedRole(TENANT_B, 1, 'DATA_STEWARD', ['data.quality.triage', 'quality_incident.read'], 40);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DgvDatasetController, DgvCatalogController, DgvQualityCommandsController, DgvScorecardController, QualityRuleReadsController, QualityRunReadsController, DgvIncidentCommandsController, QualityIncidentReadsController, QualityExceptionReadsController],
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

  it('AC-ST-DGV-003-1: UAT-AC487 takes a HIGH incident from OPEN to CLOSED: no resolution without the cause, no verification by the handler, none before a rerun that passes, one event per step', async () => {
    const w = await world();
    const id = await openIncident(w);
    // Triage: the handler must hold the right to work incidents, the due time must be ahead.
    expect(await assign(STEWARD, id, 1, { assignee_user_id: memberId(NOBODY), due_at: new Date(Date.now() + 24 * HOUR).toISOString() })).toMatchObject({ status: 422, json: { code: 'ASSIGNEE_OUT_OF_SCOPE' } });
    expect(await assign(STEWARD, id, 1, { assignee_user_id: randomUUID(), due_at: new Date(Date.now() + 24 * HOUR).toISOString() })).toMatchObject({ status: 422, json: { code: 'ASSIGNEE_OUT_OF_SCOPE' } });
    expect(await assign(STEWARD, id, 1, { assignee_user_id: memberId(ENG), due_at: new Date(Date.now() - HOUR).toISOString() })).toMatchObject({ status: 422, json: { detail: 'due_at' } });
    expect(await assign(STEWARD, id, 9, { assignee_user_id: memberId(ENG), due_at: new Date(Date.now() + 24 * HOUR).toISOString() })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await stored(id))?.status).toBe('OPEN');
    const assigned = await assign(STEWARD, id, 1, { assignee_user_id: memberId(ENG), due_at: new Date(Date.now() + 24 * HOUR).toISOString(), note: 'Ưu tiên xử lý hôm nay.' });
    expect(assigned).toMatchObject({ status: 200, json: { status: 'ASSIGNED', resource_version: 2 } });

    // A screen that read an older version is told so before anything about the state or the person (it reads again).
    expect(await transition(ENG, id, 1, { to_status: 'IN_PROGRESS' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await transition(ENG_TWO, id, 1, { to_status: 'ACKNOWLEDGED' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    // The handler only: another engineer is refused; a step cannot be skipped.
    expect(await transition(ENG_TWO, id, 2, { to_status: 'ACKNOWLEDGED' })).toMatchObject({ status: 403, json: { code: 'NOT_ASSIGNEE' } });
    expect(await transition(ENG, id, 2, { to_status: 'IN_PROGRESS' })).toMatchObject({ status: 409, json: { code: 'INCIDENT_STATE_INVALID' } });
    expect(await transition(ENG, id, 2, { to_status: 'ACKNOWLEDGED' })).toMatchObject({ status: 200, json: { status: 'ACKNOWLEDGED', resource_version: 3 } });
    expect(await transition(ENG, id, 3, { to_status: 'IN_PROGRESS' })).toMatchObject({ status: 200, json: { status: 'IN_PROGRESS' } });
    // Resolving without the cause (or the measure) is refused and changes nothing.
    expect(await transition(ENG, id, 4, { to_status: 'RESOLVED_PENDING_VERIFICATION', remediation: 'Thêm ràng buộc duy nhất ở nguồn.' })).toMatchObject({ status: 422, json: { code: 'ROOT_CAUSE_REQUIRED', detail: 'root_cause' } });
    expect(await transition(ENG, id, 4, { to_status: 'RESOLVED_PENDING_VERIFICATION', root_cause: 'Trùng khóa do nhập hai lần.' })).toMatchObject({ status: 422, json: { code: 'ROOT_CAUSE_REQUIRED', detail: 'remediation' } });
    expect((await stored(id))?.status).toBe('IN_PROGRESS');
    expect(await transition(ENG, id, 4, { to_status: 'RESOLVED_PENDING_VERIFICATION', root_cause: ' Trùng khóa do nhập hai lần. ', remediation: 'Thêm ràng buộc duy nhất ở nguồn.' })).toMatchObject({ status: 200, json: { status: 'RESOLVED_PENDING_VERIFICATION', resource_version: 5 } });

    // The handler does not verify their own work; the steward does not close before a rerun passes.
    expect(await verify(ENG, id, 5, { decision: 'CLOSE', note: 'Tôi tự xác nhận công việc của mình.' })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await verify(STEWARD, id, 5, { decision: 'CLOSE', note: 'Chưa có lần chạy lại nào.' })).toMatchObject({ status: 422, json: { code: 'RERUN_NOT_PASSED' } });
    await rerun(w, 'FAIL');
    expect(await verify(STEWARD, id, 5, { decision: 'CLOSE', note: 'Lần chạy lại vẫn lỗi.' })).toMatchObject({ status: 422, json: { code: 'RERUN_NOT_PASSED' } });
    expect((await stored(id))?.status).toBe('RESOLVED_PENDING_VERIFICATION');
    await rerun(w, 'PASS');
    // A run that could not be measured, after the one that passed, is the latest word: it is not a pass.
    await rows("insert into machvon.quality_run (tenant_id, id, dataset_contract_id, snapshot_id, rule_version_ids, passed_count, failed_count, quarantined_count, started_at, finished_at, dataset_id, trigger, status, failure_code, hard_fail, certified_blocked) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, gen_random_uuid(), jsonb_build_array(gen_random_uuid()::text), 0, 0, 0, now(), now() + interval '1 second', $2::uuid, 'MANUAL', 'FAILED', 'EXECUTION_FAILED', false, false)", [w.contractId, w.datasetId]);
    expect(await verify(STEWARD, id, 5, { decision: 'CLOSE', note: 'Lần chạy cuối không đo được.' })).toMatchObject({ status: 422, json: { code: 'RERUN_NOT_PASSED' } });
    // ...and a pass after that is the latest word again.
    await rerun(w, 'PASS', -1);
    expect(await verify(STEWARD, id, 5, { decision: 'CLOSE', note: 'Chạy lại đạt, đã kiểm tra ràng buộc.' })).toMatchObject({ status: 200, json: { status: 'CLOSED', resource_version: 6 } });
    expect(await stored(id)).toMatchObject({ status: 'CLOSED', verified_by: memberId(STEWARD), assignee_user_id: memberId(ENG) });
    expect((await events(id)).map((entry) => [entry.event_kind, entry.to_status])).toEqual([
      ['CREATED', 'OPEN'],
      ['ASSIGNED', 'ASSIGNED'],
      ['STATUS_CHANGED', 'ACKNOWLEDGED'],
      ['STATUS_CHANGED', 'IN_PROGRESS'],
      ['STATUS_CHANGED', 'RESOLVED_PENDING_VERIFICATION'],
      ['VERIFIED', 'CLOSED'],
    ]);
    expect((await outbox(id, 'dgv.incident.closed.v1'))[0]?.payload).toMatchObject({ incident_id: id, status: 'CLOSED', verified_by: memberId(STEWARD) });
    expect((await outbox(id, 'dgv.incident.status_changed.v1')).length).toBe(3);
    // A closed incident is not worked any more.
    expect(await transition(ENG, id, 6, { to_status: 'ACKNOWLEDGED' })).toMatchObject({ status: 409, json: { code: 'INCIDENT_STATE_INVALID' } });
    expect(await assign(STEWARD, id, 6, { assignee_user_id: memberId(ENG), due_at: new Date(Date.now() + HOUR).toISOString() })).toMatchObject({ status: 409, json: { code: 'INCIDENT_STATE_INVALID' } });
    const shown = (await incident(STEWARD, id)).json;
    expect(shown).toMatchObject({ status: 'CLOSED', verified_by: memberId(STEWARD), root_cause: 'Trùng khóa do nhập hai lần.', reopened_count: 0, actions: { assign: false, advance: null, verify: false } });
    expect((shown.events as unknown[]).length).toBe(6);
  });

  it('reopens an incident the verifier is not satisfied with, counts it, and gives it back to the handler', async () => {
    const w = await world();
    const id = await openIncident(w, { status: 'RESOLVED_PENDING_VERIFICATION', assignee: ENG });
    expect(await verify(STEWARD, id, 1, { decision: 'REOPEN', note: 'ngắn' })).toMatchObject({ status: 422 });
    expect(await verify(ENG, id, 1, { decision: 'REOPEN', note: 'Tự mở lại cũng không được phép.' })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await verify(STEWARD, id, 1, { decision: 'REOPEN', note: 'Nguyên nhân chưa được xử lý ở nguồn.' })).toMatchObject({ status: 200, json: { status: 'REOPENED', resource_version: 2 } });
    expect(await stored(id)).toMatchObject({ status: 'REOPENED', reopened_count: 1, assignee_user_id: memberId(ENG) });
    expect((await events(id)).at(-1)).toMatchObject({ event_kind: 'REOPENED', from_status: 'RESOLVED_PENDING_VERIFICATION', to_status: 'REOPENED' });
    expect((await outbox(id, 'dgv.incident.reopened.v1')).length).toBe(1);
    // The handler takes it up again.
    expect(await transition(ENG, id, 2, { to_status: 'ACKNOWLEDGED' })).toMatchObject({ status: 200, json: { status: 'ACKNOWLEDGED' } });
    // Not waiting for verification: nothing to verify.
    const working = await openIncident(w, { status: 'IN_PROGRESS', assignee: ENG });
    expect(await verify(STEWARD, working, 1, { decision: 'CLOSE', note: 'Chưa giải quyết xong mà đóng.' })).toMatchObject({ status: 409, json: { code: 'INCIDENT_STATE_INVALID' } });
  });

  it('marks an incident past its due time once and tells the owner and the handler; a new due time can break the SLA again', async () => {
    const w = await world();
    const late = await openIncident(w, { status: 'IN_PROGRESS', assignee: ENG, dueInHours: -1 });
    const onTime = await openIncident(w, { status: 'IN_PROGRESS', assignee: ENG, dueInHours: 5 });
    const resolved = await openIncident(w, { status: 'RESOLVED_PENDING_VERIFICATION', assignee: ENG, dueInHours: -1 });
    const first = await sweep(new Date());
    expect(first.breached).toBeGreaterThanOrEqual(1);
    expect((await stored(late))?.sla_breached_at).not.toBeNull();
    expect((await stored(onTime))?.sla_breached_at).toBeNull();
    // Once resolved, an incident is waiting for someone else, not late.
    expect((await stored(resolved))?.sla_breached_at).toBeNull();
    const sent = await outbox(late, 'dgv.incident.sla_breached.v1');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ incident_id: late, severity: 'HIGH', notification: { resource: { type: 'quality_incident', id: late }, recipients: expect.arrayContaining([memberId(OWNER), memberId(ENG)]) } });
    expect((await events(late)).filter((entry) => entry.event_kind === 'SLA_BREACHED')).toHaveLength(1);
    expect((await sweep(new Date())).breached).toBe(0);
    expect(await outbox(late, 'dgv.incident.sla_breached.v1')).toHaveLength(1);
    // Given a later due time and late again, it is announced again.
    const version = Number((await stored(late))?.version);
    expect((await assign(STEWARD, late, version, { assignee_user_id: memberId(ENG), due_at: new Date(Date.now() + HOUR).toISOString() })).status).toBe(200);
    expect((await stored(late))?.sla_breached_at).toBeNull();
    await rows("update machvon.quality_incident set due_at = now() - interval '1 minute' where id = $1", [late]);
    expect((await sweep(new Date())).breached).toBeGreaterThanOrEqual(1);
    expect(await outbox(late, 'dgv.incident.sla_breached.v1')).toHaveLength(2);
  });

  it('AC-ST-DGV-003-2: UAT-AC54 opens a new exception when a waiver ends, reopens the closed incident once, tells the handler, and a second run changes nothing', async () => {
    const w = await world();
    const closed = await openIncident(w, { status: 'CLOSED', assignee: ENG });
    const qe = await exception(w, { incidentId: closed });
    // Waived by the reviewer until a day in the near future; the waiver ends when the sweep runs after it.
    const until = new Date(Date.now() + 2 * HOUR);
    expect(await decide(REVIEWER, qe, 1, { decision: 'WAIVED', reason: 'Dòng này chờ nguồn sửa trong tháng.', waiver_expires_at: until.toISOString() })).toMatchObject({ status: 200, json: { status: 'WAIVED', resource_version: 2 } });
    // Before the end nothing changes.
    expect((await sweep(new Date(until.getTime() - HOUR))).reopened).toBe(0);
    const later = new Date(until.getTime() + 5 * 60_000);
    const swept = await sweep(later);
    expect(swept.reopened).toBe(1);
    const next = await rows<{ id: string; status: string; reopened_from_id: string; decision: string | null }>('select id, status, reopened_from_id, decision from machvon.quality_exception where reopened_from_id = $1', [qe]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ status: 'OPEN', reopened_from_id: qe, decision: null });
    // The waived one stays as it was (the history of the waiver is kept).
    expect((await rows<{ status: string; waiver_reason: string }>('select status, waiver_reason from machvon.quality_exception where id = $1', [qe]))[0]).toEqual({ status: 'WAIVED', waiver_reason: 'Dòng này chờ nguồn sửa trong tháng.' });
    expect(await stored(closed)).toMatchObject({ status: 'REOPENED', reopened_count: 1, verified_by: null });
    const reopening = (await events(closed)).at(-1);
    expect(reopening).toMatchObject({ event_kind: 'REOPENED', from_status: 'CLOSED', to_status: 'REOPENED' });
    expect(reopening?.actor_user_id).toBe(WORKER_MEMBERSHIP_ID);
    const told = await outbox(next[0]?.id as string, 'dgv.exception.reopened.v1');
    expect(told[0]?.payload).toMatchObject({ reopened_from_id: qe, incident_id: closed, notification: { recipients: [memberId(ENG)] } });
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where resource_id = $1 and action = 'dgv.quality_exception_reopened'", [next[0]?.id]))[0]?.n).toBe('1');
    // Again: nothing more.
    expect((await sweep(new Date(later.getTime() + HOUR))).reopened).toBe(0);
    expect(await stored(closed)).toMatchObject({ status: 'REOPENED', reopened_count: 1 });
    expect(await rows('select id from machvon.quality_exception where reopened_from_id = $1', [qe])).toHaveLength(1);
    // The waiver does not change the data it is about: the record reference is as it was.
    expect((await rows<{ record_reference: unknown }>('select record_reference from machvon.quality_exception where id = $1', [qe]))[0]?.record_reference).toEqual((await rows<{ record_reference: unknown }>('select record_reference from machvon.quality_exception where id = $1', [next[0]?.id]))[0]?.record_reference);
  });

  it('sends an exception whose waiver ended to the incident that is open for the rule when a later failure opened another, and leaves the closed one closed', async () => {
    const w = await world();
    const closed = await openIncident(w, { status: 'CLOSED', assignee: ENG });
    const current = await openIncident(w, { status: 'IN_PROGRESS', assignee: ENG_TWO });
    const qe = await exception(w, { incidentId: closed });
    const until = new Date(Date.now() + HOUR);
    expect((await decide(REVIEWER, qe, 1, { decision: 'WAIVED', reason: 'Dòng này chờ nguồn sửa trong tháng.', waiver_expires_at: until.toISOString() })).status).toBe(200);
    expect((await sweep(new Date(until.getTime() + 60_000))).reopened).toBe(1);
    const next = (await rows<{ incident_id: string }>('select incident_id from machvon.quality_exception where reopened_from_id = $1', [qe]))[0];
    expect(next?.incident_id).toBe(current);
    expect((await stored(closed))?.status).toBe('CLOSED');
    expect(await stored(current)).toMatchObject({ status: 'IN_PROGRESS', reopened_count: 0 });
    expect((await outbox((await rows<{ id: string }>('select id from machvon.quality_exception where reopened_from_id = $1', [qe]))[0]?.id as string, 'dgv.exception.reopened.v1'))[0]?.payload).toMatchObject({ incident_id: current, notification: { recipients: [memberId(ENG_TWO)] } });
  });

  it('decides on an exception: a reason, an end of at most 180 days for a waiver, not by its owner, once', async () => {
    const w = await world();
    const qe = await exception(w);
    const end = (days: number) => new Date(Date.now() + days * 24 * HOUR).toISOString();
    expect(await decide(OWNER, qe, 1, { decision: 'RESOLVED', reason: 'Đã sửa dòng này ở nguồn.' })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await decide(REVIEWER, qe, 1, { decision: 'WAIVED', reason: 'Chờ nguồn sửa dữ liệu.' })).toMatchObject({ status: 422, json: { detail: 'waiver_expires_at' } });
    expect(await decide(REVIEWER, qe, 1, { decision: 'WAIVED', reason: 'Chờ nguồn sửa dữ liệu.', waiver_expires_at: end(181) })).toMatchObject({ status: 422, json: { detail: 'waiver_expires_at' } });
    expect(await decide(REVIEWER, qe, 1, { decision: 'WAIVED', reason: 'Chờ nguồn sửa dữ liệu.', waiver_expires_at: end(-1) })).toMatchObject({ status: 422, json: { detail: 'waiver_expires_at' } });
    expect(await decide(REVIEWER, qe, 1, { decision: 'RESOLVED', reason: 'ngắn' })).toMatchObject({ status: 422 });
    expect(await decide(REVIEWER, qe, 1, { decision: 'RESOLVED', reason: 'Đã sửa dòng này ở nguồn.', waiver_expires_at: end(5) })).toMatchObject({ status: 422, json: { detail: 'waiver_expires_at' } });
    expect(await decide(REVIEWER, qe, 5, { decision: 'RESOLVED', reason: 'Đã sửa dòng này ở nguồn.' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await decide(STEWARD, qe, 1, { decision: 'RESOLVED', reason: 'Không có quyền duyệt ngoại lệ.' })).toMatchObject({ status: 403 });
    expect(await decide(UNIT_TRIAGER, qe, 1, { decision: 'RESOLVED', reason: 'Quyền chỉ trên một đơn vị.' })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await decide(REVIEWER, qe, 1, { decision: 'WAIVED', reason: 'Chờ nguồn sửa dữ liệu.', waiver_expires_at: end(180) })).toMatchObject({ status: 200, json: { status: 'WAIVED', resource_version: 2 } });
    expect(await decide(REVIEWER, qe, 2, { decision: 'RESOLVED', reason: 'Đã sửa dòng này ở nguồn.' })).toMatchObject({ status: 409, json: { code: 'EXCEPTION_STATE_INVALID' } });
    expect((await outbox(qe, 'dgv.exception.decided.v1'))[0]?.payload).toMatchObject({ exception_id: qe, decision: 'WAIVED' });
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where resource_id = $1 and action = 'dgv.quality_exception_decided'", [qe]))[0]?.n).toBe('1');
    const resolved = await exception(w);
    expect(await decide(REVIEWER, resolved, 1, { decision: 'RESOLVED', reason: 'Đã sửa dòng này ở nguồn.' })).toMatchObject({ status: 200, json: { status: 'RESOLVED' } });
  });

  it('AC-ST-DGV-003-3: UAT-AC55 hides the values of the record of an exception from whoever may not see the dataset, and the incident with it', async () => {
    const personal = await world({ classification: 'PERSONAL' }, ['LND']);
    const id = await openIncident(personal);
    const qe = await exception(personal, { incidentId: id, record: { row_id: 'HH-0001', national_id: '012345672345', owner_name: 'Nguyễn Văn An' } });
    const seen = (await call('GET', `/resources/quality_exception/${qe}`, { member: OUTSIDER })).json;
    expect(seen).toMatchObject({ masked: true, record_reference: { row_id: '***0001', national_id: '***2345', owner_name: '***n An' }, evidence: { rule_code: '***UNIQ' }, dataset: { code: personal.code } });
    expect(JSON.stringify(seen)).not.toContain('012345672345');
    const listed = ((await call('GET', '/resources/quality_exception?limit=200', { member: OUTSIDER })).json.items as Array<{ id: string; masked: boolean; record_reference: Record<string, string> }>).find((item) => item.id === qe);
    expect(listed).toMatchObject({ masked: true, record_reference: { national_id: '***2345' } });
    // The reason written with a decision is the dataset's too.
    await rows("update machvon.quality_exception set status = 'RESOLVED', decision = 'RESOLVED', decided_by = $2::uuid, decided_at = now(), waiver_reason = 'Đã sửa số CCCD 012345672345 ở nguồn.' where id = $1", [qe, memberId(REVIEWER)]);
    expect((await call('GET', `/resources/quality_exception/${qe}`, { member: OUTSIDER })).json).toMatchObject({ waiver_reason: '***uồn.' });
    expect(JSON.stringify((await call('GET', '/resources/quality_exception?limit=200', { member: OUTSIDER })).json)).not.toContain('012345672345');
    // The owner of the dataset sees it whole.
    expect((await call('GET', `/resources/quality_exception/${qe}`, { member: OWNER })).json).toMatchObject({ masked: false, record_reference: { national_id: '012345672345' } });
    // The incident of a dataset that is not theirs is not there for the outsider.
    expect((await incident(OUTSIDER, id)).status).toBe(404);
    const outsiderIncidents = ((await call('GET', '/resources/quality_incident?limit=200', { member: OUTSIDER })).json.items as Array<{ id: string }>).map((item) => item.id);
    expect(outsiderIncidents).not.toContain(id);
    expect(((await call('GET', '/resources/quality_incident?limit=200', { member: OWNER })).json.items as Array<{ id: string }>).map((item) => item.id)).toContain(id);
    // The command on it is as good as none for them too (they have no right to triage anyway).
    expect((await assign(OUTSIDER, id, 1, { assignee_user_id: memberId(ENG), due_at: new Date(Date.now() + HOUR).toISOString() })).status).toBe(403);
  });

  it('does not give an incident to a handler who may not see its dataset', async () => {
    const restricted = await world({ classification: 'PERSONAL' }, ['LND']);
    const id = await openIncident(restricted);
    // ENG holds the right to work incidents on the whole tenant but the dataset is for the role LND only.
    expect(await assign(STEWARD, id, 1, { assignee_user_id: memberId(ENG_TWO), due_at: new Date(Date.now() + HOUR).toISOString() })).toMatchObject({ status: 422, json: { code: 'ASSIGNEE_OUT_OF_SCOPE' } });
    // The owner of the dataset sees it: the owner is a handler it can be given to once the owner holds the right.
    await rows("update machvon.dataset set steward_user_id = $2::uuid where id = $1", [restricted.datasetId, memberId(ENG_TWO)]);
    expect(await assign(STEWARD, id, 1, { assignee_user_id: memberId(ENG_TWO), due_at: new Date(Date.now() + HOUR).toISOString() })).toMatchObject({ status: 200, json: { status: 'ASSIGNED' } });
  });

  it('shows the incidents of the datasets the viewer may see, newest first, narrowed and in pages, with what the viewer may do, and nothing of another tenant', async () => {
    const w = await world();
    const a = await openIncident(w, { severity: 'CRITICAL', dueInHours: -2 });
    const b = await openIncident(w, { severity: 'LOW', status: 'ASSIGNED', assignee: ENG });
    const c = await openIncident(w, { severity: 'LOW', status: 'RESOLVED_PENDING_VERIFICATION', assignee: ENG });
    const ids = async (member: number, query: string): Promise<string[]> => ((await call('GET', `/resources/quality_incident?limit=200${query}`, { member })).json.items as Array<{ id: string }>).map((item) => item.id);
    expect(await ids(STEWARD, `&dataset_id=${w.datasetId}`)).toEqual([c, b, a]);
    expect(await ids(STEWARD, `&dataset_id=${w.datasetId}&severity=LOW`)).toEqual([c, b]);
    expect(await ids(STEWARD, `&dataset_id=${w.datasetId}&status=ASSIGNED`)).toEqual([b]);
    expect(await ids(STEWARD, `&dataset_id=${w.datasetId}&assignee_id=${memberId(ENG)}`)).toEqual([c, b]);
    expect(await ids(STEWARD, `&dataset_id=${w.datasetId}&overdue=true`)).toEqual([a]);
    expect(await ids(STEWARD, `&dataset_id=${w.datasetId}&overdue=false`)).toEqual([c, b]);
    const page = (await call('GET', `/resources/quality_incident?limit=2&dataset_id=${w.datasetId}`, { member: STEWARD })).json;
    expect((page.items as unknown[]).length).toBe(2);
    const rest = (await call('GET', `/resources/quality_incident?limit=2&dataset_id=${w.datasetId}&cursor=${page.next_cursor as string}`, { member: STEWARD })).json;
    expect((rest.items as Array<{ id: string }>).map((item) => item.id)).toEqual([a]);
    for (const bad of ['status=NOPE', 'severity=NOPE', 'assignee_id=x', 'dataset_id=x', 'overdue=maybe', 'limit=0', 'cursor=bad', `cursor=${Buffer.from(JSON.stringify(['invalid', randomUUID()])).toString('base64url')}`]) {
      expect([bad, (await call('GET', `/resources/quality_incident?${bad}`, { member: STEWARD })).status]).toEqual([bad, 422]);
    }
    // What each one may do, from the rights and the state.
    expect((await incident(STEWARD, a)).json).toMatchObject({ is_overdue: true, severity: 'CRITICAL', actions: { assign: true, advance: null, verify: false } });
    expect((await incident(ENG, b)).json).toMatchObject({ assignee: { id: memberId(ENG) }, actions: { assign: true, advance: 'ACKNOWLEDGED', verify: false } });
    expect((await incident(ENG_TWO, b)).json).toMatchObject({ actions: { assign: false, advance: null, verify: false } });
    expect((await incident(STEWARD, c)).json).toMatchObject({ actions: { assign: false, advance: null, verify: true } });
    expect((await incident(ENG, c)).json).toMatchObject({ actions: { verify: false } });
    // Another tenant, a person without the right to read, a missing incident.
    expect((await incident(OTHER_TENANT, a, TENANT_B)).status).toBe(404);
    expect((await incident(NOBODY, a)).status).toBe(403);
    expect((await incident(STEWARD, randomUUID())).status).toBe(404);
    expect((await call('GET', '/resources/quality_exception', { member: NOBODY })).status).toBe(403);
    // The right to triage on a unit does not reach datasets, which belong to no unit.
    expect((await assign(UNIT_TRIAGER, a, 1, { assignee_user_id: memberId(ENG), due_at: new Date(Date.now() + HOUR).toISOString() })).status).toBe(403);
    expect((await assign(NOBODY, a, 1, { assignee_user_id: memberId(ENG), due_at: new Date(Date.now() + HOUR).toISOString() })).status).toBe(403);
    expect((await assign(OTHER_TENANT, a, 1, { assignee_user_id: memberId(ENG), due_at: new Date(Date.now() + HOUR).toISOString() })).status).toBe(403);
  });

  it('keeps the incident as it was written: the database refuses a step out of the chain, a resolution without a cause, a self verification, and the erasing of the history', async () => {
    const w = await world();
    const id = await openIncident(w);
    await expect(rows("update machvon.quality_incident set status = 'IN_PROGRESS' where id = $1", [id])).rejects.toThrow(/does not go from OPEN to IN_PROGRESS/);
    await expect(rows("update machvon.quality_incident set status = 'CLOSED' where id = $1", [id])).rejects.toThrow(/does not go from OPEN to CLOSED/);
    await expect(rows("update machvon.quality_incident set status = 'NOPE' where id = $1", [id])).rejects.toThrow(/does not go from OPEN to NOPE/);
    await expect(rows("update machvon.quality_incident set severity = 'LOW' where id = $1", [id])).rejects.toThrow(/not changed/);
    await expect(rows("update machvon.quality_incident set status = 'ASSIGNED' where id = $1", [id])).rejects.toThrow(/quality_incident_assigned_chk/);
    const working = await openIncident(w, { status: 'IN_PROGRESS', assignee: ENG });
    await expect(rows("update machvon.quality_incident set status = 'RESOLVED_PENDING_VERIFICATION', resolved_at = now() where id = $1", [working])).rejects.toThrow(/quality_incident_resolved_chk/);
    const waiting = await openIncident(w, { status: 'RESOLVED_PENDING_VERIFICATION', assignee: ENG });
    await expect(rows("update machvon.quality_incident set status = 'CLOSED', verified_by = assignee_user_id, verified_at = now(), closed_at = now() where id = $1", [waiting])).rejects.toThrow(/quality_incident_verify_sod_chk/);
    await expect(rows("update machvon.quality_incident set status = 'REOPENED' where id = $1", [waiting])).rejects.toThrow(/is counted/);
    const done = await openIncident(w, { status: 'CLOSED', assignee: ENG });
    await expect(rows("update machvon.quality_incident set root_cause = 'Viết lại nguyên nhân sau khi đóng sự cố.' where id = $1", [done])).rejects.toThrow(/closed quality incident is not rewritten/);
    await expect(rows("update machvon.quality_incident set status = 'CLOSED', verified_by = null where id = $1", [done])).rejects.toThrow(/quality_incident_closed_chk|not rewritten/);
    const privileges = (await rows<{ eventUpdate: boolean; eventDelete: boolean; incidentDelete: boolean; exceptionDelete: boolean }>(
      "select has_table_privilege('machvon_app', 'machvon.quality_incident_event', 'UPDATE') as \"eventUpdate\", has_table_privilege('machvon_app', 'machvon.quality_incident_event', 'DELETE') as \"eventDelete\", has_table_privilege('machvon_app', 'machvon.quality_incident', 'DELETE') as \"incidentDelete\", has_table_privilege('machvon_app', 'machvon.quality_exception', 'DELETE') as \"exceptionDelete\"",
    ))[0];
    expect(privileges).toEqual({ eventUpdate: false, eventDelete: false, incidentDelete: false, exceptionDelete: false });
    // An exception decided is not decided again, and a waiver is not longer than 180 days.
    const qe = await exception(w);
    await expect(rows("update machvon.quality_exception set status = 'WAIVED', decision = 'WAIVED', decided_by = $2::uuid, decided_at = now(), waiver_reason = 'Chờ nguồn sửa dữ liệu.', waiver_expires_at = now() + interval '181 days' where id = $1", [qe, memberId(REVIEWER)])).rejects.toThrow(/quality_exception_waiver_max_chk/);
    await expect(rows("update machvon.quality_exception set status = 'WAIVED', decision = 'WAIVED', decided_by = $2::uuid, decided_at = now(), waiver_reason = 'ngắn', waiver_expires_at = now() + interval '1 day' where id = $1", [qe, memberId(REVIEWER)])).rejects.toThrow(/quality_exception_decision_chk/);
    await expect(rows("update machvon.quality_exception set status = 'WAIVED', decision = 'WAIVED', decided_by = owner_id, decided_at = now(), waiver_reason = 'Chờ nguồn sửa dữ liệu.', waiver_expires_at = now() + interval '1 day' where id = $1", [qe])).rejects.toThrow(/quality_exception_sod_chk/);
    await rows("update machvon.quality_exception set status = 'RESOLVED', decision = 'RESOLVED', decided_by = $2::uuid, decided_at = now(), waiver_reason = 'Đã sửa dòng này ở nguồn.' where id = $1", [qe, memberId(REVIEWER)]);
    await expect(rows("update machvon.quality_exception set reason = 'rewritten', status = 'OPEN' where id = $1", [qe])).rejects.toThrow(/written once|quality_exception_decision_chk/);
    await expect(rows("update machvon.quality_exception set record_reference = '{}'::jsonb where id = $1", [qe])).rejects.toThrow(/not changed/);
  });
});
