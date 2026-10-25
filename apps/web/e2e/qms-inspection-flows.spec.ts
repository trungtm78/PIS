import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * QMS-04 (the inspection requests of a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the contractor asks for an inspection of an item of a
 * contract that is being performed and is told which regime was in force on the day, with the roles that sign the minutes and the warning that the regime waits for its confirmation; asking
 * again for the same thing is refused in words; the supervisor schedules it with the people who take part and records its result against the checklist, which is held to the answers; an
 * inspection can be cancelled with a reason. A reader sees the inspections and no command. What the screens changed is looked up in the database.
 */

const MAKER = membershipOf('lifecycleMaker');
let counter = 0;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface Seeded {
  contractId: string;
  code: string;
}

/** An ACTIVE contract with the revision in force and one item of the BOQ, written straight to the database (foreign keys to modules that are not seeded are switched off). */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const itemId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const code = `HD-KT-${suffix}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  if (contractor === undefined || project === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử kiểm tra', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, code, MAKER, membershipOf('lifecycleReviewer'), papers[0]?.id, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, papers[0]?.id, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    await client.query(
      `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, 'B01', 'Đào đất', 'M3', $4, $4)`,
      [tenant, itemId, contractId, MAKER],
    );
    await client.query(
      `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
       values ($1, gen_random_uuid(), $2, $3, $4, 1, 'B01', 'Đào đất', 'M3', 100, 10000, 'HALF_UP', 1000000, 5, $5)`,
      [tenant, revisionId, contractId, itemId, MAKER],
    );
  } finally {
    await client.end();
  }
  return { contractId, code };
}

interface InspectionRow {
  id: string;
  inspection_no: string;
  status: string;
  inspection_type: string;
  requested_for: string;
  required_roles: string[];
  regime_awaiting_confirmation: boolean;
  regime_cxn: string | null;
  boq_item_id: string | null;
  scheduled_at: string | null;
  participant_membership_ids: string[];
  result: string | null;
  result_note: string | null;
  cancel_reason: string | null;
  checklist: Array<{ code: string; label: string; outcome?: string; note?: string }>;
  version: string;
}

const inspectionsOf = (contractId: string) =>
  sql<InspectionRow>(
    `select id, inspection_no, status, inspection_type, requested_for::text, required_roles, regime_awaiting_confirmation, regime_cxn, boq_item_id, scheduled_at::text, participant_membership_ids, result, result_note, cancel_reason,
            checklist, version::text
       from machvon.inspection where contract_id = $1 order by created_at, id`,
    [contractId],
  );

const vietnamToday = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

/** Asks for an inspection of the item B01 through the dialog; the contract is the one named in the address. */
async function ask(page: Page, type: string, title: string, day?: string): Promise<void> {
  await page.getByRole('button', { name: vi['qms.inspection.request.action'] }).click();
  await page.locator('#inspection-item').selectOption({ label: 'B01 · Đào đất' });
  await page.locator('#inspection-type').selectOption(type);
  await page.locator('#inspection-title').fill(title);
  if (day !== undefined) await page.locator('#inspection-day').fill(day);
  await page.getByRole('dialog').getByRole('button', { name: vi['qms.inspection.request.submit'] }).click();
}

test.describe('the inspection requests of a contract', () => {
  test('the contractor asks, the supervisor schedules and records a failed result, and the inspection is kept as it is (UI-QMS-04, AC-ST-QMS-004-1, AC-ST-QMS-004-3, UAT-AC363, UAT-AC360)', async ({ page }) => {
    const seeded = await seed();
    const path = `/qms/qms-04?contract=${seeded.contractId}`;

    await open(page, path, 'inspectionRequester');
    await expect(page.getByRole('heading', { level: 1, name: vi['qms.inspection.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-inspections')).toHaveText(vi['qms.inspection.none.notice']);

    // An empty request says what is missing, and nothing is sent.
    await page.getByRole('button', { name: vi['qms.inspection.request.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.inspection.request.submit'] }).click();
    await expect(page.getByText(vi['qms.inspection.problem.required']).first()).toBeVisible();
    await page.getByRole('button', { name: vi['qms.inspection.dialog.cancel'] }).click();
    expect(await inspectionsOf(seeded.contractId)).toHaveLength(0);

    // The request keeps the regime in force on the day, with the roles that sign the minutes, and warns that the regime waits for its confirmation.
    await ask(page, 'CONCEALED_WORK', 'Cốt thép móng M1');
    await expect(page.getByTestId('inspections')).toBeVisible();
    const [asked] = await inspectionsOf(seeded.contractId);
    expect(asked).toMatchObject({ status: 'REQUESTED', inspection_type: 'CONCEALED_WORK', requested_for: vietnamToday(), required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], regime_awaiting_confirmation: true, regime_cxn: 'CXN-07', version: '1' });
    expect(asked?.inspection_no).toMatch(/^KT-\d{3}$/);
    expect(asked?.boq_item_id).not.toBeNull();
    const line = page.locator(`tr[data-inspection="${asked?.id}"]`);
    await expect(line.getByTestId('status')).toHaveText(vi['qms.inspection.status.requested']);
    await expect(line.getByTestId('regime')).toContainText('Nghị định 06/2021');
    await expect(line.getByTestId('regime-warning')).toHaveText(vi['qms.inspection.regime.unconfirmed'].replace('{cxn}', 'CXN-07'));
    // The contractor asked, and does not schedule or record.
    await expect(line.locator('[data-schedule]')).toHaveCount(0);
    await expect(line.locator('[data-record]')).toHaveCount(0);

    // The same thing again is refused in words.
    await ask(page, 'CONCEALED_WORK', 'Cốt thép móng M1 (lại)');
    await expect(page.getByTestId('refusal')).toHaveText(vi['qms.inspection.error.duplicate']);
    await page.getByRole('button', { name: vi['qms.inspection.dialog.cancel'] }).click();
    expect(await inspectionsOf(seeded.contractId)).toHaveLength(1);

    // A reader sees the inspection and no command.
    await open(page, path, 'inspectionReader');
    await expect(page.locator(`tr[data-inspection="${asked?.id}"]`)).toBeVisible();
    await expect(page.locator('button[data-schedule], button[data-record], button[data-cancel]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['qms.inspection.request.action'] })).toHaveCount(0);

    // The supervisor schedules it with a person who takes part.
    await open(page, path, 'inspectionSupervisor');
    await page.locator(`[data-schedule="${asked?.id}"]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.inspection.schedule.submit'] }).click();
    await expect(page.getByText(vi['qms.inspection.problem.noParticipant'])).toBeVisible();
    await page.locator('#inspection-at').fill('2999-01-01T09:30');
    await page.locator('input[data-member]').first().check();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.inspection.schedule.submit'] }).click();
    await expect(page.locator(`tr[data-inspection="${asked?.id}"]`)).toHaveAttribute('data-status', 'SCHEDULED');
    const [scheduled] = await inspectionsOf(seeded.contractId);
    expect(scheduled).toMatchObject({ status: 'SCHEDULED', version: '2' });
    expect(scheduled?.participant_membership_ids).toHaveLength(1);
    expect(new Date(scheduled?.scheduled_at ?? '').getUTCFullYear()).toBe(2999);

    // The result is held to the answers: a PASS cannot have a failed item.
    await page.locator(`[data-record="${asked?.id}"]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.inspection.record.submit'] }).click();
    await expect(page.getByText(vi['qms.inspection.problem.unanswered']).first()).toBeVisible();
    const items = scheduled?.checklist.length ?? 0;
    expect(items).toBeGreaterThan(1);
    for (let index = 0; index < items; index += 1) await page.locator(`#inspection-answer-${index}`).selectOption(index === 0 ? 'FAIL' : 'PASS');
    await page.locator('#inspection-answer-note-0').fill('Thiếu biên bản nghiệm thu cốt thép.');
    await page.locator('#inspection-result').selectOption('PASS');
    await page.locator('#inspection-result-note').fill('Không đạt yêu cầu.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.inspection.record.submit'] }).click();
    await expect(page.getByTestId('contradiction')).toHaveText(vi['qms.inspection.problem.passWithFailed']);
    expect((await inspectionsOf(seeded.contractId))[0]?.status).toBe('SCHEDULED');
    await page.locator('#inspection-result').selectOption('FAIL');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.inspection.record.submit'] }).click();
    await expect(page.locator(`tr[data-inspection="${asked?.id}"]`)).toHaveAttribute('data-status', 'RESULT_RECORDED');
    await expect(page.locator(`tr[data-inspection="${asked?.id}"]`).getByTestId('result')).toHaveText(vi['qms.inspection.result.fail']);
    const [recorded] = await inspectionsOf(seeded.contractId);
    expect(recorded).toMatchObject({ status: 'RESULT_RECORDED', result: 'FAIL', result_note: 'Không đạt yêu cầu.', version: '3' });
    expect(recorded?.checklist[0]).toMatchObject({ outcome: 'FAIL', note: 'Thiếu biên bản nghiệm thu cốt thép.' });

    // A recorded inspection is kept as it is: no command is offered on it.
    await page.reload();
    await expect(page.locator(`tr[data-inspection="${asked?.id}"]`)).toHaveAttribute('data-status', 'RESULT_RECORDED');
    await expect(page.locator(`tr[data-inspection="${asked?.id}"] button`)).toHaveCount(0);
  });

  test('the regime that replaces the current one from 2027 gives the inspection of that day its own roles (UI-QMS-04, AC-ST-QMS-004-1, UAT-AC363)', async ({ page }) => {
    const seeded = await seed();
    await open(page, `/qms/qms-04?contract=${seeded.contractId}`, 'inspectionRequester');
    await ask(page, 'COMPLETION', 'Hoàn thành hạng mục', '2027-03-01');
    await expect(page.getByTestId('inspections')).toBeVisible();
    const [asked] = await inspectionsOf(seeded.contractId);
    expect(asked).toMatchObject({ requested_for: '2027-03-01', required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'], regime_awaiting_confirmation: true, regime_cxn: 'CXN-07' });
    const line = page.locator(`tr[data-inspection="${asked?.id}"]`);
    await expect(line.getByTestId('regime')).toContainText('Nghị định 207/2026');
    await expect(line.getByTestId('roles')).toContainText(vi['qms.inspection.role.designer']);
  });

  test('a request that was made in error is cancelled with a reason, which is kept (UI-QMS-04)', async ({ page }) => {
    const seeded = await seed();
    await open(page, `/qms/qms-04?contract=${seeded.contractId}`, 'inspectionSupervisor');
    await ask(page, 'SAFETY', 'An toàn tại vị trí T1');
    await expect(page.getByTestId('inspections')).toBeVisible();
    const [asked] = await inspectionsOf(seeded.contractId);
    await page.locator(`[data-cancel="${asked?.id}"]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.inspection.cancel.submit'] }).click();
    await expect(page.getByText(vi['qms.inspection.problem.required'])).toBeVisible();
    await page.locator('#inspection-cancel-reason').fill('Đề nghị nhầm hợp đồng.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.inspection.cancel.submit'] }).click();
    const line = page.locator(`tr[data-inspection="${asked?.id}"]`);
    await expect(line).toHaveAttribute('data-status', 'CANCELLED');
    await expect(line.getByTestId('cancel-reason')).toHaveText(vi['qms.inspection.cancelled.reason'].replace('{reason}', 'Đề nghị nhầm hợp đồng.'));
    expect((await inspectionsOf(seeded.contractId))[0]).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Đề nghị nhầm hợp đồng.' });
    await expect(line.locator('button')).toHaveCount(0);
  });
});
