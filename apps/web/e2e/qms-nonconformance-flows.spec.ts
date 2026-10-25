import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * QMS-07 (the non-conformances of the work under a contract) in a real browser against the real API and database (apps/api/test/e2e-stack): the supervisor raises a critical non-conformance,
 * which holds back the acceptance, and assigns an action to the contractor; the contractor answers it with a document; the verifier gives the answer back once and verifies the second; the
 * verifier closes the non-conformance, and reopens it when it comes back. Whoever raised it, answers for it or carried out the action sees no button to verify or close. What the screens
 * changed is looked up in the database.
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
  documentVersionId: string;
}

/** An ACTIVE contract with the revision in force, written straight to the database (foreign keys to modules that are not seeded are switched off). */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const code = `HD-KP-${suffix}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' and scan_status = 'CLEAN' order by object_key");
  if (contractor === undefined || project === undefined || papers.length < 1) throw new Error('the contract fixtures of the stack are missing');
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử khắc phục', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, code, MAKER, membershipOf('lifecycleReviewer'), papers[0]?.id, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, papers[0]?.id, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
  } finally {
    await client.end();
  }
  return { contractId, documentVersionId: papers[0]?.id ?? '' };
}

interface NcrRow {
  id: string;
  ncr_no: string;
  status: string;
  severity: string;
  blocks_acceptance: boolean;
  action_owner_id: string;
  verified_by: string | null;
  closed_by: string | null;
  closure_note: string | null;
  reopen_count: number;
  version: string;
}

interface ActionRow {
  id: string;
  status: string;
  owner_membership_id: string;
  evidence_note: string | null;
  verification_note: string | null;
}

const ncrsOf = (contractId: string) =>
  sql<NcrRow>(
    `select id, ncr_no, status, severity, blocks_acceptance, action_owner_id, verified_by, closed_by, closure_note, reopen_count, version::text
       from machvon.quality_nonconformance where contract_id = $1 order by created_at, id`,
    [contractId],
  );
const actionsOf = (ncrId: string) =>
  sql<ActionRow>('select id, status, owner_membership_id, evidence_note, verification_note from machvon.corrective_action where nonconformance_id = $1 order by created_at, id', [ncrId]);

const card = (page: Page, ncrId: string) => page.locator(`[data-ncr="${ncrId}"]`);

test.describe('the non-conformances of a contract', () => {
  test('the supervisor raises and assigns, the contractor answers, the verifier gives back once, verifies and closes, and reopens it (UI-QMS-07, AC-ST-QMS-006-1, UAT-AC361)', async ({ page }) => {
    const seeded = await seed();
    const path = `/qms/qms-07?contract=${seeded.contractId}`;

    await open(page, path, 'ncrRaiser');
    await expect(page.getByRole('heading', { level: 1, name: vi['qms.ncr.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-nonconformances')).toHaveText(vi['qms.ncr.none.notice']);

    // An empty form says what is missing, and nothing is sent.
    await page.getByRole('button', { name: vi['qms.ncr.raise.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.raise.submit'] }).click();
    await expect(page.getByText(vi['qms.ncr.problem.required']).first()).toBeVisible();
    await page.getByRole('button', { name: vi['qms.ncr.dialog.cancel'] }).click();
    expect(await ncrsOf(seeded.contractId)).toHaveLength(0);

    // A critical non-conformance holds the acceptance back.
    await page.getByRole('button', { name: vi['qms.ncr.raise.action'] }).click();
    await page.locator('#ncr-severity').selectOption('CRITICAL');
    await page.locator('#ncr-source').selectOption('SUPERVISOR_REMARK');
    await page.locator('#ncr-title').fill('Lớp bảo vệ cốt thép móng M1 thiếu');
    await page.locator('#ncr-description').fill('Lớp bảo vệ đo được 30 mm, bản vẽ yêu cầu 50 mm.');
    await page.locator('#ncr-owner').selectOption(membershipOf('ncrReader'));
    await page.locator('#ncr-due').fill('2999-01-01');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.raise.submit'] }).click();
    await expect(page.getByTestId('board')).toBeVisible();
    const [raised] = await ncrsOf(seeded.contractId);
    expect(raised).toMatchObject({ ncr_no: 'NCR-001', status: 'OPEN', severity: 'CRITICAL', blocks_acceptance: true, version: '1' });
    const id = raised?.id ?? '';
    await expect(card(page, id).getByTestId('blocks')).toHaveText(vi['qms.ncr.blocks.badge']);
    await expect(page.locator(`[data-lane="OPEN"] [data-ncr="${id}"]`)).toBeVisible();

    // The supervisor assigns an action to the contractor.
    await page.locator(`[data-assign="${id}"]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.assign.submit'] }).click();
    await expect(page.getByText(vi['qms.ncr.problem.required']).first()).toBeVisible();
    await page.locator('#ncr-action-description').fill('Đục bỏ và đổ lại lớp bảo vệ.');
    await page.locator('#ncr-action-owner').selectOption(membershipOf('ncrFixer'));
    await page.locator('#ncr-action-due').fill('2999-01-01');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.assign.submit'] }).click();
    await expect(page.locator(`[data-lane="ACTION_ASSIGNED"] [data-ncr="${id}"]`)).toBeVisible();
    expect((await ncrsOf(seeded.contractId))[0]).toMatchObject({ status: 'ACTION_ASSIGNED', version: '2' });
    const [assigned] = await actionsOf(id);
    expect(assigned).toMatchObject({ status: 'ASSIGNED', owner_membership_id: membershipOf('ncrFixer') });
    // The supervisor does not answer for the contractor, nor verify.
    await expect(card(page, id).locator('[data-evidence], [data-verify], [data-close]')).toHaveCount(0);

    // The contractor answers with a document and a note.
    await open(page, path, 'ncrFixer');
    await expect(card(page, id).locator('[data-assign]')).toHaveCount(0);
    await card(page, id).locator(`[data-evidence="${assigned?.id}"]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.evidence.submit'] }).click();
    await expect(page.getByText(vi['qms.ncr.problem.evidenceRequired'])).toBeVisible();
    await page.locator('#ncr-evidence-document').fill(seeded.documentVersionId);
    await page.locator('#ncr-evidence-note').fill('Đã đổ lại, lớp bảo vệ đo được 40 mm.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.evidence.submit'] }).click();
    await expect(page.locator(`[data-lane="ACTION_SUBMITTED"] [data-ncr="${id}"]`)).toBeVisible();
    expect((await actionsOf(id))[0]).toMatchObject({ status: 'SUBMITTED', evidence_note: 'Đã đổ lại, lớp bảo vệ đo được 40 mm.' });
    await expect(card(page, id).locator('[data-evidence]')).toHaveCount(0);

    // The verifier gives it back once: the non-conformance goes back to being put right, and the contractor answers again.
    await open(page, path, 'ncrVerifier');
    await expect(card(page, id).locator('[data-close]')).toHaveCount(0);
    await card(page, id).locator(`[data-verify="${assigned?.id}"]`).click();
    await expect(page.getByTestId('verify-evidence')).toContainText('40 mm');
    await page.locator('#ncr-verify-outcome').selectOption('REJECTED');
    await page.locator('#ncr-verify-note').fill('Còn thiếu 10 mm.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.verify.submit'] }).click();
    await expect(page.locator(`[data-lane="ACTION_ASSIGNED"] [data-ncr="${id}"]`)).toBeVisible();
    expect((await actionsOf(id))[0]).toMatchObject({ status: 'REJECTED', verification_note: 'Còn thiếu 10 mm.' });

    await open(page, path, 'ncrFixer');
    await card(page, id).locator(`[data-evidence="${assigned?.id}"]`).click();
    await page.locator('#ncr-evidence-document').fill(seeded.documentVersionId);
    await page.locator('#ncr-evidence-note').fill('Đã xử lý lại, lớp bảo vệ đo được 51 mm.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.evidence.submit'] }).click();
    await expect(page.locator(`[data-lane="ACTION_SUBMITTED"] [data-ncr="${id}"]`)).toBeVisible();

    // The verifier verifies the second answer, and the non-conformance is ready to close; the person responsible for it has no button.
    await open(page, path, 'ncrVerifier');
    await card(page, id).locator(`[data-verify="${assigned?.id}"]`).click();
    await page.locator('#ncr-verify-outcome').selectOption('VERIFIED');
    await page.locator('#ncr-verify-note').fill('Đo lại đạt 51 mm.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.verify.submit'] }).click();
    await expect(page.locator(`[data-lane="VERIFIED"] [data-ncr="${id}"]`)).toBeVisible();
    expect((await ncrsOf(seeded.contractId))[0]).toMatchObject({ status: 'VERIFIED', verified_by: membershipOf('ncrVerifier') });
    await open(page, path, 'ncrReader');
    await expect(card(page, id)).toBeVisible();
    await expect(page.locator('button[data-assign], button[data-evidence], button[data-verify], button[data-close], button[data-reopen]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['qms.ncr.raise.action'] })).toHaveCount(0);

    // The verifier closes it with a note.
    await open(page, path, 'ncrVerifier');
    await card(page, id).locator(`[data-close="${id}"]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.close.submit'], exact: true }).click();
    await expect(page.getByText(vi['qms.ncr.problem.required'])).toBeVisible();
    await page.locator('#ncr-closure-note').fill('Mọi hành động đã được xác nhận.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.close.submit'], exact: true }).click();
    await expect(page.locator(`[data-lane="CLOSED"] [data-ncr="${id}"]`)).toBeVisible();
    expect((await ncrsOf(seeded.contractId))[0]).toMatchObject({ status: 'CLOSED', closed_by: membershipOf('ncrVerifier'), closure_note: 'Mọi hành động đã được xác nhận.' });
    // A closed one no longer holds the acceptance back.
    await expect(card(page, id).getByTestId('blocks')).toHaveCount(0);

    // It came back: the verifier reopens it with a reason, and it waits for a new action.
    await card(page, id).locator(`[data-reopen="${id}"]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.reopen.submit'] }).click();
    await expect(page.getByText(vi['qms.ncr.problem.required'])).toBeVisible();
    await page.locator('#ncr-reopen-reason').fill('Lớp bảo vệ nứt lại sau đợt đổ tiếp theo.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.ncr.reopen.submit'] }).click();
    await expect(page.locator(`[data-lane="OPEN"] [data-ncr="${id}"]`)).toBeVisible();
    expect((await ncrsOf(seeded.contractId))[0]).toMatchObject({ status: 'REOPENED', closed_by: null, reopen_count: 1 });
    await expect(card(page, id).getByTestId('blocks')).toHaveText(vi['qms.ncr.blocks.badge']);
  });
});
