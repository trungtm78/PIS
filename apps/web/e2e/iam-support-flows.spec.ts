import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql } from './support/stack.ts';

/**
 * IAM-08 (help and support requests) in a real browser against the real API and database (apps/api/test/e2e-stack): a member raises a ticket and sees it in
 * their list with its code, its priority and the time the answer is due; what they wrote stays in the tenant's own table; a member sees their own tickets only
 * while the manager of support of the tenant sees every one; someone who has no right to read tickets is denied.
 */

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/iam/iam-08?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const form = (page: Page) => page.getByRole('form', { name: vi['iam.support.form.aria'] });

async function raise(page: Page, values: { category: string; subject: string; description: string }): Promise<void> {
  await form(page).getByLabel(vi['iam.support.form.category.label'], { exact: true }).selectOption(values.category);
  await form(page).getByLabel(vi['iam.support.form.subject.label'], { exact: true }).fill(values.subject);
  await form(page).getByLabel(vi['iam.support.form.description.label'], { exact: true }).fill(values.description);
  await form(page).getByRole('button', { name: vi['iam.support.form.send.action'] }).click();
}

const ticketsOf = (subject: string) =>
  sql<{ id: string; ticket_code: string; priority: string; status: string; requester_membership_id: string; due_after_creation: boolean; description: string }>(
    `select t.id, t.ticket_code, t.priority, t.status, t.requester_membership_id, t.sla_due_at > t.created_at as due_after_creation, b.description
       from machvon.support_ticket t join machvon.support_ticket_body b on b.tenant_id = t.tenant_id and b.ticket_id = t.id where t.subject = $1 order by t.created_at`,
    [subject],
  );

test.describe('IAM-08 support requests', () => {
  test('a member raises a ticket and sees it with its code, its priority and the time the answer is due; the manager of support sees every ticket, a member only their own (AC-ST-IAM-007-1)', async ({ page }) => {
    const label = Date.now().toString(36);
    const subject = `Không mở được sổ đăng ký dự án ${label}`;
    const description = `Từ sáng nay sổ đăng ký báo tôi không có quyền.\nXin hỗ trợ gấp ${label}.`;
    await open(page, 'supportMember');
    await expect(page.getByRole('heading', { level: 1, name: vi['iam.support.page.title'] })).toBeVisible();

    // Nothing is sent without a subject and a description.
    await form(page).getByRole('button', { name: vi['iam.support.form.send.action'] }).click();
    await expect(form(page).locator('.field-error')).toHaveCount(2);
    expect(await ticketsOf(subject)).toEqual([]);

    await raise(page, { category: 'INCIDENT', subject, description });
    await expect(page.getByTestId('raised')).toContainText('SUP-');
    const [made] = await ticketsOf(subject);
    expect(made).toMatchObject({ priority: 'P1', status: 'Open', requester_membership_id: membershipOf('supportMember'), description });
    expect(made?.ticket_code).toMatch(/^SUP-\d{4}-\d{6}$/);
    expect(made?.due_after_creation).toBe(true);
    const row = page.locator(`tr[data-ticket-id="${made?.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(made?.ticket_code ?? '');
    await expect(row).toContainText(subject);
    await expect(row).toContainText(vi['iam.support.priority.p1.label']);
    await expect(row).toContainText(vi['iam.support.status.open.label']);
    // What the member wrote is not in the list, only the subject.
    await expect(page.getByTestId('tickets')).not.toContainText('Xin hỗ trợ gấp');
    await expect(page.getByTestId('raised')).toHaveText(`Đã gửi yêu cầu hỗ trợ, mã ${made?.ticket_code}.`);
    expect(await sql("select 1 from machvon.audit_event where resource_id = $1::uuid and action = 'support.ticket_created'", [made?.id])).toHaveLength(1);

    // Another member does not see it; the manager of support of the tenant does, and says it is someone else's.
    await open(page, 'supportOther');
    await expect(page.locator(`tr[data-ticket-id="${made?.id}"]`)).toHaveCount(0);
    await open(page, 'supportManager');
    const seen = page.locator(`tr[data-ticket-id="${made?.id}"]`);
    await expect(seen).toBeVisible();
    await expect(seen).toContainText(vi['iam.support.other.text']);
    await expect(form(page)).toHaveCount(0);
  });

  test('someone who has no right to read tickets is denied', async ({ page }) => {
    await open(page, 'permitReader');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(form(page)).toHaveCount(0);
  });
});
