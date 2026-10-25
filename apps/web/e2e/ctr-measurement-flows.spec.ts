import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CTR-10 (the measurements of a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the supervisor records the quantity of an item in a period, which waits
 * as a draft, and is told in words when a quantity would go above what is left of the item; the quantity is sent, and an authority who did not record it approves it, which is when it counts
 * towards the cumulative; the authority then corrects what was approved, which supersedes it and makes the next revision of the measurement as a draft. A reader sees the quantities and no
 * command. What the screens changed is looked up in the database.
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
  evidence: string;
  periods: string[];
}

/** An ACTIVE contract with the revision in force, B01 (100 m3) and B02 (20 m3), two periods and a clean paper, written straight to the database (foreign keys to modules that are not seeded are switched off). */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const code = `HD-KL-${suffix}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  if (contractor === undefined || project === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const items = [randomUUID(), randomUUID()];
  const periods = [randomUUID(), randomUUID()];
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử khối lượng', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, code, MAKER, membershipOf('lifecycleReviewer'), papers[0]?.id, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, papers[0]?.id, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    await client.query(
      `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
       values ($1, $2, $4, 'B01', 'Đào đất', 'M3', $5, $5), ($1, $3, $4, 'B02', 'Đắp đất', 'M3', $5, $5)`,
      [tenant, items[0], items[1], contractId, MAKER],
    );
    for (const [n, key, description, quantity, price] of [
      [1, 'B01', 'Đào đất', '100', '10000'],
      [2, 'B02', 'Đắp đất', '20', '10000'],
    ] as const) {
      await client.query(
        `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, 'M3', $8::numeric, $9::numeric, 'HALF_UP', ($8::numeric * $9::numeric), 5, $10)`,
        [tenant, revisionId, contractId, items[n - 1], n, key, description, quantity, price, MAKER],
      );
    }
    for (const [n, periodId] of periods.entries()) {
      const month = String(n + 1).padStart(2, '0');
      await client.query(
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', $6, 'MONTH', 2026, 'OPEN', gen_random_uuid(), $7, $7)`,
        [tenant, periodId, `KL-${suffix}-${month}`, `2026-${month}-01`, `2026-${month}-28`, `CAL-${suffix}`, MAKER],
      );
    }
  } finally {
    await client.end();
  }
  return { contractId, code, evidence: papers[0]?.id ?? '', periods };
}

const measurementsOf = (contractId: string) =>
  sql<{ id: string; status: string; revision: number; quantity_period: string; quantity_cumulative: string; correction_of_id: string | null; reference_no: string | null; version: string; submitted_by: string | null; decided_by: string | null }>(
    'select id, status, revision, quantity_period::text, quantity_cumulative::text, correction_of_id, reference_no, version::text, submitted_by, decided_by from machvon.measurement where contract_id = $1 order by created_at, id',
    [contractId],
  );

/** Records a quantity of an item through the dialog of the row of the item. */
async function record(page: Page, seeded: Seeded, item: string, period: number, quantity: string, reference: string): Promise<void> {
  await page.locator(`tr[data-item="${item}"] [data-action="record"]`).click();
  await page.locator('#record-period').selectOption(seeded.periods[period] ?? '');
  await page.locator('#record-quantity').fill(quantity);
  await page.locator('#record-reference').fill(reference);
  await page.locator('#record-evidence').fill(seeded.evidence);
  await page.getByRole('button', { name: vi['ctr.measurement.record.submit'] }).click();
}

test.describe('the measurements of a contract', () => {
  test('the supervisor records and sends a quantity, another person approves it, and the authority corrects it (UI-CTR-10, AC-ST-CTR-008-1, AC-ST-CTR-008-2, UAT-AC311, UAT-AC312)', async ({ page }) => {
    const seeded = await seed();

    await open(page, `/ctr/ctr-10?contract=${seeded.contractId}`, 'measurementRecorder');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.measurement.title'] })).toBeVisible();
    await expect(page.getByTestId('contract-code')).toHaveText(seeded.code);
    await expect(page.locator('tr[data-item="B01"] [data-testid="remaining"]')).toHaveText('100');

    // An empty form says what is missing, and nothing is sent.
    await page.locator('tr[data-item="B01"] [data-action="record"]').click();
    await expect(page.getByTestId('record-left')).toHaveText(`${vi['ctr.measurement.record.left'].replace('{remaining}', '100').replace('{unit}', 'M3')}`);
    await page.getByRole('button', { name: vi['ctr.measurement.record.submit'] }).click();
    await expect(page.getByText(vi['ctr.measurement.problem.required']).first()).toBeVisible();
    await page.getByRole('button', { name: vi['ctr.measurement.dialog.cancel'] }).click();

    await record(page, seeded, 'B01', 0, '60', 'NK-KL-001');
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.measurement.done.recorded']);
    await expect(page.locator('tr[data-item="B01"] [data-testid="remaining"]')).toHaveText('40');
    let [first] = await measurementsOf(seeded.contractId);
    expect(first).toMatchObject({ status: 'DRAFT', quantity_period: '60.000000', quantity_cumulative: '60.000000', revision: 1, reference_no: 'NK-KL-001' });

    // More than is left of the item is refused in words, with what is left, and the dialog stays open.
    await page.locator('tr[data-item="B01"] [data-action="record"]').click();
    await page.locator('#record-period').selectOption(seeded.periods[1] ?? '');
    await page.locator('#record-quantity').fill('40.000001');
    await page.locator('#record-reference').fill('NK-KL-002');
    await page.locator('#record-evidence').fill(seeded.evidence);
    await page.getByRole('button', { name: vi['ctr.measurement.record.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ctr.measurement.error.exceedsLeft'].replace('{remaining}', '40'));
    await page.getByRole('button', { name: vi['ctr.measurement.dialog.cancel'] }).click();
    expect(await measurementsOf(seeded.contractId)).toHaveLength(1);

    // The draft is sent; the supervisor, who recorded it, is not offered the decision.
    await page.locator(`tr[data-measurement="${first?.id}"] [data-action="submit"]`).click();
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.measurement.done.submitted']);
    await expect(page.locator(`tr[data-measurement="${first?.id}"]`)).toHaveAttribute('data-status', 'SUBMITTED');
    await expect(page.locator('[data-action="decide"]')).toHaveCount(0);
    [first] = await measurementsOf(seeded.contractId);
    expect(first).toMatchObject({ status: 'SUBMITTED', submitted_by: membershipOf('measurementRecorder') });

    // The authority approves it: it counts towards the cumulative of the item from then on.
    await open(page, `/ctr/ctr-10?contract=${seeded.contractId}`, 'measurementApprover');
    await page.locator(`tr[data-measurement="${first?.id}"] [data-action="decide"]`).click();
    await page.getByRole('button', { name: vi['ctr.measurement.decide.submit'] }).click();
    await expect(page.getByText(vi['ctr.measurement.problem.choose'])).toBeVisible();
    await page.locator('input[data-decision="approve"]').check();
    await page.locator('#decide-reason').fill('Đã kiểm tra tại hiện trường.');
    await page.getByRole('button', { name: vi['ctr.measurement.submit.approve'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.measurement.done.decided']);
    await expect(page.locator(`tr[data-measurement="${first?.id}"]`)).toHaveAttribute('data-status', 'APPROVED');
    await expect(page.locator('tr[data-item="B01"]').getByRole('cell').nth(2)).toHaveText('60');
    [first] = await measurementsOf(seeded.contractId);
    expect(first).toMatchObject({ status: 'APPROVED', quantity_cumulative: '60.000000', decided_by: membershipOf('measurementApprover') });

    // The authority corrects what was approved: the old one is superseded and the new one is a draft of the next revision, counted without the old one.
    await page.locator(`tr[data-measurement="${first?.id}"] [data-action="correct"]`).click();
    await page.locator('#correct-quantity').fill('50');
    await page.locator('#correct-reason').fill('Đo lại sau khi nghiệm thu hố móng.');
    await page.locator('#correct-evidence').fill(seeded.evidence);
    await page.getByRole('button', { name: vi['ctr.measurement.correct.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.measurement.done.corrected']);
    const all = await measurementsOf(seeded.contractId);
    expect(all.map((row) => [row.status, row.revision, row.quantity_period, row.quantity_cumulative])).toEqual([
      ['SUPERSEDED', 1, '60.000000', '60.000000'],
      ['DRAFT', 2, '50.000000', '50.000000'],
    ]);
    expect(all[1]?.correction_of_id).toBe(first?.id);
    // A draft is seen only by whoever made it: the authority who made the correction sees it, the supervisor does not.
    await expect(page.locator(`tr[data-measurement="${all[1]?.id}"]`)).toHaveCount(1);
    await open(page, `/ctr/ctr-10?contract=${seeded.contractId}`, 'measurementRecorder');
    await expect(page.getByTestId('measurements')).toBeVisible();
    await expect(page.locator(`tr[data-measurement="${all[1]?.id}"]`)).toHaveCount(0);
    await expect(page.locator(`tr[data-measurement="${first?.id}"]`)).toHaveAttribute('data-status', 'SUPERSEDED');
  });

  test('a reader sees the quantities and no command (UI-CTR-10)', async ({ page }) => {
    const seeded = await seed();
    await open(page, `/ctr/ctr-10?contract=${seeded.contractId}`, 'measurementReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.measurement.title'] })).toBeVisible();
    // This reader may not read the BOQ, so the table of items is replaced by a sentence, and the quantities are still listed.
    await expect(page.getByTestId('no-items')).toHaveText(vi['ctr.measurement.items.denied']);
    await expect(page.locator('button[data-action]')).toHaveCount(0);
    await expect(page.getByTestId('no-measurements')).toHaveText(vi['ctr.measurement.list.empty']);
  });
});
