import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DIS_MOBILE_COMMANDS, DIS_SYNC_BUCKETS, DIS_SYNC_TABLES, DIS_SYNC_TRANSLATION, bindSyncQuery, mobileContractMarkdown, operationFacts, syncRulesYaml } from '@machvon/contracts';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';

const ROOT_DIR = join(__dirname, '..', '..', '..', '..');
const OPENAPI = JSON.parse(readFileSync(join(ROOT_DIR, 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json'), 'utf8')) as Parameters<typeof mobileContractMarkdown>[0];
const normal = (text: string): string => text.replace(/\r\n/g, '\n');
const ROOT = 1;
const HERE = 2;
const ELSEWHERE = 3;
const FAMILY = 0xa9;
const WORKER = '00000000-0000-4000-8000-000000000000';
const M_HERE = 1; // a scope on the unit HERE and what is under it
const M_PROJECT = 2; // a scope on one project of ELSEWHERE
const M_NONE = 3; // one scope row, which names a project of another tenant
const M_NOBODY = 5; // no scope row at all
const M_OTHER = 4; // writes the drafts that M_HERE must not receive

type Row = Record<string, unknown>;

/** The sync rules of the weekly report run on PostgreSQL as the replication reader would: with no row-level security, so that the queries are all there is between a phone and the rows of other tenants (ST-DIS-017). */
describe('the sync rules of the weekly report for the phone (ST-DIS-017)', () => {
  const harness = new AuthzHarness();
  let client: Client;
  const world = {
    projects: {} as Record<string, string>,
    periods: {} as Record<string, string>,
    reports: {} as Record<string, string>,
  };

  async function exec(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await client.query(sql, params)).rows as Row[];
  }

  /** The rows a device gets for one bucket: the parameter query with the claims of its token, then each data query once for each row of parameters, the rows once each. */
  async function bucket(name: string, claims: { tenant: string; membership: string }): Promise<Record<string, Row[]>> {
    const definition = DIS_SYNC_BUCKETS.find((each) => each.name === name);
    if (definition === undefined) throw new Error(`no bucket ${name}`);
    const parameters = await exec(bindSyncQuery(definition.parameters, { tenant: claims.tenant, membership: claims.membership }));
    const received: Record<string, Map<string, Row>> = {};
    for (const entry of definition.data) received[entry.table] = new Map();
    for (const parameter of parameters) {
      for (const entry of definition.data) {
        const values: Parameters<typeof bindSyncQuery>[1] = { bucketTenant: String(parameter.tenant_id) };
        if (parameter.scope_kind !== undefined) values.bucketKind = String(parameter.scope_kind);
        if (parameter.scope_ref_id !== undefined) values.bucketRef = String(parameter.scope_ref_id);
        if (parameter.membership_id !== undefined) values.bucketMembership = String(parameter.membership_id);
        for (const row of await exec(bindSyncQuery(entry.query, values))) (received[entry.table] as Map<string, Row>).set(String(row.id), row);
      }
    }
    return Object.fromEntries(Object.entries(received).map(([table, rows]) => [table, [...rows.values()]]));
  }
  const ids = (rows: Row[] | undefined): string[] => (rows ?? []).map((row) => String(row.id)).sort();
  const claimsOf = (member: number, tenant = TENANT_A): { tenant: string; membership: string } => ({ tenant, membership: memberId(member) });
  const idsOf = (names: string[], from: Record<string, string>): string[] => names.map((name) => from[name] as string).sort();

  async function seed(): Promise<void> {
    await client.query('set session_replication_role = replica');
    // The queries name the tables as the sync service does, without the schema.
    await client.query('set search_path to machvon, public');
    const project = async (tag: string, tenant: string, unit: number): Promise<string> => {
      const projectId = id(FAMILY, 100 + Object.keys(world.projects).length);
      world.projects[tag] = projectId;
      await exec(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 5000000000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, projectId, `SY-${tag}`, unitId(unit), id(FAMILY, 30)],
      );
      return projectId;
    };
    const period = async (tag: string, tenant: string, status: string, offset: number): Promise<string> => {
      const periodId = id(FAMILY, 1000 + Object.keys(world.periods).length);
      world.periods[tag] = periodId;
      await exec(
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by, soft_closed_at, locked_at, locked_by)
         values ($1, $2, $3, 1, date '2043-01-01' + $4::int, date '2043-01-07' + $4::int, now(), $5, 'WEEK', 2043, $6, $7, $8, $8, case when $6 <> 'OPEN' then now() end, case when $6 = 'LOCKED' then now() end, case when $6 = 'LOCKED' then $8::uuid end)`,
        [tenant, periodId, `SY-${tag}`, offset, `CAL-${tag}`, status, id(FAMILY, 40), WORKER],
      );
      return periodId;
    };
    const report = async (tag: string, tenant: string, projectId: string, periodId: string, revision: number, status: string, by: number, current = false): Promise<string> => {
      const reportId = randomUUID();
      world.reports[tag] = reportId;
      const handedIn = status !== 'DRAFT';
      await exec(
        `insert into machvon.report_revision
           (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, report_type, measurement_basis, submitted_by, submitted_at, accepted_by, accepted_at, amendment_reason, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 1, repeat('a', 64), 'WEEKLY', 'YTD', $9, $10::timestamptz, $11, $12::timestamptz, $13, $14, $14)`,
        [tenant, reportId, projectId, periodId, id(FAMILY, 31), revision, status, current, handedIn ? memberId(by) : null, handedIn ? new Date().toISOString() : null, status === 'ACCEPTED' ? memberId(M_OTHER) : null, status === 'ACCEPTED' ? new Date().toISOString() : null, revision === 1 ? null : 'A correction', memberId(by)],
      );
      await exec(
        `insert into machvon.funding_snapshot_line (tenant_id, id, report_revision_id, bucket, budget_level, disbursed_cumulative_vnd, next_month_registered_vnd) values ($1, gen_random_uuid(), $2, 'CURRENT_YEAR', 'CENTRAL', 100, 10)`,
        [tenant, reportId],
      );
      await exec(
        `insert into machvon.progress_snapshot (tenant_id, id, report_revision_id, construction_value_vnd, acceptance_value_vnd, treasury_submitted_value_vnd, preparing_dossier_value_vnd, measurement_basis) values ($1, gen_random_uuid(), $2, 1, 1, 1, 1, 'YTD')`,
        [tenant, reportId],
      );
      await exec(`insert into machvon.report_narrative (tenant_id, id, report_revision_id, results_text, created_by, updated_by) values ($1, gen_random_uuid(), $2, 'Done', $3, $3)`, [tenant, reportId, memberId(by)]);
      return reportId;
    };
    const scope = (tenant: string, member: number, kind: string, ref: string): Promise<Row[]> =>
      exec(`insert into machvon.sync_membership_scope (tenant_id, id, membership_id, scope_kind, scope_ref_id) values ($1, gen_random_uuid(), $2, $3, $4)`, [tenant, memberId(member), kind, ref]);

    const p1 = await project('P1', TENANT_A, HERE);
    const p2 = await project('P2', TENANT_A, HERE);
    const p3 = await project('P3', TENANT_A, ELSEWHERE);
    const b1 = await project('B1', TENANT_B, HERE);
    const open = await period('OPEN', TENANT_A, 'OPEN', 0);
    const soft = await period('SOFT', TENANT_A, 'SOFT_CLOSED', 10);
    const locked = await period('LOCKED', TENANT_A, 'LOCKED', 20);
    const bOpen = await period('BOPEN', TENANT_B, 'OPEN', 0);
    // P1 in the open period: two revisions that were handed in and a draft of M_HERE.
    await report('P1-old', TENANT_A, p1, open, 1, 'SUBMITTED', M_HERE);
    await report('P1-last', TENANT_A, p1, open, 2, 'SUBMITTED', M_HERE);
    await report('P1-draft', TENANT_A, p1, open, 3, 'DRAFT', M_HERE);
    // P2: a draft of someone else in the open period, an accepted report in the soft-closed one.
    await report('P2-draft-other', TENANT_A, p2, open, 1, 'DRAFT', M_OTHER);
    await report('P2-accepted', TENANT_A, p2, soft, 1, 'ACCEPTED', M_HERE, true);
    // P1 in the locked period, and P3 of another branch.
    await report('P1-locked', TENANT_A, p1, locked, 1, 'SUBMITTED', M_HERE);
    await report('P3-last', TENANT_A, p3, open, 1, 'SUBMITTED', M_OTHER);
    await report('B1-last', TENANT_B, b1, bOpen, 1, 'SUBMITTED', M_OTHER);
    // A line of a frozen snapshot of a project that is not theirs: it must never be in a bucket.
    const snapshotId = randomUUID();
    await exec(
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2043-01-08', date '2043-01-08', 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, $4, $4)`,
      [TENANT_A, snapshotId, open, WORKER],
    );
    await exec(
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
       values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1, 1, 1, 'COMPLETE')`,
      [TENANT_A, snapshotId, p3, unitId(ELSEWHERE)],
    );
    await scope(TENANT_A, M_HERE, 'unit_subtree', unitId(HERE));
    await scope(TENANT_A, M_HERE, 'contract', randomUUID());
    await scope(TENANT_A, M_PROJECT, 'project', p3);
    // A row of the same member in another tenant, and a row of a tenant that names a project of another one: neither may carry anything across.
    await scope(TENANT_B, M_HERE, 'unit_subtree', unitId(HERE));
    await scope(TENANT_A, M_NONE, 'project', b1);
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
    client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    await seed();
  }, 300_000);

  afterAll(async () => {
    await client.end();
    await harness.stop();
  }, 60_000);

  it('TK-DIS-017-1: gives a member the projects of their scope, the periods that take a report, their own drafts and the last revision handed in, and nothing of the others', async () => {
    const projects = await bucket('dis_projects', claimsOf(M_HERE));
    expect(ids(projects.project)).toEqual(idsOf(['P1', 'P2'], world.projects));
    const periods = await bucket('dis_periods', claimsOf(M_HERE));
    expect(ids(periods.reporting_period)).toEqual(idsOf(['OPEN', 'SOFT'], world.periods));
    const reports = await bucket('dis_reports', claimsOf(M_HERE));
    // P1-last (the last handed in) and P1-draft (their draft), P2-accepted; not the older revision, not the draft of someone else, not the locked period, not P3.
    expect(ids(reports.report_revision)).toEqual(idsOf(['P1-last', 'P1-draft', 'P2-accepted'], world.reports));
    for (const table of ['funding_snapshot_line', 'progress_snapshot', 'report_narrative']) {
      const owners = (reports[table] ?? []).map((row) => String(row.report_revision_id)).sort();
      expect(owners).toEqual(idsOf(['P1-last', 'P1-draft', 'P2-accepted'], world.reports));
    }
  });

  it('a project scope gives that project alone, and a member with no scope row gets nothing from any bucket', async () => {
    const reports = await bucket('dis_reports', claimsOf(M_PROJECT));
    expect(ids((await bucket('dis_projects', claimsOf(M_PROJECT))).project)).toEqual(idsOf(['P3'], world.projects));
    expect(ids(reports.report_revision)).toEqual(idsOf(['P3-last'], world.reports));
    for (const name of DIS_SYNC_BUCKETS.map((each) => each.name)) {
      const received = await bucket(name, claimsOf(M_NOBODY));
      expect(Object.values(received).flat()).toEqual([]);
    }
    // A scope row that names a project of another tenant gives no project and no report (the periods are reference data of the tenant of the row).
    for (const name of ['dis_projects', 'dis_reports']) expect(Object.values(await bucket(name, claimsOf(M_NONE))).flat()).toEqual([]);
  });

  it('UAT-NFR-TENANCY-07 / AC-ST-DIS-017-4: the token of another tenant reaches nothing of the first, a scope row that names a project of another tenant reaches nothing, and the same member in the other tenant gets only that tenant', async () => {
    const asB = await bucket('dis_projects', claimsOf(M_HERE, TENANT_B));
    expect(ids(asB.project)).toEqual(idsOf(['B1'], world.projects));
    const reportsB = await bucket('dis_reports', claimsOf(M_HERE, TENANT_B));
    expect(ids(reportsB.report_revision)).toEqual(idsOf(['B1-last'], world.reports));
    // M_NONE has a row in tenant A that names the project B1 of tenant B: the tenant of the bucket is the tenant of the row, and B1 is not in it.
    expect(Object.values(await bucket('dis_projects', claimsOf(M_NONE))).flat()).toEqual([]);
    // A token of a tenant where the member has no scope.
    expect(Object.values(await bucket('dis_reports', claimsOf(M_PROJECT, TENANT_B))).flat()).toEqual([]);
  });

  it('UAT-NFR-TENANCY-07 / AC-ST-DIS-017-4: when the scope is revoked the buckets are empty at the next sync, and a row that was ended for one scope leaves the others', async () => {
    const before = await bucket('dis_projects', claimsOf(M_HERE));
    expect(ids(before.project)).toHaveLength(2);
    await exec("update machvon.sync_membership_scope set effective_until = now() + interval '1 second' where membership_id = $1 and tenant_id = $2 and scope_kind = 'unit_subtree'", [memberId(M_HERE), TENANT_A]);
    // A scope row ends by the update of its end, which the next evaluation of the parameter query sees.
    await exec("update machvon.sync_membership_scope set effective_from = now() - interval '1 hour', effective_until = now() where membership_id = $1 and tenant_id = $2", [memberId(M_HERE), TENANT_A]);
    for (const name of DIS_SYNC_BUCKETS.map((each) => each.name)) {
      expect(Object.values(await bucket(name, claimsOf(M_HERE))).flat()).toEqual([]);
    }
    // The other tenant of the same member is untouched, and so is another member.
    expect(ids((await bucket('dis_projects', claimsOf(M_HERE, TENANT_B))).project)).toEqual(idsOf(['B1'], world.projects));
    expect(ids((await bucket('dis_projects', claimsOf(M_PROJECT))).project)).toEqual(idsOf(['P3'], world.projects));
  });

  it('respects both ends of the validity of a scope row: a grant that has not started gives nothing, a grant that ends in the future gives its data until it ends', async () => {
    const member = 6;
    const reach = (): Promise<string[]> => bucket('dis_projects', claimsOf(member)).then((received) => ids(received.project));
    await exec(
      "insert into machvon.sync_membership_scope (tenant_id, id, membership_id, scope_kind, scope_ref_id, effective_from) values ($1, gen_random_uuid(), $2, 'project', $3, now() + interval '1 day')",
      [TENANT_A, memberId(member), world.projects.P1],
    );
    expect(await reach()).toEqual([]);
    expect(Object.values(await bucket('dis_periods', claimsOf(member))).flat()).toEqual([]);
    await exec("update machvon.sync_membership_scope set effective_from = now() - interval '1 hour', effective_until = now() + interval '1 day' where membership_id = $1", [memberId(member)]);
    expect(await reach()).toEqual(idsOf(['P1'], world.projects));
    expect(ids((await bucket('dis_periods', claimsOf(member))).reporting_period)).toEqual(idsOf(['OPEN', 'SOFT'], world.periods));
    await exec("update machvon.sync_membership_scope set effective_from = now() - interval '2 hours', effective_until = now() - interval '1 hour' where membership_id = $1", [memberId(member)]);
    expect(await reach()).toEqual([]);
  });

  it('syncs only the tables and the columns of the contract: the amount of the investment, the lines of the snapshots and every other column stay on the server, and the money of the phone is read only', async () => {
    const reports = await bucket('dis_reports', claimsOf(M_PROJECT));
    const received = { ...reports, ...(await bucket('dis_projects', claimsOf(M_PROJECT))), ...(await bucket('dis_periods', claimsOf(M_PROJECT))) };
    for (const table of DIS_SYNC_TABLES) {
      const rows = received[table.table] ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(table.columns.map((column) => column.name).sort());
    }
    const everyQuery = DIS_SYNC_BUCKETS.flatMap((each) => [each.parameters, ...each.data.map((entry) => entry.query)]).join('\n');
    expect(everyQuery).not.toMatch(/period_snapshot|total_investment_vnd|plan_total_vnd|household|national_id/i);
    expect(DIS_SYNC_TABLES.flatMap((table) => table.columns.filter((column) => column.readOnlyMoney === true).map((column) => `${table.table}.${column.name}`)).sort()).toEqual([
      'funding_snapshot_line.ctmtqg_subset_vnd',
      'funding_snapshot_line.disbursed_cumulative_vnd',
      'funding_snapshot_line.next_month_ctmtqg_subset_vnd',
      'funding_snapshot_line.next_month_registered_vnd',
      'progress_snapshot.acceptance_value_vnd',
      'progress_snapshot.construction_value_vnd',
      'progress_snapshot.preparing_dossier_value_vnd',
      'progress_snapshot.treasury_submitted_value_vnd',
    ]);
    // Every money column of the synced tables is marked: a column ending in _vnd that is not read only is a mistake of the contract.
    for (const table of DIS_SYNC_TABLES) for (const column of table.columns) expect(column.name.endsWith('_vnd') || column.name.endsWith('_value_vnd') ? column.readOnlyMoney === true : true).toBe(true);
  });

  it('says plainly that the rules are a reference that the PowerSync dialect cannot take as they are, and what the translation needs', () => {
    expect(DIS_SYNC_TRANSLATION.length).toBeGreaterThanOrEqual(4);
    const file = syncRulesYaml();
    expect(file).toMatch(/PROPOSED REFERENCE, not deployable as it is/);
    expect(file).toContain('is_last_handed_in');
    expect(readFileSync(join(ROOT_DIR, 'docs', 'dis-mobile-contract.md'), 'utf8')).toContain('not the deployable file');
  });

  it('TK-DIS-017-1 / TK-DIS-017-2: the sync rules file and the contract pack are what the source says, and the pack names only operations that the OpenAPI document has', () => {
    expect(normal(readFileSync(join(ROOT_DIR, 'infra', 'powersync', 'sync-rules.reference.yaml'), 'utf8'))).toBe(syncRulesYaml());
    expect(normal(readFileSync(join(ROOT_DIR, 'docs', 'dis-mobile-contract.md'), 'utf8'))).toBe(mobileContractMarkdown(OPENAPI));
    for (const command of DIS_MOBILE_COMMANDS) {
      const facts = operationFacts(OPENAPI, command.operationId);
      expect(facts).toBeDefined();
      expect(facts?.permission).not.toBe('');
    }
    expect(DIS_MOBILE_COMMANDS.filter((command) => command.offline === 'QUEUED').map((command) => command.operationId)).toEqual(['post_reports', 'post_reports_id_revisions', 'uploadReportFile', 'post_reports_id_submit', 'deleteDraftReport']);
    expect(() => bindSyncQuery('x', { tenant: "1'; drop table x; --" })).toThrow();
  });
});
