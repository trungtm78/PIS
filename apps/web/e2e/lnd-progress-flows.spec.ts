import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * LND-11 (progress when the land fund centre executes) and LND-01 (the overview of the land clearance of a project) in a real browser against the real API and database
 * (apps/api/test/e2e-stack): the officer of the project gives a stage to the centre and reports on it with the evidence of a clean document; a stage behind its planned end is
 * late, asks ISS for one issue and shows on the overview with the unit that executes it; the figures of the overview equal the rows under it. Someone who may only read sees
 * the board and the overview and no button.
 */

const OWNER_UNIT = 'CB-SKHDT-QLDA';
const CENTRE_UNIT = 'CB-STC';
const CENTRE_NAME = 'Sở Tài chính';

async function seedProject(): Promise<{ id: string; code: string; section: { id: string; code: string } }> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const id = randomUUID();
  const code = `E2E-PRG-${Date.now().toString(36).toUpperCase()}-${id.slice(0, 4).toUpperCase()}`;
  const officer = membershipOf('progressOfficer');
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, id, code, `Dự án GPMB ${code}`, stackInfo().units.A[OWNER_UNIT], area?.id, officer],
  );
  const section = { id: randomUUID(), code: `SEC-${id.slice(0, 4).toUpperCase()}` };
  await sql(
    `insert into machvon.land_handover_section (tenant_id, id, project_id, code, name, required_area_m2, status, version, created_by, updated_by)
     values ($1, $2, $3, $4, 'Km 0 đến km 3', 30000, 'NOT_READY', 1, $5, $5)`,
    [tenant, section.id, id, section.code, officer],
  );
  for (const n of [1, 2]) {
    await sql(
      `insert into machvon.land_parcel (tenant_id, id, project_id, section_id, owner_unit_id, parcel_code, land_use_group, area_total_m2, area_affected_m2, status, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'AGRICULTURAL', 100, 50, 'SURVEYED', 1, $7, $7)`,
      [tenant, randomUUID(), id, section.id, stackInfo().units.A[OWNER_UNIT], `E2E-${code}-${n}`, officer],
    );
  }
  return { id, code, section };
}

/** The report of the executing unit: a clean version, as the upload pipeline leaves it. */
async function evidenceDocument(): Promise<string> {
  const tenant = stackInfo().tenants.A;
  const documentId = randomUUID();
  const versionId = randomUUID();
  await sql(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'TB', 'Báo cáo kiểm đếm của Trung tâm', 'INTERNAL', $3, $3)`, [
    tenant,
    documentId,
    membershipOf('progressOfficer'),
  ]);
  await sql(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
    [tenant, versionId, documentId, `tenants/${tenant}/e2e/${versionId}.pdf`],
  );
  return versionId;
}

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const stageRows = (projectId: string) =>
  sql<{ id: string; mode: string; status: string; parcels_total: number; parcels_done: number; progress_pct: string; evidence_document_version_id: string | null; executor_unit_id: string; version: string }>(
    `select id, mode, status, parcels_total, parcels_done, progress_pct::text as progress_pct, evidence_document_version_id, executor_unit_id, version::text as version
       from machvon.land_stage_progress where project_id = $1 order by stage_code`,
    [projectId],
  );

test.describe('LND-11 and LND-01: the progress of the stages that an external centre executes', () => {
  test('the officer reports the stage of the centre with evidence, the late stage shows on the overview with the centre, and the figures equal the rows (AC-ST-LND-010-1, UAT-AC387, UI-LND-11, UI-LND-01)', async ({ page }) => {
    const project = await seedProject();
    const document = await evidenceDocument();
    await open(page, 'progressOfficer', `/lnd/lnd-11?project=${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.progress.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-stages')).toHaveText(vi['lnd.progress.empty.notice']);

    await page.getByRole('button', { name: vi['lnd.progress.report.action'] }).click();
    // The form refuses what is missing before anything is sent.
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.progress.field.required']).first()).toBeVisible();
    await page.getByLabel(vi['lnd.progress.field.section'], { exact: true }).selectOption(project.section.id);
    await page.getByLabel(vi['lnd.progress.field.stage'], { exact: true }).selectOption('INVENTORY');
    await page.getByLabel(vi['lnd.progress.field.executorKind'], { exact: true }).selectOption('LAND_FUND_CENTRE');
    await page.getByLabel(vi['lnd.progress.field.executorUnit'], { exact: true }).selectOption({ label: CENTRE_NAME });
    await page.getByLabel(vi['lnd.progress.field.parcelsTotal'], { exact: true }).fill('120');
    await page.getByLabel(vi['lnd.progress.field.parcelsDone'], { exact: true }).fill('121');
    await page.getByLabel(vi['lnd.progress.field.plannedEnd'], { exact: true }).fill('2026-01-31');
    await page.getByLabel(vi['lnd.progress.field.evidence'], { exact: true }).fill(document);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.progress.field.exceeds'])).toBeVisible();
    await page.getByLabel(vi['lnd.progress.field.parcelsDone'], { exact: true }).fill('45');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();

    const row = page.locator('[data-stage-id]').first();
    await expect(row.getByTestId('parcels')).toHaveText('45 / 120');
    await expect(row.getByTestId('progress')).toHaveText('37.50%');
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.stageStatus.late.label']);
    await expect(row.getByTestId('mode')).toHaveText(vi['lnd.mode.trackedExternal.label']);
    await expect(row.getByTestId('evidence')).toBeVisible();
    await expect(row.getByTestId('executor')).toContainText(CENTRE_NAME);

    const [stored] = await stageRows(project.id);
    expect(stored).toMatchObject({
      mode: 'TRACKED_EXTERNAL',
      status: 'LATE',
      parcels_total: 120,
      parcels_done: 45,
      progress_pct: '37.50',
      evidence_document_version_id: document,
      executor_unit_id: stackInfo().units.A[CENTRE_UNIT],
      version: '1',
    });
    const asked = async () => (await sql<{ n: string }>("select count(*)::text as n from machvon.outbox_event where aggregate_id = $1 and type = 'lnd.stage.late.v1'", [stored?.id]))[0]?.n;
    expect(await asked()).toBe('1');

    // A later report of the same stage is the same row, and it asks for no second issue.
    await row.getByRole('button').click();
    await page.getByLabel(vi['lnd.progress.field.parcelsDone'], { exact: true }).fill('60');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(row.getByTestId('parcels')).toHaveText('60 / 120');
    await expect(row.getByTestId('progress')).toHaveText('50.00%');
    expect(await stageRows(project.id)).toHaveLength(1);
    expect(await asked()).toBe('1');

    // The overview counts the same rows.
    await page.goto(`/lnd/lnd-01?project=${project.id}&devUser=progressOfficer`);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.overview.page.title'] })).toBeVisible();
    await expect(page.getByTestId('tile-parcels')).toContainText('2');
    await expect(page.getByTestId('tile-late')).toContainText('1');
    const late = page.getByTestId('late-stages');
    await expect(late.getByTestId('executor')).toContainText(CENTRE_NAME);
    await expect(late.getByText(vi['lnd.stage.inventory.label'])).toBeVisible();
    await expect(page.getByTestId('sections').getByText(`${project.section.code} · Km 0 đến km 3`)).toBeVisible();
    const [rows] = await sql<{ parcels: string; late: string }>(
      "select (select count(*) from machvon.land_parcel where project_id = $1)::text as parcels, (select count(*) from machvon.land_stage_progress where project_id = $1 and status = 'LATE')::text as late",
      [project.id],
    );
    await expect(page.getByTestId('tile-parcels')).toContainText(String(rows?.parcels));
    await expect(page.getByTestId('tile-late')).toContainText(String(rows?.late));
  });

  test('someone who may only read sees the board and the overview and no button (UI-LND-11)', async ({ page }) => {
    const project = await seedProject();
    const document = await evidenceDocument();
    const tenant = stackInfo().tenants.A;
    await sql(
      `insert into machvon.land_stage_progress
         (tenant_id, id, project_id, section_id, stage_code, executor_kind, executor_unit_id, mode, planned_end, parcels_total, parcels_done, last_reported_by, last_reported_at, evidence_document_version_id, status, version, created_by, updated_by)
       values ($1, $2, $3, $4, 'SURVEY', 'LAND_FUND_CENTRE', $5, 'TRACKED_EXTERNAL', date '2099-01-01', 10, 3, $6, now(), $7, 'IN_PROGRESS', 1, $6, $6)`,
      [tenant, randomUUID(), project.id, project.section.id, stackInfo().units.A[CENTRE_UNIT], membershipOf('progressOfficer'), document],
    );
    await open(page, 'progressReader', `/lnd/lnd-11?project=${project.id}`);
    const row = page.locator('[data-stage-id]').first();
    await expect(row.getByTestId('parcels')).toHaveText('3 / 10');
    await expect(page.getByRole('button', { name: vi['lnd.progress.report.action'] })).toHaveCount(0);
    await expect(row.getByRole('button')).toHaveCount(0);
    await page.goto(`/lnd/lnd-01?project=${project.id}&devUser=progressReader`);
    await expect(page.getByTestId('tile-late')).toContainText('0');
    await expect(page.getByTestId('no-late')).toHaveText(vi['lnd.overview.late.none']);
  });
});
