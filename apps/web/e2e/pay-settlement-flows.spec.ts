import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PAY-15 (the settlement of a project) in a real browser against the real API and database (apps/api/test/e2e-stack): the settlement officer opens the settlement of a complete project and sends it, the
 * deadline following the group of the project (UAT-AC339); another person takes the file up and verifies it; with something still owed the leader cannot close it, the chief accountant approves the
 * exception, and the leader closes it with the figures as they were (UAT-AC66). A reader sees the settlement and no command. What the screens changed is looked up in the database.
 */

const OWNER = membershipOf('owner');
let counter = 0;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** The Vietnam calendar day `shift` days from now, as the screens count it. */
const day = (shift = 0): string => new Date(Date.now() + 7 * 3_600_000 + shift * 86_400_000).toISOString().slice(0, 10);
const plus = (from: string, days: number): string => new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** A complete project of group B in the Project Management Board, and a clean paper to stand for the decision and the approval of the exception. Written straight to the database (the guards are switched off). */
async function seed(): Promise<{ projectId: string; code: string; paper: string; decision: string }> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const projectId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenant]);
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  const unit = stackInfo().units.A['CB-SKHDT-QLDA'] as string;
  if (area === undefined || papers.length < 2) throw new Error('the fixtures of the stack are missing');
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'COMPLETED', 'B', $7, 1, $8, $8)`,
      [tenant, projectId, `E2E-QT-${suffix}`, `Cầu quyết toán ${counter}`, unit, area.id, String(2000000 + Math.floor(Math.random() * 7999999)), OWNER],
    );
  } finally {
    await client.end();
  }
  return { projectId, code: `E2E-QT-${suffix}`, paper: papers[0]!.id, decision: papers[1]!.id };
}

const eventsOf = (id: string, type: string) => sql<{ id: string }>('select id from machvon.outbox_event where aggregate_id = $1 and type = $2', [id, type]);
const auditsOf = (id: string, action: string) => sql<{ actor_id: string }>('select actor_id from machvon.audit_event where resource_id = $1 and action = $2', [id, action]);
const rowOf = async (id: string) =>
  (
    await sql<{ status: string; outstanding: string; group: string | null; due: string | null; days: number | null; exception_by: string | null; closed_by: string | null; version: string }>(
      'select status, outstanding_vnd::text as outstanding, project_group as group, verification_due_on::text as due, deadline_days as days, exception_approved_by as exception_by, closed_by, version::text as version from machvon.settlement_revision where id = $1',
      [id],
    )
  )[0];

test.describe('PAY-15 the settlement of a project (ST-PAY-009, UI-PAY-15, UAT-AC339, UAT-AC66)', () => {
  test('opens, sends with the deadline of the group, verifies, approves the exception and closes with the figures as they were', async ({ page }) => {
    const seeded = await seed();

    // The officer opens the settlement of the complete project.
    await open(page, '/pay/pay-15', 'settleOfficer');
    await expect(page.getByRole('heading', { level: 1, name: vi['pay.settlement.title'] })).toBeVisible();
    await page.locator('button[data-action="open"]').click();
    await page.locator('select#open-project').selectOption(seeded.projectId);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.open.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.settlement.done.opened']);
    const [created] = await sql<{ id: string }>('select id from machvon.settlement_revision where project_id = $1', [seeded.projectId]);
    const id = created!.id;
    expect(await rowOf(id)).toMatchObject({ status: 'DRAFT', outstanding: '0' });
    expect(await eventsOf(id, 'pay.settlement.opened.v1')).toHaveLength(1);
    expect(await auditsOf(id, 'settlement_revision.opened')).toEqual([{ actor_id: membershipOf('settleOfficer') }]);
    await expect(page.getByTestId('detail')).toHaveAttribute('data-status', 'DRAFT');
    await expect(page.getByTestId('fact-project')).toHaveText(seeded.code);

    // A second settlement of the same project is refused in words.
    await page.locator('button[data-action="open"]').click();
    await page.locator('select#open-project').selectOption(seeded.projectId);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.open.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['pay.settlement.error.openExists']);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.dialog.cancel'] }).click();

    // Something is owed (the ledgers of the stack hold no payment for this project, so the figure is put there, as the read of the ledgers would give it).
    const client = new Client({ connectionString: stackInfo().adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query('update machvon.settlement_revision set outstanding_vnd = 150000000, settled_amount_vnd = 9850000000 where id = $1::uuid', [id]);
    } finally {
      await client.end();
    }

    // UAT-AC339: sent today, the group B gives 180 days.
    await open(page, `/pay/pay-15?settlement=${id}`, 'settleOfficer');
    await expect(page.getByTestId('fact-outstanding')).toHaveText('150.000.000');
    await page.locator('button[data-action="submit"]').click();
    await expect(page.locator('#submit-day')).toHaveValue(day());
    await page.locator('#submit-day').fill(day(1));
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.submit.submit'] }).click();
    await expect(page.getByRole('dialog').getByText(vi['pay.settlement.problem.future'])).toBeVisible();
    await page.locator('#submit-day').fill(day());
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.submit.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.settlement.done.submitted']);
    await expect(page.getByTestId('fact-status')).toHaveText(vi['pay.settlement.status.submitted']);
    await expect(page.getByTestId('fact-group')).toHaveText(vi['pay.settlement.group.b']);
    await expect(page.getByTestId('fact-deadline')).toHaveText(plus(day(), 180));
    await expect(page.getByTestId('fact-rule')).toHaveText(vi['pay.settlement.fact.rule.awaiting']);
    // The officer who sent it holds no right to verify, and so is not offered the verification.
    await expect(page.locator('button[data-action="take-up"]')).toHaveCount(0);
    expect(await rowOf(id)).toMatchObject({ status: 'SUBMITTED', group: 'B', due: plus(day(), 180), days: 180 });
    expect(await eventsOf(id, 'pay.settlement.submitted.v1')).toHaveLength(1);
    // The row of the list tells the days left.
    await expect(page.locator(`tr[data-settlement="${id}"]`).getByTestId('days-left')).toHaveText(vi['pay.settlement.deadline.later'].replace('{days}', '180'));

    // Another person takes the file up and verifies it.
    await open(page, `/pay/pay-15?settlement=${id}`, 'settleVerifier');
    await page.locator('button[data-action="take-up"]').click();
    await page.locator('#verify-findings').fill('Hồ sơ đầy đủ, đối chiếu sổ cái.');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.outcome.verifying'] }).click();
    await expect(page.getByTestId('fact-status')).toHaveText(vi['pay.settlement.status.verifying']);
    await page.locator('button[data-action="verify"]').click();
    await page.locator('#verify-findings').fill('Số liệu khớp sổ cái; không có phát hiện.');
    await expect(page.locator('#verify-refs')).toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.outcome.verified'] }).click();
    await expect(page.getByTestId('fact-status')).toHaveText(vi['pay.settlement.status.verified']);
    await expect(page.getByTestId('fact-verified')).toHaveText(day());
    expect(await rowOf(id)).toMatchObject({ status: 'VERIFIED' });
    expect(await eventsOf(id, 'pay.settlement.verified.v1')).toHaveLength(1);
    expect(await auditsOf(id, 'settlement_revision.verification_verifying')).toEqual([{ actor_id: membershipOf('settleVerifier') }]);

    // UAT-AC66: something is owed, so the leader is not offered the close; the chief approves the exception; then the leader closes.
    await open(page, `/pay/pay-15?settlement=${id}`, 'settleLeader');
    await expect(page.getByTestId('owes')).toHaveText(vi['pay.settlement.owes.callout']);
    await expect(page.locator('button[data-action="close"]')).toHaveCount(0);
    await open(page, `/pay/pay-15?settlement=${id}`, 'settleChief');
    await page.locator('button[data-action="exception"]').click();
    await page.locator('#exception-reason').fill('Công nợ chờ bảo lãnh bảo hành theo biên bản 05/BB');
    await page.locator('#exception-document').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.exception.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.settlement.done.exception']);
    await expect(page.getByTestId('fact-exception')).toHaveText('Công nợ chờ bảo lãnh bảo hành theo biên bản 05/BB');
    expect(await rowOf(id)).toMatchObject({ status: 'VERIFIED', exception_by: membershipOf('settleChief'), outstanding: '150000000' });
    expect(await auditsOf(id, 'settlement_revision.exception_approved')).toEqual([{ actor_id: membershipOf('settleChief') }]);

    await open(page, `/pay/pay-15?settlement=${id}`, 'settleLeader');
    await expect(page.getByTestId('owes')).toHaveCount(0);
    await page.locator('button[data-action="close"]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.close.submit'] }).click();
    await expect(page.getByRole('dialog').getByText(vi['pay.settlement.problem.required']).first()).toBeVisible();
    await page.locator('#close-reason').fill('Phê duyệt quyết toán theo quyết định 10/QTDA');
    await page.locator('#close-decision').fill(seeded.decision);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.close.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.settlement.done.closed']);
    await expect(page.getByTestId('fact-status')).toHaveText(vi['pay.settlement.status.closed']);
    // The figures stay as they were.
    await expect(page.getByTestId('fact-outstanding')).toHaveText('150.000.000');
    expect(await rowOf(id)).toMatchObject({ status: 'CLOSED', outstanding: '150000000', closed_by: membershipOf('settleLeader') });
    expect(await eventsOf(id, 'pay.settlement.closed.v1')).toHaveLength(1);
    expect(await auditsOf(id, 'settlement_revision.closed')).toEqual([{ actor_id: membershipOf('settleLeader') }]);
    await expect(page.locator('button[data-action]')).toHaveCount(0);
  });

  test('a reader sees the settlement and no command, and the filter by status narrows the table', async ({ page }) => {
    const seeded = await seed();
    await open(page, '/pay/pay-15', 'settleOfficer');
    await page.locator('button[data-action="open"]').click();
    await page.locator('select#open-project').selectOption(seeded.projectId);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.settlement.open.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.settlement.done.opened']);
    const [created] = await sql<{ id: string }>('select id from machvon.settlement_revision where project_id = $1', [seeded.projectId]);

    await open(page, `/pay/pay-15?settlement=${created!.id}`, 'settleReader');
    await expect(page.getByTestId('detail')).toBeVisible();
    await expect(page.locator('button[data-action]')).toHaveCount(0);
    await expect(page.locator(`tr[data-settlement="${created!.id}"]`).getByTestId('status')).toHaveText(vi['pay.settlement.status.draft']);
    // Filtering by a status nothing is in leaves the table empty in words.
    await page.locator('#settlement-status').selectOption('CLOSED');
    await expect(page.locator(`tr[data-settlement="${created!.id}"]`)).toHaveCount(0);
    await page.locator('#settlement-status').selectOption('');
    await expect(page.locator(`tr[data-settlement="${created!.id}"]`)).toHaveCount(1);
  });
});
