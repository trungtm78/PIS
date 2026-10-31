import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { loadCommittedMigrations } from '../src/generate-migrations';
import { migrate } from '../src/migrate';
import { startTestDatabase } from '../src/test-database';
import type { TestDatabase } from '../src/test-database';

// ST-MNE-009: a database that holds evaluations written under the old rules (V002 only: no submitter, no decision kept) is upgraded by V1706. What the table did know is carried over, the checks of the workflow
// judge what is written from now on (they are added NOT VALID) and do not refuse the rows that exist. The migration runs as the owner role, to which row-level security applies, so the test also proves that it reaches
// the rows of every tenant.
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TENANT = '00000000-0000-4000-8000-00000000000a';
const OTHER_TENANT = '00000000-0000-4000-8000-00000000000b';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const PLANNER = '00000000-0000-4000-8000-0000000000f1';
const SUBMITTER = '00000000-0000-4000-8000-0000000000f2';
const APPROVER = '00000000-0000-4000-8000-0000000000f3';
const MIGRATION = 'V1706__mne1_evaluation_workflow';

describe('V1706: the evaluations written before the workflow kept who submitted and who decided (ST-MNE-009)', () => {
  let database: TestDatabase;
  let admin: Client;
  const ids: Record<string, string> = {};
  const run = async (text: string, params: unknown[] = []) => (await admin.query(text, params)).rows;

  async function legacy(name: string, status: string, options: { tenant?: string; approvedBy?: string | null; updatedBy?: string; conclusion?: boolean; name?: string; scope?: string; recommendations?: string; findings?: string } = {}): Promise<void> {
    const id = randomUUID();
    ids[name] = id;
    const tenant = options.tenant ?? TENANT;
    await run("select set_config('app.tenant_id', $1, false)", [tenant]);
    await run(
      `insert into machvon.mne_evaluation (tenant_id, id, project_id, evaluation_kind, evaluator_kind, evaluator_name, scope_text, recommendations_text, findings_json, conclusion, status, planned_date, completed_date, approved_by, created_by, updated_by, updated_at)
       values ($1, $2, $3, 'MIDTERM', 'INTERNAL', $10, $11, $12, $13::jsonb, $4, $5, date '2026-06-01', $6, $7, $8, $9, '2026-07-01T00:00:00Z')`,
      [tenant, id, PROJECT, options.conclusion === false ? null : 'SATISFACTORY', status, options.conclusion === false ? null : '2026-06-20', options.approvedBy ?? null, PLANNER, options.updatedBy ?? SUBMITTER, options.name ?? 'MNE office', options.scope ?? 'Midterm evaluation of the bridge', options.recommendations ?? null, options.findings ?? '[]'],
    );
  }

  beforeAll(async () => {
    const migrations = await loadCommittedMigrations(REPO_ROOT);
    const index = migrations.findIndex((migration) => migration.name === MIGRATION);
    expect(index).toBeGreaterThan(2);
    database = await startTestDatabase();
    await migrate(database.adminUrl, migrations.slice(0, index), { profile: 'test' });
    admin = new Client({ connectionString: database.adminUrl });
    await admin.connect();
    // The rows of the old shape are written without the foreign keys (the projects and the people they name are not part of what is tested).
    await run('set session_replication_role = replica');
    await run(`insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, 'T-A', 'Tenant A', 'Active', $3, 'vn'), ($2, 'T-B', 'Tenant B', 'Active', $3, 'vn')`, [TENANT, OTHER_TENANT, randomUUID()]);
    for (const tenant of [TENANT, OTHER_TENANT]) {
      await run("select set_config('app.tenant_id', $1, false)", [tenant]);
      await run(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-1', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, PROJECT, randomUUID(), randomUUID()],
      );
    }
    await legacy('planned', 'PLANNED', { conclusion: false });
    await legacy('submitted', 'SUBMITTED');
    await legacy('approved', 'APPROVED', { approvedBy: APPROVER, updatedBy: APPROVER });
    await legacy('returned', 'RETURNED');
    // Texts the old table allowed and the checks of the workflow do not: padded, too short, too long, empty.
    await legacy('untidy', 'SUBMITTED', { name: '  A ', scope: 'Q4 review', recommendations: '   ' });
    await legacy('huge', 'PLANNED', { conclusion: false, name: 'x'.repeat(400), scope: 'y'.repeat(2500), recommendations: 'z'.repeat(2500) });
    // A space at the boundary of the cut must not be left at the end of the text.
    await legacy('edge', 'PLANNED', { conclusion: false, name: 'a'.repeat(299) + ' bb', scope: 'c'.repeat(1999) + ' dd' });
    await legacy('objects', 'SUBMITTED', { findings: '{"topic":"progress"}' });
    await legacy('null-json', 'SUBMITTED', { findings: 'null' });
    await legacy('other-tenant', 'APPROVED', { tenant: OTHER_TENANT, approvedBy: APPROVER, updatedBy: APPROVER });
    await run('set session_replication_role = origin');
    await migrate(database.adminUrl, migrations.slice(0, index + 1), { profile: 'test' });
  }, 240_000);

  afterAll(async () => {
    await admin?.end();
    if (database) await database.stop();
  }, 60_000);

  const rowOf = async (name: string) =>
    (
      await run(
        'select status, submitted_by, submitted_at is not null as has_submitted_at, decided_by, decided_at is not null as has_decided_at, decision_reason, approved_by from machvon.mne_evaluation where id = $1',
        [ids[name]],
      )
    )[0];

  it('gives a submitted evaluation the person who last touched it as its submitter, and no decision', async () => {
    expect(await rowOf('submitted')).toMatchObject({ status: 'SUBMITTED', submitted_by: SUBMITTER, has_submitted_at: true, decided_by: null, has_decided_at: false, decision_reason: null });
  });

  it('gives an approved evaluation its approver as the one who decided, with a reason that says it was decided before', async () => {
    expect(await rowOf('approved')).toMatchObject({ status: 'APPROVED', submitted_by: APPROVER, decided_by: APPROVER, approved_by: APPROVER, has_decided_at: true });
    expect((await rowOf('approved'))?.decision_reason).toMatch(/before the workflow/);
  });

  it('gives a returned evaluation a decision as well, and leaves a planned one as it was', async () => {
    expect(await rowOf('returned')).toMatchObject({ status: 'RETURNED', submitted_by: SUBMITTER, decided_by: SUBMITTER, approved_by: null, has_decided_at: true });
    expect(await rowOf('planned')).toMatchObject({ status: 'PLANNED', submitted_by: null, has_submitted_at: false, decided_by: null });
  });

  it('brings the texts of the old rows to the shape the checks ask for, so that no evaluation is stuck on a text the guard would not let it repair', async () => {
    const texts = async (name: string) => (await run('select evaluator_name, scope_text, recommendations_text from machvon.mne_evaluation where id = $1', [ids[name]]))[0];
    expect(await texts('untidy')).toEqual({ evaluator_name: 'A (n/a)', scope_text: 'Q4 review (scope recorded before the workflow)', recommendations_text: null });
    const huge = await texts('huge');
    expect([huge?.evaluator_name.length, huge?.scope_text.length, huge?.recommendations_text.length]).toEqual([300, 2000, 2000]);
    const edge = await texts('edge');
    expect([edge?.evaluator_name.length, edge?.scope_text.length, edge?.evaluator_name.endsWith(' '), edge?.scope_text.endsWith(' ')]).toEqual([299, 1999, false, false]);
    expect(await texts('submitted')).toEqual({ evaluator_name: 'MNE office', scope_text: 'Midterm evaluation of the bridge', recommendations_text: null });
  });

  it('turns findings that are not a list into one, and lets such an evaluation be decided afterwards', async () => {
    const findings = async (name: string) => (await run('select findings_json from machvon.mne_evaluation where id = $1', [ids[name]]))[0]?.findings_json;
    expect(await findings('objects')).toEqual([{ topic: 'progress' }]);
    expect(await findings('null-json')).toEqual([]);
    expect(await findings('submitted')).toEqual([]);
    // The guard keeps the findings while the evaluation waits for its decision: the decision goes through on the list the migration wrote.
    await run("select set_config('app.tenant_id', $1, false)", [TENANT]);
    // (The people of the old rows are not memberships of this test database: the foreign keys are left out of what is tested.)
    await run('set session_replication_role = replica');
    await run("update machvon.mne_evaluation set status = 'APPROVED', approved_by = $2, decided_by = $2, decided_at = now(), decision_reason = 'Approved after the upgrade' where id = $1", [ids.objects, APPROVER]);
    await run('set session_replication_role = origin');
    expect((await rowOf('objects'))?.status).toBe('APPROVED');
  });

  it('reaches the rows of every tenant', async () => {
    await run("select set_config('app.tenant_id', $1, false)", [OTHER_TENANT]);
    expect(await rowOf('other-tenant')).toMatchObject({ status: 'APPROVED', decided_by: APPROVER, has_decided_at: true });
  });

  it('adds the checks of the workflow without validating the rows that exist, and judges every row written from now on', async () => {
    const checks = await run(
      "select conname, convalidated from pg_constraint where conrelid = 'machvon.mne_evaluation'::regclass and conname in ('mne_evaluation_text_chk', 'mne_evaluation_findings_chk', 'mne_evaluation_submitted_chk', 'mne_evaluation_decision_chk', 'mne_evaluation_decider_chk', 'mne_evaluation_report_chk') order by conname",
    );
    expect(checks).toHaveLength(6);
    expect(checks.every((check) => check.convalidated === false)).toBe(true);
    await run("select set_config('app.tenant_id', $1, false)", [TENANT]);
    await expect(
      run(
        `insert into machvon.mne_evaluation (tenant_id, id, project_id, evaluation_kind, evaluator_kind, evaluator_name, scope_text, status, planned_date, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, 'MIDTERM', 'INTERNAL', 'MNE office', 'short', 'PLANNED', date '2026-12-01', $3, $3)`,
        [TENANT, PROJECT, PLANNER],
      ),
    ).rejects.toThrow(/mne_evaluation_text_chk/);
  });
});
