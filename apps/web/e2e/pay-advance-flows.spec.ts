import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PAY-07 and CTR-06 (the advance of a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the accountant sees a land clearance advance that is late and a
 * planned one, meets the refusal of a recovery above what is owed, records a recovery with its basis and evidence, cancels the planned advance with a reason, and reads the schedule of the
 * recovery of the advance with the cap and the rule that waits for its confirmation. A reader sees the list and no command. What the screens changed is looked up in the database.
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
  paid: string;
  planned: string;
  paper: string;
}

/**
 * A contract being performed with its one member, an advance of 2bn paid to the member for land clearance, 750m of it recovered and the deadline gone by, and an advance of 500m that is only
 * planned. Written straight to the database (foreign keys and the guards of modules that are not seeded are switched off).
 */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const [projectId, packageId, contractId, revisionId, partyId, paid, planned] = Array.from({ length: 7 }, () => randomUUID()) as [string, string, string, string, string, string, string];
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const code = `HD-TU-${suffix}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenant]);
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  const unit = stackInfo().units.A['CB-SKHDT-QLDA'] as string;
  if (area === undefined || contractor === undefined || papers.length < 1) throw new Error('the fixtures of the stack are missing');
  const paper = papers[0]!.id;
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
      [tenant, projectId, `E2E-ADV-${suffix}`, `Cầu tạm ứng ${counter}`, unit, area.id, String(1000000 + Math.floor(Math.random() * 8999999)), OWNER],
    );
    await client.query(
      `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
       values ($1, $2, $3, $4, 10000000000, 'OPEN_BIDDING', 1, 'APPROVED', $5, $6, 1)`,
      [tenant, packageId, projectId, `GT-TU-${suffix}`, `Gói thầu tạm ứng ${counter}`, OWNER],
    );
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, accepted_total_vnd,
                                     advance_category, created_by, updated_by, submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by, advance_paid_vnd, advance_recovered_vnd)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử tạm ứng', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 10000000000::numeric, 10000000000::numeric, 0::numeric, 'CONSTRUCTION', $7, $7, $7, date '2026-01-02', $8, $9,
               date '2026-01-03', $10, 2000000000::numeric, 750000000::numeric)`,
      [tenant, contractId, projectId, packageId, contractor.id, code, OWNER, membershipOf('lifecycleReviewer'), paper, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 10000000000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, paper, OWNER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    await client.query(
      `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
       values ($1, $2, $3, $4, 'SOLE', 100, 10000000000, 'ACTIVE', date '2026-01-03', $5, $5)`,
      [tenant, partyId, contractId, contractor.id, OWNER],
    );
    const rule = (await client.query<{ id: string }>("select id from machvon.master_record_version where master_type = 'PAY_ADVANCE_CAP' and code = 'CONSTRUCTION' order by revision desc limit 1")).rows[0]?.id;
    if (rule === undefined) throw new Error('the cap rule of the platform is missing');
    await client.query(
      `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, cap_rule_version_id, status, paid_vnd, recovered_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
       values ($1, $2, $3, $4, 1, 'GPMB', 2000000000, 2000000000, $5, 'RECOVERING', 2000000000, 750000000, date '2026-07-01', 80, date '2026-07-31', $6, $6)`,
      [tenant, paid, contractId, partyId, rule, OWNER],
    );
    await client.query(
      `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, cap_rule_version_id, status, created_by, updated_by)
       values ($1, $2, $3, $4, 2, 'GPMB', 500000000, 500000000, $5, 'PLANNED', $6, $6)`,
      [tenant, planned, contractId, partyId, rule, OWNER],
    );
  } finally {
    await client.end();
  }
  return { contractId, code, paid, planned, paper };
}

interface AdvanceRow {
  status: string;
  recovered: string;
  outstanding: string;
  version: string;
}

const advanceOf = async (id: string): Promise<AdvanceRow | undefined> =>
  (await sql<AdvanceRow>('select status, recovered_vnd::text as recovered, outstanding_vnd::text as outstanding, version::text from machvon.contract_advance where id = $1', [id]))[0];
const journalOf = (id: string) =>
  sql<{ entry_kind: string; amount: string; basis: string | null; evidence: string | null; outstanding_after: string }>(
    'select entry_kind, amount_vnd::text as amount, basis, evidence_document_version_id as evidence, outstanding_after_vnd::text as outstanding_after from machvon.advance_ledger_entry where advance_id = $1 order by posted_at, id',
    [id],
  );
const eventsOf = (id: string, type: string) => sql<{ id: string }>('select id from machvon.outbox_event where aggregate_id = $1 and type = $2', [id, type]);
const auditsOf = (id: string, action: string) => sql<{ actor_id: string; reason: string | null }>('select actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2', [id, action]);

test.describe('the advance of a contract', () => {
  test('the accountant sees a late advance and a planned one, is refused a recovery above what is owed, records one with its evidence, cancels the planned advance and reads the schedule (UI-PAY-07, UI-CTR-06, AC-ST-PAY-004-3, AC-ST-PAY-004-4, UAT-AC61)', async ({ page }) => {
    const seeded = await seed();
    await open(page, `/pay/pay-07?contract=${seeded.contractId}`, 'advanceAccountant');
    await expect(page.getByRole('heading', { level: 1, name: vi['pay.advance.list.title'] })).toBeVisible();
    const late = page.locator(`tr[data-advance="${seeded.paid}"]`);
    const planned = page.locator(`tr[data-advance="${seeded.planned}"]`);
    await expect(late.getByTestId('outstanding')).toHaveText('1.250.000.000');
    await expect(late.getByTestId('recovered')).toHaveText('750.000.000');
    await expect(late.getByTestId('deadline')).toHaveText('2026-07-31');
    await expect(late.getByTestId('threshold')).toHaveText(vi['pay.advance.threshold'].replace('{pct}', '80'));
    await expect(late.getByTestId('status')).toHaveText(vi['pay.advance.status.recovering']);
    await expect(late.getByTestId('overdue')).not.toHaveText('');
    await expect(planned.getByTestId('status')).toHaveText(vi['pay.advance.status.planned']);

    // A recovery above what is owed is refused in words and records nothing.
    await late.locator('button[data-action="recover"]').click();
    await expect(page.getByTestId('owed')).toHaveText(vi['pay.advance.recovery.owed'].replace('{amount}', '1.250.000.000'));
    await page.locator('#recovery-amount').fill('1300000000');
    await page.locator('#recovery-basis').selectOption('REFUND');
    await page.locator('#recovery-evidence').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.advance.recovery.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['pay.advance.error.recoveryExceeded']);
    expect(await journalOf(seeded.paid)).toEqual([]);

    // What is owed, exactly, is recorded with its basis and evidence: the advance is recovered in full.
    await page.locator('#recovery-amount').fill('1250000000');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.advance.recovery.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.advance.done.recovered']);
    await expect(late.getByTestId('status')).toHaveText(vi['pay.advance.status.fullyRecovered']);
    await expect(late.getByTestId('outstanding')).toHaveText('0');
    expect(await advanceOf(seeded.paid)).toMatchObject({ status: 'FULLY_RECOVERED', recovered: '2000000000', outstanding: '0' });
    expect(await journalOf(seeded.paid)).toEqual([{ entry_kind: 'RECOVER', amount: '1250000000', basis: 'REFUND', evidence: seeded.paper, outstanding_after: '0' }]);
    expect(await eventsOf(seeded.paid, 'pay.advance.recovered.v1')).toHaveLength(1);
    expect(await auditsOf(seeded.paid, 'advance.recovered')).toEqual([{ actor_id: membershipOf('advanceAccountant'), reason: null }]);
    expect((await sql<{ recovered: string }>('select advance_recovered_vnd::text as recovered from machvon.contract where id = $1', [seeded.contractId]))[0]?.recovered).toBe('2000000000');

    // The planned advance is cancelled with a reason.
    await planned.locator('button[data-action="cancel"]').click();
    await page.locator('#cancel-reason').fill('Khoản tạm ứng không còn cần thiết.');
    await page.getByRole('dialog').getByRole('button', { name: vi['pay.advance.cancel.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['pay.advance.done.cancelled']);
    await expect(planned.getByTestId('status')).toHaveText(vi['pay.advance.status.cancelled']);
    expect(await advanceOf(seeded.planned)).toMatchObject({ status: 'CANCELLED' });
    expect(await auditsOf(seeded.planned, 'advance.cancelled')).toEqual([{ actor_id: membershipOf('advanceAccountant'), reason: 'Khoản tạm ứng không còn cần thiết.' }]);
    expect(await eventsOf(seeded.planned, 'pay.advance.cancelled.v1')).toHaveLength(1);

    // The schedule of the recovery is a click away: the cap of the category, the rule that waits for its confirmation, the threshold and the milestones.
    await late.getByTestId('schedule').click();
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.advance.title'] })).toBeVisible();
    await expect(page.getByTestId('awaiting')).toHaveText(vi['ctr.advance.awaiting'].replace('{cxn}', 'CXN-02'));
    const row = page.locator(`tr[data-advance="${seeded.paid}"]`);
    await expect(row.getByTestId('cap')).toHaveText(vi['ctr.advance.cap'].replace('{pct}', '20').replace('{amount}', '2.000.000.000'));
    await expect(row.getByTestId('member')).toContainText('SOLE');
    await expect(page.getByTestId('threshold')).toHaveText(vi['ctr.advance.fact.thresholdValue'].replace('{pct}', '80').replace('{amount}', '8.000.000.000'));
    await expect(page.getByTestId('work')).toHaveText('10.000.000.000');
    await expect(page.locator('tr[data-milestone="100"]').getByTestId('milestone-recovered')).toHaveText('2.000.000.000');
    await expect(page.locator('tr[data-milestone="25"]').getByTestId('milestone-gross')).toHaveText('2.000.000.000');
  });

  test('a reader sees the advances and the schedule and no command (UI-PAY-07)', async ({ page }) => {
    const seeded = await seed();
    await open(page, `/pay/pay-07?contract=${seeded.contractId}`, 'advanceReader');
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('button[data-action]')).toHaveCount(0);
    await page.locator(`tr[data-advance="${seeded.paid}"]`).getByTestId('schedule').click();
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.advance.title'] })).toBeVisible();
    await expect(page.getByTestId('milestones')).toBeVisible();
  });
});
