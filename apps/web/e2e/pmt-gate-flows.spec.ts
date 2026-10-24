import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PMT-04 (gate rules and their evaluation) in a real browser against the real API and database (apps/api/test/e2e-stack): the business owner of the
 * tenant publishes the rule of a gate for a permit type with its legal basis, the evaluation of a project says BLOCKED until the permit is there and
 * PASSED once it is, the next revision takes over from its day and ends the one before it, a rule that overlaps is refused with its reason, and a rule
 * is ended. Someone who only reads sees the rules and the evaluation and has neither the form nor the way to end a rule.
 */

const DAY_MS = 86_400_000;
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);
const tenantA = (): string => stackInfo().tenants.A;
const BASIS = 'Luật Xây dựng 135/2025, điều 43';

async function open(page: Page, user: string, path = '/pmt/pmt-04'): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function seedType(code: string): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, default_validity_months, status, created_by, updated_by)
     values ($1, $2, $3, $4, 'OTHER', 'Sở Xây dựng', 'Luật Xây dựng 135/2025, điều 43', date '2025-01-01', '{}'::jsonb, 12, 'PUBLISHED', $5, $5)`,
    [tenantA(), id, code, `Giấy phép ${code}`, membershipOf('owner')],
  );
  return id;
}

async function seedScan(): Promise<string> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await sql(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'GP', 'Giấy phép', 'INTERNAL', $3, $3)`, [
    tenantA(),
    documentId,
    membershipOf('owner'),
  ]);
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
  const projectCode = `E2E-GT-${label}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenantA()]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 'B', $7, 1, $8, $8)`,
    [tenantA(), projectId, projectCode, `Dự án ${label}`, stackInfo().units.A['CB-SKHDT-QLDA'], area?.id, String(9900000 + (Number.parseInt(projectId.slice(0, 5), 16) % 90000)), membershipOf('owner')],
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

const rulesOf = (code: string) =>
  sql<{ id: string; revision: number; status: string; effective_from: string; effective_until: string | null; requirement: string; legal_basis: string }>(
    'select id, revision, status, effective_from::text, effective_until::text, requirement, legal_basis from machvon.permit_gate_rule where permit_type_code = $1 order by revision',
    [code],
  );
const form = (page: Page) => page.getByRole('form', { name: vi['pmt.gate.form.aria'] });
const field = (page: Page, label: string) => form(page).getByLabel(label, { exact: true });

async function publish(page: Page, code: string, options: { from: string; until?: string; basis?: string; requirement?: string }): Promise<void> {
  await field(page, vi['pmt.gate.form.gate.label']).selectOption('HANDOVER');
  await field(page, vi['pmt.gate.form.type.label']).selectOption({ label: `${code} · Giấy phép ${code}` });
  await field(page, vi['pmt.gate.form.requirement.label']).selectOption(options.requirement ?? 'VALID_PERMIT');
  await field(page, vi['pmt.gate.form.basis.label']).fill(options.basis ?? BASIS);
  await field(page, vi['pmt.gate.form.from.label']).fill(options.from);
  if (options.until !== undefined) await field(page, vi['pmt.gate.form.until.label']).fill(options.until);
  await form(page).getByRole('button', { name: vi['pmt.gate.form.save.action'] }).click();
}

test.describe('PMT-04 gate rules', () => {
  test('the business owner publishes a rule, the evaluation says BLOCKED then PASSED, the next revision takes over, an overlap is refused and a rule is ended (AC-ST-PMT-004-1)', async ({ page }) => {
    const label = Date.now().toString(36).toUpperCase();
    const code = `E2E_GT_${label}`;
    const { projectId, projectCode, dossierId } = await seedProjectWithDossier(label);
    await seedType(code);
    // The gate HANDOVER has no rule of this type; an earlier run may have left rules of other types, which the evaluation of this project also reads.
    await open(page, 'permitGateManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['pmt.gate.page.title'] })).toBeVisible();

    // Without a legal basis nothing is sent.
    await field(page, vi['pmt.gate.form.type.label']).selectOption({ label: `${code} · Giấy phép ${code}` });
    await field(page, vi['pmt.gate.form.from.label']).fill('2026-01-01');
    await form(page).getByRole('button', { name: vi['pmt.gate.form.save.action'] }).click();
    await expect(form(page).getByText(vi['pmt.field.required.error'])).toBeVisible();
    expect(await rulesOf(code)).toEqual([]);

    await publish(page, code, { from: '2026-01-01' });
    await expect(page.getByTestId('saved')).toBeVisible();
    const [first] = await rulesOf(code);
    expect(first).toMatchObject({ revision: 1, status: 'PUBLISHED', effective_from: '2026-01-01', effective_until: null, requirement: 'VALID_PERMIT', legal_basis: BASIS });
    const row = page.locator(`tr[data-rule-id="${first?.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(code);
    await expect(row).toContainText(BASIS);

    // The project has no permit of this type: the gate is blocked, and the rule and its legal basis are named.
    await page.getByLabel(vi['pmt.gate.eval.project.label'], { exact: true }).selectOption(projectId);
    await page.getByLabel(vi['pmt.gate.eval.gate.label'], { exact: true }).selectOption('HANDOVER');
    const result = page.locator('[data-gate-result="HANDOVER"]');
    await expect(result).toHaveAttribute('data-status', 'BLOCKED');
    await expect(result.locator(`[data-rule-id="${first?.id}"]`)).toHaveAttribute('data-outcome', 'BLOCKING');
    await expect(result).toContainText(BASIS);

    // The permit is issued: after a reload the same gate passes, with the permit named.
    const scan = await seedScan();
    const typeId = (await sql<{ id: string }>('select id from machvon.permit_type where code = $1', [code]))[0]?.id;
    await sql(
      `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, permit_no, status, authority_name, issued_on, valid_from, valid_until, document_version_id, responsible_membership_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'ISSUED', 'Sở Xây dựng', date '2026-01-02', date '2026-01-02', $6::date, $7, $8, $8, $8)`,
      [tenantA(), randomUUID(), dossierId, typeId, `GP-${label}`, inDays(200), scan, membershipOf('owner')],
    );
    await open(page, 'permitGateManager');
    await page.getByLabel(vi['pmt.gate.eval.project.label'], { exact: true }).selectOption(projectId);
    await page.getByLabel(vi['pmt.gate.eval.gate.label'], { exact: true }).selectOption('HANDOVER');
    await expect(page.locator('[data-gate-result="HANDOVER"]')).toHaveAttribute('data-status', 'PASSED');
    await expect(page.locator(`[data-gate-result="HANDOVER"] [data-rule-id="${first?.id}"]`)).toHaveAttribute('data-outcome', 'SATISFIED');
    await expect(page.locator('[data-gate-result="HANDOVER"]')).toContainText(`GP-${label}`);
    // Before the permit began the same rule blocks.
    await page.getByLabel(vi['pmt.gate.eval.day.label'], { exact: true }).fill('2026-01-01');
    await expect(page.locator('[data-gate-result="HANDOVER"]')).toHaveAttribute('data-status', 'BLOCKED');

    // The next revision takes over from its day and ends the first one the day before.
    await publish(page, code, { from: inDays(30), requirement: 'VALID_OR_EXEMPT', basis: 'Nghị định 217/2026, điều 12' });
    await expect(page.getByTestId('saved')).toBeVisible();
    expect((await rulesOf(code)).map((rule) => [rule.revision, rule.status, rule.effective_from, rule.effective_until, rule.requirement])).toEqual([
      [1, 'RETIRED', '2026-01-01', inDays(29), 'VALID_PERMIT'],
      [2, 'PUBLISHED', inDays(30), null, 'VALID_OR_EXEMPT'],
    ]);
    // A rule that would apply on the days of the one in force is refused with its reason, and nothing is written.
    await publish(page, code, { from: inDays(10) });
    await expect(page.getByTestId('problem')).toHaveText(vi['pmt.gate.problem.overlap.error']);
    expect(await rulesOf(code)).toHaveLength(2);

    // The second revision is ended on a day of its own.
    const second = (await rulesOf(code))[1];
    await page.locator(`tr[data-rule-id="${second?.id}"]`).getByRole('button', { name: vi['pmt.gate.retire.action'] }).click();
    const retire = page.getByRole('form', { name: `Kết thúc quy tắc ${code}` });
    await retire.getByLabel(vi['pmt.gate.retire.until.label']).fill(inDays(120));
    await retire.getByRole('button', { name: vi['pmt.gate.retire.confirm'] }).click();
    await expect(retire).toHaveCount(0);
    expect((await rulesOf(code))[1]).toMatchObject({ status: 'RETIRED', effective_until: inDays(120) });
    await expect(sql("select 1 from machvon.audit_event where action = 'pmt.gate_rule_retired' and resource_id = $1", [second?.id])).resolves.toHaveLength(1);
    expect(projectCode).toContain(label);
  });

  test('someone who only reads sees the rules and the evaluation, and has neither the form nor the way to end a rule; someone who may not read permits is denied', async ({ page }) => {
    await open(page, 'permitReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['pmt.gate.page.title'] })).toBeVisible();
    await expect(page.getByTestId('evaluation')).toBeVisible();
    await expect(page.getByText(vi['pmt.gate.readonly.text'])).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['pmt.gate.retire.action'] })).toHaveCount(0);

    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(form(page)).toHaveCount(0);
  });
});
