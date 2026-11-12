import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CTR-12 (the acceptance of work under a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the officer draws up an acceptance from approved measurements
 * of a period, each line priced at the revision in force, and sends it with the people who sign the paper; a leader who did not draft it approves it, which makes the contract's accepted total
 * rise and tells payment once; another person revokes it with a reason and a paper, which brings the total back. A contract that asks for quality acceptance minutes refuses the approval in words
 * until there are some. A reader sees the acceptances and no command. What the screens changed is looked up in the database.
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
  paper: string;
  period: string;
  measurements: string[];
}

/**
 * An ACTIVE contract worth 1,200,000 dong with the revision in force and B01 and B02 (100 m3 each at 10,000), a period and an approved measurement of each (60 m3 of B01 and 20 m3 of B02),
 * written straight to the database (foreign keys to modules that are not seeded are switched off).
 */
async function seed(options: { requiresQuality: boolean }): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const items = [randomUUID(), randomUUID()];
  const lines = [randomUUID(), randomUUID()];
  const period = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const code = `HD-NTK-${suffix}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  if (contractor === undefined || project === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const measurements = [randomUUID(), randomUUID()];
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, requires_quality_acceptance,
                                     created_by, updated_by, submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử nghiệm thu khối lượng', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $11, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, code, MAKER, membershipOf('lifecycleReviewer'), papers[0]?.id, membershipOf('lifecycleActivator'), options.requiresQuality],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, papers[0]?.id, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    for (const [n, key] of ['B01', 'B02'].entries()) {
      await client.query(`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, $5, $6, 'M3', $4, $4)`, [tenant, items[n], contractId, MAKER, key, `Hạng mục ${key}`]);
      await client.query(
        `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
         values ($1, $2, $3, $4, $5, $7, $6, $8, 'M3', 100, 10000, 'HALF_UP', 1000000, 5, $9)`,
        [tenant, lines[n], revisionId, contractId, items[n], key, n + 1, `Hạng mục ${key}`, MAKER],
      );
    }
    await client.query(
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, date '2026-07-01', date '2026-07-28', date '2026-07-28' + interval '3 hours', $4, 'MONTH', 2026, 'OPEN', gen_random_uuid(), $5, $5)`,
      [tenant, period, `NT-${suffix}`, `CAL-${suffix}`, MAKER],
    );
    for (const [n, measurementId] of measurements.entries()) {
      const quantity = n === 0 ? '60' : '20';
      await client.query(
        `insert into machvon.measurement
           (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no, created_by, updated_by,
            submitted_by, submitted_at, decided_by, decided_at, version)
         values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $8::numeric, $9, 'APPROVED', jsonb_build_array(jsonb_build_object('document_version_id', $10::text)), $11, $12, $12, $12, now(), $13, now(), 1)`,
        [tenant, measurementId, contractId, revisionId, lines[n], items[n], period, quantity, 1, papers[0]?.id, `NK-${suffix}-${n + 1}`, MAKER, membershipOf('lifecycleActivator')],
      );
    }
  } finally {
    await client.end();
  }
  return { contractId, code, paper: papers[0]?.id ?? '', period, measurements };
}

interface AcceptanceRow {
  id: string;
  acceptance_no: string;
  status: string;
  accepted_amount_vnd: string;
  submitted_by: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  revoke_reason: string | null;
  version: string;
}

const acceptancesOf = (contractId: string) =>
  sql<AcceptanceRow>('select id, acceptance_no, status, accepted_amount_vnd::text, submitted_by, decided_by, decision_reason, revoke_reason, version::text from machvon.acceptance where contract_id = $1 order by created_at, id', [contractId]);
const linesOf = (acceptanceId: string) =>
  sql<{ measurement_id: string; quantity: string; unit_price_snapshot: string; amount_vnd: string; active: boolean; retention_pct_snapshot: string }>(
    'select measurement_id, quantity::text, unit_price_snapshot::text, amount_vnd::text, active, retention_pct_snapshot::text from machvon.acceptance_line where acceptance_id = $1 order by amount_vnd',
    [acceptanceId],
  );
const acceptedTotal = async (contractId: string) => (await sql<{ total: string }>('select accepted_total_vnd::text as total from machvon.contract where id = $1', [contractId]))[0]?.total;
const eventsOf = (acceptanceId: string, type: string) => sql<{ id: string }>('select id from machvon.outbox_event where aggregate_id = $1 and type = $2', [acceptanceId, type]);

test.describe('the acceptance of work under a contract', () => {
  test('the officer draws up and sends an acceptance, a leader approves it and payment is told once, and another person revokes it (UI-CTR-12, AC-ST-CTR-009-1, UAT-AC63, UAT-AC313)', async ({ page }) => {
    const seeded = await seed({ requiresQuality: false });
    const path = `/ctr/ctr-12?contract=${seeded.contractId}`;

    await open(page, path, 'acceptanceMaker');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.acceptance.title'] })).toBeVisible();
    await expect(page.getByTestId('contract-code')).toHaveText(seeded.code);
    await expect(page.getByTestId('contract-value')).toHaveText('1.200.000');
    await expect(page.getByTestId('contract-remaining')).toHaveText('1.200.000');
    await expect(page.getByTestId('no-acceptances')).toHaveText(vi['ctr.acceptance.list.empty']);

    // An empty form says what is missing, and nothing is sent.
    await page.getByRole('button', { name: vi['ctr.acceptance.draft.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.draft.submit'] }).click();
    await expect(page.getByText(vi['ctr.acceptance.problem.required']).first()).toBeVisible();
    await page.getByRole('button', { name: vi['ctr.acceptance.dialog.cancel'] }).click();
    expect(await acceptancesOf(seeded.contractId)).toHaveLength(0);

    // Both approved measurements are of the one period; the officer takes both. Each line keeps the price of the revision in force.
    await page.getByRole('button', { name: vi['ctr.acceptance.draft.action'] }).click();
    await page.locator('#acceptance-period').selectOption(seeded.period);
    await page.locator(`[data-measurement="${seeded.measurements[0]}"]`).check();
    await page.locator(`[data-measurement="${seeded.measurements[1]}"]`).check();
    await page.locator('#acceptance-document').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.draft.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.acceptance.done.drafted']);
    const [drafted] = await acceptancesOf(seeded.contractId);
    expect(drafted).toMatchObject({ acceptance_no: 'NT-001', status: 'DRAFT', accepted_amount_vnd: '800000', version: '1' });
    expect((await linesOf(drafted?.id ?? '')).map((line) => [line.quantity, line.unit_price_snapshot, line.amount_vnd, line.active, line.retention_pct_snapshot])).toEqual([
      ['20.000000', '10000.000000', '200000', false, '5.0000'],
      ['60.000000', '10000.000000', '600000', false, '5.0000'],
    ]);
    const line = page.locator(`tr[data-acceptance="${drafted?.id}"]`);
    await expect(line.getByTestId('amount')).toHaveText('800.000');
    await expect(line.getByTestId('lines')).toContainText('B01 · 60 M3 × 10.000 = 600.000');
    expect(await acceptedTotal(seeded.contractId)).toBe('0');

    // Sent with the people who sign the paper.
    await line.locator('[data-submit]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.submit.submit'] }).click();
    await expect(page.getByText(vi['ctr.acceptance.problem.required'])).toBeVisible();
    await page.locator('#acceptance-signers').fill('Đại diện chủ đầu tư\nGiám sát thi công');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.submit.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.acceptance.done.submitted']);
    await expect(line).toHaveAttribute('data-status', 'SUBMITTED');
    expect((await acceptancesOf(seeded.contractId))[0]).toMatchObject({ status: 'SUBMITTED', submitted_by: membershipOf('acceptanceMaker') });
    // The officer who drafted and sent it is not offered the decision.
    await expect(line.locator('[data-decide]')).toHaveCount(0);

    // A leader who did not draft it approves it: the accepted total rises, the lines count, and payment is told once.
    await open(page, path, 'acceptanceApprover');
    await page.locator(`tr[data-acceptance="${drafted?.id}"] [data-decide]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.decide.submit'] }).click();
    await expect(page.getByText(vi['ctr.acceptance.problem.required']).first()).toBeVisible();
    await page.locator('input[data-decision="approve"]').check();
    await page.locator('#acceptance-reason').fill('Đã đối chiếu với các khối lượng đã duyệt.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.decide.submit'] }).click();
    await expect(page.locator(`tr[data-acceptance="${drafted?.id}"]`)).toHaveAttribute('data-status', 'APPROVED');
    expect((await acceptancesOf(seeded.contractId))[0]).toMatchObject({ status: 'APPROVED', decided_by: membershipOf('acceptanceApprover'), decision_reason: 'Đã đối chiếu với các khối lượng đã duyệt.' });
    expect((await linesOf(drafted?.id ?? '')).every((entry) => entry.active)).toBe(true);
    expect(await acceptedTotal(seeded.contractId)).toBe('800000');
    expect(await eventsOf(drafted?.id ?? '', 'ctr.acceptance.approved.v1')).toHaveLength(1);
    await expect(page.getByTestId('contract-accepted')).toHaveText('800.000');
    await expect(page.getByTestId('contract-remaining')).toHaveText('400.000');
    // Measurements held by an approved acceptance are not offered again.
    await open(page, path, 'acceptanceMaker');
    await expect(page.getByRole('button', { name: vi['ctr.acceptance.draft.action'] })).toHaveCount(0);

    // Another person withdraws it with a reason and the paper that approves the withdrawal.
    await open(page, path, 'acceptanceRevoker');
    await page.locator(`tr[data-acceptance="${drafted?.id}"] [data-revoke]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.revoke.submit'] }).click();
    await expect(page.getByText(vi['ctr.acceptance.problem.required']).first()).toBeVisible();
    await page.locator('#acceptance-revoke-reason').fill('Khối lượng được đo lại.');
    await page.locator('#acceptance-revoke-document').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.revoke.submit'] }).click();
    const revoked = page.locator(`tr[data-acceptance="${drafted?.id}"]`);
    await expect(revoked).toHaveAttribute('data-status', 'REVOKED');
    await expect(revoked.getByTestId('revoke-reason')).toHaveText(vi['ctr.acceptance.revoked.reason'].replace('{reason}', 'Khối lượng được đo lại.'));
    expect((await acceptancesOf(seeded.contractId))[0]).toMatchObject({ status: 'REVOKED', revoke_reason: 'Khối lượng được đo lại.' });
    expect((await linesOf(drafted?.id ?? '')).every((entry) => !entry.active)).toBe(true);
    expect(await acceptedTotal(seeded.contractId)).toBe('0');
    expect(await eventsOf(drafted?.id ?? '', 'ctr.acceptance.revoked.v1')).toHaveLength(1);
  });

  test('a contract that asks for quality acceptance minutes refuses the approval in words until there are some (UI-CTR-12, AC-ST-CTR-009-2, UAT-AC313)', async ({ page }) => {
    const seeded = await seed({ requiresQuality: true });
    const path = `/ctr/ctr-12?contract=${seeded.contractId}`;
    await open(page, path, 'acceptanceMaker');
    await expect(page.getByTestId('quality-required')).toHaveText(vi['ctr.acceptance.contract.qualityRequired']);
    await page.getByRole('button', { name: vi['ctr.acceptance.draft.action'] }).click();
    await page.locator('#acceptance-period').selectOption(seeded.period);
    await page.locator(`[data-measurement="${seeded.measurements[0]}"]`).check();
    await page.locator('#acceptance-document').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.draft.submit'] }).click();
    // The row of the database is read only once the page says the draft was made: the click only sends the command, and a runner slower than a laptop reads the table before it is written.
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.acceptance.done.drafted']);
    const [drafted] = await acceptancesOf(seeded.contractId);
    const line = page.locator(`tr[data-acceptance="${drafted?.id}"]`);
    await expect(line.getByTestId('quality')).toHaveText(vi['ctr.acceptance.quality.missing']);
    await line.locator('[data-submit]').click();
    await page.locator('#acceptance-signers').fill('Giám sát thi công');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.submit.submit'] }).click();
    await expect(line).toHaveAttribute('data-status', 'SUBMITTED');

    await open(page, path, 'acceptanceApprover');
    await page.locator(`tr[data-acceptance="${drafted?.id}"] [data-decide]`).click();
    await page.locator('input[data-decision="approve"]').check();
    await page.locator('#acceptance-reason').fill('Duyệt.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.decide.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ctr.acceptance.error.qualityRequired']);
    expect((await acceptancesOf(seeded.contractId))[0]?.status).toBe('SUBMITTED');
    expect(await acceptedTotal(seeded.contractId)).toBe('0');
    expect(await eventsOf(drafted?.id ?? '', 'ctr.acceptance.approved.v1')).toHaveLength(0);
  });

  test('a reader sees the acceptances and no command (UI-CTR-12)', async ({ page }) => {
    const seeded = await seed({ requiresQuality: false });
    await open(page, `/ctr/ctr-12?contract=${seeded.contractId}`, 'acceptanceMaker');
    await page.getByRole('button', { name: vi['ctr.acceptance.draft.action'] }).click();
    await page.locator('#acceptance-period').selectOption(seeded.period);
    await page.locator(`[data-measurement="${seeded.measurements[1]}"]`).check();
    await page.locator('#acceptance-document').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.acceptance.draft.submit'] }).click();
    await expect(page.getByTestId('acceptances')).toBeVisible();

    await open(page, `/ctr/ctr-12?contract=${seeded.contractId}`, 'acceptanceViewer');
    await expect(page.getByTestId('acceptances')).toBeVisible();
    await expect(page.locator('button[data-submit], button[data-decide], button[data-revoke]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['ctr.acceptance.draft.action'] })).toHaveCount(0);
  });
});
