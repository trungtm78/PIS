import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * AST-03 (the asset dossier) in a real browser against the real API and database (apps/api/test/e2e-stack): the accountant registers an asset of an accepted handover and is refused in words when the
 * assets would come to more than the contract is worth or the code is used; the operating unit transfers it with the dossier of the commissioning and the code typed by hand, and the screen shows
 * what is left of the contract. What the screens changed is looked up in the database.
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
  documentVersionId: string;
  unitId: string;
}

/** An ACTIVE contract worth 1,200,000 with an accepted handover, written straight to the database (foreign keys to modules that are not seeded are switched off). */
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
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử tài sản', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, `HD-TS-${suffix}`, MAKER, membershipOf('lifecycleReviewer'), documentVersionId, membershipOf('lifecycleActivator')],
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
      [tenant, handoverId, project.id, contractId, unit.id, documentVersionId, `BG-TS-${suffix}`, MAKER, membershipOf('lifecycleActivator')],
    );
  } finally {
    await client.end();
  }
  return { contractId, handoverId, documentVersionId, unitId: unit.id };
}

interface AssetRow {
  id: string;
  asset_code: string;
  name: string;
  status: string;
  value_vnd: string;
  value_basis: string;
  external_asset_id: string | null;
  transferred_by: string | null;
  commissioning_document_version_id: string | null;
  version: string;
}

const assetsOf = (handoverId: string) =>
  sql<AssetRow>(
    'select id, asset_code, name, status, value_vnd::text, value_basis, external_asset_id, transferred_by, commissioning_document_version_id, version::text from machvon.asset_record where handover_id = $1 order by created_at, id',
    [handoverId],
  );

const fill = async (page: Page, values: Record<string, string>): Promise<void> => {
  for (const [id, value] of Object.entries(values)) await page.locator(`#${id}`).fill(value);
};

test.describe('the asset dossier', () => {
  test('the accountant registers assets within the value of the contract, and the operating unit transfers one with the dossier of the commissioning (UI-AST-03, AC-ST-AST-002-1, UAT-AC389)', async ({
    page,
  }) => {
    const seeded = await seed();
    const list = `/ast/ast-03?handover=${seeded.handoverId}`;

    await open(page, list, 'assetAccountant');
    await expect(page.getByRole('heading', { level: 1, name: vi['ast.asset.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-assets')).toHaveText(vi['ast.asset.none.notice']);

    // An empty form says what is missing, and nothing is sent.
    await page.getByRole('button', { name: vi['ast.asset.register.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.asset.register.submit'] }).click();
    await expect(page.getByText(vi['ast.asset.problem.required']).first()).toBeVisible();
    await page.getByRole('button', { name: vi['ast.asset.dialog.cancel'] }).click();
    expect(await assetsOf(seeded.handoverId)).toHaveLength(0);

    // An asset worth more than the whole contract is refused with the figures.
    await page.getByRole('button', { name: vi['ast.asset.register.action'] }).click();
    await expect.poll(async () => page.locator('#asset-unit option').count()).toBeGreaterThan(1);
    await page.locator('#asset-unit').selectOption({ index: 1 });
    await fill(page, { 'asset-code': 'TS-001', 'asset-name': 'Trạm bơm số 1', 'asset-value': '1200001' });
    await page.locator('#asset-basis').selectOption('CONTRACT_VALUE');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.asset.register.submit'] }).click();
    await expect(page.getByTestId('refusal')).toContainText(vi['ast.asset.error.valueExceeds']);
    expect(await assetsOf(seeded.handoverId)).toHaveLength(0);

    // Within the value, the asset is registered and the screen shows what is left of the contract.
    await page.locator('#asset-value').fill('700000');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.asset.register.submit'] }).click();
    await expect(page.getByTestId('assets')).toBeVisible();
    const [first] = await assetsOf(seeded.handoverId);
    expect(first).toMatchObject({ asset_code: 'TS-001', name: 'Trạm bơm số 1', status: 'REGISTERED', value_vnd: '700000', value_basis: 'CONTRACT_VALUE', external_asset_id: null, version: '1' });
    const id = first?.id ?? '';
    const line = page.locator(`tr[data-asset="${id}"]`);
    await expect(line.getByTestId('status')).toHaveText(vi['ast.asset.status.registered']);
    await expect(line.getByTestId('external')).toHaveText(vi['ast.asset.external.manual']);
    await expect(line.getByTestId('remaining')).toContainText('500.000');

    // The same code is refused, and so is an asset that would take the contract past its value.
    await page.getByRole('button', { name: vi['ast.asset.register.action'] }).click();
    await expect.poll(async () => page.locator('#asset-unit option').count()).toBeGreaterThan(1);
    await page.locator('#asset-unit').selectOption({ index: 1 });
    await fill(page, { 'asset-code': 'TS-001', 'asset-name': 'Trạm bơm khác', 'asset-value': '100' });
    await page.locator('#asset-basis').selectOption('APPRAISED_VALUE');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.asset.register.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['ast.asset.error.duplicate']);
    await page.locator('#asset-code').fill('TS-002');
    await page.locator('#asset-value').fill('500001');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.asset.register.submit'] }).click();
    await expect(page.getByTestId('refusal')).toContainText(vi['ast.asset.error.valueExceeds']);
    await page.getByRole('button', { name: vi['ast.asset.dialog.cancel'] }).click();
    expect(await assetsOf(seeded.handoverId)).toHaveLength(1);

    // The accountant does not transfer; the operating unit does, with the dossier of the commissioning and the code typed by hand.
    await expect(line.locator('[data-transfer]')).toHaveCount(0);
    await open(page, list, 'assetOperator');
    await expect(page.getByRole('button', { name: vi['ast.asset.register.action'] })).toHaveCount(0);
    await line.locator('[data-transfer]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.asset.transfer.submit'] }).click();
    await expect(page.getByText(vi['ast.asset.problem.required']).first()).toBeVisible();
    await page.locator('#transfer-document').fill(seeded.documentVersionId);
    await page.locator('#transfer-external').fill('TSC-2026-0001');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.asset.transfer.submit'] }).click();
    await expect(line.getByTestId('status')).toHaveText(vi['ast.asset.status.transferred']);
    await expect(line.getByTestId('external')).toHaveText('TSC-2026-0001');
    expect((await assetsOf(seeded.handoverId))[0]).toMatchObject({
      status: 'TRANSFERRED',
      external_asset_id: 'TSC-2026-0001',
      transferred_by: membershipOf('assetOperator'),
      commissioning_document_version_id: seeded.documentVersionId,
      version: '2',
    });
    await expect(line.locator('[data-transfer]')).toHaveCount(0);
  });
});
