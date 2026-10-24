import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PRJ-09, PRJ-15 and PRJ-10 (the appraisal of a project and its admission to the project bank) in a real browser against the real API and database
 * (apps/api/test/e2e-stack): one person sends a CONCEPT project to appraisal with its proposal, two appraisers score it against the set of criteria in
 * force, a decision maker admits it to the project bank in a group with the document of the decision, and the database holds the sheets, the moves, the
 * audit rows and the events. The proposer of a project neither scores it nor decides on it, a decision against the sheets needs its reason, and someone
 * who may only read is refused. The weights of the set are the platform's (25/25/20/20/10) and the threshold 60.
 */

const REASON = 'Kiểm thử trình duyệt: thẩm định dự án';
const CRITERIA = ['POLICY_ALIGNMENT', 'FEASIBILITY', 'EFFECTIVENESS', 'CAPITAL_READINESS', 'RISK'] as const;

interface SeededProject {
  id: string;
  code: string;
}

/** A project written the way the register writes it, left in a stage by the stories before this one; `createdBy` is its proposer. */
async function seed(status: string, createdBy: string): Promise<SeededProject> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const id = randomUUID();
  const code = `E2E-AP-${Date.now().toString(36).toUpperCase()}-${id.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, $7, 1, $8, $8)`,
    [tenant, id, code, `Dự án thẩm định ${code}`, stackInfo().units.A['CB-SKHDT-QLDA'], area?.id, status, membershipOf(createdBy)],
  );
  return { id, code };
}

const document = async (n: number): Promise<string> => ((await sql<{ id: string }>('select id from machvon.document where symbol = $1', [`QD-E2E-${n}/2026`]))[0] as { id: string }).id;

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface ProjectRow {
  status: string;
  version: string;
  project_group: string | null;
  appraisal_score: string | null;
  policy_decision_document_id: string | null;
}

const projectOf = async (id: string): Promise<ProjectRow | undefined> =>
  (await sql<ProjectRow>('select status, version::text as version, project_group, appraisal_score::text as appraisal_score, policy_decision_document_id from machvon.project where id = $1', [id]))[0];

interface SheetRow {
  appraiser_membership_id: string;
  total_score: string;
  recommendation: string;
  status: string;
  decision: string | null;
  decided_group: string | null;
  override_reason: string | null;
  version: string;
}

const sheetsOf = (id: string) =>
  sql<SheetRow>(
    `select appraiser_membership_id, total_score::text as total_score, recommendation, status, decision, decided_group, override_reason, version::text as version
       from machvon.project_appraisal where project_id = $1 order by created_at, id`,
    [id],
  );

const score = (page: Page, criterion: string, value: number) => page.locator(`[data-criterion="${criterion}"] input[value="${value}"]`).check();

async function scoreAll(page: Page, values: readonly number[]): Promise<void> {
  for (const [index, criterion] of CRITERIA.entries()) await score(page, criterion, values[index] as number);
}

test.describe('PRJ-09, PRJ-15 and PRJ-10: the appraisal of a project and its admission to the project bank', () => {
  test('a project is sent, scored by two appraisers and admitted to the project bank, and the database holds every step (AC-ST-PRJ-003-2, AC-ST-PRJ-003-1, AC-ST-PRJ-003-4, UI-PRJ-09, UI-PRJ-15, UI-PRJ-10)', async ({ page }) => {
    const project = await seed('CONCEPT', 'projectManager');
    const proposal = await document(2);
    const decision = await document(3);

    // PRJ-09: the proposer sends the project with its proposal; the form is checked first.
    await open(page, 'appraisalProposer', `/prj/prj-09?id=${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.proposal.page.title'] })).toBeVisible();
    await expect(page.getByTestId('project-head')).toContainText(project.code);
    await page.getByRole('button', { name: vi['prj.proposal.submit.action'] }).click();
    await expect(page.getByText(vi['prj.appraisal.field.required.error']).first()).toBeVisible();
    expect(await projectOf(project.id)).toMatchObject({ status: 'CONCEPT', version: '1' });
    await page.getByLabel(vi['prj.proposal.reason.label'], { exact: true }).fill(REASON);
    await page.getByLabel(vi['prj.proposal.document.label'], { exact: true }).fill(proposal);
    await page.getByRole('button', { name: vi['prj.proposal.submit.action'] }).click();
    await expect(page.getByTestId('sent')).toContainText(vi['prj.proposal.done.text']);
    expect(await projectOf(project.id)).toMatchObject({ status: 'APPRAISAL', version: '2' });
    expect(await sql('select operation, actor_id, decision_document_id, reason from machvon.project_stage_change where project_id = $1', [project.id])).toEqual([
      { operation: 'submitProjectForAppraisal', actor_id: membershipOf('appraisalProposer'), decision_document_id: proposal, reason: REASON },
    ]);

    // PRJ-15: the first appraiser scores; the grid previews the total and the sheet shows the one the server computed.
    await open(page, 'appraisalAppraiser', `/prj/prj-15?id=${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.score.page.title'] })).toBeVisible();
    await expect(page.getByTestId('grid').locator('[data-criterion]')).toHaveCount(5);
    await expect(page.getByTestId('set-awaiting')).toBeVisible();
    await page.getByRole('button', { name: vi['prj.score.submit.action'] }).click();
    await expect(page.getByTestId('scores-error')).toHaveText(vi['prj.appraisal.field.scoresIncomplete.error']);
    expect(await sheetsOf(project.id)).toEqual([]);
    await scoreAll(page, [4, 3, 5, 2, 4]);
    await expect(page.getByTestId('total')).toContainText('71.00');
    await page.getByLabel(vi['prj.score.recommendation.label'], { exact: true }).selectOption('ADMIT');
    await page.getByLabel(vi['prj.score.note.label'], { exact: true }).fill('Đề xuất có cơ sở');
    await page.getByRole('button', { name: vi['prj.score.submit.action'] }).click();
    await expect(page.getByTestId('saved')).toHaveText(vi['prj.score.saved.notice']);
    await expect(page.getByTestId('own-sheet')).toContainText('71.00');

    // The second appraiser scores the same project.
    await open(page, 'appraisalSecond', `/prj/prj-15?id=${project.id}`);
    await expect(page.getByTestId('grid')).toBeVisible();
    await scoreAll(page, [5, 4, 4, 3, 3]);
    await expect(page.getByTestId('total')).toContainText('79.00');
    await page.getByLabel(vi['prj.score.recommendation.label'], { exact: true }).selectOption('ADMIT');
    await page.getByRole('button', { name: vi['prj.score.submit.action'] }).click();
    await expect(page.getByTestId('saved')).toBeVisible();
    expect((await sheetsOf(project.id)).map((sheet) => [sheet.appraiser_membership_id, sheet.total_score, sheet.status])).toEqual([
      [membershipOf('appraisalAppraiser'), '71.00', 'SUBMITTED'],
      [membershipOf('appraisalSecond'), '79.00', 'SUBMITTED'],
    ]);

    // PRJ-10: the decision maker reads both sheets and the mean, and admits the project in a group with the document.
    await open(page, 'appraisalDecider', `/prj/prj-10?id=${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.decision.page.title'] })).toBeVisible();
    await expect(page.getByTestId('sheets').locator('[data-sheet]')).toHaveCount(2);
    await expect(page.getByTestId('mean')).toHaveText('75.00');
    await expect(page.getByTestId('threshold-recommendation')).toHaveText(vi['prj.appraisal.recommendation.admit.label']);
    await page.locator('[data-decision="ADMIT"] input').check();
    await page.getByLabel(vi['prj.decision.reason.label'], { exact: true }).fill(REASON);
    await page.getByRole('button', { name: vi['prj.decision.submit.action'] }).click();
    await expect(page.getByText(vi['prj.appraisal.field.required.error']).first()).toBeVisible();
    expect((await projectOf(project.id))?.status).toBe('APPRAISAL');
    await page.getByLabel(vi['prj.decision.document.label'], { exact: true }).fill(decision);
    await page.getByLabel(vi['prj.decision.group.label'], { exact: true }).selectOption('B');
    await page.getByRole('button', { name: vi['prj.decision.submit.action'] }).click();
    await expect(page.getByTestId('decided')).toContainText(vi['prj.appraisal.recommendation.admit.label']);

    expect(await projectOf(project.id)).toEqual({ status: 'PIPELINE', version: '3', project_group: 'B', appraisal_score: '75.00', policy_decision_document_id: decision });
    expect((await sheetsOf(project.id)).map((sheet) => [sheet.status, sheet.decision, sheet.decided_group, sheet.override_reason, sheet.version])).toEqual([
      ['DECIDED', 'ADMIT', 'B', null, '2'],
      ['DECIDED', 'ADMIT', 'B', null, '2'],
    ]);
    const moves = await sql<{ from_stage: string; to_stage: string; operation: string; actor_id: string }>(
      'select from_stage, to_stage, operation, actor_id from machvon.project_stage_change where project_id = $1 order by project_version',
      [project.id],
    );
    expect(moves).toEqual([
      { from_stage: 'CONCEPT', to_stage: 'APPRAISAL', operation: 'submitProjectForAppraisal', actor_id: membershipOf('appraisalProposer') },
      { from_stage: 'APPRAISAL', to_stage: 'PIPELINE', operation: 'decideProjectAppraisal', actor_id: membershipOf('appraisalDecider') },
    ]);
    expect(await sql("select count(*)::int as n from machvon.outbox_event where type = 'project.stage_changed.v1' and payload->>'project_id' = $1", [project.id])).toEqual([{ n: 2 }]);
    expect(await sql("select count(*)::int as n from machvon.outbox_event where type = 'project.appraisal_recorded.v1' and payload->>'project_id' = $1", [project.id])).toEqual([{ n: 2 }]);
    expect(await sql("select count(*)::int as n from machvon.audit_event where outcome = 'SUCCESS' and action in ('project.stage_changed', 'project.appraisal_recorded', 'project.appraisal_decided') and (resource_id = $1::uuid or safe_diff->>'project_id' = $1::text)", [project.id])).toEqual([{ n: 5 }]);
  });

  test('the proposer of a project cannot score it or decide on it, and the database holds no sheet of theirs (four-eyes, AC-ST-PRJ-003-3)', async ({ page }) => {
    const project = await seed('APPRAISAL', 'appraisalAll');
    await open(page, 'appraisalAll', `/prj/prj-15?id=${project.id}`);
    await expect(page.getByTestId('proposer')).toHaveText(vi['prj.score.proposer.notice']);
    await expect(page.getByTestId('grid')).toHaveCount(0);
    await open(page, 'appraisalAll', `/prj/prj-10?id=${project.id}`);
    await expect(page.getByTestId('proposer')).toHaveText(vi['prj.decision.proposer.notice']);
    await expect(page.getByRole('button', { name: vi['prj.decision.submit.action'] })).toHaveCount(0);
    expect(await sheetsOf(project.id)).toEqual([]);
    expect(await projectOf(project.id)).toMatchObject({ status: 'APPRAISAL', version: '1' });
  });

  test('a decision against the sheets needs its reason; with it the project is rejected and the reason is kept (AC-ST-PRJ-003-3)', async ({ page }) => {
    const project = await seed('APPRAISAL', 'projectManager');
    const [set] = await sql<{ id: string }>("select v.id from machvon.master_record_version v where v.master_type = 'APPRAISAL_CRITERIA' and v.status = 'EFFECTIVE' order by v.valid_from desc limit 1");
    await sql(
      `insert into machvon.project_appraisal (tenant_id, id, project_id, round, criteria_set_version_id, appraiser_membership_id, scores_json, total_score, recommendation, status, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, 1, $3, $4, $5::jsonb, 80, 'ADMIT', 'SUBMITTED', $4, $4)`,
      [stackInfo().tenants.A, project.id, set?.id, membershipOf('appraisalAppraiser'), JSON.stringify(CRITERIA.map((criterion) => ({ criterion_code: criterion, score: 4 })))],
    );
    await open(page, 'appraisalDecider', `/prj/prj-10?id=${project.id}`);
    await expect(page.getByTestId('sheets').locator('[data-sheet]')).toHaveCount(1);
    await page.locator('[data-decision="REJECT"] input').check();
    await expect(page.getByLabel(vi['prj.decision.overrideReason.label'], { exact: true })).toBeVisible();
    await page.getByLabel(vi['prj.decision.reason.label'], { exact: true }).fill(REASON);
    await page.getByRole('button', { name: vi['prj.decision.submit.action'] }).click();
    await expect(page.getByText(vi['prj.appraisal.field.required.error']).first()).toBeVisible();
    await page.getByLabel(vi['prj.decision.overrideReason.label'], { exact: true }).fill('quá ngắn');
    await page.getByRole('button', { name: vi['prj.decision.submit.action'] }).click();
    await expect(page.getByText(vi['prj.appraisal.field.overrideShort.error'])).toBeVisible();
    expect(await projectOf(project.id)).toMatchObject({ status: 'APPRAISAL', version: '1' });
    const reason = 'Nguồn vốn đối ứng của dự án đã bị rút lại';
    await page.getByLabel(vi['prj.decision.overrideReason.label'], { exact: true }).fill(reason);
    await page.getByRole('button', { name: vi['prj.decision.submit.action'] }).click();
    await expect(page.getByTestId('decided')).toBeVisible();
    expect(await projectOf(project.id)).toMatchObject({ status: 'REJECTED', version: '2', project_group: null });
    expect((await sheetsOf(project.id))[0]).toMatchObject({ status: 'DECIDED', decision: 'REJECT', override_reason: reason });
  });

  test('someone who may only read is refused the scoring and the decision, and cannot send a project; someone without the read permission is refused the screen (denied, read-only)', async ({ page }) => {
    const waiting = await seed('APPRAISAL', 'projectManager');
    const concept = await seed('CONCEPT', 'projectManager');
    await open(page, 'projectViewer', `/prj/prj-15?id=${waiting.id}`);
    await expect(page.getByTestId('denied')).toHaveText(vi['prj.score.denied.notice']);
    await expect(page.getByTestId('grid')).toHaveCount(0);
    await open(page, 'projectViewer', `/prj/prj-10?id=${waiting.id}`);
    await expect(page.getByTestId('denied')).toHaveText(vi['prj.decision.denied.notice']);
    await open(page, 'projectViewer', `/prj/prj-09?id=${concept.id}`);
    await expect(page.getByTestId('read-only')).toHaveText(vi['prj.proposal.readOnly.denied.notice']);
    await expect(page.getByRole('button', { name: vi['prj.proposal.submit.action'] })).toBeDisabled();
    await open(page, 'appraisalProposer', `/prj/prj-09?id=${waiting.id}`);
    await expect(page.getByTestId('not-concept')).toHaveText(vi['prj.proposal.notConcept.notice']);
    await open(page, 'nobody', `/prj/prj-15?id=${waiting.id}`);
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    expect(await projectOf(waiting.id)).toMatchObject({ status: 'APPRAISAL', version: '1' });
    expect(await projectOf(concept.id)).toMatchObject({ status: 'CONCEPT', version: '1' });
    expect(await sheetsOf(waiting.id)).toEqual([]);
  });
});
