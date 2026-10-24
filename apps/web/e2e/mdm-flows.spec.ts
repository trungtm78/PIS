import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * MDM-01, MDM-25, MDM-26, MDM-27, MDM-28 and MDM-32 in a real browser against the real API and database (apps/api/test/e2e-stack):
 * a catalogue steward proposes an entry, a second person reviews it, a publisher puts it in force, and the history keeps what was
 * valid before. The four-eyes rule is the real one: the proposer sees their own request as theirs and is offered no decision.
 */

const unique = (): string => Date.now().toString(36).toUpperCase();

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface ChangeRow {
  id: string;
  status: string;
  change_kind: string;
  version: string;
}

const changesOf = (key: string): Promise<ChangeRow[]> =>
  sql(
    `select c.id, c.status, c.change_kind, c.version::text as version
       from machvon.master_change_request c join machvon.master_record r on r.id = c.master_record_id
      where r.business_key = $1 order by c.created_at`,
    [key],
  );

const recordOf = async (key: string): Promise<{ id: string; status: string; current_version_id: string | null }> => {
  const [row] = await sql<{ id: string; status: string; current_version_id: string | null }>('select id, status, current_version_id from machvon.master_record where business_key = $1', [key]);
  if (row === undefined) throw new Error(`no record ${key}`);
  return row;
};

async function documentFor(): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
     values ($1, $2, 'INCOMING', 'CV', 'Decision of the e2e flow', 'INTERNAL', $3, $3)`,
    [stackInfo().tenants.A, id, membershipOf('dataChecker')],
  );
  return id;
}

async function propose(page: Page, key: string): Promise<void> {
  await open(page, '/mdm/mdm-25', 'steward');
  await page.getByLabel(vi['mdm.create.type.label']).fill('E2E_SECTOR');
  await page.getByLabel(vi['mdm.create.key.label']).fill(key);
  await page.getByLabel(vi['mdm.create.name.label']).fill('Giao thông e2e');
  await page.getByLabel(vi['mdm.create.validFrom.label']).fill('2024-01-01');
  await page.getByLabel(vi['mdm.create.reason.label']).fill('Entry made by the end-to-end flow');
  await page.getByRole('button', { name: vi['mdm.create.save.action'] }).click();
  await expect(page.getByTestId('impact')).toBeVisible();
  await page.getByRole('checkbox', { name: vi['mdm.impact.read.label'] }).check();
  await page.getByRole('button', { name: vi['mdm.impact.submit.action'] }).click();
  await expect(page.getByText(vi['mdm.create.submitted.notice'], { exact: false })).toBeVisible();
}

async function approve(page: Page, changeId: string, reason: string): Promise<void> {
  await open(page, '/mdm/mdm-32', 'dataChecker');
  const row = page.locator(`[data-stage="review"][data-change-id="${changeId}"]`);
  await row.getByRole('button', { name: vi['mdm.approval.review.action'] }).click();
  const panel = page.locator(`[data-panel-for="${changeId}"]`);
  await panel.getByLabel(vi['mdm.approval.reason.label']).fill(reason);
  await panel.getByRole('button', { name: vi['mdm.approval.decision.approve.action'] }).click();
  await expect(page.getByText(vi['mdm.approval.decided.notice'])).toBeVisible();
}

async function publish(page: Page, changeId: string): Promise<void> {
  const document = await documentFor();
  await open(page, '/mdm/mdm-32', 'dataChecker');
  const row = page.locator(`[data-stage="publish"][data-change-id="${changeId}"]`);
  await row.getByRole('button', { name: vi['mdm.approval.publish.action'] }).click();
  const panel = page.locator(`[data-panel-for="${changeId}"]`);
  await panel.getByLabel(vi['mdm.approval.document.label']).fill(document);
  await panel.getByRole('button', { name: vi['mdm.approval.publish.confirm.action'] }).click();
  await expect(page.getByText(vi['mdm.approval.published.notice'])).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('master data: propose, review, publish, change and history', () => {
  const key = `E2E-${unique()}`;

  test('a steward proposes an entry, the proposer is offered no decision on it, and a checker approves and publishes it', async ({ page }) => {
    await propose(page, key);
    const [created] = await changesOf(key);
    expect(created).toMatchObject({ status: 'IN_REVIEW', change_kind: 'CREATE' });

    // The steward reads the queue (master.read) and is offered no decision: a steward holds neither the review nor the publish permission.
    await open(page, '/mdm/mdm-32', 'steward');
    await expect(page.locator(`[data-change-id="${created?.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-change-id="${created?.id}"]`).getByRole('button')).toHaveCount(0);

    await approve(page, created?.id ?? '', 'Checked against the decision of the committee');
    expect((await changesOf(key))[0]?.status).toBe('APPROVED');
    expect((await recordOf(key)).status).toBe('APPROVED');

    await publish(page, created?.id ?? '');
    expect((await changesOf(key))[0]?.status).toBe('APPLIED');
    const record = await recordOf(key);
    expect(record.status).toBe('EFFECTIVE');
    expect(record.current_version_id).not.toBeNull();
    const events = await sql<{ n: string }>("select count(*)::text as n from machvon.outbox_event where type = 'master.published.v1' and aggregate_id = $1", [record.id]);
    expect(Number(events[0]?.n)).toBe(1);

    await open(page, '/mdm/mdm-01', 'steward');
    const row = page.locator(`[data-record-id="${record.id}"]`);
    await expect(row).toContainText(key);
    await expect(row).toContainText(vi['mdm.status.record.effective']);
    await row.getByRole('link', { name: vi['mdm.hub.open.action'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.detail.page.title'] })).toBeVisible();
    await expect(page.getByTestId('entry')).toContainText('Giao thông e2e');
    await expect(page.getByTestId('impact')).toHaveAttribute('data-impact-total', '0');
  });

  test('a change from a later date keeps the old name for the earlier dates, and the history shows both versions', async ({ page }) => {
    await open(page, `/mdm/mdm-26?type=E2E_SECTOR&key=${key}`, 'steward');
    await page.getByLabel(vi['mdm.edit.name.label']).fill('Giao thông vận tải e2e');
    await page.getByLabel(vi['mdm.edit.effectiveFrom.label']).fill('2025-06-01');
    await page.getByLabel(vi['mdm.edit.reason.label']).fill('Renamed by the end-to-end flow');
    await page.getByRole('button', { name: vi['mdm.edit.save.action'] }).click();
    await expect(page.getByTestId('impact')).toBeVisible();
    await page.getByRole('checkbox', { name: vi['mdm.impact.read.label'] }).check();
    await page.getByRole('button', { name: vi['mdm.impact.submit.action'] }).click();
    await expect(page.getByText(vi['mdm.create.submitted.notice'], { exact: false })).toBeVisible();

    const changes = await changesOf(key);
    const update = changes.find((change) => change.change_kind === 'UPDATE');
    expect(update?.status).toBe('IN_REVIEW');
    await approve(page, update?.id ?? '', 'Checked against the decision of the committee');
    await publish(page, update?.id ?? '');

    await open(page, `/mdm/mdm-28?type=E2E_SECTOR&key=${key}`, 'steward');
    await expect(page.locator('[data-revision]')).toHaveCount(2);
    const second = page.locator('[data-revision="2"]');
    await expect(second.locator('[data-field="label"] [data-side="before"]')).toHaveText('Giao thông e2e');
    await expect(second.locator('[data-field="label"] [data-side="after"]')).toHaveText('Giao thông vận tải e2e');
    await expect(page.locator('[data-revision="1"]')).toContainText('2024-01-01 → 2025-06-01');
    expect((await recordOf(key)).status).toBe('EFFECTIVE');
  });

  test('a duplicate key is refused with the message of the screen and nothing is written', async ({ page }) => {
    await open(page, '/mdm/mdm-25', 'steward');
    await page.getByLabel(vi['mdm.create.type.label']).fill('E2E_SECTOR');
    await page.getByLabel(vi['mdm.create.key.label']).fill(key);
    await page.getByLabel(vi['mdm.create.name.label']).fill('Trùng mã');
    await page.getByLabel(vi['mdm.create.validFrom.label']).fill('2024-01-01');
    await page.getByLabel(vi['mdm.create.reason.label']).fill('A second entry with the same key');
    await page.getByRole('button', { name: vi['mdm.create.save.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['mdm.problem.duplicateKey.error'] })).toBeVisible();
    const rows = await sql<{ n: string }>("select count(*)::text as n from machvon.master_record where business_key = $1 and master_type = 'E2E_SECTOR'", [key]);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  test('someone without the master data permissions sees no entry and is offered no way to add one', async ({ page }) => {
    await open(page, '/mdm/mdm-01', 'auditor');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.hub.page.title'] })).toBeVisible();
    await expect(page.getByRole('link', { name: vi['mdm.hub.add.action'] })).toHaveCount(0);
    await expect(page.locator('[data-record-id]')).toHaveCount(0);
  });
});
