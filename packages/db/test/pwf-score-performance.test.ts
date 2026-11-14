import { pwfKpi } from '@machvon/kernel';
import { Client } from 'pg';
import { PwfKpiStore } from '../src/pwf-kpi-store';
import { PwfScoreStore } from '../src/pwf-score-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, memberId, unitId } from './support/authz-fixtures';
import { budgetFor, median, judgedBudget } from './support/perf-budget';
import { ScoreFixtures } from './support/pwf-score-fixtures';

/**
 * R35, BR-PWF-29: the close of a period of 5,000 people is done in 20 seconds (on a machine of the reference speed), and the KPI results of the day are written incrementally in a few statements. The budget is stretched by
 * how much slower than the reference this machine measures in the same run, with a workload that touches nothing under test (`support/perf-budget.ts`); a machine five times slower than the reference is not judged.
 */

jest.setTimeout(1_800_000);

const PEOPLE = 5_000;
/** The three members the fixtures seed for the maker, the submitter and the checker of the rules: they are members of the root unit, so they are on its roster too (every member of the unit has a line, rated or not). */
const FIXTURE_MEMBERS = 3;
const TASKS_PER_PERSON = 3;
const UNITS = 10;
const BUDGET_MS = 20_000;
/** How long the reference workload of `machineMs` takes on the reference machine (median of 5 runs, in milliseconds): a scan of the task table and a fetch of the tasks that were done. Provisional: re-measure on an idle machine. */
const REFERENCE_MACHINE_MS = 50;
const REFERENCE_RUNS = 5;
const MAKER = 1;
const ROOT = 1;
const FROM = '2025-07-01';
const TO = '2025-09-30';

describe(`the close of a scoring period at the size of a province (R35: ${PEOPLE} people, ${PEOPLE * TASKS_PER_PERSON} tasks, within ${BUDGET_MS / 1000} s)`, () => {
  const harness = new AuthzHarness();
  const fixtures = new ScoreFixtures({ harness, maker: MAKER, unit: ROOT });
  const kpis = new PwfKpiStore();
  const scores = new PwfScoreStore();
  const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 }, work);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }, ...Array.from({ length: UNITS }, (_, index) => ({ n: index + 2, path: `/${unitId(ROOT)}/${unitId(index + 2)}/`, parent: ROOT }))]);
    for (const n of [MAKER, MAKER + 1, MAKER + 2]) await harness.seedMembership(TENANT_A, n, ROOT);
    await fixtures.seed({ maker: MAKER, submitter: MAKER + 1, checker: MAKER + 2 }, { ...pwfKpi.DEFAULT_STAFF_SCORING_PARAMS, min_rated_tasks: 1, min_effective_weight: 0.5 });
    const wf = await fixtures.workflow();
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // The load is written with the triggers and the checks of the foreign keys off (what a bulk load does); every row still passes its own CHECK constraints.
      await client.query('set session_replication_role = replica');
      const units = Array.from({ length: UNITS }, (_, index) => unitId(index + 2));
      await client.query(
        `insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from)
         select $1::uuid, ('00000000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid, gen_random_uuid(), ($2::uuid[])[(n % $3::int) + 1], 'Active', now() - interval '400 days' from generate_series(1, $4::int) n`,
        [TENANT_A, units, UNITS, PEOPLE],
      );
      await client.query(
        `create temp table seed as select n, ('00000000-0000-4000-9100-' || lpad(to_hex(n), 12, '0'))::uuid as task_id, ('00000000-0000-4000-9000-' || lpad(to_hex(((n - 1) % $1::int) + 1), 12, '0'))::uuid as person
           from generate_series(1, $2::int) n`,
        [PEOPLE, PEOPLE * TASKS_PER_PERSON],
      );
      await client.query(
        `insert into machvon.project_task (tenant_id, id, workflow_id, project_id, task_code, name, phase_code, sort_order, kind, required, responsible_role, priority, duration_working_days, own_task, status, tracked,
            baseline_start, baseline_finish, planned_start, planned_finish, actual_start, actual_finish, return_count, created_by, updated_by)
         select $1::uuid, task_id, $2::uuid, $3::uuid, 'P' || n, 'Task ' || n, 'P1', 900, 'TASK', false, 'WORKER_ROLE', (array['LOW','NORMAL','HIGH','CRITICAL'])[(n % 4) + 1], 5 + (n % 15), true, 'DONE', true,
                date '2025-07-07', date '2025-08-15', date '2025-07-07', date '2025-08-15', date '2025-07-08', date '2025-08-15' + (n % 12), n % 3, $4::uuid, $4::uuid
           from seed`,
        [TENANT_A, wf.id, wf.projectId, memberId(MAKER)],
      );
      await client.query(
        `insert into machvon.project_task_assignment (tenant_id, task_id, membership_id, role, valid_from, share_pct, reason, assigned_by) select $1::uuid, task_id, person, 'RESPONSIBLE', date '2025-07-01', 100, 'Held for the load', $2::uuid from seed`,
        [TENANT_A, memberId(MAKER)],
      );
      for (const table of ['membership', 'project_task', 'project_task_assignment', 'organization_unit']) await client.query(`analyze machvon.${table}`);
    } finally {
      await client.end();
    }
  }, 900_000);

  afterAll(() => harness.stop(), 60_000);

  /** The speed of this machine today: a scan of the tasks and a fetch of the done ones, through the same driver as what is under test and nothing of it. */
  async function machineMs(): Promise<number> {
    const timings: number[] = [];
    for (let run = 0; run <= REFERENCE_RUNS; run += 1) {
      const started = performance.now();
      await as(async (tx) => {
        await tx.query('select count(*)::int as n, count(distinct workflow_id)::int as w from machvon.project_task');
        await tx.query("select id::text, task_code, status, baseline_finish::text, actual_finish::text from machvon.project_task where status = 'DONE'");
      });
      if (run > 0) timings.push(performance.now() - started);
    }
    return median(timings);
  }

  it('has the people and the tasks the budget is about', async () => {
    const [row] = await harness.owner<{ people: string; tasks: string; held: string }>(TENANT_A, [
      ['select (select count(*) from machvon.membership)::text as people, (select count(*) from machvon.project_task)::text as tasks, (select count(*) from machvon.project_task_assignment)::text as held'],
    ]);
    expect(Number(row?.people)).toBe(PEOPLE + FIXTURE_MEMBERS);
    // The task of the template of the workflow is one more.
    expect(Number(row?.tasks)).toBe(PEOPLE * TASKS_PER_PERSON + 1);
    expect(Number(row?.held)).toBe(PEOPLE * TASKS_PER_PERSON);
  });

  it('writes the KPI results of 15,000 closed tasks incrementally: one pass, then nothing to do, and a pass costs a handful of statements and not one for each result', async () => {
    const started = performance.now();
    let written = 0;
    let passes = 0;
    for (;;) {
      const pending = await as((tx) => kpis.pendingTaskIds(tx, 500));
      if (pending.length === 0) break;
      const done = await as((tx) => kpis.record(tx, pending, new Date()));
      written += done.written;
      passes += 1;
    }
    const elapsed = performance.now() - started;
    process.stdout.write(`R35 KPI results: ${written} results in ${passes} passes, ${elapsed.toFixed(0)} ms\n`);
    expect(written).toBe(PEOPLE * TASKS_PER_PERSON * 6);
    expect(await as((tx) => kpis.pendingTaskIds(tx, 500))).toEqual([]);
  });

  it(`closes the period of ${PEOPLE} people (locks the draft: the facts read again, the snapshot and its hash) within ${BUDGET_MS / 1000} s on a machine of the reference speed`, async () => {
    const before = await machineMs();
    const started = performance.now();
    const draft = await as((tx) => scores.compute(tx, { scopeUnitId: unitId(ROOT), periodFrom: FROM, periodTo: TO, policyCode: 'TESTPOL', actor: memberId(MAKER), units: '*', now: new Date() }));
    const computed = performance.now();
    const locked = await as((tx) => scores.lock(tx, { periodId: draft.period.id, expectedVersion: draft.period.version, actor: memberId(MAKER), units: '*', now: new Date() }));
    const finished = performance.now();
    const after = await machineMs();
    // The close is the lock (it reads the facts once more and takes the snapshot); the draft before it is the preview people look at during the period.
    const close = finished - computed;
    const decision = budgetFor(Math.max(before, after), REFERENCE_MACHINE_MS, BUDGET_MS);
    process.stdout.write(
      `R35 period close: ${close.toFixed(0)} ms (draft ${(computed - started).toFixed(0)} ms, lock ${(finished - computed).toFixed(0)} ms), budget ${decision.budgetMs.toFixed(0)} ms (machine ${decision.factor.toFixed(2)}x the reference: ${before.toFixed(0)}/${after.toFixed(0)} ms against ${REFERENCE_MACHINE_MS} ms)\n`,
    );
    if (decision.tooSlow) throw new Error(`this machine measured more than five times slower than the reference (${Math.max(before, after).toFixed(0)} ms against ${REFERENCE_MACHINE_MS} ms): no verdict can be given, run it again when the machine is quiet`);
    // The people the period is about are the 5,000 of the load and the members of the fixtures, each with a line.
    expect(draft.ratedCount + draft.smallSampleCount + draft.notRatedCount).toBe(PEOPLE + FIXTURE_MEMBERS);
    expect(locked.status).toBe('LOCKED');
    expect(close).toBeLessThanOrEqual(judgedBudget(decision.budgetMs));
    // The period is what it says: reproducible from its snapshot to the same hash.
    expect(await as((tx) => scores.verify(tx, draft.period.id))).toMatchObject({ reproducible: true });
  });
});
