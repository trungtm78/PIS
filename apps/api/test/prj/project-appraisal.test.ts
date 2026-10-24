import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { BASELINE_PACK, applyBaseline } from '../../../../packages/db/src/master-baseline';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { prjModule } from '../../src/modules/prj';
import { ProjectAppraisalController } from '../../src/modules/prj/appraisal.controller';
import { InMemoryPipelineCache } from '../../src/modules/prj/pipeline-cache';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { ProjectLifecycleReadsController, ProjectStageController } from '../../src/modules/prj/stage.controller';
import { PRJ_METRICS, PRJ_PIPELINE_CACHE } from '../../src/modules/prj/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const TODAY = vietnamDateOf(new Date());
const PROPOSER = 1; // creates projects and sends them to appraisal
const APPRAISER = 2;
const SECOND_APPRAISER = 3;
const DECIDER = 4;
const READER = 5; // project.read only
const DEPARTMENT_DECIDER = 6; // decides on the department only
const EVERYTHING = 7; // creates, appraises and decides: the proposer who must still not do all three
const AUTHORITY_DECIDER = 8; // decides over the unit that the project names as its deciding authority
const OUTSIDE_AUTHORITY = 9; // decides over the whole tenant but not over the authority unit
const B_PROPOSER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const AUTHORITY_UNIT = 3;
const WORKER = WORKER_MEMBERSHIP_ID;
const WEIGHTS = [30, 25, 20, 15, 10];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the appraisal and the admission to the project bank (ST-PRJ-003)', () => {
  const harness = new AuthzHarness();
  const increments: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  const metrics: MetricsSink = { increment: (name, labels) => void increments.push({ name, labels }), gauge: () => undefined };
  const cache = new InMemoryPipelineCache();
  let app: RunningApp;
  let counter = 0;
  const versions: Record<string, string> = {};
  let criteria: { versionId: string; codes: string[] };

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
  const projectRow = async (projectId: string): Promise<Record<string, unknown>> => (await rows<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [projectId]))[0] as Record<string, unknown>;
  const sheetRows = (projectId: string) => rows<Record<string, unknown>>('select * from machvon.project_appraisal where project_id = $1::uuid order by round, created_at, id', [projectId]);
  const events = (type: string, projectId: string) =>
    rows<{ payload: Record<string, unknown>; aggregate_id: string }>(`select payload, aggregate_id from machvon.outbox_event where type = $1 and payload->>'project_id' = $2 order by created_at, aggregate_version`, [type, projectId]);
  const audits = (action: string, resourceId: string) =>
    rows<{ reason: string | null; safe_diff: Record<string, unknown>; outcome: string; actor_id: string }>(`select reason, safe_diff, outcome, actor_id from machvon.audit_event where resource_id = $1 and action = $2`, [resourceId, action]);

  async function seedVersion(tenant: string, masterType: string, key: string, attributes: Record<string, unknown> = {}): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(tenant, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [tenant, recordId, masterType, key, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, valid_until, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $4, $5::jsonb, '2020-01-01', null, 'EFFECTIVE', $6, now(), $7, $7)`,
        [tenant, versionId, masterType, key, JSON.stringify(attributes), recordId, memberId(1)],
      ],
    ]);
    return versionId;
  }

  async function document(status = 'EFFECTIVE', tenant = TENANT_A): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
      [tenant, id, `QD-${id.slice(0, 8)}/2026`, status, memberId(1)],
      tenant,
    );
    return id;
  }

  /** A project made through the register by `creator`. */
  async function project(options: { creator?: number; authorityUnit?: number; tenant?: string } = {}): Promise<{ id: string; version: number }> {
    counter += 1;
    const tenant = options.tenant ?? TENANT_A;
    const made = await call('POST', '/projects', {
      member: options.creator ?? PROPOSER,
      tenantId: tenant,
      body: {
        code: `AP-${counter}-${randomUUID().slice(0, 6)}`,
        name: 'Dự án cầu Thủ Thiêm 4',
        owner_unit_id: unitId(DEPARTMENT),
        ...(options.authorityUnit === undefined ? {} : { decision_authority_unit_id: unitId(options.authorityUnit) }),
        area_master_version_id: tenant === TENANT_A ? versions.area : versions.areaB,
        total_investment_vnd: '500000000000',
      },
    });
    expect(made.status).toBe(200);
    return { id: made.json.resource_id as string, version: 1 };
  }

  const submit = async (target: { id: string; version: number }, member = PROPOSER, body: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/projects/${target.id}/appraisal-submissions`, { member, ifMatch: `"${target.version}"`, body: { reason: 'Sent to appraisal with its proposal', policy_proposal_document_id: await document(), ...body } });

  const scoresOf = (values: number[]) => criteria.codes.map((criterion_code, index) => ({ criterion_code, score: values[index] }));
  const appraise = (target: { id: string }, values: number[], member = APPRAISER, body: Record<string, unknown> = {}, ifMatch?: string): Promise<Reply> =>
    call('POST', `/projects/${target.id}/appraisals`, { member, ...(ifMatch === undefined ? {} : { ifMatch }), body: { criteria_set_version_id: criteria.versionId, scores: scoresOf(values), recommendation: 'ADMIT', ...body } });
  const decide = (sheet: { id: string; version: number }, member = DECIDER, body: Record<string, unknown> = {}, version?: number): Promise<Reply> =>
    call('POST', `/project-appraisals/${sheet.id}/decision`, { member, ifMatch: `"${version ?? sheet.version}"`, body: { decision: 'ADMIT', reason: 'Decided after the appraisal', ...body } });

  /** A project in APPRAISAL with the sheets of the appraisers, through the commands. */
  async function appraised(values: number[][], options: { creator?: number; authorityUnit?: number } = {}) {
    const target = await project(options);
    const sent = await submit(target, options.creator ?? PROPOSER);
    expect(sent.status).toBe(200);
    const sheets: Array<{ id: string; version: number }> = [];
    for (const [index, scores] of values.entries()) {
      const reply = await appraise(target, scores, [APPRAISER, SECOND_APPRAISER][index]);
      expect(reply.status).toBe(200);
      sheets.push({ id: reply.json.resource_id as string, version: reply.json.resource_version as number });
    }
    return { target: { id: target.id, version: sent.json.resource_version as number }, sheets };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: AUTHORITY_UNIT, path: `/${unitId(ROOT)}/${unitId(AUTHORITY_UNIT)}/`, parent: ROOT },
      ]);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    for (const n of [PROPOSER, APPRAISER, SECOND_APPRAISER, DECIDER, READER, DEPARTMENT_DECIDER, EVERYTHING, AUTHORITY_DECIDER, OUTSIDE_AUTHORITY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PROPOSER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PROPOSER', ['project.create', 'project.read', 'project.stage.submit'], 30);
    await harness.seedRole(TENANT_A, 2, 'APPRAISER', ['project.read', 'project.appraise'], 30);
    await harness.seedRole(TENANT_A, 3, 'DECIDER', ['project.read', 'project.appraisal.decide'], 40);
    await harness.seedRole(TENANT_A, 4, 'READER', ['project.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'ALL', ['project.create', 'project.read', 'project.stage.submit', 'project.appraise', 'project.appraisal.decide'], 40);
    await harness.seedRole(TENANT_B, 1, 'PROPOSER', ['project.create', 'project.read', 'project.stage.submit', 'project.appraise', 'project.appraisal.decide'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PROPOSER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPRAISER, role: 2, kind: 'TENANT' },
      { n: 3, member: SECOND_APPRAISER, role: 2, kind: 'TENANT' },
      { n: 4, member: DECIDER, role: 3, kind: 'TENANT' },
      { n: 5, member: READER, role: 4, kind: 'TENANT' },
      { n: 6, member: DEPARTMENT_DECIDER, role: 4, kind: 'TENANT' },
      { n: 7, member: DEPARTMENT_DECIDER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 8, member: EVERYTHING, role: 5, kind: 'TENANT' },
      { n: 9, member: AUTHORITY_DECIDER, role: 4, kind: 'TENANT' },
      { n: 10, member: AUTHORITY_DECIDER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(AUTHORITY_UNIT)] },
      { n: 11, member: AUTHORITY_DECIDER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 12, member: OUTSIDE_AUTHORITY, role: 4, kind: 'TENANT' },
      { n: 13, member: OUTSIDE_AUTHORITY, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PROPOSER, role: 1, kind: 'TENANT' }]);
    versions.area = await seedVersion(TENANT_A, 'AREA', 'TINH-P');
    versions.areaB = await seedVersion(TENANT_B, 'AREA', 'TINH-P');
    const codes = WEIGHTS.map((_, index) => `C${index + 1}`);
    criteria = {
      versionId: await seedVersion(TENANT_A, 'APPRAISAL_CRITERIA', 'TEST-API-CRIT', { owner_module: 'PRJ', criteria: WEIGHTS.map((weight, index) => ({ code: codes[index], name: `Criterion ${index + 1}`, max_score: weight })), pass_threshold: 60 }),
      codes,
    };
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController, ProjectAppraisalController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: PRJ_METRICS, useValue: metrics },
        { provide: PRJ_PIPELINE_CACHE, useValue: cache },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of PRJ', () => {
    expect(prjModule.controllers).toContain(ProjectAppraisalController);
  });

  describe('the score of a sheet', () => {
    it('AC-ST-PRJ-003-1: scores 4,3,5,2,4 against weights 30/25/20/15/10 are 73.00, stored, audited and announced', async () => {
      const target = await project();
      expect((await submit(target)).status).toBe(200);
      const reply = await appraise(target, [4, 3, 5, 2, 4], APPRAISER, { note: 'A sound proposal' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'SUBMITTED', resource_version: 1, total_score: '73.00', round: 1, project_id: target.id });
      const [sheet] = await sheetRows(target.id);
      expect(sheet).toMatchObject({ id: reply.json.resource_id, total_score: '73.00', status: 'SUBMITTED', appraiser_membership_id: memberId(APPRAISER), note: 'A sound proposal' });
      const audit = await audits('project.appraisal_recorded', sheet?.id as string);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', safe_diff: { project_id: target.id, round: 1, total_score: '73.00', recommendation: 'ADMIT', replaced: false, has_note: true, mean_score: '73.00' } });
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('A sound proposal');
      const announced = await events('project.appraisal_recorded.v1', target.id);
      expect(announced).toHaveLength(1);
      expect(announced[0]?.payload).toEqual(expect.objectContaining({ tenant_id: TENANT_A, project_id: target.id, version: 2, actor_id: memberId(APPRAISER), appraisal_id: sheet?.id, round: 1, total_score: '73.00', recommendation: 'ADMIT' }));
      expect(JSON.stringify(announced[0]?.payload)).not.toContain('A sound proposal');
    });

    it('AC-ST-PRJ-003-1: a set whose weights do not add up to 100 is 422 CRITERIA_WEIGHT_INVALID and nothing is stored', async () => {
      const broken = await seedVersion(TENANT_A, 'APPRAISAL_CRITERIA', `TEST-BAD-${randomUUID().slice(0, 6)}`, { criteria: [{ code: 'C1', name: 'One', max_score: 60 }, { code: 'C2', name: 'Two', max_score: 39 }], pass_threshold: 60 });
      const target = await project();
      await submit(target);
      const reply = await appraise(target, [], APPRAISER, { criteria_set_version_id: broken, scores: [{ criterion_code: 'C1', score: 4 }, { criterion_code: 'C2', score: 3 }] });
      expect([reply.status, reply.json.code]).toEqual([422, 'CRITERIA_WEIGHT_INVALID']);
      expect(await sheetRows(target.id)).toEqual([]);
    });

    it('AC-ST-PRJ-003-1: a score outside 0..5 is refused before anything is stored', async () => {
      const target = await project();
      await submit(target);
      for (const bad of [6, -1, 2.5]) {
        const reply = await appraise(target, [4, 3, bad, 2, 4]);
        expect([400, 422]).toContain(reply.status);
        expect(['SCORE_OUT_OF_RANGE', 'INVALID_REQUEST', 'VALIDATION_FAILED']).toContain(reply.json.code);
      }
      expect(await sheetRows(target.id)).toEqual([]);
    });

    it('AC-ST-PRJ-003-1: the same appraiser scoring again replaces their sheet; a stale If-Match is 409', async () => {
      const target = await project();
      await submit(target);
      const first = await appraise(target, [4, 3, 5, 2, 4]);
      const stale = await appraise(target, [5, 5, 5, 5, 5], APPRAISER, {}, '"9"');
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const again = await appraise(target, [5, 5, 5, 5, 5], APPRAISER, {}, `"${first.json.resource_version}"`);
      expect(again.json).toMatchObject({ resource_id: first.json.resource_id, resource_version: 2, total_score: '100.00' });
      expect(await sheetRows(target.id)).toHaveLength(1);
      const audit = await audits('project.appraisal_recorded', first.json.resource_id as string);
      expect(audit.map((entry) => [entry.safe_diff.total_score, entry.safe_diff.previous_total_score, entry.safe_diff.replaced])).toEqual(expect.arrayContaining([['100.00', '73.00', true]]));
    });

    it('a sheet keeps the set of criteria it was scored against: scoring again against another set is 422 on that field, never a database error', async () => {
      const other = await seedVersion(TENANT_A, 'APPRAISAL_CRITERIA', `TEST-API-CRIT-${randomUUID().slice(0, 6)}`, {
        owner_module: 'PRJ',
        criteria: WEIGHTS.map((weight, index) => ({ code: criteria.codes[index], name: `Criterion ${index + 1}`, max_score: weight })),
        pass_threshold: 55,
      });
      const target = await project();
      await submit(target);
      const first = await appraise(target, [4, 3, 5, 2, 4]);
      expect(first.status).toBe(200);
      const switched = await appraise(target, [5, 5, 5, 5, 5], APPRAISER, { criteria_set_version_id: other });
      expect([switched.status, switched.json.code, switched.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'criteria_set_version_id']);
      expect(await sheetRows(target.id)).toMatchObject([{ total_score: '73.00', version: '1' }]);
    });

    it('blind scoring: the answer to an appraiser carries their own total and nothing computed over the other sheets of the round', async () => {
      const { target } = await appraised([[4, 3, 5, 2, 4]]);
      // With two sheets, a mean and a count would give the second appraiser the first one's total to the cent (2 x mean - own).
      const second = await appraise(target, [1, 1, 1, 1, 1], SECOND_APPRAISER);
      expect(second.status).toBe(200);
      expect(second.json).toMatchObject({ total_score: '20.00', round: 1 });
      for (const aggregate of ['mean_score', 'sheet_count', 'pass_threshold', 'threshold_recommendation']) expect(second.json).not.toHaveProperty(aggregate);
      expect(JSON.stringify(second.json)).not.toContain('73.00');
    });

    it('AC-ST-PRJ-003-1: a command repeated with its key answers the first answer and writes nothing twice', async () => {
      const target = await project();
      await submit(target);
      const key = `key-${randomUUID()}`;
      const send = () => call('POST', `/projects/${target.id}/appraisals`, { member: APPRAISER, key, body: { criteria_set_version_id: criteria.versionId, scores: scoresOf([4, 3, 5, 2, 4]), recommendation: 'ADMIT' } });
      const first = await send();
      const second = await send();
      expect(second.json).toEqual(first.json);
      expect(await sheetRows(target.id)).toHaveLength(1);
      expect(await events('project.appraisal_recorded.v1', target.id)).toHaveLength(1);
    });
  });

  describe('sending to appraisal and deciding', () => {
    it('AC-ST-PRJ-003-2: P-A-010 is sent, scored 72.50 by two sheets and ADMITted with a document: PIPELINE, group B, two stage_changed events', async () => {
      const target = await project();
      const proposal = await document();
      const sent = await submit(target, PROPOSER, { policy_proposal_document_id: proposal });
      expect(sent.json).toMatchObject({ status: 'APPRAISAL', resource_version: 2, resource_id: target.id });
      const first = await appraise(target, [4, 3, 5, 2, 4]);
      const second = await appraise(target, [4, 3, 4, 3, 4], SECOND_APPRAISER);
      expect(second.json).toMatchObject({ total_score: '72.00' });
      const decision = await document();
      const decided = await decide({ id: first.json.resource_id as string, version: 1 }, DECIDER, { decision_document_id: decision, project_group: 'B' });
      expect(decided.status).toBe(200);
      expect(decided.json).toMatchObject({ status: 'DECIDED', resource_version: 2, resource_id: first.json.resource_id, project_status: 'PIPELINE', project_version: 3, mean_score: '72.50' });
      expect(await projectRow(target.id)).toMatchObject({ status: 'PIPELINE', project_group: 'B', appraisal_score: '72.50', policy_decision_document_id: decision, version: '3' });
      const moves = await events('project.stage_changed.v1', target.id);
      expect(moves.map((move) => [move.payload.from, move.payload.to, move.payload.decision_document_id])).toEqual([
        ['CONCEPT', 'APPRAISAL', proposal],
        ['APPRAISAL', 'PIPELINE', decision],
      ]);
      const audit = await audits('project.appraisal_decided', first.json.resource_id as string);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', reason: 'Decided after the appraisal', safe_diff: { decision: 'ADMIT', mean_score: '72.50', sheet_count: 2, against_recommendation: false, project_group: 'B', decision_document_id: decision } });
      expect(increments).toContainEqual({ name: 'prj_stage_transition_total', labels: { to: 'PIPELINE' } });
      expect(increments).toContainEqual({ name: 'prj_stage_transition_total', labels: { to: 'APPRAISAL' } });
      expect((await sheetRows(target.id)).map((sheet) => [sheet.status, sheet.decision, sheet.decided_by])).toEqual([
        ['DECIDED', 'ADMIT', memberId(DECIDER)],
        ['DECIDED', 'ADMIT', memberId(DECIDER)],
      ]);
    });

    it('a project that was placed in APPRAISAL without being sent (the old shape) opens round 2 after a return and a new submission, not round 1 again over decided sheets', async () => {
      const target = await project();
      await rows("update machvon.project set status = 'APPRAISAL', version = 2 where id = $1::uuid", [target.id]);
      const first = await appraise(target, [4, 3, 5, 2, 4]);
      expect(first.json).toMatchObject({ round: 1 });
      const returned = await decide({ id: first.json.resource_id as string, version: 1 }, DECIDER, { decision: 'RETURN', reason: 'Back to the proposer', override_reason: 'The proposal lacks the investment policy decision' });
      expect(returned.status).toBe(200);
      const sent = await submit({ id: target.id, version: returned.json.project_version as number });
      expect(sent.status).toBe(200);
      const second = await appraise(target, [2, 2, 2, 2, 2]);
      expect([second.status, second.json.round, second.json.resource_version]).toEqual([200, 2, 1]);
      expect((await sheetRows(target.id)).map((sheet) => [sheet.round, sheet.status])).toEqual([
        [1, 'DECIDED'],
        [2, 'SUBMITTED'],
      ]);
    });

    it('AC-ST-PRJ-003-2: a project that is not in CONCEPT cannot be sent, and a missing proposal is 422 DECISION_REQUIRED', async () => {
      const target = await project();
      const missing = await call('POST', `/projects/${target.id}/appraisal-submissions`, { member: PROPOSER, ifMatch: '"1"', body: { reason: 'Sent without its proposal' } });
      expect([missing.status, missing.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      expect((await submit(target)).status).toBe(200);
      const again = await submit({ id: target.id, version: 2 });
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      const stale = await submit({ id: (await project()).id, version: 8 });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    });

    it('AC-ST-PRJ-003-4: ADMIT without a group is 422 PROJECT_GROUP_REQUIRED, with a group that does not exist 422, with the right group 200', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      const decision = await document();
      const without = await decide(sheet, DECIDER, { decision_document_id: decision });
      expect([without.status, without.json.code]).toEqual([422, 'PROJECT_GROUP_REQUIRED']);
      const wrong = await decide(sheet, DECIDER, { decision_document_id: decision, project_group: 'Z' });
      expect(wrong.status).toBe(422);
      expect((await projectRow(target.id)).status).toBe('APPRAISAL');
      const right = await decide(sheet, DECIDER, { decision_document_id: decision, project_group: 'A' });
      expect(right.status).toBe(200);
      expect(await projectRow(target.id)).toMatchObject({ status: 'PIPELINE', project_group: 'A' });
    });

    it('AC-ST-PRJ-003-4: REJECT ends the project, RETURN sends it back, and each leaves the group alone', async () => {
      const rejected = await appraised([[0, 0, 0, 0, 0]]);
      const rejectedSheet = rejected.sheets[0] as { id: string; version: number };
      const noReason = await decide(rejectedSheet, DECIDER, { decision: 'REJECT' });
      expect([noReason.status, noReason.json.code]).toEqual([422, 'OVERRIDE_REASON_REQUIRED']);
      const reply = await decide(rejectedSheet, DECIDER, { decision: 'REJECT', override_reason: 'The sheets say admit but the budget is gone for good' });
      expect(reply.json).toMatchObject({ project_status: 'REJECTED' });
      expect(await projectRow(rejected.target.id)).toMatchObject({ status: 'REJECTED', project_group: null });
      const returned = await appraised([[4, 3, 5, 2, 4]]);
      const returnedSheet = returned.sheets[0] as { id: string; version: number };
      const back = await decide(returnedSheet, DECIDER, { decision: 'RETURN', reason: 'Add the land clearance plan', override_reason: 'The sheet recommends admission but the plan is missing' });
      expect(back.json).toMatchObject({ project_status: 'CONCEPT' });
    });
  });

  describe('four eyes', () => {
    it('AC-ST-PRJ-003-3: the proposer who also holds the appraisal permissions can score nothing and decide nothing: 403 SELF_APPROVAL_DENIED', async () => {
      const target = await project({ creator: EVERYTHING });
      expect((await submit(target, EVERYTHING)).status).toBe(200);
      const scored = await appraise(target, [4, 3, 5, 2, 4], EVERYTHING);
      expect([scored.status, scored.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await sheetRows(target.id)).toEqual([]);
      const other = await appraise(target, [4, 3, 5, 2, 4]);
      expect(other.status).toBe(200);
      const contrary = await decide({ id: other.json.resource_id as string, version: 1 }, EVERYTHING, { decision: 'REJECT' });
      expect([contrary.status, contrary.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const following = await decide({ id: other.json.resource_id as string, version: 1 }, EVERYTHING, { decision: 'ADMIT', decision_document_id: await document(), project_group: 'B' });
      expect([following.status, following.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await projectRow(target.id)).status).toBe('APPRAISAL');
    });

    it('AC-ST-PRJ-003-3: whoever sent the project to appraisal does not score it, though they did not create it', async () => {
      const target = await project();
      const sent = await submit(target, EVERYTHING);
      expect(sent.status).toBe(200);
      const reply = await appraise(target, [4, 3, 5, 2, 4], EVERYTHING);
      expect([reply.status, reply.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    });

    it('AC-ST-PRJ-003-3: a decision against the sheets needs an override reason of 20 characters; the reason is kept with the decision', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      const short = await decide(sheet, DECIDER, { decision: 'REJECT', override_reason: 'too short' });
      expect([400, 422]).toContain(short.status);
      const missing = await decide(sheet, DECIDER, { decision: 'REJECT' });
      expect([missing.status, missing.json.code]).toEqual([422, 'OVERRIDE_REASON_REQUIRED']);
      const reason = 'The financing agreement was withdrawn';
      const done = await decide(sheet, DECIDER, { decision: 'REJECT', override_reason: reason });
      expect(done.status).toBe(200);
      expect((await audits('project.appraisal_decided', sheet.id))[0]?.safe_diff).toMatchObject({ against_recommendation: true, override_reason: reason, decision: 'REJECT' });
      expect((await sheetRows(target.id))[0]).toMatchObject({ override_reason: reason });
    });

    it('AC-ST-PRJ-003-3: two decisions on the same sheet: the second one finds the version moved (409 VERSION_CONFLICT)', async () => {
      const { sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      const decision = await document();
      const results = await Promise.all([decide(sheet, DECIDER, { decision_document_id: decision, project_group: 'B' }), decide(sheet, DECIDER, { decision_document_id: decision, project_group: 'C' })]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expect(results.find((result) => result.status === 409)?.json.code).toBe('VERSION_CONFLICT');
    });
  });

  describe('scope, authority and tenant', () => {
    it('AC-ST-PRJ-003-3: a caller without the permission is refused 403 and the refusal is audited; one inside no scope does not see the project', async () => {
      const target = await project();
      await submit(target);
      const noPermission = await appraise(target, [4, 3, 5, 2, 4], READER);
      expect([noPermission.status, noPermission.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const submitDenied = await call('POST', `/projects/${(await project()).id}/appraisal-submissions`, { member: READER, ifMatch: '"1"', body: { reason: 'Not mine to send', policy_proposal_document_id: await document() } });
      expect(submitDenied.status).toBe(403);
      expect(await sheetRows(target.id)).toEqual([]);
    });

    it('AC-ST-PRJ-003-3: a decision maker of the department decides on its projects and on no others; a project of another tenant does not exist', async () => {
      const { sheets } = await appraised([[4, 3, 5, 2, 4]]);
      const sheet = sheets[0] as { id: string; version: number };
      const decision = await document();
      const reply = await decide(sheet, DEPARTMENT_DECIDER, { decision_document_id: decision, project_group: 'B' });
      expect(reply.status).toBe(200);
      const foreign = await project({ tenant: TENANT_B, creator: B_PROPOSER });
      const crossing = await call('POST', `/projects/${foreign.id}/appraisals`, { member: APPRAISER, body: { criteria_set_version_id: criteria.versionId, scores: scoresOf([4, 3, 5, 2, 4]), recommendation: 'ADMIT' } });
      expect([crossing.status, crossing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const unknown = await decide({ id: randomUUID(), version: 1 }, DECIDER, {});
      expect([unknown.status, unknown.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const other = await appraised([[4, 3, 5, 2, 4]]);
      const crossed = await call('POST', `/project-appraisals/${other.sheets[0]?.id}/decision`, { member: B_PROPOSER, tenantId: TENANT_B, ifMatch: '"1"', body: { decision: 'RETURN', reason: 'Crossing tenants', override_reason: 'There is nothing to override across tenants' } });
      expect([crossed.status, crossed.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });

    it('AC-ST-PRJ-003-3: a project that names a deciding authority is decided on only by whoever holds the right over that unit', async () => {
      const { sheets } = await appraised([[4, 3, 5, 2, 4]], { authorityUnit: AUTHORITY_UNIT });
      const sheet = sheets[0] as { id: string; version: number };
      const decision = await document();
      const outside = await decide(sheet, OUTSIDE_AUTHORITY, { decision_document_id: decision, project_group: 'B' });
      expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const inside = await decide(sheet, AUTHORITY_DECIDER, { decision_document_id: decision, project_group: 'B' });
      expect(inside.status).toBe(200);
    });
  });

  describe('what the lifecycle shows', () => {
    it('AC-ST-PRJ-003-3: a decision maker reads every sheet, the mean and the override rule; an appraiser only their own; a reader nothing of it', async () => {
      const { target, sheets } = await appraised([[4, 3, 5, 2, 4], [1, 1, 1, 1, 1]]);
      const asDecider = await call('GET', `/projects/${target.id}/lifecycle`, { member: DECIDER });
      expect(asDecider.status).toBe(200);
      const view = asDecider.json.appraisal as Record<string, unknown>;
      expect(view).toMatchObject({
        round: 1,
        can_record: false,
        can_decide: true,
        viewer_is_proposer: false,
        summary: { sheet_count: 2, mean_score: '46.50', threshold_recommendation: 'REJECT', override_required: { ADMIT: true, REJECT: true, RETURN: true } },
        decision_target: { id: sheets[0]?.id, version: 1 },
      });
      expect((view.sheets as Array<Record<string, unknown>>).map((sheet) => [sheet.total_score, sheet.mine])).toEqual([
        ['73.00', false],
        ['20.00', false],
      ]);
      expect(view.criteria_set).toMatchObject({ version_id: criteria.versionId, pass_threshold: '60', criteria: [{ code: 'C1', weight: '30' }, { code: 'C2' }, { code: 'C3' }, { code: 'C4' }, { code: 'C5', weight: '10' }] });
      const asAppraiser = await call('GET', `/projects/${target.id}/lifecycle`, { member: APPRAISER });
      const own = asAppraiser.json.appraisal as Record<string, unknown>;
      expect(own).toMatchObject({ can_record: true, can_decide: false, summary: null, decision_target: null });
      expect((own.sheets as Array<Record<string, unknown>>).map((sheet) => [sheet.total_score, sheet.mine])).toEqual([['73.00', true]]);
      const asReader = await call('GET', `/projects/${target.id}/lifecycle`, { member: READER });
      expect(asReader.status).toBe(200);
      expect(asReader.json.appraisal).toBeNull();
      expect(JSON.stringify(asReader.json)).not.toContain('73.00');
      const asProposer = await call('GET', `/projects/${target.id}/lifecycle`, { member: EVERYTHING });
      expect((asProposer.json.appraisal as Record<string, unknown>).can_record).toBe(true);
    });

    it('blind scoring: the proposer who holds the right to decide reads none of the sheets while the round is open, and the decision maker still reads all of them', async () => {
      const target = await project({ creator: EVERYTHING });
      const sent = await submit(target, EVERYTHING);
      expect(sent.status).toBe(200);
      const scored = await appraise(target, [4, 3, 5, 2, 4], APPRAISER);
      expect(scored.status).toBe(200);
      const mine = (await call('GET', `/projects/${target.id}/lifecycle`, { member: EVERYTHING })).json.appraisal as Record<string, unknown>;
      expect(mine).toMatchObject({ viewer_is_proposer: true, can_decide: false, summary: null, decision_target: null, sheets: [] });
      expect(JSON.stringify(mine)).not.toContain('73.00');
      const theirs = (await call('GET', `/projects/${target.id}/lifecycle`, { member: DECIDER })).json.appraisal as Record<string, unknown>;
      expect(theirs).toMatchObject({ can_decide: true, summary: { sheet_count: 1, mean_score: '73.00' } });
      expect((theirs.sheets as unknown[]).length).toBe(1);
    });

    it('AC-ST-PRJ-003-3: the proposer is told they cannot score or decide, and the lifecycle of another tenant does not exist', async () => {
      const target = await project({ creator: EVERYTHING });
      await submit(target, EVERYTHING);
      const mine = await call('GET', `/projects/${target.id}/lifecycle`, { member: EVERYTHING });
      expect(mine.json.appraisal).toMatchObject({ viewer_is_proposer: true, can_record: false, can_decide: false });
      const crossing = await call('GET', `/projects/${target.id}/lifecycle`, { member: B_PROPOSER, tenantId: TENANT_B });
      expect([crossing.status, crossing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });
});
