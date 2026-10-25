import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * LND-10 (site handover by section and km) in a real browser against the real API and database (apps/api/test/e2e-stack): an officer hands the cleared land of a section over to the
 * ACTIVE construction contract in steps, with the share of the whole project computed from the areas; a section whose contract is only signed is refused, and so is an area above
 * the one the section needs; someone who may only read sees the sections and no button. What the screens changed is looked up in the database.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';

interface Seeded {
  projectId: string;
  activeContract: string;
  signedContract: string;
  document: string;
  code: string;
}

/** A project in implementation with two contracts (one ACTIVE, one only SIGNED), a clean document and no section yet; written straight to the database (foreign keys to modules that are not seeded are switched off, as in the stack). */
async function seedProject(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [paper] = await sql<{ id: string }>("select id from machvon.document_version where object_key = 'tenants/e2e/ctr-1.pdf'");
  if (contractor === undefined || paper === undefined) throw new Error('the contract fixtures of the stack are missing');
  const projectId = randomUUID();
  const activeContract = randomUUID();
  const signedContract = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${projectId.slice(0, 4).toUpperCase()}`;
  const code = `E2E-HDV-${suffix}`;
  const officer = membershipOf('landOfficer');
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.project
         (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
      [tenant, projectId, code, `Dự án bàn giao ${suffix}`, stackInfo().units.A[UNIT_CODE], area?.id, officer],
    );
    for (const [contractId, status, label] of [
      [activeContract, 'ACTIVE', 'A'],
      [signedContract, 'SIGNED', 'S'],
    ] as const) {
      await client.query(
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, advance_category)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, 1000, date '2026-01-01', $8::date, 'CONSTRUCTION')`,
        [tenant, contractId, projectId, randomUUID(), contractor.id, `HD-HDV-${label}-${suffix}`, status, status === 'SIGNED' ? null : '2026-01-01'],
      );
    }
  } finally {
    await client.end();
  }
  return { projectId, activeContract, signedContract, document: paper.id, code };
}

async function seedSection(projectId: string, code: string, contractId: string, required: string): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.land_handover_section (tenant_id, id, project_id, contract_id, code, name, from_km, to_km, required_area_m2, status, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 0, 3, $7::numeric, 'NOT_READY', $8, $8)`,
    [stackInfo().tenants.A, id, projectId, contractId, code, `Đoạn ${code}`, required, membershipOf('landOfficer')],
  );
  return id;
}

async function open(page: Page, user: string, projectId: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/lnd/lnd-10?project=${projectId}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const sectionOf = async (id: string) => {
  const [row] = await sql<{ status: string; handed_area_m2: string; handed_over_on: string | null; handover_document_version_id: string | null }>(
    'select status, handed_area_m2::text, handed_over_on::text, handover_document_version_id from machvon.land_handover_section where id = $1',
    [id],
  );
  if (row === undefined) throw new Error('the section is missing');
  return row;
};

const handoverDialog = (page: Page) => page.getByRole('dialog');
const send = async (page: Page, area: string, document: string, day?: string): Promise<void> => {
  await page.locator('#handover-area').fill(area);
  if (day !== undefined) await page.locator('#handover-day').fill(day);
  await page.locator('#handover-document').fill(document);
  await handoverDialog(page).getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
};

test.describe('LND-10: site handover by section and km', () => {
  test('an officer hands a section over to the active contract in steps, and the share of the project follows the areas (AC-ST-LND-009-1, UAT-AC386, UI-LND-10)', async ({ page }) => {
    const seeded = await seedProject();
    const first = await seedSection(seeded.projectId, 'SEC-01', seeded.activeContract, '30000');
    const second = await seedSection(seeded.projectId, 'SEC-02', seeded.signedContract, '28000');

    await open(page, 'landHandover', seeded.projectId);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.sections.page.title'] })).toBeVisible();
    await expect(page.locator('[data-section]')).toHaveCount(2);
    await expect(page.locator('[data-section="SEC-01"] [data-testid="contract"]')).toContainText('HD-HDV-A-');
    await expect(page.getByTestId('total-ratio')).toHaveText(vi['lnd.sections.ratio.value'].replace('{ratio}', '0.00'));

    // 18,000 of 30,000: PARTIAL.
    await page.locator('[data-handover="SEC-01"]').click();
    await handoverDialog(page).getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(handoverDialog(page).getByText(vi['lnd.field.required.error']).first()).toBeVisible();
    await send(page, '30000.01', seeded.document);
    await expect(handoverDialog(page).getByText(vi['lnd.sections.problem.exceeds.error'])).toBeVisible();
    await send(page, '18000', seeded.document);
    await expect(page.locator('[data-section="SEC-01"] [data-testid="status"]')).toHaveText(vi['lnd.sections.status.partial']);
    expect(await sectionOf(first)).toEqual({ status: 'PARTIAL', handed_area_m2: '18000.00', handed_over_on: expect.any(String), handover_document_version_id: seeded.document });

    // The rest of it: HANDED_OVER, and 30,000 of 58,000 is 51.72% of the project.
    await page.locator('[data-handover="SEC-01"]').click();
    await send(page, '30000', seeded.document);
    await expect(page.locator('[data-section="SEC-01"] [data-testid="status"]')).toHaveText(vi['lnd.sections.status.handedOver']);
    await expect(page.locator('[data-handover="SEC-01"]')).toHaveCount(0);
    await expect(page.getByTestId('total-ratio')).toHaveText(vi['lnd.sections.ratio.value'].replace('{ratio}', '51.72'));
    await expect(page.getByTestId('total-sections')).toHaveText('1/2');
    expect((await sectionOf(first)).status).toBe('HANDED_OVER');

    // A contract that is only signed receives nothing.
    await page.locator('[data-handover="SEC-02"]').click();
    await send(page, '10000', seeded.document);
    await expect(page.getByTestId('refusal')).toHaveText(vi['lnd.problem.contractNotActive.error']);
    expect((await sectionOf(second)).status).toBe('NOT_READY');
    expect(await sql<{ n: string }>("select count(*)::text as n from machvon.audit_event where resource_id = $1 and action = 'land.section_handed_over'", [first])).toEqual([{ n: '2' }]);
  });

  test('someone who may only read sees the sections and no button (UI-LND-10)', async ({ page }) => {
    const seeded = await seedProject();
    await seedSection(seeded.projectId, 'SEC-01', seeded.activeContract, '30000');
    await open(page, 'landReader', seeded.projectId);
    await expect(page.locator('[data-section="SEC-01"]')).toBeVisible();
    await expect(page.locator('[data-handover]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['lnd.sections.create.action'] })).toHaveCount(0);
  });

  test('an officer who manages the land creates a section and names no contract yet; nothing can be handed over until one is named (UI-LND-10)', async ({ page }) => {
    const seeded = await seedProject();
    await open(page, 'landOfficer', seeded.projectId);
    await expect(page.getByTestId('no-sections')).toHaveText(vi['lnd.sections.none.notice']);
    await page.getByRole('button', { name: vi['lnd.sections.create.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(vi['lnd.sectionDialog.code.label']).fill('SEC-NEW');
    await dialog.getByLabel(vi['lnd.sectionDialog.name.label']).fill('Đoạn mới');
    await dialog.getByLabel(vi['lnd.sectionDialog.area.label']).fill('12000');
    await dialog.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.locator('[data-section="SEC-NEW"] [data-testid="status"]')).toHaveText(vi['lnd.sections.status.notReady']);
    await expect(page.locator('[data-section="SEC-NEW"] [data-testid="contract"]')).toHaveText(vi['lnd.sections.contract.none']);
    await expect(page.locator('[data-handover]')).toHaveCount(0);
  });
});
