import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PRJ-21 (the national project codes of the register) in a real browser against the real API and database (apps/api/test/e2e-stack): the planning
 * officer finds the projects that have no code, assigns one by hand, is told by the server when the code has not the format of the rule or belongs to
 * another project, and the database holds the code, the new version, the audit row and the event. The screen says that the adapter of the national
 * system is a proposal and calls nothing outside the application. Someone who only reads sees no button, and someone without the read permission is
 * refused the screen. The officer also uploads the reconciliation file, reads the dry run row by row and applies it once.
 */

interface SeededProject {
  id: string;
  code: string;
}

async function seed(status: string, nationalCode: string | null): Promise<SeededProject> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const id = randomUUID();
  const code = `E2E-NC-${Date.now().toString(36).toUpperCase()}-${id.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, $7, 'B', $8, 1, $9, $9)`,
    [tenant, id, code, `Dự án mã TTQG ${code}`, stackInfo().units.A['CB-SKHDT-QLDA'], area?.id, status, nationalCode, membershipOf('projectManager')],
  );
  return { id, code };
}

const freshCode = (): string => String(7_200_000 + Math.floor(Math.random() * 99_999));

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/prj/prj-21?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const rowOf = (page: Page, project: SeededProject) => page.locator(`tr[data-project-id="${project.id}"]`);
const projectOf = async (id: string) =>
  (await sql<{ national_project_code: string | null; version: string; status: string }>('select national_project_code, version::text as version, status from machvon.project where id = $1', [id]))[0];

test.describe('PRJ-21 the national project codes of the register', () => {
  test('the officer assigns a code by hand, is refused a code of the wrong format or one that is held, and the database holds the code, the audit row and the event (AC-ST-PRJ-004-1, UI-PRJ-21)', async ({ page }) => {
    const target = await seed('BUDGETED', null);
    const held = freshCode();
    await seed('BUDGETED', held);
    const outside: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') outside.push(request.url());
    });

    await open(page, 'nationalCodeAdmin');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.reconcile.page.title'] })).toBeVisible();
    await expect(page.getByTestId('adapter-badge')).toHaveText(vi['prj.reconcile.adapter.badge']);
    await expect(rowOf(page, target).getByTestId('national-code-missing')).toHaveText(vi['prj.nationalCode.missing.badge']);
    await expect(rowOf(page, target).getByTestId('state')).toHaveText(vi['prj.reconcile.state.missing.label']);

    await rowOf(page, target).getByRole('button').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('current-code')).toHaveText(vi['prj.reconcile.dialog.current.none']);
    await dialog.getByRole('button', { name: vi['prj.reconcile.dialog.submit.action'] }).click();
    await expect(dialog.getByText(vi['prj.reconcile.field.codeRequired.error'])).toBeVisible();

    await dialog.getByLabel(vi['prj.reconcile.dialog.code.label'], { exact: true }).fill('ABC-123');
    await dialog.getByRole('button', { name: vi['prj.reconcile.dialog.submit.action'] }).click();
    await expect(dialog.getByTestId('refusal')).toHaveText(vi['prj.reconcile.problem.formatInvalid.error']);
    await dialog.getByLabel(vi['prj.reconcile.dialog.code.label'], { exact: true }).fill(held);
    await dialog.getByRole('button', { name: vi['prj.reconcile.dialog.submit.action'] }).click();
    await expect(dialog.getByTestId('refusal')).toHaveText(vi['prj.reconcile.problem.duplicate.error']);
    expect(await projectOf(target.id)).toEqual({ national_project_code: null, version: '1', status: 'BUDGETED' });

    const code = freshCode();
    await dialog.getByLabel(vi['prj.reconcile.dialog.code.label'], { exact: true }).fill(code);
    await dialog.getByRole('button', { name: vi['prj.reconcile.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The project has its code, so the list that shows the missing ones no longer holds it.
    await expect(rowOf(page, target)).toHaveCount(0);
    expect(await projectOf(target.id)).toEqual({ national_project_code: code, version: '2', status: 'BUDGETED' });
    const audit = await sql<{ safe_diff: Record<string, unknown>; actor_id: string }>("select safe_diff, actor_id from machvon.audit_event where action = 'project.national_code_assigned' and resource_id = $1", [target.id]);
    expect(audit).toEqual([{ safe_diff: { code: target.code, previous_national_project_code: null, national_project_code: code, evidence_document_id: null, via: 'MANUAL' }, actor_id: membershipOf('nationalCodeAdmin') }]);
    const events = await sql<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'project.national_code_assigned.v1' and aggregate_id = $1", [target.id]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ project_id: target.id, version: 2, national_project_code: code, previous_national_project_code: null, via: 'MANUAL' });
    // Nothing was asked of a system outside the application.
    expect(outside).toEqual([]);

    // Shown again with the filter off, the project has its code and says so.
    await page.getByLabel(vi['prj.reconcile.missingOnly.label']).uncheck();
    await expect(rowOf(page, target).getByTestId('national-code')).toHaveText(code);
    await expect(rowOf(page, target).getByTestId('state')).toHaveText(vi['prj.reconcile.state.hasCode.label']);
  });

  test('a project under way keeps its code unless the change is grounded in a document (AC-ST-PRJ-004-1)', async ({ page }) => {
    const running = await seed('IMPLEMENTATION', freshCode());
    const before = await projectOf(running.id);
    await open(page, 'nationalCodeAdmin');
    await page.getByLabel(vi['prj.reconcile.missingOnly.label']).uncheck();
    await rowOf(page, running).getByRole('button').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(vi['prj.reconcile.dialog.evidence.required']);
    await dialog.getByLabel(vi['prj.reconcile.dialog.code.label'], { exact: true }).fill(freshCode());
    await dialog.getByRole('button', { name: vi['prj.reconcile.dialog.submit.action'] }).click();
    await expect(dialog.getByText(vi['prj.reconcile.field.evidenceRequired.error'])).toBeVisible();
    expect(await projectOf(running.id)).toEqual(before);
    const [document] = await sql<{ id: string }>("select id from machvon.document where symbol = 'QD-E2E-2/2026'");
    const code = freshCode();
    await dialog.getByLabel(vi['prj.reconcile.dialog.code.label'], { exact: true }).fill(code);
    await dialog.getByLabel(vi['prj.reconcile.dialog.evidence.label'], { exact: true }).fill(document?.id ?? '');
    await dialog.getByRole('button', { name: vi['prj.reconcile.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await projectOf(running.id)).toEqual({ national_project_code: code, version: '2', status: 'IMPLEMENTATION' });
    expect(await sql("select safe_diff->>'evidence_document_id' as evidence from machvon.audit_event where action = 'project.national_code_assigned' and resource_id = $1", [running.id])).toEqual([{ evidence: document?.id }]);
  });

  test('the officer uploads the reconciliation file, reads the dry run row by row, applies it once, and the second apply is refused (AC-ST-PRJ-004-2, UI-PRJ-21)', async ({ page }) => {
    const [a, b, c] = [await seed('BUDGETED', null), await seed('BUDGETED', null), await seed('BUDGETED', null)];
    const first = freshCode();
    const second = freshCode();
    const bytes = Buffer.from(['internal_code,national_project_code', `${a.code},${first}`, `${b.code},${second}`, `${c.code},${first}`].join('\n'));
    const file = { name: 'national_codes.csv', mimeType: 'text/csv', buffer: bytes };

    await open(page, 'nationalCodeAdmin');
    const panel = page.getByTestId('import-panel');
    await expect(panel).toContainText(vi['prj.reconcile.import.layout.note']);
    await expect(panel.getByRole('button', { name: vi['prj.reconcile.import.check.action'] })).toBeDisabled();
    await panel.getByLabel(vi['prj.reconcile.import.file.label']).setInputFiles(file);
    await panel.getByRole('button', { name: vi['prj.reconcile.import.check.action'] }).click();

    // The dry run: two rows would be taken, the third repeats a code of the file; nothing has been written.
    await expect(panel.getByTestId('import-counts')).toHaveText(vi['prj.reconcile.import.preview.counts'].replace('{total}', '3').replace('{valid}', '2').replace('{repeats}', '0').replace('{errors}', '1'));
    await expect(panel.locator(`[data-line="4"][data-status="ERROR"]`)).toContainText(vi['prj.reconcile.importRow.duplicate.text']);
    expect(await projectOf(a.id)).toMatchObject({ national_project_code: null, version: '1' });
    expect(await sql('select id from machvon.file_import where connector_code = $1', ['NATIONAL_PIM_FILE'])).toEqual([]);

    await panel.getByRole('button', { name: vi['prj.reconcile.import.apply.action'] }).click();
    await expect(panel.getByTestId('import-applied')).toHaveText(vi['prj.reconcile.import.applied.notice']);
    expect(await projectOf(a.id)).toMatchObject({ national_project_code: first, version: '2' });
    expect(await projectOf(b.id)).toMatchObject({ national_project_code: second, version: '2' });
    expect(await projectOf(c.id)).toMatchObject({ national_project_code: null, version: '1' });
    expect(await sql("select count(*)::int as n from machvon.audit_event where action = 'project.national_code_import_applied'")).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from machvon.outbox_event where type = 'project.national_code_assigned.v1' and aggregate_id = any($1::uuid[])", [[a.id, b.id]])).toEqual([{ n: 2 }]);

    // The same file again: the dry run says it was applied, and the apply is not offered.
    await panel.getByLabel(vi['prj.reconcile.import.file.label']).setInputFiles(file);
    await panel.getByRole('button', { name: vi['prj.reconcile.import.check.action'] }).click();
    await expect(panel.getByTestId('import-already')).toHaveText(vi['prj.reconcile.import.already.notice']);
    await expect(panel.getByRole('button', { name: vi['prj.reconcile.import.apply.action'] })).toBeDisabled();
  });

  test('someone who only reads sees the codes and no button, and someone without the read permission is refused the screen (read-only, denied)', async ({ page }) => {
    const waiting = await seed('BUDGETED', null);
    await open(page, 'projectViewer');
    await expect(page.getByTestId('adapter-badge')).toHaveText(vi['prj.reconcile.adapter.badge']);
    await expect(rowOf(page, waiting).getByTestId('state')).toHaveText(vi['prj.reconcile.state.missing.label']);
    await expect(page.getByRole('button', { name: new RegExp(vi['prj.reconcile.assign.action']) })).toHaveCount(0);
    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    expect(await projectOf(waiting.id)).toMatchObject({ national_project_code: null, version: '1' });
  });
});
