import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * DGV-01, DGV-06 and DGV-07 in a real browser against the real API, the quality job and the database (apps/api/test/e2e-stack): the steward
 * writes two rules, is refused the approval of their own rule (by the server), another person approves them, the steward requests a run on a
 * frozen snapshot with a reference to no project, the job executes it, and the scorecard shows a hard fail with a score of 75 and a CRITICAL
 * incident; a dataset that was never assessed shows "not assessed" with no score; a reader changes nothing. What the screens changed is looked
 * up in the database.
 */

const STEWARD = 'qualitySteward';
const APPROVER = 'qualityApprover';
const READER = 'qualityReader';
const unique = (): string => `DS-E2E-Q-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 100)}`;

async function open(page: Page, path: 'dgv-01' | 'dgv-06' | 'dgv-07', user: string, datasetId?: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/dgv/${path}?devUser=${user}${datasetId === undefined ? '' : `&dataset=${datasetId}`}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface Seeded {
  datasetId: string;
  contractId: string;
  code: string;
  snapshotId: string;
  projectIds: string[];
}

/** What the flows seeded and have not released yet. */
const seeded: Seeded[] = [];

/** Runs statements as the superuser with the foreign keys switched off for the session, so that a snapshot with an orphan reference can be written. */
async function seedWithoutKeys(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [text, params] of statements) await client.query(text, params);
  } finally {
    await client.end();
  }
}

/** A dataset of the DIS module with a working contract, and a frozen snapshot of four lines, two of which name a project that does not exist. */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const datasetId = randomUUID();
  const contractId = randomUUID();
  const snapshotId = randomUUID();
  const code = unique();
  const unit = Object.values(stackInfo().units.A)[0] as string;
  const statements: Array<[string, unknown[]]> = [
    [
      `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
       values ($1, $2, $3, $4, 'DISBURSEMENT', 'one row per project and bucket', 'DIS', $5, $6, 'INTERNAL', true, 86400, 'DRAFT', $6, $6)`,
      [tenant, datasetId, code, `Giải ngân ${code}`, membershipOf(APPROVER), membershipOf(STEWARD)],
    ],
    [
      `insert into machvon.dataset_contract (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id)
       values ($1, $2, $3, 1, $4, '{}'::jsonb, '{}'::jsonb, 86400, 'INTERNAL', 'DRAFT', $5)`,
      [tenant, contractId, code, membershipOf(APPROVER), datasetId],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), current_date, current_date, 'FROZEN', 'v1', 'PROPOSED_PENDING_SIGNOFF', 4, repeat('e', 64), $4, now(), $4, $4)`,
      [tenant, snapshotId, randomUUID(), membershipOf(STEWARD)],
    ],
  ];
  const projectIds: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const projectId = randomUUID();
    if (index < 2) {
      projectIds.push(projectId);
      statements.push([
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, created_by, updated_by)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'CONCEPT', 1, $6, $6)`,
        [tenant, projectId, `PRJ-${randomUUID().slice(0, 8)}`, unit, randomUUID(), membershipOf(STEWARD)],
      ]);
    }
    statements.push([
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, ctmtqg_subset_vnd, rate_total_pct, treasury_coverage)
       values ($1, $2, $3, $4, $5, 'CURRENT_YEAR', 'CENTRAL', 1000, 0, 1000, 500, 50, 'COMPLETE')`,
      [tenant, randomUUID(), snapshotId, projectId, unit],
    ]);
  }
  await seedWithoutKeys(statements);
  const world = { datasetId, contractId, code, snapshotId, projectIds };
  seeded.push(world);
  return world;
}

/** The snapshot is the newest frozen one of the tenant, and its projects name a master version that is not there: the screens of the other flows would read them, so they are set aside when the flow ends. */
async function release(): Promise<void> {
  const worlds = seeded.splice(0);
  if (worlds.length === 0) return;
  await seedWithoutKeys([
    ["update machvon.period_snapshot set status = 'SUPERSEDED' where id = any($1::uuid[])", [worlds.map((world) => world.snapshotId)]],
    ['delete from machvon.project where id = any($1::uuid[])', [worlds.flatMap((world) => world.projectIds)]],
  ]);
}

const form = (page: Page) => page.getByRole('form', { name: vi['dgv.rules.form.title'] });
const rowOf = (page: Page, code: string) => page.locator(`tr[data-rule-code="${code}"]`);

async function writeRule(page: Page, fields: { code: string; dimension: string; field: string; minRate: string; action: string }): Promise<void> {
  const f = form(page);
  await f.getByLabel(vi['dgv.rules.form.code.label'], { exact: true }).fill(fields.code);
  await f.getByLabel(vi['dgv.rules.form.dimension.label'], { exact: true }).selectOption(fields.dimension);
  await f.getByLabel(vi['dgv.rules.form.field.label'], { exact: true }).fill(fields.field);
  await f.getByLabel(vi['dgv.rules.form.minRate.label'], { exact: true }).fill(fields.minRate);
  await f.getByLabel(vi['dgv.rules.form.action.label'], { exact: true }).selectOption(fields.action);
  await f.getByRole('button', { name: vi['dgv.rules.form.save.action'] }).click();
  await expect(f.getByTestId('rule-saved')).toBeVisible();
}

test.describe('DGV-06 quality rules, DGV-07 score and DGV-01 control', () => {
  test.afterEach(release);

  test('the steward writes rules, another person approves them, the run is executed on the frozen snapshot, and the scorecard shows a hard fail with a CRITICAL incident (AC-ST-DGV-002-1, AC-ST-DGV-002-3, AC-ST-DGV-002-4)', async ({ page }) => {
    const world = await seed();
    await open(page, 'dgv-06', STEWARD, world.datasetId);
    await expect(page.getByRole('heading', { level: 1, name: vi['dgv.rules.page.title'] })).toBeVisible();
    await expect(page.getByTestId('empty-rules')).toBeVisible();
    await expect(page.getByTestId('no-contract')).toHaveCount(0);

    // An empty form sends nothing.
    await form(page).getByRole('button', { name: vi['dgv.rules.form.save.action'] }).click();
    await expect(page.locator('[data-field="rule-code"]').getByText(vi['dgv.field.required.error'])).toBeVisible();

    await writeRule(page, { code: 'R-COMPLETE', dimension: 'COMPLETENESS', field: 'project_id', minRate: '100', action: 'QUARANTINE' });
    await writeRule(page, { code: 'R-FK-PROJECT', dimension: 'INTEGRITY', field: 'project_id', minRate: '100', action: 'HARD_BLOCK' });
    await expect(rowOf(page, 'R-FK-PROJECT')).toBeVisible();
    const drafts = await sql<{ code: string; status: string; created_by: string; dimension: string; version: string }>(
      'select code, status, created_by, dimension, version::text from machvon.quality_rule_version where dataset_id = $1 order by code',
      [world.datasetId],
    );
    expect(drafts).toEqual([
      { code: 'R-COMPLETE', status: 'DRAFT', created_by: membershipOf(STEWARD), dimension: 'COMPLETENESS', version: '1' },
      { code: 'R-FK-PROJECT', status: 'DRAFT', created_by: membershipOf(STEWARD), dimension: 'INTEGRITY', version: '1' },
    ]);

    // A rule with a raw SQL node is refused by the server (no screen can write one); the author cannot approve their own rule, and the screen does not offer it.
    const raw = await apiCall(STEWARD, 'POST', '/dgv/quality-rules', {
      body: { contract_id: world.contractId, code: 'R-RAW', dimension: 'COMPLETENESS', expression_ast: { op: 'raw_sql', sql: 'select 1' }, severity: 'LOW', threshold_json: { min_pass_rate_pct: '100' }, action_on_fail: 'WARN', criticality_weight: 1 },
    });
    expect([raw.status, raw.json.code]).toEqual([422, 'EXPRESSION_NOT_ALLOWED']);
    await expect(rowOf(page, 'R-COMPLETE').getByRole('button', { name: vi['dgv.rules.approve.action'] })).toHaveCount(0);
    await expect(rowOf(page, 'R-COMPLETE').getByText(vi['dgv.rules.approve.own.hint'])).toBeVisible();
    const ruleId = (await sql<{ id: string }>("select id from machvon.quality_rule_version where dataset_id = $1 and code = 'R-COMPLETE'", [world.datasetId]))[0]?.id;
    const self = await apiCall(STEWARD, 'POST', `/dgv/quality-rules/${ruleId}/approval`, { version: 1 });
    expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);

    // Another person approves both rules.
    await open(page, 'dgv-06', APPROVER, world.datasetId);
    await expect(form(page)).toHaveCount(0);
    await rowOf(page, 'R-COMPLETE').getByRole('button', { name: vi['dgv.rules.approve.action'] }).click();
    await expect(rowOf(page, 'R-COMPLETE').getByText(vi['dgv.quality.ruleStatus.approved.text'])).toBeVisible();
    await rowOf(page, 'R-FK-PROJECT').getByRole('button', { name: vi['dgv.rules.approve.action'] }).click();
    await expect(rowOf(page, 'R-FK-PROJECT').getByText(vi['dgv.quality.ruleStatus.approved.text'])).toBeVisible();
    expect(await sql('select code, status, approved_by, version::text from machvon.quality_rule_version where dataset_id = $1 order by code', [world.datasetId])).toEqual([
      { code: 'R-COMPLETE', status: 'APPROVED', approved_by: membershipOf(APPROVER), version: '2' },
      { code: 'R-FK-PROJECT', status: 'APPROVED', approved_by: membershipOf(APPROVER), version: '2' },
    ]);

    // Before the first run the dataset is not assessed: no score, and nothing measured.
    await open(page, 'dgv-07', STEWARD, world.datasetId);
    await expect(page.getByTestId('not-assessed')).toHaveText(vi['dgv.score.notAssessed.text']);
    await expect(page.getByTestId('score')).not.toContainText(/\d/);

    // The steward requests a run on the frozen snapshot; the job executes it.
    await page.getByLabel(vi['dgv.score.run.snapshot.label'], { exact: true }).fill(world.snapshotId);
    await page.getByRole('button', { name: vi['dgv.score.run.start.action'] }).click();
    await expect(page.getByTestId('run-requested')).toHaveText(vi['dgv.score.run.requested.notice']);
    await expect
      .poll(async () => (await sql<{ status: string }>('select status from machvon.quality_run where dataset_id = $1 order by started_at limit 1', [world.datasetId]))[0]?.status, { timeout: 60_000 })
      .toBe('COMPLETED');

    const run = (await sql<{ overall_result: string; score: string; hard_fail: boolean; certified_blocked: boolean; trigger: string; snapshot_id: string; rules: string }>(
      'select overall_result, score::text, hard_fail, certified_blocked, trigger, snapshot_id, jsonb_array_length(rule_version_ids)::text as rules from machvon.quality_run where dataset_id = $1',
      [world.datasetId],
    ))[0];
    expect(run).toEqual({ overall_result: 'FAILED', score: '75.00', hard_fail: true, certified_blocked: true, trigger: 'MANUAL', snapshot_id: world.snapshotId, rules: '2' });
    expect(await sql('select severity, sla_hours, status from machvon.quality_incident where run_id in (select id from machvon.quality_run where dataset_id = $1)', [world.datasetId])).toEqual([
      { severity: 'CRITICAL', sla_hours: 4, status: 'OPEN' },
    ]);

    await open(page, 'dgv-07', READER, world.datasetId);
    await expect(page.getByTestId('scorecard')).toHaveAttribute('data-badge', 'FAILED');
    await expect(page.getByTestId('score')).toContainText('75.00');
    await expect(page.getByTestId('hard-fail')).toHaveText(vi['dgv.score.hardFail.text']);
    await expect(page.getByTestId('certified-blocked')).toHaveText(vi['dgv.score.certifiedBlocked.text']);
    await expect(page.getByTestId('definitions-unsigned')).toBeVisible();
    await expect(page.locator('tr[data-rule-code="R-FK-PROJECT"]')).toHaveAttribute('data-result', 'FAIL');
    await expect(page.locator('tr[data-rule-code="R-COMPLETE"]')).toHaveAttribute('data-result', 'PASS');
    await expect(page.locator('tr[data-dimension="ACCURACY"] [data-testid="dimension-score"]')).toHaveText(vi['dgv.score.dimension.notAssessed']);
    await expect(page.getByRole('form', { name: vi['dgv.score.run.title'] })).toHaveCount(0);
  });

  test('the dashboard shows a dataset that was never assessed as not assessed with no score, and a hard fail as one; a reader can only read', async ({ page }) => {
    const never = await seed();
    await open(page, 'dgv-01', READER);
    await expect(page.getByRole('heading', { level: 1, name: vi['dgv.dashboard.page.title'] })).toBeVisible();
    const row = page.locator(`tr[data-dataset-code="${never.code}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-badge', 'NOT_ASSESSED');
    await expect(row.getByTestId('score')).toHaveText(vi['dgv.dashboard.score.none']);
    await expect(row.getByRole('link', { name: vi['dgv.dashboard.detail.link'] })).toHaveAttribute('href', new RegExp(`/dgv/dgv-07\\?dataset=${never.datasetId}`));
    await expect(page.getByTestId('tile-average')).not.toContainText('NaN');

    // A reader sees the rules and cannot write or approve; a member without the right to read quality gets the denied state.
    await open(page, 'dgv-06', READER, never.datasetId);
    await expect(page.getByTestId('empty-rules')).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    await open(page, 'dgv-07', 'nobody', never.datasetId);
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
  });
});
