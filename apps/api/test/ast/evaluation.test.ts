import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { AstEvaluationDueJob, AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { astModule } from '../../src/modules/ast';
import { EvaluationController, EvaluationReadsController } from '../../src/modules/ast/evaluation.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { asSuperuser } from '../../../../packages/db/test/support/ncr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb7;
const ROOT = 1;
const MANAGER = 11; // evaluation.trigger.manage and project.read over the tenant
const READER = 12; // project.read only
const NOBODY = 13;
const NARROW = 14; // evaluation.trigger.manage over another branch, project.read over the tenant: sees the project and may not act on it
const ELSEWHERE = 15; // evaluation.trigger.manage over another branch and nothing else: does not see the project
const FOREIGN = 16; // a member of another tenant with every right over the triggers of that tenant
const MEMBERS = [MANAGER, READER, NOBODY, NARROW, ELSEWHERE];
const OTHER_BRANCH = 5;
const RECEIVING_UNIT = 7;
const CLEAN = id(FAMILY, 31);
const DOCUMENT = id(FAMILY, 30);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the trigger of the evaluation after the investment over HTTP (ST-AST-006, UC-AST-04, UAT-AC394)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';

  const tokenOf = (member: number, tenantId: string = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; key?: string; tenant?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const stage = (sql: string, params: unknown[] = []): Promise<void> => asSuperuser(harness.database.adminUrl, sql, params);
  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; actor_id: string }>('select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const stored = async (triggerId: string) =>
    (
      await rows<{ status: string; version: string; fired_at: string | null; mne_evaluation_id: string | null; outbox_event_id: string | null }>(
        'select status, version::text, fired_at::text, mne_evaluation_id, outbox_event_id from machvon.evaluation_trigger where id = $1::uuid',
        [triggerId],
      )
    )[0];

  /** The job of the day asked for: the clock is the argument, so that a day in 2028 can be run now. */
  const sweep = async (at: string): Promise<number> => {
    const tenants = harness.tenants as TenantDatabase;
    const summary = await tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => new AstEvaluationDueJob(new AuditWriter(tenants)).run(tx, WORKER_MEMBERSHIP_ID, new Date(at)));
    return summary.fired;
  };

  interface Subject {
    projectId: string;
    contractId: string;
    handoverId: string;
  }

  /** A project in implementation with a contract and a handover of the status asked for, accepted at the time given (the day in Vietnam is the 15th of January 2027 for the default). */
  async function subject(options: { handover?: string; acceptedAt?: string; projectStatus?: string } = {}): Promise<Subject> {
    counter += 1;
    const line = await world.publishedLine();
    await world.owner('update machvon.project set status = $2 where id = $1::uuid', [line.projectId, options.projectStatus ?? 'IMPLEMENTATION']);
    const contractId = randomUUID();
    const handoverId = randomUUID();
    const status = options.handover ?? 'ACCEPTED';
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000::numeric, $7, $7, date '2026-01-02', date '2026-01-03')`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, `HD-E-${String(counter).padStart(4, '0')}`, memberId(ROOT)],
      ],
    ]);
    await stage(
      `insert into machvon.handover
         (tenant_id, id, project_id, contract_id, recipient_unit_id, document_version_id, punch_list, status, handover_no, handover_kind, created_by, updated_by, version, accepted_at, accepted_by, as_built_document_version_id)
       values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7, $8, 'COMPLETION', $9, $9, 1, $10::timestamptz, $11, $12)`,
      [
        TENANT_A,
        handoverId,
        line.projectId,
        contractId,
        unitId(RECEIVING_UNIT),
        CLEAN,
        status,
        `BG-E-${counter}`,
        memberId(ROOT),
        status === 'ACCEPTED' ? (options.acceptedAt ?? '2027-01-15T03:00:00Z') : null,
        status === 'ACCEPTED' ? memberId(ROOT) : null,
        status === 'ACCEPTED' ? CLEAN : null,
      ],
    );
    return { projectId: line.projectId, contractId, handoverId };
  }

  const schedule = (member: number, projectId: string, body: Record<string, unknown>, key?: string) =>
    call('POST', `/projects/${projectId}/evaluation-triggers`, { member, ...(key === undefined ? {} : { key }), body });
  const acknowledge = (member: number, triggerId: string, body: Record<string, unknown>) => call('POST', `/evaluation-triggers/${triggerId}/acknowledge`, { member, body });
  const evaluation = async (projectId: string): Promise<string> => {
    const evaluationId = randomUUID();
    await stage(
      `insert into machvon.mne_evaluation (tenant_id, id, project_id, evaluation_kind, evaluator_kind, evaluator_name, scope_text, status, planned_date, created_by, updated_by)
       values ($1, $2, $3, 'FINAL', 'INTERNAL', 'MNE office', 'Post-investment evaluation', 'PLANNED', date '2028-02-01', $4, $4)`,
      [TENANT_A, evaluationId, projectId, memberId(ROOT)],
    );
    return evaluationId;
  };
  /** A trigger after the handover of the subject, due on the earliest day. */
  const twelve = (s: Subject, overrides: Record<string, unknown> = {}) => schedule(MANAGER, s.projectId, { trigger_kind: 'POST_HANDOVER_12M', source_handover_id: s.handoverId, due_on: '2028-01-15', ...overrides });

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [
      { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      { n: RECEIVING_UNIT, path: `/${unitId(RECEIVING_UNIT)}/` },
    ]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, FOREIGN, ROOT);
    await harness.seedRole(TENANT_B, 601, 'AST_EVALUATION', ['evaluation.trigger.manage', 'project.read'], 60);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: FOREIGN, role: 601, kind: 'TENANT' }]);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'AST_EVALUATION_MANAGER', ['evaluation.trigger.manage', 'project.read'], 40],
      [2, 'AST_PROJECT_READER', ['project.read'], 10],
      [3, 'AST_EVALUATION_BRANCH', ['evaluation.trigger.manage'], 30],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 101, kind: 'TENANT' },
      { n: 2, member: READER, role: 102, kind: 'TENANT' },
      { n: 3, member: NARROW, role: 103, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
      { n: 4, member: NARROW, role: 102, kind: 'TENANT' },
      { n: 5, member: ELSEWHERE, role: 103, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    contractor = await seedContractor(harness);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(ROOT)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ast/evaluation.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN, DOCUMENT],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [EvaluationController, EvaluationReadsController],
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

  it('is registered in the module of AST', () => {
    expect(astModule.controllers).toEqual(expect.arrayContaining([EvaluationController, EvaluationReadsController]));
  });

  it('UAT-AC394: sets the trigger 12 months after the acceptance, refuses a second one, fires it once on its day and has it acknowledged with the evaluation of MNE', async () => {
    const s = await subject();
    const sent = await twelve(s);
    expect(sent).toMatchObject({ status: 200, json: { status: 'SCHEDULED', resource_version: 1 } });
    const triggerId = sent.json.resource_id as string;
    expect(await stored(triggerId)).toMatchObject({ status: 'SCHEDULED', version: '1', fired_at: null });
    expect((await audits(triggerId, 'ast.evaluation_trigger_scheduled'))[0]).toMatchObject({
      actor_id: memberId(MANAGER),
      safe_diff: { project_id: s.projectId, trigger_kind: 'POST_HANDOVER_12M', handover_id: s.handoverId, due_on: '2028-01-15', from_status: null, to_status: 'SCHEDULED' },
    });
    expect((await events(triggerId, 'ast.evaluation_trigger.scheduled.v1'))[0]?.payload).toMatchObject({ trigger_id: triggerId, project_id: s.projectId, due_on: '2028-01-15', status: 'SCHEDULED', version: 1, actor_id: memberId(MANAGER) });
    expect(await twelve(s)).toMatchObject({ status: 409, json: { code: 'TRIGGER_DUPLICATE' } });
    expect(await rows('select id from machvon.evaluation_trigger where source_handover_id = $1::uuid', [s.handoverId])).toHaveLength(1);

    // The day before, nothing happens; on the day the trigger is fired and announced once, and a second pass announces nothing.
    expect(await sweep('2028-01-14T09:00:00+07:00')).toBe(0);
    expect(await stored(triggerId)).toMatchObject({ status: 'SCHEDULED' });
    expect(await events(triggerId, 'ast.evaluation.due.v1')).toHaveLength(0);
    expect(await sweep('2028-01-15T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
    const fired = await stored(triggerId);
    expect(fired).toMatchObject({ status: 'FIRED', version: '2' });
    expect(fired?.fired_at).not.toBeNull();
    expect(fired?.outbox_event_id).not.toBeNull();
    const due = await events(triggerId, 'ast.evaluation.due.v1');
    expect(due).toHaveLength(1);
    expect(due[0]?.payload).toMatchObject({
      trigger_id: triggerId,
      project_id: s.projectId,
      trigger_kind: 'POST_HANDOVER_12M',
      handover_id: s.handoverId,
      due_on: '2028-01-15',
      notification: { recipients: [memberId(MANAGER)], deepLink: `/ast/ast-07?project=${s.projectId}` },
    });
    expect(await sweep('2028-01-15T21:00:00+07:00')).toBe(0);
    expect(await sweep('2028-01-16T09:00:00+07:00')).toBe(0);
    expect(await events(triggerId, 'ast.evaluation.due.v1')).toHaveLength(1);
    expect((await audits(triggerId, 'ast.evaluation_trigger_fired'))).toHaveLength(1);

    const evaluationId = await evaluation(s.projectId);
    const done = await acknowledge(MANAGER, triggerId, { mne_evaluation_id: evaluationId });
    expect(done).toMatchObject({ status: 200, json: { status: 'ACKNOWLEDGED', resource_version: 3 } });
    expect(await stored(triggerId)).toMatchObject({ status: 'ACKNOWLEDGED', version: '3', mne_evaluation_id: evaluationId });
    expect((await audits(triggerId, 'ast.evaluation_trigger_acknowledged'))[0]).toMatchObject({ safe_diff: { from_status: 'FIRED', to_status: 'ACKNOWLEDGED', mne_evaluation_id: evaluationId } });
    expect((await events(triggerId, 'ast.evaluation_trigger.acknowledged.v1'))[0]?.payload).toMatchObject({ trigger_id: triggerId, mne_evaluation_id: evaluationId, status: 'ACKNOWLEDGED', version: 3 });
    expect(await acknowledge(MANAGER, triggerId, { mne_evaluation_id: evaluationId })).toMatchObject({ status: 409, json: { code: 'TRIGGER_STATE_INVALID' } });
  });

  it('names the investing unit of the project in the reminder, so that a grant on that unit sees it too', async () => {
    const s = await subject();
    await world.owner('update machvon.project set investor_unit_id = $2::uuid where id = $1::uuid', [s.projectId, unitId(OTHER_BRANCH)]);
    const triggerId = (await twelve(s, { due_on: '2028-11-01' })).json.resource_id as string;
    expect(await sweep('2028-11-01T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
    const resource = ((await events(triggerId, 'ast.evaluation.due.v1'))[0]?.payload.notification as { resource: Record<string, unknown> }).resource;
    expect(resource).toMatchObject({ type: 'evaluation_trigger', id: triggerId, projectId: s.projectId, investorUnitId: unitId(OTHER_BRANCH), investorUnitPath: `/${unitId(OTHER_BRANCH)}/` });
    expect(resource.ownerUnitId).toEqual(expect.any(String));
    // A project with no investing unit names none.
    const alone = await subject();
    const otherId = (await twelve(alone, { due_on: '2028-11-02' })).json.resource_id as string;
    expect(await sweep('2028-11-02T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
    const bare = ((await events(otherId, 'ast.evaluation.due.v1'))[0]?.payload.notification as { resource: Record<string, unknown> }).resource;
    expect(bare.investorUnitId).toBeUndefined();
    expect(bare.investorUnitPath).toBeUndefined();
  });

  it('answers the same key once', async () => {
    const s = await subject();
    const send = () => schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL', due_on: '2999-01-01' }, 'schedule-once-for-this-key');
    const first = await send();
    expect(first.status).toBe(200);
    expect(await send()).toEqual(first);
    expect(await rows('select id from machvon.evaluation_trigger where project_id = $1::uuid', [s.projectId])).toHaveLength(1);
  });

  it('does not fire a trigger before its day, whatever the hour, and fires a trigger whose day is long gone', async () => {
    const s = await subject();
    const late = await twelve(s, { due_on: '2030-06-30' });
    expect(late.status).toBe(200);
    expect(await sweep('2030-06-29T23:59:00+07:00')).toBe(0);
    // 17:30 UTC on the 29th is already the 30th in Vietnam.
    expect(await sweep('2030-06-29T17:30:00Z')).toBeGreaterThanOrEqual(1);
    expect(await stored(late.json.resource_id as string)).toMatchObject({ status: 'FIRED' });
  });

  describe('the day it falls due', () => {
    it('is not before 12 months after the acceptance of the handover (the day in Vietnam), nor before 24 months for the second kind', async () => {
      // 17:30 UTC on the 14th of January 2027 is the 15th in Vietnam.
      const s = await subject({ acceptedAt: '2027-01-14T17:30:00Z' });
      expect(await twelve(s, { due_on: '2028-01-14' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'due_on', reason: 'BEFORE_EARLIEST', earliest_due_on: '2028-01-15' } });
      expect(await twelve(s, { trigger_kind: 'POST_HANDOVER_24M', due_on: '2028-01-15' })).toMatchObject({ status: 422, json: { reason: 'BEFORE_EARLIEST', earliest_due_on: '2029-01-15' } });
      expect(await rows('select id from machvon.evaluation_trigger where source_handover_id = $1::uuid', [s.handoverId])).toEqual([]);
      expect((await twelve(s, { trigger_kind: 'POST_HANDOVER_24M', due_on: '2029-03-01' })).status).toBe(200);
      expect((await twelve(s, { due_on: '2028-02-01' })).status).toBe(200);
    });

    it('is the last day of the month when the month is shorter', async () => {
      const s = await subject({ acceptedAt: '2028-02-29T03:00:00Z' });
      expect(await twelve(s, { due_on: '2029-02-27' })).toMatchObject({ status: 422, json: { reason: 'BEFORE_EARLIEST', earliest_due_on: '2029-02-28' } });
      expect((await twelve(s, { due_on: '2029-02-28' })).status).toBe(200);
    });

    it('is not a day that has gone for a trigger by hand or for the closed settlement', async () => {
      const s = await subject();
      expect(await schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL', due_on: '2020-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'due_on', reason: 'IN_THE_PAST' } });
      expect(await schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL', due_on: '2026-02-30' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'due_on' } });
      expect(await schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL', due_on: '2999-01-01' })).toMatchObject({ status: 200 });
    });
  });

  describe('the handover it follows', () => {
    it('is named for a trigger after a handover, accepted, and one of the project', async () => {
      const s = await subject();
      expect(await schedule(MANAGER, s.projectId, { trigger_kind: 'POST_HANDOVER_12M', due_on: '2028-01-15' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'source_handover_id' } });
      const pending = await subject({ handover: 'PUNCH_PENDING' });
      expect(await twelve(pending)).toMatchObject({ status: 422, json: { code: 'HANDOVER_NOT_ACCEPTED' } });
      expect(await twelve(s, { source_handover_id: pending.handoverId })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'source_handover_id', reason: 'NOT_A_HANDOVER_OF_THE_PROJECT' } });
      expect(await twelve(s, { source_handover_id: randomUUID() })).toMatchObject({ status: 422, json: { reason: 'NOT_A_HANDOVER_OF_THE_PROJECT' } });
      expect(await twelve(s, { source_handover_id: 'not-an-id' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    });

    it('may be named by a trigger by hand, which then stands once for the handover as well as once for the project', async () => {
      const s = await subject();
      const other = { trigger_kind: 'MANUAL', due_on: '2999-01-01' };
      expect((await schedule(MANAGER, s.projectId, { ...other, source_handover_id: s.handoverId })).status).toBe(200);
      expect(await schedule(MANAGER, s.projectId, { ...other, source_handover_id: s.handoverId })).toMatchObject({ status: 409, json: { code: 'TRIGGER_DUPLICATE' } });
      expect((await schedule(MANAGER, s.projectId, other)).status).toBe(200);
      expect(await schedule(MANAGER, s.projectId, other)).toMatchObject({ status: 409, json: { code: 'TRIGGER_DUPLICATE' } });
    });
  });

  describe('the stage of the project', () => {
    it('admits a trigger once the work is under way, and not for a project that is not yet implemented, was rejected or was cancelled', async () => {
      for (const status of ['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'REJECTED', 'CANCELLED']) {
        const s = await subject({ projectStatus: status });
        expect(await schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL', due_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'PROJECT_STAGE_INVALID' } });
      }
      for (const status of ['IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED']) {
        const s = await subject({ projectStatus: status });
        expect((await schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL', due_on: '2999-01-01' })).status).toBe(200);
      }
    });

    it('waits for the settlement of the project before the trigger of the closed settlement', async () => {
      const running = await subject({ projectStatus: 'COMPLETED' });
      expect(await schedule(MANAGER, running.projectId, { trigger_kind: 'SETTLEMENT_CLOSED', due_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'PROJECT_STAGE_INVALID' } });
      const settled = await subject({ projectStatus: 'SETTLED' });
      expect((await schedule(MANAGER, settled.projectId, { trigger_kind: 'SETTLEMENT_CLOSED', due_on: '2999-01-01' })).status).toBe(200);
    });

    it('refuses a kind that is not one and what is not in the body', async () => {
      const s = await subject();
      expect(await schedule(MANAGER, s.projectId, { trigger_kind: 'WHENEVER', due_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'trigger_kind' } });
      expect(await schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL', due_on: '2999-01-01', status: 'FIRED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect((await schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL' })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('acknowledgeEvaluationTrigger', () => {
    it('is for a trigger that was fired: a trigger still scheduled is 409 and stays so', async () => {
      const s = await subject();
      const sent = await schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL', due_on: '2999-01-01' });
      const triggerId = sent.json.resource_id as string;
      expect(await acknowledge(MANAGER, triggerId, { mne_evaluation_id: await evaluation(s.projectId) })).toMatchObject({ status: 409, json: { code: 'TRIGGER_STATE_INVALID' } });
      expect(await stored(triggerId)).toMatchObject({ status: 'SCHEDULED', version: '1', mne_evaluation_id: null });
    });

    it('names an evaluation of MNE that exists in the tenant and belongs to the project of the trigger', async () => {
      const s = await subject();
      const sent = await twelve(s, { due_on: '2028-03-01' });
      const triggerId = sent.json.resource_id as string;
      expect(await sweep('2028-03-01T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
      expect(await acknowledge(MANAGER, triggerId, { mne_evaluation_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'mne_evaluation_id', reason: 'NOT_FOUND' } });
      const otherProject = await subject();
      expect(await acknowledge(MANAGER, triggerId, { mne_evaluation_id: await evaluation(otherProject.projectId) })).toMatchObject({
        status: 422,
        json: { code: 'VALIDATION_FAILED', detail: 'mne_evaluation_id', reason: 'NOT_AN_EVALUATION_OF_THE_PROJECT' },
      });
      expect(await acknowledge(MANAGER, triggerId, { mne_evaluation_id: 'not-an-id' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await stored(triggerId)).toMatchObject({ status: 'FIRED', mne_evaluation_id: null });
      expect((await acknowledge(MANAGER, triggerId, { mne_evaluation_id: await evaluation(s.projectId) })).status).toBe(200);
    });

    it('lets one acknowledgement through when two come at once: the trigger is locked', async () => {
      const s = await subject();
      const triggerId = (await twelve(s, { due_on: '2028-04-01' })).json.resource_id as string;
      expect(await sweep('2028-04-01T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
      const evaluations = [await evaluation(s.projectId), await evaluation(s.projectId)];
      const replies = await Promise.all(evaluations.map((evaluationId) => acknowledge(MANAGER, triggerId, { mne_evaluation_id: evaluationId })));
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect((await events(triggerId, 'ast.evaluation_trigger.acknowledged.v1')).length).toBe(1);
    });
  });

  describe('who may', () => {
    it('is for the people who hold the right to manage the triggers, over the project: a project that is seen and not managed is 403, one that is not seen is 404', async () => {
      const s = await subject();
      const body = { trigger_kind: 'MANUAL', due_on: '2999-01-01' };
      expect((await schedule(NOBODY, s.projectId, body)).status).toBe(403);
      expect((await schedule(READER, s.projectId, body)).status).toBe(403);
      expect(await schedule(NARROW, s.projectId, body)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await schedule(ELSEWHERE, s.projectId, body)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await schedule(MANAGER, randomUUID(), body)).toMatchObject({ status: 404 });
      expect(await rows('select id from machvon.evaluation_trigger where project_id = $1::uuid', [s.projectId])).toEqual([]);
      expect((await schedule(MANAGER, s.projectId, body)).status).toBe(200);
    });

    it('acknowledges a trigger of a project in the scope only', async () => {
      const s = await subject();
      const triggerId = (await twelve(s, { due_on: '2028-05-01' })).json.resource_id as string;
      expect(await sweep('2028-05-01T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
      const evaluationId = await evaluation(s.projectId);
      expect((await acknowledge(NOBODY, triggerId, { mne_evaluation_id: evaluationId })).status).toBe(403);
      expect(await acknowledge(NARROW, triggerId, { mne_evaluation_id: evaluationId })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await acknowledge(ELSEWHERE, triggerId, { mne_evaluation_id: evaluationId })).toMatchObject({ status: 404 });
      expect(await acknowledge(MANAGER, randomUUID(), { mne_evaluation_id: evaluationId })).toMatchObject({ status: 404 });
      expect(await stored(triggerId)).toMatchObject({ status: 'FIRED' });
    });

    it('does not reach the project or the trigger of another tenant', async () => {
      const s = await subject();
      const triggerId = (await twelve(s, { due_on: '2028-06-01' })).json.resource_id as string;
      expect((await call('POST', `/projects/${s.projectId}/evaluation-triggers`, { member: FOREIGN, tenant: TENANT_B, body: { trigger_kind: 'MANUAL', due_on: '2999-01-01' } })).status).toBe(404);
      expect((await call('POST', `/evaluation-triggers/${triggerId}/acknowledge`, { member: FOREIGN, tenant: TENANT_B, body: { mne_evaluation_id: randomUUID() } })).status).toBe(404);
      expect((await call('GET', '/evaluation-triggers', { member: FOREIGN, tenant: TENANT_B })).json.items).toEqual([]);
    });
  });

  describe('listEvaluationTriggers (AST-07)', () => {
    it('lists the triggers of a project newest first with the handover, the day and the evaluation, a page at a time, and filters them by status', async () => {
      const s = await subject();
      const first = (await twelve(s, { due_on: '2028-07-01' })).json.resource_id as string;
      const second = (await twelve(s, { trigger_kind: 'POST_HANDOVER_24M', due_on: '2029-07-01' })).json.resource_id as string;
      const third = (await schedule(MANAGER, s.projectId, { trigger_kind: 'MANUAL', due_on: '2999-01-01' })).json.resource_id as string;
      const all = await call('GET', `/evaluation-triggers?project_id=${s.projectId}`, { member: MANAGER });
      expect(all.status).toBe(200);
      const items = all.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([third, second, first]);
      expect(items[2]).toMatchObject({
        trigger_kind: 'POST_HANDOVER_12M',
        due_on: '2028-07-01',
        status: 'SCHEDULED',
        fired_at: null,
        evaluation: null,
        project: { id: s.projectId },
        handover: { id: s.handoverId, accepted_on: '2027-01-15' },
        version: 1,
      });
      expect(items[0]?.handover).toBeNull();
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(['created_at', 'due_on', 'evaluation', 'fired_at', 'handover', 'id', 'project', 'status', 'trigger_kind', 'version']);

      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page += 1) {
        const reply = await call('GET', `/evaluation-triggers?project_id=${s.projectId}&limit=2${cursor}`, { member: MANAGER });
        seen.push(...(reply.json.items as Array<{ id: string }>).map((item) => item.id));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${encodeURIComponent(reply.json.next_cursor as string)}`;
      }
      expect(seen).toEqual([third, second, first]);

      expect(await sweep('2028-07-01T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
      const firedOnly = await call('GET', `/evaluation-triggers?project_id=${s.projectId}&status=FIRED`, { member: MANAGER });
      expect((firedOnly.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([first]);
      const evaluationId = await evaluation(s.projectId);
      expect((await acknowledge(MANAGER, first, { mne_evaluation_id: evaluationId })).status).toBe(200);
      const done = await call('GET', `/evaluation-triggers?project_id=${s.projectId}&status=ACKNOWLEDGED`, { member: MANAGER });
      expect((done.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: first, status: 'ACKNOWLEDGED', evaluation: { id: evaluationId, evaluation_kind: 'FINAL', status: 'PLANNED' }, version: 3 });
    });

    it('shows nothing of a project outside the scope, is for the holders of the right and refuses what is badly formed', async () => {
      const s = await subject();
      await twelve(s, { due_on: '2028-08-01' });
      expect((await call('GET', `/evaluation-triggers?project_id=${s.projectId}`, { member: ELSEWHERE })).json.items).toEqual([]);
      expect((await call('GET', `/evaluation-triggers?project_id=${s.projectId}`, { member: READER })).status).toBe(403);
      expect((await call('GET', `/evaluation-triggers?project_id=${s.projectId}`, { member: NOBODY })).status).toBe(403);
      for (const query of ['project_id=nope', 'status=NOPE', 'limit=0', 'limit=500', 'cursor=nope']) {
        expect((await call('GET', `/evaluation-triggers?${query}`, { member: MANAGER })).status).toBeGreaterThanOrEqual(400);
      }
      expect((await call('GET', '/evaluation-triggers', { member: MANAGER })).status).toBe(200);
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

    it('does not let what a trigger says change, its status go back or be skipped, nor the time it was fired or the evaluation it led to', async () => {
      const s = await subject();
      const triggerId = (await twelve(s, { due_on: '2028-09-01' })).json.resource_id as string;
      expect(await edit("update machvon.evaluation_trigger set due_on = date '2030-01-01' where id = $1::uuid", [triggerId])).toMatch(/never changes/);
      expect(await edit("update machvon.evaluation_trigger set trigger_kind = 'MANUAL' where id = $1::uuid", [triggerId])).toMatch(/never changes/);
      expect(await edit("update machvon.evaluation_trigger set status = 'ACKNOWLEDGED', fired_at = now() where id = $1::uuid", [triggerId])).toMatch(/not allowed|violates check/);
      expect(await sweep('2028-09-01T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
      expect(await edit("update machvon.evaluation_trigger set status = 'SCHEDULED' where id = $1::uuid", [triggerId])).toMatch(/not allowed/);
      expect(await edit("update machvon.evaluation_trigger set fired_at = now() - interval '1 day' where id = $1::uuid", [triggerId])).toMatch(/keeps the time/);
      expect(await edit('update machvon.evaluation_trigger set outbox_event_id = gen_random_uuid() where id = $1::uuid', [triggerId])).toMatch(/keeps the time/);
      expect(await edit("update machvon.evaluation_trigger set status = 'ACKNOWLEDGED' where id = $1::uuid", [triggerId])).toMatch(/violates check/);
      expect(await stored(triggerId)).toMatchObject({ status: 'FIRED', version: '2' });
    });

    it('names the handover for a trigger after a handover, and is never deleted by the application', async () => {
      const s = await subject();
      expect(
        await edit(
          `insert into machvon.evaluation_trigger (tenant_id, id, project_id, trigger_kind, due_on, status, created_by, updated_by) values ($1, gen_random_uuid(), $2, 'POST_HANDOVER_24M', date '2030-01-01', 'SCHEDULED', $3, $3)`,
          [TENANT_A, s.projectId, memberId(ROOT)],
        ),
      ).toMatch(/evaluation_trigger_handover_chk/);
      const triggerId = (await twelve(s, { due_on: '2028-10-01' })).json.resource_id as string;
      const app = new Client({ connectionString: harness.database.urlFor('machvon_app') });
      await app.connect();
      try {
        await app.query('begin');
        await app.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        await expect(app.query('delete from machvon.evaluation_trigger where id = $1::uuid', [triggerId])).rejects.toThrow(/permission denied/);
      } finally {
        await app.end();
      }
      expect(await stored(triggerId)).toMatchObject({ status: 'SCHEDULED' });
    });
  });
});
