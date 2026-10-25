import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * AST-01 and AST-02 (the handover of a work and its punch list) in a real browser against the real API and database (apps/api/test/e2e-stack): the project office drafts a handover on the approved
 * completion minutes and lists a critical and a minor defect; the receiving unit is refused in words while the critical one is open, and the critical one is never offered a waiver; the contractor
 * says it is put right with a photo, the verifier gives it back once and verifies it the second time and waives the minor one; the receiving unit then accepts with the as-built dossier. What the
 * screens changed is looked up in the database.
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
  projectId: string;
  documentVersionId: string;
  minutesId: string;
  photoId: string;
}

/** An ACTIVE contract with approved completion minutes and a clean photo, written straight to the database (foreign keys to modules that are not seeded are switched off). */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const minutesId = randomUUID();
  const photoId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' and scan_status = 'CLEAN' order by object_key");
  if (contractor === undefined || project === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const documentVersionId = papers[0]?.id ?? '';
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử bàn giao', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, `HD-BG-${suffix}`, MAKER, membershipOf('lifecycleReviewer'), documentVersionId, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, documentVersionId, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    await client.query(
      `insert into machvon.quality_acceptance
         (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version, approved_at, approved_by, decision_note)
       values ($1, $2, $3, $4, $5, $6, 'COMPLETION', $7, 'APPROVED', '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $8, $8, 1, timestamptz '2026-10-01T03:00:00Z', $9, 'Approved for the test.')`,
      [tenant, minutesId, project.id, contractId, randomUUID(), `QA-BG-${suffix}`, documentVersionId, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.site_photo (tenant_id, id, project_id, contract_id, client_operation_id, object_key, file_sha256, scan_status, uploaded_by, created_by)
       values ($1, $2, $3, $4, gen_random_uuid(), 'tenants/e2e/photo.jpg', repeat('a', 64), 'CLEAN', $5, $5)`,
      [tenant, photoId, project.id, contractId, MAKER],
    );
  } finally {
    await client.end();
  }
  return { contractId, projectId: project.id, documentVersionId, minutesId, photoId };
}

interface HandoverRow {
  id: string;
  handover_no: string;
  status: string;
  handover_kind: string;
  open_critical_punch_count: number;
  accepted_by: string | null;
  as_built_document_version_id: string | null;
  version: string;
}

interface ItemRow {
  id: string;
  item_no: number;
  severity: string;
  status: string;
  fixed_by: string | null;
  verified_by: string | null;
  waiver_approved_by: string | null;
  reopen_count: number;
}

const handoversOf = (contractId: string) =>
  sql<HandoverRow>(
    'select id, handover_no, status, handover_kind, open_critical_punch_count, accepted_by, as_built_document_version_id, version::text from machvon.handover where contract_id = $1 order by created_at, id',
    [contractId],
  );
const itemsOf = (handoverId: string) =>
  sql<ItemRow>('select id, item_no, severity, status, fixed_by, verified_by, waiver_approved_by, reopen_count from machvon.handover_punch_item where handover_id = $1 order by item_no', [handoverId]);

const row = (page: Page, itemId: string) => page.locator(`[data-item="${itemId}"]`);

test.describe('the handover of a work', () => {
  test('the project office drafts and lists the defects, the contractor puts them right, the verifier verifies and waives, and the receiving unit accepts (UI-AST-01, UI-AST-02, AC-ST-AST-001-1, AC-ST-AST-001-2, UAT-AC65, UAT-AC388)', async ({
    page,
  }) => {
    const seeded = await seed();
    const list = `/ast/ast-01?contract=${seeded.contractId}`;

    await open(page, list, 'handoverDrafter');
    await expect(page.getByRole('heading', { level: 1, name: vi['ast.handover.list.title'] })).toBeVisible();
    await expect(page.getByTestId('no-handovers')).toHaveText(vi['ast.handover.none.notice']);

    // An empty form says what is missing, and nothing is sent.
    await page.getByRole('button', { name: vi['ast.handover.create.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.create.submit'] }).click();
    await expect(page.getByText(vi['ast.handover.problem.required']).first()).toBeVisible();
    await page.getByRole('button', { name: vi['ast.handover.dialog.cancel'] }).click();
    expect(await handoversOf(seeded.contractId)).toHaveLength(0);

    // The handover of the completion is drafted on the approved completion minutes, to a unit of the tenant.
    await page.getByRole('button', { name: vi['ast.handover.create.action'] }).click();
    await page.locator('#handover-kind').selectOption('COMPLETION');
    await page.locator('#handover-no').fill('BG-001');
    await expect.poll(async () => page.locator('#handover-unit option').count()).toBeGreaterThan(1);
    await page.locator('#handover-unit').selectOption({ index: 1 });
    await page.locator('#handover-minutes').fill(seeded.minutesId);
    await page.locator('#handover-document').fill(seeded.documentVersionId);
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.create.submit'] }).click();
    await expect(page.getByTestId('handovers')).toBeVisible();
    const [drafted] = await handoversOf(seeded.contractId);
    expect(drafted).toMatchObject({ handover_no: 'BG-001', status: 'DRAFT', handover_kind: 'COMPLETION', open_critical_punch_count: 0, version: '1' });
    const id = drafted?.id ?? '';
    await expect(page.locator(`[data-handover="${id}"]`).getByTestId('status')).toHaveText(vi['ast.handover.status.draft']);

    // The handover is opened, and the defects are listed: a critical one and a minor one.
    await page.locator(`[data-open="${id}"]`).click();
    await expect(page.getByTestId('handover-no')).toHaveText('BG-001');
    await page.locator('[data-command="add-item"]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.item.submit'] }).click();
    await expect(page.getByText(vi['ast.handover.problem.required']).first()).toBeVisible();
    await page.locator('#item-description').fill('Tay vịn cầu thang lỏng.');
    await page.locator('#item-severity').selectOption('CRITICAL');
    await page.locator('#item-due').fill('2999-01-01');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.item.submit'] }).click();
    await expect(page.getByTestId('critical-notice')).toHaveText(vi['ast.handover.critical.notice'].replace('{count}', '1'));
    await page.locator('[data-command="add-item"]').click();
    await page.locator('#item-description').fill('Một viên gạch bị mẻ.');
    await page.locator('#item-severity').selectOption('MINOR');
    await page.locator('#item-due').fill('2999-01-01');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.item.submit'] }).click();
    await expect(page.locator('[data-item]')).toHaveCount(2);
    const [critical, minor] = await itemsOf(id);
    expect(critical).toMatchObject({ item_no: 1, severity: 'CRITICAL', status: 'OPEN' });
    expect(minor).toMatchObject({ item_no: 2, severity: 'MINOR', status: 'OPEN' });
    expect((await handoversOf(seeded.contractId))[0]).toMatchObject({ status: 'PUNCH_PENDING', open_critical_punch_count: 1 });
    const trace = `/ast/ast-02?id=${id}`;

    // The receiving unit is told in words that a critical defect is open; the minor defect is waived by the verifier, the critical one is never offered a waiver.
    await open(page, trace, 'handoverReceiver');
    await expect(page.getByTestId('critical-notice')).toBeVisible();
    await page.locator('[data-command="decide"]').click();
    await page.locator('#decide-decision').selectOption('approve');
    await page.locator('#decide-reason').fill('Đủ điều kiện nhận bàn giao.');
    await page.locator('#decide-as-built').fill(seeded.documentVersionId);
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.decide.submit'] }).click();
    await expect(page.getByTestId('refusal')).toContainText(vi['ast.handover.error.openCritical']);
    await expect(page.getByTestId('refusal')).toContainText('1');
    expect((await handoversOf(seeded.contractId))[0]?.status).toBe('PUNCH_PENDING');

    await open(page, trace, 'handoverVerifier');
    await expect(row(page, critical?.id ?? '').locator('[data-waive]')).toHaveCount(0);
    await row(page, minor?.id ?? '')
      .locator('[data-waive]')
      .click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.waive.submit'] }).click();
    await expect(page.getByText(vi['ast.handover.problem.required'])).toBeVisible();
    await page.locator('#waive-reason').fill('Chỉ là thẩm mỹ, đơn vị nhận chấp nhận.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.waive.submit'] }).click();
    await expect(row(page, minor?.id ?? '')).toHaveAttribute('data-status', 'WAIVED');
    expect((await itemsOf(id))[1]).toMatchObject({ status: 'WAIVED', waiver_approved_by: membershipOf('handoverVerifier') });

    // The contractor says the critical defect is put right with a photo; the verifier gives it back once and verifies the second answer.
    await open(page, trace, 'handoverContractor');
    await row(page, critical?.id ?? '')
      .locator('[data-fix]')
      .click();
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.fix.submit'] }).click();
    await expect(page.getByText(vi['ast.handover.problem.required']).first()).toBeVisible();
    await page.locator('#fix-photo').fill(seeded.photoId);
    await page.locator('#fix-note').fill('Đã siết chặt lại tay vịn.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.fix.submit'] }).click();
    await expect(row(page, critical?.id ?? '')).toHaveAttribute('data-status', 'FIXED');
    expect((await itemsOf(id))[0]).toMatchObject({ status: 'FIXED', fixed_by: membershipOf('handoverContractor') });

    await open(page, trace, 'handoverVerifier');
    await row(page, critical?.id ?? '')
      .locator('[data-verify]')
      .click();
    await expect(page.getByTestId('verify-fixed')).toContainText('siết chặt');
    await page.locator('#verify-outcome').selectOption('REOPEN');
    await page.locator('#verify-note').fill('Vẫn còn rung.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.verify.submit'] }).click();
    await expect(row(page, critical?.id ?? '')).toHaveAttribute('data-status', 'OPEN');
    expect((await itemsOf(id))[0]).toMatchObject({ status: 'OPEN', reopen_count: 1, fixed_by: null });

    await open(page, trace, 'handoverContractor');
    await row(page, critical?.id ?? '')
      .locator('[data-fix]')
      .click();
    await page.locator('#fix-photo').fill(seeded.photoId);
    await page.locator('#fix-note').fill('Đã hàn lại chân tay vịn.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.fix.submit'] }).click();
    await expect(row(page, critical?.id ?? '')).toHaveAttribute('data-status', 'FIXED');
    // The contractor does not verify its own answer.
    await expect(row(page, critical?.id ?? '').locator('[data-verify]')).toHaveCount(0);

    await open(page, trace, 'handoverVerifier');
    await row(page, critical?.id ?? '')
      .locator('[data-verify]')
      .click();
    await page.locator('#verify-outcome').selectOption('VERIFIED');
    await page.locator('#verify-note').fill('Đã kiểm tra lại, chắc chắn.');
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.verify.submit'] }).click();
    await expect(row(page, critical?.id ?? '')).toHaveAttribute('data-status', 'VERIFIED');
    expect((await itemsOf(id))[0]).toMatchObject({ status: 'VERIFIED', verified_by: membershipOf('handoverVerifier') });
    expect((await handoversOf(seeded.contractId))[0]).toMatchObject({ status: 'PUNCH_PENDING', open_critical_punch_count: 0 });

    // The drafter does not accept the handover it drew up; the receiving unit does, with the as-built dossier.
    await open(page, trace, 'handoverDrafter');
    await expect(page.locator('[data-command="decide"]')).toHaveCount(0);
    await open(page, trace, 'handoverReceiver');
    await expect(page.getByTestId('critical-notice')).toHaveCount(0);
    await page.locator('[data-command="decide"]').click();
    await page.locator('#decide-decision').selectOption('approve');
    await page.locator('#decide-reason').fill('Đủ điều kiện nhận bàn giao.');
    await page.locator('#decide-as-built').fill(seeded.documentVersionId);
    await page.getByRole('dialog').getByRole('button', { name: vi['ast.handover.decide.submit'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['ast.handover.status.accepted']);
    expect((await handoversOf(seeded.contractId))[0]).toMatchObject({
      status: 'ACCEPTED',
      accepted_by: membershipOf('handoverReceiver'),
      as_built_document_version_id: seeded.documentVersionId,
      open_critical_punch_count: 0,
    });
    await expect(page.locator('[data-command]')).toHaveCount(0);
    await expect(page.locator('[data-item] button')).toHaveCount(0);
    await expect(page.getByTestId('documents')).toContainText(seeded.documentVersionId);
  });
});
