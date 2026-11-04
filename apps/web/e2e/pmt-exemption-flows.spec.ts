import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, retireTestPermitTypes, sql, stackInfo } from './support/stack.ts';

/**
 * The exemption of a permit on PMT-02 (ST-PMT-003) in a real browser against the real API and database (apps/api/test/e2e-stack): the officer plans the permit,
 * the leader declares the exemption with the legal basis and the decision document, the dossier counts the type as covered, and the server refuses a person who
 * both proposed the permit and holds the right to approve. A type that does not allow an exemption offers no form, and someone who only reads sees nothing to change.
 * What the screens changed is looked up in the database.
 */

const unique = (): string => `E2E_${Date.now().toString(36).toUpperCase()}_${Math.floor(Math.random() * 1000)}`;
const tenantA = (): string => stackInfo().tenants.A;
const BASIS = 'Được miễn giấy phép xây dựng theo Luật Xây dựng 135/2025, điều 89';

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

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

/** A permit type that applies to every project and, as asked, allows an exemption. */
async function seedType(code: string, exemptionAllowed: boolean): Promise<void> {
  await sql(
    `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, default_validity_months, exemption_allowed, status, created_by, updated_by)
     values ($1, $2, $3, $4, 'OTHER', 'Sở Xây dựng', 'Luật Xây dựng 135/2025, điều 43', date '2026-01-01', '{}'::jsonb, 12, $6, 'PUBLISHED', $5, $5)`,
    [tenantA(), randomUUID(), code, `Giấy phép ${code}`, membershipOf('owner'), exemptionAllowed],
  );
}

async function seedScan(): Promise<string> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'GP', 'Quyết định miễn giấy phép', 'INTERNAL', $3, $3)`,
    [tenantA(), documentId, membershipOf('owner')],
  );
  await sql(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
    [tenantA(), versionId, documentId, `tenants/e2e/${versionId}.pdf`],
  );
  return versionId;
}

interface PermitState {
  id: string;
  status: string;
  basis: string | null;
  decision: string | null;
  dossierId: string;
}

async function permitOf(typeCode: string, projectId: string): Promise<PermitState> {
  const [row] = await sql<{ id: string; status: string; exemption_basis: string | null; exemption_decision_document_version_id: string | null; dossier_id: string }>(
    `select x.id, x.status, x.exemption_basis, x.exemption_decision_document_version_id, x.dossier_id
       from machvon.permit x join machvon.permit_dossier d on d.id = x.dossier_id where x.permit_type_code = $1 and d.project_id = $2::uuid order by x.created_at desc limit 1`,
    [typeCode, projectId],
  );
  if (row === undefined) throw new Error('no permit');
  return { id: row.id, status: row.status, basis: row.exemption_basis, decision: row.exemption_decision_document_version_id, dossierId: row.dossier_id };
}

const form = (page: Page, key: keyof typeof vi) => page.getByRole('form', { name: vi[key] });

/** The officer (who holds permit.manage) opens the dossier of a project, which plans the permit; returns the permit. */
async function planPermit(page: Page, user: string, projectCode: string, typeCode: string, projectId: string): Promise<PermitState> {
  await open(page, user, '/pmt/pmt-01');
  await form(page, 'pmt.dossier.open.aria').getByLabel(vi['pmt.dossier.open.project.label']).selectOption({ label: `${projectCode} · Dự án ${projectCode}` });
  await form(page, 'pmt.dossier.open.aria').getByRole('button', { name: vi['pmt.dossier.open.action'] }).click();
  await expect(page.locator('tr[data-dossier-id]').filter({ hasText: projectCode })).toBeVisible();
  return permitOf(typeCode, projectId);
}

test.describe('PMT-02 exemption of a permit (ST-PMT-003)', () => {
  test.beforeEach(retireTestPermitTypes);

  test('the leader exempts a planned permit on its basis and decision document, and the dossier counts it as covered (AC-ST-PMT-003-1)', async ({ page }) => {
    const code = unique();
    const typeCode = unique();
    const projectCode = `PRJ-${code}`;
    const projectId = await seedProject(projectCode);
    await seedType(typeCode, true);
    const scan = await seedScan();
    const planned = await planPermit(page, 'permitOfficer', projectCode, typeCode, projectId);
    expect(planned.status).toBe('PLANNED');

    // The officer who proposed the permit holds no right to approve an exemption: the form is not offered.
    await open(page, 'permitOfficer', `/pmt/pmt-02?permit=${planned.id}`);
    await expect(form(page, 'pmt.permit.exempt.aria')).toHaveCount(0);

    await open(page, 'permitLeader', `/pmt/pmt-02?permit=${planned.id}`);
    const exemption = form(page, 'pmt.permit.exempt.aria');
    await expect(exemption).toBeVisible();
    await expect(page.getByText(vi['pmt.permit.exempt.hint.text'])).toBeVisible();
    // The form asks for both before it asks the server, and nothing changes.
    await exemption.getByRole('button', { name: vi['pmt.permit.exempt.save.action'] }).click();
    await expect(exemption.getByText(vi['pmt.permit.field.required.error'])).toHaveCount(2);
    expect((await permitOf(typeCode, projectId)).status).toBe('PLANNED');

    await exemption.getByLabel(vi['pmt.permit.exempt.basis.label']).fill(BASIS);
    await exemption.getByLabel(vi['pmt.permit.exempt.scan.label']).fill(scan);
    await exemption.getByRole('button', { name: vi['pmt.permit.exempt.save.action'] }).click();
    await expect(page.getByTestId('exempt-saved')).toHaveText(vi['pmt.permit.exempt.saved.notice']);
    expect(await permitOf(typeCode, projectId)).toMatchObject({ status: 'EXEMPTED', basis: BASIS, decision: scan });
    await expect(page.getByText(BASIS).first()).toBeVisible();

    // The type counts as covered: the only permit of the dossier is exempted, so the dossier is complete.
    expect(await sql('select status, readiness_pct::text as readiness_pct from machvon.permit_dossier where project_id = $1::uuid', [projectId])).toEqual([{ status: 'COMPLETE', readiness_pct: '100.00' }]);
    expect(await sql("select count(*)::int as n from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit.exempted.v1'", [planned.id])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_exempted'", [planned.id])).toEqual([{ n: 1 }]);
    // Nothing is offered on the exempted permit any more.
    await expect(form(page, 'pmt.permit.exempt.aria')).toHaveCount(0);
  });

  test('the person who proposed the permit cannot approve its exemption, even with the right to approve: the server refuses and the permit stays planned', async ({ page }) => {
    const code = unique();
    const typeCode = unique();
    const projectCode = `PRJ-${code}`;
    const projectId = await seedProject(projectCode);
    await seedType(typeCode, true);
    const scan = await seedScan();
    const planned = await planPermit(page, 'permitProposerLeader', projectCode, typeCode, projectId);

    await open(page, 'permitProposerLeader', `/pmt/pmt-02?permit=${planned.id}`);
    const exemption = form(page, 'pmt.permit.exempt.aria');
    await exemption.getByLabel(vi['pmt.permit.exempt.basis.label']).fill(BASIS);
    await exemption.getByLabel(vi['pmt.permit.exempt.scan.label']).fill(scan);
    await exemption.getByRole('button', { name: vi['pmt.permit.exempt.save.action'] }).click();
    await expect(exemption.getByRole('alert')).toHaveText(vi['pmt.permit.problem.selfApproval.error']);
    expect(await permitOf(typeCode, projectId)).toMatchObject({ status: 'PLANNED', basis: null });
    expect(await sql("select count(*)::int as n from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit.exempted.v1'", [planned.id])).toEqual([{ n: 0 }]);

    // A different leader approves it.
    await open(page, 'permitLeader', `/pmt/pmt-02?permit=${planned.id}`);
    const other = form(page, 'pmt.permit.exempt.aria');
    await other.getByLabel(vi['pmt.permit.exempt.basis.label']).fill(BASIS);
    await other.getByLabel(vi['pmt.permit.exempt.scan.label']).fill(scan);
    await other.getByRole('button', { name: vi['pmt.permit.exempt.save.action'] }).click();
    await expect(page.getByTestId('exempt-saved')).toBeVisible();
    expect((await permitOf(typeCode, projectId)).status).toBe('EXEMPTED');
  });

  test('a type that does not allow an exemption offers no form, and someone who only reads is offered nothing', async ({ page }) => {
    const code = unique();
    const typeCode = unique();
    const projectCode = `PRJ-${code}`;
    const projectId = await seedProject(projectCode);
    await seedType(typeCode, false);
    const planned = await planPermit(page, 'permitOfficer', projectCode, typeCode, projectId);

    await open(page, 'permitLeader', `/pmt/pmt-02?permit=${planned.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['pmt.permit.page.title'] })).toBeVisible();
    await expect(form(page, 'pmt.permit.exempt.aria')).toHaveCount(0);
    expect((await permitOf(typeCode, projectId)).status).toBe('PLANNED');

    await open(page, 'permitReader', `/pmt/pmt-02?permit=${planned.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['pmt.permit.page.title'] })).toBeVisible();
    await expect(page.getByRole('form')).toHaveCount(0);
  });
});
