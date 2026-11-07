import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PAY-10 (the cumulative ledger of a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the chief accountant opens the ledger of a contract and sees, for each
 * BOQ item of the acceptance, what was accepted, requested, paid, recovered from the advance and held back, with the entries that make each balance (a claim, and the reversal of a payment marked
 * as one); narrows it to one item; and a person without the right to the ledger is refused in words. The ledger is written to the database as the consumer of the acceptance events leaves it.
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
  acceptanceId: string;
  items: string[];
}

/**
 * An ACTIVE contract worth 1,200,000 dong with B01 and B02, an approved acceptance of both (600,000 each) and the ledger the consumer leaves for it: B01 has a claim of 250,000 and a payment of
 * 100,000 that was reversed again; B02 has only the recognition. The rows are written straight to the database (foreign keys to modules that are not seeded are switched off).
 */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const acceptanceId = randomUUID();
  const items = [randomUUID(), randomUUID()];
  const lines = [randomUUID(), randomUUID()];
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const code = `HD-SL-${suffix}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  if (contractor === undefined || project === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, advance_recovered_vnd,
                                     accepted_total_vnd, requested_total_vnd, paid_total_vnd, retention_held_vnd, created_by, updated_by, submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử sổ lũy kế', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 50000::numeric, 20000::numeric,
               1200000::numeric, 250000::numeric, 0::numeric, 12500::numeric, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, code, MAKER, membershipOf('lifecycleReviewer'), papers[0]?.id, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, papers[0]?.id, MAKER, membershipOf('lifecycleActivator')],
    );
    for (const [n, key] of ['B01', 'B02'].entries()) {
      await client.query(`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, $5, $6, 'M3', $4, $4)`, [tenant, items[n], contractId, MAKER, key, `Hạng mục ${key}`]);
      await client.query(
        `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
         values ($1, $2, $3, $4, $5, $7, $6, $8, 'M3', 60, 10000, 'HALF_UP', 600000, 5, $9)`,
        [tenant, lines[n], revisionId, contractId, items[n], key, n + 1, `Hạng mục ${key}`, MAKER],
      );
    }
    await client.query(
      `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, signer_refs, status, version, acceptance_no, accepted_amount_vnd, created_by, updated_by,
                                       submitted_by, submitted_at, approved_at, decided_by, decision_reason)
       values ($1, $2, $3, jsonb_build_array(gen_random_uuid()::text), $4, '[]'::jsonb, 'APPROVED', 3, $5, 1200000::numeric, $6, $6, $6, now(), now(), $7, 'Checked.')`,
      [tenant, acceptanceId, contractId, papers[0]?.id, `NT-${suffix}`, MAKER, membershipOf('lifecycleActivator')],
    );
    const ledgers = [randomUUID(), randomUUID()];
    const balances = [
      { accepted: 600000, requested: 250000, paid: 0, recovered: 5000, held: 12500 },
      { accepted: 600000, requested: 0, paid: 0, recovered: 0, held: 0 },
    ];
    for (const [n, ledgerId] of ledgers.entries()) {
      const balance = balances[n]!;
      await client.query(
        `insert into machvon.cumulative_ledger (tenant_id, id, contract_id, boq_item_id, acceptance_id, accepted_vnd, requested_vnd, paid_vnd, advance_recovered_vnd, retention_held_vnd, created_by, updated_by, version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 4)`,
        [tenant, ledgerId, contractId, items[n], acceptanceId, balance.accepted, balance.requested, balance.paid, balance.recovered, balance.held, MAKER],
      );
      await client.query(
        `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, entry_kind, accepted_delta_vnd, advance_outstanding_after_vnd, request_id, created_by, posted_at)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, 'RECOGNIZE_ACCEPTANCE', 600000, 30000, gen_random_uuid(), $6, timestamptz '2026-10-25 01:00:00+00')`,
        [tenant, ledgerId, contractId, items[n], acceptanceId, MAKER],
      );
    }
    await client.query(
      `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, entry_kind, requested_delta_vnd, advance_recovery_delta_vnd, retention_delta_vnd, advance_outstanding_after_vnd,
                                                    reason, request_id, created_by, posted_at)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, 'CLAIM', 250000, 5000, 12500, 30000, 'Đề nghị thanh toán đợt 1', gen_random_uuid(), $6, timestamptz '2026-10-25 02:00:00+00')`,
      [tenant, ledgers[0], contractId, items[0], acceptanceId, MAKER],
    );
    // A payment and its reversal: the pair is shown, the reversal marked.
    const payment = randomUUID();
    await client.query(
      `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, entry_kind, paid_delta_vnd, advance_outstanding_after_vnd, request_id, created_by, posted_at)
       values ($1, $7, $2, $3, $4, $5, 'PAYMENT', 100000, 30000, gen_random_uuid(), $6, timestamptz '2026-10-25 03:00:00+00')`,
      [tenant, ledgers[0], contractId, items[0], acceptanceId, MAKER, payment],
    );
    await client.query(
      `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, entry_kind, paid_delta_vnd, advance_outstanding_after_vnd, reversal_of_id, reason, request_id, created_by, posted_at)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, 'PAYMENT_REVERSAL', -100000, 30000, $7, 'Kho bạc trả lại lệnh chi', gen_random_uuid(), $6, timestamptz '2026-10-25 04:00:00+00')`,
      [tenant, ledgers[0], contractId, items[0], acceptanceId, MAKER, payment],
    );
  } finally {
    await client.end();
  }
  return { contractId, code, acceptanceId, items };
}

test.describe('the cumulative ledger of a contract', () => {
  test('the chief accountant reads the balances and their entries, narrows them to one item, and a person without the right is refused (UI-PAY-10, AC-ST-PAY-001-4, UAT-AC341)', async ({ page }) => {
    const seeded = await seed();
    const path = `/pay/pay-10?contract=${seeded.contractId}`;

    await open(page, '/pay/pay-10', 'ledgerReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['pay.ledger.title'] })).toBeVisible();
    await expect(page.getByTestId('no-contract')).toHaveText(vi['pay.ledger.none.notice']);

    await open(page, path, 'ledgerReader');
    await expect(page.getByTestId('contract-code')).toHaveText(seeded.code);
    await expect(page.getByTestId('contract-value')).toHaveText('1.200.000');
    await expect(page.getByTestId('contract-accepted')).toHaveText('1.200.000');
    await expect(page.getByTestId('contract-requested')).toHaveText('250.000');
    await expect(page.getByTestId('contract-advance')).toHaveText('30.000');
    await expect(page.getByTestId('contract-retention-held')).toHaveText('12.500');
    await expect(page.getByTestId('reconciled')).toHaveText(vi['pay.ledger.reconciled.yes']);

    const first = page.locator(`tr[data-item="${seeded.items[0]}"]`);
    await expect(first.getByTestId('item')).toHaveText('B01');
    await expect(first.getByTestId('accepted')).toHaveText('600.000');
    await expect(first.getByTestId('requested')).toHaveText('250.000');
    await expect(first.getByTestId('recovered')).toHaveText('5.000');
    await expect(first.getByTestId('held')).toHaveText('12.500');
    await expect(first.getByTestId('available')).toHaveText('350.000');
    const second = page.locator(`tr[data-item="${seeded.items[1]}"]`);
    await expect(second.getByTestId('available')).toHaveText('600.000');
    await expect(page.locator('tfoot').getByTestId('accepted')).toHaveText('1.200.000');

    // The entries of B01 in the order they were posted, the reversal marked and the reason kept.
    await first.getByRole('button', { name: vi['pay.ledger.entries.show'].replace('{count}', '4') }).click();
    const entries = page.locator('tr[data-entry]');
    await expect(entries).toHaveCount(4);
    await expect(entries.nth(0)).toContainText(vi['pay.ledger.entry.kind.recognizeAcceptance']);
    await expect(entries.nth(1)).toContainText(vi['pay.ledger.entry.kind.claim']);
    await expect(entries.nth(1)).toContainText('Đề nghị thanh toán đợt 1');
    await expect(entries.nth(3)).toContainText(vi['pay.ledger.entry.kind.paymentReversal']);
    await expect(entries.nth(3)).toContainText(vi['pay.ledger.entry.reverses']);
    await expect(entries.nth(3)).toContainText('-100.000');
    await expect(entries.nth(2)).not.toContainText(vi['pay.ledger.entry.reverses']);

    // Narrowed to B02, the total follows the filter.
    await page.getByTestId('filter-item').selectOption(seeded.items[1]!);
    await expect(page.locator('tbody > tr[data-line]')).toHaveCount(1);
    await expect(page.locator('tfoot').getByTestId('accepted')).toHaveText('600.000');
    await expect(page.locator('tfoot')).toContainText(vi['pay.ledger.total.filtered']);

    // What the screen showed is what the database holds.
    const [sum] = await sql<{ accepted: string; entries: string }>(
      'select sum(l.accepted_vnd)::text as accepted, (select count(*)::text from machvon.cumulative_ledger_entry where contract_id = $1) as entries from machvon.cumulative_ledger l where l.contract_id = $1',
      [seeded.contractId],
    );
    expect(sum).toEqual({ accepted: '1200000', entries: '5' });

    // Whoever holds no right to the ledger is told so; the page shows none of it.
    await open(page, path, 'acceptanceViewer');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByTestId('contract-code')).toHaveCount(0);
    await expect(page.getByTestId('ledger')).toHaveCount(0);
  });
});
