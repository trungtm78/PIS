import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTERPRISE_BI_DATASET_DEFINITIONS, biDatasetsOfEdition, generateBiPassword, scramVerifierOf } from '@machvon/kernel';
import { Client } from 'pg';
import { BiReaderStore } from '../src/int-bi-reader-store';
import { ExportDatasetStore } from '../src/int-open-api-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, REPO_ROOT, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedSnapshot } from './support/dgv-quality-fixtures';

/**
 * INT-2: the certified dataset DS-ENT of the BI reader schema (V2960). A BI login of an enterprise tenant reads the FROZEN enterprise period snapshot (kind ENTERPRISE_CLOSE) through four views, behind the same gate
 * as the two datasets of INT-1: the tenant switched it on, its data product is CERTIFIED and has not run out. The tenant of a read is the one of the binding of the login, never `app.tenant_id` (R6, R13).
 */
const harness = new AuthzHarness();
const datasets = new ExportDatasetStore();
const readers = new BiReaderStore();
const MAKER = 1;
const CHECKER = 2;
const NOW = new Date('2026-11-08T03:00:00Z');
const REASON = 'A reason of ten characters';
const ENTERPRISE = biDatasetsOfEdition('enterprise');
const PERIOD_A = randomUUID();
const PERIOD_A_OTHER = randomUUID();
const PERIOD_B = randomUUID();
const PERIOD_B_YEAR = randomUUID();

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(MAKER)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

async function seedProduct(tenant: string, code: string): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.data_product (tenant_id, id, code, title, dataset_ids, owner_user_id, certification_status, certified_by, certified_at, certification_expires_on, evidence_refs, created_by, updated_by)
     values ($1, $2, $3, $3, $4::jsonb, $5, 'CERTIFIED', $6, now(), '2027-12-31'::date, '["evidence-1"]', $5, $5)`,
    [tenant, id, code, JSON.stringify([randomUUID()]), memberId(MAKER), memberId(CHECKER)],
    tenant,
  );
  return id;
}

interface Figure {
  project: string;
  unit: string;
  klass: string;
  kind: string;
  amount: string | null;
  grain?: string;
  ordinal?: number;
  measure?: string;
  tier?: string;
}

/** The figures of one cell as the figure engine freezes them for a month: the plan of the year, of the month and to date, the actual of the month and the cumulative of the year. */
function cell(project: string, unit: string, klass: string, figures: { planInForce: string | null; planToDate: string | null; actual: string | null; cumulative: string | null; planMonth?: string | null }, period: 'MONTH' | 'YEAR' = 'MONTH'): Figure[] {
  const year = period === 'YEAR';
  const row = (kind: string, amount: string | null, grain = year ? 'YEAR' : 'MONTH', ordinal = year ? 0 : 10): Figure => ({ project, unit, klass, kind, amount, grain, ordinal });
  return [
    row('PLAN_YEAR', figures.planInForce, 'YEAR', 0),
    row('PLAN_IN_FORCE', figures.planInForce, 'YEAR', 0),
    // The figure engine writes no plan row of its own for a year: the plan of a year period is the plan in force.
    ...(year ? [] : [row('PLAN_MONTH', figures.planMonth ?? null)]),
    row('PLAN_TO_DATE', figures.planToDate),
    row('ACTUAL', figures.actual),
    row('CUMULATIVE_YTD', figures.cumulative),
  ];
}

/** Writes an enterprise snapshot while it is BUILDING with its figures, then moves it on as the store does (the guards allow figures only while it is built). */
async function seedEnterpriseSnapshot(tenant: string, period: string, revision: number, status: 'BUILDING' | 'FROZEN' | 'SUPERSEDED', figures: Figure[], kind = 'ENTERPRISE_CLOSE'): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, taxonomy_pack, hash_schema, revision, created_by, updated_by)
     values ($1, $2, $3, $4, now(), date '2026-10-31', date '2026-10-31', 'BUILDING', 'ENT-SNAPSHOT-R1', 'SIGNED', $5, 'ENTERPRISE', 2, $6, $7, $7)`,
    [tenant, id, period, kind, figures.length, revision, memberId(MAKER)],
    tenant,
  );
  for (const one of figures) {
    await owner(
      `insert into machvon.period_snapshot_figure (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal, amount_vnd, null_reason, basis)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9, 2026, $10, $11::numeric, $12, 'PLAN_DECISION')`,
      [tenant, id, one.project, one.unit, one.klass, one.tier ?? 'ALL', one.measure ?? 'DISBURSED', one.kind, one.grain ?? 'MONTH', one.ordinal ?? 10, one.amount, one.amount === null ? 'NO_DATA' : null],
      tenant,
    );
  }
  if (status !== 'BUILDING') {
    await owner("update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = $2, frozen_by = $3, frozen_at = now() where id = $1", [id, 'c'.repeat(64), memberId(CHECKER)], tenant);
    if (status === 'SUPERSEDED') await owner("update machvon.period_snapshot set status = 'SUPERSEDED' where id = $1", [id], tenant);
  }
  return id;
}

describe('the certified dataset DS-ENT for BI logins of an enterprise tenant (INT-2)', () => {
  const unit1 = unitId(1);
  const unit2 = unitId(2);
  const [p1, p2, p3] = [randomUUID(), randomUUID(), randomUUID()];
  const passwords = new Map<string, string>();
  const clients: Client[] = [];
  let readerA: Awaited<ReturnType<BiReaderStore['provision']>>;
  let readerB: Awaited<ReturnType<BiReaderStore['provision']>>;
  let productA: string;
  let productB: string;
  let snapshotA: string;
  let supersededA: string;
  let publicSnapshotA: { id: string };

  const urlOf = (login: string, password: string): string => {
    const url = new URL(harness.database.urlFor('machvon_app'));
    url.username = login;
    url.password = password;
    return url.toString();
  };

  async function connect(reader: { loginName: string }): Promise<Client> {
    const client = new Client({ connectionString: urlOf(reader.loginName, passwords.get(reader.loginName) as string) });
    client.on('error', () => undefined);
    await client.connect();
    clients.push(client);
    return client;
  }

  async function provision(tenant: string, name: string): Promise<Awaited<ReturnType<BiReaderStore['provision']>>> {
    const password = generateBiPassword();
    const row = await as((tx) => readers.provision(tx, tenant, { name, tool: 'Power BI', connectionLimit: 5 }, scramVerifierOf(password), memberId(MAKER)), tenant);
    passwords.set(row.loginName, password);
    return row;
  }

  const rowsOf = async (client: Client, sql: string): Promise<Record<string, unknown>[]> => (await client.query(sql)).rows as Record<string, unknown>[];
  const stateOf = async (tenant: string, code: string): Promise<{ version: number }> => ((await as((tx) => datasets.state(tx, NOW, ENTERPRISE), tenant)).find((row) => row.datasetCode === code) as { version: number });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unit1}/` },
        { n: 2, path: `/${unit2}/` },
      ]);
      for (const member of [MAKER, CHECKER]) await harness.seedMembership(tenant, member, 1);
    }
    await dropSnapshotFixtureKeys(harness, TENANT_A);
    // Tenant A: an old revision (superseded) and the official one of the period, a snapshot still being built, and the public close snapshot of the tenant.
    supersededA = await seedEnterpriseSnapshot(TENANT_A, PERIOD_A, 1, 'SUPERSEDED', cell(randomUUID(), unit1, 'EQUITY', { planInForce: '9999', planToDate: '9999', actual: '9999', cumulative: '9999' }));
    snapshotA = await seedEnterpriseSnapshot(TENANT_A, PERIOD_A, 2, 'FROZEN', [
      ...cell(p1, unit1, 'EQUITY', { planInForce: '1000', planToDate: '800', actual: '90', cumulative: '400', planMonth: '100' }),
      ...cell(p1, unit1, 'LOAN', { planInForce: '3000', planToDate: '2000', actual: '300', cumulative: '1200' }),
      { project: p1, unit: unit1, klass: 'TOTAL', tier: 'ALL', kind: 'TMDT_IN_FORCE', amount: '50000', grain: 'YEAR', ordinal: 0 },
      ...cell(p2, unit1, 'EQUITY', { planInForce: '0', planToDate: '0', actual: '0', cumulative: '0' }),
      ...cell(p3, unit2, 'OTHER', { planInForce: '500', planToDate: '250', actual: '50', cumulative: '100' }),
    ]);
    await seedEnterpriseSnapshot(TENANT_A, PERIOD_A_OTHER, 1, 'BUILDING', cell(p1, unit1, 'EQUITY', { planInForce: '1', planToDate: '1', actual: '1', cumulative: '1' }));
    await seedEnterpriseSnapshot(TENANT_A, randomUUID(), 1, 'FROZEN', cell(p1, unit1, 'EQUITY', { planInForce: '2', planToDate: '2', actual: '2', cumulative: '2' }), 'ADHOC');
    publicSnapshotA = await seedSnapshot(harness, TENANT_A, MAKER, { lines: [{}, {}] });
    // A figure row of a PUBLIC snapshot (FND-1 keeps those in the same table): written while the snapshot was built.
    const publicBuilding = await seedSnapshot(harness, TENANT_A, MAKER, { lines: [{}], status: 'BUILDING' });
    await owner(
      `insert into machvon.period_snapshot_figure (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal, amount_vnd, basis)
       values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 'DISBURSED', 'ACTUAL', 'MONTH', 2026, 10, 123456, 'TREASURY')`,
      [TENANT_A, publicBuilding.id, randomUUID(), unit1],
    );
    await owner("update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = $2, frozen_by = $3, frozen_at = now() where id = $1", [publicBuilding.id, 'd'.repeat(64), memberId(CHECKER)]);
    // Tenant B: one official snapshot with figures of its own.
    await seedEnterpriseSnapshot(TENANT_B, PERIOD_B, 1, 'FROZEN', cell(randomUUID(), unit1, 'EQUITY', { planInForce: '777', planToDate: '700', actual: '7', cumulative: '77' }));
    await seedEnterpriseSnapshot(TENANT_B, PERIOD_B_YEAR, 1, 'FROZEN', cell(randomUUID(), unit1, 'LOAN', { planInForce: '600', planToDate: '600', actual: '5', cumulative: '55' }, 'YEAR'));
    productA = await seedProduct(TENANT_A, 'DP-ENT-A');
    productB = await seedProduct(TENANT_B, 'DP-ENT-B');
    readerA = await provision(TENANT_A, 'Power BI A');
    readerB = await provision(TENANT_B, 'Power BI B');
  }, 240_000);

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end().catch(() => undefined)));
  });

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  const VIEWS = ENTERPRISE_BI_DATASET_DEFINITIONS['DS-ENT'].views.map((one) => one.view);

  it('is closed until the tenant switches it on, and the catalogue says why; the catalogue of INT-1 is untouched', async () => {
    const client = await connect(readerA);
    for (const view of VIEWS) expect([view, await rowsOf(client, `select * from ${view}`)]).toEqual([view, []]);
    const catalogue = await rowsOf(client, 'select dataset_code, view_name, is_open, reason from v_enterprise_dataset_catalogue order by view_name');
    expect(catalogue.map((row) => [row.dataset_code, row.view_name, row.is_open, row.reason])).toEqual(VIEWS.slice().sort().map((view) => ['DS-ENT', view, false, 'DISABLED']));
    expect((await rowsOf(client, 'select dataset_code from v_dataset_catalogue order by dataset_code')).map((row) => row.dataset_code)).toEqual(['DS-CTR', 'DS-DISB']);
    // The granted columns of the tables are closed with the dataset: the gate is not a thing a login walks around by reading the tables.
    for (const sql of ['select tenant_id, id from machvon.period_snapshot', 'select tenant_id, snapshot_id from machvon.period_snapshot_figure']) expect([sql, await rowsOf(client, sql)]).toEqual([sql, []]);
  });

  it('audits every read of a login as a session, so a direct read of the granted columns is in the log as well (V2961)', async () => {
    const settings = await owner<{ setconfig: string[] }>('select s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = $1', [readerA.loginName]);
    expect(settings[0]?.setconfig).toEqual(expect.arrayContaining(['pgaudit.log=read', 'default_transaction_read_only=on']));
  });

  it('is offered by the enterprise edition only: the public list has no way to switch it on', async () => {
    expect(biDatasetsOfEdition('public')).toEqual(['DS-DISB', 'DS-CTR']);
    expect(await as((tx) => datasets.state(tx, NOW))).toHaveLength(2);
    await expect(as((tx) => datasets.set(tx, 'DS-ENT', 1, { enabled: true, productId: productA, reason: REASON }, memberId(MAKER), NOW))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(await owner('select 1 from machvon.int_export_dataset')).toEqual([]);
    // The database holds the list too: a code that is no dataset is refused whatever the application says.
    expect(await databaseRefusal(owner("insert into machvon.int_export_dataset (tenant_id, dataset_code, product_id, enabled, state_changed_by, created_by, updated_by) values ($1, 'DS-XYZ', $2, false, $3, $3, $3)", [TENANT_A, productA, memberId(MAKER)]))).toMatch(
      /int_export_dataset_code_chk/,
    );
  });

  describe('with the dataset switched on for both tenants', () => {
    beforeAll(async () => {
      for (const [tenant, product] of [[TENANT_A, productA], [TENANT_B, productB]] as const) {
        const before = await stateOf(tenant, 'DS-ENT');
        const done = await as((tx) => datasets.set(tx, 'DS-ENT', before.version, { enabled: true, productId: product, reason: REASON }, memberId(MAKER), NOW, ENTERPRISE), tenant);
        expect(done.row.gate).toEqual({ open: true });
      }
    });

    it('lists the four views as open in the catalogue of the dataset', async () => {
      const client = await connect(readerA);
      const catalogue = await rowsOf(client, 'select view_name, is_open, reason from v_enterprise_dataset_catalogue order by view_name');
      expect(catalogue.map((row) => [row.view_name, row.is_open, row.reason])).toEqual(VIEWS.slice().sort().map((view) => [view, true, 'OPEN']));
    });

    it('has the columns the kernel documents, in the same order', async () => {
      const client = await connect(readerA);
      for (const one of ENTERPRISE_BI_DATASET_DEFINITIONS['DS-ENT'].views) {
        const columns = await rowsOf(client, `select column_name from information_schema.columns where table_schema = 'machvon_bi' and table_name = '${one.view}' order by ordinal_position`);
        expect([one.view, columns.map((row) => row.column_name)]).toEqual([one.view, [...one.columns]]);
      }
    });

    it('v_enterprise_figures: the figures of the official snapshot of the tenant only, nulls with their reason, no old revision, no draft, no public figure', async () => {
      const a = await connect(readerA);
      const rows = await rowsOf(a, 'select * from v_enterprise_figures');
      expect(new Set(rows.map((row) => row.tenant_id))).toEqual(new Set([TENANT_A]));
      expect(new Set(rows.map((row) => row.snapshot_id))).toEqual(new Set([snapshotA]));
      expect(new Set(rows.map((row) => row.revision))).toEqual(new Set([2]));
      expect(rows).toHaveLength(6 + 6 + 1 + 6 + 6);
      const total = rows.filter((row) => row.class_code === 'TOTAL');
      expect(total).toHaveLength(1);
      expect(total[0]).toMatchObject({ figure_kind: 'TMDT_IN_FORCE', amount_vnd: '50000', project_id: p1 });
      expect(rows.some((row) => row.amount_vnd === '9999' || row.amount_vnd === '123456')).toBe(false);
      // A figure nobody has is a row without an amount and with its reason, never a zero.
      const missing = await rowsOf(a, "select amount_vnd, null_reason from v_enterprise_figures where figure_kind = 'PLAN_MONTH' and project_id = '" + p2 + "'");
      expect(missing).toEqual([{ amount_vnd: null, null_reason: 'NO_DATA' }]);
      expect(await rowsOf(await connect(readerB), 'select amount_vnd from v_enterprise_figures where figure_kind = \'CUMULATIVE_YTD\' and period_id = \'' + PERIOD_B + '\'')).toEqual([{ amount_vnd: '77' }]);
    });

    it('v_enterprise_plan_actual: plan, actual and cumulative side by side, the rate sum over sum and null on a zero plan', async () => {
      const a = await connect(readerA);
      const rows = await rowsOf(
        a,
        `select project_id, class_code, period_grain, plan_year, period_ordinal, plan_year_vnd::text, plan_in_force_vnd::text, plan_period_vnd::text, plan_to_date_vnd::text, actual_vnd::text, cumulative_ytd_vnd::text, rate_in_force_pct::text, rate_to_date_pct::text
           from v_enterprise_plan_actual order by project_id, class_code`,
      );
      const byKey = new Map(rows.map((row) => [`${row.project_id}:${row.class_code}`, row]));
      expect(rows).toHaveLength(4);
      expect(byKey.get(`${p1}:EQUITY`)).toMatchObject({ period_grain: 'MONTH', plan_year: 2026, period_ordinal: 10, plan_year_vnd: '1000', plan_in_force_vnd: '1000', plan_period_vnd: '100', plan_to_date_vnd: '800', actual_vnd: '90', cumulative_ytd_vnd: '400', rate_in_force_pct: '40.0000', rate_to_date_pct: '50.0000' });
      expect(byKey.get(`${p1}:LOAN`)).toMatchObject({ plan_in_force_vnd: '3000', cumulative_ytd_vnd: '1200', rate_in_force_pct: '40.0000', rate_to_date_pct: '60.0000', plan_period_vnd: null });
      expect(byKey.get(`${p2}:EQUITY`)).toMatchObject({ plan_in_force_vnd: '0', cumulative_ytd_vnd: '0', rate_in_force_pct: null, rate_to_date_pct: null });
      expect(byKey.get(`${p3}:OTHER`)).toMatchObject({ rate_in_force_pct: '20.0000', rate_to_date_pct: '40.0000' });
      expect(rows.some((row) => row.class_code === 'TOTAL')).toBe(false);
    });

    it('v_enterprise_plan_actual: the plan of a year period is the plan of the year in force, and the plan of a month stays the plan of the month', async () => {
      const b = await connect(readerB);
      const year = await rowsOf(b, `select period_grain, period_ordinal, plan_in_force_vnd::text, plan_period_vnd::text, rate_in_force_pct::text from v_enterprise_plan_actual where period_id = '${PERIOD_B_YEAR}'`);
      expect(year).toEqual([{ period_grain: 'YEAR', period_ordinal: 0, plan_in_force_vnd: '600', plan_period_vnd: '600', rate_in_force_pct: '9.1667' }]);
      const month = await rowsOf(b, `select period_grain, plan_period_vnd::text from v_enterprise_plan_actual where period_id = '${PERIOD_B}'`);
      expect(month).toEqual([{ period_grain: 'MONTH', plan_period_vnd: null }]);
    });

    it('v_enterprise_funding_split: equity, loan and other side by side with their share of the cumulative', async () => {
      const a = await connect(readerA);
      const rows = await rowsOf(
        a,
        `select project_id, plan_in_force_equity_vnd::text, plan_in_force_loan_vnd::text, plan_in_force_other_vnd::text, plan_in_force_total_vnd::text, cumulative_ytd_equity_vnd::text, cumulative_ytd_loan_vnd::text,
                cumulative_ytd_other_vnd::text, cumulative_ytd_total_vnd::text, equity_share_pct::text, loan_share_pct::text
           from v_enterprise_funding_split order by project_id`,
      );
      const byProject = new Map(rows.map((row) => [row.project_id, row]));
      expect(rows).toHaveLength(3);
      expect(byProject.get(p1)).toEqual({
        project_id: p1,
        plan_in_force_equity_vnd: '1000',
        plan_in_force_loan_vnd: '3000',
        plan_in_force_other_vnd: null,
        plan_in_force_total_vnd: '4000',
        cumulative_ytd_equity_vnd: '400',
        cumulative_ytd_loan_vnd: '1200',
        cumulative_ytd_other_vnd: null,
        cumulative_ytd_total_vnd: '1600',
        equity_share_pct: '25.0000',
        loan_share_pct: '75.0000',
      });
      expect(byProject.get(p2)).toMatchObject({ cumulative_ytd_total_vnd: '0', equity_share_pct: null, loan_share_pct: null });
      expect(byProject.get(p3)).toMatchObject({ cumulative_ytd_equity_vnd: null, cumulative_ytd_loan_vnd: null, cumulative_ytd_other_vnd: '100', equity_share_pct: '0.0000', loan_share_pct: '0.0000' });
    });

    it('v_enterprise_by_unit: the sums by unit and for the tenant, the rate made from the sums and not the average of the rates', async () => {
      const a = await connect(readerA);
      const rows = await rowsOf(
        a,
        `select level, unit_id, project_count::int as project_count, plan_in_force_vnd::text, plan_to_date_vnd::text, actual_vnd::text, cumulative_ytd_vnd::text, rate_in_force_pct::text, rate_to_date_pct::text,
                cumulative_ytd_equity_vnd::text, cumulative_ytd_loan_vnd::text, cumulative_ytd_other_vnd::text, equity_share_pct::text
           from v_enterprise_by_unit order by level desc, unit_id`,
      );
      expect(rows).toEqual([
        { level: 'UNIT', unit_id: unit1, project_count: 2, plan_in_force_vnd: '4000', plan_to_date_vnd: '2800', actual_vnd: '390', cumulative_ytd_vnd: '1600', rate_in_force_pct: '40.0000', rate_to_date_pct: '57.1429', cumulative_ytd_equity_vnd: '400', cumulative_ytd_loan_vnd: '1200', cumulative_ytd_other_vnd: null, equity_share_pct: '25.0000' },
        { level: 'UNIT', unit_id: unit2, project_count: 1, plan_in_force_vnd: '500', plan_to_date_vnd: '250', actual_vnd: '50', cumulative_ytd_vnd: '100', rate_in_force_pct: '20.0000', rate_to_date_pct: '40.0000', cumulative_ytd_equity_vnd: null, cumulative_ytd_loan_vnd: null, cumulative_ytd_other_vnd: '100', equity_share_pct: '0.0000' },
        { level: 'TENANT', unit_id: null, project_count: 3, plan_in_force_vnd: '4500', plan_to_date_vnd: '3050', actual_vnd: '440', cumulative_ytd_vnd: '1700', rate_in_force_pct: '37.7778', rate_to_date_pct: '55.7377', cumulative_ytd_equity_vnd: '400', cumulative_ytd_loan_vnd: '1200', cumulative_ytd_other_vnd: '100', equity_share_pct: '23.5294' },
      ]);
    });

    it('runs the sample queries 12 to 18 of the Power BI documentation as they are written', async () => {
      const text = readFileSync(join(REPO_ROOT, 'docs', 'integration', 'power-bi-sample-queries.sql'), 'utf8').replace(/\r\n/g, '\n');
      const numbered = text.split(/^-- (\d+)\. /m);
      const queries = new Map<number, string>();
      for (let index = 1; index < numbered.length; index += 2) {
        // The first line of the block is the rest of the title; the comment lines that follow are not SQL.
        const body = (numbered[index + 1] as string).split('\n').slice(1).filter((line) => !line.startsWith('--'));
        queries.set(Number(numbered[index]), body.join('\n').trim());
      }
      const a = await connect(readerA);
      for (const number of [12, 13, 14, 15, 16, 17, 18]) {
        const sql = queries.get(number) as string;
        expect([number, sql.startsWith('SELECT')]).toEqual([number, true]);
        const rows = await rowsOf(a, sql.replace(/;\s*$/, ''));
        // Every query has rows in this fixture (17 lists the figure of the month that nobody has).
        expect([number, rows.length > 0]).toEqual([number, true]);
      }
      const byUnit = await rowsOf(a, (queries.get(15) as string).replace(/;\s*$/, ''));
      expect(byUnit.filter((row) => row.level === 'TENANT')).toHaveLength(1);
      expect(byUnit.filter((row) => row.level === 'UNIT')).toHaveLength(2);
    });

    it('NEGATIVE (R13): a login that sets app.tenant_id to another tenant reads NOTHING, from the views and from the granted columns of the tables', async () => {
      const a = await connect(readerA);
      for (const view of VIEWS) expect((await rowsOf(a, `select 1 from ${view}`)).length).toBeGreaterThan(0);
      await a.query("select set_config('app.tenant_id', $1, false)", [TENANT_B]);
      expect((await rowsOf(a, "select current_setting('app.tenant_id') as t"))[0]).toEqual({ t: TENANT_B });
      for (const view of VIEWS) expect([view, await rowsOf(a, `select * from ${view}`)]).toEqual([view, []]);
      for (const sql of ['select tenant_id, id from machvon.period_snapshot', 'select tenant_id, snapshot_id from machvon.period_snapshot_figure']) expect([sql, await rowsOf(a, sql)]).toEqual([sql, []]);
      await a.query("select set_config('app.tenant_id', '', false)");
      for (const view of VIEWS) expect([view, await rowsOf(a, `select * from ${view}`)]).toEqual([view, []]);
      await a.query('reset app.tenant_id');
      expect((await rowsOf(a, 'select distinct tenant_id from v_enterprise_figures'))).toEqual([{ tenant_id: TENANT_A }]);
      // The same from the other side: the login of B naming A reads nothing of A.
      const b = await connect(readerB);
      await b.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
      for (const view of VIEWS) expect([view, await rowsOf(b, `select * from ${view}`)]).toEqual([view, []]);
      expect(await rowsOf(b, 'select tenant_id from machvon.period_snapshot_figure')).toEqual([]);
    });

    it('shows a reader of DS-ENT the headers of the enterprise snapshots only, and the figures of no public snapshot', async () => {
      const a = await connect(readerA);
      const headers = await rowsOf(a, 'select id, snapshot_kind, status, revision from machvon.period_snapshot order by revision');
      expect(headers).toEqual([{ id: snapshotA, snapshot_kind: 'ENTERPRISE_CLOSE', status: 'FROZEN', revision: 2 }]);
      expect(headers.some((row) => row.id === supersededA || row.id === publicSnapshotA.id)).toBe(false);
      expect(await rowsOf(a, 'select 1 from v_disbursement_lines')).toEqual([]);
      const figures = await rowsOf(a, 'select distinct snapshot_id from machvon.period_snapshot_figure');
      expect(figures).toEqual([{ snapshot_id: snapshotA }]);
    });

    it('reads nothing else and writes nothing: the columns the views do not use stay closed', async () => {
      const a = await connect(readerA);
      for (const sql of [
        'select source_figure_id from machvon.period_snapshot_figure',
        'select id from machvon.period_snapshot_figure',
        'select * from machvon.period_snapshot_figure',
        'select * from machvon.period_snapshot_indicator',
        'select payload_sha256 from machvon.period_snapshot',
        'select frozen_by from machvon.period_snapshot',
      ]) {
        expect([sql, await databaseRefusal(a.query(sql))]).toEqual([sql, expect.stringMatching(/permission denied/)]);
      }
      for (const sql of [
        "update machvon.period_snapshot_figure set amount_vnd = 0",
        'delete from machvon.period_snapshot_figure',
        'create table machvon_bi.mine (a int)',
        'create temp table t as select * from v_enterprise_figures',
      ]) {
        expect([sql, await databaseRefusal(a.query(sql))]).toEqual([sql, expect.stringMatching(/permission denied|read-only|must be owner|cannot/)]);
      }
    });

    it('closes with the certification of the product and reopens with it, without touching the datasets of INT-1', async () => {
      const a = await connect(readerA);
      await owner("update machvon.data_product set certification_expires_on = (now() at time zone 'Asia/Ho_Chi_Minh')::date where id = $1", [productA]);
      for (const view of VIEWS) expect([view, await rowsOf(a, `select 1 from ${view}`)]).toEqual([view, []]);
      expect(await rowsOf(a, 'select 1 from machvon.period_snapshot_figure')).toEqual([]);
      expect((await rowsOf(a, "select distinct reason from v_enterprise_dataset_catalogue"))).toEqual([{ reason: 'EXPIRED' }]);
      await owner("update machvon.data_product set certification_expires_on = (now() at time zone 'Asia/Ho_Chi_Minh')::date + 30 where id = $1", [productA]);
      expect((await rowsOf(a, 'select 1 from v_enterprise_figures')).length).toBeGreaterThan(0);
      await owner("update machvon.data_product set certification_status = 'REVOKED', revoke_reason = 'Revoked in the test for the gate' where id = $1", [productA]);
      for (const view of VIEWS) expect([view, await rowsOf(a, `select 1 from ${view}`)]).toEqual([view, []]);
      expect((await rowsOf(a, 'select distinct reason from v_enterprise_dataset_catalogue'))).toEqual([{ reason: 'NOT_CERTIFIED' }]);
      // The other tenant keeps its own product, so it keeps its own figures.
      expect((await rowsOf(await connect(readerB), 'select 1 from v_enterprise_figures')).length).toBeGreaterThan(0);
    });

    it('is independent of DS-DISB and DS-CTR: opening those does not open DS-ENT, and closing DS-ENT keeps them open', async () => {
      const b = await connect(readerB);
      const before = await stateOf(TENANT_B, 'DS-ENT');
      await as((tx) => datasets.set(tx, 'DS-ENT', before.version, { enabled: false, productId: null, reason: REASON }, memberId(MAKER), NOW, ENTERPRISE), TENANT_B);
      for (const view of VIEWS) expect([view, await rowsOf(b, `select 1 from ${view}`)]).toEqual([view, []]);
      const disb = await stateOf(TENANT_B, 'DS-DISB');
      await as((tx) => datasets.set(tx, 'DS-DISB', disb.version, { enabled: true, productId: productB, reason: REASON }, memberId(MAKER), NOW, ENTERPRISE), TENANT_B);
      // DS-DISB is open now: its own view answers, the enterprise views stay closed, and the headers of the enterprise snapshot are not shown on its account.
      expect((await rowsOf(b, 'select 1 from v_dataset_catalogue where dataset_code = \'DS-DISB\' and is_open')).length).toBe(1);
      for (const view of VIEWS) expect([view, await rowsOf(b, `select 1 from ${view}`)]).toEqual([view, []]);
      expect(await rowsOf(b, "select 1 from machvon.period_snapshot where snapshot_kind = 'ENTERPRISE_CLOSE'")).toEqual([]);
    });
  });
});
