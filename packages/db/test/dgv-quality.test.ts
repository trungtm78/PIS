import { randomUUID } from 'node:crypto';
import { CollectingTelemetry } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { WORKER_MEMBERSHIP_ID } from '../src/consumer-inbox';
import { DgvDatasetStore } from '../src/dgv-dataset-store';
import type { DatasetViewer } from '../src/dgv-dataset-store';
import { DgvQualityRuleStore } from '../src/dgv-quality-rule-store';
import type { QualityRuleDraftInput } from '../src/dgv-quality-rule-store';
import { DgvQualityRunJob, MAX_RUN_ATTEMPTS, QualityRunsBroken } from '../src/dgv-quality-run-job';
import { DgvQualityRunStore } from '../src/dgv-quality-run-store';
import { DIS_PERIOD_SNAPSHOT_SOURCE, countSnapshotRows, evaluateExpression, loadSnapshot, qualitySourceOf } from '../src/dgv-quality-source';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedFinishedRun, seedSnapshot, seedWorkingContract } from './support/dgv-quality-fixtures';
import type { SeededSnapshot, SnapshotSeed } from './support/dgv-quality-fixtures';

const harness = new AuthzHarness();
const datasets = new DgvDatasetStore();
const rules = new DgvQualityRuleStore();
const runs = new DgvQualityRunStore();
const STEWARD = 1;
const OWNER = 2;
const READER = 3; // reads the catalogue, owns nothing
const OTHER_TENANT_MEMBER = 4; // of tenant B only
const WORKER = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = STEWARD, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const viewer = (member: number, ...roleCodes: string[]): DatasetViewer => ({ membershipId: memberId(member), roleCodes });

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

let counter = 0;

interface World {
  datasetId: string;
  contractId: string;
  code: string;
}

/** A dataset of the DIS module (its rows are the lines of a period snapshot) with a working contract. */
async function newWorld(extra: { producerModule?: string; isCritical?: boolean; freshness?: number; classification?: string; allowedRoles?: string[] } = {}): Promise<World> {
  counter += 1;
  const code = `DS-Q-${counter}-${randomUUID().slice(0, 5)}`.toUpperCase();
  const created = await as((tx) =>
    datasets.register(
      tx,
      {
        datasetCode: code,
        title: `Quality dataset ${counter}`,
        domain: 'DISBURSEMENT',
        grain: 'one row per project and bucket',
        producerModule: extra.producerModule ?? 'DIS',
        ownerId: memberId(OWNER),
        stewardId: memberId(STEWARD),
        classification: (extra.classification ?? 'INTERNAL') as 'INTERNAL',
        isCritical: extra.isCritical ?? true,
        freshnessSloSeconds: extra.freshness ?? 86_400,
      },
      memberId(STEWARD),
    ),
  );
  if (extra.allowedRoles !== undefined) await owner('update machvon.dataset set allowed_role_codes = $2 where id = $1', [created.id, extra.allowedRoles]);
  const contractId = await seedWorkingContract(harness, TENANT_A, created.id, code, OWNER);
  return { datasetId: created.id, contractId, code };
}

/** A change of a snapshot that its guard refuses, made with the guard switched off for the statement (the defect that a run has to notice). */
const tamper = (sql: string, params: unknown[]) =>
  harness.owner(TENANT_A, [['alter table machvon.period_snapshot disable trigger period_snapshot_guard'], [sql, params], ['alter table machvon.period_snapshot enable trigger period_snapshot_guard']]);
const newSnapshot = (seed: SnapshotSeed = {}): Promise<SeededSnapshot> => seedSnapshot(harness, TENANT_A, STEWARD, seed);

const draft = (world: World, extra: Partial<QualityRuleDraftInput> & { code: string }): QualityRuleDraftInput => ({
  contractId: world.contractId,
  dimension: 'COMPLETENESS',
  expressionAst: { op: 'not_null', field: 'project_id' },
  severity: 'MEDIUM',
  thresholdJson: { min_pass_rate_pct: '100' },
  actionOnFail: 'QUARANTINE',
  criticalityWeight: 1,
  ...extra,
});

/** Writes a rule as the steward and approves it as the owner. */
async function approvedRule(world: World, extra: Partial<QualityRuleDraftInput> & { code: string }): Promise<string> {
  const created = await as((tx) => rules.create(tx, draft(world, extra), viewer(STEWARD)));
  await as((tx) => rules.approve(tx, created.id, 1, viewer(OWNER)), OWNER);
  return created.id;
}

const request = (world: World, snapshotId: string, member = STEWARD, trigger: 'MANUAL' | 'SCHEDULE' = 'MANUAL') =>
  as((tx) => runs.request(tx, { datasetContractId: world.contractId, snapshotId, trigger }, viewer(member)), member);

function newJob(metrics = new CollectingTelemetry()): { job: DgvQualityRunJob; metrics: CollectingTelemetry } {
  return { job: new DgvQualityRunJob(harness.tenants, new AuditWriter(harness.tenants), { metrics }), metrics };
}

const runRow = async (runId: string) =>
  (
    await owner<{ status: string; overall_result: string | null; score: string | null; hard_fail: boolean; certified_blocked: boolean; failure_code: string | null; passed_count: string; failed_count: string; quarantined_count: string; attempts: number }>(
      'select status, overall_result, score::text, hard_fail, certified_blocked, failure_code, passed_count::text, failed_count::text, quarantined_count::text, attempts from machvon.quality_run where id = $1',
      [runId],
    )
  )[0];

/** Executes the waiting runs of the tenant (only the ones this test requested are waiting: every test drains its own). */
const drain = async (job: DgvQualityRunJob) => job.runPending(WORKER);

describe('quality rules, runs on frozen snapshots and scorecards (ST-DGV-002)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
    for (const member of [STEWARD, OWNER, READER]) await harness.seedMembership(TENANT_A, member, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_MEMBER, 1);
    await dropSnapshotFixtureKeys(harness, TENANT_A);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('a rule version (createQualityRuleVersion, approveQualityRuleVersion)', () => {
    it('is written as a DRAFT revision 1, the next draft of the same code is revision 2, and the stored expression and threshold are the normalised ones', async () => {
      const world = await newWorld();
      const first = await as((tx) =>
        rules.create(tx, draft(world, { code: 'R-COMPLETE', dimension: 'COMPLETENESS', thresholdJson: { min_pass_rate_pct: 99.5, warn_pass_rate_pct: '98' }, fieldPath: 'project_id' }), viewer(STEWARD)),
      );
      expect(first).toMatchObject({ revision: 1, version: 1, datasetId: world.datasetId, datasetCode: world.code, isCritical: true });
      const second = await as((tx) => rules.create(tx, draft(world, { code: 'R-COMPLETE' }), viewer(STEWARD)));
      expect(second.revision).toBe(2);
      const row = await as((tx) => rules.find(tx, first.id, viewer(STEWARD)));
      expect(row).toMatchObject({
        status: 'DRAFT',
        revision: 1,
        dimension: 'COMPLETENESS',
        fieldPath: 'project_id',
        thresholdJson: { min_pass_rate_pct: '99.500000', warn_pass_rate_pct: '98.000000' },
        expressionAst: { op: 'not_null', field: 'project_id' },
        createdBy: memberId(STEWARD),
        approvedBy: null,
        approvedAt: null,
        version: 1,
      });
      // The field path defaults to the first field the expression reads; a rule that reads none (timeliness) has none.
      const timeliness = await as((tx) => rules.create(tx, draft(world, { code: 'R-AGE', dimension: 'TIMELINESS', expressionAst: { op: 'snapshot_age_within', seconds: 3600 } }), viewer(STEWARD)));
      expect((await as((tx) => rules.find(tx, timeliness.id, viewer(STEWARD))))?.fieldPath).toBeNull();
      expect((await as((tx) => rules.find(tx, second.id, viewer(STEWARD))))?.fieldPath).toBe('project_id');
    });

    it('refuses a rule with a raw SQL node as 422 EXPRESSION_NOT_ALLOWED and writes nothing (AC-ST-DGV-002-3)', async () => {
      const world = await newWorld();
      const raw = draft(world, { code: 'R-RAW', expressionAst: { op: 'raw_sql', sql: 'select 1' } });
      expect(await refusal(as((tx) => rules.create(tx, raw, viewer(STEWARD))))).toEqual({ code: 'EXPRESSION_NOT_ALLOWED', status: 422, detail: 'expression_ast' });
      expect(await refusal(as((tx) => rules.create(tx, draft(world, { code: 'R-ACC', dimension: 'ACCURACY' }), viewer(STEWARD))))).toEqual({ code: 'EXPRESSION_NOT_ALLOWED', status: 422, detail: 'expression_ast' });
      expect(await owner('select id from machvon.quality_rule_version where contract_id = $1', [world.contractId])).toEqual([]);
    });

    it('refuses what is not a rule: a threshold that cannot be judged, an unknown value, an integrity rule that only warns, a field path the expression does not read', async () => {
      const world = await newWorld();
      const create = (extra: Partial<QualityRuleDraftInput>) => refusal(as((tx) => rules.create(tx, draft(world, { code: 'R-BAD', ...extra }), viewer(STEWARD))));
      expect(await create({ thresholdJson: { min_pass_rate_pct: '101' } })).toEqual({ code: 'THRESHOLD_INVALID', status: 422, detail: 'threshold_json' });
      expect(await create({ dimension: 'INTEGRITY', expressionAst: { op: 'reference_exists', field: 'project_id' }, thresholdJson: { min_pass_rate_pct: '99' } })).toMatchObject({ code: 'THRESHOLD_INVALID' });
      expect(await create({ dimension: 'INTEGRITY', expressionAst: { op: 'reference_exists', field: 'project_id' }, actionOnFail: 'WARN' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'action_on_fail' });
      expect(await create({ dimension: 'NOPE' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'dimension' });
      expect(await create({ severity: 'SEVERE' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'severity' });
      expect(await create({ actionOnFail: 'DELETE' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'action_on_fail' });
      expect(await create({ criticalityWeight: 11 })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'criticality_weight' });
      expect(await create({ criticalityWeight: 0 })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'criticality_weight' });
      expect(await create({ criticalityWeight: 1.5 })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'criticality_weight' });
      expect(await create({ code: ' ' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'code' });
      expect(await create({ code: 'x'.repeat(81) })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'code' });
      expect(await create({ fieldPath: 'bucket' })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'field_path' });
      expect(await create({ fieldPath: 'x'.repeat(301) })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'field_path' });
      expect(await owner('select id from machvon.quality_rule_version where contract_id = $1', [world.contractId])).toEqual([]);
    });

    it('does not exist for a writer who cannot see the dataset, or in another tenant, and is refused on a dataset that has nothing to measure yet', async () => {
      const hidden = await newWorld({ classification: 'CONFIDENTIAL' });
      const input = draft(hidden, { code: 'R-HIDDEN' });
      expect(await refusal(as((tx) => rules.create(tx, input, viewer(READER)), READER))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id' });
      expect(await refusal(as((tx) => rules.create(tx, input, viewer(OTHER_TENANT_MEMBER)), OTHER_TENANT_MEMBER, TENANT_B))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id' });
      expect(await refusal(as((tx) => rules.create(tx, draft(hidden, { code: 'R-X', contractId: randomUUID() }), viewer(STEWARD))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id' });
      const pay = await newWorld({ producerModule: 'PAY' });
      expect(await refusal(as((tx) => rules.create(tx, draft(pay, { code: 'R-PAY' }), viewer(STEWARD))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id' });
      await owner("update machvon.dataset set status = 'RETIRED' where id = $1", [hidden.datasetId]);
      expect(await refusal(as((tx) => rules.create(tx, input, viewer(STEWARD))))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });
      await owner('update machvon.dataset_contract set dataset_id = null where id = $1', [pay.contractId]);
      expect(await refusal(as((tx) => rules.create(tx, draft(pay, { code: 'R-NONE' }), viewer(STEWARD))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id' });
    });

    it('is not approved by its author (403 SELF_APPROVAL_DENIED) but by another person (APPROVED) (AC-ST-DGV-002-3)', async () => {
      const world = await newWorld();
      const created = await as((tx) => rules.create(tx, draft(world, { code: 'R-COMPLETE', thresholdJson: { min_pass_rate_pct: '99.5' }, actionOnFail: 'HARD_BLOCK' }), viewer(STEWARD)));
      expect(await refusal(as((tx) => rules.approve(tx, created.id, 1, viewer(STEWARD))))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await owner<{ status: string }>('select status from machvon.quality_rule_version where id = $1', [created.id]))[0]?.status).toBe('DRAFT');
      const approved = await as((tx) => rules.approve(tx, created.id, 1, viewer(OWNER)), OWNER);
      expect(approved).toMatchObject({ id: created.id, datasetId: world.datasetId, contractId: world.contractId, code: 'R-COMPLETE', revision: 1, dimension: 'COMPLETENESS', author: memberId(STEWARD), version: 2, supersededIds: [] });
      expect(await owner('select status, approved_by, version::text from machvon.quality_rule_version where id = $1', [created.id])).toEqual([{ status: 'APPROVED', approved_by: memberId(OWNER), version: '2' }]);
    });

    it('is approved against the version that was read, once, and a stale or hidden or unknown rule is refused', async () => {
      const world = await newWorld();
      const created = await as((tx) => rules.create(tx, draft(world, { code: 'R-ONCE' }), viewer(STEWARD)));
      expect(await refusal(as((tx) => rules.approve(tx, created.id, 7, viewer(OWNER)), OWNER))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await as((tx) => rules.approve(tx, created.id, 1, viewer(OWNER)), OWNER);
      expect(await refusal(as((tx) => rules.approve(tx, created.id, 2, viewer(OWNER)), OWNER))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });
      expect(await refusal(as((tx) => rules.approve(tx, randomUUID(), 1, viewer(OWNER)), OWNER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => rules.approve(tx, created.id, 2, viewer(OTHER_TENANT_MEMBER)), OTHER_TENANT_MEMBER, TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const hidden = await newWorld({ classification: 'CONFIDENTIAL' });
      const secret = await as((tx) => rules.create(tx, draft(hidden, { code: 'R-SECRET' }), viewer(STEWARD)));
      expect(await refusal(as((tx) => rules.approve(tx, secret.id, 1, viewer(READER)), READER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('supersedes the version it replaces, and the older drafts, when a newer revision is approved; an older draft cannot be approved over a newer approved one', async () => {
      const world = await newWorld();
      const r1 = await approvedRule(world, { code: 'R-REV' });
      const r2 = await as((tx) => rules.create(tx, draft(world, { code: 'R-REV' }), viewer(STEWARD)));
      const r3 = await as((tx) => rules.create(tx, draft(world, { code: 'R-REV', thresholdJson: { min_pass_rate_pct: '90' } }), viewer(STEWARD)));
      const approvedThird = await as((tx) => rules.approve(tx, r3.id, 1, viewer(OWNER)), OWNER);
      expect(approvedThird.supersededIds).toEqual([r1, r2.id].sort());
      expect(await owner('select revision, status from machvon.quality_rule_version where contract_id = $1 order by revision', [world.contractId])).toEqual([
        { revision: 1, status: 'SUPERSEDED' },
        { revision: 2, status: 'SUPERSEDED' },
        { revision: 3, status: 'APPROVED' },
      ]);
      expect(await refusal(as((tx) => rules.approve(tx, r2.id, 2, viewer(OWNER)), OWNER))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });
      const fourth = await as((tx) => rules.create(tx, draft(world, { code: 'R-REV' }), viewer(STEWARD)));
      expect(fourth.revision).toBe(4);
      const approvedOfContract = await as((tx) => rules.approvedOfContract(tx, world.contractId));
      expect(approvedOfContract).toEqual([{ id: r3.id }]);
    });

    it('lists the rules of the visible datasets by code and revision, filtered by dataset and status, page by page', async () => {
      const world = await newWorld();
      const other = await newWorld();
      await approvedRule(world, { code: 'R-LIST-A' });
      const b1 = await as((tx) => rules.create(tx, draft(world, { code: 'R-LIST-B' }), viewer(STEWARD)));
      await as((tx) => rules.create(tx, draft(world, { code: 'R-LIST-B' }), viewer(STEWARD)));
      await as((tx) => rules.create(tx, draft(other, { code: 'R-LIST-A' }), viewer(STEWARD)));
      const page1 = await as((tx) => rules.list(tx, viewer(STEWARD), { datasetId: world.datasetId }, { limit: 2, after: undefined }));
      expect(page1.map((rule) => `${rule.code}#${rule.revision}`)).toEqual(['R-LIST-A#1', 'R-LIST-B#1']);
      expect(page1[0]).toMatchObject({ datasetCode: world.code, status: 'APPROVED', approvedBy: memberId(OWNER), approvedByName: 'User 2' });
      const last = page1[1];
      const page2 = await as((tx) => rules.list(tx, viewer(STEWARD), { datasetId: world.datasetId }, { limit: 5, after: { code: last?.listKey ?? '', id: last?.id ?? '' } }));
      expect(page2.map((rule) => `${rule.code}#${rule.revision}`)).toEqual(['R-LIST-B#2']);
      const drafts = await as((tx) => rules.list(tx, viewer(STEWARD), { datasetId: world.datasetId, status: 'DRAFT' }, { limit: 10, after: undefined }));
      expect(drafts.map((rule) => rule.id)).toContain(b1.id);
      expect(drafts.every((rule) => rule.status === 'DRAFT')).toBe(true);
      const hidden = await newWorld({ classification: 'CONFIDENTIAL' });
      await as((tx) => rules.create(tx, draft(hidden, { code: 'R-LIST-HIDDEN' }), viewer(STEWARD)));
      const forReader = await as((tx) => rules.list(tx, viewer(READER), {}, { limit: 200, after: undefined }), READER);
      expect(forReader.map((rule) => rule.code)).not.toContain('R-LIST-HIDDEN');
      expect(await as((tx) => rules.list(tx, viewer(OTHER_TENANT_MEMBER), {}, { limit: 200, after: undefined }), OTHER_TENANT_MEMBER, TENANT_B)).toEqual([]);
    });

    it('never changes once it is written: the database refuses an update of the definition, of an approval, of a superseded version, and a delete', async () => {
      const world = await newWorld();
      const id = await approvedRule(world, { code: 'R-FROZEN' });
      const attempt = (sql: string) => owner(sql, [id]).then(() => 'changed', (error: { message: string }) => error.message);
      expect(await attempt(`update machvon.quality_rule_version set expression_ast = '{"op":"raw_sql"}'::jsonb where id = $1`)).toContain('definition of a quality rule version never changes');
      expect(await attempt(`update machvon.quality_rule_version set threshold_json = '{"min_pass_rate_pct":"1"}'::jsonb where id = $1`)).toContain('never changes');
      expect(await attempt(`update machvon.quality_rule_version set status = 'DRAFT' where id = $1`)).toContain('keeps its approval');
      expect(await attempt(`update machvon.quality_rule_version set approved_by = created_by where id = $1`)).toMatch(/keeps its approval|violates check constraint/);
      expect(await attempt(`update machvon.quality_rule_version set status = 'SUPERSEDED' where id = $1`)).toBe('changed');
      expect(await attempt(`update machvon.quality_rule_version set version = version + 1 where id = $1`)).toContain('superseded quality rule version is never changed');
      const appPool = harness.appPool;
      await expect(appPool.query('delete from machvon.quality_rule_version where id = $1', [id])).rejects.toThrow(/permission denied/);
    });
  });

  describe('requesting a run (runQualityChecks)', () => {
    it('starts a RUNNING run that names the approved rule versions and the digest of the frozen snapshot it will read', async () => {
      const world = await newWorld();
      const a = await approvedRule(world, { code: 'R-A' });
      const b = await approvedRule(world, { code: 'R-B' });
      await as((tx) => rules.create(tx, draft(world, { code: 'R-C-DRAFT' }), viewer(STEWARD)));
      const snapshot = await newSnapshot();
      const started = await request(world, snapshot.id);
      expect(started).toMatchObject({ datasetId: world.datasetId, datasetCode: world.code, snapshotId: snapshot.id, ruleCount: 2, trigger: 'MANUAL' });
      const row = (await owner<{ status: string; rule_version_ids: string[]; snapshot_sha256: string; triggered_by: string; trigger: string; finished_at: string | null; attempts: number }>(
        'select status, rule_version_ids, snapshot_sha256, triggered_by, trigger, finished_at::text, attempts from machvon.quality_run where id = $1',
        [started.id],
      ))[0];
      expect(row).toMatchObject({ status: 'RUNNING', snapshot_sha256: snapshot.sha256, triggered_by: memberId(STEWARD), trigger: 'MANUAL', finished_at: null, attempts: 0 });
      expect([...(row?.rule_version_ids ?? [])].sort()).toEqual([a, b].sort());
    });

    it('answers 409 RUN_ALREADY_RUNNING for a second request on the snapshot while the first is running, and accepts one when it has finished (AC-ST-DGV-002-4)', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-A' });
      const snapshot = await newSnapshot();
      await request(world, snapshot.id);
      expect(await refusal(request(world, snapshot.id, OWNER, 'SCHEDULE'))).toEqual({ code: 'RUN_ALREADY_RUNNING', status: 409, detail: 'snapshot_id' });
      expect(Number((await owner<{ n: string }>("select count(*)::text as n from machvon.quality_run where dataset_id = $1 and snapshot_id = $2", [world.datasetId, snapshot.id]))[0]?.n)).toBe(1);
      const { job } = newJob();
      await drain(job);
      const again = await request(world, snapshot.id);
      expect(again.id).toBeDefined();
    });

    it('refuses a snapshot that does not exist (404 SNAPSHOT_NOT_FOUND), one that is not frozen (409), a contract the requester cannot see, a contract without approved rules, and a dataset without a source', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-A' });
      expect(await refusal(request(world, randomUUID()))).toEqual({ code: 'SNAPSHOT_NOT_FOUND', status: 404, detail: 'snapshot_id' });
      const building = await newSnapshot({ status: 'BUILDING' });
      expect(await refusal(request(world, building.id))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'snapshot_id' });
      const snapshot = await newSnapshot();
      expect(await refusal(as((tx) => runs.request(tx, { datasetContractId: randomUUID(), snapshotId: snapshot.id, trigger: 'MANUAL' }, viewer(STEWARD))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'dataset_contract_id' });
      const hidden = await newWorld({ classification: 'CONFIDENTIAL' });
      await approvedRule(hidden, { code: 'R-A' });
      expect(await refusal(request(hidden, snapshot.id, READER))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'dataset_contract_id' });
      expect(await refusal(request(hidden, snapshot.id, OTHER_TENANT_MEMBER))).toMatchObject({ code: 'VALIDATION_FAILED' });
      const bare = await newWorld();
      expect(await refusal(request(bare, snapshot.id))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'dataset_contract_id' });
      const pay = await newWorld({ producerModule: 'PAY' });
      expect(await refusal(request(pay, snapshot.id))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'dataset_contract_id' });
      await owner("update machvon.dataset set status = 'RETIRED' where id = $1", [world.datasetId]);
      expect(await refusal(request(world, snapshot.id))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'status' });
    });

    it('starts one run per dataset when the event that a snapshot was frozen is delivered, however often (AC-ST-DGV-002-4)', async () => {
      const first = await newWorld();
      const second = await newWorld();
      const withoutRules = await newWorld();
      const pay = await newWorld({ producerModule: 'PAY' });
      await approvedRule(first, { code: 'R-A' });
      await approvedRule(second, { code: 'R-A' });
      const snapshot = await newSnapshot();
      const started = await as((tx) => runs.requestForFrozenSnapshot(tx, snapshot.id, WORKER_MEMBERSHIP_ID));
      // A dataset without approved rules is not measured (it stays NOT_ASSESSED), nor is one whose module has no source of rows yet.
      // (The tenant has the datasets of the other tests too: every one with approved rules and a source is called for; look at these.)
      const own = [first.datasetId, second.datasetId, withoutRules.datasetId, pay.datasetId];
      expect(started.map((run) => run.datasetId).filter((id) => own.includes(id)).sort()).toEqual([first.datasetId, second.datasetId].sort());
      expect(started.map((run) => run.datasetId)).not.toContain(withoutRules.datasetId);
      expect(started.map((run) => run.datasetId)).not.toContain(pay.datasetId);
      expect(started.every((run) => run.trigger === 'SNAPSHOT_FROZEN')).toBe(true);
      const repeated = await as((tx) => runs.requestForFrozenSnapshot(tx, snapshot.id, WORKER_MEMBERSHIP_ID));
      expect(repeated).toEqual([]);
      const rows = await owner<{ dataset_id: string }>("select dataset_id from machvon.quality_run where snapshot_id = $1 and trigger = 'SNAPSHOT_FROZEN'", [snapshot.id]);
      expect(rows.filter((row) => row.dataset_id === first.datasetId)).toHaveLength(1);
      expect(rows.filter((row) => row.dataset_id === second.datasetId)).toHaveLength(1);
      expect(rows).toHaveLength(started.length);
      // After the runs have finished, the same event still starts nothing for the snapshot.
      await drain(newJob().job);
      expect(await as((tx) => runs.requestForFrozenSnapshot(tx, snapshot.id, WORKER_MEMBERSHIP_ID))).toEqual([]);
    });

    it('starts no run for a snapshot that is not frozen, that does not exist, or that is superseded', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-A' });
      const building = await newSnapshot({ status: 'BUILDING' });
      const superseded = await newSnapshot({ status: 'SUPERSEDED' });
      expect(await as((tx) => runs.requestForFrozenSnapshot(tx, building.id, WORKER_MEMBERSHIP_ID))).toEqual([]);
      expect(await as((tx) => runs.requestForFrozenSnapshot(tx, superseded.id, WORKER_MEMBERSHIP_ID))).toEqual([]);
      expect(await as((tx) => runs.requestForFrozenSnapshot(tx, randomUUID(), WORKER_MEMBERSHIP_ID))).toEqual([]);
    });

    it('lets a person run the rules on a superseded snapshot, whose rows are final too', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-A' });
      const superseded = await newSnapshot({ status: 'SUPERSEDED' });
      expect((await request(world, superseded.id)).snapshotId).toBe(superseded.id);
    });
  });

  describe('executing a run (the quality job)', () => {
    async function nineAndAnIntegrityFailure(): Promise<{ world: World; snapshotId: string; runId: string }> {
      const world = await newWorld({ isCritical: true });
      await approvedRule(world, { code: 'R-01-NOT-NULL', dimension: 'COMPLETENESS', expressionAst: { op: 'not_null', field: 'project_id' } });
      await approvedRule(world, { code: 'R-02-NOT-BLANK', dimension: 'COMPLETENESS', expressionAst: { op: 'not_blank', field: 'bucket' } });
      await approvedRule(world, { code: 'R-03-RATE', dimension: 'VALIDITY', expressionAst: { op: 'between', field: 'rate_total_pct', min: 0, max: 100 } });
      await approvedRule(world, { code: 'R-04-BUCKET', dimension: 'VALIDITY', expressionAst: { op: 'in', field: 'bucket', values: ['CURRENT_YEAR', 'CARRYOVER'] } });
      await approvedRule(world, { code: 'R-05-UNIQUE', dimension: 'UNIQUENESS', expressionAst: { op: 'unique', fields: ['project_id', 'bucket', 'budget_level'] } });
      await approvedRule(world, { code: 'R-06-SUBSET', dimension: 'CONSISTENCY', expressionAst: { op: 'compare_fields', left: 'ctmtqg_subset_vnd', cmp: 'lte', right: 'plan_total_vnd' } });
      await approvedRule(world, { code: 'R-07-AGE', dimension: 'TIMELINESS', expressionAst: { op: 'snapshot_age_within', seconds: 31_536_000 } });
      await approvedRule(world, { code: 'R-08-PLAN', dimension: 'VALIDITY', expressionAst: { op: 'compare', field: 'plan_total_vnd', cmp: 'gte', value: '0' } });
      await approvedRule(world, { code: 'R-09-UNIT', dimension: 'COMPLETENESS', expressionAst: { op: 'and', args: [{ op: 'not_null', field: 'unit_id' }, { op: 'not_null', field: 'treasury_coverage' }] } });
      await approvedRule(world, {
        code: 'R-10-FK-PROJECT',
        dimension: 'INTEGRITY',
        severity: 'MEDIUM',
        expressionAst: { op: 'reference_exists', field: 'project_id' },
        thresholdJson: { min_pass_rate_pct: '100' },
        actionOnFail: 'HARD_BLOCK',
      });
      const snapshot = await newSnapshot({ lines: [{}, {}, { project: 'dangling' }, { project: 'dangling' }] });
      const started = await request(world, snapshot.id);
      return { world, snapshotId: snapshot.id, runId: started.id };
    }

    it('is a hard fail with a score of about 95 and the verdict FAILED when nine rules pass and one integrity rule finds a reference to no project; a CRITICAL incident opens with a 4 hour SLA and the snapshot is blocked for certified figures (AC-ST-DGV-002-1)', async () => {
      const { world, snapshotId, runId } = await nineAndAnIntegrityFailure();
      const { job, metrics } = newJob();
      const summary = await drain(job);
      expect(summary.completed).toBeGreaterThanOrEqual(1);
      expect(await runRow(runId)).toMatchObject({ status: 'COMPLETED', overall_result: 'FAILED', score: '95.00', hard_fail: true, certified_blocked: true, failure_code: null, passed_count: '9', failed_count: '1', quarantined_count: '0', attempts: 1 });

      const results = await owner<{ code: string; result: string; evaluated_count: string; failed_count: string; measured_value: string | null; incident_id: string | null; sample_refs: Array<{ row_id: string }> }>(
        `select v.code, res.result, res.evaluated_count::text, res.failed_count::text, res.measured_value::text, res.incident_id, res.sample_refs
           from machvon.quality_rule_result res join machvon.quality_rule_version v on v.id = res.rule_version_id where res.run_id = $1 order by v.code`,
        [runId],
      );
      expect(results.map((r) => [r.code, r.result])).toEqual([
        ['R-01-NOT-NULL', 'PASS'], ['R-02-NOT-BLANK', 'PASS'], ['R-03-RATE', 'PASS'], ['R-04-BUCKET', 'PASS'], ['R-05-UNIQUE', 'PASS'],
        ['R-06-SUBSET', 'PASS'], ['R-07-AGE', 'PASS'], ['R-08-PLAN', 'PASS'], ['R-09-UNIT', 'PASS'], ['R-10-FK-PROJECT', 'FAIL'],
      ]);
      const failed = results[9];
      expect(failed).toMatchObject({ evaluated_count: '4', failed_count: '2', measured_value: '50.000000' });
      expect(failed?.sample_refs).toHaveLength(2);
      // Rows with no sample on the passing rules; the timeliness rule evaluates the snapshot itself (one).
      expect(results[0]?.sample_refs).toEqual([]);
      expect(results[6]?.evaluated_count).toBe('1');

      const incidents = await owner<{ id: string; severity: string; sla_hours: number; status: string; owner_id: string; run_id: string; dataset_version_id: string; title: string; in_hours: string }>(
        `select id, severity, sla_hours, status, owner_id, run_id, dataset_version_id, title, round(extract(epoch from (due_at - created_at)) / 3600)::text as in_hours from machvon.quality_incident where run_id = $1`,
        [runId],
      );
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ severity: 'CRITICAL', sla_hours: 4, status: 'OPEN', owner_id: memberId(OWNER), dataset_version_id: snapshotId, title: `${world.code} / R-10-FK-PROJECT`, in_hours: '4' });
      expect(failed?.incident_id).toBe(incidents[0]?.id);
      expect(await owner('select event_kind, to_status from machvon.quality_incident_event where incident_id = $1', [incidents[0]?.id])).toEqual([{ event_kind: 'CREATED', to_status: 'OPEN' }]);

      const events = await owner<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where aggregate_id in ($1, $2) order by type", [runId, incidents[0]?.id]);
      expect(events.map((event) => event.type)).toEqual(['dgv.incident.opened.v1', 'dgv.quality_run.completed.v1']);
      expect(events[1]?.payload).toEqual({ run_id: runId, dataset_id: world.datasetId, snapshot_id: snapshotId, overall_result: 'FAILED', score: '95.00', hard_fail: true, certified_blocked: true, quarantined_count: 0 });
      expect(events[0]?.payload).toMatchObject({ dataset_id: world.datasetId, run_id: runId, rule_code: 'R-10-FK-PROJECT', severity: 'CRITICAL' });
      const audit = await owner<{ action: string; actor_id: string }>("select action, actor_id from machvon.audit_event where resource_id in ($1, $2) order by action", [runId, incidents[0]?.id]);
      expect(audit).toEqual([
        { action: 'dgv.quality_incident_opened', actor_id: WORKER_MEMBERSHIP_ID },
        { action: 'dgv.quality_run_completed', actor_id: WORKER_MEMBERSHIP_ID },
      ]);
      const telemetry = metrics.snapshot();
      expect(telemetry.gauges).toContainEqual({ name: 'dgv_quality_score', value: 95, labels: { dataset: world.code } });
      expect(telemetry.counters).toContainEqual({ name: 'dgv_hard_fail_total', value: 1, labels: { dataset: world.code } });

      // The catalogue badge and the scorecard are the verdict of the run.
      const card = await as((tx) => runs.scorecard(tx, world.datasetId, viewer(STEWARD)));
      expect(card?.dataset).toMatchObject({ qualityBadge: 'FAILED', qualityScore: '95.00', qualityHardFail: true });
      expect(card?.latestRun).toMatchObject({ id: runId, overallResult: 'FAILED', score: '95.00', hardFail: true, certifiedBlocked: true, snapshotId, definitionStatus: 'PROPOSED_PENDING_SIGNOFF' });
      expect(card?.openIncidents).toBe(1);
      expect(card?.overdueIncidents).toBe(0);
      expect(card?.pendingAttempt).toBeNull();
      expect(card?.rules).toHaveLength(10);
      const integrity = card?.dimensions.find((dimension) => dimension.dimension === 'INTEGRITY');
      expect(integrity).toEqual({ dimension: 'INTEGRITY', assessed: true, score: '50.00', rulesTotal: 1, rulesFailed: 1 });
      // Accuracy has no rule: not assessed, and no score (not 0).
      expect(card?.dimensions.find((dimension) => dimension.dimension === 'ACCURACY')).toEqual({ dimension: 'ACCURACY', assessed: false, score: null, rulesTotal: 0, rulesFailed: 0 });
    });

    it('executes a run once: the job finds nothing to do afterwards and the results are not written twice', async () => {
      const { runId } = await nineAndAnIntegrityFailure();
      const { job } = newJob();
      await drain(job);
      const again = await drain(job);
      expect(again.completed).toBe(0);
      expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.quality_rule_result where run_id = $1', [runId]))[0]?.n)).toBe(10);
    });

    it('reuses the incident that is still open for the same rule of the dataset when a later run fails it again, and opens a new one once it is closed', async () => {
      const { world, runId } = await nineAndAnIntegrityFailure();
      await drain(newJob().job);
      const firstIncident = (await owner<{ id: string }>('select id from machvon.quality_incident where run_id = $1', [runId]))[0]?.id;
      const second = await newSnapshot({ lines: [{ project: 'dangling' }, {}] });
      const rerun = await request(world, second.id);
      await drain(newJob().job);
      expect(await owner('select count(*)::int as n from machvon.quality_incident where id in (select incident_id from machvon.quality_rule_result where run_id = $1)', [rerun.id])).toEqual([{ n: 1 }]);
      expect((await owner<{ incident_id: string }>("select incident_id from machvon.quality_rule_result res where run_id = $1 and incident_id is not null", [rerun.id]))[0]?.incident_id).toBe(firstIncident);
      expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.quality_incident where id = $1', [firstIncident]))[0]?.n)).toBe(1);

      // Closed the way the chain of ST-DGV-003 closes it: handled, resolved, verified by someone else.
      await owner(
        "update machvon.quality_incident set status = 'ASSIGNED', assignee_user_id = owner_id where id = $1",
        [firstIncident],
      );
      for (const step of ['ACKNOWLEDGED', 'IN_PROGRESS']) await owner('update machvon.quality_incident set status = $2 where id = $1', [firstIncident, step]);
      await owner("update machvon.quality_incident set status = 'RESOLVED_PENDING_VERIFICATION', root_cause = 'Cause written for the test.', remediation = 'Measure written for the test.', resolved_at = now() where id = $1", [firstIncident]);
      await owner("update machvon.quality_incident set status = 'CLOSED', verified_by = gen_random_uuid(), verified_at = now(), closed_at = now() where id = $1", [firstIncident]);
      const third = await newSnapshot({ lines: [{ project: 'dangling' }, {}] });
      const again = await request(world, third.id);
      await drain(newJob().job);
      const reopened = (await owner<{ incident_id: string }>('select incident_id from machvon.quality_rule_result where run_id = $1 and incident_id is not null', [again.id]))[0]?.incident_id;
      expect(reopened).toBeDefined();
      expect(reopened).not.toBe(firstIncident);
    });

    it('is PASSED with a score of 100.00 when every rule passes, and opens no incident', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-A', dimension: 'COMPLETENESS' });
      await approvedRule(world, { code: 'R-B', dimension: 'INTEGRITY', expressionAst: { op: 'reference_exists', field: 'project_id' }, actionOnFail: 'HARD_BLOCK' });
      const snapshot = await newSnapshot();
      const started = await request(world, snapshot.id);
      await drain(newJob().job);
      expect(await runRow(started.id)).toMatchObject({ status: 'COMPLETED', overall_result: 'PASSED', score: '100.00', hard_fail: false, certified_blocked: false });
      expect(await owner('select id from machvon.quality_incident where run_id = $1', [started.id])).toEqual([]);
      const card = await as((tx) => runs.scorecard(tx, world.datasetId, viewer(STEWARD)));
      expect(card?.dataset.qualityBadge).toBe('PASSED');
    });

    it('quarantines the failing rows of a QUARANTINE rule that does not pass, fails the run without a hard fail, and warns for a rule inside its warning band', async () => {
      const world = await newWorld({ isCritical: true });
      // 12 of 1000 would be 98.8 percent: here 1 of 4 lines has no treasury coverage value to check, so use a compare rule that fails one line of four.
      await approvedRule(world, { code: 'R-QUARANTINE', dimension: 'CONSISTENCY', expressionAst: { op: 'compare_fields', left: 'ctmtqg_subset_vnd', cmp: 'lte', right: 'plan_total_vnd' }, thresholdJson: { min_pass_rate_pct: '100' }, actionOnFail: 'QUARANTINE', severity: 'HIGH', criticalityWeight: 5 });
      await approvedRule(world, { code: 'R-WARN-BAND', dimension: 'VALIDITY', expressionAst: { op: 'compare', field: 'plan_total_vnd', cmp: 'gte', value: '1000' }, thresholdJson: { min_pass_rate_pct: '100', warn_pass_rate_pct: '70' }, actionOnFail: 'HARD_BLOCK' });
      await approvedRule(world, { code: 'R-WARN-ACTION', dimension: 'VALIDITY', expressionAst: { op: 'compare', field: 'plan_total_vnd', cmp: 'gte', value: '1000' }, thresholdJson: { min_pass_rate_pct: '100' }, actionOnFail: 'WARN' });
      const snapshot = await newSnapshot({ lines: [{ ctmtqg: '2000' }, {}, {}, { planTotal: '999', ctmtqg: '10' }] });
      const started = await request(world, snapshot.id);
      await drain(newJob().job);
      // R-QUARANTINE: line 1 breaks it, 3 of 4 pass (75 percent, weight 5); R-WARN-BAND: 3 of 4 pass (75, in the band 70 to 100, weight 1); R-WARN-ACTION: 75, weight 1.
      expect(await runRow(started.id)).toMatchObject({ status: 'COMPLETED', overall_result: 'FAILED', hard_fail: false, certified_blocked: false, passed_count: '0', failed_count: '1', quarantined_count: '1', score: '75.00' });
      const byCode = Object.fromEntries((await owner<{ code: string; result: string; quarantined_count: string; incident_id: string | null }>(
        'select v.code, res.result, res.quarantined_count::text, res.incident_id from machvon.quality_rule_result res join machvon.quality_rule_version v on v.id = res.rule_version_id where res.run_id = $1',
        [started.id],
      )).map((row) => [row.code, row]));
      expect(byCode['R-QUARANTINE']).toMatchObject({ result: 'FAIL', quarantined_count: '1' });
      expect(byCode['R-WARN-BAND']).toMatchObject({ result: 'WARN', quarantined_count: '0', incident_id: null });
      expect(byCode['R-WARN-ACTION']).toMatchObject({ result: 'WARN', incident_id: null });
      const incident = (await owner<{ severity: string; sla_hours: number }>('select severity, sla_hours from machvon.quality_incident where run_id = $1', [started.id]))[0];
      expect(incident).toEqual({ severity: 'HIGH', sla_hours: 24 });
    });

    it('blocks certified figures on a failed HARD_BLOCK rule of a plain dataset without making it a hard fail', async () => {
      const world = await newWorld({ isCritical: false });
      await approvedRule(world, { code: 'R-BLOCK', dimension: 'CONSISTENCY', expressionAst: { op: 'compare_fields', left: 'ctmtqg_subset_vnd', cmp: 'lte', right: 'plan_total_vnd' }, actionOnFail: 'HARD_BLOCK' });
      const snapshot = await newSnapshot({ lines: [{ ctmtqg: '2000' }, {}] });
      const started = await request(world, snapshot.id);
      await drain(newJob().job);
      expect(await runRow(started.id)).toMatchObject({ overall_result: 'FAILED', hard_fail: false, certified_blocked: true, score: '50.00' });
    });

    it('reads the rows of one snapshot only, and a rule that finds nothing to evaluate is ERROR and never a pass: the run FAILED to be measured has no verdict', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-EMPTY', dimension: 'COMPLETENESS' });
      const snapshot = await newSnapshot({ lines: [] });
      const started = await request(world, snapshot.id);
      await drain(newJob().job);
      expect(await runRow(started.id)).toMatchObject({ status: 'FAILED', overall_result: null, score: null, failure_code: 'NO_RULE_MEASURED', hard_fail: false, certified_blocked: false });
      expect(await owner('select result, error_code, measured_value::text from machvon.quality_rule_result where run_id = $1', [started.id])).toEqual([{ result: 'ERROR', error_code: 'NO_ROWS_EVALUATED', measured_value: null }]);
      // A failed run is no result: the dataset is still NOT_ASSESSED, with no score, and the scorecard says what was attempted.
      const card = await as((tx) => runs.scorecard(tx, world.datasetId, viewer(STEWARD)));
      expect(card?.dataset).toMatchObject({ qualityBadge: 'NOT_ASSESSED', qualityScore: null, qualityHardFail: null, qualityRunAt: null });
      expect(card?.latestRun).toBeNull();
      expect(card?.pendingAttempt).toMatchObject({ id: started.id, status: 'FAILED', failureCode: 'NO_RULE_MEASURED' });
      expect(card?.ageSeconds).toBeNull();
    });

    it('keeps a rule that cannot be evaluated as an ERROR result, measures the others, and never lets the run read PASSED', async () => {
      const world = await newWorld();
      const broken = await approvedRule(world, { code: 'R-BROKEN', dimension: 'COMPLETENESS' });
      await approvedRule(world, { code: 'R-FINE', dimension: 'COMPLETENESS', expressionAst: { op: 'not_null', field: 'unit_id' } });
      await owner('alter table machvon.quality_rule_version disable trigger quality_rule_version_update_guard');
      await owner(`update machvon.quality_rule_version set expression_ast = '{"op":"raw_sql","sql":"select 1"}'::jsonb where id = $1`, [broken]);
      await owner('alter table machvon.quality_rule_version enable trigger quality_rule_version_update_guard');
      const snapshot = await newSnapshot();
      const started = await request(world, snapshot.id);
      await drain(newJob().job);
      expect(await runRow(started.id)).toMatchObject({ status: 'COMPLETED', overall_result: 'WARNING', score: '100.00', hard_fail: false });
      const results = await owner<{ code: string; result: string; error_code: string | null }>(
        'select v.code, res.result, res.error_code from machvon.quality_rule_result res join machvon.quality_rule_version v on v.id = res.rule_version_id where res.run_id = $1 order by v.code',
        [started.id],
      );
      expect(results).toEqual([
        { code: 'R-BROKEN', result: 'ERROR', error_code: 'EVALUATION_FAILED' },
        { code: 'R-FINE', result: 'PASS', error_code: null },
      ]);
    });

    it('does not measure a snapshot that is no longer the frozen one that was asked for (SNAPSHOT_CHANGED) or whose rows are not all there (SNAPSHOT_INCOMPLETE)', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-A' });
      const changed = await newSnapshot();
      const incomplete = await newSnapshot();
      const requestedChanged = await request(world, changed.id);
      const requestedIncomplete = await request(world, incomplete.id);
      // The table keeps a frozen snapshot as it was: what a tampering would do is simulated with its guard switched off.
      await tamper("update machvon.period_snapshot set payload_sha256 = repeat('f', 64) where id = $1", [changed.id]);
      await tamper('update machvon.period_snapshot set row_count = row_count + 3 where id = $1', [incomplete.id]);
      await drain(newJob().job);
      expect(await runRow(requestedChanged.id)).toMatchObject({ status: 'FAILED', failure_code: 'SNAPSHOT_CHANGED', overall_result: null, score: null });
      expect(await runRow(requestedIncomplete.id)).toMatchObject({ status: 'FAILED', failure_code: 'SNAPSHOT_INCOMPLETE', overall_result: null, score: null });
      expect(await owner('select action from machvon.audit_event where resource_id = $1', [requestedChanged.id])).toEqual([{ action: 'dgv.quality_run_failed' }]);
      expect(await owner('select id from machvon.quality_rule_result where run_id in ($1, $2)', [requestedChanged.id, requestedIncomplete.id])).toEqual([]);
      // A snapshot that is no longer frozen at all is the same refusal.
      const gone = await newSnapshot();
      const requestedGone = await request(world, gone.id);
      await tamper("update machvon.period_snapshot set status = 'FAILED', payload_sha256 = null, frozen_at = null, frozen_by = null where id = $1", [gone.id]);
      await drain(newJob().job);
      expect(await runRow(requestedGone.id)).toMatchObject({ status: 'FAILED', failure_code: 'SNAPSHOT_CHANGED' });
    });

    it('finishes a run whose dataset has no source as SOURCE_NOT_SUPPORTED, and a run that keeps failing to execute as EXECUTION_FAILED after five attempts', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-A' });
      const snapshot = await newSnapshot();
      const started = await request(world, snapshot.id);
      await owner("update machvon.dataset set producer_module = 'PAY' where id = $1", [world.datasetId]);
      await drain(newJob().job);
      expect(await runRow(started.id)).toMatchObject({ status: 'FAILED', failure_code: 'SOURCE_NOT_SUPPORTED' });

      const tired = await newWorld();
      await approvedRule(tired, { code: 'R-A' });
      const again = await request(tired, snapshot.id);
      await owner('update machvon.quality_run set attempts = $2 where id = $1', [again.id, MAX_RUN_ATTEMPTS]);
      await drain(newJob().job);
      expect(await runRow(again.id)).toMatchObject({ status: 'FAILED', failure_code: 'EXECUTION_FAILED', attempts: MAX_RUN_ATTEMPTS + 1 });
    });

    it('counts a run that throws, leaves it RUNNING to be taken up again, and reports it after the others have been executed', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-A' });
      const good = await request(world, (await newSnapshot()).id);
      const poisoned = await newWorld();
      await approvedRule(poisoned, { code: 'R-A' });
      const bad = await request(poisoned, (await newSnapshot()).id);
      // A rule version that no longer exists makes the execution throw on the audit/outbox step: break the run's dataset reference instead.
      await owner('alter table machvon.quality_run disable trigger quality_run_update_guard');
      await owner(`update machvon.quality_run set rule_version_ids = '["not-a-uuid"]'::jsonb where id = $1`, [bad.id]);
      await owner('alter table machvon.quality_run enable trigger quality_run_update_guard');
      const { job } = newJob();
      await expect(drain(job)).rejects.toBeInstanceOf(QualityRunsBroken);
      expect(await runRow(good.id)).toMatchObject({ status: 'COMPLETED' });
      expect(await runRow(bad.id)).toMatchObject({ status: 'RUNNING', attempts: 1 });
      await expect(drain(job)).rejects.toThrow('1 quality run(s) could not be executed');
      expect((await runRow(bad.id))?.attempts).toBe(2);
      // The run is removed so that it does not break the passes of the tests that follow (the runtime role cannot delete a run; the owner can).
      await owner('delete from machvon.quality_run where id = $1', [bad.id]);
    });

    it('never changes a finished run or one of its results, and cannot delete them', async () => {
      const { runId } = await nineAndAnIntegrityFailure();
      await drain(newJob().job);
      const attempt = (sql: string, params: unknown[]) => owner(sql, params).then(() => 'changed', (error: { message: string }) => error.message);
      expect(await attempt("update machvon.quality_run set score = 1 where id = $1", [runId])).toContain('finished quality run is never changed');
      expect(await attempt('update machvon.quality_rule_result set result = $2 where run_id = $1', [runId, 'PASS'])).toContain('never changed or removed');
      expect(await attempt('delete from machvon.quality_rule_result where run_id = $1', [runId])).toContain('never changed or removed');
      await expect(harness.appPool.query('delete from machvon.quality_run where id = $1', [runId])).rejects.toThrow(/permission denied/);
      await expect(harness.appPool.query('truncate machvon.quality_rule_result')).rejects.toThrow(/permission denied/);
      const waiting = await newWorld();
      await approvedRule(waiting, { code: 'R-A' });
      const running = await request(waiting, (await newSnapshot()).id);
      expect(await attempt("update machvon.quality_run set snapshot_id = $2 where id = $1", [running.id, randomUUID()])).toContain('keeps its dataset, contract, snapshot');
    });

    it('refuses at the database what a run must not be: a verdict without a score, a hard fail that is not FAILED, a finished run without a finish', async () => {
      const world = await newWorld();
      await approvedRule(world, { code: 'R-A' });
      const running = await request(world, (await newSnapshot()).id);
      const attempt = (sql: string) => owner(sql, [running.id]).then(() => 'changed', (error: { message: string }) => error.message);
      expect(await attempt("update machvon.quality_run set status = 'COMPLETED', finished_at = now(), overall_result = 'PASSED' where id = $1")).toContain('quality_run_state_chk');
      expect(await attempt("update machvon.quality_run set status = 'COMPLETED', finished_at = now(), overall_result = 'PASSED', score = 99, hard_fail = true, certified_blocked = true where id = $1")).toContain('quality_run_hard_fail_chk');
      expect(await attempt("update machvon.quality_run set status = 'FAILED', finished_at = now() where id = $1")).toContain('quality_run_state_chk');
      expect(await attempt("update machvon.quality_run set status = 'COMPLETED', overall_result = 'PASSED', score = 99 where id = $1")).toContain('quality_run_state_chk');
      expect(await attempt("update machvon.quality_run set failure_code = 'NO_SUCH_CODE' where id = $1")).toContain('quality_run_failure_code_chk');
    });
  });

  describe('the scorecard and the catalogue badge (BR-DGV-01, BR-DGV-04)', () => {
    /** A finished run of the dataset, finished `ageHours` ago with the given verdict and score. */
    const finishedRun = (world: World, ageHours: number, overall: 'PASSED' | 'WARNING' | 'FAILED', score: string, hardFail = false): Promise<string> =>
      seedFinishedRun(harness, TENANT_A, { datasetId: world.datasetId, contractId: world.contractId, ageHours, overall, score, hardFail });

    it('shows NOT_ASSESSED with no score for a dataset that has no run, and STALE with its age for a run older than the freshness SLO; the average leaves the unassessed dataset out (AC-ST-DGV-002-2)', async () => {
      const never = await newWorld({ freshness: 86_400 });
      const stale = await newWorld({ freshness: 86_400 });
      const fresh = await newWorld({ freshness: 86_400 });
      await finishedRun(stale, 48, 'PASSED', '80.00');
      await finishedRun(fresh, 1, 'PASSED', '90.00');

      const neverCard = await as((tx) => runs.scorecard(tx, never.datasetId, viewer(STEWARD)));
      expect(neverCard).toMatchObject({ latestRun: null, pendingAttempt: null, rules: [], openIncidents: 0, overdueIncidents: 0, ageSeconds: null });
      expect(neverCard?.dataset).toMatchObject({ qualityBadge: 'NOT_ASSESSED', qualityScore: null, qualityHardFail: null, qualityRunAt: null });
      expect(neverCard?.dimensions.every((dimension) => !dimension.assessed && dimension.score === null)).toBe(true);

      const staleCard = await as((tx) => runs.scorecard(tx, stale.datasetId, viewer(STEWARD)));
      expect(staleCard?.dataset).toMatchObject({ qualityBadge: 'STALE', qualityScore: '80.00', freshnessSloSeconds: 86_400 });
      expect(staleCard?.ageSeconds).toBeGreaterThanOrEqual(2 * 86_400 - 5);
      expect(staleCard?.ageSeconds).toBeLessThan(2 * 86_400 + 600);
      expect((await as((tx) => runs.scorecard(tx, fresh.datasetId, viewer(STEWARD))))?.dataset.qualityBadge).toBe('PASSED');

      // The summary of a single dataset (found by its own code) carries its badge: the unassessed one is counted as such and has no average.
      expect(await as((tx) => datasets.summarize(tx, viewer(STEWARD), { query: never.code }))).toEqual({ total: 1, notAssessed: 1, passed: 0, warning: 0, failed: 0, stale: 0, hardFail: 0, openIncidents: 0, overdueIncidents: 0, averageScore: null });
      expect(await as((tx) => datasets.summarize(tx, viewer(STEWARD), { query: stale.code }))).toEqual({ total: 1, notAssessed: 0, passed: 0, warning: 0, failed: 0, stale: 1, hardFail: 0, openIncidents: 0, overdueIncidents: 0, averageScore: '80.00' });
    });

    it('averages only the datasets that have a score, truncated to hundredths, and counts the hard fails and each badge', async () => {
      const unique = `AVG-${randomUUID().slice(0, 6)}`;
      const make = async (score: string | null, overall: 'PASSED' | 'WARNING' | 'FAILED', hardFail = false, ageHours = 1): Promise<World> => {
        const world = await newWorld();
        await owner('update machvon.dataset set domain = $2 where id = $1', [world.datasetId, unique]);
        if (score !== null) await finishedRun(world, ageHours, overall, score, hardFail);
        return world;
      };
      await make('95.00', 'FAILED', true);
      await make('90.01', 'PASSED');
      await make('80.00', 'WARNING');
      await make('70.00', 'PASSED', false, 72);
      await make(null, 'PASSED');
      const summary = await as((tx) => datasets.summarize(tx, viewer(STEWARD), { domain: unique }));
      expect(summary).toEqual({ total: 5, notAssessed: 1, passed: 1, warning: 1, failed: 1, stale: 1, hardFail: 1, openIncidents: 0, overdueIncidents: 0, averageScore: '83.75' });
      const none = await as((tx) => datasets.summarize(tx, viewer(STEWARD), { domain: 'NO-SUCH-DOMAIN' }));
      expect(none).toEqual({ total: 0, notAssessed: 0, passed: 0, warning: 0, failed: 0, stale: 0, hardFail: 0, openIncidents: 0, overdueIncidents: 0, averageScore: null });
    });

    it('does not show the scorecard, the runs or the counts of a dataset the viewer may not see, nor anything of another tenant', async () => {
      const world = await newWorld({ classification: 'CONFIDENTIAL' });
      const runId = await finishedRun(world, 1, 'PASSED', '99.00');
      expect(await as((tx) => runs.scorecard(tx, world.datasetId, viewer(READER)), READER)).toBeUndefined();
      expect(await as((tx) => runs.find(tx, runId, viewer(READER)), READER)).toBeUndefined();
      expect((await as((tx) => runs.list(tx, viewer(READER), {}, { limit: 200, after: undefined }), READER)).map((run) => run.id)).not.toContain(runId);
      expect(await as((tx) => runs.scorecard(tx, world.datasetId, viewer(OTHER_TENANT_MEMBER)), OTHER_TENANT_MEMBER, TENANT_B)).toBeUndefined();
      expect(await as((tx) => runs.find(tx, runId, viewer(OTHER_TENANT_MEMBER)), OTHER_TENANT_MEMBER, TENANT_B)).toBeUndefined();
      expect(await as((tx) => runs.scorecard(tx, randomUUID(), viewer(STEWARD)))).toBeUndefined();
      // The owner, the steward and a role the dataset names do see it.
      expect((await as((tx) => runs.scorecard(tx, world.datasetId, viewer(OWNER)), OWNER))?.dataset.qualityBadge).toBe('PASSED');
      await owner("update machvon.dataset set allowed_role_codes = '{LND}' where id = $1", [world.datasetId]);
      expect((await as((tx) => runs.scorecard(tx, world.datasetId, viewer(READER, 'LND')), READER))?.latestRun?.id).toBe(runId);
    });

    it('lists the runs of the visible datasets newest first, filtered by dataset and status, page by page', async () => {
      const world = await newWorld();
      const older = await finishedRun(world, 5, 'PASSED', '90.00');
      const newer = await finishedRun(world, 2, 'WARNING', '80.00');
      await approvedRule(world, { code: 'R-A' });
      const running = await request(world, (await newSnapshot()).id);
      const all = await as((tx) => runs.list(tx, viewer(STEWARD), { datasetId: world.datasetId }, { limit: 10, after: undefined }));
      expect(all.map((run) => run.id)).toEqual([running.id, newer, older]);
      expect(all[0]).toMatchObject({ status: 'RUNNING', score: null, overallResult: null, finishedAt: null, datasetCode: world.code, trigger: 'MANUAL', ruleCount: 1, triggeredBy: memberId(STEWARD) });
      expect(all[1]).toMatchObject({ status: 'COMPLETED', overallResult: 'WARNING', score: '80.00', hardFail: false });
      const page1 = await as((tx) => runs.list(tx, viewer(STEWARD), { datasetId: world.datasetId }, { limit: 2, after: undefined }));
      const last = page1[1];
      const page2 = await as((tx) => runs.list(tx, viewer(STEWARD), { datasetId: world.datasetId }, { limit: 2, after: { code: last?.startedKey ?? '', id: last?.id ?? '' } }));
      expect(page2.map((run) => run.id)).toEqual([older]);
      expect((await as((tx) => runs.list(tx, viewer(STEWARD), { datasetId: world.datasetId, status: 'RUNNING' }, { limit: 10, after: undefined }))).map((run) => run.id)).toEqual([running.id]);
      expect((await as((tx) => runs.find(tx, newer, viewer(STEWARD))))?.id).toBe(newer);
      expect(await as((tx) => runs.find(tx, randomUUID(), viewer(STEWARD)))).toBeUndefined();
    });

    it('shows a run that is still RUNNING, or that could not be measured, next to the latest result without taking its place', async () => {
      const world = await newWorld();
      await finishedRun(world, 1, 'PASSED', '97.00');
      await approvedRule(world, { code: 'R-A' });
      const running = await request(world, (await newSnapshot()).id);
      const card = await as((tx) => runs.scorecard(tx, world.datasetId, viewer(STEWARD)));
      expect(card?.dataset).toMatchObject({ qualityBadge: 'PASSED', qualityScore: '97.00' });
      expect(card?.pendingAttempt).toMatchObject({ id: running.id, status: 'RUNNING' });
    });

    it('offers the working contract of the dataset in the catalogue: its highest revision', async () => {
      const world = await newWorld();
      const second = randomUUID();
      await owner(
        `insert into machvon.dataset_contract (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id)
         values ($1, $2, $3, 2, $4, '{}'::jsonb, '{}'::jsonb, 86400, 'INTERNAL', 'DRAFT', $5)`,
        [TENANT_A, second, world.code, memberId(OWNER), world.datasetId],
      );
      expect((await as((tx) => datasets.find(tx, world.datasetId, viewer(STEWARD))))?.workingContractId).toBe(second);
      const bare = await as((tx) => datasets.register(tx, { datasetCode: `DS-BARE-${randomUUID().slice(0, 5)}`, title: 'No contract', domain: 'X', grain: 'g', producerModule: 'DIS', ownerId: memberId(OWNER), stewardId: memberId(STEWARD), classification: 'INTERNAL', isCritical: false, freshnessSloSeconds: 60 }, memberId(STEWARD)));
      expect((await as((tx) => datasets.find(tx, bare.id, viewer(STEWARD))))?.workingContractId).toBeNull();
    });
  });

  describe('the source of the rows (the lines of a DIS period snapshot)', () => {
    it('is the source of the datasets that the DIS module produces and of none else yet', () => {
      expect(qualitySourceOf('DIS')).toBe(DIS_PERIOD_SNAPSHOT_SOURCE);
      expect(qualitySourceOf('PAY')).toBeUndefined();
    });

    it('reads the state of a snapshot and counts its lines, and knows no snapshot of another tenant', async () => {
      const snapshot = await newSnapshot({ lines: [{}, {}, {}] });
      const state = await as((tx) => loadSnapshot(tx, DIS_PERIOD_SNAPSHOT_SOURCE, snapshot.id));
      expect(state).toMatchObject({ id: snapshot.id, status: 'FROZEN', payloadSha256: snapshot.sha256, rowCount: 3, definitionStatus: 'PROPOSED_PENDING_SIGNOFF' });
      expect(state?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(await as((tx) => countSnapshotRows(tx, DIS_PERIOD_SNAPSHOT_SOURCE, snapshot.id))).toBe(3);
      expect(await as((tx) => loadSnapshot(tx, DIS_PERIOD_SNAPSHOT_SOURCE, snapshot.id), OTHER_TENANT_MEMBER, TENANT_B)).toBeUndefined();
      expect(await as((tx) => countSnapshotRows(tx, DIS_PERIOD_SNAPSHOT_SOURCE, snapshot.id), OTHER_TENANT_MEMBER, TENANT_B)).toBe(0);
      expect(await as((tx) => loadSnapshot(tx, DIS_PERIOD_SNAPSHOT_SOURCE, randomUUID()))).toBeUndefined();
    });

    it('counts what an expression passes and fails, with the ids of the failing rows, for each operator', async () => {
      const snapshot = await newSnapshot({
        lines: [
          { bucket: 'CURRENT_YEAR', planTotal: '100', ctmtqg: '50', rateTotal: '10' },
          { bucket: 'CURRENT_YEAR', planTotal: '200', ctmtqg: '300', rateTotal: '120' },
          { bucket: 'OTHER', planTotal: '300', ctmtqg: '300', rateTotal: null },
          { bucket: 'CARRYOVER', planTotal: '400', ctmtqg: '0', rateTotal: '100', project: 'dangling' },
        ],
      });
      const evaluate = (dimension: Parameters<typeof evaluateExpression>[2], ast: unknown) => as((tx) => evaluateExpression(tx, DIS_PERIOD_SNAPSHOT_SOURCE, dimension, ast, snapshot.id));
      const counts = async (dimension: Parameters<typeof evaluateExpression>[2], ast: unknown): Promise<[number, number, number, number]> => {
        const result = await evaluate(dimension, ast);
        return [result.evaluated, result.passed, result.failed, result.sampleIds.length];
      };
      expect(await counts('COMPLETENESS', { op: 'not_null', field: 'rate_total_pct' })).toEqual([4, 3, 1, 1]);
      expect(await counts('COMPLETENESS', { op: 'not_blank', field: 'rate_null_reason' })).toEqual([4, 1, 3, 3]);
      expect(await counts('VALIDITY', { op: 'between', field: 'rate_total_pct', min: 0, max: 100 })).toEqual([4, 2, 2, 2]);
      expect(await counts('VALIDITY', { op: 'or', args: [{ op: 'is_null', field: 'rate_total_pct' }, { op: 'between', field: 'rate_total_pct', min: 0, max: 100 }] })).toEqual([4, 3, 1, 1]);
      expect(await counts('VALIDITY', { op: 'not', arg: { op: 'in', field: 'bucket', values: ['OTHER'] } })).toEqual([4, 3, 1, 1]);
      expect(await counts('VALIDITY', { op: 'compare', field: 'bucket', cmp: 'ne', value: 'OTHER' })).toEqual([4, 3, 1, 1]);
      expect(await counts('VALIDITY', { op: 'compare', field: 'plan_total_vnd', cmp: 'gt', value: '100.5' })).toEqual([4, 3, 1, 1]);
      expect(await counts('CONSISTENCY', { op: 'compare_fields', left: 'ctmtqg_subset_vnd', cmp: 'lte', right: 'plan_total_vnd' })).toEqual([4, 3, 1, 1]);
      expect(await counts('UNIQUENESS', { op: 'unique', fields: ['bucket'] })).toEqual([4, 2, 2, 2]);
      expect(await counts('UNIQUENESS', { op: 'unique', fields: ['project_id', 'bucket'] })).toEqual([4, 4, 0, 0]);
      expect(await counts('INTEGRITY', { op: 'reference_exists', field: 'project_id' })).toEqual([4, 3, 1, 1]);
      expect(await counts('INTEGRITY', { op: 'reference_exists', field: 'report_revision_id' })).toEqual([4, 4, 0, 0]);
      expect(await counts('TIMELINESS', { op: 'snapshot_age_within', seconds: 3600 })).toEqual([1, 1, 0, 0]);
      const old = await newSnapshot({ asOfAt: '2020-01-01T00:00:00Z' });
      const aged = await as((tx) => evaluateExpression(tx, DIS_PERIOD_SNAPSHOT_SOURCE, 'TIMELINESS', { op: 'snapshot_age_within', seconds: 3600 }, old.id));
      expect([aged.evaluated, aged.passed, aged.failed]).toEqual([1, 0, 1]);
      const failing = await evaluate('INTEGRITY', { op: 'reference_exists', field: 'project_id' });
      expect(failing.sampleIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('measures a uniqueness rule over a key with an absent value as passing for that row, and refuses an expression the rule engine does not allow', async () => {
      const snapshot = await newSnapshot({ lines: [{ rateTotal: null }, { rateTotal: null }, { rateTotal: '5' }] });
      const result = await as((tx) => evaluateExpression(tx, DIS_PERIOD_SNAPSHOT_SOURCE, 'UNIQUENESS', { op: 'unique', fields: ['rate_total_pct'] }, snapshot.id));
      expect([result.evaluated, result.passed, result.failed]).toEqual([3, 3, 0]);
      expect(await refusal(as((tx) => evaluateExpression(tx, DIS_PERIOD_SNAPSHOT_SOURCE, 'COMPLETENESS', { op: 'raw_sql', sql: 'select 1' }, snapshot.id)))).toEqual({
        code: 'EXPRESSION_NOT_ALLOWED',
        status: 422,
        detail: 'expression_ast',
      });
    });
  });
});
