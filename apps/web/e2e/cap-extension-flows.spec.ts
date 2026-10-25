import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CAP-20 (the extension of the disbursement of capital to the next year) in a real browser against the real API and database (apps/api/test/e2e-stack): the planner picks a line of
 * a published plan, sees what is left to carry over and asks for 600 million until the end of January; more than is left is refused before it is sent; the approver, who is not the
 * planner, approves it with the document that allows it and the capital moves: a line of bucket CARRYOVER in the next year with its source year and last day, the line of the plan year
 * gave up the 600 million, two ledger entries of one extension; a rejection moves nothing; a reader sees the requests and nothing to do. What the screen changed is looked up in the database.
 */

const TENANT = stackInfo().tenants.A;
const MILLION = 1_000_000;
const millions = (n: number): string => String(n * MILLION);
const unitOf = (code: string): string => stackInfo().units.A[code] as string;
/** The decision document the stack seeds in tenant A (apps/api/test/e2e-stack): 1. It allows the extensions of the cases. */
const DOCUMENT = '00000000-0000-4000-005d-000000000001';

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.goto(`/cap/cap-20?devUser=${user}`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForSelector('.cap-extension');
}

interface Funded {
  projectId: string;
  projectCode: string;
  planCode: string;
  appropriationId: string;
  lineId: string;
  balanceId: string;
  year: number;
}

/** A project with a line of 1,000 million in a published plan of the year, its balance and the ALLOCATE entry that explains it. */
async function seedFunded(label: string, year: number): Promise<Funded> {
  const projectId = randomUUID();
  const projectCode = `E2E-EX-${label}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [TENANT]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
    [TENANT, projectId, projectCode, `Dự án kéo dài ${label}`, unitOf('CB-SKHDT-QLDA'), area?.id, String(9300000 + (Number.parseInt(projectId.slice(0, 6), 16) % 600000)), membershipOf('owner')],
  );
  const [fund] = await sql<{ id: string }>(
    "select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where v.tenant_id = $1 and v.master_type = 'FUND_SOURCE' and r.business_key = 'NSTW' and v.status = 'EFFECTIVE' limit 1",
    [TENANT],
  );
  const appropriationId = randomUUID();
  await sql(
    `insert into machvon.appropriation
       (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
     values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, $5::numeric, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
    [TENANT, appropriationId, fund?.id, year, millions(10_000), DOCUMENT, membershipOf('planApprover'), membershipOf('owner')],
  );
  const planId = randomUUID();
  const planCode = `E2E-EX-${label}`;
  await sql(
    `insert into machvon.capital_plan
       (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, submitted_by, approved_by, decision_document_id, effective_at, published_at, published_by, created_by, updated_by)
     values ($1, $2, $3, 'ANNUAL', $4, $4, $4, $5, 1, 'PUBLISHED', $6, $7, $8, '2026-01-15T00:00:00Z', '2026-01-15T00:00:00Z', $9, $6, $6)`,
    [TENANT, planId, planCode, year, unitOf('CB-STC'), membershipOf('planSubmitter'), membershipOf('planApprover'), DOCUMENT, membershipOf('planPublisher')],
  );
  const versionId = randomUUID();
  const lineId = randomUUID();
  await sql(
    `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, decision_id, effective_at, created_by, updated_by)
     values ($1, $2, $3, $4, 1, 'PUBLISHED', $5, $6, '2026-01-15T00:00:00Z', $7, $7)`,
    [TENANT, versionId, projectId, year, planId, DOCUMENT, membershipOf('planSubmitter')],
  );
  await sql(
    `insert into machvon.allocation_line
       (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, created_by, updated_by)
     values ($1, $2, $3, $4, 'CURRENT_YEAR', $5, $6::numeric, 0, $7, $8, 'CENTRAL', 'PM_ASSIGNED', $9, $9)`,
    [TENANT, lineId, versionId, fund?.id, year, millions(1_000), appropriationId, projectId, membershipOf('planSubmitter')],
  );
  const balanceId = randomUUID();
  await sql('insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, reserved_vnd, committed_vnd, disbursed_vnd) values ($1, $2, $3, $4::numeric, 0, $5::numeric, $6::numeric)', [
    TENANT,
    balanceId,
    lineId,
    millions(1_000),
    millions(100),
    millions(100),
  ]);
  await sql(
    `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
     values ($1, $2, $3, $4, $5, 'ALLOCATE', $6::numeric, $7, 'CAPITAL_PLAN', $8, $9)`,
    [TENANT, randomUUID(), appropriationId, lineId, projectId, millions(1_000), year, planId, membershipOf('planPublisher')],
  );
  return { projectId, projectCode, planCode, appropriationId, lineId, balanceId, year };
}

const form = (page: Page) => page.getByRole('form', { name: vi['cap.extension.form.aria'] });
const fieldOf = (page: Page, label: string) => form(page).getByLabel(label, { exact: true });
const rowOf = (page: Page, extensionId: string) => page.locator(`tr[data-extension-id="${extensionId}"]`);
const extensionOf = async (lineId: string) =>
  (
    await sql<{ id: string; status: string; version: string; amount_vnd: string; created_by: string; decided_by: string | null; new_allocation_line_id: string | null; new_appropriation_id: string | null; extended_to: string }>(
      'select id, status, version::text as version, amount_vnd::text as amount_vnd, created_by, decided_by, new_allocation_line_id, new_appropriation_id, extended_to::text as extended_to from machvon.allocation_extension where allocation_line_id = $1::uuid order by created_at desc limit 1',
      [lineId],
    )
  )[0];

/** Picks the plan and the line of the form; the figures of the line are read once it is chosen. */
async function pickLine(page: Page, target: Funded): Promise<void> {
  await fieldOf(page, vi['cap.extension.field.plan']).selectOption({ label: vi['cap.extension.plan.option'].replace('{code}', target.planCode).replace('{year}', String(target.year)).replace('{revision}', '1') });
  const line = fieldOf(page, vi['cap.extension.field.line']);
  await expect(line.locator('option')).not.toHaveCount(1);
  await line.selectOption(target.lineId);
  await expect(page.getByTestId('figures')).toBeVisible();
  await expect(page.getByTestId('figures')).not.toHaveAttribute('data-undisbursed', '');
}

async function ask(page: Page, target: Funded, amount: string, until: string): Promise<void> {
  await pickLine(page, target);
  await fieldOf(page, vi['cap.extension.field.amount']).fill(amount);
  await fieldOf(page, vi['cap.extension.field.until']).fill(until);
  await fieldOf(page, vi['cap.extension.field.reason']).selectOption('GPMB_CHAM');
  await form(page).getByRole('button', { name: vi['cap.extension.request.action'] }).click();
}

test.describe('CAP-20: the extension of the disbursement of capital', () => {
  test('the planner asks, the approver approves with the document and the capital moves to a line of the next year (AC-ST-CAP-007-1, UAT-AC229)', async ({ page }) => {
    const target = await seedFunded('A', 2051);
    await open(page, 'extPlanner');
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.extension.page.title'] })).toBeVisible();

    // More than is left (1,000 less 100 committed and 100 disbursed: 800 million) is refused in the form, with the figure, and nothing is sent.
    await pickLine(page, target);
    await expect(page.getByTestId('figures')).toHaveAttribute('data-undisbursed', millions(800));
    await fieldOf(page, vi['cap.extension.field.amount']).fill(millions(900));
    await fieldOf(page, vi['cap.extension.field.until']).fill('2052-01-31');
    await fieldOf(page, vi['cap.extension.field.reason']).selectOption('GPMB_CHAM');
    await form(page).getByRole('button', { name: vi['cap.extension.request.action'] }).click();
    await expect(form(page).getByText(vi['cap.extension.fieldError.exceeds'].replace('{undisbursed}', BigInt(millions(800)).toLocaleString('vi')))).toBeVisible();
    expect(await extensionOf(target.lineId)).toBeUndefined();

    // A last day outside the year after the plan year is refused in the form too.
    await fieldOf(page, vi['cap.extension.field.amount']).fill(millions(600));
    await fieldOf(page, vi['cap.extension.field.until']).fill('2051-12-31');
    await form(page).getByRole('button', { name: vi['cap.extension.request.action'] }).click();
    await expect(form(page).getByText(/^Ngày giải ngân cuối phải từ/)).toBeVisible();

    await fieldOf(page, vi['cap.extension.field.until']).fill('2052-01-31');
    await expect(page.getByTestId('preview')).toBeVisible();
    await form(page).getByRole('button', { name: vi['cap.extension.request.action'] }).click();
    await expect(page.getByText(vi['cap.extension.done.requested'])).toBeVisible();
    const asked = await extensionOf(target.lineId);
    expect(asked).toMatchObject({ status: 'REQUESTED', version: '1', amount_vnd: millions(600), created_by: membershipOf('extPlanner'), extended_to: '2052-01-31', new_allocation_line_id: null });
    const row = rowOf(page, asked?.id ?? '');
    await expect(row).toHaveAttribute('data-status', 'REQUESTED');
    // The planner holds no right to decide.
    await expect(row.getByRole('button')).toHaveCount(0);

    // The approver decides it with the document.
    await open(page, 'extApprover');
    await expect(form(page)).toHaveCount(0);
    const waiting = rowOf(page, asked?.id ?? '');
    await waiting.getByRole('button', { name: vi['cap.extension.approve.action'] }).click();
    const decision = page.getByRole('form', { name: vi['cap.extension.decision.aria'] });
    await decision.getByLabel(vi['cap.extension.field.document'], { exact: true }).fill(DOCUMENT);
    await decision.getByLabel(vi['cap.extension.field.decisionReason'], { exact: true }).fill('Đúng với quyết định kéo dài vốn');
    await decision.getByRole('button', { name: vi['cap.extension.decision.confirm.approve'] }).click();
    await expect(page.getByText(vi['cap.extension.done.applied'])).toBeVisible();
    await expect(rowOf(page, asked?.id ?? '')).toHaveAttribute('data-status', 'APPLIED');

    const applied = await extensionOf(target.lineId);
    expect(applied).toMatchObject({ status: 'APPLIED', version: '2', decided_by: membershipOf('extApprover') });
    const [carried] = await sql<{ bucket: string; source_year: number; is_extended: boolean; extended_to: string; amount_vnd: string; appropriation_id: string; extension_document_id: string }>(
      'select bucket, source_year, is_extended, extended_to::text as extended_to, amount_vnd::text as amount_vnd, appropriation_id, extension_document_id from machvon.allocation_line where id = $1::uuid',
      [applied?.new_allocation_line_id],
    );
    expect(carried).toMatchObject({ bucket: 'CARRYOVER', source_year: 2051, is_extended: true, extended_to: '2052-01-31', amount_vnd: millions(600), appropriation_id: applied?.new_appropriation_id, extension_document_id: DOCUMENT });
    const [source] = await sql<{ allocated: string; amount: string; total: string }>(
      'select b.allocated_vnd::text as allocated, a.amount_vnd::text as amount, a.allocated_total_vnd::text as total from machvon.allocation_balance b, machvon.appropriation a where b.id = $1::uuid and a.id = $2::uuid',
      [target.balanceId, target.appropriationId],
    );
    // The capital of the plan year was not increased: the line gave up 600 million and its appropriation holds what it held.
    expect(source).toEqual({ allocated: millions(400), amount: millions(10_000), total: millions(10_000) });
    const entries = await sql<{ entry_type: string }>('select entry_type from machvon.capital_ledger_entry where source_ref_id = $1::uuid order by entry_type', [applied?.id]);
    expect(entries.map((entry) => entry.entry_type)).toEqual(['EXTEND_IN', 'EXTEND_OUT']);
    const events = await sql<{ n: string }>("select count(*)::text as n from machvon.outbox_event where aggregate_id = $1::uuid and type = 'capital.allocation_extended.v1'", [applied?.id]);
    expect(events[0]?.n).toBe('1');
  });

  test('the approver rejects a request with a reason and nothing moves; the person who asked is offered no decision on their own request', async ({ page }) => {
    const target = await seedFunded('B', 2053);
    await open(page, 'extPlanner');
    await ask(page, target, millions(300), '2054-03-31');
    await expect(page.getByText(vi['cap.extension.done.requested'])).toBeVisible();
    const asked = await extensionOf(target.lineId);
    await open(page, 'extApprover');
    await rowOf(page, asked?.id ?? '').getByRole('button', { name: vi['cap.extension.reject.action'] }).click();
    const decision = page.getByRole('form', { name: vi['cap.extension.decision.aria'] });
    await expect(decision.getByLabel(vi['cap.extension.field.document'], { exact: true })).toHaveCount(0);
    await decision.getByLabel(vi['cap.extension.field.decisionReason'], { exact: true }).fill('Chưa đủ căn cứ để kéo dài');
    await decision.getByRole('button', { name: vi['cap.extension.decision.confirm.reject'] }).click();
    await expect(page.getByText(vi['cap.extension.done.rejected'])).toBeVisible();
    await expect(rowOf(page, asked?.id ?? '')).toHaveAttribute('data-status', 'REJECTED');
    expect(await extensionOf(target.lineId)).toMatchObject({ status: 'REJECTED', version: '2', new_allocation_line_id: null });
    const [balance] = await sql<{ allocated: string }>('select allocated_vnd::text as allocated from machvon.allocation_balance where id = $1::uuid', [target.balanceId]);
    expect(balance?.allocated).toBe(millions(1_000));
    expect(await sql('select 1 from machvon.capital_ledger_entry where entry_type in (\'EXTEND_OUT\', \'EXTEND_IN\') and allocation_line_id = $1::uuid', [target.lineId])).toEqual([]);
  });

  test('a reader sees the requests and has nothing to ask for or decide', async ({ page }) => {
    const target = await seedFunded('C', 2055);
    await open(page, 'extPlanner');
    await ask(page, target, millions(100), '2056-06-30');
    await expect(page.getByText(vi['cap.extension.done.requested'])).toBeVisible();
    const asked = await extensionOf(target.lineId);
    await open(page, 'extReader');
    await expect(rowOf(page, asked?.id ?? '')).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    await expect(page.getByText(vi['cap.extension.form.denied'])).toBeVisible();
    await expect(page.locator('tr[data-extension-id]').getByRole('button')).toHaveCount(0);
  });
});
