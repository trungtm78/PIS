import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CTR-03 (the review, the signing and the activation of a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the maker sends a draft whose bill
 * of quantities adds up to review and sees the commands that apply; the reviewer gives it back with the reason, the maker sends it again, and the reviewer signs it with a clean file
 * under the delegation limit of the matrix; the maker, who holds no permission to sign, is offered no command on it. The activation is refused while the conditions stand open, and the
 * contract stays signed. What the screens changed is looked up in the database.
 */

const MAKER = membershipOf('lifecycleMaker');
const VALUE = '1000000';
let counter = 0;
const code = (): string => {
  counter += 1;
  return `HD-LC-${Date.now().toString(36).toUpperCase()}-${counter}`;
};

async function open(page: Page, contractId: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/ctr/ctr-03?id=${contractId}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface Seeded {
  contractId: string;
  code: string;
}

/** A contract of the project of the stack with its first revision and a bill of quantities that adds up; foreign keys to modules that are not seeded are switched off, as in the stack. */
async function seedContract(status: 'DRAFT' | 'SIGNED'): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  if (project === undefined || contractor === undefined || papers.length < 2) throw new Error('the contract fixtures of the stack are missing');
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const contractCode = code();
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    const [plan] = (await client.query('select id from machvon.plan_version where project_id = $1 and status = $2', [project.id, 'APPROVED'])).rows;
    if (plan === undefined) {
      await client.query(
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at)
         values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now())`,
        [tenant, randomUUID(), project.id, randomUUID()],
      );
    }
    const signed = status === 'SIGNED';
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, submitted_at, signed_on, signed_by, signed_document_version_id)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử vòng đời', 'UNIT_PRICE', 'VND', $7, 1, $8::numeric, $8::numeric, 0, $9, $9,
               $10, $11::timestamptz, $12::date, $13, $14)`,
      [
        tenant,
        contractId,
        project.id,
        randomUUID(),
        contractor.id,
        contractCode,
        status,
        VALUE,
        MAKER,
        signed ? MAKER : null,
        signed ? new Date().toISOString() : null,
        signed ? new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10) : null,
        signed ? membershipOf('lifecycleReviewer') : null,
        signed ? papers[0]?.id : null,
      ],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
       values ($1, $2, $3, 1, $4::numeric, $5, date '2026-01-01', 'DRAFT', 'BASE', 1, $6, $6)`,
      [tenant, revisionId, contractId, VALUE, papers[0]?.id, MAKER],
    );
    await client.query(
      `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, created_by)
       values ($1, gen_random_uuid(), $2, $3, gen_random_uuid(), 1, 'B01', 'Công việc', 'LS', 1, $4, 'HALF_UP', $4, $5)`,
      [tenant, revisionId, contractId, VALUE, MAKER],
    );
  } finally {
    await client.end();
  }
  return { contractId, code: contractCode };
}

const statusOf = async (contractId: string): Promise<{ status: string; submitted_by: string | null; signed_by: string | null; status_reason: string | null }> => {
  const [row] = await sql<{ status: string; submitted_by: string | null; signed_by: string | null; status_reason: string | null }>(
    'select status, submitted_by, signed_by, status_reason from machvon.contract where id = $1',
    [contractId],
  );
  if (row === undefined) throw new Error('the contract is missing');
  return row;
};

const commands = (page: Page) => page.locator('[data-testid="commands"] [data-command]');

test.describe('CTR-03: the review, the signing and the activation of a contract', () => {
  test('the maker sends a draft to review; the reviewer gives it back with the reason, the maker sends it again and the reviewer signs it (UI-CTR-03, AC-ST-CTR-004-1, UAT-AC56)', async ({ page }) => {
    const seeded = await seedContract('DRAFT');

    await open(page, seeded.contractId, 'lifecycleMaker');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.workspace.page.title'] })).toBeVisible();
    await expect(page.getByTestId('contract-code')).toHaveText(seeded.code);
    await expect(page.getByTestId('status')).toHaveText(vi['ctr.status.draft.label']);
    await expect(page.locator('[data-check="boq"]')).toHaveAttribute('data-ok', 'true');
    await expect(commands(page)).toHaveCount(2);
    await expect(page.locator('[data-command="submit"]')).toBeVisible();
    await expect(page.locator('[data-command="cancel"]')).toBeVisible();
    await page.locator('[data-command="submit"]').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(vi['ctr.workspace.submit.field']).fill('Hồ sơ đã đủ, trình lãnh đạo.');
    await dialog.getByRole('button', { name: vi['ctr.workspace.submit.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['ctr.status.inReview.label']);
    expect(await statusOf(seeded.contractId)).toMatchObject({ status: 'IN_REVIEW', submitted_by: MAKER });
    // The maker holds no permission to give back or to sign: the only command left is the cancellation.
    await expect(commands(page)).toHaveCount(1);
    await expect(page.locator('[data-command="cancel"]')).toBeVisible();

    await open(page, seeded.contractId, 'lifecycleReviewer');
    await expect(commands(page)).toHaveCount(2);
    await page.locator('[data-command="return"]').click();
    await dialog.getByRole('button', { name: vi['ctr.workspace.return.submit'] }).click();
    await expect(dialog.getByText(vi['ctr.workspace.problem.required'])).toBeVisible();
    await dialog.getByLabel(vi['ctr.workspace.return.field']).fill('Bảng khối lượng cần soát lại.');
    await dialog.getByRole('button', { name: vi['ctr.workspace.return.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['ctr.status.draft.label']);
    expect(await statusOf(seeded.contractId)).toMatchObject({ status: 'DRAFT', submitted_by: null, status_reason: 'Bảng khối lượng cần soát lại.' });
    await expect(page.getByTestId('history').locator('li')).toHaveCount(2);

    await open(page, seeded.contractId, 'lifecycleMaker');
    await page.locator('[data-command="submit"]').click();
    await dialog.getByRole('button', { name: vi['ctr.workspace.submit.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['ctr.status.inReview.label']);

    await open(page, seeded.contractId, 'lifecycleReviewer');
    const [paper] = await sql<{ id: string }>("select id from machvon.document_version where object_key = 'tenants/e2e/ctr-2.pdf'");
    await page.locator('[data-command="sign"]').click();
    await dialog.getByLabel(vi['ctr.workspace.sign.document']).fill('not-an-id');
    await dialog.getByRole('button', { name: vi['ctr.workspace.sign.submit'] }).click();
    await expect(dialog.getByText(vi['ctr.workspace.problem.uuid'])).toBeVisible();
    await dialog.getByLabel(vi['ctr.workspace.sign.document']).fill(paper?.id ?? '');
    await dialog.getByRole('button', { name: vi['ctr.workspace.sign.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['ctr.status.signed.label']);
    expect(await statusOf(seeded.contractId)).toMatchObject({ status: 'SIGNED', signed_by: membershipOf('lifecycleReviewer') });
    await expect(page.getByTestId('signed-on')).toBeVisible();
    await expect(page.getByTestId('history').locator('li')).toHaveCount(4);
  });

  test('the activation is refused while the conditions stand open, and the contract stays signed (AC-ST-CTR-004-2, UAT-AC302)', async ({ page }) => {
    const seeded = await seedContract('SIGNED');

    await open(page, seeded.contractId, 'lifecycleActivator');
    await expect(page.getByTestId('status')).toHaveText(vi['ctr.status.signed.label']);
    await expect(page.getByTestId('checks')).toBeVisible();
    await page.locator('[data-command="activate"]').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(vi['ctr.workspace.activate.reason']).fill('Các điều kiện đã đủ.');
    await dialog.getByRole('button', { name: vi['ctr.workspace.activate.submit'] }).click();
    await expect(dialog.getByTestId('refusal')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect((await statusOf(seeded.contractId)).status).toBe('SIGNED');
    const ledger = await sql<{ n: string }>('select count(*)::text as n from machvon.capital_ledger_entry where source_ref_id = $1', [seeded.contractId]);
    expect(ledger[0]?.n).toBe('0');
  });

  test('someone who may read the contract and nothing more sees the contract and no command (UI-CTR-03)', async ({ page }) => {
    const seeded = await seedContract('DRAFT');
    await open(page, seeded.contractId, 'ctrReader');
    await expect(page.getByTestId('contract-code')).toHaveText(seeded.code);
    await expect(commands(page)).toHaveCount(0);
  });
});
