import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * BID-01 and BID-02 in a real browser against the real API and database (apps/api/test/e2e-stack): the contractor manager registers two
 * contractors with one tax id and cannot verify their own registration; a second person verifies the first on evidence (the lookup adapter of
 * the stack is MISSING, and the profile says so instead of claiming an official check), is refused the duplicate with the way to the merge in
 * master data, and records a restriction on a decision in force. A reader sees the tax id covered and no decision form. What the screens
 * changed is looked up in the database.
 */

const DAY_MS = 86_400_000;
/** The Vietnam date `days` days from now, the clock the API judges a restriction by. */
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);
let counter = 0;
/** A well-formed tax id that no other flow of the run uses. */
const taxId = (): string => {
  counter += 1;
  return `09${String(Date.now() % 1_000_000).padStart(6, '0')}${String(counter).padStart(2, '0')}`;
};
const SEEDED_TAX_ID = '0100000001';
const MANAGER = membershipOf('bidManager');
const VERIFIER = membershipOf('bidVerifier');

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** A document of the tenant that the registry can name; `effective` makes it a decision in force. */
async function documentRow(effective: boolean): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Tài liệu thử', 'INTERNAL', '12/QD', date '2026-01-01', $3, $4, $4)`,
    [stackInfo().tenants.A, id, effective ? 'EFFECTIVE' : 'PENDING', membershipOf('owner')],
  );
  return id;
}

interface ContractorRow {
  id: string;
  legal_name: string;
  verification_status: string;
  verification_basis: string | null;
  lookup_adapter_status: string | null;
  lookup_outcome: string | null;
  verified_by: string | null;
  verification_evidence_document_id: string | null;
  master_record_id: string | null;
  created_by: string;
  version: string;
}

const contractorsOf = (tax: string): Promise<ContractorRow[]> =>
  sql(
    `select id, legal_name, verification_status, verification_basis, lookup_adapter_status, lookup_outcome, verified_by, verification_evidence_document_id, master_record_id, created_by, version::text
       from machvon.contractor where tax_identifier = $1 order by created_at, id`,
    [tax],
  );

const rowOf = (page: Page, tax: string) => page.locator('tr[data-contractor-id]', { hasText: tax });

interface Registration {
  tax: string;
  name: string;
  profile: string;
}

async function register(page: Page, input: Registration): Promise<void> {
  await page.getByLabel(vi['bid.register.taxId.label'], { exact: true }).fill(input.tax);
  await page.getByLabel(vi['bid.register.name.label'], { exact: true }).fill(input.name);
  await page.getByLabel(vi['bid.register.form.label'], { exact: true }).fill('TNHH');
  await page.getByLabel(vi['bid.register.profile.label'], { exact: true }).fill(input.profile);
  await page.getByRole('button', { name: vi['bid.register.submit.action'], exact: true }).click();
}

const profilePath = (id: string): string => `/bid/bid-02?id=${id}`;

test.describe('BID-01 and BID-02 contractor registry', () => {
  test('the manager registers two contractors with one tax id, the registrant cannot verify, a second person does, and the duplicate goes to the merge (AC-ST-BID-002-1)', async ({ page }) => {
    const tax = taxId();
    const profileDocument = await documentRow(false);
    const evidence = await documentRow(false);
    // The master data entry of the contractor, which the registry links by the tax id and never by the name.
    const master = randomUUID();
    await sql(
      "insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'CONTRACTOR', $3, 'EFFECTIVE', $4, $4)",
      [stackInfo().tenants.A, master, tax, membershipOf('owner')],
    );
    await open(page, '/bid/bid-01', 'bidManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['bid.list.page.title'] })).toBeVisible();
    // The contractor that the stack seeds is verified and shown with its full tax id to a caller who holds the full right to read.
    const seeded = rowOf(page, SEEDED_TAX_ID);
    await expect(seeded.getByTestId('verification')).toContainText(vi['bid.status.verified.label']);
    await expect(seeded.getByTestId('restriction-none')).toHaveText(vi['bid.restriction.none.text']);

    // Nothing is sent for a form that is wrong: each field says what is wrong and the database has no contractor.
    await page.getByRole('button', { name: vi['bid.register.submit.action'], exact: true }).click();
    await expect(page.locator('[data-field="register-taxIdentifier"]').getByText(vi['bid.field.required.error'])).toBeVisible();
    await expect(page.locator('[data-field="register-profileDocumentId"]').getByText(vi['bid.field.required.error'])).toBeVisible();
    await register(page, { tax: '123', name: 'Nhà thầu thử', profile: 'not-a-document' });
    await expect(page.locator('[data-field="register-taxIdentifier"]').getByText(vi['bid.field.invalidTaxId.error'])).toBeVisible();
    await expect(page.locator('[data-field="register-profileDocumentId"]').getByText(vi['bid.field.invalidId.error'])).toBeVisible();
    expect(await contractorsOf('123')).toEqual([]);

    // A tax id that a verified contractor holds is not registered again, and the refusal points at the holder.
    await register(page, { tax: SEEDED_TAX_ID, name: 'Nhà thầu trùng mã số thuế', profile: profileDocument });
    const refusal = page.getByTestId('register-refusal');
    await expect(refusal).toContainText(vi['bid.problem.alreadyVerified.error']);
    await expect(refusal.getByRole('link', { name: vi['bid.register.holder.link'] })).toHaveAttribute('href', /\/bid\/bid-02\?id=/);
    expect(await contractorsOf(SEEDED_TAX_ID)).toHaveLength(1);

    // Two claims of one new tax id wait for a decision: both are registered as unverified.
    await register(page, { tax, name: 'Công ty TNHH Xây dựng An Phát', profile: profileDocument });
    await expect(page.getByTestId('register-done')).toContainText(vi['bid.register.done.notice']);
    await register(page, { tax, name: 'Công ty Xây dựng An Phát (bản đăng ký thứ hai)', profile: profileDocument });
    await expect(page.getByTestId('register-done')).toContainText(vi['bid.register.done.notice']);
    const claims = await contractorsOf(tax);
    expect(claims.map((row) => [row.legal_name, row.verification_status, row.created_by, row.master_record_id, row.version])).toEqual([
      ['Công ty TNHH Xây dựng An Phát', 'UNVERIFIED', MANAGER, master, '1'],
      ['Công ty Xây dựng An Phát (bản đăng ký thứ hai)', 'UNVERIFIED', MANAGER, master, '1'],
    ]);
    const [first, second] = claims;
    if (first === undefined || second === undefined) throw new Error('the two registrations are missing');
    await expect(rowOf(page, tax)).toHaveCount(2);
    await expect(rowOf(page, tax).first().getByTestId('verification')).toContainText(vi['bid.status.unverified.label']);

    // The registrant holds the right to verify, and the server still refuses them their own registration.
    await open(page, profilePath(first.id), 'bidManager');
    const ownPanel = page.getByTestId('verification-panel');
    await ownPanel.getByLabel(vi['bid.verify.evidence.label'], { exact: true }).fill(evidence);
    await ownPanel.getByRole('button', { name: vi['bid.verify.submit.action'] }).click();
    await expect(ownPanel.getByTestId('verify-refusal')).toContainText(vi['bid.problem.selfApproval.error']);
    expect((await contractorsOf(tax))[0]).toMatchObject({ verification_status: 'UNVERIFIED', verified_by: null, version: '1' });

    // A second person verifies the first on evidence. The decision needs a well-formed evidence document.
    await open(page, profilePath(first.id), 'bidVerifier');
    await expect(page.getByRole('heading', { level: 1, name: first.legal_name })).toBeVisible();
    const panel = page.getByTestId('verification-panel');
    await panel.getByRole('button', { name: vi['bid.verify.submit.action'] }).click();
    await expect(panel.getByText(vi['bid.field.required.error'])).toBeVisible();
    await panel.getByLabel(vi['bid.verify.evidence.label'], { exact: true }).fill(evidence);
    await panel.getByRole('button', { name: vi['bid.verify.submit.action'] }).click();
    await expect(page.getByTestId('verification-panel')).toHaveCount(0);
    expect((await contractorsOf(tax))[0]).toEqual({
      ...first,
      verification_status: 'VERIFIED',
      verification_basis: 'EVIDENCE_DOCUMENT',
      lookup_adapter_status: 'MISSING',
      lookup_outcome: 'UNAVAILABLE',
      verified_by: VERIFIER,
      verification_evidence_document_id: evidence,
      version: '2',
    });
    // The profile says on what the tax id was verified, and the lookup adapter of the stack is not connected: it never claims an official check.
    await expect(page.getByTestId('verification')).toContainText(vi['bid.status.verified.label']);
    await expect(page.getByTestId('basis')).toHaveText(vi['bid.basis.document.label']);
    await expect(page.getByTestId('lookup-note')).toContainText(vi['bid.adapter.missing.label']);
    await expect(page.getByTestId('lookup-note')).toContainText(vi['bid.outcome.unavailable.label']);
    await expect(page.getByText(vi['bid.basis.lookup.label'])).toHaveCount(0);
    await expect(page.getByTestId('tax-id')).toHaveText(tax);
    await expect(page.getByTestId('master-none')).toHaveCount(0);
    await expect(page.getByText(master)).toBeVisible();

    // The same tax id cannot be verified for the second claim: no automatic merge, the answer points at the verified holder and at master data.
    await open(page, profilePath(second.id), 'bidVerifier');
    const duplicatePanel = page.getByTestId('verification-panel');
    await duplicatePanel.getByLabel(vi['bid.verify.evidence.label'], { exact: true }).fill(evidence);
    await duplicatePanel.getByRole('button', { name: vi['bid.verify.submit.action'] }).click();
    await expect(duplicatePanel.getByTestId('verify-refusal')).toContainText(vi['bid.problem.duplicateVerified.error']);
    const suggestion = duplicatePanel.getByTestId('merge-suggestion');
    await expect(suggestion.getByRole('link', { name: vi['bid.verify.holder.link'] })).toHaveAttribute('href', `${profilePath(first.id)}`);
    await expect(suggestion.getByRole('link', { name: vi['bid.verify.merge.link'] })).toHaveAttribute('href', '/mdm/mdm-37');
    expect((await contractorsOf(tax))[1]).toMatchObject({ verification_status: 'UNVERIFIED', verified_by: null, version: '1' });

    // The duplicate is rejected instead, on evidence; a decided contractor cannot be decided again, and the list filters by the decision.
    await duplicatePanel.getByLabel(vi['bid.status.rejected.label'], { exact: true }).check();
    await duplicatePanel.getByRole('button', { name: vi['bid.verify.submit.action'] }).click();
    await expect(page.getByTestId('verification-panel')).toHaveCount(0);
    expect((await contractorsOf(tax))[1]).toMatchObject({ verification_status: 'REJECTED', verification_basis: null, verified_by: VERIFIER, version: '2' });
    await open(page, '/bid/bid-01', 'bidVerifier');
    await page.getByLabel(vi['bid.list.query.label'], { exact: true }).fill(tax);
    await page.getByLabel(vi['bid.list.status.label'], { exact: true }).selectOption('REJECTED');
    await expect(page.locator('tr[data-contractor-id]')).toHaveCount(1);
    await expect(rowOf(page, tax).getByTestId('verification')).toContainText(vi['bid.status.rejected.label']);
    await page.getByLabel(vi['bid.list.status.label'], { exact: true }).selectOption('UNVERIFIED');
    await expect(page.getByTestId('no-match')).toHaveText(vi['bid.list.noMatch.notice']);
    expect(
      await sql("select action from machvon.audit_event where resource_id = $1 and action like 'contractor.%' and outcome = 'SUCCESS' order by occurred_at", [first.id]),
    ).toEqual([{ action: 'contractor.registered' }, { action: 'contractor.verified' }]);
  });

  test('the verifier records a restriction on a decision in force, and a decision that is not in force is refused (AC-ST-BID-002-1)', async ({ page }) => {
    const tax = taxId();
    const profileDocument = await documentRow(false);
    const decision = await documentRow(true);
    const notInForce = await documentRow(false);
    await open(page, '/bid/bid-01', 'bidManager');
    await register(page, { tax, name: 'Công ty Cổ phần Thương mại Hòa Bình', profile: profileDocument });
    await expect(page.getByTestId('register-done')).toBeVisible();
    const contractor = (await contractorsOf(tax))[0];
    if (contractor === undefined) throw new Error('the registration is missing');

    await open(page, profilePath(contractor.id), 'bidVerifier');
    await expect(page.getByTestId('restrictions-empty')).toHaveText(vi['bid.profile.restrictions.empty']);
    await expect(page.getByTestId('history-notice')).toHaveText(vi['bid.profile.history.notice']);
    const panel = page.getByTestId('restriction-panel');
    const submit = panel.getByRole('button', { name: vi['bid.restrict.submit.action'] });
    await submit.click();
    await expect(panel.getByText(vi['bid.field.required.error']).first()).toBeVisible();
    await panel.getByLabel(vi['bid.restrict.from.label'], { exact: true }).fill(inDays(-30));
    await panel.getByLabel(vi['bid.restrict.until.label'], { exact: true }).fill(inDays(-60));
    await panel.getByLabel(vi['bid.restrict.decision.label'], { exact: true }).fill(notInForce);
    await submit.click();
    await expect(panel.getByText(vi['bid.field.order.error'])).toBeVisible();

    // A decision that is not in force is refused by the server and nothing is recorded.
    await panel.getByLabel(vi['bid.restrict.until.label'], { exact: true }).fill(inDays(365));
    await submit.click();
    await expect(panel.getByTestId('restrict-refusal')).toContainText(vi['bid.problem.decisionNotEffective.error']);
    expect(await sql('select count(*)::int as n from machvon.contractor_restriction where contractor_id = $1', [contractor.id])).toEqual([{ n: 0 }]);

    await panel.getByLabel(vi['bid.restrict.decision.label'], { exact: true }).fill(decision);
    await panel.getByLabel(vi['bid.restrict.note.label'], { exact: true }).fill('Vi phạm hợp đồng đã xác nhận');
    await submit.click();
    await expect(panel.getByTestId('restrict-done')).toHaveText(vi['bid.restrict.done.notice']);
    expect(
      await sql('select kind, source, effective_from::text, effective_until::text, decision_document_id, note, created_by from machvon.contractor_restriction where contractor_id = $1', [contractor.id]),
    ).toEqual([{ kind: 'DEBARMENT', source: 'DECISION', effective_from: inDays(-30), effective_until: inDays(365), decision_document_id: decision, note: 'Vi phạm hợp đồng đã xác nhận', created_by: VERIFIER }]);
    const badge = vi['bid.restriction.until.badge'].replace('{kind}', vi['bid.kind.debarment.label']).replace('{until}', inDays(365));
    await expect(page.getByTestId('restriction-in-force')).toHaveText(badge);
    await expect(page.getByTestId('restrictions').locator('tr[data-restriction-id]')).toHaveCount(1);
    await expect(page.getByTestId('restrictions')).toContainText(decision);

    // The registry lists it as restricted, and the filter for restricted contractors finds it.
    await open(page, '/bid/bid-01', 'bidVerifier');
    await expect(rowOf(page, tax).getByTestId('restriction-in-force')).toHaveText(badge);
    await page.getByLabel(vi['bid.list.restricted.label'], { exact: true }).check();
    await expect(rowOf(page, tax)).toBeVisible();
    await expect(rowOf(page, SEEDED_TAX_ID)).toHaveCount(0);
  });

  test('a reader sees the tax id covered and no form to decide, and a member without the right to read gets the denied state', async ({ page }) => {
    const tax = taxId();
    const profileDocument = await documentRow(false);
    await open(page, '/bid/bid-01', 'bidManager');
    await register(page, { tax, name: 'Công ty TNHH Một thành viên Sông Hồng', profile: profileDocument });
    await expect(page.getByTestId('register-done')).toBeVisible();
    const contractor = (await contractorsOf(tax))[0];
    if (contractor === undefined) throw new Error('the registration is missing');

    await open(page, '/bid/bid-01', 'bidReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['bid.list.page.title'] })).toBeVisible();
    await expect(page.locator(`tr[data-contractor-id="${contractor.id}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-contractor-id="${contractor.id}"] code`)).not.toHaveText(tax);
    await expect(page.getByTestId('register-panel')).toHaveCount(0);

    await open(page, profilePath(contractor.id), 'bidReader');
    await expect(page.getByTestId('tax-id-masked')).toContainText(vi['bid.profile.taxId.masked']);
    await expect(page.getByTestId('tax-id')).not.toHaveText(tax);
    await expect(page.getByTestId('verification-panel')).toHaveCount(0);
    await expect(page.getByTestId('restriction-panel')).toHaveCount(0);

    await open(page, '/bid/bid-01', 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-contractor-id]')).toHaveCount(0);

    // Without a contractor in the address, the profile says so instead of showing an empty record.
    await open(page, '/bid/bid-02', 'bidReader');
    await expect(page.getByTestId('no-contractor')).toHaveText(vi['bid.profile.noContractor.notice']);
  });
});
