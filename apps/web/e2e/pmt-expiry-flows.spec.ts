import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PMT-05 (permit expiry alerts) in a real browser against the real API and database (apps/api/test/e2e-stack): the officer sees the permits that run
 * out within the window and the expired ones no renewal has replaced, the soonest first, with the days left and the level of alert; a longer window
 * brings the later ones in; an expired permit has a way to its own screen to be renewed; an expired permit that was renewed is no longer on the
 * board; someone who may not read permits is denied. The reminders and the expiry themselves are the work of the job `permit-expiry`.
 */

const DAY_MS = 86_400_000;
/** The Vietnam date `days` days from now, the clock the board judges by. */
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);
const tenantA = (): string => stackInfo().tenants.A;

async function open(page: Page, user: string, path = '/pmt/pmt-05'): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function seedType(code: string): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, default_validity_months, status, created_by, updated_by)
     values ($1, $2, $3, $4, 'OTHER', 'Sở Xây dựng', 'Luật Xây dựng 135/2025, điều 43', date '2026-01-01', '{}'::jsonb, 12, 'PUBLISHED', $5, $5)`,
    [tenantA(), id, code, `Giấy phép ${code}`, membershipOf('owner')],
  );
  return id;
}

async function seedScan(): Promise<string> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'GP', 'Giấy phép', 'INTERNAL', $3, $3)`,
    [tenantA(), documentId, membershipOf('owner')],
  );
  await sql(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
    [tenantA(), versionId, documentId, `tenants/e2e/${versionId}.pdf`],
  );
  return versionId;
}

async function seedProjectWithDossier(label: string): Promise<{ projectId: string; projectCode: string; dossierId: string }> {
  const projectId = randomUUID();
  const dossierId = randomUUID();
  const projectCode = `E2E-EX-${label}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenantA()]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 'B', $7, 1, $8, $8)`,
    [tenantA(), projectId, projectCode, `Dự án ${label}`, stackInfo().units.A['CB-SKHDT-QLDA'], area?.id, String(9500000 + (Number.parseInt(projectId.slice(0, 5), 16) % 400000)), membershipOf('owner')],
  );
  await sql(`insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, owner_membership_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5, $5)`, [
    tenantA(),
    dossierId,
    projectId,
    stackInfo().units.A['CB-SKHDT-QLDA'],
    membershipOf('owner'),
  ]);
  return { projectId, projectCode, dossierId };
}

interface PermitSeed {
  dossierId: string;
  typeId: string;
  status: 'ISSUED' | 'EXPIRED';
  validUntil: string;
  no: string;
  alertLevel?: number;
  supersedes?: string;
  documentVersionId: string;
}

async function seedPermit(seed: PermitSeed): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, permit_no, status, authority_name, issued_on, valid_from, valid_until, document_version_id, supersedes_id,
                                 responsible_membership_id, alert_level_sent, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'Sở Xây dựng', date '2025-01-01', date '2025-01-01', $7::date, $8, $9, $10, $11, $10, $10)`,
    [tenantA(), id, seed.dossierId, seed.typeId, seed.no, seed.status, seed.validUntil, seed.documentVersionId, seed.supersedes ?? null, membershipOf('owner'), seed.alertLevel ?? 0],
  );
  return id;
}

const rowOf = (page: Page, permitId: string) => page.locator(`tr[data-permit-id="${permitId}"]`);

test.describe('PMT-05 permit expiry alerts', () => {
  test('lists the permits within the window and the expired ones not yet replaced, the soonest first, and a longer window brings the later ones in (AC-ST-PMT-006-1)', async ({ page }) => {
    const label = Date.now().toString(36).toUpperCase();
    const { dossierId, projectCode } = await seedProjectWithDossier(label);
    const scan = await seedScan();
    const types = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((suffix) => seedType(`E2E_EX_${label}_${suffix}`)));
    const [soonType, laterType, farType, expiredType, renewedType] = types as [string, string, string, string, string];
    const soon = await seedPermit({ dossierId, typeId: soonType, status: 'ISSUED', validUntil: inDays(10), no: `GP-${label}-A`, alertLevel: 3, documentVersionId: scan });
    const later = await seedPermit({ dossierId, typeId: laterType, status: 'ISSUED', validUntil: inDays(40), no: `GP-${label}-B`, alertLevel: 1, documentVersionId: scan });
    const far = await seedPermit({ dossierId, typeId: farType, status: 'ISSUED', validUntil: inDays(100), no: `GP-${label}-C`, documentVersionId: scan });
    const expired = await seedPermit({ dossierId, typeId: expiredType, status: 'EXPIRED', validUntil: inDays(-5), no: `GP-${label}-D`, alertLevel: 4, documentVersionId: scan });
    const renewedOld = await seedPermit({ dossierId, typeId: renewedType, status: 'EXPIRED', validUntil: inDays(-50), no: `GP-${label}-E`, alertLevel: 4, documentVersionId: scan });
    const renewedNew = await seedPermit({ dossierId, typeId: renewedType, status: 'ISSUED', validUntil: inDays(300), no: `GP-${label}-F`, supersedes: renewedOld, documentVersionId: scan });

    await open(page, 'permitOfficer');
    await expect(page.getByRole('heading', { level: 1, name: vi['pmt.expiry.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-renewal')).toHaveText(vi['pmt.expiry.note.noRenewal']);
    // The expired one first, then by last day; the far one, the replaced one and its replacement are not on the board.
    const mine = page.locator('tr[data-permit-id]').filter({ hasText: projectCode });
    await expect(mine).toHaveCount(3);
    expect(await mine.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-permit-id')))).toEqual([expired, soon, later]);
    await expect(rowOf(page, far)).toHaveCount(0);
    await expect(rowOf(page, renewedOld)).toHaveCount(0);
    await expect(rowOf(page, renewedNew)).toHaveCount(0);
    await expect(rowOf(page, expired).getByTestId('left')).toHaveText('Quá hạn 5 ngày');
    await expect(rowOf(page, expired).getByTestId('level')).toHaveText(vi['pmt.expiry.level.expired']);
    await expect(rowOf(page, soon).getByTestId('left')).toHaveText('10');
    await expect(rowOf(page, soon).getByTestId('level')).toHaveText('Còn 15 ngày');
    await expect(rowOf(page, later).getByTestId('level')).toHaveText('Còn 60 ngày');
    await expect(rowOf(page, soon)).toContainText(`GP-${label}-A`);

    // A longer window brings the later permit in.
    await page.getByLabel(vi['pmt.expiry.window.label']).selectOption('180');
    await expect(rowOf(page, far)).toBeVisible();
    await expect(rowOf(page, far).getByTestId('level')).toHaveText(vi['pmt.expiry.level.none']);
    await expect(rowOf(page, renewedNew)).toHaveCount(0);

    // The expired permit leads to its own screen, where it is renewed.
    await rowOf(page, expired).getByTestId('open-permit').click();
    await expect(page).toHaveURL(new RegExp(`/pmt/pmt-02\\?permit=${expired}`));
  });

  test('someone who may not read permits is denied and sees none of them', async ({ page }) => {
    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });
});
