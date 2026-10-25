import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * BID-20 (petitions of contractors and conflicts of interest) in a real browser against the real API and database (apps/api/test/e2e-stack): the planner logs a petition received ten days
 * ago, and the screen shows the last day to answer, counted by the rule data (seven days), and the petition overdue; a person who declared a conflict of interest against the contractor is
 * told that somebody else answers and is offered no answer; a different officer answers it with a document, and the petition is answered; a reader sees the petition and no button. What
 * the screen changed is looked up in the database.
 */

const OWNER_UNIT = 'CB-SKHDT-QLDA';
const DAY_MS = 86_400_000;
const dayFromToday = (offset: number): string => new Date(Date.now() + 7 * 3_600_000 + offset * DAY_MS).toISOString().slice(0, 10);

interface Seeded {
  packageId: string;
  code: string;
  contractor: string;
  contractorName: string;
  paper: string;
  reply: string;
}

async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const planner = membershipOf('petitionManager');
  const projectId = randomUUID();
  const packageId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${packageId.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, `E2E-PET-${suffix}`, `Dự án kiến nghị ${suffix}`, stackInfo().units.A[OWNER_UNIT], area?.id, planner],
  );
  const code = `GT-PET-${suffix}`;
  await sql(
    `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
     values ($1, $2, $3, $4, 18000000000, 'OPEN_BIDDING', 1, 'APPROVED', $5, $6, 1)`,
    [tenant, packageId, projectId, code, `Gói thầu kiến nghị ${suffix}`, planner],
  );
  const profile = randomUUID();
  await sql(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'ATTACHMENT', 'E2E-PROFILE', 'Hồ sơ năng lực', 'INTERNAL', $3, $3)`, [tenant, profile, planner]);
  const contractor = randomUUID();
  const contractorName = `Công ty kiến nghị ${suffix}`;
  await sql(`insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, $3, $4, 'VERIFIED', $5)`, [
    tenant,
    contractor,
    String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)),
    contractorName,
    profile,
  ]);
  const paper = randomUUID();
  const reply = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values
       ($1, $2, 'REFERENCE', 'CV', $4, 'INTERNAL', $6, $6), ($1, $3, 'REFERENCE', 'CV', $5, 'INTERNAL', $6, $6)`,
    [tenant, paper, reply, `Văn bản kiến nghị ${suffix}`, `Văn bản trả lời ${suffix}`, planner],
  );
  return { packageId, code, contractor, contractorName, paper, reply };
}

async function open(page: Page, user: string, seeded: Seeded): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/bid/bid-20?package=${seeded.packageId}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const petitionOf = async (packageId: string) => {
  const [row] = await sql<{ id: string; status: string; received_on: string; due_on: string; days_applied: number; handled_by: string | null; resolution_document_id: string | null; version: string; created_by: string }>(
    'select id, status, received_on::text, due_on::text, days_applied, handled_by, resolution_document_id, version::text, created_by from machvon.procurement_petition where package_id = $1 order by created_at desc limit 1',
    [packageId],
  );
  return row;
};

test.describe('the petitions of contractors', () => {
  test('the planner logs a petition, the screen shows it overdue, a person with a conflict is not offered the answer and a different officer answers it (UI-BID-20, AC-ST-BID-007-1, AC-ST-BID-007-2, UAT-AC456, UAT-AC450)', async ({ page }) => {
    const seeded = await seed();
    const received = dayFromToday(-10);

    await open(page, 'petitionManager', seeded);
    await expect(page.getByRole('heading', { level: 1, name: vi['bid.petitions.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-petitions')).toHaveText(vi['bid.petitions.none.notice']);

    // An empty form says what is missing, and a day that has not come is refused before anything is sent.
    await page.getByRole('button', { name: vi['bid.petitions.receive.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['bid.petitions.receive.submit'], exact: true }).click();
    await expect(page.getByText(vi['bid.petitions.problem.required']).first()).toBeVisible();
    await page.locator('#petition-kind').selectOption('PROCESS');
    await page.locator('#petition-contractor').selectOption({ label: seeded.contractorName });
    await page.locator('#petition-received').fill(dayFromToday(3));
    await page.locator('#petition-document').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['bid.petitions.receive.submit'], exact: true }).click();
    await expect(page.getByText(vi['bid.petitions.problem.future'])).toBeVisible();
    expect(await petitionOf(seeded.packageId)).toBeUndefined();

    await page.locator('#petition-received').fill(received);
    await page.getByRole('dialog').getByRole('button', { name: vi['bid.petitions.receive.submit'], exact: true }).click();
    await expect(page.getByTestId('petitions')).toBeVisible();
    const row = await petitionOf(seeded.packageId);
    expect(row).toMatchObject({ status: 'RECEIVED', received_on: received, due_on: dayFromToday(-3), days_applied: 7, handled_by: null, created_by: membershipOf('petitionManager') });
    const line = page.locator(`[data-petition="${row?.id}"]`);
    await expect(line).toHaveAttribute('data-overdue', 'true');
    await expect(line.getByTestId('overdue')).toHaveText(vi['bid.petitions.overdue.badge'].replace('{days}', '3'));
    await expect(line.getByTestId('status')).toHaveText(vi['bid.petitions.status.received']);
    await expect(line.getByTestId('contractor')).toHaveText(seeded.contractorName);

    // The same paper does not lodge a second petition.
    await page.getByRole('button', { name: vi['bid.petitions.receive.action'] }).click();
    await page.locator('#petition-kind').selectOption('RESULT');
    await page.locator('#petition-contractor').selectOption({ label: seeded.contractorName });
    await page.locator('#petition-document').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['bid.petitions.receive.submit'], exact: true }).click();
    // The package has no approved result, so a petition about the result is out of time.
    await expect(page.getByTestId('refusal')).toHaveText(vi['bid.petitions.error.outOfTimeNoResult']);
    await page.locator('#petition-kind').selectOption('PROCESS');
    await page.getByRole('dialog').getByRole('button', { name: vi['bid.petitions.receive.submit'], exact: true }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['bid.petitions.error.documentLodged']);
    await page.getByRole('dialog').getByRole('button', { name: vi['bid.petitions.dialog.cancel'] }).click();

    // A person who declared a conflict of interest against the contractor is told that somebody else answers.
    await sql(
      `insert into machvon.bid_conflict_declaration (tenant_id, id, package_id, user_id, has_conflict, relation_text, contractor_id, declared_at, created_by, updated_by, version)
       values ($1, $2, $3, $4, true, 'Quan hệ họ hàng', $5, now(), $4, $4, 1)`,
      [stackInfo().tenants.A, randomUUID(), seeded.packageId, membershipOf('petitionConflicted'), seeded.contractor],
    );
    await open(page, 'petitionConflicted', seeded);
    await expect(page.locator(`[data-petition="${row?.id}"]`).getByTestId('conflict-note')).toHaveText(vi['bid.petitions.conflict.notice']);
    await expect(page.locator(`[data-petition="${row?.id}"] [data-resolve]`)).toHaveCount(0);

    // A reader sees the petition and no button.
    await open(page, 'petitionReader', seeded);
    await expect(page.locator(`[data-petition="${row?.id}"]`)).toBeVisible();
    await expect(page.locator('button[data-resolve]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['bid.petitions.receive.action'] })).toHaveCount(0);

    // A different officer answers it with a document: without one nothing is sent.
    await open(page, 'petitionAuthority', seeded);
    await page.locator(`[data-petition="${row?.id}"] [data-resolve]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['bid.petitions.resolve.submit'], exact: true }).click();
    await expect(page.getByText(vi['bid.petitions.problem.required']).first()).toBeVisible();
    expect((await petitionOf(seeded.packageId))?.status).toBe('RECEIVED');
    await page.locator('input[data-outcome="RESOLVED"]').check();
    await page.locator('#petition-reply').fill(seeded.reply);
    await page.getByRole('dialog').getByRole('button', { name: vi['bid.petitions.resolve.submit'], exact: true }).click();
    await expect(page.locator(`[data-petition="${row?.id}"]`).getByTestId('status')).toHaveText(vi['bid.petitions.status.resolved']);
    await expect(page.locator(`[data-petition="${row?.id}"]`)).toHaveAttribute('data-overdue', 'false');
    expect(await petitionOf(seeded.packageId)).toMatchObject({ status: 'RESOLVED', handled_by: membershipOf('petitionAuthority'), resolution_document_id: seeded.reply, version: '2' });
    await expect(page.locator(`[data-petition="${row?.id}"] [data-resolve]`)).toHaveCount(0);
  });
});
