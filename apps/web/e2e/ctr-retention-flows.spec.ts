import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CTR-21 (the retention by BOQ line) in a real browser against the real API and database (apps/api/test/e2e-stack): the chief accountant opens a contract that holds back 150,000 on two BOQ lines
 * until the end of the warranty, is refused in words while the warranty is open and while the amount is more than is held, releases the first line when the warranty is closed, and a reader sees the
 * same figures and may do nothing. What the screen changed is looked up in the database: the hold, the totals of the contract and the entry of the ledger.
 */

const MAKER = membershipOf('lifecycleMaker');
let counter = 0;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (the acceptance, the payment request) are seeded with the foreign keys to the modules that are not seeded switched off.
    await client.query('set session_replication_role = replica');
    return await work(client);
  } finally {
    await client.end();
  }
}

interface Seeded {
  contractId: string;
  holds: { b01: string; b02: string };
  obligationId: string;
}

/** An ACTIVE contract with a payment that holds back 100,000 on B01 and 50,000 on B02 until the end of the warranty, and a warranty obligation that is still open. */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const acceptanceId = randomUUID();
  const paymentId = randomUUID();
  const obligationId = randomUUID();
  const items = { b01: randomUUID(), b02: randomUUID() };
  const holds = { b01: randomUUID(), b02: randomUUID() };
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' and scan_status = 'CLEAN' order by object_key");
  if (contractor === undefined || project === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const documentVersionId = papers[0]?.id ?? '';
  await admin(async (client) => {
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by, retention_held_vnd)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử giữ lại', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10, 150000::numeric)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, `HD-GL-${suffix}`, MAKER, membershipOf('lifecycleReviewer'), documentVersionId, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, documentVersionId, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    for (const [key, id] of [
      ['B01', items.b01],
      ['B02', items.b02],
    ] as const) {
      await client.query(`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, $4, $5, 'M3', $6, $6)`, [
        tenant,
        id,
        contractId,
        key,
        `Hạng mục ${key}`,
        MAKER,
      ]);
    }
    await client.query(
      `insert into machvon.acceptance
         (tenant_id, id, contract_id, measurement_ids, document_version_id, signer_refs, status, version, acceptance_no, period_id, accepted_amount_vnd, approved_at, decided_by, decision_reason, submitted_by, submitted_at, created_by, updated_by)
       values ($1, $2, $3, jsonb_build_array($4::text), $5, '[]'::jsonb, 'APPROVED', 3, $6, $7, 1000000, now(), $8, 'Approved for the test.', $9, now(), $9, $9)`,
      [tenant, acceptanceId, contractId, randomUUID(), documentVersionId, `NT-GL-${suffix}`, randomUUID(), membershipOf('lifecycleActivator'), MAKER],
    );
    await client.query(
      `insert into machvon.payment_request
         (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, request_kind, request_no, claims_acceptance, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'VND', 1000000, 0, 150000, 0, 850000, 'SUBMITTED', 1, 'INTERIM', $6, true, $7, $7)`,
      [tenant, paymentId, project.id, contractId, acceptanceId, `DNTT-GL-${suffix}`, MAKER],
    );
    for (const [item, hold, held] of [
      [items.b01, holds.b01, 100000],
      [items.b02, holds.b02, 50000],
    ] as const) {
      // A balance is the sum of its entries: the acceptance is recognised, claimed, and the retention is held, as the payment left it.
      const ledgerId = randomUUID();
      await client.query(
        `insert into machvon.cumulative_ledger (tenant_id, id, contract_id, boq_item_id, acceptance_id, accepted_vnd, requested_vnd, retention_held_vnd, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 500000, 500000, $6, $7, $7)`,
        [tenant, ledgerId, contractId, item, acceptanceId, held, MAKER],
      );
      for (const [kind, accepted, requested, retention] of [
        ['RECOGNIZE_ACCEPTANCE', 500000, 0, 0],
        ['CLAIM', 0, 500000, 0],
        ['RETENTION_HOLD', 0, 0, held],
      ] as const) {
        await client.query(
          `insert into machvon.cumulative_ledger_entry
             (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, payment_request_id, entry_kind, accepted_delta_vnd, requested_delta_vnd, retention_delta_vnd, advance_outstanding_after_vnd, request_id, created_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, gen_random_uuid(), $11)`,
          [tenant, ledgerId, contractId, item, acceptanceId, kind === 'RECOGNIZE_ACCEPTANCE' ? null : paymentId, kind, accepted, requested, retention, MAKER],
        );
      }
      await client.query(
        `insert into machvon.retention_hold (tenant_id, id, contract_id, boq_item_id, acceptance_id, payment_request_id, held_vnd, release_condition, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, 'WARRANTY_END', $8, $8)`,
        [tenant, hold, contractId, item, acceptanceId, paymentId, held, MAKER],
      );
    }
    await client.query(
      `insert into machvon.warranty_obligation
         (tenant_id, id, project_id, contract_id, handover_id, scope_description, starts_on, ends_on, period_months, retention_amount_vnd, status, created_by, updated_by)
       values ($1, $2, $3, $4, gen_random_uuid(), 'Toàn bộ công trình', date '2024-01-01', date '2025-01-01', 12, 150000, 'ACTIVE', $5, $5)`,
      [tenant, obligationId, project.id, contractId, MAKER],
    );
  });
  return { contractId, holds, obligationId };
}

interface HoldRow {
  id: string;
  status: string;
  released_vnd: string;
  released_by: string | null;
  release_reason: string | null;
  version: string;
}

const holdOf = async (id: string): Promise<HoldRow | undefined> =>
  (await sql<HoldRow>('select id, status, released_vnd::text, released_by, release_reason, version::text from machvon.retention_hold where id = $1', [id]))[0];

test.describe('the retention by BOQ line', () => {
  test('the chief accountant is refused while the warranty is open and above what is held, releases a line once the warranty is closed, and a reader may do nothing (UI-CTR-21, AC-ST-CTR-010-1, UAT-AC309)', async ({
    page,
  }) => {
    const seeded = await seed();
    const url = `/ctr/ctr-21?contract=${seeded.contractId}`;
    const line = (id: string) => page.locator(`[data-hold="${id}"]`);

    await open(page, url, 'retentionAccountant');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.retention.page.title'] })).toBeVisible();
    await expect(page.getByTestId('contract')).toContainText('HD-GL-');
    await expect(line(seeded.holds.b01).getByTestId('item')).toHaveText('B01');
    await expect(line(seeded.holds.b01).getByTestId('condition')).toHaveText(vi['ctr.retention.condition.warrantyEnd']);
    await expect(line(seeded.holds.b01).getByTestId('condition-state')).toHaveText(vi['ctr.retention.blocker.warrantyOpen']);
    await expect(line(seeded.holds.b01).getByTestId('status')).toHaveText(vi['ctr.retention.status.held']);

    // The warranty is open: the server refuses, in words, and nothing is released.
    await line(seeded.holds.b01).locator('[data-release]').click();
    await page.locator('#release-reason').fill('Đã hết bảo hành.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.retention.release.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ctr.retention.error.conditionNotMet'].replace('{reason}', vi['ctr.retention.blocker.warrantyOpen']));
    expect(await holdOf(seeded.holds.b01)).toMatchObject({ status: 'HELD', released_vnd: '0', version: '1' });
    await page.getByRole('button', { name: vi['ctr.retention.dialog.cancel'] }).click();

    // The warranty is closed; the screen shows the condition met, and an amount above what is held is turned back before it is sent.
    await admin((client) =>
      client.query("update machvon.warranty_obligation set status = 'CLOSED', closed_by = $2, closed_at = now() where id = $1", [seeded.obligationId, membershipOf('lifecycleActivator')]),
    );
    await open(page, url, 'retentionAccountant');
    await expect(line(seeded.holds.b01).getByTestId('condition-state')).toHaveText(vi['ctr.retention.condition.met']);
    await line(seeded.holds.b01).locator('[data-release]').click();
    await expect(page.locator('#release-amount')).toHaveValue('100000');
    await page.locator('#release-amount').fill('100001');
    await page.locator('#release-reason').fill('Đã hết bảo hành.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.retention.release.submit'] }).click();
    await expect(page.getByText(vi['ctr.retention.problem.exceeds'])).toBeVisible();
    expect(await holdOf(seeded.holds.b01)).toMatchObject({ status: 'HELD', released_vnd: '0' });

    // The exact amount releases the line: the hold, the totals of the contract and the ledger agree, and the other line is still held.
    await page.locator('#release-amount').fill('100000');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.retention.release.submit'] }).click();
    await expect(line(seeded.holds.b01).getByTestId('status')).toHaveText(vi['ctr.retention.status.released']);
    await expect(line(seeded.holds.b01).getByTestId('left')).toContainText('0');
    await expect(line(seeded.holds.b01).locator('[data-release]')).toHaveCount(0);
    await expect(page.getByTestId('released-total')).toContainText('100.000');
    expect(await holdOf(seeded.holds.b01)).toMatchObject({
      status: 'RELEASED',
      released_vnd: '100000',
      released_by: membershipOf('retentionAccountant'),
      release_reason: 'Đã hết bảo hành.',
      version: '2',
    });
    expect(await holdOf(seeded.holds.b02)).toMatchObject({ status: 'HELD', released_vnd: '0', version: '1' });
    expect(
      (await sql<{ held: string; released: string }>('select retention_held_vnd::text as held, retention_released_vnd::text as released from machvon.contract where id = $1', [seeded.contractId]))[0],
    ).toEqual({ held: '150000', released: '100000' });
    expect(
      await sql<{ retention_delta_vnd: string }>("select retention_delta_vnd::text from machvon.cumulative_ledger_entry where contract_id = $1 and entry_kind = 'RETENTION_RELEASE'", [
        seeded.contractId,
      ]),
    ).toEqual([{ retention_delta_vnd: '-100000' }]);
    await expect(line(seeded.holds.b02).getByTestId('status')).toHaveText(vi['ctr.retention.status.held']);

    // A reader sees the same figures and has nothing to press.
    await open(page, url, 'retentionReader');
    await expect(line(seeded.holds.b01).getByTestId('status')).toHaveText(vi['ctr.retention.status.released']);
    await expect(line(seeded.holds.b02).getByTestId('condition-state')).toHaveText(vi['ctr.retention.condition.met']);
    await expect(page.locator('[data-release]')).toHaveCount(0);
  });
});
