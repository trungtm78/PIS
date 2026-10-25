import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CTR-20, CTR-07 and CTR-19 (the chain of changes of a project) in a real browser against the real API and database (apps/api/test/e2e-stack): the business owner sets the tiers of a
 * project, the contract officer raises the first request, which fixes them (the screen of the policy then shows them locked, and a statement that bypasses the command is refused by the
 * database), and the request is promoted from the change event to the PCO and the CO and the CO is assessed. A reader sees the board and no command. What the screens changed is looked up in
 * the database.
 */

const MAKER = membershipOf('lifecycleMaker');
const VALUE = '1000000';
let counter = 0;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface Seeded {
  projectId: string;
  contractId: string;
  code: string;
  revisionId: string;
}

/** A project of its own (the number of tiers is fixed once, so each case needs one) with an ACTIVE contract and the revision in force, written straight to the database (foreign keys to modules that are not seeded are switched off, as in the stack). */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const projectId = randomUUID();
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const code = `HD-CH-${Date.now().toString(36).toUpperCase()}-${counter}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  if (contractor === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       select tenant_id, $1, $2, 'Dự án thử chuỗi thay đổi', owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, 1, project_group
         from machvon.project where code = 'DA-CTR'`,
      [projectId, `DA-CH-${Date.now().toString(36).toUpperCase()}-${counter}`],
    );
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử chuỗi thay đổi', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, $7::numeric, $7::numeric, 0, $8, $8, $9, date '2026-01-02', $10, $11, date '2026-01-03', $12)`,
      [tenant, contractId, projectId, randomUUID(), contractor.id, code, VALUE, MAKER, MAKER, membershipOf('lifecycleReviewer'), papers[0]?.id, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, $4::numeric, $5, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $6, $6, $7, now())`,
      [tenant, revisionId, contractId, VALUE, papers[0]?.id, MAKER, membershipOf('lifecycleActivator')],
    );
  } finally {
    await client.end();
  }
  return { projectId, contractId, code, revisionId };
}

const configOf = async (projectId: string) => {
  const [row] = await sql<{ tier_count: number; locked_at: string | null; locked_by_change_id: string | null }>('select tier_count, locked_at::text, locked_by_change_id from machvon.change_chain_config where project_id = $1', [projectId]);
  return row;
};

const requestsOf = (contractId: string) =>
  sql<{ id: string; code: string; stage: string; status: string; parent_id: string | null; evaluated_delta_vnd: string | null; schedule_impact_days: number; funding_impact_note: string | null; evaluated_by: string | null }>(
    'select id, code, stage, status, parent_id, evaluated_delta_vnd::text, schedule_impact_days, funding_impact_note, evaluated_by from machvon.change_request where contract_id = $1 order by created_at, id',
    [contractId],
  );

/** Presses a command of the card of a request on the board. */
const press = (page: Page, requestId: string, command: 'promote' | 'evaluate' | 'withdraw') => page.locator(`[data-request="${requestId}"] [data-command="${command}"]`).click();

test.describe('the chain of changes of a project', () => {
  test('the owner sets the tiers, the first request locks them, and a statement that bypasses the command is refused (UI-CTR-20, UI-CTR-07, AC-ST-CTR-006-1, UAT-AC307)', async ({ page }) => {
    const seeded = await seed();

    await open(page, `/ctr/ctr-20?project=${seeded.projectId}`, 'changeOwner');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.change.tiers.page.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['ctr.change.tiers.submit'] }).click();
    await expect(page.getByText(vi['ctr.change.problem.required'])).toBeVisible();
    await page.locator('input[data-tiers="2"]').check();
    await page.getByRole('button', { name: vi['ctr.change.tiers.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.change.tiers.done.notice']);
    expect(await configOf(seeded.projectId)).toMatchObject({ tier_count: 2, locked_at: null });
    // Until the first request it can be set again.
    await page.locator('input[data-tiers="3"]').check();
    await page.getByRole('button', { name: vi['ctr.change.tiers.submit'] }).click();
    await expect.poll(async () => (await configOf(seeded.projectId))?.tier_count).toBe(3);

    // The officer raises the first request: the form says it fixes the tiers, and starts the chain at the change event.
    await open(page, `/ctr/ctr-07?contract=${seeded.contractId}`, 'changeOfficer');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.change.request.title'] })).toBeVisible();
    await expect(page.getByTestId('contract-code')).toHaveText(seeded.code);
    await expect(page.getByTestId('locks-notice')).toBeVisible();
    await expect(page.getByTestId('start-stage')).toContainText('ChangeEvent');
    await page.getByRole('button', { name: vi['ctr.change.request.submit'] }).click();
    await expect(page.getByText(vi['ctr.change.problem.required'])).toBeVisible();
    await page.locator('#request-reason').fill('Chủ đầu tư yêu cầu mở rộng vỉa hè.');
    await page.locator('#request-kind').selectOption('OWNER_INSTRUCTION');
    await page.locator('#request-estimated').fill('400000');
    await page.locator('#request-days').fill('10');
    await page.getByRole('button', { name: vi['ctr.change.request.submit'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['ctr.change.request.done.notice']);
    await expect(page.getByTestId('requests').getByRole('link', { name: 'CE-001' })).toBeVisible();
    await expect(page.getByTestId('locks-notice')).toHaveCount(0);
    const [first] = await requestsOf(seeded.contractId);
    expect(first).toMatchObject({ code: 'CE-001', stage: 'EVENT', status: 'SUBMITTED' });
    expect(await configOf(seeded.projectId)).toMatchObject({ tier_count: 3, locked_by_change_id: first?.id });
    expect((await configOf(seeded.projectId))?.locked_at).not.toBeNull();

    // The policy now shows the tiers locked by that request, and offers no way to change them.
    await open(page, `/ctr/ctr-20?project=${seeded.projectId}`, 'changeOwner');
    await expect(page.getByTestId('locked-notice')).toContainText('CE-001');
    await expect(page.locator('input[name="tier-count"]:disabled')).toHaveCount(3);
    await expect(page.getByRole('button', { name: vi['ctr.change.tiers.submit'] })).toHaveCount(0);

    // A statement that bypasses the command is refused by the database itself (SQLSTATE 23514).
    await expect(sql('update machvon.change_chain_config set tier_count = 2 where project_id = $1', [seeded.projectId])).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('CHANGE_TIERS_LOCKED') });
    await expect(sql('update machvon.change_chain_config set locked_at = null, locked_by_change_id = null where project_id = $1', [seeded.projectId])).rejects.toMatchObject({ code: '23514' });
    expect(await configOf(seeded.projectId)).toMatchObject({ tier_count: 3 });
  });

  test('a project of one tier starts at the CO, and the form says where it starts (UI-CTR-07, AC-ST-CTR-006-1, UAT-AC307)', async ({ page }) => {
    const seeded = await seed();
    await open(page, `/ctr/ctr-07?contract=${seeded.contractId}`, 'changeOfficer');
    await expect(page.getByTestId('not-configured')).toContainText(vi['ctr.change.request.notConfigured']);
    await open(page, `/ctr/ctr-20?project=${seeded.projectId}`, 'changeOwner');
    await page.locator('input[data-tiers="1"]').check();
    await page.getByRole('button', { name: vi['ctr.change.tiers.submit'] }).click();
    await expect(page.getByTestId('done')).toBeVisible();

    await open(page, `/ctr/ctr-07?contract=${seeded.contractId}`, 'changeOfficer');
    await expect(page.getByTestId('start-stage')).toContainText('CO');
    await page.locator('#request-reason').fill('Điều chỉnh trực tiếp bằng phụ lục.');
    await page.getByRole('button', { name: vi['ctr.change.request.submit'] }).click();
    await expect(page.getByTestId('done')).toBeVisible();
    expect(await requestsOf(seeded.contractId)).toMatchObject([{ code: 'CO-001', stage: 'CO', status: 'SUBMITTED' }]);
  });

  test('the request is promoted from the change event to the PCO and the CO, and the CO is assessed with cost, schedule, scope and funding (UI-CTR-19, AC-ST-CTR-006-2, UAT-AC308)', async ({ page }) => {
    const seeded = await seed();
    await open(page, `/ctr/ctr-20?project=${seeded.projectId}`, 'changeOwner');
    await page.locator('input[data-tiers="3"]').check();
    await page.getByRole('button', { name: vi['ctr.change.tiers.submit'] }).click();
    await expect(page.getByTestId('done')).toBeVisible();
    await open(page, `/ctr/ctr-07?contract=${seeded.contractId}`, 'changeOfficer');
    await page.locator('#request-reason').fill('Điều kiện địa chất khác hồ sơ khảo sát.');
    await page.locator('#request-estimated').fill('400000');
    await page.getByRole('button', { name: vi['ctr.change.request.submit'] }).click();
    await expect(page.getByTestId('done')).toBeVisible();
    const [event] = await requestsOf(seeded.contractId);

    // The officer promotes it to the PCO, then the PCO to the CO.
    await open(page, `/ctr/ctr-19?project=${seeded.projectId}`, 'changeOfficer');
    await expect(page.getByRole('heading', { level: 1, name: vi['ctr.change.board.title'] })).toBeVisible();
    await expect(page.locator('[data-stage]')).toHaveCount(3);
    await expect(page.getByTestId('locked')).toBeVisible();
    await press(page, event?.id ?? '', 'promote');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.change.promote.submit'] }).click();
    await expect(page.getByText(vi['ctr.change.problem.required'])).toBeVisible();
    await page.locator('#change-reason').fill('Sự kiện là thay đổi cần định giá.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.change.promote.submit'] }).click();
    await expect(page.locator('[data-stage="PCO"] [data-testid="request-code"]')).toHaveText('PCO-001');
    const afterEvent = await requestsOf(seeded.contractId);
    expect(afterEvent.map((request) => [request.code, request.status])).toEqual([
      ['CE-001', 'PROMOTED'],
      ['PCO-001', 'SUBMITTED'],
    ]);
    const pco = afterEvent[1];
    await press(page, pco?.id ?? '', 'promote');
    await page.locator('#change-reason').fill('Giá đã thống nhất.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.change.promote.submit'] }).click();
    await expect(page.locator('[data-stage="CO"] [data-testid="request-code"]')).toHaveText('CO-001');
    const co = (await requestsOf(seeded.contractId))[2];
    expect(co).toMatchObject({ code: 'CO-001', stage: 'CO', status: 'SUBMITTED', parent_id: pco?.id });
    // The officer promotes and withdraws; assessing is for someone else.
    await expect(page.locator(`[data-request="${co?.id}"] [data-command="evaluate"]`)).toHaveCount(0);
    await expect(page.locator(`[data-request="${co?.id}"] [data-command="promote"]`)).toHaveCount(0);

    // The evaluator assesses the CO: a decrease needs no line of capital; an increase is asked for one before anything is sent.
    await open(page, `/ctr/ctr-19?project=${seeded.projectId}`, 'changeEvaluator');
    await press(page, co?.id ?? '', 'evaluate');
    await page.locator('#change-evaluated').fill('500000');
    await page.locator('#change-days').fill('20');
    await page.locator('#change-funding').fill('Chi từ dòng vốn của kế hoạch.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.change.evaluate.submit'] }).click();
    await expect(page.getByText(vi['ctr.change.problem.required'])).toBeVisible();
    await page.locator('#change-evaluated').fill('-5000');
    await page.locator('#change-scope').fill('Giảm khối lượng đào đắp.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.change.evaluate.submit'] }).click();
    await expect(page.locator(`[data-request="${co?.id}"] [data-testid="change-status"]`)).toHaveText(vi['ctr.change.status.evaluated']);
    await expect(page.locator(`[data-request="${co?.id}"] [data-testid="evaluated"]`)).toContainText('-5.000');
    const assessed = (await requestsOf(seeded.contractId))[2];
    expect(assessed).toMatchObject({ status: 'EVALUATED', evaluated_delta_vnd: '-5000', schedule_impact_days: 20, funding_impact_note: 'Chi từ dòng vốn của kế hoạch.', evaluated_by: membershipOf('changeEvaluator') });
    expect((await requestsOf(seeded.contractId)).slice(0, 2).map((request) => request.status)).toEqual(['PROMOTED', 'PROMOTED']);
  });

  test('a request is withdrawn with a reason, and a reader sees the board and no command (UI-CTR-19)', async ({ page }) => {
    const seeded = await seed();
    await open(page, `/ctr/ctr-20?project=${seeded.projectId}`, 'changeOwner');
    await page.locator('input[data-tiers="3"]').check();
    await page.getByRole('button', { name: vi['ctr.change.tiers.submit'] }).click();
    await expect(page.getByTestId('done')).toBeVisible();
    await open(page, `/ctr/ctr-07?contract=${seeded.contractId}`, 'changeOfficer');
    await page.locator('#request-reason').fill('Yêu cầu lập nhầm.');
    await page.getByRole('button', { name: vi['ctr.change.request.submit'] }).click();
    await expect(page.getByTestId('done')).toBeVisible();
    const [event] = await requestsOf(seeded.contractId);

    await open(page, `/ctr/ctr-19?project=${seeded.projectId}&contract=${seeded.contractId}`, 'changeReader');
    await expect(page.locator(`[data-request="${event?.id}"]`)).toBeVisible();
    await expect(page.locator('[data-command]')).toHaveCount(0);
    await expect(page.getByTestId('tiers-link')).toHaveCount(0);
    await expect(page.getByTestId('open-link')).toHaveCount(0);

    await open(page, `/ctr/ctr-19?project=${seeded.projectId}`, 'changeOfficer');
    await press(page, event?.id ?? '', 'withdraw');
    await page.locator('#change-reason').fill('Lập nhầm hợp đồng.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ctr.change.withdraw.submit'] }).click();
    await expect(page.locator(`[data-request="${event?.id}"] [data-testid="change-status"]`)).toHaveText(vi['ctr.change.status.withdrawn']);
    expect(await requestsOf(seeded.contractId)).toMatchObject([{ status: 'WITHDRAWN' }]);
    await expect(page.locator('[data-command]')).toHaveCount(0);
  });
});
