import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, retireTestPermitTypes, sql, stackInfo } from './support/stack.ts';

/**
 * PMT-06 (waivers of the permit gates) in a real browser against the real API and database (apps/api/test/e2e-stack): the leader in charge lets a blocked
 * gate pass for a while on a decision document and for a reason, the gate then says it passes with a waiver (PMT-04) until the waiver is revoked, a waiver
 * longer than the longest is refused before it is sent, a second waiver for the same gate and permit type is refused, and a leader who is one of the
 * people who asked for it is refused by the server. Someone who only reads sees the waivers and has neither the form nor the way to revoke.
 */

const DAY_MS = 86_400_000;
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);
const tenantA = (): string => stackInfo().tenants.A;
const BASIS = 'Luật Xây dựng 135/2025, điều 43';

async function open(page: Page, user: string, path = '/pmt/pmt-06'): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function seedProject(label: string): Promise<{ projectId: string }> {
  const projectId = randomUUID();
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenantA()]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 'B', $7, 1, $8, $8)`,
    [tenantA(), projectId, `E2E-WV-${label}`, `Dự án ${label}`, stackInfo().units.A['CB-SKHDT-QLDA'], area?.id, String(9800000 + (Number.parseInt(projectId.slice(0, 5), 16) % 90000)), membershipOf('owner')],
  );
  return { projectId };
}

/** A permit type and the rule that makes the HANDOVER gate ask for it. */
async function seedRule(code: string): Promise<string> {
  const typeId = randomUUID();
  await sql(
    `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, default_validity_months, status, created_by, updated_by)
     values ($1, $2, $3, $4, 'OTHER', 'Sở Xây dựng', $5, date '2025-01-01', '{}'::jsonb, 12, 'PUBLISHED', $6, $6)`,
    [tenantA(), typeId, code, `Giấy phép ${code}`, BASIS, membershipOf('owner')],
  );
  await sql(
    `insert into machvon.permit_gate_rule (tenant_id, id, gate_code, permit_type_id, requirement, applies_to_rule, legal_basis, effective_from, revision, status, created_by, updated_by)
     values ($1, $2, 'HANDOVER', $3, 'VALID_PERMIT', '{}'::jsonb, $4, date '2026-01-01', 1, 'PUBLISHED', $5, $5)`,
    [tenantA(), randomUUID(), typeId, BASIS, membershipOf('owner')],
  );
  return typeId;
}

/** A document version made by `creator`: the decision a waiver rests on. */
async function seedDecision(creator: string): Promise<string> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await sql(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Quyết định', 'INTERNAL', $3, $3)`, [tenantA(), documentId, membershipOf(creator)]);
  await sql(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
    [tenantA(), versionId, documentId, `tenants/e2e/${versionId}.pdf`],
  );
  return versionId;
}

const waiversOf = (projectId: string) =>
  sql<{ id: string; status: string; gate_code: string; permit_type_code: string; valid_until: string; created_by: string; approved_by: string; revoked_reason: string | null }>(
    'select id, status, gate_code, permit_type_code, valid_until::text as valid_until, created_by, approved_by, revoked_reason from machvon.permit_gate_waiver where project_id = $1 order by created_at',
    [projectId],
  );
const form = (page: Page): Locator => page.getByRole('form', { name: vi['pmt.waiver.form.aria'] });
const field = (page: Page, label: string): Locator => form(page).getByLabel(label, { exact: true });

async function fill(page: Page, values: { projectId: string; typeId: string; reason: string; document: string; until: string }): Promise<void> {
  await field(page, vi['pmt.waiver.form.project.label']).selectOption(values.projectId);
  await field(page, vi['pmt.waiver.form.gate.label']).selectOption('HANDOVER');
  await field(page, vi['pmt.waiver.form.type.label']).selectOption(values.typeId);
  await field(page, vi['pmt.waiver.form.reason.label']).fill(values.reason);
  await field(page, vi['pmt.waiver.form.document.label']).fill(values.document);
  await field(page, vi['pmt.waiver.form.until.label']).fill(values.until);
}

const grant = (page: Page) => form(page).getByRole('button', { name: vi['pmt.waiver.form.save.action'] }).click();

test.describe('PMT-06 gate waivers', () => {
  test.beforeEach(retireTestPermitTypes);

  test('the leader lets a blocked gate pass for a while, the gate says so, a second waiver is refused, and the waiver is revoked (AC-ST-PMT-005-1)', async ({ page }) => {
    const label = Date.now().toString(36).toUpperCase();
    const code = `E2E_WV_${label}`;
    const { projectId } = await seedProject(label);
    const typeId = await seedRule(code);
    const document = await seedDecision('owner');
    const reason = 'Cơ quan có thẩm quyền cho phép bàn giao trước khi hoàn tất giấy phép';

    // Without a waiver the gate is blocked.
    await open(page, 'permitWaiveLeader', '/pmt/pmt-04');
    await page.getByLabel(vi['pmt.gate.eval.project.label'], { exact: true }).selectOption(projectId);
    await page.getByLabel(vi['pmt.gate.eval.gate.label'], { exact: true }).selectOption('HANDOVER');
    await expect(page.locator('[data-gate-result="HANDOVER"]')).toHaveAttribute('data-status', 'BLOCKED');

    await open(page, 'permitWaiveLeader');
    await expect(page.getByRole('heading', { level: 1, name: vi['pmt.waiver.page.title'] })).toBeVisible();
    // A last day beyond the longest is told before anything is sent.
    await fill(page, { projectId, typeId, reason, document, until: inDays(120) });
    await grant(page);
    await expect(form(page).locator('.field-error')).toContainText('tối đa 90 ngày');
    expect(await waiversOf(projectId)).toEqual([]);

    // A valid one is granted: the officer who made the decision asked for it, the leader approves.
    await field(page, vi['pmt.waiver.form.until.label']).fill(inDays(30));
    await grant(page);
    await expect(page.getByTestId('granted')).toBeVisible();
    const [granted] = await waiversOf(projectId);
    expect(granted).toMatchObject({ status: 'ACTIVE', gate_code: 'HANDOVER', permit_type_code: code, valid_until: inDays(30), created_by: membershipOf('owner'), approved_by: membershipOf('permitWaiveLeader') });
    const row = page.locator(`tr[data-waiver-id="${granted?.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-phase', 'inForce');
    await expect(row).toContainText(reason);
    await expect(row.getByTestId('days-left')).toHaveText('còn 30 ngày');

    // The gate now passes with a waiver, until it is revoked.
    await open(page, 'permitWaiveLeader', '/pmt/pmt-04');
    await page.getByLabel(vi['pmt.gate.eval.project.label'], { exact: true }).selectOption(projectId);
    await page.getByLabel(vi['pmt.gate.eval.gate.label'], { exact: true }).selectOption('HANDOVER');
    await expect(page.locator('[data-gate-result="HANDOVER"]')).toHaveAttribute('data-status', 'PASSED_WITH_WAIVER');

    // A second waiver for the same project, gate and permit type is refused with its reason.
    await open(page, 'permitWaiveLeader');
    await fill(page, { projectId, typeId, reason, document, until: inDays(10) });
    await grant(page);
    await expect(page.getByTestId('problem')).toHaveText(vi['pmt.waiver.problem.stateInvalid.error']);
    expect(await waiversOf(projectId)).toHaveLength(1);

    // The leader revokes it with the words that explain it.
    await page.locator(`tr[data-waiver-id="${granted?.id}"]`).getByRole('button', { name: vi['pmt.waiver.revoke.action'] }).click();
    const revoke = page.getByRole('form', { name: `Thu hồi miễn trừ ${code}` });
    await revoke.getByRole('button', { name: vi['pmt.waiver.revoke.confirm'] }).click();
    await expect(revoke.locator('.field-error')).toHaveText(vi['pmt.waiver.field.required.error']);
    await revoke.getByLabel(vi['pmt.waiver.revoke.reason.label']).fill('Giấy phép đã được cấp');
    await revoke.getByRole('button', { name: vi['pmt.waiver.revoke.confirm'] }).click();
    await expect(revoke).toHaveCount(0);
    expect((await waiversOf(projectId))[0]).toMatchObject({ status: 'REVOKED', revoked_reason: 'Giấy phép đã được cấp' });
    await expect(page.locator(`tr[data-waiver-id="${granted?.id}"]`)).toHaveAttribute('data-phase', 'revoked');
    await expect(page.locator(`tr[data-waiver-id="${granted?.id}"] [data-testid="days-left"]`)).toHaveCount(0);
    expect(await sql("select 1 from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.gate_waiver_revoked'", [granted?.id])).toHaveLength(1);

    await open(page, 'permitWaiveLeader', '/pmt/pmt-04');
    await page.getByLabel(vi['pmt.gate.eval.project.label'], { exact: true }).selectOption(projectId);
    await page.getByLabel(vi['pmt.gate.eval.gate.label'], { exact: true }).selectOption('HANDOVER');
    await expect(page.locator('[data-gate-result="HANDOVER"]')).toHaveAttribute('data-status', 'BLOCKED');
  });

  test('a leader who made the decision is one of the people who asked for the waiver, and the server refuses them (AC-ST-PMT-005-1)', async ({ page }) => {
    const label = `S${Date.now().toString(36).toUpperCase()}`;
    const code = `E2E_WV_${label}`;
    const { projectId } = await seedProject(label);
    const typeId = await seedRule(code);
    const own = await seedDecision('permitWaiveLeader');
    await open(page, 'permitWaiveLeader');
    await fill(page, { projectId, typeId, reason: 'Tôi tự lập văn bản và tự cấp', document: own, until: inDays(10) });
    await grant(page);
    await expect(page.getByTestId('problem')).toHaveText(vi['pmt.waiver.problem.selfApproval.error']);
    expect(await waiversOf(projectId)).toEqual([]);
  });

  test('someone who only reads sees the waivers and has neither the form nor the way to revoke', async ({ page }) => {
    const label = `R${Date.now().toString(36).toUpperCase()}`;
    const code = `E2E_WV_${label}`;
    const { projectId } = await seedProject(label);
    const typeId = await seedRule(code);
    const document = await seedDecision('owner');
    const waiverId = randomUUID();
    await sql(
      `insert into machvon.permit_gate_waiver (tenant_id, id, project_id, gate_code, permit_type_id, reason, decision_document_version_id, valid_until, approved_by, status, created_by, updated_by)
       values ($1, $2, $3, 'HANDOVER', $4, 'Lý do để người xem đọc', $5, $6::date, $7, 'ACTIVE', $8, $7)`,
      [tenantA(), waiverId, projectId, typeId, document, inDays(15), membershipOf('permitWaiveLeader'), membershipOf('owner')],
    );
    await open(page, 'permitReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['pmt.waiver.page.title'] })).toBeVisible();
    const row = page.locator(`tr[data-waiver-id="${waiverId}"]`);
    await expect(row).toContainText('Lý do để người xem đọc');
    await expect(row.getByTestId('days-left')).toHaveText('còn 15 ngày');
    await expect(form(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['pmt.waiver.revoke.action'] })).toHaveCount(0);
    await expect(page.getByText(vi['pmt.waiver.readonly.text'])).toBeVisible();

    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
  });
});
