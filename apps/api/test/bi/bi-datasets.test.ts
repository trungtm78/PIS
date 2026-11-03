import { randomUUID } from 'node:crypto';
import { BiDatasetStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { TenantDatabase, TenantTx } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import { DatasetBuildConsumer } from '../../src/modules/bi/dataset.consumer';
import { BUILDER, BiApp, DATASET, NOBODY, QUERIER, READER, SIGNING_KEY, TENANT_A, TENANT_B, contextFor, memberId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(120_000);

const app = new BiApp();
let counter = 0;
const SNAPSHOT_FROZEN = 'snapshot.frozen.v1';
const RUN_COMPLETED = 'dgv.quality_run.completed.v1';

interface Snapshot {
  id: string;
  periodId: string;
  code: string;
}

/** A reporting period and a snapshot of it (a frozen close snapshot unless said otherwise); the rows of DIS get the few columns BI reads. */
async function snapshot(options: { code?: string; kind?: string; status?: string; sha?: string; rows?: number; frozenAt?: string; periodId?: string; tenant?: string } = {}): Promise<Snapshot> {
  counter += 1;
  const code = options.code ?? `2026-${String(counter).padStart(2, '0')}`;
  const periodId = options.periodId ?? randomUUID();
  const id = randomUUID();
  const tenant = options.tenant ?? TENANT_A;
  const status = options.status ?? 'FROZEN';
  const statements: Array<[string, unknown[]]> = [];
  if (options.periodId === undefined) {
    statements.push([
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2026-01-01' + $6::int * 40, date '2026-01-01' + $6::int * 40 + 30, now(), 'DEFAULT', 'MONTH', 2026, 'OPEN', $4, $5, $5)`,
      [tenant, periodId, code, randomUUID(), WORKER_MEMBERSHIP_ID, counter],
    ]);
  }
  statements.push([
    `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
     values ($1, $2, $3, $4, now(), date '2026-10-31', date '2026-10-31', $5, 'DIS-METRICS-R1', 'SIGNED', $6, $7, $8::uuid, $9::timestamptz, $10::uuid, $10::uuid)`,
    [tenant, id, periodId, options.kind ?? 'PERIOD_CLOSE', status, options.rows ?? 100, status === 'FROZEN' || status === 'SUPERSEDED' ? (options.sha ?? 'a'.repeat(64)) : null, status === 'FROZEN' || status === 'SUPERSEDED' ? WORKER_MEMBERSHIP_ID : null, status === 'FROZEN' || status === 'SUPERSEDED' ? (options.frozenAt ?? new Date().toISOString()) : null, WORKER_MEMBERSHIP_ID],
  ]);
  await app.seedReplica(statements);
  return { id, periodId, code };
}

/** The dataset DGV keeps for the producer DIS, and a quality run of a snapshot with the verdict given. */
const DGV_DATASET = '00000000-0000-4000-8000-0000000000e1';
async function dgvDataset(): Promise<void> {
  await app.seedReplica([
    [
      `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
       values ($1, $2, 'DS-DGV-DIS', 'DIS snapshot', 'DISBURSEMENT', 'project', 'DIS', $3, $3, 'INTERNAL', false, 3600, 'ACTIVE', $3, $3) on conflict do nothing`,
      [TENANT_A, DGV_DATASET, WORKER_MEMBERSHIP_ID],
    ],
  ]);
}
async function qualityRun(snapshotId: string, options: { status?: string; overall?: string | null; quarantined?: number; blocked?: boolean; sha?: string; finishedAt?: string } = {}): Promise<string> {
  const id = randomUUID();
  const status = options.status ?? 'COMPLETED';
  const finished = status === 'RUNNING' ? null : (options.finishedAt ?? new Date().toISOString());
  await app.seedReplica([
    [
      `insert into machvon.quality_run (tenant_id, id, dataset_contract_id, snapshot_id, rule_version_ids, passed_count, failed_count, quarantined_count, started_at, finished_at, dataset_id, trigger, status, overall_result, score, hard_fail, certified_blocked, snapshot_sha256, failure_code)
       values ($1, $2, $3, $4, jsonb_build_array(($2::uuid)::text), 1, 0, $5, now(), $6::timestamptz, $7, 'MANUAL', $8, $9, $10::numeric, false, $11, $12, $13)`,
      [
        TENANT_A, id, randomUUID(), snapshotId, options.quarantined ?? 0, finished, DGV_DATASET, status,
        status === 'COMPLETED' ? (options.overall ?? 'PASSED') : null, status === 'COMPLETED' ? 90 : null, options.blocked ?? false, options.sha ?? 'a'.repeat(64), status === 'FAILED' ? 'EXECUTION_FAILED' : null,
      ],
    ],
  ]);
  return id;
}

const build = (body: Record<string, unknown>, member = BUILDER, datasetId = DATASET, tenantId?: string): Promise<Reply> =>
  app.call('POST', `/bi/datasets/${datasetId}/versions`, { member, body, ...(tenantId === undefined ? {} : { tenantId }) });
const versions = (query = '', member = QUERIER, datasetId = DATASET, tenantId?: string): Promise<Reply> =>
  app.call('GET', `/bi/datasets/${datasetId}/versions${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
const rows = (sql: string, params: unknown[] = []) => app.harness.owner<Record<string, unknown>>(TENANT_A, [[sql, params]]);

/** The consumer as the worker runs it: a delivery signed for the tenant by the worker. */
const consumer = () => new DatasetBuildConsumer({ database: app.harness.tenants as never, security: { signingKey: SIGNING_KEY } });
const delivery = (type: string, payload: Record<string, unknown>, id = randomUUID(), tenantId = TENANT_A) => ({
  id,
  tenantId,
  tenantContext: signTenantContext({ tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
  type,
  payload,
});

describe('the versions of the datasets by period (ST-BI-002, BI F2)', () => {
  beforeAll(async () => {
    await app.start();
    await dgvDataset();
  }, 240_000);
  afterAll(() => app.stop(), 60_000);
  beforeEach(async () => {
    // The snapshots of DIS are kept for good, so the fixtures are removed with the triggers off.
    await app.seedReplica([['delete from machvon.bi_dataset_version', []], ['delete from machvon.quality_run', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.reporting_period', []]]);
  });

  describe('the build of a period', () => {
    it('AC-ST-BI-002-1, AC-ST-DGV-004-3: UAT-AC478, UAT-AC51 builds NOT_ASSESSED with no row excluded before DGV has run, then links the run with its 12 quarantined rows, supersedes the first and keeps it', async () => {
      const snap = await snapshot({ code: '2026-10', rows: 500 });
      const first = await build({ as_of_period: '2026-10' });
      expect(first.status).toBe(202);
      expect(first.json).toMatchObject({ status: 'FROZEN', outcome: 'BUILT', quality_badge: 'NOT_ASSESSED' });
      const run = await qualityRun(snap.id, { overall: 'WARNING', quarantined: 12 });
      const second = await build({ as_of_period: '2026-10' });
      expect(second.json).toMatchObject({ status: 'FROZEN', outcome: 'BUILT', quality_badge: 'WARNING' });
      const listed = items(await versions('?as_of_period=2026-10'));
      expect(listed.map((item) => [item.status, item.quality_badge, item.excluded_quarantine_rows, item.row_count, item.certified_row_count_min])).toEqual([
        ['FROZEN', 'WARNING', 12, 500, 488],
        ['SUPERSEDED', 'NOT_ASSESSED', 0, 500, 500],
      ]);
      expect(listed[0]).toMatchObject({ quality_run_id: run, source_snapshot_id: snap.id, supersedes_id: first.json.resource_id, feeds_certified: true });
      expect(listed[1]).toMatchObject({ id: first.json.resource_id, quality_run_id: null });
      // The version that was superseded stays and can be read: an open drill is served from it.
      expect(items(await versions('?status=SUPERSEDED')).map((item) => item.id)).toEqual([first.json.resource_id]);
      expect(await rows("select count(*)::int as n from machvon.bi_dataset_version where status = 'FROZEN' and as_of_period = '2026-10'")).toEqual([{ n: 1 }]);
    });

    it('AC-ST-BI-002-2: UAT-AC482 builds nothing new when the content is the same, however often it is asked, and keeps one frozen version per dataset and period', async () => {
      await snapshot({ code: '2026-11' });
      const first = await build({ as_of_period: '2026-11' });
      const again = await build({ as_of_period: '2026-11' });
      expect(again.json).toMatchObject({ outcome: 'UNCHANGED', resource_id: first.json.resource_id });
      expect(await rows("select count(*)::int as n from machvon.bi_dataset_version where as_of_period = '2026-11'")).toEqual([{ n: 1 }]);
      const audited = await rows("select action from machvon.audit_event where resource_id = $1 order by occurred_at", [first.json.resource_id]);
      expect(audited.map((row) => row.action)).toEqual(['bi.dataset_version_built', 'bi.dataset_version_build_unchanged']);
      const events = await rows('select type from machvon.outbox_event where aggregate_id = $1', [first.json.resource_id]);
      expect(events.map((row) => row.type)).toEqual(['bi.dataset_version.frozen.v1']);
    });

    it('AC-ST-BI-002-2: UAT-AC482 answers 409 BUILD_ALREADY_RUNNING while a build of the same dataset and period is in progress, and builds the other periods', async () => {
      const busy = await snapshot({ code: '2026-12' });
      const other = await snapshot({ code: '2027-01' });
      await app.seedReplica([
        [
          `insert into machvon.bi_dataset_version (tenant_id, id, dataset_id, as_of_period, source_snapshot_id, built_at, row_count, checksum_sha256, status, created_by, updated_by)
           values ($1, $2, $3, '2026-12', $4, now(), 0, repeat('0', 64), 'BUILDING', $5, $5)`,
          [TENANT_A, randomUUID(), DATASET, busy.id, WORKER_MEMBERSHIP_ID],
        ],
      ]);
      const refused = await build({ as_of_period: '2026-12' });
      expect([refused.status, refused.json.code]).toEqual([409, 'BUILD_ALREADY_RUNNING']);
      expect((await build({ as_of_period: '2027-01' })).json).toMatchObject({ outcome: 'BUILT' });
      void other;
      // A build that has stayed BUILDING for hours is taken for dead: it is marked FAILED and the period can be built.
      await app.harness.owner(TENANT_A, [["update machvon.bi_dataset_version set created_at = now() - interval '3 hours' where status = 'BUILDING'"]]);
      expect((await build({ as_of_period: '2026-12' })).json).toMatchObject({ outcome: 'BUILT' });
      expect(await rows("select status from machvon.bi_dataset_version where as_of_period = '2026-12' order by created_at")).toEqual([{ status: 'FAILED' }, { status: 'FROZEN' }]);
    });

    it('serializes two builds asked at once for one period: one builds, the other finds it built or is told one is running', async () => {
      await snapshot({ code: '2027-02' });
      const replies = await Promise.all([build({ as_of_period: '2027-02' }), build({ as_of_period: '2027-02' })]);
      const outcomes = replies.map((reply) => (reply.status === 202 ? (reply.json.outcome as string) : (reply.json.code as string))).sort();
      expect(outcomes.filter((outcome) => outcome === 'BUILT')).toHaveLength(1);
      expect(outcomes.every((outcome) => ['BUILT', 'UNCHANGED', 'BUILD_ALREADY_RUNNING'].includes(outcome))).toBe(true);
      expect(await rows("select count(*)::int as n from machvon.bi_dataset_version where as_of_period = '2027-02' and status = 'FROZEN'")).toEqual([{ n: 1 }]);
    });

    it('takes the frozen close snapshot of the period, and refuses what is not a frozen close snapshot (422 SOURCE_SNAPSHOT_NOT_FROZEN)', async () => {
      // A later freezing of the period replaced the first: only the later one is frozen.
      const old = await snapshot({ code: '2027-03', status: 'SUPERSEDED', frozenAt: '2027-03-01T00:00:00Z', sha: 'b'.repeat(64) });
      const latest = await snapshot({ code: '2027-03', periodId: old.periodId, frozenAt: '2027-03-02T00:00:00Z', sha: 'c'.repeat(64) });
      expect((await build({ as_of_period: '2027-03' })).json).toMatchObject({ outcome: 'BUILT' });
      expect(items(await versions('?as_of_period=2027-03')).map((item) => item.source_snapshot_id)).toEqual([latest.id]);
      expect((await build({ as_of_period: '2027-03', source_snapshot_id: latest.id })).json).toMatchObject({ outcome: 'UNCHANGED' });
      const none = await build({ as_of_period: '2027-04' });
      expect([none.status, none.json.code, none.json.detail]).toEqual([422, 'SOURCE_SNAPSHOT_NOT_FROZEN', 'as_of_period']);
      const adhoc = await snapshot({ code: '2027-05', kind: 'ADHOC' });
      const building = await snapshot({ code: '2027-06', status: 'BUILDING' });
      for (const [period, named] of [['2027-05', adhoc.id], ['2027-06', building.id], ['2027-05', randomUUID()], ['2027-03', adhoc.id], ['2027-03', old.id]] as const) {
        const refused = await build({ as_of_period: period, source_snapshot_id: named });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'SOURCE_SNAPSHOT_NOT_FROZEN', 'source_snapshot_id']);
      }
    });

    it('links the dataset to the catalogue of DGV as soon as DGV has a dataset for the producer, and reads the quality run of that dataset', async () => {
      await app.harness.owner(TENANT_A, [['update machvon.bi_dataset set dgv_dataset_id = null where id = $1', [DATASET]]]);
      const snap = await snapshot({ code: '2029-11' });
      await qualityRun(snap.id, { overall: 'PASSED', quarantined: 0 });
      expect((await build({ as_of_period: '2029-11' })).json).toMatchObject({ quality_badge: 'PASSED' });
      expect(await rows('select dgv_dataset_id from machvon.bi_dataset where id = $1', [DATASET])).toEqual([{ dgv_dataset_id: DGV_DATASET }]);
      const listed = items(await app.call('GET', '/bi/datasets', { member: QUERIER })).find((item) => item.id === DATASET);
      expect(listed?.dgv_dataset_id).toBe(DGV_DATASET);
    });

    it('does not build from a snapshot that was replaced between the read of it and the lock: the version of the one that replaced it stands', async () => {
      const old = await snapshot({ code: '2029-10', sha: 'b'.repeat(64) });
      // The replacement is frozen, and its consumer builds its version, in the instant between the build reading the old snapshot and taking the lock.
      let replaced = false;
      const tenants = app.harness.tenants as TenantDatabase;
      await expect(
        tenants.withTenant(contextFor(TENANT_A, memberId(BUILDER)), (tx) => {
          const racing = {
            query: async (sql: string, params?: unknown[]) => {
              if (!replaced && sql.includes('pg_try_advisory_xact_lock')) {
                replaced = true;
                await app.seedReplica([["update machvon.period_snapshot set status = 'SUPERSEDED' where id = '" + old.id + "'", []]]);
              }
              return tx.query(sql, params);
            },
          } as unknown as TenantTx;
          return new BiDatasetStore().build(racing, { datasetId: DATASET, asOfPeriod: '2029-10', actor: memberId(BUILDER) });
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_NOT_FROZEN', detail: 'source_snapshot_id' });
      expect(replaced).toBe(true);
      expect(await rows("select id from machvon.bi_dataset_version where as_of_period = '2029-10'")).toEqual([]);
    });

    it('refuses a bad period, a bad snapshot id, a dataset that is not there or not ACTIVE or not built from snapshots, and a body with a field it does not know', async () => {
      expect([(await build({ as_of_period: 'x' })).status, (await build({ as_of_period: '2026 10' })).status, (await build({ as_of_period: '2026-10', source_snapshot_id: 'nope' })).status]).toEqual([422, 422, 422]);
      const unknown = await build({ as_of_period: '2026-10', dataset_id: randomUUID() });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      expect((await build({ as_of_period: '2026-10' }, BUILDER, randomUUID())).status).toBe(404);
      await app.harness.owner(TENANT_A, [["update machvon.bi_dataset set status = 'DEPRECATED' where id = $1", [DATASET]]]);
      const old = await build({ as_of_period: '2026-10' });
      await app.harness.owner(TENANT_A, [["update machvon.bi_dataset set status = 'ACTIVE' where id = $1", [DATASET]]]);
      expect([old.status, old.json.code, old.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'dataset']);
      await app.harness.owner(TENANT_A, [["update machvon.bi_dataset set source_kind = 'AUDIT_FACT' where id = $1", [DATASET]]]);
      const other = await build({ as_of_period: '2026-10' });
      await app.harness.owner(TENANT_A, [["update machvon.bi_dataset set source_kind = 'PERIOD_SNAPSHOT' where id = $1", [DATASET]]]);
      expect([other.status, other.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('marks a run of another payload STALE with no row excluded, a run that blocks certified figures FAILED, and a run still running or failed NOT_ASSESSED', async () => {
      const stale = await snapshot({ code: '2027-07', sha: 'd'.repeat(64) });
      await qualityRun(stale.id, { overall: 'PASSED', quarantined: 9, sha: 'e'.repeat(64) });
      const staleReply = await build({ as_of_period: '2027-07' });
      expect(staleReply.json.quality_badge).toBe('STALE');
      expect(items(await versions('?as_of_period=2027-07'))[0]).toMatchObject({ excluded_quarantine_rows: 0, feeds_certified: false });
      const blocked = await snapshot({ code: '2027-08' });
      await qualityRun(blocked.id, { overall: 'WARNING', quarantined: 2, blocked: true });
      expect((await build({ as_of_period: '2027-08' })).json.quality_badge).toBe('FAILED');
      const running = await snapshot({ code: '2027-09' });
      await qualityRun(running.id, { status: 'RUNNING' });
      await qualityRun(running.id, { status: 'FAILED' });
      expect((await build({ as_of_period: '2027-09' })).json.quality_badge).toBe('NOT_ASSESSED');
      // The latest completed run is the one that counts.
      const twice = await snapshot({ code: '2027-10' });
      await qualityRun(twice.id, { overall: 'FAILED', quarantined: 1, finishedAt: '2027-10-01T00:00:00Z' });
      await qualityRun(twice.id, { overall: 'PASSED', quarantined: 4, finishedAt: '2027-10-02T00:00:00Z' });
      expect((await build({ as_of_period: '2027-10' })).json.quality_badge).toBe('PASSED');
    });
  });

  describe('the consumer of the events', () => {
    it('AC-ST-BI-002-1: UAT-AC478 builds the version when a close snapshot freezes (creating the dataset of the tenant), and builds it again with the run linked when DGV completes one', async () => {
      const snap = await snapshot({ code: '2027-11', rows: 40 });
      const event = delivery(SNAPSHOT_FROZEN, { snapshot_id: snap.id, tenant_id: TENANT_A });
      expect(await consumer().handle(event)).toBe('processed');
      expect(await consumer().handle(event)).toBe('duplicate');
      let found = await rows("select v.quality_badge, v.status, v.excluded_quarantine_rows::int as excluded, d.dataset_code from machvon.bi_dataset_version v join machvon.bi_dataset d on d.id = v.dataset_id where v.as_of_period = '2027-11'");
      expect(found).toEqual([{ quality_badge: 'NOT_ASSESSED', status: 'FROZEN', excluded: 0, dataset_code: 'DS-DISB' }]);
      await qualityRun(snap.id, { overall: 'WARNING', quarantined: 12 });
      expect(await consumer().handle(delivery(RUN_COMPLETED, { snapshot_id: snap.id, run_id: randomUUID() }))).toBe('processed');
      found = await rows("select quality_badge, status, excluded_quarantine_rows::int as excluded from machvon.bi_dataset_version where as_of_period = '2027-11' order by created_at");
      expect(found).toEqual([{ quality_badge: 'NOT_ASSESSED', status: 'SUPERSEDED', excluded: 0 }, { quality_badge: 'WARNING', status: 'FROZEN', excluded: 12 }]);
      // The same event of another delivery id builds nothing more: the content is the same.
      expect(await consumer().handle(delivery(RUN_COMPLETED, { snapshot_id: snap.id }))).toBe('processed');
      expect(await rows("select count(*)::int as n from machvon.bi_dataset_version where as_of_period = '2027-11'")).toEqual([{ n: 2 }]);
      const events = await rows("select payload from machvon.outbox_event where type = 'bi.dataset_version.frozen.v1' order by created_at");
      expect(events.map((row) => (row.payload as { quality_badge: string; dataset_code: string }).quality_badge).slice(-2)).toEqual(['NOT_ASSESSED', 'WARNING']);
      const audited = await rows("select actor_id from machvon.audit_event where action = 'bi.dataset_version_built' and safe_diff ->> 'as_of_period' = '2027-11'");
      expect(audited).toEqual([{ actor_id: WORKER_MEMBERSHIP_ID }, { actor_id: WORKER_MEMBERSHIP_ID }]);
    });

    it('AC-ST-BI-002-2: UAT-AC482 builds one frozen version when the event of a snapshot is delivered twice and when two events name it, and supersedes the version of the snapshot that replaces it', async () => {
      const first = await snapshot({ code: '2027-12', sha: 'b'.repeat(64) });
      await consumer().handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: first.id }));
      await consumer().handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: first.id }));
      expect(await rows("select count(*)::int as n from machvon.bi_dataset_version where as_of_period = '2027-12' and status = 'FROZEN'")).toEqual([{ n: 1 }]);
      // A later close snapshot of the period replaces the first one; the version of the first stays, superseded.
      await app.harness.owner(TENANT_A, [["update machvon.period_snapshot set status = 'SUPERSEDED' where id = $1", [first.id]]]);
      const second = await snapshot({ code: '2027-12', periodId: first.periodId, sha: 'c'.repeat(64) });
      await consumer().handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: second.id }));
      expect(await rows("select source_snapshot_id, status from machvon.bi_dataset_version where as_of_period = '2027-12' order by created_at")).toEqual([
        { source_snapshot_id: first.id, status: 'SUPERSEDED' },
        { source_snapshot_id: second.id, status: 'FROZEN' },
      ]);
      // A quality run of the replaced snapshot completing late builds nothing: it is no longer the frozen one.
      await qualityRun(first.id, { overall: 'FAILED', quarantined: 3 });
      expect(await consumer().handle(delivery(RUN_COMPLETED, { snapshot_id: first.id }))).toBe('processed');
      expect(await rows("select count(*)::int as n from machvon.bi_dataset_version where as_of_period = '2027-12'")).toEqual([{ n: 2 }]);
    });

    it('builds nothing from an ad hoc snapshot, one that is not frozen or one that is not there, and leaves alone what is not its to act on', async () => {
      const adhoc = await snapshot({ code: '2028-01', kind: 'ADHOC' });
      expect(await consumer().handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: adhoc.id }))).toBe('processed');
      expect(await consumer().handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: randomUUID() }))).toBe('processed');
      expect(await rows('select id from machvon.bi_dataset_version')).toEqual([]);
      expect(await consumer().handle(delivery('report.accepted.v1', { snapshot_id: adhoc.id }))).toBe('ignored');
      expect(await consumer().handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: adhoc.id, tenant_id: TENANT_B }))).toBe('ignored');
      await expect(consumer().handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: 'not-a-uuid' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(consumer().handle({ ...delivery(SNAPSHOT_FROZEN, { snapshot_id: adhoc.id }), tenantContext: 'forged' })).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    });

    it('fails the delivery as itself when the record of what a build made fails, not as a savepoint that is gone', async () => {
      const snap = await snapshot({ code: '2029-12' });
      const real = app.harness.tenants as TenantDatabase;
      const failing = {
        withTenant: (context: never, work: (tx: TenantTx) => Promise<unknown>) =>
          real.withTenant(context, (tx) => work({ query: (sql: string, params?: unknown[]) => (sql.includes('outbox_event') && sql.includes('insert') ? Promise.reject(new Error('the outbox is down')) : tx.query(sql, params)) } as unknown as TenantTx)),
      };
      const broken = new DatasetBuildConsumer({ database: failing as never, security: { signingKey: SIGNING_KEY } });
      await expect(broken.handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: snap.id }))).rejects.toThrow('the outbox is down');
      // Nothing of it stays, and the delivery goes through once the outbox is back.
      expect(await rows("select id from machvon.bi_dataset_version where as_of_period = '2029-12'")).toEqual([]);
      expect(await consumer().handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: snap.id }))).toBe('processed');
    });

    it('retries a delivery while a build of the period is in progress: the event is not lost', async () => {
      const snap = await snapshot({ code: '2028-02' });
      await app.seedReplica([
        [
          `insert into machvon.bi_dataset_version (tenant_id, id, dataset_id, as_of_period, source_snapshot_id, built_at, row_count, checksum_sha256, status, created_by, updated_by)
           values ($1, $2, $3, '2028-02', $4, now(), 0, repeat('0', 64), 'BUILDING', $5, $5)`,
          [TENANT_A, randomUUID(), DATASET, snap.id, WORKER_MEMBERSHIP_ID],
        ],
      ]);
      await expect(consumer().handle(delivery(SNAPSHOT_FROZEN, { snapshot_id: snap.id }))).rejects.toMatchObject({ code: 'BUILD_ALREADY_RUNNING' });
      expect(await rows("select count(*)::int as n from machvon.bi_dataset_version where as_of_period = '2028-02' and status = 'FROZEN'")).toEqual([{ n: 0 }]);
    });
  });

  describe('the datasets and who may read and build', () => {
    it('lists the datasets with the approved joins, the refresh policy and the version that serves, and pages them by code', async () => {
      await snapshot({ code: '2028-03' });
      await build({ as_of_period: '2028-03' });
      const list = await app.call('GET', '/bi/datasets', { member: QUERIER });
      expect(list.status).toBe(200);
      const [disb] = items(list).filter((item) => item.id === DATASET);
      expect(disb).toMatchObject({ dataset_code: 'DS-DISB', source_kind: 'PERIOD_SNAPSHOT', refresh_policy: 'ON_SNAPSHOT_FROZEN', status: 'ACTIVE', latest_version: { as_of_period: '2028-03', quality_badge: 'NOT_ASSESSED' } });
      expect(disb?.join_paths).toEqual({ dimensions: ['unit', 'fund'] });
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page += 1) {
        const reply = await app.call('GET', `/bi/datasets?limit=1${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { member: QUERIER });
        seen.push(...items(reply).map((item) => item.dataset_code as string));
        if (reply.json.next_cursor === null) break;
        cursor = reply.json.next_cursor as string;
      }
      expect(seen).toEqual(['DS-DISB', 'DS-OLD']);
    });

    it('pages the versions without repeating or skipping one, and refuses a filter or a cursor it does not know and a dataset that is not there', async () => {
      for (const code of ['2028-04', '2028-05', '2028-06']) {
        await snapshot({ code });
        await build({ as_of_period: code });
      }
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page += 1) {
        const reply = await versions(`?limit=2${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
        seen.push(...items(reply).map((item) => item.as_of_period as string));
        if (reply.json.next_cursor === null) break;
        cursor = reply.json.next_cursor as string;
      }
      expect(seen).toEqual(['2028-06', '2028-05', '2028-04']);
      expect((await versions('?status=GONE')).status).toBe(422);
      expect((await versions('?as_of_period=a%20b')).status).toBe(422);
      expect((await versions(`?cursor=${encodeURIComponent(Buffer.from(JSON.stringify({ code: 'not a date', id: randomUUID() })).toString('base64url'))}`)).status).toBe(422);
      expect((await versions('', QUERIER, randomUUID())).status).toBe(404);
    });

    it('continues a page from the microsecond: versions made within one millisecond are neither repeated nor skipped', async () => {
      for (const [index, micros] of ['000100', '000200', '000300'].entries()) {
        await app.seedReplica([
          [
            `insert into machvon.bi_dataset_version (tenant_id, id, dataset_id, as_of_period, built_at, row_count, checksum_sha256, status, created_at, created_by, updated_by)
             values ($1, $2, $3, $4, now(), 1, repeat('1', 64), 'FROZEN', ('2029-01-01 00:00:00.' || $5 || '+00')::timestamptz, $6, $6)`,
            [TENANT_A, randomUUID(), DATASET, `2029-0${index + 1}`, micros, WORKER_MEMBERSHIP_ID],
          ],
        ]);
      }
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page += 1) {
        const reply = await versions(`?limit=1${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
        seen.push(...items(reply).map((item) => item.as_of_period as string));
        if (reply.json.next_cursor === null) break;
        cursor = reply.json.next_cursor as string;
      }
      expect(seen).toEqual(['2029-03', '2029-02', '2029-01']);
    });

    it('keeps the build to whoever holds the right over the whole tenant, and the reads to whoever may query', async () => {
      await snapshot({ code: '2028-07' });
      for (const member of [QUERIER, READER, NOBODY]) expect((await build({ as_of_period: '2028-07' }, member)).status).toBe(403);
      for (const member of [READER, NOBODY]) expect((await versions('', member)).status).toBe(403);
      expect((await app.call('GET', '/bi/datasets', { member: NOBODY })).status).toBe(403);
      expect((await versions('', BUILDER)).status).toBe(200);
      expect(await rows("select count(*)::int as n from machvon.bi_dataset_version where as_of_period = '2028-07'")).toEqual([{ n: 0 }]);
    });

    it('keeps each tenant to its own datasets and snapshots', async () => {
      await snapshot({ code: '2028-08' });
      const foreign = await build({ as_of_period: '2028-08' }, BUILDER, DATASET, TENANT_B);
      expect([foreign.status]).toEqual([404]);
      expect((await versions('', BUILDER, DATASET, TENANT_B)).status).toBe(404);
      expect(items(await app.call('GET', '/bi/datasets', { member: BUILDER, tenantId: TENANT_B }))).toEqual([]);
    });
  });
});
