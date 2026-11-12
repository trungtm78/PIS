import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { AuditWriter, DgvQualityRunJob, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { DgvCatalogController, DgvDatasetController } from '../../src/modules/dgv/dgv-dataset.controller';
import { DgvQualityCommandsController, DgvScorecardController, QualityRuleReadsController, QualityRunReadsController } from '../../src/modules/dgv/dgv-quality.controller';
import { SNAPSHOT_FROZEN_EVENT, SnapshotFrozenConsumer } from '../../src/modules/dgv/snapshot-frozen.consumer';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedFinishedRun, seedSnapshot, seedWorkingContract } from '../../../../packages/db/test/support/dgv-quality-fixtures';
import type { LineSpec } from '../../../../packages/db/test/support/dgv-quality-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const STEWARD = 1; // drafts rules, requests runs, registers datasets
const OWNER = 2; // approves rules
const UNIT_STEWARD = 3; // the permissions of the steward on a unit subtree only
const READER = 4; // reads the catalogue and the quality
const NOBODY = 5;
const LEAD = 7; // drafts and approves, so the one person can try to approve their own draft
const OTHER_TENANT_STEWARD = 6;
const QUALITY_READS = ['data.quality.read', 'quality_rule_version.read', 'quality_run.read'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('quality rules, runs and scorecards over HTTP (ST-DGV-002)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let tenants: TenantDatabase;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  let counter = 0;

  interface World {
    datasetId: string;
    contractId: string;
    code: string;
  }

  /** A dataset of the DIS module registered through the API, with its working contract. */
  async function newWorld(extra: Record<string, unknown> = {}): Promise<World> {
    counter += 1;
    const code = `DS-QA-${counter}-${randomUUID().slice(0, 5)}`.toUpperCase();
    const created = await call('POST', '/dgv/datasets', {
      member: STEWARD,
      body: {
        dataset_code: code,
        title: `Quality API dataset ${counter}`,
        domain: 'DISBURSEMENT',
        grain: 'one row per project and bucket',
        producer_module: 'DIS',
        owner_user_id: memberId(OWNER),
        steward_user_id: memberId(STEWARD),
        classification: 'INTERNAL',
        is_critical: true,
        freshness_slo_seconds: 86_400,
        ...extra,
      },
    });
    expect(created.status).toBe(200);
    const datasetId = idOf(created);
    return { datasetId, contractId: await seedWorkingContract(harness, TENANT_A, datasetId, code, OWNER), code };
  }

  const ruleBody = (world: World, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    contract_id: world.contractId,
    code: 'R-COMPLETE',
    dimension: 'COMPLETENESS',
    expression_ast: { op: 'not_null', field: 'project_id' },
    severity: 'MEDIUM',
    threshold_json: { min_pass_rate_pct: '99.5' },
    action_on_fail: 'HARD_BLOCK',
    criticality_weight: 3,
    ...extra,
  });
  const createRule = (member: number, payload: Record<string, unknown>, key?: string): Promise<Reply> => call('POST', '/dgv/quality-rules', { member, body: payload, ...(key === undefined ? {} : { key }) });
  const approveRule = (member: number, ruleId: string, version: number | string = 1): Promise<Reply> => call('POST', `/dgv/quality-rules/${ruleId}/approval`, { member, ifMatch: `"${version}"`, body: {} });
  const requestRun = (member: number, world: World, snapshotId: string, trigger = 'MANUAL'): Promise<Reply> =>
    call('POST', '/dgv/quality-runs', { member, body: { dataset_contract_id: world.contractId, snapshot_id: snapshotId, trigger } });
  const snapshot = (lines?: LineSpec[], status?: string) => seedSnapshot(harness, TENANT_A, STEWARD, { ...(lines === undefined ? {} : { lines }), ...(status === undefined ? {} : { status }) });
  const job = () => new DgvQualityRunJob(tenants, new AuditWriter(tenants));
  const execute = () => job().runPending({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 });

  async function approved(world: World, extra: Record<string, unknown>): Promise<string> {
    const created = await createRule(STEWARD, ruleBody(world, extra));
    expect(created.status).toBe(200);
    expect((await approveRule(OWNER, idOf(created))).status).toBe(200);
    return idOf(created);
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [STEWARD, OWNER, UNIT_STEWARD, READER, NOBODY, LEAD]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_STEWARD, 1);
    const stewardPermissions = ['data.catalog.manage', 'data.catalog.read', 'data.quality.manage', 'data.quality.run', ...QUALITY_READS];
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', stewardPermissions, 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_OWNER', ['data.catalog.read', 'data.quality.approve', ...QUALITY_READS], 30);
    await harness.seedRole(TENANT_A, 3, 'UNIT_DATA_STEWARD', [...stewardPermissions, 'data.quality.approve'], 35);
    await harness.seedRole(TENANT_A, 4, 'DATA_READER', ['data.catalog.read', ...QUALITY_READS], 20);
    await harness.seedRole(TENANT_A, 5, 'DATA_LEAD', ['data.catalog.read', 'data.quality.manage', 'data.quality.approve', ...QUALITY_READS], 38);
    await harness.seedRole(TENANT_B, 1, 'DATA_STEWARD', ['data.catalog.manage', 'data.catalog.read', 'data.quality.manage', 'data.quality.run', 'data.quality.approve', ...QUALITY_READS], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: UNIT_STEWARD, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: LEAD, role: 5, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_STEWARD, role: 1, kind: 'TENANT' }]);
    await dropSnapshotFixtureKeys(harness, TENANT_A);
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [DgvDatasetController, DgvCatalogController, DgvQualityCommandsController, DgvScorecardController, QualityRuleReadsController, QualityRunReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('createQualityRuleVersion and approveQualityRuleVersion', () => {
    it('UAT-AC484: refuses the author approving the rule, accepts another approver, and refuses a raw SQL node (AC-ST-DGV-002-3)', async () => {
      const world = await newWorld();
      const draft = await createRule(LEAD, ruleBody(world));
      expect(draft.status).toBe(200);
      expect(draft.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });

      const self = await approveRule(LEAD, idOf(draft));
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await rows<{ status: string }>('select status from machvon.quality_rule_version where id = $1', [idOf(draft)]))[0]?.status).toBe('DRAFT');

      const done = await approveRule(OWNER, idOf(draft));
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });
      expect((await rows<{ status: string; approved_by: string }>('select status, approved_by from machvon.quality_rule_version where id = $1', [idOf(draft)]))[0]).toEqual({ status: 'APPROVED', approved_by: memberId(OWNER) });

      const raw = await createRule(STEWARD, ruleBody(world, { code: 'R-RAW', expression_ast: { op: 'raw_sql', sql: 'select 1' } }));
      expect([raw.status, raw.json.code, raw.json.detail]).toEqual([422, 'EXPRESSION_NOT_ALLOWED', 'expression_ast']);
      expect(await rows('select id from machvon.quality_rule_version where code = $1', ['R-RAW'])).toEqual([]);
    });

    it('writes the audit rows and the events of the draft and the approval with the stored values, and replays an identical request without a second rule', async () => {
      const world = await newWorld();
      const payload = ruleBody(world, { code: '  R-AUDIT  ', threshold_json: { min_pass_rate_pct: 99.5 }, contract_id: world.contractId.toUpperCase() });
      const key = `key-${randomUUID()}`;
      const first = await createRule(STEWARD, payload, key);
      const replay = await createRule(STEWARD, payload, key);
      expect(replay).toEqual(first);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.quality_rule_version where contract_id = $1', [world.contractId]))[0]?.n)).toBe(1);
      await approveRule(OWNER, idOf(first));

      const audit = await rows<{ action: string; actor_id: string; safe_diff: Record<string, unknown> }>('select action, actor_id, safe_diff from machvon.audit_event where resource_id = $1 order by occurred_at', [idOf(first)]);
      expect(audit.map((row) => [row.action, row.actor_id])).toEqual([
        ['dgv.quality_rule_drafted', memberId(STEWARD)],
        ['dgv.quality_rule_approved', memberId(OWNER)],
      ]);
      expect(audit[0]?.safe_diff).toMatchObject({ contract_id: world.contractId, code: 'R-AUDIT', revision: 1, threshold_min_percent: '99.500000', threshold_warn_percent: null, dataset_id: world.datasetId });
      expect(audit[1]?.safe_diff).toMatchObject({ author_user_id: memberId(STEWARD), superseded_ids: [], revision: 1 });
      const events = await rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1 order by created_at', [idOf(first)]);
      expect(events.map((event) => event.type)).toEqual(['dgv.rule.drafted.v1', 'dgv.rule.approved.v1']);
      expect(events[0]?.payload).toMatchObject({ rule_version_id: idOf(first), code: 'R-AUDIT', dimension: 'COMPLETENESS' });
    });

    it('refuses a person without the permission, an unknown or a missing field, a stale version, a rule that is already approved, and ids that do not exist', async () => {
      const world = await newWorld();
      expect((await createRule(READER, ruleBody(world))).status).toBe(403);
      expect((await createRule(NOBODY, ruleBody(world))).status).toBe(403);
      const unknown = await createRule(STEWARD, ruleBody(world, { status: 'APPROVED' }));
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const incomplete = ruleBody(world);
      delete incomplete.threshold_json;
      expect([(await createRule(STEWARD, incomplete)).status, (await createRule(STEWARD, incomplete)).json.code]).toEqual([400, 'INVALID_REQUEST']);
      const threshold = await createRule(STEWARD, ruleBody(world, { threshold_json: { min_pass_rate_pct: '120' } }));
      expect([threshold.status, threshold.json.code]).toEqual([422, 'THRESHOLD_INVALID']);
      const stranger = await createRule(STEWARD, ruleBody(world, { contract_id: randomUUID() }));
      expect([stranger.status, stranger.json.code, stranger.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'contract_id']);
      const notAUuid = await createRule(STEWARD, ruleBody(world, { contract_id: 'not-a-uuid' }));
      expect([notAUuid.status, notAUuid.json.code]).toEqual([422, 'VALIDATION_FAILED']);

      const draft = await createRule(STEWARD, ruleBody(world));
      const stale = await approveRule(OWNER, idOf(draft), 9);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await approveRule(OWNER, idOf(draft))).status).toBe(200);
      const again = await approveRule(OWNER, idOf(draft), 2);
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      const missing = await approveRule(OWNER, randomUUID());
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await approveRule(READER, idOf(draft), 2)).status).toBe(403);
    });

    it('needs the permission on the whole tenant: a grant on a unit subtree is refused with 403 SCOPE_DENIED and nothing is written', async () => {
      const world = await newWorld();
      const snap = await snapshot();
      const draft = await createRule(STEWARD, ruleBody(world, { code: 'R-SCOPE' }));
      await approveRule(OWNER, idOf(draft));
      const create = await createRule(UNIT_STEWARD, ruleBody(world, { code: 'R-UNIT' }));
      expect([create.status, create.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select id from machvon.quality_rule_version where code = $1', ['R-UNIT'])).toEqual([]);
      const second = await createRule(STEWARD, ruleBody(world, { code: 'R-SCOPE-2' }));
      const approve = await approveRule(UNIT_STEWARD, idOf(second));
      expect([approve.status, approve.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await rows<{ status: string }>('select status from machvon.quality_rule_version where id = $1', [idOf(second)]))[0]?.status).toBe('DRAFT');
      const run = await requestRun(UNIT_STEWARD, world, snap.id);
      expect([run.status, run.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select id from machvon.quality_run where snapshot_id = $1', [snap.id])).toEqual([]);
    });
  });

  describe('runQualityChecks and the event that a snapshot was frozen', () => {
    it('answers 202 RUNNING for a run on a frozen snapshot, 409 RUN_ALREADY_RUNNING for a second while it runs, and writes the audit row (AC-ST-DGV-002-4)', async () => {
      const world = await newWorld();
      await approved(world, { code: 'R-A' });
      const snap = await snapshot();
      const first = await requestRun(STEWARD, world, snap.id);
      expect(first.status).toBe(202);
      expect(first.json).toMatchObject({ status: 'RUNNING', resource_version: 1 });
      const second = await requestRun(STEWARD, world, snap.id, 'SCHEDULE');
      expect([second.status, second.json.code, second.json.detail]).toEqual([409, 'RUN_ALREADY_RUNNING', 'snapshot_id']);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.quality_run where dataset_id = $1 and snapshot_id = $2', [world.datasetId, snap.id]))[0]?.n)).toBe(1);
      const audit = await rows<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id = $1', [idOf(first)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'dgv.quality_run_requested', safe_diff: { dataset_id: world.datasetId, snapshot_id: snap.id, trigger: 'MANUAL', rule_count: 1 } });
      await execute();
      expect((await rows<{ status: string }>('select status from machvon.quality_run where id = $1', [idOf(first)]))[0]?.status).toBe('COMPLETED');
    });

    it('refuses a snapshot that does not exist (404 SNAPSHOT_NOT_FOUND), one that is not frozen (409), a trigger that is not allowed, and a contract without approved rules', async () => {
      const world = await newWorld();
      const bare = await newWorld();
      await approved(world, { code: 'R-A' });
      const missing = await requestRun(STEWARD, world, randomUUID());
      expect([missing.status, missing.json.code]).toEqual([404, 'SNAPSHOT_NOT_FOUND']);
      const building = await snapshot(undefined, 'BUILDING');
      const notFrozen = await requestRun(STEWARD, world, building.id);
      expect([notFrozen.status, notFrozen.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      const snap = await snapshot();
      const trigger = await requestRun(STEWARD, world, snap.id, 'SNAPSHOT_FROZEN');
      expect([trigger.status, trigger.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const noRules = await requestRun(STEWARD, bare, snap.id);
      expect([noRules.status, noRules.json.code, noRules.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'dataset_contract_id']);
      expect((await requestRun(READER, world, snap.id)).status).toBe(403);
    });

    it('starts one run per dataset when snapshot.frozen.v1 is delivered twice, and a manual run while it is running is 409 (AC-ST-DGV-002-4)', async () => {
      const world = await newWorld();
      await approved(world, { code: 'R-A' });
      const snap = await snapshot();
      const consumer = new SnapshotFrozenConsumer({ database: tenants, security: { signingKey: SIGNING_KEY } });
      const delivery = (id: string, payload: Record<string, unknown>, type = SNAPSHOT_FROZEN_EVENT) => ({
        id,
        tenantId: TENANT_A,
        tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
        type,
        payload,
      });
      const eventId = randomUUID();
      expect(await consumer.handle(delivery(eventId, { snapshot_id: snap.id }))).toBe('processed');
      expect(await consumer.handle(delivery(eventId, { snapshot_id: snap.id }))).toBe('duplicate');
      // Another event for the same snapshot (the producer repeated itself) starts nothing more.
      expect(await consumer.handle(delivery(randomUUID(), { snapshot_id: snap.id.toUpperCase(), tenant_id: TENANT_A }))).toBe('processed');
      const started = await rows<{ trigger: string; status: string; triggered_by: string }>('select trigger, status, triggered_by from machvon.quality_run where dataset_id = $1 and snapshot_id = $2', [world.datasetId, snap.id]);
      expect(started).toEqual([{ trigger: 'SNAPSHOT_FROZEN', status: 'RUNNING', triggered_by: WORKER_MEMBERSHIP_ID }]);
      const manual = await requestRun(STEWARD, world, snap.id);
      expect([manual.status, manual.json.code]).toEqual([409, 'RUN_ALREADY_RUNNING']);
      const audit = await rows<{ action: string; actor_id: string }>("select action, actor_id from machvon.audit_event where action = 'dgv.quality_run_requested' and safe_diff ->> 'dataset_id' = $1", [world.datasetId]);
      expect(audit).toEqual([{ action: 'dgv.quality_run_requested', actor_id: WORKER_MEMBERSHIP_ID }]);

      // What is not ours to act on is left alone: another event type, a payload of another tenant, a payload without the snapshot, a tampered context.
      expect(await consumer.handle(delivery(randomUUID(), { snapshot_id: snap.id }, 'report.accepted.v1'))).toBe('ignored');
      expect(await consumer.handle(delivery(randomUUID(), { snapshot_id: snap.id, tenant_id: TENANT_B }))).toBe('ignored');
      await expect(consumer.handle(delivery(randomUUID(), { snapshot_id: 'not-a-uuid' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(consumer.handle({ ...delivery(randomUUID(), { snapshot_id: snap.id }), tenantContext: 'forged' })).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
      // A snapshot that is not frozen, or that does not exist, starts nothing.
      const building = await snapshot(undefined, 'BUILDING');
      expect(await consumer.handle(delivery(randomUUID(), { snapshot_id: building.id }))).toBe('processed');
      expect(await rows('select id from machvon.quality_run where snapshot_id = $1', [building.id])).toEqual([]);
      await execute();
    });
  });

  describe('getQualityScorecard', () => {
    it('UAT-AC485: is a hard fail with a score of about 95 and a CRITICAL incident when nine rules pass and one integrity rule finds a reference to no project (AC-ST-DGV-002-1)', async () => {
      const world = await newWorld({ is_critical: true });
      const passing: Array<[string, string, unknown]> = [
        ['R-01', 'COMPLETENESS', { op: 'not_null', field: 'project_id' }],
        ['R-02', 'COMPLETENESS', { op: 'not_blank', field: 'bucket' }],
        ['R-03', 'VALIDITY', { op: 'between', field: 'rate_total_pct', min: 0, max: 100 }],
        ['R-04', 'VALIDITY', { op: 'in', field: 'bucket', values: ['CURRENT_YEAR', 'CARRYOVER'] }],
        ['R-05', 'UNIQUENESS', { op: 'unique', fields: ['project_id', 'bucket', 'budget_level'] }],
        ['R-06', 'CONSISTENCY', { op: 'compare_fields', left: 'ctmtqg_subset_vnd', cmp: 'lte', right: 'plan_total_vnd' }],
        ['R-07', 'TIMELINESS', { op: 'snapshot_age_within', seconds: 31_536_000 }],
        ['R-08', 'VALIDITY', { op: 'compare', field: 'plan_total_vnd', cmp: 'gte', value: '0' }],
        ['R-09', 'COMPLETENESS', { op: 'and', args: [{ op: 'not_null', field: 'unit_id' }, { op: 'not_null', field: 'treasury_coverage' }] }],
      ];
      for (const [code, dimension, ast] of passing) await approved(world, { code, dimension, expression_ast: ast, threshold_json: { min_pass_rate_pct: '100' }, criticality_weight: 1 });
      await approved(world, {
        code: 'R-10-FK',
        dimension: 'INTEGRITY',
        severity: 'MEDIUM',
        expression_ast: { op: 'reference_exists', field: 'project_id' },
        threshold_json: { min_pass_rate_pct: '100' },
        criticality_weight: 1,
      });
      const snap = await snapshot([{}, {}, { project: 'dangling' }, { project: 'dangling' }]);
      const requested = await requestRun(STEWARD, world, snap.id);
      expect(requested.status).toBe(202);
      await execute();

      const card = await call('GET', `/dgv/datasets/${world.datasetId}/quality-scorecard`, { member: READER });
      expect(card.status).toBe(200);
      expect(card.json).toMatchObject({
        dataset_id: world.datasetId,
        badge: 'FAILED',
        assessed: true,
        score: '95.00',
        hard_fail: true,
        certified_blocked: true,
        snapshot_id: snap.id,
        definition_status: 'PROPOSED_PENDING_SIGNOFF',
        open_incidents: 1,
        overdue_incidents: 0,
        pending_attempt: null,
      });
      expect(card.json.latest_run).toMatchObject({ id: idOf(requested), status: 'COMPLETED', overall_result: 'FAILED', score: '95.00', hard_fail: true, trigger: 'MANUAL', rule_count: 10 });
      const integrity = (card.json.rules as Array<Record<string, unknown>>).find((rule) => rule.code === 'R-10-FK');
      expect(integrity).toMatchObject({ result: 'FAIL', evaluated_count: 4, failed_count: 2, measured_value: '50.000000', threshold: { min_pass_rate_pct: '100.000000' } });
      expect(integrity).not.toHaveProperty('sample_refs');
      expect(JSON.stringify(card.json)).not.toContain(snap.projectIds[2]);
      const dimensions = card.json.dimensions as Array<{ dimension: string; assessed: boolean; score: string | null }>;
      expect(dimensions.find((dimension) => dimension.dimension === 'INTEGRITY')).toMatchObject({ assessed: true, score: '50.00' });
      expect(dimensions.find((dimension) => dimension.dimension === 'ACCURACY')).toMatchObject({ assessed: false, score: null });
      const incident = (await rows<{ severity: string; sla_hours: number; status: string }>('select severity, sla_hours, status from machvon.quality_incident where run_id = $1', [idOf(requested)]))[0];
      expect(incident).toEqual({ severity: 'CRITICAL', sla_hours: 4, status: 'OPEN' });
      const runDetail = await call('GET', `/resources/quality_run/${idOf(requested)}`, { member: READER });
      expect(runDetail.json).toMatchObject({ id: idOf(requested), certified_blocked: true, hard_fail: true, snapshot_id: snap.id });
    });

    it('UAT-AC486: shows NOT_ASSESSED with a null score for a dataset with no run, STALE with its age for an old run, and the executive average leaves out the unassessed dataset (AC-ST-DGV-002-2)', async () => {
      const domain = `AC2${randomUUID().slice(0, 5).toUpperCase()}`;
      const never = await newWorld({ domain });
      const stale = await newWorld({ domain });
      await seedFinishedRun(harness, TENANT_A, { datasetId: stale.datasetId, contractId: stale.contractId, ageHours: 48, overall: 'PASSED', score: '80.00' });

      const neverCard = await call('GET', `/dgv/datasets/${never.datasetId}/quality-scorecard`, { member: STEWARD });
      expect(neverCard.json).toMatchObject({ badge: 'NOT_ASSESSED', assessed: false, score: null, hard_fail: null, certified_blocked: null, latest_run: null, snapshot_id: null, freshness: { slo_seconds: 86_400, age_seconds: null } });
      const staleCard = await call('GET', `/dgv/datasets/${stale.datasetId}/quality-scorecard`, { member: STEWARD });
      expect(staleCard.json).toMatchObject({ badge: 'STALE', assessed: true, score: '80.00', freshness: { slo_seconds: 86_400 } });
      const age = (staleCard.json.freshness as { age_seconds: number }).age_seconds;
      expect(age).toBeGreaterThanOrEqual(2 * 86_400 - 5);

      const catalog = await call('GET', `/dgv/catalog?domain=${domain}`, { member: STEWARD });
      expect(catalog.status).toBe(200);
      expect(catalog.json.summary).toEqual({ total: 2, not_assessed: 1, passed: 0, warning: 0, failed: 0, stale: 1, hard_fail: 0, open_incidents: 0, overdue_incidents: 0, average_score: '80.00' });
      const items = catalog.json.items as Array<Record<string, unknown>>;
      expect(items.find((item) => item.id === never.datasetId)).toMatchObject({ quality_badge: 'NOT_ASSESSED', quality_score: null, quality_hard_fail: null, quality_run_at: null, working_contract_id: never.contractId });
      expect(items.find((item) => item.id === stale.datasetId)).toMatchObject({ quality_badge: 'STALE', quality_score: '80.00', quality_hard_fail: false });
      const empty = await call('GET', '/dgv/catalog?domain=NOTHING-HERE', { member: STEWARD });
      expect(empty.json.summary).toEqual({ total: 0, not_assessed: 0, passed: 0, warning: 0, failed: 0, stale: 0, hard_fail: 0, open_incidents: 0, overdue_incidents: 0, average_score: null });
    });

    it('does not exist for a reader who may not see the dataset, for another tenant, or for an id that is nobody\'s; and needs the permission', async () => {
      const world = await newWorld({ classification: 'CONFIDENTIAL' });
      await seedFinishedRun(harness, TENANT_A, { datasetId: world.datasetId, contractId: world.contractId, ageHours: 1, overall: 'PASSED', score: '99.00' });
      expect((await call('GET', `/dgv/datasets/${world.datasetId}/quality-scorecard`, { member: STEWARD })).status).toBe(200);
      for (const outsider of [{ member: READER }, { member: OTHER_TENANT_STEWARD, tenantId: TENANT_B }]) {
        const hidden = await call('GET', `/dgv/datasets/${world.datasetId}/quality-scorecard`, outsider);
        expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      }
      expect((await call('GET', `/dgv/datasets/${randomUUID()}/quality-scorecard`, { member: STEWARD })).status).toBe(404);
      expect((await call('GET', `/dgv/datasets/${world.datasetId}/quality-scorecard`, { member: NOBODY })).status).toBe(403);
    });
  });

  describe('the reads of the rule versions and of the runs', () => {
    it('lists and opens the rule versions of the visible datasets, by dataset and status, page by page', async () => {
      const world = await newWorld();
      const hidden = await newWorld({ classification: 'CONFIDENTIAL' });
      const first = await approved(world, { code: 'R-LIST-A' });
      const second = await createRule(STEWARD, ruleBody(world, { code: 'R-LIST-B' }));
      await createRule(STEWARD, ruleBody(hidden, { code: 'R-LIST-HIDDEN' }));

      const page1 = await call('GET', `/resources/quality_rule_version?dataset_id=${world.datasetId}&limit=1`, { member: READER });
      expect(page1.status).toBe(200);
      expect((page1.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([first]);
      expect(typeof page1.json.as_of).toBe('string');
      const cursor = page1.json.next_cursor as string;
      expect(cursor).toEqual(expect.any(String));
      const page2 = await call('GET', `/resources/quality_rule_version?dataset_id=${world.datasetId}&limit=1&cursor=${cursor}`, { member: READER });
      expect((page2.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([idOf(second)]);
      expect(page2.json.next_cursor).toBeNull();
      const drafts = await call('GET', `/resources/quality_rule_version?dataset_id=${world.datasetId}&status=DRAFT`, { member: READER });
      expect((drafts.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([idOf(second)]);
      const seenByReader = await call('GET', '/resources/quality_rule_version?limit=200', { member: READER });
      expect((seenByReader.json.items as Array<{ code: string }>).map((item) => item.code)).not.toContain('R-LIST-HIDDEN');
      const seenBySteward = await call('GET', '/resources/quality_rule_version?limit=200', { member: STEWARD });
      expect((seenBySteward.json.items as Array<{ code: string }>).map((item) => item.code)).toContain('R-LIST-HIDDEN');

      const detail = await call('GET', `/resources/quality_rule_version/${first}`, { member: READER });
      expect(detail.json).toMatchObject({ id: first, code: 'R-LIST-A', status: 'APPROVED', approved_by_name: 'User 2', expression_ast: { op: 'not_null', field: 'project_id' }, version: 2 });
      expect((await call('GET', `/resources/quality_rule_version/${first}`, { member: OTHER_TENANT_STEWARD, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/resources/quality_rule_version/${randomUUID()}`, { member: STEWARD })).status).toBe(404);
      expect((await call('GET', '/resources/quality_rule_version', { member: NOBODY })).status).toBe(403);
      for (const query of ['?dataset_id=nope', '?status=ALMOST', '?limit=0', '?cursor=%%%']) expect((await call('GET', `/resources/quality_rule_version${query}`, { member: READER })).status).toBe(422);
    });

    it('lists and opens the runs of the visible datasets, newest first, by dataset and status', async () => {
      const world = await newWorld();
      const hidden = await newWorld({ classification: 'CONFIDENTIAL' });
      await approved(world, { code: 'R-A' });
      const older = await seedFinishedRun(harness, TENANT_A, { datasetId: world.datasetId, contractId: world.contractId, ageHours: 5, overall: 'PASSED', score: '90.00' });
      const hiddenRun = await seedFinishedRun(harness, TENANT_A, { datasetId: hidden.datasetId, contractId: hidden.contractId, ageHours: 1, overall: 'PASSED', score: '99.00' });
      const running = await requestRun(STEWARD, world, (await snapshot()).id);

      const all = await call('GET', `/resources/quality_run?dataset_id=${world.datasetId}`, { member: READER });
      expect((all.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([idOf(running), older]);
      expect((all.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'RUNNING', score: null, overall_result: null, finished_at: null, dataset_code: world.code, rule_count: 1 });
      const page1 = await call('GET', `/resources/quality_run?dataset_id=${world.datasetId}&limit=1`, { member: READER });
      const page2 = await call('GET', `/resources/quality_run?dataset_id=${world.datasetId}&limit=1&cursor=${page1.json.next_cursor as string}`, { member: READER });
      expect((page2.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([older]);
      const onlyRunning = await call('GET', `/resources/quality_run?dataset_id=${world.datasetId}&status=RUNNING`, { member: READER });
      expect((onlyRunning.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([idOf(running)]);
      const seenByReader = await call('GET', '/resources/quality_run?limit=200', { member: READER });
      expect((seenByReader.json.items as Array<{ id: string }>).map((item) => item.id)).not.toContain(hiddenRun);

      const detail = await call('GET', `/resources/quality_run/${older}`, { member: READER });
      expect(detail.json).toMatchObject({ id: older, status: 'COMPLETED', score: '90.00', overall_result: 'PASSED' });
      expect(typeof detail.json.as_of).toBe('string');
      for (const outsider of [{ member: READER }, { member: OTHER_TENANT_STEWARD, tenantId: TENANT_B }]) expect((await call('GET', `/resources/quality_run/${hiddenRun}`, outsider)).status).toBe(404);
      expect((await call('GET', '/resources/quality_run', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/resources/quality_run?cursor=bm90LWEtY3Vyc29y', { member: READER })).status).toBe(422);
      await execute();
    });
  });
});
