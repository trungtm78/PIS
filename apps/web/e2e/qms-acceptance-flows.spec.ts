import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * QMS-05 (the quality acceptance minutes of an inspection) in a real browser against the real API and database (apps/api/test/e2e-stack): the supervisor drafts minutes from an inspection that
 * passed and signs as the supervisor; the owner is told which role is missing when it tries to approve before everyone has signed; the contractor (a guest of the contractor of the contract)
 * signs for the contractor and no one else can; the owner signs, approves, and the approval is sent to CTR once; the owner then revokes the minutes with a reason. A reader sees the minutes and
 * no command. What the screens changed is looked up in the database.
 */

const MAKER = membershipOf('lifecycleMaker');
let counter = 0;
let contractorMade = false;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface Seeded {
  contractId: string;
  code: string;
  inspectionNo: string;
  paper: string;
}

/** An ACTIVE contract and an inspection of it that passed, with the regime in force and the roles that sign, written straight to the database (foreign keys to modules that are not seeded are switched off). */
async function seed(): Promise<Seeded> {
  counter += 1;
  const tenant = stackInfo().tenants.A;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const itemId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${counter}`;
  const code = `HD-NT-${suffix}`;
  const [contractor] = await sql<{ id: string }>("select id from machvon.contractor where tax_identifier = '0100000777'");
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-CTR'");
  const [regime] = await sql<{ id: string }>("select id from machvon.master_record_version where master_type = 'QMS_REGIME' and code = 'ND-06-2021'");
  const papers = await sql<{ id: string }>("select id from machvon.document_version where object_key like 'tenants/e2e/ctr-%' order by object_key");
  if (contractor === undefined || project === undefined || regime === undefined || papers.length < 1) throw new Error('the fixtures of the stack are missing');
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    if (!contractorMade) {
      // The contractor of the contract signs as a guest of that contractor: the person of the stack is made one, once.
      await client.query("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1", [membershipOf('acceptanceContractor'), contractor.id]);
      contractorMade = true;
    }
    await client.query(
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, title, type, currency, status, version, contract_value_vnd, estimate_ceiling_vnd, advance_paid_vnd, created_by, updated_by,
                                     submitted_by, signed_on, signed_by, signed_document_version_id, effective_from, activated_by)
       values ($1, $2, $3, $4, $5, $6, 'Hợp đồng thử nghiệm thu', 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 1200000::numeric, 1200000::numeric, 0, $7, $7, $7, date '2026-01-02', $8, $9, date '2026-01-03', $10)`,
      [tenant, contractId, project.id, randomUUID(), contractor.id, code, MAKER, membershipOf('lifecycleReviewer'), papers[0]?.id, membershipOf('lifecycleActivator')],
    );
    await client.query(
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
       values ($1, $2, $3, 1, 1200000::numeric, $4, date '2026-01-03', 'EFFECTIVE', 'BASE', 1, $5, $5, $6, now())`,
      [tenant, revisionId, contractId, papers[0]?.id, MAKER, membershipOf('lifecycleActivator')],
    );
    await client.query(`update machvon.contract set current_revision_id = $2 where id = $1`, [contractId, revisionId]);
    await client.query(`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, 'B01', 'Đào đất', 'M3', $4, $4)`, [tenant, itemId, contractId, MAKER]);
    await client.query(
      `insert into machvon.inspection
         (tenant_id, id, project_id, contract_id, boq_item_id, inspection_no, inspection_type, title, requested_by, requested_for, status, scheduled_at, participant_membership_ids, result, result_note, result_recorded_by, result_recorded_at,
          checklist, regime_rule_version_id, required_roles, regime_awaiting_confirmation, regime_cxn, created_by, updated_by, version)
       values ($1, gen_random_uuid(), $2, $3, $4, 'KT-001', 'CONCEALED_WORK', 'Cốt thép móng M1', $5, date '2026-10-30', 'RESULT_RECORDED', now(), jsonb_build_array($7::text), 'PASS', 'Đạt yêu cầu.', $5, now(),
               '[{"code":"DRAWING","label":"Đúng bản vẽ","outcome":"PASS"}]'::jsonb, $6, '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, true, 'CXN-07', $5, $5, 3)`,
      [tenant, project.id, contractId, itemId, MAKER, regime.id, MAKER],
    );
  } finally {
    await client.end();
  }
  return { contractId, code, inspectionNo: 'KT-001', paper: papers[0]?.id ?? '' };
}

interface MinutesRow {
  id: string;
  record_no: string;
  status: string;
  acceptance_scope: string;
  required_roles: string[];
  version: string;
  approved_by: string | null;
  decision_note: string | null;
  revoke_reason: string | null;
}

const minutesOf = (contractId: string) =>
  sql<MinutesRow>('select id, record_no, status, acceptance_scope, required_roles, version::text, approved_by, decision_note, revoke_reason from machvon.quality_acceptance where contract_id = $1 order by created_at, id', [contractId]);
const signaturesOf = (minutesId: string) =>
  sql<{ signer_role: string; membership_id: string; method: string; legal_effect: string; cert_serial: string | null }>(
    "select signer_role, membership_id, method, legal_effect, cert_serial from machvon.qms_signature where subject_kind = 'QUALITY_ACCEPTANCE' and subject_id = $1 order by signed_at, id",
    [minutesId],
  );
const eventsOf = (minutesId: string, type: string) => sql<{ id: string }>('select id from machvon.outbox_event where aggregate_id = $1 and type = $2', [minutesId, type]);

test.describe('the quality acceptance minutes of an inspection', () => {
  test('the supervisor drafts and signs, the contractor and the owner sign, the owner approves it once and revokes it with a reason (UI-QMS-05, AC-ST-QMS-005-1, AC-ST-QMS-005-2, UAT-AC360, UAT-PLAN-27)', async ({ page }) => {
    const seeded = await seed();
    const path = `/qms/qms-05?contract=${seeded.contractId}`;

    await open(page, path, 'acceptanceDrafter');
    await expect(page.getByRole('heading', { level: 1, name: vi['qms.acceptance.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-acceptances')).toHaveText(vi['qms.acceptance.none.notice']);

    // An empty draft says what is missing, and nothing is sent.
    await page.getByRole('button', { name: vi['qms.acceptance.draft.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.draft.submit'] }).click();
    await expect(page.getByText(vi['qms.acceptance.problem.required']).first()).toBeVisible();
    await page.getByRole('button', { name: vi['qms.acceptance.dialog.cancel'] }).click();
    expect(await minutesOf(seeded.contractId)).toHaveLength(0);

    // The minutes take the roles the regime required of the inspection, and the scope of its kind.
    await page.getByRole('button', { name: vi['qms.acceptance.draft.action'] }).click();
    await page.locator('#acceptance-inspection').selectOption({ index: 1 });
    await expect(page.getByTestId('draft-scope')).toContainText(vi['qms.acceptance.scope.workItem']);
    await page.locator('#acceptance-record-no').fill('QA-W-001');
    await page.locator('#acceptance-document').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.draft.submit'] }).click();
    await expect(page.getByTestId('acceptances')).toBeVisible();
    const [drafted] = await minutesOf(seeded.contractId);
    expect(drafted).toMatchObject({ record_no: 'QA-W-001', status: 'DRAFT', acceptance_scope: 'WORK_ITEM', required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], version: '1' });
    const line = page.locator(`tr[data-acceptance="${drafted?.id}"]`);
    await expect(line.getByTestId('status')).toHaveText(vi['qms.acceptance.status.draft']);
    await expect(line.getByTestId('regime-warning')).toHaveText(vi['qms.acceptance.regime.unconfirmed'].replace('{cxn}', 'CXN-07'));
    await expect(line.locator('[data-role][data-signed="true"]')).toHaveCount(0);

    // The supervisor signs as the supervisor with an in-app confirmation, which is shown as an internal record and not as a digital signature.
    await line.locator('[data-sign]').click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.sign.submit'] }).click();
    await expect(page.getByText(vi['qms.acceptance.problem.required']).first()).toBeVisible();
    await page.locator('#acceptance-role').selectOption('SUPERVISOR');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.sign.submit'] }).click();
    await expect(line).toHaveAttribute('data-status', 'SIGNING');
    await expect(line.locator('[data-role="SUPERVISOR"]')).toHaveAttribute('data-signed', 'true');
    await expect(line.locator('[data-role="SUPERVISOR"] [data-testid="effect"]')).toHaveText(vi['qms.acceptance.effect.internal']);
    expect(await signaturesOf(drafted?.id ?? '')).toEqual([expect.objectContaining({ signer_role: 'SUPERVISOR', membership_id: membershipOf('acceptanceDrafter'), method: 'IN_APP_OTP', legal_effect: 'INTERNAL_RECORD' })]);

    // The owner signs as the owner and tries to approve while the contractor has not signed: the server names the role that is missing, and nothing is approved.
    await open(page, path, 'acceptanceOwner');
    const ownerLine = page.locator(`tr[data-acceptance="${drafted?.id}"]`);
    await ownerLine.locator('[data-sign]').click();
    await expect(page.locator('#acceptance-role')).toHaveValue('OWNER');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.sign.submit'] }).click();
    await expect(ownerLine.locator('[data-role="OWNER"]')).toHaveAttribute('data-signed', 'true');
    await ownerLine.locator('[data-decide]').click();
    await page.locator('input[data-decision="approve"]').check();
    await page.locator('#acceptance-reason').fill('Đã xem tại hiện trường.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.decide.submit'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['qms.acceptance.error.signaturesMissing'].replace('{roles}', vi['qms.inspection.role.contractor']));
    await page.getByRole('button', { name: vi['qms.acceptance.dialog.cancel'] }).click();
    expect((await minutesOf(seeded.contractId))[0]?.status).toBe('SIGNING');
    expect(await eventsOf(drafted?.id ?? '', 'qms.quality_acceptance.approved.v1')).toHaveLength(0);

    // The contractor, a guest of the contractor of the contract, signs for the contractor with a certificate, which is a legal electronic signature and carries its serial.
    await open(page, path, 'acceptanceContractor');
    const contractorLine = page.locator(`tr[data-acceptance="${drafted?.id}"]`);
    await contractorLine.locator('[data-sign]').click();
    await expect(page.locator('#acceptance-role')).toHaveValue('CONTRACTOR');
    await page.locator('#acceptance-method').selectOption('DIGITAL_CERT');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.sign.submit'] }).click();
    await expect(page.getByText(vi['qms.acceptance.problem.certSerial'])).toBeVisible();
    await page.locator('#acceptance-serial').fill('SN-0099');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.sign.submit'] }).click();
    await expect(contractorLine.locator('[data-role="CONTRACTOR"]')).toHaveAttribute('data-signed', 'true');
    await expect(contractorLine.locator('[data-role="CONTRACTOR"] [data-testid="effect"]')).toHaveText(vi['qms.acceptance.effect.legal']);
    // Everyone has signed: the contractor is not offered to decide, and the one who drafted the minutes is not offered to approve them.
    await expect(contractorLine.locator('[data-decide], [data-sign]')).toHaveCount(0);
    expect((await signaturesOf(drafted?.id ?? '')).map((signature) => [signature.signer_role, signature.legal_effect, signature.cert_serial])).toEqual([
      ['SUPERVISOR', 'INTERNAL_RECORD', null],
      ['OWNER', 'INTERNAL_RECORD', null],
      ['CONTRACTOR', 'LEGAL_E_SIGNATURE', 'SN-0099'],
    ]);
    await open(page, path, 'acceptanceDrafter');
    await expect(page.locator(`tr[data-acceptance="${drafted?.id}"]`).locator('[data-decide], [data-sign]')).toHaveCount(0);

    // The owner approves: the minutes are approved, and the approval is sent to CTR once.
    await open(page, path, 'acceptanceOwner');
    await page.locator(`tr[data-acceptance="${drafted?.id}"] [data-decide]`).click();
    await page.locator('input[data-decision="approve"]').check();
    await page.locator('#acceptance-reason').fill('Đã đủ chữ ký.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.decide.submit'] }).click();
    await expect(page.locator(`tr[data-acceptance="${drafted?.id}"]`)).toHaveAttribute('data-status', 'APPROVED');
    expect((await minutesOf(seeded.contractId))[0]).toMatchObject({ status: 'APPROVED', approved_by: membershipOf('acceptanceOwner'), decision_note: 'Đã đủ chữ ký.' });
    expect(await eventsOf(drafted?.id ?? '', 'qms.quality_acceptance.approved.v1')).toHaveLength(1);

    // Approved minutes are withdrawn with a reason, which is kept, and CTR is told once.
    await page.locator(`tr[data-acceptance="${drafted?.id}"] [data-revoke]`).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.revoke.submit'] }).click();
    await expect(page.getByText(vi['qms.acceptance.problem.required'])).toBeVisible();
    await page.locator('#acceptance-revoke-reason').fill('Công việc bị phát hiện lỗi sau nghiệm thu.');
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.revoke.submit'] }).click();
    const revoked = page.locator(`tr[data-acceptance="${drafted?.id}"]`);
    await expect(revoked).toHaveAttribute('data-status', 'REVOKED');
    await expect(revoked.getByTestId('revoke-reason')).toHaveText(vi['qms.acceptance.revoked.reason'].replace('{reason}', 'Công việc bị phát hiện lỗi sau nghiệm thu.'));
    expect((await minutesOf(seeded.contractId))[0]).toMatchObject({ status: 'REVOKED', revoke_reason: 'Công việc bị phát hiện lỗi sau nghiệm thu.' });
    expect(await eventsOf(drafted?.id ?? '', 'qms.quality_acceptance.revoked.v1')).toHaveLength(1);
    await expect(revoked.locator('button')).toHaveCount(0);
  });

  test('a reader sees the minutes and no command (UI-QMS-05)', async ({ page }) => {
    const seeded = await seed();
    await open(page, `/qms/qms-05?contract=${seeded.contractId}`, 'acceptanceDrafter');
    await page.getByRole('button', { name: vi['qms.acceptance.draft.action'] }).click();
    await page.locator('#acceptance-inspection').selectOption({ index: 1 });
    await page.locator('#acceptance-record-no').fill('QA-W-002');
    await page.locator('#acceptance-document').fill(seeded.paper);
    await page.getByRole('dialog').getByRole('button', { name: vi['qms.acceptance.draft.submit'] }).click();
    await expect(page.getByTestId('acceptances')).toBeVisible();

    await open(page, `/qms/qms-05?contract=${seeded.contractId}`, 'acceptanceReader');
    await expect(page.getByTestId('acceptances')).toBeVisible();
    await expect(page.locator('button[data-sign], button[data-decide], button[data-revoke]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['qms.acceptance.draft.action'] })).toHaveCount(0);
  });
});
