import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CTR-03 (the closure of a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the leader sees what stands in the way of closing a contract that was completed
 * (its settlement is closed with an exception that carries the advance still owed, and 100,000 of retention is still held), is refused in words, and closes the contract once the retention is
 * released; nothing is offered on the contract afterwards, and its history says it was closed. What the screen changed is looked up in the database.
 */

const MAKER = membershipOf('lifecycleMaker');
const LEADER = membershipOf('contractCloser');
let counter = 0;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function admin(work: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (the minutes, the settlement, the payment) are seeded with the foreign keys to the modules that are not seeded switched off.
    await client.query('set session_replication_role = replica');
    await work(client);
  } finally {
    await client.end();
  }
}

interface Seeded {
  contractId: string;
  settlementId: string;
  holdId: string;
}

/** A contract that was completed, owing 1,250,000 of advance, with a closed settlement that carries the exception for it and 100,000 of retention that is still held. */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const settlementId = randomUUID();
  const holdId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' and scan_status = 'CLEAN' order by object_key");
  if (contractor === undefined || project === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const documentVersionId = papers[0]?.id ?? '';
  await admin(async (client) => {
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử đóng', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 12000000::numeric, 12000000::numeric, 1250000::numeric, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, `HD-DG-${suffix}`, MAKER, membershipOf('lifecycleReviewer'), documentVersionId, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 12000000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, documentVersionId, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `update machvon.contract set current_revision_id = $2, status = 'COMPLETED', completed_on = date '2026-10-01', completion_quality_acceptance_id = gen_random_uuid(), completed_by = $3 where id = $1`,
      [contractId, revisionId, MAKER],
    );
    await client.query(
      `insert into machvon.settlement_revision
         (tenant_id, id, project_id, contract_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, audit_finding_refs, status, settlement_scope, project_group,
          submitted_by, submitted_at, submitted_on, deadline_rule_version_id, deadline_days, verification_due_on, verified_by, verified_at, verified_on,
          closed_by, closed_at, close_reason, decision_document_version_id, exception_reason, exception_approved_by, exception_approved_at, exception_approval_document_version_id,
          created_by, updated_by, version)
       values ($1, $2, $3, $4, 1, 1000000, 0, 1250000, '[]'::jsonb, 'CLOSED', 'CONTRACT', 'B',
               $5, now(), date '2026-10-02', gen_random_uuid(), 120, date '2027-01-30', $6, now(), date '2026-10-10',
               $7, timestamptz '2026-10-20T03:00:00Z', 'Closed after the verification.', $8, 'The advance is carried to the next year.', $7, timestamptz '2026-10-19T03:00:00Z', $8,
               $9, $9, 1)`,
      [tenant, settlementId, project.id, contractId, membershipOf('lifecycleReviewer'), membershipOf('lifecycleActivator'), membershipOf('lifecycleActivator'), documentVersionId, MAKER],
    );
    await client.query(
      `insert into machvon.retention_hold (tenant_id, id, contract_id, boq_item_id, acceptance_id, payment_request_id, held_vnd, release_condition, created_by, updated_by)
       values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 100000, 'COMPLETION', $4, $4)`,
      [tenant, holdId, contractId, MAKER],
    );
  });
  return { contractId, settlementId, holdId };
}

const stored = async (contractId: string) => (await sql<{ status: string; version: string }>('select status, version::text from machvon.contract where id = $1', [contractId]))[0];

test.describe('the closure of a contract', () => {
  test('the leader is refused while retention is held, then closes the contract on the closed settlement once it is released (UI-CTR-03, AC-ST-CTR-012-1, UAT-AC300)', async ({ page }) => {
    const seeded = await seed();
    const path = `/ctr/ctr-03?id=${seeded.contractId}`;

    await open(page, path, 'contractCloser');
    await expect(page.getByTestId('contract-code')).toBeVisible();
    // The way to closure says what stands in the way: the settlement is closed and carries the exception for the advance, the retention is still held.
    const state = (key: string) => page.locator(`[data-closure="${key}"]`);
    await expect(state('settlement')).toHaveAttribute('data-ok', 'true');
    await expect(state('advance')).toHaveAttribute('data-ok', 'true');
    await expect(state('retention')).toHaveAttribute('data-ok', 'false');
    await expect(state('retention')).toContainText('100.000');

    // The retention is what the server tells, in words, and nothing changes.
    await page.locator('[data-command="close"]').click();
    await expect(page.locator('#workspace-closure-settlement')).toHaveValue(seeded.settlementId);
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.workspace.close.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ctr.workspace.error.retentionUnresolved']);
    expect(await stored(seeded.contractId)).toEqual({ status: 'COMPLETED', version: '1' });

    // The retention is released: all three are met, and the contract is closed on the settlement.
    await admin(async (client) => {
      await client.query(
        "update machvon.retention_hold set released_vnd = held_vnd, status = 'RELEASED', released_by = $2, released_at = now(), release_reason = 'Released for the test.' where id = $1",
        [seeded.holdId, membershipOf('lifecycleActivator')],
      );
    });
    await open(page, path, 'contractCloser');
    await expect(state('retention')).toHaveAttribute('data-ok', 'true');
    await page.locator('[data-command="close"]').click();
    await page.locator('#workspace-closure-note').fill('Đã giải tỏa hết khoản giữ lại.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.workspace.close.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['ctr.status.closed.label']);
    expect(await stored(seeded.contractId)).toEqual({ status: 'CLOSED', version: '2' });
    expect(
      await sql<{ reason: string; created_by: string }>("select reason, created_by from machvon.contract_status_change where contract_id = $1 and to_status = 'CLOSED'", [seeded.contractId]),
    ).toEqual([{ reason: 'Đã giải tỏa hết khoản giữ lại.', created_by: LEADER }]);
    await expect(page.locator('[data-command]')).toHaveCount(0);
    await expect(page.getByTestId('closure-checks')).toHaveCount(0);
    await expect(page.getByTestId('history')).toContainText('Đã giải tỏa hết khoản giữ lại.');
  });
});
