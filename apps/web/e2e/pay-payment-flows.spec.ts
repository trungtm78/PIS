import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PAY-01, PAY-02, PAY-03 and CTR-13 (the payment request) in a real browser against the real API and database (apps/api/test/e2e-stack): the accountant draws a request up from an approved acceptance
 * of a contract (the server works out gross, recovery, retention and net, and the form does not ask for them), reads it, gives it an invoice, meets the refusal of a duplicate invoice number, an
 * approver who did not draw it up lets it through with a reason, the table of CTR-13 shows how the amount is made up, and a draft is cancelled. A reader sees the list and the detail and no command.
 * What the screens changed is looked up in the database.
 */

const OWNER = membershipOf('owner');
let counter = 0;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface Seeded {
  contractId: string;
  code: string;
  acceptanceId: string;
  line: string;
  paper: string;
}

/**
 * A project of the Project Management Board with a published line of capital of the year 2099 (so the payment is open whenever the test runs) and a contract being performed under it: B01 and B02, a
 * sole party whose work is worth 10bn with an advance of 2bn paid, and an approved acceptance of 2bn of B01 and 1bn of B02. Written straight to the database (foreign keys and the guards of modules that
 * are not seeded are switched off).
 */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const [projectId, capitalPlan, version, line, balance, appropriation, contractId, revisionId, partyId, acceptanceId] = Array.from({ length: 10 }, () => randomUUID()) as [string, string, string, string, string, string, string, string, string, string];
  const items = [randomUUID(), randomUUID()];
  const lines = [randomUUID(), randomUUID()];
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const code = `HD-TT-${suffix}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenant]);
  const [fund] = await sql<{ id: string }>(
    "select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where v.tenant_id = $1 and v.master_type = 'FUND_SOURCE' and r.business_key = 'NSTW' and v.status = 'EFFECTIVE' limit 1",
    [tenant],
  );
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const papers = await sql<{ id: string; document_id: string }>("select id, document_id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  const unit = stackInfo().units.A['CB-SKHDT-QLDA'] as string;
  const planUnit = stackInfo().units.A['CB-STC'] as string;
  if (area === undefined || fund === undefined || contractor === undefined || papers.length < 1) throw new Error('the fixtures of the stack are missing');
  const paper = papers[0]!;
  // One decision line is registered once: each seed takes a combination of origin and level of its own.
  const origin = ['PM_ASSIGNED', 'LOCAL_ADDED', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE'][counter % 4]!;
  const level = counter % 8 < 4 ? 'CENTRAL' : 'LOCAL';
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
      [tenant, projectId, `E2E-PAY-${suffix}`, `Cầu thanh toán ${counter}`, unit, area.id, String(1000000 + Math.floor(Math.random() * 8999999)), OWNER],
    );
    await client.query(
      `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
       values ($1, $2, $3, 'ANNUAL', 2099, 2099, 2099, $4, 1, 'PUBLISHED', $5, now(), $6, $6)`,
      [tenant, capitalPlan, `E2E-PAY-CAP-${suffix}`, planUnit, paper.document_id, OWNER],
    );
    await client.query(
      `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id, created_by, updated_by)
       values ($1, $2, $3, 2099, 1, $4, 'PUBLISHED', now(), $5, $6, $6)`,
      [tenant, version, projectId, paper.document_id, capitalPlan, OWNER],
    );
    await client.query(
      `insert into machvon.appropriation (tenant_id, id, capital_plan_id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision,
                                          status, approved_by, created_by, updated_by, version)
       values ($1, $2, $3, $4, 2099, $8, $9, 30000000000, 30000000000, $5, 'Thủ tướng Chính phủ', 2099, 1, 'PUBLISHED', $6, $7, $7, 1)`,
      [tenant, appropriation, capitalPlan, fund.id, paper.document_id, membershipOf('lifecycleActivator'), OWNER, origin, level],
    );
    await client.query(
      `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, appropriation_id, budget_level, origin, created_by, updated_by)
       values ($1, $2, $3, $4, 'CURRENT_YEAR', 2099, 30000000000, 0, $5, $6, $8, $9, $7, $7)`,
      [tenant, line, version, fund.id, projectId, appropriation, OWNER, level, origin],
    );
    await client.query(`insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd) values ($1, $2, $3, 30000000000)`, [tenant, balance, line]);
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, accepted_total_vnd,
                                     created_by, updated_by, submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử đề nghị thanh toán', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 9000000000::numeric, 9000000000::numeric, 3000000000::numeric, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, projectId, randomUUID(), contractor.id, code, OWNER, membershipOf('lifecycleReviewer'), paper.id, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 9000000000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, paper.id, OWNER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    await client.query(
      `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
       values ($1, $2, $3, $4, 'SOLE', 100, 10000000000, 'ACTIVE', date '2026-01-03', $5, $5)`,
      [tenant, partyId, contractId, contractor.id, OWNER],
    );
    await client.query(
      `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, $3, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2099-12-31', $4, $4)`,
      [tenant, contractId, partyId, OWNER],
    );
    const amounts = ['2000000000', '1000000000'];
    const quantities = ['2000', '500'];
    const prices = ['1000000', '2000000'];
    for (const [n, key] of ['B01', 'B02'].entries()) {
      await client.query(`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, $5, $6, 'M3', $4, $4)`, [tenant, items[n], contractId, OWNER, key, `Hạng mục ${key}`]);
      await client.query(
        `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
         values ($1, $2, $3, $4, $5, $7, $6, $8, 'M3', $9::numeric * 4, $10::numeric, 'HALF_UP', $11::numeric * 4, 5, $12)`,
        [tenant, lines[n], revisionId, contractId, items[n], key, n + 1, `Hạng mục ${key}`, quantities[n], prices[n], amounts[n], OWNER],
      );
    }
    await client.query(
      `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, signer_refs, status, version, acceptance_no, accepted_amount_vnd, accepted_on, created_by, updated_by,
                                       submitted_by, submitted_at, approved_at, decided_by, decision_reason)
       values ($1, $2, $3, jsonb_build_array(gen_random_uuid()::text, gen_random_uuid()::text), $4, '[]'::jsonb, 'APPROVED', 3, $5, 3000000000, date '2026-07-25', $6, $6, $6, now(), now(), $7, 'Checked.')`,
      [tenant, acceptanceId, contractId, paper.id, `NT-${suffix}`, OWNER, membershipOf('lifecycleActivator')],
    );
    for (const [n, measurement] of [randomUUID(), randomUUID()].entries()) {
      await client.query(
        `insert into machvon.acceptance_line (tenant_id, id, acceptance_id, measurement_id, boq_item_id, contract_revision_id, quantity, unit_price_snapshot, amount_vnd, retention_pct_snapshot, active, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, 5, true, $9, $9)`,
        [tenant, acceptanceId, measurement, items[n], revisionId, quantities[n], prices[n], amounts[n], OWNER],
      );
    }
  } finally {
    await client.end();
  }
  return { contractId, code, acceptanceId, line, paper: paper.id };
}

interface RequestRow {
  id: string;
  request_no: string;
  status: string;
  version: string;
  gross_vnd: string;
  advance_recovery_vnd: string;
  retention_vnd: string;
  tax_adjustment_vnd: string;
  net_vnd: string;
  plan_year: number;
  cancel_reason: string | null;
}

const requestsOf = (contractId: string) =>
  sql<RequestRow>(
    `select id, request_no, status, version::text, gross_vnd::text, advance_recovery_vnd::text, retention_vnd::text, tax_adjustment_vnd::text, net_vnd::text, plan_year, cancel_reason
       from machvon.payment_request where contract_id = $1 order by created_at, id`,
    [contractId],
  );
const documentsOf = (requestId: string) =>
  sql<{ doc_kind: string; invoice_no: string | null; duplicate_override_reason: string | null; duplicate_override_by: string | null }>(
    'select doc_kind, invoice_no, duplicate_override_reason, duplicate_override_by from machvon.payment_document where payment_request_id = $1 order by created_at, id',
    [requestId],
  );
const eventsOf = (requestId: string, type: string) => sql<{ id: string }>('select id from machvon.outbox_event where aggregate_id = $1 and type = $2', [requestId, type]);
const auditsOf = (requestId: string, action: string) => sql<{ actor_id: string }>('select actor_id from machvon.audit_event where resource_id = $1 and action = $2', [requestId, action]);

/** Draws a request up in the form (PAY-02) and gives back the page with the result open. */
async function draw(page: Page, seeded: Seeded, number: string, tax?: { amount: string; basis: string }): Promise<void> {
  await open(page, `/pay/pay-02?contract=${seeded.contractId}`, 'paymentAccountant');
  await expect(page.getByRole('heading', { level: 1, name: vi['pay.payment.create.title'] })).toBeVisible();
  await expect(page.locator('#payment-acceptance option')).toHaveCount(2);
  await page.locator('#payment-acceptance').selectOption(seeded.acceptanceId);
  await expect(page.locator('#payment-line option')).toHaveCount(2);
  await page.locator('#payment-line').selectOption(seeded.line);
  await page.locator('#payment-no').fill(number);
  if (tax !== undefined) {
    await page.locator('#payment-tax').fill(tax.amount);
    await page.locator('#payment-tax-basis').fill(tax.basis);
  }
  await page.getByRole('button', { name: vi['pay.payment.create.submit'] }).click();
  await page.getByTestId('result').or(page.getByTestId('refusal')).waitFor();
  // A refusal is told in words, so the test says which one rather than that the result was missing.
  if ((await page.getByTestId('refusal').count()) > 0) throw new Error(`the form was refused: ${await page.getByTestId('refusal').textContent()}`);
  await expect(page.getByTestId('result')).toBeVisible();
}

test.describe('the payment request', () => {
  test('the accountant draws a request up, gives it an invoice, meets a duplicate invoice, an approver lets it through, and the valuation shows how the amount is made up (UI-PAY-01, UI-PAY-02, UI-PAY-03, UI-CTR-13, AC-ST-PAY-002-1, AC-ST-PAY-002-4, UAT-AC323, UAT-AC60)', async ({ page }) => {
    const seeded = await seed();
    const first = `DNTT-E2E-${Date.now().toString(36).toUpperCase()}-${counter}`;

    // The form does not ask for any amount the server works out; the server's figures are shown once the request is drawn up.
    await open(page, `/pay/pay-02?contract=${seeded.contractId}`, 'paymentAccountant');
    await expect(page.getByText(vi['pay.payment.create.serverNumbers'])).toBeVisible();
    await expect(page.locator('[id*="gross"], [id*="net"], [id*="retention"], [id*="recovery"]')).toHaveCount(0);
    await draw(page, seeded, first, { amount: '-1000000', basis: 'Thông báo thuế 12/TB' });
    await expect(page.getByTestId('result-gross')).toHaveText('3.000.000.000');
    await expect(page.getByTestId('result-recovery')).toHaveText('750.000.000');
    await expect(page.getByTestId('result-retention')).toHaveText('150.000.000');
    await expect(page.getByTestId('result-tax')).toHaveText('-1.000.000');
    await expect(page.getByTestId('result-net')).toHaveText('2.099.000.000');

    const [made] = await requestsOf(seeded.contractId);
    expect(made).toMatchObject({ request_no: first, status: 'DRAFT', version: '1', gross_vnd: '3000000000', advance_recovery_vnd: '750000000', retention_vnd: '150000000', tax_adjustment_vnd: '-1000000', net_vnd: '2099000000', plan_year: 2099 });
    expect(await eventsOf(made!.id, 'pay.payment_request.drafted.v1')).toHaveLength(1);
    expect(await auditsOf(made!.id, 'payment_request.drafted')).toEqual([{ actor_id: membershipOf('paymentAccountant') }]);

    // The list and the detail show the request; the detail has the commands for a draft.
    await page.getByTestId('open-request').click();
    await expect(page.getByTestId('request-no')).toHaveText(first);
    await expect(page.getByTestId('gross')).toHaveText('3.000.000.000');
    await expect(page.getByTestId('net')).toHaveText('2.099.000.000');
    await expect(page.getByTestId('tax-basis')).toHaveText('Thông báo thuế 12/TB');
    await expect(page.getByTestId('no-documents')).toHaveText(vi['pay.payment.documents.empty']);

    // An invoice is attached: its number and date are asked for; a second draft of the acceptance meets the duplicate.
    const invoiceNo = `HD-E2E-${Date.now().toString(36).toUpperCase()}`;
    await page.locator('button[data-action="attach"]').click();
    await page.locator('#attach-kind').selectOption('INVOICE');
    await page.locator('#attach-document').fill(seeded.paper);
    await page.locator('#attach-invoice-no').fill(invoiceNo);
    await page.locator('#attach-invoice-date').fill('2026-07-01');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.attach.submit'] }).click();
    await expect(page.getByTestId('done')).toContainText(vi['pay.payment.done.attached']);
    await expect(page.getByTestId('doc-invoice')).toContainText(invoiceNo);
    expect(await documentsOf(made!.id)).toEqual([{ doc_kind: 'INVOICE', invoice_no: invoiceNo, duplicate_override_reason: null, duplicate_override_by: null }]);

    const second = `${first}-2`;
    await draw(page, seeded, second);
    await expect(page.getByTestId('warnings')).toContainText(vi['pay.payment.warning.otherDrafts']);
    await page.getByTestId('open-request').click();
    await expect(page.getByTestId('other-drafts')).toBeVisible();
    await page.locator('button[data-action="attach"]').click();
    await page.locator('#attach-kind').selectOption('INVOICE');
    await page.locator('#attach-document').fill(seeded.paper);
    await page.locator('#attach-invoice-no').fill(invoiceNo);
    await page.locator('#attach-invoice-date').fill('2026-07-01');
    // The accountant who drew the request up is not offered the exception.
    await expect(page.locator('#attach-override')).toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.attach.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['pay.payment.error.invoiceDuplicate']);
    const [, other] = await requestsOf(seeded.contractId);
    expect(await documentsOf(other!.id)).toEqual([]);

    // The approver, who did not draw it up, lets the number through with a reason.
    await open(page, `/pay/pay-03?request=${other!.id}`, 'paymentApprover');
    await expect(page.locator('button[data-action="revise"]')).toHaveCount(0);
    await page.locator('button[data-action="attach"]').click();
    await page.locator('#attach-kind').selectOption('INVOICE');
    await page.locator('#attach-document').fill(seeded.paper);
    await page.locator('#attach-invoice-no').fill(invoiceNo);
    await page.locator('#attach-invoice-date').fill('2026-07-01');
    await page.locator('#attach-override').fill('Hóa đơn điều chỉnh theo thông báo 12/TB');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.attach.submit'] }).click();
    await expect(page.getByTestId('done')).toContainText(vi['pay.payment.done.attached']);
    await expect(page.getByTestId('doc-override')).toHaveText('Hóa đơn điều chỉnh theo thông báo 12/TB');
    expect(await documentsOf(other!.id)).toEqual([{ doc_kind: 'INVOICE', invoice_no: invoiceNo, duplicate_override_reason: 'Hóa đơn điều chỉnh theo thông báo 12/TB', duplicate_override_by: membershipOf('paymentApprover') }]);

    // CTR-13 shows how the amount of the first request is made up, line by line.
    await open(page, `/ctr/ctr-13?request=${made!.id}`, 'paymentReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.valuation.title'] })).toBeVisible();
    const lines = page.locator('tr[data-line]');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0).getByTestId('item')).toHaveText('B01');
    await expect(lines.nth(0).getByTestId('quantity')).toHaveText('2.000 M3');
    await expect(lines.nth(0).getByTestId('gross')).toHaveText('2.000.000.000');
    await expect(lines.nth(0).getByTestId('recovery')).toHaveText('500.000.000');
    await expect(lines.nth(0).getByTestId('retention')).toHaveText('100.000.000');
    await expect(lines.nth(0).getByTestId('net')).toHaveText('1.400.000.000');
    await expect(lines.nth(1).getByTestId('net')).toHaveText('700.000.000');
    await expect(page.getByTestId('total-gross')).toHaveText('3.000.000.000');
    await expect(page.getByTestId('total-tax')).toHaveText('-1.000.000');
    await expect(page.getByTestId('total-net')).toHaveText('2.099.000.000');

    // The accountant cancels the second draft with a reason; the list shows both.
    await open(page, `/pay/pay-03?request=${other!.id}`, 'paymentAccountant');
    await page.locator('button[data-action="cancel"]').click();
    await page.locator('#cancel-reason').fill('Lập trùng với đề nghị trước.');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.cancel.submit'] }).click();
    await expect(page.getByTestId('done')).toContainText(vi['pay.payment.done.cancelled']);
    await expect(page.getByTestId('status')).toHaveText(vi['pay.payment.status.cancelled']);
    expect((await requestsOf(seeded.contractId)).map((row) => [row.request_no, row.status])).toEqual([
      [first, 'DRAFT'],
      [second, 'CANCELLED'],
    ]);
    await open(page, `/pay/pay-01?contract=${seeded.contractId}`, 'paymentAccountant');
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await page.getByTestId('filter-status').selectOption('CANCELLED');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByTestId('net')).toHaveText('2.100.000.000');
  });

  test('a reader sees the requests and their detail and no command; a person without the right to draw up is told so (UI-PAY-01)', async ({ page }) => {
    const seeded = await seed();
    await draw(page, seeded, `DNTT-E2E-R-${Date.now().toString(36).toUpperCase()}-${counter}`);
    const [made] = await requestsOf(seeded.contractId);

    await open(page, `/pay/pay-01?contract=${seeded.contractId}`, 'paymentReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['pay.payment.list.title'] })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByTestId('create')).toHaveCount(0);
    await page.getByTestId('open').click();
    await expect(page.getByTestId('net')).toHaveText('2.100.000.000');
    await expect(page.locator('button[data-action]')).toHaveCount(0);
    await expect(page.getByTestId('valuation')).toBeVisible();
    await open(page, `/pay/pay-02?contract=${seeded.contractId}`, 'paymentReader');
    await expect(page.getByTestId('no-right')).toHaveText(vi['pay.payment.create.noRight']);
    expect(made?.status).toBe('DRAFT');
  });
});
