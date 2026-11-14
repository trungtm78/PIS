import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
// The words of the edition under test: the enterprise overlay replaces some of the words these flows read (the national project code).
import { terms as vi } from './support/edition-terms.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PRJ-14 (the project bank and the PIMA life cycle) in a real browser against the real API and database (apps/api/test/e2e-stack): the stage manager
 * reads the board, is told by the confirmation which guard of a move is not met instead of the project being moved, moves a project through start,
 * suspension and resumption with the decision documents the guards ask for, and the database holds the move, its history row, its audit row and its
 * event. A stale version is refused by the server, someone who may only cancel is offered only the cancellation, and someone who only reads sees no
 * button. The moves are guarded commands: there is no four-eyes step in these commands, the checks are the guards.
 */

const FORMAT_SEED = (): string => String(9_000_000 + Math.floor(Math.random() * 999_999));
const TARGET_REASON = 'Kiểm thử trình duyệt: chuyển giai đoạn';

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/prj/prj-14?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface SeededProject {
  id: string;
  code: string;
}

/** A project left in a stage by the stories that come before this one, written the way the register writes it. */
async function seed(status: string, options: { nationalCode?: string | null; group?: string; score?: string } = {}): Promise<SeededProject> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const id = randomUUID();
  const code = `E2E-ST-${Date.now().toString(36).toUpperCase()}-${id.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code,
        appraisal_score, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, $7, $8, $9, $10::numeric, 1, $11, $11)`,
    [
      tenant,
      id,
      code,
      `Dự án vòng đời ${code}`,
      stackInfo().units.A['CB-SKHDT-QLDA'],
      area?.id,
      status,
      options.group ?? 'B',
      options.nationalCode === undefined ? FORMAT_SEED() : options.nationalCode,
      options.score ?? '70.00',
      membershipOf('projectManager'),
    ],
  );
  return { id, code };
}

const decisionDocument = async (): Promise<string> => ((await sql<{ id: string }>("select id from machvon.document where symbol = 'QD-E2E-1/2026'"))[0] as { id: string }).id;

interface ProjectRow {
  status: string;
  version: string;
  investment_decision_document_id: string | null;
}

const projectOf = async (id: string): Promise<ProjectRow | undefined> =>
  (await sql<ProjectRow>('select status, version::text as version, investment_decision_document_id from machvon.project where id = $1', [id]))[0];

const column = (page: Page, stage: string) => page.locator(`[data-stage="${stage}"]`);
const cardOf = (page: Page, stage: string, project: SeededProject) => column(page, stage).locator('.prj-card', { hasText: project.code });
const dialog = (page: Page) => page.getByRole('dialog');

async function openMove(page: Page, stage: string, project: SeededProject): Promise<void> {
  await expect(cardOf(page, stage, project)).toBeVisible();
  await cardOf(page, stage, project).getByRole('button', { name: vi['prj.board.card.move.action'] }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByTestId('current-stage')).toBeVisible();
}

async function fillMove(page: Page, documentLabel: string | undefined, documentId: string): Promise<void> {
  await dialog(page).getByLabel(vi['prj.board.dialog.reason.label'], { exact: true }).fill(TARGET_REASON);
  if (documentLabel !== undefined) await dialog(page).getByLabel(documentLabel, { exact: true }).fill(documentId);
}

const confirm = (page: Page) => dialog(page).getByRole('button', { name: vi['prj.board.dialog.confirm.action'] });

test.describe('PRJ-14 project bank and the guarded moves of the PIMA life cycle', () => {
  // The pages of the bank are cached by the API for 60 seconds and a row written straight to the database does not clear them: every project the
  // flows read is written before the first page is read, and the moves that follow go through the commands, which do clear the cache.
  const seeded: Record<'missingCode' | 'ready' | 'waiting' | 'budgeted' | 'running' | 'viewed', SeededProject> = {} as never;

  test.beforeAll(async () => {
    seeded.missingCode = await seed('BUDGETED', { nationalCode: null });
    seeded.ready = await seed('BUDGETED');
    seeded.waiting = await seed('PIPELINE');
    seeded.budgeted = await seed('BUDGETED');
    seeded.running = await seed('IMPLEMENTATION');
    seeded.viewed = await seed('BUDGETED');
  });

  test('the stage manager is told which guard is not met, then moves a project through start, suspension and resumption, and the database holds each move (AC-ST-PRJ-002-4, AC-ST-PRJ-002-2, UI-PRJ-14)', async ({ page }) => {
    const { missingCode, ready } = seeded;
    const decision = await decisionDocument();
    await open(page, 'stageManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.board.page.title'] })).toBeVisible();
    await expect(page.getByTestId('drag-disabled')).toHaveText(vi['prj.board.dragDisabled.notice']);
    await expect(column(page, 'BUDGETED').getByRole('heading', { name: vi['prj.stage.budgeted.label'] })).toBeVisible();
    await expect(cardOf(page, 'BUDGETED', missingCode).getByTestId('national-code-missing')).toHaveText(vi['prj.nationalCode.missing.badge']);
    await expect(cardOf(page, 'BUDGETED', ready).getByTestId('national-code')).toBeVisible();

    // The project without the national code is not moved: the confirmation names the guard and the button of the move stays off.
    await openMove(page, 'BUDGETED', missingCode);
    await expect(dialog(page).getByTestId('unmet')).toContainText(vi['prj.guard.nationalCode.label']);
    await expect(dialog(page).getByTestId('guards').locator('[data-guard="NATIONAL_CODE"]')).toHaveAttribute('data-state', 'UNMET');
    await expect(confirm(page)).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect(await projectOf(missingCode.id)).toMatchObject({ status: 'BUDGETED', version: '1' });
    expect(await sql('select count(*)::int as n from machvon.project_stage_change where project_id = $1', [missingCode.id])).toEqual([{ n: 0 }]);

    // The project with the code is started: the form is checked first, then the server moves it on the investment decision.
    await openMove(page, 'BUDGETED', ready);
    await expect(dialog(page).getByRole('radio').first()).toBeChecked();
    await confirm(page).click();
    await expect(dialog(page).getByText(vi['prj.board.reasonRequired.error'])).toBeVisible();
    await expect(dialog(page).getByText(vi['prj.board.documentRequired.error'])).toBeVisible();
    expect(await projectOf(ready.id)).toMatchObject({ status: 'BUDGETED', version: '1' });
    await fillMove(page, vi['prj.guard.investmentDecision.field'], decision);
    await confirm(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(cardOf(page, 'IMPLEMENTATION', ready)).toBeVisible();
    await expect(cardOf(page, 'BUDGETED', ready)).toHaveCount(0);
    expect(await projectOf(ready.id)).toEqual({ status: 'IMPLEMENTATION', version: '2', investment_decision_document_id: decision });

    // Suspended on a decision, then resumed with only a reason.
    await openMove(page, 'IMPLEMENTATION', ready);
    await dialog(page).getByRole('radio', { name: new RegExp(vi['prj.move.suspend.label']) }).check();
    await fillMove(page, vi['prj.guard.decision.field'], decision);
    await confirm(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(cardOf(page, 'SUSPENDED', ready)).toBeVisible();
    await openMove(page, 'SUSPENDED', ready);
    await expect(dialog(page).getByTestId('history')).toContainText(vi['prj.stage.implementation.label']);
    await fillMove(page, undefined, '');
    await confirm(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(cardOf(page, 'IMPLEMENTATION', ready)).toBeVisible();

    const moves = await sql<{ project_version: string; from_stage: string; to_stage: string; operation: string; actor_kind: string; actor_id: string; reason: string }>(
      'select project_version::text as project_version, from_stage, to_stage, operation, actor_kind, actor_id, reason from machvon.project_stage_change where project_id = $1 order by project_version',
      [ready.id],
    );
    expect(moves.map((move) => `${move.from_stage}>${move.to_stage}:${move.operation}:v${move.project_version}`)).toEqual([
      'BUDGETED>IMPLEMENTATION:startProjectImplementation:v2',
      'IMPLEMENTATION>SUSPENDED:suspendProject:v3',
      'SUSPENDED>IMPLEMENTATION:resumeProject:v4',
    ]);
    expect(moves.every((move) => move.actor_kind === 'USER' && move.actor_id === membershipOf('stageManager') && move.reason === TARGET_REASON)).toBe(true);
    expect(await sql("select count(*)::int as n from machvon.audit_event where action = 'project.stage_changed' and resource_id = $1", [ready.id])).toEqual([{ n: 3 }]);
    const events = await sql<{ payload: { from: string; to: string; decision_document_id: string | null } }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'project.stage_changed.v1' order by aggregate_version", [ready.id]);
    expect(events.map((event) => `${event.payload.from}>${event.payload.to}`)).toEqual(['BUDGETED>IMPLEMENTATION', 'IMPLEMENTATION>SUSPENDED', 'SUSPENDED>IMPLEMENTATION']);
    expect(events[0]?.payload.decision_document_id).toBe(decision);
    expect(await projectOf(ready.id)).toMatchObject({ status: 'IMPLEMENTATION', version: '4' });
  });

  test('the server refuses a move made on a stale version, tells it in the confirmation and changes nothing (AC-ST-PRJ-002-2)', async ({ page }) => {
    const { waiting } = seeded;
    const decision = await decisionDocument();
    await open(page, 'stageManager');
    await openMove(page, 'PIPELINE', waiting);
    await fillMove(page, vi['prj.guard.decision.field'], decision);
    // Someone else changes the project meanwhile.
    await sql('update machvon.project set version = version + 1 where id = $1', [waiting.id]);
    await confirm(page).click();
    await expect(dialog(page).getByTestId('refusal')).toHaveText(vi['prj.problem.versionConflict.error']);
    expect(await projectOf(waiting.id)).toMatchObject({ status: 'PIPELINE', version: '2' });
    expect(await sql('select count(*)::int as n from machvon.project_stage_change where project_id = $1', [waiting.id])).toEqual([{ n: 0 }]);
  });

  test('someone who may only cancel is offered only the cancellation, and a project they cannot move offers nothing (denied)', async ({ page }) => {
    const { budgeted, running } = seeded;
    await open(page, 'stageCanceller');
    await openMove(page, 'BUDGETED', budgeted);
    await expect(dialog(page).getByRole('radio')).toHaveCount(1);
    await expect(dialog(page).getByRole('radio').first()).toBeChecked();
    await expect(dialog(page)).toContainText(vi['prj.move.cancel.label']);
    await page.keyboard.press('Escape');
    await openMove(page, 'IMPLEMENTATION', running);
    await expect(dialog(page).getByTestId('no-moves')).toHaveText(vi['prj.board.dialog.noMoves.notice']);
    await expect(confirm(page)).toBeDisabled();
    expect(await projectOf(running.id)).toMatchObject({ status: 'IMPLEMENTATION', version: '1' });
  });

  test('someone who only reads sees the board without a button of change, and someone without the read permission is refused the screen (read-only)', async ({ page }) => {
    const budgeted = seeded.viewed;
    await open(page, 'projectViewer');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.board.page.title'] })).toBeVisible();
    await expect(cardOf(page, 'BUDGETED', budgeted)).toBeVisible();
    await expect(page.getByRole('button', { name: vi['prj.board.card.move.action'] })).toHaveCount(0);
    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('.prj-card')).toHaveCount(0);
  });
});
