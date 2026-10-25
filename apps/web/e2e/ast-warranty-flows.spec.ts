import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * AST-04 (the warranty and what is held back) in a real browser against the real API and database (apps/api/test/e2e-stack): the project office creates the warranty obligation of an accepted
 * handover and is refused in words when the term is below the minimum of the rule; once the warranty has run out, closing it is refused in words while a claim is open and succeeds when the claim
 * has been verified; a reader sees the obligation and may do nothing. What the screens changed is looked up in the database.
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
  handoverId: string;
}

async function admin<T>(work: (client: Client) => Promise<T>, replica = false): Promise<T> {
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    if (replica) await client.query('set session_replication_role = replica');
    return await work(client);
  } finally {
    await client.end();
  }
}

/** An ACTIVE contract with an accepted handover, written straight to the database (foreign keys to modules that are not seeded are switched off). */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const handoverId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const [unit] = await sql<{ id: string }>('select id from machvon.organization_unit order by code limit 1');
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' and scan_status = 'CLEAN' order by object_key");
  if (contractor === undefined || project === undefined || unit === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const documentVersionId = papers[0]?.id ?? '';
  await admin(async (client) => {
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử bảo hành', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, `HD-BH-${suffix}`, MAKER, membershipOf('lifecycleReviewer'), documentVersionId, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, documentVersionId, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    await client.query(
      `insert into machvon.handover
         (tenant_id, id, project_id, contract_id, recipient_unit_id, document_version_id, punch_list, status, handover_no, handover_kind, created_by, updated_by, version, accepted_at, accepted_by, as_built_document_version_id)
       values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, 'ACCEPTED', $7, 'COMPLETION', $8, $8, 1, timestamptz '2026-10-20T03:00:00Z', $9, $6)`,
      [tenant, handoverId, project.id, contractId, unit.id, documentVersionId, `BG-BH-${suffix}`, MAKER, membershipOf('lifecycleActivator')],
    );
  }, true);
  return { contractId, handoverId };
}

interface WarrantyRow {
  id: string;
  status: string;
  starts_on: string;
  ends_on: string;
  period_months: number;
  construction_grade: string | null;
  minimum_months: number | null;
  retention_amount_vnd: string;
  closed_by: string | null;
  version: string;
}

const warrantiesOf = (handoverId: string) =>
  sql<WarrantyRow>(
    'select id, status, starts_on::text, ends_on::text, period_months, construction_grade, minimum_months, retention_amount_vnd::text, closed_by, version::text from machvon.warranty_obligation where handover_id = $1 order by created_at, id',
    [handoverId],
  );

const fill = async (page: Page, values: Record<string, string>): Promise<void> => {
  for (const [id, value] of Object.entries(values)) await page.locator(`#${id}`).fill(value);
};

test.describe('the warranty and what is held back', () => {
  test('the project office creates an obligation within the rule, closes it once it has run out and no claim is open, and a reader may do nothing (UI-AST-04, AC-ST-AST-003-1, AC-ST-AST-003-2, UAT-AC390, UAT-AC392)', async ({
    page,
  }) => {
    const seeded = await seed();
    const list = `/ast/ast-04?handover=${seeded.handoverId}`;

    await open(page, list, 'warrantyManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['ast.warranty.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-warranties')).toHaveText(vi['ast.warranty.none.notice']);

    // An empty form says what is missing, and nothing is sent.
    await page.getByRole('button', { name: vi['ast.warranty.create.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.warranty.create.submit'] }).click();
    await expect(page.getByText(vi['ast.warranty.problem.required']).first()).toBeVisible();
    await expect(page.getByText(vi['ast.warranty.problem.cover'])).toBeVisible();
    await page.getByRole('button', { name: vi['ast.warranty.dialog.cancel'] }).click();
    expect(await warrantiesOf(seeded.handoverId)).toHaveLength(0);

    // A term below the minimum for the grade of the work is refused with the figures of the rule.
    await page.getByRole('button', { name: vi['ast.warranty.create.action'] }).click();
    await fill(page, { 'warranty-scope': 'Toàn bộ nhà bơm', 'warranty-starts': '2024-01-01', 'warranty-period': '6', 'warranty-retention': '100000' });
    await page.locator('#warranty-handover').selectOption(seeded.handoverId);
    await page.locator('#warranty-grade').selectOption('II');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.warranty.create.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ast.warranty.error.belowMinimum'].replace('{period}', '6').replace('{minimum}', '12'));
    expect(await warrantiesOf(seeded.handoverId)).toHaveLength(0);

    // A work of grade I is held to 24 months; at the minimum for grade II the obligation is created, and its warranty has run out already.
    await page.locator('#warranty-period').fill('12');
    await page.locator('#warranty-grade').selectOption('I');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.warranty.create.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ast.warranty.error.belowMinimum'].replace('{period}', '12').replace('{minimum}', '24'));
    await page.locator('#warranty-grade').selectOption('II');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.warranty.create.submit'] }).click();
    await expect(page.getByTestId('warranties')).toBeVisible();
    const [created] = await warrantiesOf(seeded.handoverId);
    expect(created).toMatchObject({
      status: 'ACTIVE',
      starts_on: '2024-01-01',
      ends_on: '2025-01-01',
      period_months: 12,
      construction_grade: 'II',
      minimum_months: 12,
      retention_amount_vnd: '100000',
      version: '1',
    });
    const id = created?.id ?? '';
    const line = page.locator(`[data-warranty="${id}"]`);
    await expect(line.getByTestId('status')).toHaveText(vi['ast.warranty.status.expired']);
    await expect(line.getByTestId('rule-waiting')).toContainText('CXN-EXE-04');
    await expect(line.getByTestId('claims')).toHaveText(vi['ast.warranty.claims.count'].replace('{open}', '0').replace('{total}', '0'));

    // A claim is open: closing is refused in words, with the number of the claim.
    await admin((client) =>
      client.query(
        `insert into machvon.warranty_claim (tenant_id, id, obligation_id, claim_no, reported_on, reported_by, defect_description, severity, response_due_on, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, 'WC-001', date '2024-06-20', $3, 'Nứt tường', 'MAJOR', date '2024-06-27', $3, $3)`,
        [stackInfo().tenants.A, id, MAKER],
      ),
    );
    await open(page, list, 'warrantyManager');
    await expect(line.getByTestId('claims')).toHaveText(vi['ast.warranty.claims.count'].replace('{open}', '1').replace('{total}', '1'));
    await line.locator('[data-close]').click();
    await expect(page.getByTestId('close-notice')).toHaveText(vi['ast.warranty.close.notice']);
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.warranty.close.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ast.warranty.error.openClaims'].replace('{count}', '1').replace('{claims}', 'WC-001'));
    expect((await warrantiesOf(seeded.handoverId))[0]).toMatchObject({ status: 'ACTIVE', closed_by: null });

    // A reader sees the obligation and the open claim, and has nothing to press.
    await open(page, list, 'warrantyReader');
    await expect(line.getByTestId('claims')).toContainText('1');
    await expect(page.getByRole('button', { name: vi['ast.warranty.create.action'] })).toHaveCount(0);
    await expect(line.locator('[data-close]')).toHaveCount(0);

    // The claim is verified; the project office closes the warranty with a note.
    await admin((client) =>
      client.query("update machvon.warranty_claim set status = 'VERIFIED', fixed_on = date '2024-06-25', verified_by = $2, verified_at = now() where obligation_id = $1", [
        id,
        membershipOf('lifecycleActivator'),
      ]),
    );
    await open(page, list, 'warrantyManager');
    await line.locator('[data-close]').click();
    await page.locator('#warranty-note').fill('Đã xử lý hết yêu cầu.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.warranty.close.submit'] }).click();
    await expect(line.getByTestId('status')).toHaveText(vi['ast.warranty.status.closed']);
    expect((await warrantiesOf(seeded.handoverId))[0]).toMatchObject({ status: 'CLOSED', closed_by: membershipOf('warrantyManager'), version: '2' });
    await expect(line.locator('[data-close]')).toHaveCount(0);
  });
});
