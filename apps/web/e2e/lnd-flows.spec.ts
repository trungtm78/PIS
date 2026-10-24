import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * LND-02 (the parcels of a project and the recovery notice timers) in a real browser against the real API and database (apps/api/test/e2e-stack): an
 * officer declares a parcel, gives the notice of recovery and the timer of 90 days (agricultural land) or 180 (the rest) starts from the notice date with the
 * rule and its legal basis; a parcel list is imported once and the same file again creates nothing; a file with a column for an owner is refused and kept
 * nowhere; someone who may only read sees the parcels and no button. A parcel carries no owner or user of the land.
 */

const HEADER = 'parcel_code,owner_unit_code,land_use_group,area_total_m2,area_affected_m2,address_text,section_code';
const UNIT_CODE = 'CB-SKHDT-QLDA';
const UNIT_NAME = 'Ban Quản lý dự án';

async function seedProject(): Promise<{ id: string; code: string }> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const id = randomUUID();
  const code = `E2E-LND-${Date.now().toString(36).toUpperCase()}-${id.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, id, code, `Dự án GPMB ${code}`, stackInfo().units.A[UNIT_CODE], area?.id, membershipOf('landOfficer')],
  );
  return { id, code };
}

/** The document of a recovery notice: a clean version, as the upload pipeline leaves it. */
async function noticeDocument(): Promise<string> {
  const tenant = stackInfo().tenants.A;
  const documentId = randomUUID();
  const versionId = randomUUID();
  await sql(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'TB', 'Thông báo thu hồi đất', 'INTERNAL', $3, $3)`, [
    tenant,
    documentId,
    membershipOf('landOfficer'),
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

test.describe('LND-02: the parcels of a project and the recovery notice timers', () => {
  test('a parcel is declared, its notice starts 90 days for agricultural land and 180 for the rest, and the database holds the timers (AC-ST-LND-001-1, UI-LND-02)', async ({ page }) => {
    const project = await seedProject();
    const document = await noticeDocument();
    await open(page, 'landOfficer', `/lnd/lnd-02?project=${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.parcels.page.title'] })).toBeVisible();
    await expect(page.getByTestId('privacy-note')).toHaveText(vi['lnd.parcels.privacy.note']);

    for (const [code, landUse, timer, due, days] of [
      ['E2E-A-001', 'AGRICULTURAL', 'NOTICE_AGRICULTURAL_90', '2026-09-29', 90],
      ['E2E-A-002', 'NON_AGRICULTURAL_RESIDENTIAL', 'NOTICE_NON_AGRICULTURAL_180', '2026-12-28', 180],
    ] as const) {
      await page.getByRole('button', { name: vi['lnd.parcels.create.action'] }).click();
      // The form refuses what is missing before anything is sent.
      await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
      await expect(page.getByText(vi['lnd.field.required.error']).first()).toBeVisible();
      await page.getByLabel(vi['lnd.parcelDialog.code.label'], { exact: true }).fill(code);
      await page.getByLabel(vi['lnd.parcelDialog.unit.label'], { exact: true }).selectOption({ label: UNIT_NAME });
      await page.getByLabel(vi['lnd.parcelDialog.landUse.label'], { exact: true }).selectOption(landUse);
      await page.getByLabel(vi['lnd.parcelDialog.areaTotal.label'], { exact: true }).fill('1200.5');
      await page.getByLabel(vi['lnd.parcelDialog.areaAffected.label'], { exact: true }).fill('800');
      await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
      const row = page.locator('[data-parcel-id]', { hasText: code });
      await expect(row).toBeVisible();
      await expect(row.getByTestId('notice')).toHaveText(vi['lnd.notice.none.label']);

      await row.getByRole('button').click();
      await page.getByLabel(vi['lnd.noticeDialog.date.label'], { exact: true }).fill('2026-07-01');
      await page.getByLabel(vi['lnd.noticeDialog.document.label'], { exact: true }).fill(document);
      await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
      await expect(row.getByTestId('notice-awaiting')).toBeVisible();
      await expect(row.getByTestId('notice')).toContainText(vi['lnd.parcels.notice.line'].replace('{on}', '2026-07-01').replace('{days}', String(days)).replace('{due}', due));
      await expect(row.getByTestId('notice-basis')).toContainText('CXN-12');
      await expect(row.getByRole('button')).toHaveCount(0);

      const [deadline] = await sql<{ timer_code: string; due_on: string; days_applied: number; status: string }>(
        `select d.timer_code, d.due_on::text as due_on, d.days_applied, d.status from machvon.land_deadline d join machvon.land_parcel p on p.id = d.subject_id where p.project_id = $1 and p.parcel_code = $2`,
        [project.id, code],
      );
      expect(deadline).toEqual({ timer_code: timer, due_on: due, days_applied: days, status: 'RUNNING' });
    }

    // The database refuses a decision to recover before the end of the notice, whoever writes it (land_parcel_notice_chk).
    await expect(
      sql("update machvon.land_parcel set recovery_decision_on = date '2026-09-28' where project_id = $1 and parcel_code = 'E2E-A-001'", [project.id]),
    ).rejects.toThrow(/land_parcel_notice_chk/);
    expect(await sql('select action from machvon.audit_event where action = $1 and resource_id in (select id from machvon.land_parcel where project_id = $2)', ['land.recovery_notice_recorded', project.id])).toHaveLength(2);
  });

  test('a parcel list is imported once, the same file again creates nothing, and a file with an owner column is refused and kept nowhere (AC-ST-LND-001-2, UI-LND-02)', async ({ page }) => {
    const project = await seedProject();
    await open(page, 'landOfficer', `/lnd/lnd-02?project=${project.id}`);
    const chooser = page.getByLabel(vi['lnd.import.file.label']);
    const file = { name: 'parcels.csv', mimeType: 'text/csv', buffer: Buffer.from(`${HEADER}\nIMP-1,${UNIT_CODE},AGRICULTURAL,100,50,,\nIMP-2,${UNIT_CODE},PUBLIC,200,0,,`) };
    await chooser.setInputFiles(file);
    await page.getByRole('button', { name: vi['lnd.import.check.action'] }).click();
    await expect(page.getByTestId('import-layout')).toBeVisible();
    await page.getByRole('button', { name: vi['lnd.import.run.action'] }).click();
    await expect(page.getByTestId('import-result')).toHaveAttribute('data-outcome', 'APPLIED');
    expect(await sql('select parcel_code, status from machvon.land_parcel where project_id = $1 order by parcel_code', [project.id])).toEqual([
      { parcel_code: 'IMP-1', status: 'SURVEYED' },
      { parcel_code: 'IMP-2', status: 'SURVEYED' },
    ]);
    await expect(page.locator('[data-parcel-id]')).toHaveCount(2);

    // The same file again: nothing is created.
    await chooser.setInputFiles(file);
    await page.getByRole('button', { name: vi['lnd.import.check.action'] }).click();
    await expect(page.getByTestId('import-layout')).toBeVisible();
    await page.getByRole('button', { name: vi['lnd.import.run.action'] }).click();
    await expect(page.getByTestId('import-result')).toHaveAttribute('data-outcome', 'ALREADY_IMPORTED');
    expect(await sql('select 1 from machvon.land_parcel where project_id = $1', [project.id])).toHaveLength(2);

    // A file with a column for an owner is refused at the door and the import stays closed.
    await chooser.setInputFiles({ name: 'owners.csv', mimeType: 'text/csv', buffer: Buffer.from(`${HEADER},owner_name\nIMP-3,${UNIT_CODE},AGRICULTURAL,100,50,,,Nguyen Van A`) });
    await page.getByRole('button', { name: vi['lnd.import.check.action'] }).click();
    await expect(page.getByTestId('import-unknown')).toContainText('owner_name');
    await expect(page.getByTestId('import-refusal')).toHaveText(vi['lnd.import.problem.schemaInvalid.error']);
    await expect(page.getByRole('button', { name: vi['lnd.import.run.action'] })).toBeDisabled();
    expect(await sql('select 1 from machvon.land_parcel where project_id = $1', [project.id])).toHaveLength(2);
  });

  test('a section is created for the project, and someone who may only read sees the parcels and no button (UI-LND-02)', async ({ page }) => {
    const project = await seedProject();
    await open(page, 'landOfficer', `/lnd/lnd-02?project=${project.id}`);
    await page.getByRole('button', { name: vi['lnd.parcels.section.action'] }).click();
    await page.getByLabel(vi['lnd.sectionDialog.code.label'], { exact: true }).fill('KM-0-3');
    await page.getByLabel(vi['lnd.sectionDialog.name.label'], { exact: true }).fill('Km 0 đến km 3');
    await page.getByLabel(vi['lnd.sectionDialog.area.label'], { exact: true }).fill('30000');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await sql('select code, status from machvon.land_handover_section where project_id = $1', [project.id])).toEqual([{ code: 'KM-0-3', status: 'NOT_READY' }]);
    await expect(page.getByLabel(vi['lnd.parcels.section.label'], { exact: true }).locator('option', { hasText: 'KM-0-3' })).toHaveCount(1);

    await open(page, 'landReader', `/lnd/lnd-02?project=${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.parcels.page.title'] })).toBeVisible();
    await expect(page.getByRole('button', { name: vi['lnd.parcels.create.action'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['lnd.parcels.section.action'] })).toHaveCount(0);
    await expect(page.getByTestId('import-denied')).toHaveText(vi['lnd.import.denied.notice']);
  });
});
