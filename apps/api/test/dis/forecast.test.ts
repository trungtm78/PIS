import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { DisbursementScheduleController } from '../../src/modules/cap/schedule.controller';
import { disModule } from '../../src/modules/dis';
import { DisbursementForecastController, curveOf } from '../../src/modules/dis/disbursement-forecast.controller';
import { DIS_CLOCK } from '../../src/modules/dis/tokens';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const READER = 1; // disbursement.read over the whole tenant
const HERE_READER = 2; // over the unit HERE
const NOBODY = 3;
const INVESTOR = 4; // capital.schedule.register over the whole tenant
const B_READER = 1;
const ROOT = 1;
const HERE = 2;
const ELSEWHERE = 3;
const FAMILY = 0xaa;
const NOW = new Date('2027-11-02T03:00:00Z');

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Spec {
  tag: string;
  unit?: number;
  plan: string;
  /** What the Treasury paid, one payment each: [month of 2027, amount]. */
  payments?: Array<[number, string]>;
  /** The disbursement of the line of the snapshot; defaults to the payments added up, null when there are none. */
  disbursed?: string | null;
  forecasts?: Array<[number, string]>;
  registered?: Array<[number, string]>;
}

/** The year-end estimate and the cumulative curve over a frozen snapshot, over HTTP (ST-DIS-018, DIS-23, BR-DIS-11). */
describe('the disbursement forecast over HTTP (ST-DIS-018)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function get(query = '', member = READER, tenantId?: string): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}/disbursement-forecasts${query}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }
  interface ProjectView {
    project: { id: string; code: string };
    [member: string]: unknown;
  }
  const projectsOf = (reply: Reply): ProjectView[] => reply.json.projects as ProjectView[];
  const day = (offset: number): string => new Date(Date.UTC(2044, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

  /** A frozen close snapshot whose cutoff is the last day of October 2027, with a project for each spec (a line each) and what the Treasury paid, the forecasts and the registrations of each. */
  async function world(specs: Spec[], options: { frozen?: boolean; cutoff?: string } = {}) {
    counter += 1;
    const periodId = id(FAMILY, 1000 + counter);
    const snapshotId = randomUUID();
    const cutoff = options.cutoff ?? '2027-10-31';
    const projects: Array<{ id: string; code: string; tag: string }> = [];
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `FC-${counter}`, day(counter * 10), id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, $5::date, $5::date, 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', $6, $7, $7)`,
        [TENANT_A, snapshotId, periodId, NOW.toISOString(), cutoff, specs.length, WORKER_MEMBERSHIP_ID],
      ],
    ];
    specs.forEach((spec, n) => {
      const projectId = id(FAMILY, 100 + counter * 20 + n);
      const code = `PF-${String(counter).padStart(2, '0')}-${spec.tag}`;
      projects.push({ id: projectId, code, tag: spec.tag });
      statements.push([
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(spec.unit ?? HERE), id(FAMILY, 30)],
      ]);
      const paidTotal = (spec.payments ?? []).reduce((sum, [, amount]) => sum + BigInt(amount), 0n);
      const disbursed = spec.disbursed !== undefined ? spec.disbursed : spec.payments === undefined ? null : paidTotal.toString();
      statements.push([
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', $5::numeric, $5::numeric, $6::numeric, $7)`,
        [TENANT_A, snapshotId, projectId, unitId(spec.unit ?? HERE), spec.plan, disbursed, disbursed === null ? 'NONE' : 'COMPLETE'],
      ]);
      for (const [month, amount] of spec.payments ?? []) {
        statements.push([
          `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, direction, import_id)
           values ($1, gen_random_uuid(), $2, $3, 'TREASURY', $4::numeric, make_timestamptz(2027, $5::int, 10, 4, 0, 0, 'Asia/Ho_Chi_Minh'), repeat('d', 64), 'PAYMENT', gen_random_uuid())`,
          [TENANT_A, projectId, `EXT-${randomUUID()}`, amount, month],
        ]);
      }
      const schedule = (kind: 'FORECAST' | 'REGISTERED', rows: Array<[number, string]> | undefined): void => {
        for (const [month, amount] of rows ?? []) {
          statements.push([
            `insert into machvon.disbursement_schedule_line (tenant_id, id, project_id, plan_year, granularity, month, bucket, budget_level, kind, amount_vnd, assumption, revision, is_current, created_by, updated_by)
             values ($1, gen_random_uuid(), $2, 2027, 'MONTH', $3::smallint, 'CURRENT_YEAR', 'CENTRAL', $4, $5::numeric, $6, 1, true, $7, $7)`,
            [TENANT_A, projectId, month, kind, amount, kind === 'FORECAST' ? 'Expected by the investor' : null, WORKER_MEMBERSHIP_ID],
          ]);
        }
      };
      schedule('FORECAST', spec.forecasts);
      schedule('REGISTERED', spec.registered);
    });
    if (options.frozen !== false) statements.push([`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = $3::timestamptz where id = $1`, [snapshotId, WORKER_MEMBERSHIP_ID, NOW.toISOString()]]);
    await seedReplica(statements);
    return { snapshotId, projects };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: HERE, path: `/${unitId(ROOT)}/${unitId(HERE)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [READER, HERE_READER, NOBODY, INVESTOR]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_READER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'DIS_READER', ['disbursement.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'DIS_READER', ['disbursement.read'], 20);
    await harness.seedRole(TENANT_A, 2, 'CAP_INVESTOR', ['capital.schedule.register', 'capital.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: READER, role: 1, kind: 'TENANT' },
      { n: 2, member: HERE_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(HERE)] },
      { n: 3, member: INVESTOR, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_READER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [DisbursementForecastController, DisbursementScheduleController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('serves the controller of the forecast in the module of DIS', () => {
    expect(disModule.controllers).toContain(DisbursementForecastController);
  });

  it('AC-ST-DIS-018-1 / UAT-AC255: P-A-002 disbursed 400 million with forecasts of 100 million for November and 150 million for December is estimated at 650 million, 350 million under a plan of a billion, and is a candidate for reallocation', async () => {
    const w = await world([{ tag: 'A2', plan: '1000000000', payments: [[3, '100000000'], [6, '200000000'], [10, '100000000']], forecasts: [[11, '100000000'], [12, '150000000']] }]);
    const reply = await get(`?snapshot_id=${w.snapshotId}`);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({
      snapshot_id: w.snapshotId,
      plan_year: 2027,
      cutoff_month: 10,
      treasury_cutoff_date: '2027-10-31',
      definition_status: 'PROPOSED_PENDING_SIGNOFF',
      reallocation_threshold_pct: 80,
      disbursed_vnd: '400000000',
      eac_vnd: '650000000',
      plan_total_vnd: '1000000000',
      gap_vnd: '-350000000',
      ratio_pct: '65.0',
      coverage: 'COMPLETE',
      reallocation_candidate: true,
      method: 'FORECAST_AND_REGISTERED',
    });
    expect(reply.json.months).toEqual([
      { month: 11, amount_vnd: '100000000', source: 'FORECAST' },
      { month: 12, amount_vnd: '150000000', source: 'FORECAST' },
    ]);
    expect(projectsOf(reply)).toHaveLength(1);
    expect(projectsOf(reply)[0]).toMatchObject({ project: { id: w.projects[0]?.id, code: w.projects[0]?.code }, eac_vnd: '650000000', gap_vnd: '-350000000', reallocation_candidate: true });
  });

  it('UAT-AC232: forecasts of 100 and 150 million for November and December make the estimate 650 million, and the December forecast raised to 200 million (revision 2, revision 1 no longer current) makes it 700 million, 300 million under the plan, with the reason of the change kept', async () => {
    const w = await world([{ tag: 'E2', plan: '1000000000', payments: [[3, '100000000'], [6, '200000000'], [10, '100000000']] }]);
    const projectId = w.projects[0]?.id as string;
    const registered = async (month: number, amount: string, extra: Record<string, unknown> = {}): Promise<Reply> => {
      const response = await fetch(`${app.baseUrl}/disbursement-schedules`, {
        method: 'POST',
        headers: { [TENANT_HEADER]: tokenOf(INVESTOR), 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}` },
        body: JSON.stringify({ project_id: projectId, plan_year: 2027, granularity: 'MONTH', month, kind: 'FORECAST', bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', amount_vnd: amount, assumption: 'Expected by the investor', ...extra }),
      });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };
    // Step 1: the forecasts of the two months go in through the command of CAP.
    expect((await registered(11, '100000000')).status).toBe(200);
    const december = await registered(12, '150000000');
    expect(december.status).toBe(200);
    const first = await get(`?snapshot_id=${w.snapshotId}`);
    expect(first.json).toMatchObject({ disbursed_vnd: '400000000', eac_vnd: '650000000', plan_total_vnd: '1000000000', gap_vnd: '-350000000' });
    // Step 2: December is revised to 200 million, with the reason.
    const revised = await registered(12, '200000000', { revision_reason: 'The contractor brought the payment forward' });
    expect(revised.status).toBe(200);
    const history = await harness.owner<{ revision: number; is_current: boolean; amount: string; supersedes_id: string | null; id: string }>(
      TENANT_A,
      [['select id, revision, is_current, amount_vnd::text as amount, supersedes_id from machvon.disbursement_schedule_line where project_id = $1::uuid and month = 12 and kind = \'FORECAST\' order by revision', [projectId]]],
    );
    expect(history).toMatchObject([
      { revision: 1, is_current: false, amount: '150000000', supersedes_id: null },
      { revision: 2, is_current: true, amount: '200000000', supersedes_id: december.json.resource_id },
    ]);
    // Step 3: what the screen reads: the estimate 700 million and the gap to the plan of -300 million.
    const second = await get(`?snapshot_id=${w.snapshotId}`);
    expect(second.json).toMatchObject({ eac_vnd: '700000000', gap_vnd: '-300000000', plan_total_vnd: '1000000000', method: 'FORECAST_AND_REGISTERED' });
    expect(second.json.months).toEqual([
      { month: 11, amount_vnd: '100000000', source: 'FORECAST' },
      { month: 12, amount_vnd: '200000000', source: 'FORECAST' },
    ]);
    const reasons = await harness.owner<{ reason: string | null }>(TENANT_A, [['select reason from machvon.audit_event where action = \'capital.schedule_registered\' and resource_id = $1::uuid', [revised.json.resource_id]]]);
    expect(reasons).toEqual([{ reason: 'The contractor brought the payment forward' }]);
    // A wrong expectation makes the check fail: the estimate did not stay at the first 650 million.
    expect(second.json.eac_vnd).not.toBe('650000000');
  });

  it('draws the cumulative curve: what the Treasury paid month by month to the cutoff (ending at the figure of the snapshot), the forecast after it, and nothing where the year is not known', async () => {
    const w = await world([{ tag: 'CV', plan: '1000000000', payments: [[3, '100000000'], [6, '200000000'], [10, '100000000']], forecasts: [[11, '100000000'], [12, '150000000']] }]);
    const curve = (await get(`?snapshot_id=${w.snapshotId}`)).json.curve as Array<Record<string, unknown>>;
    expect(curve.map((point) => [point.month, point.actual_cumulative_vnd])).toEqual([[1, '0'], [2, '0'], [3, '100000000'], [4, '100000000'], [5, '100000000'], [6, '300000000'], [7, '300000000'], [8, '300000000'], [9, '300000000'], [10, '400000000'], [11, null], [12, null]]);
    expect(curve.filter((point) => point.forecast_cumulative_vnd !== null).map((point) => [point.month, point.forecast_cumulative_vnd])).toEqual([[10, '400000000'], [11, '500000000'], [12, '650000000']]);
    const partial = await world([{ tag: 'CP', plan: '1000000000', payments: [[10, '100000000']], forecasts: [[11, '100000000']] }]);
    const gap = (await get(`?snapshot_id=${partial.snapshotId}`)).json.curve as Array<Record<string, unknown>>;
    expect(gap.find((point) => point.month === 11)?.forecast_cumulative_vnd).toBe('200000000');
    expect(gap.find((point) => point.month === 12)?.forecast_cumulative_vnd).toBeNull();
    // The curve takes the month that the cutoff is in from the snapshot, whatever the transactions say.
    expect(curveOf({ disbursedVnd: '500', planTotalVnd: '1', months: [], eacVnd: '500', gapVnd: '499', ratioPct: null, coverage: 'COMPLETE', reallocationCandidate: null, method: 'FORECAST_AND_REGISTERED' }, new Map([[1, '100']]), 2)).toEqual([
      { month: 1, actual_cumulative_vnd: '100', forecast_cumulative_vnd: null },
      { month: 2, actual_cumulative_vnd: '500', forecast_cumulative_vnd: '500' },
    ]);
  });

  it('takes the registration of a month that has no forecast, calls a month with neither missing (not zero), tells the estimate partial, and calls no reallocation on a lower bound', async () => {
    const w = await world([
      { tag: 'R1', plan: '1000000000', payments: [[10, '400000000']], forecasts: [[12, '150000000']], registered: [[11, '90000000']] },
      { tag: 'R2', plan: '500000000', payments: [[10, '100000000']], forecasts: [[11, '50000000']] },
    ]);
    const reply = await get(`?snapshot_id=${w.snapshotId}`);
    const byTag = (tag: string): ProjectView => projectsOf(reply).find((entry) => String(entry.project.code).endsWith(tag)) as ProjectView;
    expect(byTag('R1')).toMatchObject({ eac_vnd: '640000000', coverage: 'COMPLETE', reallocation_candidate: true, months: [{ month: 11, amount_vnd: '90000000', source: 'REGISTERED' }, { month: 12, amount_vnd: '150000000', source: 'FORECAST' }] });
    expect(byTag('R2')).toMatchObject({ eac_vnd: '150000000', coverage: 'PARTIAL', reallocation_candidate: null, months: [{ month: 11, amount_vnd: '50000000', source: 'FORECAST' }, { month: 12, amount_vnd: null, source: 'MISSING' }] });
    expect(reply.json).toMatchObject({ disbursed_vnd: '500000000', eac_vnd: '790000000', plan_total_vnd: '1500000000', gap_vnd: '-710000000', coverage: 'PARTIAL', reallocation_candidate: null, method: 'FORECAST_AND_REGISTERED_PARTIAL' });
  });

  it('says nothing is known of a project the Treasury booked nothing for (no estimate, not zero), and keeps the others a lower bound', async () => {
    const w = await world([
      { tag: 'N1', plan: '1000000000', payments: [[10, '400000000']], forecasts: [[11, '100000000'], [12, '150000000']] },
      { tag: 'N2', plan: '300000000', forecasts: [[11, '10'], [12, '10']] },
    ]);
    const reply = await get(`?snapshot_id=${w.snapshotId}`);
    expect(projectsOf(reply).find((entry) => String(entry.project.code).endsWith('N2'))).toMatchObject({ disbursed_vnd: null, eac_vnd: null, gap_vnd: null, coverage: 'NONE', reallocation_candidate: null, method: 'NO_TREASURY_DATA' });
    expect(reply.json).toMatchObject({ disbursed_vnd: '400000000', eac_vnd: '650000000', plan_total_vnd: '1300000000', coverage: 'PARTIAL', reallocation_candidate: null });
  });

  it('reads only the projects in the scope of the caller (the totals too), by unit and by project, and a project that is not theirs does not exist for them', async () => {
    const w = await world([
      { tag: 'S1', plan: '100', payments: [[10, '40']], forecasts: [[11, '10'], [12, '10']] },
      { tag: 'S2', plan: '200', unit: ELSEWHERE, payments: [[10, '80']], forecasts: [[11, '20'], [12, '20']] },
    ]);
    const all = await get(`?snapshot_id=${w.snapshotId}`);
    expect(all.json).toMatchObject({ disbursed_vnd: '120', plan_total_vnd: '300', eac_vnd: '180' });
    const here = await get(`?snapshot_id=${w.snapshotId}`, HERE_READER);
    expect(here.json).toMatchObject({ disbursed_vnd: '40', plan_total_vnd: '100', eac_vnd: '60' });
    expect(projectsOf(here).map((entry) => entry.project.id)).toEqual([w.projects[0]?.id]);
    expect((await get(`?snapshot_id=${w.snapshotId}&unit_id=${unitId(ELSEWHERE)}`)).json).toMatchObject({ disbursed_vnd: '80', plan_total_vnd: '200', eac_vnd: '120' });
    expect((await get(`?snapshot_id=${w.snapshotId}&project_id=${w.projects[1]?.id}`, HERE_READER)).status).toBe(404);
    const one = await get(`?snapshot_id=${w.snapshotId}&project_id=${w.projects[1]?.id}`);
    expect(one.json).toMatchObject({ project_id: w.projects[1]?.id, eac_vnd: '120', disbursed_vnd: '80' });
    expect(await get(`?snapshot_id=${w.snapshotId}`, NOBODY)).toMatchObject({ status: 403 });
    expect((await get(`?snapshot_id=${w.snapshotId}`, B_READER, TENANT_B)).status).toBe(404);
  });

  it('pages the projects by cursor in the order of their code with the totals of all of them, and judges the query: the ids, the snapshot, the cursor and the limit', async () => {
    const w = await world([
      { tag: 'P1', plan: '10', payments: [[10, '1']] },
      { tag: 'P2', plan: '10', payments: [[10, '2']] },
      { tag: 'P3', plan: '10', payments: [[10, '3']] },
    ]);
    const first = await get(`?snapshot_id=${w.snapshotId}&limit=2`);
    expect(projectsOf(first).map((entry) => entry.project.code)).toEqual([w.projects[0]?.code, w.projects[1]?.code]);
    expect(first.json.disbursed_vnd).toBe('6');
    const rest = await get(`?snapshot_id=${w.snapshotId}&limit=2&cursor=${first.json.next_cursor as string}`);
    expect(projectsOf(rest).map((entry) => entry.project.code)).toEqual([w.projects[2]?.code]);
    expect(rest.json.next_cursor).toBeNull();
    for (const [query, detail] of [['?snapshot_id=nope', 'snapshot_id'], ['?project_id=nope', 'project_id'], ['?unit_id=nope', 'unit_id'], ['?limit=0', 'limit'], ['?cursor=nope', 'cursor']] as const) {
      expect(await get(query)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail } });
    }
  });

  it('refuses a snapshot that is not frozen (422 SNAPSHOT_NOT_FROZEN) and one that does not exist (404), and opens on the latest frozen close snapshot when none is named', async () => {
    const built = await world([{ tag: 'B1', plan: '10', payments: [[10, '1']] }], { frozen: false });
    expect(await get(`?snapshot_id=${built.snapshotId}`)).toMatchObject({ status: 422, json: { code: 'SNAPSHOT_NOT_FROZEN', detail: 'snapshot_id' } });
    expect((await get(`?snapshot_id=${randomUUID()}`)).status).toBe(404);
    const latest = await world([{ tag: 'L1', plan: '10', payments: [[10, '1']] }]);
    expect((await get('')).json.snapshot_id).toBe(latest.snapshotId);
    // A tenant with no frozen snapshot has nothing to estimate.
    expect((await get('', B_READER, TENANT_B)).status).toBe(404);
  });

  it('puts the cutoff of the snapshot at the month the estimate starts from: a snapshot of March estimates April to December, and one of December has nothing after it', async () => {
    const march = await world([{ tag: 'M1', plan: '1000', payments: [[3, '100']], forecasts: [[4, '10'], [5, '10'], [6, '10'], [7, '10'], [8, '10'], [9, '10'], [10, '10'], [11, '10'], [12, '10']] }], { cutoff: '2027-03-31' });
    expect((await get(`?snapshot_id=${march.snapshotId}`)).json).toMatchObject({ cutoff_month: 3, eac_vnd: '190', coverage: 'COMPLETE', reallocation_candidate: true });
    const december = await world([{ tag: 'D1', plan: '1000', payments: [[10, '900']] }], { cutoff: '2027-12-31' });
    expect((await get(`?snapshot_id=${december.snapshotId}`)).json).toMatchObject({ cutoff_month: 12, months: [], eac_vnd: '900', coverage: 'COMPLETE', reallocation_candidate: false });
  });

  it('takes the plan year from the fiscal year of the period of the snapshot: a close of December of 2027 whose cutoff is in January 2028 is in the adjustment month of 2027, not the start of a new year, and the schedule of that month is not added to a figure that already holds it', async () => {
    const w = await world([{ tag: 'Y1', plan: '1000', payments: [[10, '900']], forecasts: [[11, '5'], [13, '50']] }], { cutoff: '2028-01-15' });
    const reply = await get(`?snapshot_id=${w.snapshotId}`);
    expect(reply.json).toMatchObject({ plan_year: 2027, cutoff_month: 13, treasury_cutoff_date: '2028-01-15', months: [], disbursed_vnd: '900', eac_vnd: '900', coverage: 'COMPLETE' });
    const curve = reply.json.curve as Array<Record<string, unknown>>;
    expect(curve.map((point) => point.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(curve[11]).toMatchObject({ month: 12, actual_cumulative_vnd: '900', forecast_cumulative_vnd: null });
    expect(curve[12]).toMatchObject({ month: 13, actual_cumulative_vnd: '900', forecast_cumulative_vnd: '900' });
  });

  it('ends the curve at the estimate: the months of a project that has no Treasury data are not in it, so December is the same number as the estimate', async () => {
    const w = await world([
      { tag: 'K1', plan: '1000000000', payments: [[10, '400000000']], forecasts: [[11, '100000000'], [12, '150000000']] },
      { tag: 'K2', plan: '300000000', forecasts: [[11, '10'], [12, '10']] },
    ]);
    const reply = await get(`?snapshot_id=${w.snapshotId}`);
    const curve = reply.json.curve as Array<Record<string, unknown>>;
    expect(reply.json.eac_vnd).toBe('650000000');
    expect(curve.find((point) => point.month === 12)?.forecast_cumulative_vnd).toBe('650000000');
    expect((reply.json.months as Array<Record<string, unknown>>).find((month) => month.month === 12)?.amount_vnd).toBe('150000000');
  });

  it('stops the curve at a month that one of the projects has no figure for, instead of carrying on with the sum of the others', async () => {
    const w = await world([
      { tag: 'G1', plan: '1000', payments: [[10, '400']], forecasts: [[11, '100'], [12, '150']] },
      { tag: 'G2', plan: '1000', payments: [[10, '100']], forecasts: [[11, '50']] },
    ]);
    const reply = await get(`?snapshot_id=${w.snapshotId}`);
    const curve = reply.json.curve as Array<Record<string, unknown>>;
    expect(curve.find((point) => point.month === 11)?.forecast_cumulative_vnd).toBe('650');
    expect(curve.find((point) => point.month === 12)?.forecast_cumulative_vnd).toBeNull();
    expect(reply.json).toMatchObject({ eac_vnd: '800', coverage: 'PARTIAL', reallocation_candidate: null });
  });
});
