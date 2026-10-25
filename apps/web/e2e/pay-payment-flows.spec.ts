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
    const packageId = randomUUID();
    await client.query(
      `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
       values ($1, $2, $3, $4, 9000000000, 'OPEN_BIDDING', 1, 'APPROVED', $5, $6, 1)`,
      [tenant, packageId, projectId, `GT-TT-${suffix}`, `Gói thầu thanh toán ${counter}`, OWNER],
    );
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, accepted_total_vnd,
                                     created_by, updated_by, submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử đề nghị thanh toán', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 9000000000::numeric, 9000000000::numeric, 3000000000::numeric, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, projectId, packageId, contractor.id, code, OWNER, membershipOf('lifecycleReviewer'), paper.id, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 9000000000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, paper.id, OWNER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2, advance_paid_vnd = 2000000000 where id = $1`, [contractId, revisionId]);
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

/** Gives a draft its invoice in the dialog of PAY-03. */
async function attachInvoice(page: Page, seeded: Seeded, invoiceNo: string): Promise<void> {
  await page.locator('button[data-action="attach"]').click();
  await page.locator('#attach-kind').selectOption('INVOICE');
  await page.locator('#attach-document').fill(seeded.paper);
  await page.locator('#attach-invoice-no').fill(invoiceNo);
  await page.locator('#attach-invoice-date').fill('2026-07-01');
  await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.attach.submit'] }).click();
  await expect(page.getByTestId('done')).toContainText(vi['pay.payment.done.attached']);
}

const ledgerOf = (contractId: string) =>
  sql<{ requested: string; entries: string }>('select coalesce(sum(requested_vnd), 0)::text as requested, (select count(*)::text from machvon.cumulative_ledger_entry where contract_id = $1) as entries from machvon.cumulative_ledger where contract_id = $1', [contractId]);

/** Four confirmed templates of the Treasury forms, on a layout profile that is confirmed, for the tenant of the stack (once). The platform ships none of them: they await the appendix of the decree (CXN-08). */
async function treasuryTemplates(): Promise<void> {
  const tenant = stackInfo().tenants.A;
  const [have] = await sql<{ count: string }>("select count(*)::text as count from machvon.document_template where tenant_id = $1 and template_code like 'E2E-PAY-FORM-%'", [tenant]);
  if (have?.count === '4') return;
  const [profile] = await sql<{ id: string }>("select id from machvon.document_layout_profile where tenant_id = $1 and profile_code = 'E2E-PAY-FORMS'", [tenant]);
  let profileId = profile?.id;
  if (profileId === undefined) {
    const [created] = await sql<{ id: string }>(
      `insert into machvon.document_layout_profile
         select (jsonb_populate_record(null::machvon.document_layout_profile, to_jsonb(p) || jsonb_build_object('id', gen_random_uuid(), 'profile_code', 'E2E-PAY-FORMS', 'confirmation_status', 'CONFIRMED', 'legal_confirmation_ref', 'CXN-DOC-01'))).*
           from machvon.document_layout_profile p where p.tenant_id = $1 and p.status = 'PUBLISHED' order by p.created_at limit 1
         returning id`,
      [tenant],
    );
    profileId = created?.id;
  }
  if (profileId === undefined) throw new Error('the layout profile of the stack is missing');
  for (const code of ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']) {
    await sql(
      `insert into machvon.document_template
         (tenant_id, id, template_code, revision, group_code, doc_type_code, form_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, confirmation_status, legal_confirmation_ref, legal_confirmed_by,
          legal_confirmed_at, origin, content_sha256, effective_from, status, approved_by, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, 1, 'OTHER', 'QD', $3, $4, $5::uuid, '[{"kind":"paragraph","text":"Hợp đồng {{contract_code}}: đề nghị thanh toán {{net_text}} đồng."}]'::jsonb, '{"required":["contract_code","net_text"]}'::jsonb,
               'Nghị định 254/2025/NĐ-CP, phụ lục (mẫu thử)', 'CONFIRMED', 'CXN-08', $6, now(), 'PLATFORM_PACK', repeat('e', 64), date '2026-01-01', 'PUBLISHED', $6, $7, $7)`,
      [tenant, `E2E-PAY-FORM-${code.replace(/\W/g, '')}`, code, `Giấy đề nghị thanh toán ${code}`, profileId, membershipOf('lifecycleActivator'), OWNER],
    );
  }
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

  test('the accountant sends a request, another request for the same acceptance is turned away, the approver checks it and gives it back, and the ledger follows (UI-PAY-03, AC-ST-PAY-003-1, AC-ST-PAY-003-3, AC-ST-PAY-003-5, UAT-AC320, UAT-AC322, UAT-AC332)', async ({ page }) => {
    const seeded = await seed();
    const stamp = `${Date.now().toString(36).toUpperCase()}-${counter}`;
    await draw(page, seeded, `DNTT-E2E-S-${stamp}`);
    await page.getByTestId('open-request').click();
    await attachInvoice(page, seeded, `HD-E2E-S-${stamp}`);
    // A second draft of the same acceptance is allowed while neither has been sent.
    await draw(page, seeded, `DNTT-E2E-S2-${stamp}`);
    await page.getByTestId('open-request').click();
    await attachInvoice(page, seeded, `HD-E2E-S2-${stamp}`);
    const [firstDraft, secondDraft] = await requestsOf(seeded.contractId);
    await open(page, `/pay/pay-03?request=${firstDraft!.id}`, 'paymentAccountant');

    // Sending shows what the request is worth and what sending does, then holds the acceptance and puts the amounts on the ledger of the contract.
    await page.locator('button[data-action="submit"]').click();
    await expect(page.getByTestId('submit-intro')).toHaveText(vi['pay.payment.submit.intro'].replace('{gross}', '3.000.000.000').replace('{net}', '2.100.000.000'));
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.submit.submit'] }).click();
    await expect(page.getByTestId('done')).toContainText(vi['pay.payment.done.submitted']);
    await expect(page.getByTestId('status')).toHaveText(vi['pay.payment.status.submitted']);
    const sent = firstDraft;
    expect((await requestsOf(seeded.contractId))[0]).toMatchObject({ status: 'SUBMITTED' });
    expect(await sql<{ claims_acceptance: boolean }>('select claims_acceptance from machvon.payment_request where id = $1', [sent!.id])).toEqual([{ claims_acceptance: true }]);
    expect((await ledgerOf(seeded.contractId))[0]).toMatchObject({ requested: '3000000000' });
    expect(await eventsOf(sent!.id, 'pay.payment_request.submitted.v1')).toHaveLength(1);
    expect(await auditsOf(sent!.id, 'payment_request.submitted')).toEqual([{ actor_id: membershipOf('paymentAccountant') }]);
    // The one who sent it has no button left for it, and cannot check it.
    await expect(page.locator('button[data-action="submit"]')).toHaveCount(0);
    await expect(page.locator('button[data-action="verify"]')).toHaveCount(0);

    // A second request for the same acceptance is turned away in words, and leaves nothing on the ledger.
    await open(page, `/pay/pay-03?request=${secondDraft!.id}`, 'paymentAccountant');
    await page.locator('button[data-action="submit"]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.submit.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['pay.payment.error.claimed']);
    expect((await ledgerOf(seeded.contractId))[0]).toMatchObject({ requested: '3000000000' });

    // The approver checks the first request with a note, then gives it back with a reason; the acceptance, the retention and the recovery are released.
    await open(page, `/pay/pay-03?request=${sent!.id}`, 'paymentApprover');
    await page.locator('button[data-action="verify"]').click();
    await page.locator('#verify-note').fill('Hồ sơ đầy đủ.');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.verify.submit'] }).click();
    await expect(page.getByTestId('done')).toContainText(vi['pay.payment.done.verified']);
    await expect(page.getByTestId('status')).toHaveText(vi['pay.payment.status.verified']);
    await expect(page.getByTestId('verification-note')).toHaveText('Hồ sơ đầy đủ.');
    await page.locator('button[data-action="return"]').click();
    await page.locator('#return-reason').fill('Hóa đơn không khớp với nghiệm thu.');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.return.submit'] }).click();
    await expect(page.getByTestId('done')).toContainText(vi['pay.payment.done.returned']);
    await expect(page.getByTestId('status')).toHaveText(vi['pay.payment.status.returned']);
    await expect(page.getByTestId('return-reason')).toHaveText('Hóa đơn không khớp với nghiệm thu.');
    expect(await sql<{ status: string; claims_acceptance: boolean; verified_by: string }>('select status, claims_acceptance, verified_by from machvon.payment_request where id = $1', [sent!.id])).toEqual([
      { status: 'RETURNED', claims_acceptance: false, verified_by: membershipOf('paymentApprover') },
    ]);
    expect((await ledgerOf(seeded.contractId))[0]).toMatchObject({ requested: '0' });
    expect(await auditsOf(sent!.id, 'payment_request.verified')).toEqual([{ actor_id: membershipOf('paymentApprover') }]);
    expect(await auditsOf(sent!.id, 'payment_request.returned')).toEqual([{ actor_id: membershipOf('paymentApprover') }]);
  });

  test('the accountant draws the four Treasury forms of a checked request, follows it on the board and records the day and the number the file was sent (UI-PAY-04, UI-PAY-14, AC-ST-PAY-005-1, AC-ST-PAY-005-2, UAT-AC337)', async ({ page }) => {
    await treasuryTemplates();
    const seeded = await seed();
    const stamp = `${Date.now().toString(36).toUpperCase()}-${counter}`;
    await draw(page, seeded, `DNTT-E2E-F-${stamp}`);
    await page.getByTestId('open-request').click();
    await attachInvoice(page, seeded, `HD-E2E-F-${stamp}`);
    await page.locator('button[data-action="submit"]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.submit.submit'] }).click();
    await expect(page.getByTestId('done')).toContainText(vi['pay.payment.done.submitted']);
    const [made] = await requestsOf(seeded.contractId);
    await open(page, `/pay/pay-03?request=${made!.id}`, 'paymentApprover');
    await page.locator('button[data-action="verify"]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.verify.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['pay.payment.status.verified']);

    // The board shows the request waiting for its forms; the forms are drawn from the confirmed templates, with the place the accountant writes.
    await open(page, '/pay/pay-04', 'paymentAccountant');
    const row = page.locator(`tr[data-request="${made!.id}"]`);
    await expect(row.getByTestId('forms')).toHaveText(vi['pay.board.forms'].replace('{count}', '0').replace('{total}', '4'));
    await row.getByTestId('open').click();
    await expect(page.getByRole('heading', { level: 1, name: vi['pay.forms.title'] })).toBeVisible();
    await expect(page.getByTestId('missing')).toHaveText(vi['pay.forms.missing'].replace('{forms}', '03.a/TT, 04.a/TT, 04.b/TT, 05.a/TT'));
    await expect(page.locator('button[data-action="send"]')).toHaveCount(0);
    await page.locator('button[data-action="generate-all"]').click();
    await page.locator('#generate-place').fill('Cao Bằng');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.forms.generate.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.forms.done.generated']);
    for (const code of ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']) {
      const form = page.locator(`tr[data-form="${code}"]`);
      await expect(form).toHaveAttribute('data-state', 'standing');
      await expect(form.getByTestId('basis')).toContainText('254/2025');
      await expect(form.getByTestId('hash')).toHaveText(/^[0-9a-f]{16}$/);
    }
    const stored = await sql<{ form_code: string; status: string; file_sha256: string; version_checksum: string; mime: string }>(
      `select f.form_code, f.status, f.file_sha256, v.checksum as version_checksum, v.mime from machvon.payment_form_instance f join machvon.document_version v on v.id = f.document_version_id where f.payment_request_id = $1 order by f.form_code`,
      [made!.id],
    );
    expect(stored.map((form) => [form.form_code, form.status, form.mime])).toEqual([
      ['03.a/TT', 'GENERATED', 'application/pdf'],
      ['04.a/TT', 'GENERATED', 'application/pdf'],
      ['04.b/TT', 'GENERATED', 'application/pdf'],
      ['05.a/TT', 'GENERATED', 'application/pdf'],
    ]);
    expect(stored.every((form) => form.file_sha256 === form.version_checksum)).toBe(true);
    expect(await eventsOf(made!.id, 'pay.payment_form.generated.v1')).toHaveLength(1);

    // One form drawn again replaces the one before: the old one is kept as superseded.
    await page.locator('tr[data-form="03.a/TT"] button[data-action="generate"]').click();
    await page.locator('#generate-place').fill('Cao Bằng');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.forms.generate.submit'] }).click();
    await expect(page.getByTestId('history')).toContainText(vi['pay.forms.status.superseded']);
    expect((await sql<{ status: string }>("select status from machvon.payment_form_instance where payment_request_id = $1 and form_code = '03.a/TT' order by created_at", [made!.id])).map((form) => form.status)).toEqual(['SUPERSEDED', 'GENERATED']);

    // The file goes to the Treasury by hand; the day and the number are recorded.
    await page.locator('button[data-action="send"]').click();
    await page.locator('#send-day').fill('2026-07-24');
    await page.locator('#send-ref').fill('KB-2026-0001');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.forms.send.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.forms.done.sent']);
    await expect(page.getByTestId('status')).toHaveText(vi['pay.payment.status.sentTreasury']);
    await expect(page.getByTestId('sent-on')).toHaveText('2026-07-24');
    await expect(page.getByTestId('ref')).toHaveText('KB-2026-0001');
    expect(await sql<{ status: string; treasury_ref: string; treasury_sent_by: string }>('select status, treasury_ref, treasury_sent_by from machvon.payment_request where id = $1', [made!.id])).toEqual([
      { status: 'SENT_TREASURY', treasury_ref: 'KB-2026-0001', treasury_sent_by: membershipOf('paymentAccountant') },
    ]);
    expect(await auditsOf(made!.id, 'payment_request.sent_treasury')).toEqual([{ actor_id: membershipOf('paymentAccountant') }]);
    expect(await eventsOf(made!.id, 'pay.payment_request.sent_treasury.v1')).toHaveLength(1);

    await open(page, '/pay/pay-04', 'paymentReader');
    await expect(page.locator(`tr[data-request="${made!.id}"]`).getByTestId('ref')).toHaveText('KB-2026-0001');
    await page.locator(`tr[data-request="${made!.id}"]`).getByTestId('open').click();
    await expect(page.locator('button[data-action]')).toHaveCount(0);
  });

  test('the reconciler matches a transaction that differs and an explained difference is written off by a second person, then matches the one that agrees and the request is settled (UI-PAY-05, UI-PAY-06, UI-PAY-09, AC-ST-PAY-007-1, AC-ST-PAY-007-2, AC-ST-PAY-007-3, UAT-AC335, UAT-AC12, UAT-AC336)', async ({ page }) => {
    await treasuryTemplates();
    const seeded = await seed();
    const stamp = `${Date.now().toString(36).toUpperCase()}-${counter}`;
    await draw(page, seeded, `DNTT-E2E-R-${stamp}`);
    await page.getByTestId('open-request').click();
    await attachInvoice(page, seeded, `HD-E2E-R-${stamp}`);
    await page.locator('button[data-action="submit"]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.submit.submit'] }).click();
    await expect(page.getByTestId('done')).toContainText(vi['pay.payment.done.submitted']);
    const [made] = await requestsOf(seeded.contractId);
    await open(page, `/pay/pay-03?request=${made!.id}`, 'paymentApprover');
    await page.locator('button[data-action="verify"]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.payment.verify.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['pay.payment.status.verified']);
    await open(page, `/pay/pay-14?request=${made!.id}`, 'paymentAccountant');
    await page.locator('button[data-action="generate-all"]').click();
    await page.locator('#generate-place').fill('Cao Bằng');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.forms.generate.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.forms.done.generated']);
    await page.locator('button[data-action="send"]').click();
    await page.locator('#send-day').fill('2026-07-24');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.forms.send.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['pay.payment.status.sentTreasury']);

    // The Treasury confirmed two payments: one that is 10m short of the net of the request (2.1bn) and one that is the net.
    const [project] = await sql<{ project_id: string }>('select project_id from machvon.contract where id = $1', [seeded.contractId]);
    const transaction = async (key: string, amount: string): Promise<string> => {
      const [row] = await sql<{ id: string }>(
        `insert into machvon.treasury_transaction
           (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction, document_no, document_date, source_kind, provider_event_id, match_status)
         values ($1, gen_random_uuid(), $2, $3, 'MOCKKB', $4::numeric, timestamptz '2026-07-24T18:30:00Z', repeat('a', 64), repeat('a', 64), 'PAYMENT', $3, date '2026-07-24', 'CALLBACK_MOCK', $3, 'UNMATCHED') returning id`,
        [stackInfo().tenants.A, project!.project_id, key, amount],
      );
      return row!.id;
    };
    const short = await transaction(`CT-E2E-${stamp}-A`, '2090000000');
    const exact = await transaction(`CT-E2E-${stamp}-B`, '2100000000');

    // UAT-AC12: matched to the request, the short transaction does not settle it; the dialog shows both figures and leads to the difference that was opened.
    await open(page, '/pay/pay-05', 'reconciler');
    await expect(page.getByRole('heading', { level: 1, name: vi['pay.recon.title'] })).toBeVisible();
    await page.locator(`tr[data-transaction="${short}"] button[data-action="match"]`).click();
    await page.locator('#match-request').selectOption(made!.id);
    await expect(page.getByTestId('match-agree')).toHaveAttribute('data-agree', 'no');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.recon.match.submit'] }).click();
    await expect(page.getByTestId('mismatch')).toContainText(
      vi['pay.recon.match.mismatch'].replace('{internal}', '2.100.000.000').replace('{confirmed}', '2.090.000.000').replace('{difference}', '-10.000.000'),
    );
    expect((await sql<{ status: string }>('select status from machvon.payment_request where id = $1', [made!.id]))[0]?.status).toBe('SENT_TREASURY');
    const [opened] = await sql<{ id: string; internal: string; confirmed: string; difference: string; owner: string; status: string }>(
      'select id, internal_amount_vnd::text as internal, confirmed_amount_vnd::text as confirmed, difference_vnd::text as difference, owner_membership_id as owner, status from machvon.reconciliation_item where treasury_transaction_id = $1',
      [short],
    );
    expect(opened).toMatchObject({ internal: '2100000000', confirmed: '2090000000', difference: '-10000000', owner: membershipOf('reconciler'), status: 'OPEN' });
    await page.getByTestId('mismatch-item').click();

    // UAT-AC336: the reconciler gives it to its owner with a day; the owner explains it; the owner may not write it off, a second person may.
    await expect(page.getByRole('heading', { level: 1, name: vi['pay.item.title'] })).toBeVisible();
    await expect(page.getByTestId('internal')).toHaveText('2.100.000.000');
    await expect(page.getByTestId('confirmed')).toHaveText('2.090.000.000');
    await expect(page.getByTestId('difference')).toHaveText('-10.000.000');
    await page.locator('button[data-action="assign"]').click();
    await page.locator('#assign-owner').selectOption(membershipOf('reconcileOwner'));
    await page.locator('#assign-due').fill('2099-12-31T10:00');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.item.assign.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.item.done.assigned']);
    expect((await sql<{ owner: string; due: string }>(`select owner_membership_id as owner, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as due from machvon.reconciliation_item where id = $1`, [opened!.id]))[0]).toEqual({
      owner: membershipOf('reconcileOwner'),
      due: '2099-12-31T03:00',
    });

    await open(page, `/pay/pay-06?item=${opened!.id}`, 'reconcileOwner');
    await page.locator('button[data-action="explain"]').click();
    await page.locator('#resolve-note').fill('Kho bạc trừ phí 10.000.000 theo thông báo TB-77');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.item.action.explain'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['pay.recon.status.explained']);
    await page.locator('button[data-action="write-off"]').click();
    await page.locator('#resolve-note').fill('Không thu hồi được');
    await page.locator('#resolve-approval').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.item.action.writeOff'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['pay.recon.error.selfApproval']);
    expect((await sql<{ status: string }>('select status from machvon.reconciliation_item where id = $1', [opened!.id]))[0]?.status).toBe('EXPLAINED');

    await open(page, `/pay/pay-06?item=${opened!.id}`, 'reconcileApprover');
    await page.locator('button[data-action="write-off"]').click();
    await page.locator('#resolve-note').fill('Không thu hồi được');
    await page.locator('#resolve-approval').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.item.action.writeOff'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['pay.recon.status.writtenOff']);
    await expect(page.getByTestId('difference')).toHaveText('-10.000.000');
    expect((await sql<{ status: string; resolved_by: string; approval: string; difference: string }>('select status, resolved_by, approval_document_version_id as approval, difference_vnd::text as difference from machvon.reconciliation_item where id = $1', [opened!.id]))[0]).toEqual({
      status: 'WRITTEN_OFF_APPROVED',
      resolved_by: membershipOf('reconcileApprover'),
      approval: seeded.paper,
      difference: '-10000000',
    });
    expect(await auditsOf(opened!.id, 'reconciliation_item.resolved')).toEqual([{ actor_id: membershipOf('reconcileOwner') }, { actor_id: membershipOf('reconcileApprover') }]);

    // UAT-AC335: the transaction that is the net settles the request, once, and tells CAP, DIS and MNE.
    await open(page, '/pay/pay-05', 'reconciler');
    await expect(page.locator(`tr[data-transaction="${short}"]`)).toHaveCount(0);
    await page.locator(`tr[data-transaction="${exact}"] button[data-action="match"]`).click();
    await page.locator('#match-request').selectOption(made!.id);
    await expect(page.getByTestId('match-agree')).toHaveAttribute('data-agree', 'yes');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.recon.match.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.recon.done.settled'].replace('{day}', '2026-07-25'));
    expect((await sql<{ status: string; paid_on: string; tx: string }>('select status, treasury_paid_on::text as paid_on, settled_transaction_id as tx from machvon.payment_request where id = $1', [made!.id]))[0]).toEqual({ status: 'SETTLED', paid_on: '2026-07-25', tx: exact });
    expect((await sql<{ paid_total: string; recovered: string }>('select paid_total_vnd::text as paid_total, advance_recovered_vnd::text as recovered from machvon.contract where id = $1', [seeded.contractId]))[0]).toEqual({ paid_total: '3000000000', recovered: '750000000' });
    expect(await sql(`select 1 from machvon.cumulative_ledger_entry where payment_request_id = $1 and entry_kind = 'PAYMENT'`, [made!.id])).toHaveLength(2);
    expect(await eventsOf(made!.id, 'pay.payment.settled.v1')).toHaveLength(1);
    expect(await eventsOf(made!.id, 'pay.payment.settled.v2')).toHaveLength(1);
    expect(await auditsOf(made!.id, 'payment_request.settled')).toEqual([{ actor_id: membershipOf('reconciler') }]);

    // PAY-09: the project stands as the rows say, and a reader sees the board and the item and no command.
    await open(page, '/pay/pay-09', 'reconcileReader');
    const row = page.locator(`tr[data-project="${project!.project_id}"]`);
    await expect(row.getByTestId('sent')).toHaveText(vi['pay.track.count'].replace('{count}', '0').replace('{amount}', '0'));
    await expect(row.getByTestId('settled')).toHaveText(vi['pay.track.count'].replace('{count}', '1').replace('{amount}', '2.100.000.000'));
    await expect(row.getByTestId('confirmed')).toHaveText(vi['pay.track.count'].replace('{count}', '2').replace('{amount}', '4.190.000.000'));
    await expect(row.getByTestId('unmatched')).toHaveText('0');
    await expect(row.getByTestId('differences')).toHaveText('0');
    await open(page, '/pay/pay-05', 'reconcileReader');
    await expect(page.locator('button[data-action="match"]')).toHaveCount(0);
    await expect(page.locator(`tr[data-item="${opened!.id}"]`).getByTestId('status')).toHaveText(vi['pay.recon.status.writtenOff']);
    await page.locator(`tr[data-item="${opened!.id}"]`).getByTestId('open').click();
    await expect(page.locator('button[data-action]')).toHaveCount(0);
  });
});
