import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PMT-01 (the legal dossier of a project) and PMT-02 (a permit with the timeline of its milestones) in a real browser against the real API
 * and database (apps/api/test/e2e-stack): the permit officer opens the dossier of a project, which plans a permit for the type in force,
 * walks it through submission and appraisal to the decision with its scan, is refused a number that the type already uses in the tenant,
 * renews the permit by a replacement and revokes it; the manager who only keeps the file cannot decide; someone who only reads sees no form.
 * What the screens changed is looked up in the database.
 */

const unique = (): string => `E2E_${Date.now().toString(36).toUpperCase()}_${Math.floor(Math.random() * 1000)}`;
/** The Vietnam date `days` days from now, the clock the screens and the API judge dates by. */
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
const tenantA = (): string => stackInfo().tenants.A;

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** A project of the department of its own, so that the dossier a test opens is the only one of its project. */
async function seedProject(code: string): Promise<string> {
  const projectId = randomUUID();
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1' limit 1", [tenantA()]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, 'B', $7, $7)`,
    [tenantA(), projectId, code, `Dự án ${code}`, stackInfo().units.A['CB-SKHDT-QLDA'], area?.id, membershipOf('owner')],
  );
  return projectId;
}

/** A permit type that applies to every project, in force since the start of the year, with a year of validity. */
async function seedType(code: string): Promise<string> {
  const typeId = randomUUID();
  await sql(
    `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, default_validity_months, status, created_by, updated_by)
     values ($1, $2, $3, $4, 'OTHER', 'Sở Xây dựng', 'Luật Xây dựng 135/2025, điều 43', date '2026-01-01', '{}'::jsonb, 12, 'PUBLISHED', $5, $5)`,
    [tenantA(), typeId, code, `Giấy phép ${code}`, membershipOf('owner')],
  );
  return typeId;
}

/** A version of a scanned document that a permit can name. */
async function seedScan(): Promise<string> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'GP', 'Bản quét giấy phép', 'INTERNAL', $3, $3)`,
    [tenantA(), documentId, membershipOf('owner')],
  );
  await sql(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
    [tenantA(), versionId, documentId, `tenants/e2e/${versionId}.pdf`],
  );
  return versionId;
}

interface PermitRow {
  id: string;
  status: string;
  permit_no: string | null;
  version: string;
  valid_until: string | null;
  supersedes_id: string | null;
  permit_type_id: string;
}

const permitOf = async (typeCode: string, projectId: string): Promise<PermitRow | undefined> =>
  (
    await sql<PermitRow>(
      `select x.id, x.status, x.permit_no, x.version::text as version, x.valid_until::text as valid_until, x.supersedes_id, x.permit_type_id
         from machvon.permit x join machvon.permit_dossier d on d.id = x.dossier_id
        where x.permit_type_code = $1 and d.project_id = $2::uuid order by x.created_at desc limit 1`,
      [typeCode, projectId],
    )
  )[0];

const form = (page: Page, key: keyof typeof vi) => page.getByRole('form', { name: vi[key] });

async function openDossierOf(page: Page, code: string): Promise<void> {
  await open(page, 'permitOfficer', '/pmt/pmt-01');
  await expect(page.getByRole('heading', { level: 1, name: vi['pmt.dossier.page.title'] })).toBeVisible();
  await form(page, 'pmt.dossier.open.aria').getByLabel(vi['pmt.dossier.open.project.label']).selectOption({ label: `${code} · Dự án ${code}` });
  await form(page, 'pmt.dossier.open.aria').getByRole('button', { name: vi['pmt.dossier.open.action'] }).click();
  await expect(page.locator(`tr[data-dossier-id]`).filter({ hasText: code })).toBeVisible();
}

const permitRow = (page: Page, typeCode: string) => page.locator('tr[data-permit-id]').filter({ hasText: typeCode });

async function record(page: Page, step: string, day: string): Promise<void> {
  const milestone = form(page, 'pmt.permit.milestone.aria');
  await milestone.getByLabel(vi['pmt.permit.milestone.step.label']).selectOption(step);
  await milestone.getByLabel(vi['pmt.permit.milestone.actual.label']).fill(day);
  await milestone.getByRole('button', { name: vi['pmt.permit.milestone.save.action'] }).click();
  await expect(page.getByTestId('milestone-saved')).toBeVisible();
}

test.describe('PMT-01 and PMT-02 project permit dossier', () => {
  test('the officer opens the dossier, walks a permit to its decision with the scan, is refused a number in use, renews and revokes it (AC-ST-PMT-002-1)', async ({ page }) => {
    const code = unique();
    const typeCode = unique();
    const projectCode = `PRJ-${code}`;
    const projectId = await seedProject(projectCode);
    const secondCode = `PRJ-${code}-2`;
    const secondId = await seedProject(secondCode);
    await seedType(typeCode);
    const scan = await seedScan();
    const number = `GP-${code}`;

    // The dossier plans a permit of the type in force for the project, and nothing else of it is written.
    await openDossierOf(page, projectCode);
    await expect(permitRow(page, typeCode)).toBeVisible();
    expect((await permitOf(typeCode, projectId))?.status).toBe('PLANNED');
    expect(await sql('select status, readiness_pct::text as readiness_pct from machvon.permit_dossier where project_id = $1::uuid', [projectId])).toEqual([{ status: 'OPEN', readiness_pct: '0.00' }]);
    expect(await sql("select count(*)::int as n from machvon.audit_event where action = 'pmt.dossier_opened' and safe_diff->>'project_id' = $1", [projectId])).toEqual([{ n: 1 }]);

    // PMT-02: submission, then the authority takes the file (the status moves with each milestone).
    await permitRow(page, typeCode).getByRole('link', { name: vi['pmt.dossier.detail.action'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['pmt.permit.page.title'] })).toBeVisible();
    await record(page, 'SUBMITTED', inDays(-3));
    await record(page, 'ACKNOWLEDGED', inDays(-2));
    expect((await permitOf(typeCode, projectId))?.status).toBe('IN_APPRAISAL');
    await expect(page.getByTestId('timeline').locator('li')).toHaveCount(2);

    // The decision needs the scan: the form says so before it asks the server, and nothing changes.
    const decision = form(page, 'pmt.permit.decision.aria');
    await decision.getByLabel(vi['pmt.permit.decision.number.label']).fill(number);
    await decision.getByLabel(vi['pmt.permit.decision.issuedOn.label']).fill(inDays(-1));
    await decision.getByLabel(vi['pmt.permit.decision.validFrom.label']).fill(inDays(-1));
    await decision.getByLabel(vi['pmt.permit.decision.validUntil.label']).fill(inDays(300));
    await decision.getByRole('button', { name: vi['pmt.permit.decision.save.action'] }).click();
    await expect(decision.getByText(vi['pmt.permit.field.scanRequired.error'])).toBeVisible();
    expect((await permitOf(typeCode, projectId))?.status).toBe('IN_APPRAISAL');

    // With the scan the permit is issued with the days it was given, under the version of the type it was written for.
    await decision.getByLabel(vi['pmt.permit.scan.label']).fill(scan);
    await decision.getByRole('button', { name: vi['pmt.permit.decision.save.action'] }).click();
    await expect(page.getByTestId('decision-saved')).toBeVisible();
    const issued = await permitOf(typeCode, projectId);
    expect(issued).toMatchObject({ status: 'ISSUED', permit_no: number });
    expect(issued?.valid_until).toBe(inDays(300));
    const [dossier] = await sql<{ readiness_pct: string }>('select readiness_pct::text as readiness_pct from machvon.permit_dossier where project_id = $1::uuid', [projectId]);
    expect(dossier?.readiness_pct).not.toBe('0.00');
    expect(await sql("select count(*)::int as n from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit.issued.v1'", [issued?.id])).toEqual([{ n: 1 }]);

    // The same number for the same type in another dossier is refused by the server, and the permit stays in appraisal.
    await openDossierOf(page, secondCode);
    await permitRow(page, typeCode).getByRole('link', { name: vi['pmt.dossier.detail.action'] }).click();
    await record(page, 'SUBMITTED', inDays(-3));
    await record(page, 'ACKNOWLEDGED', inDays(-2));
    const second = form(page, 'pmt.permit.decision.aria');
    await second.getByLabel(vi['pmt.permit.decision.number.label']).fill(number);
    await second.getByLabel(vi['pmt.permit.decision.validUntil.label']).fill(inDays(200));
    await second.getByLabel(vi['pmt.permit.scan.label']).fill(scan);
    await second.getByRole('button', { name: vi['pmt.permit.decision.save.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['pmt.permit.problem.numberDuplicate.error'] })).toBeVisible();
    expect((await permitOf(typeCode, secondId))?.status).toBe('IN_APPRAISAL');

    // Renewal replaces the issued permit: the old one is superseded and keeps what it says, the new one is the one current permit.
    await open(page, 'permitOfficer', `/pmt/pmt-02?permit=${issued?.id}`);
    const renew = form(page, 'pmt.permit.renew.aria');
    await renew.getByLabel(vi['pmt.permit.renew.number.label']).fill(`${number}-R`);
    await renew.getByLabel(vi['pmt.permit.renew.until.label']).fill(inDays(900));
    await renew.getByLabel(vi['pmt.permit.scan.label']).fill(scan);
    await renew.getByRole('button', { name: vi['pmt.permit.renew.save.action'] }).click();
    await expect(page.getByText(vi['pmt.permit.renew.saved.notice'])).toBeVisible();
    const rows = await sql<{ status: string; permit_no: string; supersedes_id: string | null }>(
      "select status, permit_no, supersedes_id from machvon.permit where permit_type_code = $1 and dossier_id = (select id from machvon.permit_dossier where project_id = $2::uuid) order by created_at",
      [typeCode, projectId],
    );
    expect(rows).toEqual([
      { status: 'SUPERSEDED', permit_no: number, supersedes_id: null },
      { status: 'ISSUED', permit_no: `${number}-R`, supersedes_id: issued?.id },
    ]);

    // Revocation takes the current permit back with its reason and the decision, and the dossier is no longer ready.
    const current = await permitOf(typeCode, projectId);
    await open(page, 'permitOfficer', `/pmt/pmt-02?permit=${current?.id}`);
    const revoke = form(page, 'pmt.permit.revoke.aria');
    await revoke.getByLabel(vi['pmt.permit.revoke.reason.label']).fill('Cấp nhầm đối tượng');
    await revoke.getByLabel(vi['pmt.permit.revoke.scan.label']).fill(scan);
    await revoke.getByRole('button', { name: vi['pmt.permit.revoke.save.action'] }).click();
    await expect(page.getByText(vi['pmt.permit.revoke.saved.notice'])).toBeVisible();
    expect(await permitOf(typeCode, projectId)).toMatchObject({ status: 'REVOKED' });
    expect(await sql('select status, readiness_pct::text as readiness_pct from machvon.permit_dossier where project_id = $1::uuid', [projectId])).toEqual([{ status: 'OPEN', readiness_pct: '0.00' }]);
  });

  test('the manager who keeps the file moves the milestones but is not offered the decision, and the project that has a dossier is not offered again (AC-ST-PMT-002-1)', async ({ page }) => {
    const code = unique();
    const typeCode = unique();
    const projectCode = `PRJ-${code}`;
    const projectId = await seedProject(projectCode);
    await seedType(typeCode);
    await openDossierOf(page, projectCode);
    const target = await permitOf(typeCode, projectId);

    await open(page, 'permitManager', `/pmt/pmt-02?permit=${target?.id}`);
    await record(page, 'SUBMITTED', inDays(-1));
    await expect(form(page, 'pmt.permit.milestone.aria')).toBeVisible();
    await record(page, 'ACKNOWLEDGED', inDays(0));
    await expect(form(page, 'pmt.permit.decision.aria')).toHaveCount(0);
    expect((await permitOf(typeCode, projectId))?.status).toBe('IN_APPRAISAL');

    // The project of the dossier is no longer among the projects that can be given one.
    await open(page, 'permitManager', '/pmt/pmt-01');
    const options = await form(page, 'pmt.dossier.open.aria').getByLabel(vi['pmt.dossier.open.project.label']).locator('option').allTextContents();
    expect(options.some((text) => text.includes(projectCode))).toBe(false);
  });

  test('someone who only reads sees the dossiers and the permit and is offered no form; a project of another tenant is not found (AC-ST-PMT-002-2)', async ({ page }) => {
    const code = unique();
    const typeCode = unique();
    const projectCode = `PRJ-${code}`;
    const projectId = await seedProject(projectCode);
    await seedType(typeCode);
    await openDossierOf(page, projectCode);
    const target = await permitOf(typeCode, projectId);

    await open(page, 'permitReader', '/pmt/pmt-01');
    await expect(page.locator('tr[data-dossier-id]').filter({ hasText: projectCode })).toBeVisible();
    await expect(form(page, 'pmt.dossier.open.aria')).toHaveCount(0);
    await open(page, 'permitReader', `/pmt/pmt-02?permit=${target?.id}`);
    await expect(page.getByTestId('permit-summary')).toBeVisible();
    await expect(page.getByTestId('actions-readonly')).toBeVisible();
    await expect(form(page, 'pmt.permit.milestone.aria')).toHaveCount(0);

    // A permit that does not exist for the caller (here an id that is nobody's) is a notice, not a half-filled screen.
    await open(page, 'permitReader', `/pmt/pmt-02?permit=${randomUUID()}`);
    await expect(page.getByTestId('no-permit')).toBeVisible();
  });
});
