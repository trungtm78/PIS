import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * BID-05 (the sealed proposals and the declaration of conflict of interest) in a real browser against the real API and database (apps/api/test/e2e-stack): the clerk logs the files a
 * contractor handed in, each through the upload door, and the proposal is stored confidential and sealed until the opening of the bids; a member of the evaluation team sees none of it
 * before the opening, declares, and then opens it in full (the server records that they did); a member who declares a relation with a bidder loses that bidder's proposal until the
 * authority allows it, and the authority decides in the same screen. The clerk never sees the price or a file.
 */

const OWNER_UNIT = 'CB-SKHDT-QLDA';

interface Seeded {
  projectId: string;
  packageId: string;
  code: string;
}

const hoursFromNow = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();
/** A moment as the value of a `datetime-local` control in Vietnam time. */
const vietnamLocal = (hours: number): string => new Date(Date.now() + 7 * 3_600_000 + hours * 3_600_000).toISOString().slice(0, 16);

async function seedPackage(options: { opening?: number; closing?: number } = {}): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const projectId = randomUUID();
  const packageId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${packageId.slice(0, 4).toUpperCase()}`;
  const clerk = membershipOf('proposalClerk');
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, `E2E-PRP-${suffix}`, `Dự án hồ sơ dự thầu ${suffix}`, stackInfo().units.A[OWNER_UNIT], area?.id, clerk],
  );
  const code = `GT-${suffix}`;
  await sql(
    `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
     values ($1, $2, $3, $4, 20000000000, 'OPEN_BIDDING', 1, 'APPROVED', $5, $6, 1)`,
    [tenant, packageId, projectId, code, `Gói xây lắp ${suffix}`, clerk],
  );
  const milestone = (kind: string, hours: number) =>
    sql(
      `insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, planned_at, source, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5::timestamptz, 'MANUAL', $6, $6, 1)`,
      [tenant, randomUUID(), packageId, kind, hoursFromNow(hours), clerk],
    );
  await milestone('BID_CLOSING', options.closing ?? 36);
  await milestone('BID_OPENING', options.opening ?? 48);
  return { projectId, packageId, code };
}

async function seedContractor(name: string): Promise<string> {
  const tenant = stackInfo().tenants.A;
  const clerk = membershipOf('proposalClerk');
  const documentId = randomUUID();
  const contractorId = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
     values ($1, $2, 'ATTACHMENT', 'E2E-PROFILE', 'Hồ sơ năng lực', 'INTERNAL', $3, $3)`,
    [tenant, documentId, clerk],
  );
  const taxId = String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
  await sql(
    `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
     values ($1, $2, $3, $4, 'VERIFIED', $5)`,
    [tenant, contractorId, taxId, name, documentId],
  );
  return contractorId;
}

/** A proposal as the receipt leaves it: the confidential attachment, clean, about the proposal, and the record of its file. */
async function sealProposal(seeded: Seeded, contractorId: string, price: string): Promise<string> {
  const tenant = stackInfo().tenants.A;
  const clerk = membershipOf('proposalClerk');
  const proposalId = randomUUID();
  const documentId = randomUUID();
  const versionId = randomUUID();
  const [opening] = await sql<{ at: string }>("select planned_at::text as at from machvon.procurement_milestone where package_id = $1 and milestone_kind = 'BID_OPENING'", [seeded.packageId]);
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, subject_module, subject_id, created_by, updated_by)
     values ($1, $2, 'ATTACHMENT', 'BID-PROPOSAL-FILE', 'Đề xuất kỹ thuật', 'CONFIDENTIAL', 'BID_PROPOSAL', $3, $4, $4)`,
    [tenant, documentId, proposalId, clerk],
  );
  await sql(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage, byte_length, created_by)
     values ($1, $2, $3, 1, $4, $5, 'application/pdf', 12, 'CONFIDENTIAL', 'PENDING', '{}'::jsonb, 'ATTACHMENT', 2048, $6)`,
    [tenant, versionId, documentId, `tenants/${tenant}/document/${randomUUID()}`, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), clerk],
  );
  await sql("update machvon.document_version set scan_status = 'CLEAN' where id = $1", [versionId]);
  await sql(
    `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, bid_price_vnd, access_released_at, classification, created_by, version)
     values ($1, $2, $3, $4, $5, $6::jsonb, 1, 'RECEIVED', now() - interval '2 hours', $7::numeric, $8::timestamptz, 'CONFIDENTIAL', $9, 1)`,
    [tenant, proposalId, seeded.projectId, seeded.packageId, contractorId, JSON.stringify([versionId]), price, opening?.at, clerk],
  );
  await sql(`insert into machvon.proposal_document (tenant_id, id, proposal_id, document_version_id, part, received_by) values ($1, $2, $3, $4, 'TECHNICAL', $5)`, [tenant, randomUUID(), proposalId, versionId, clerk]);
  return proposalId;
}

/** The bids open: the milestone moves to the past and the sealed proposals follow it (the database does that, not the test). */
async function openTheBids(seeded: Seeded): Promise<void> {
  await sql("update machvon.procurement_milestone set planned_at = now() - interval '2 hours' where package_id = $1 and milestone_kind = 'BID_CLOSING'", [seeded.packageId]);
  await sql("update machvon.procurement_milestone set planned_at = now() - interval '1 hour' where package_id = $1 and milestone_kind = 'BID_OPENING'", [seeded.packageId]);
}

async function pdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.setTitle(`E2E bid volume ${randomUUID()}`);
  document.addPage();
  document.addPage();
  return Buffer.from(await document.save());
}

async function open(page: Page, user: string, seeded: Seeded): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/bid/bid-05?package=${seeded.packageId}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const declaredBy = (packageId: string, user: string) =>
  sql<{ id: string; has_conflict: boolean; decision: string | null; contractor_id: string | null; version: string }>(
    'select id, has_conflict, decision, contractor_id, version::text from machvon.bid_conflict_declaration where package_id = $1 and user_id = $2',
    [packageId, membershipOf(user)],
  );

test.describe('BID-05: the sealed proposals and the declaration of conflict of interest', () => {
  test('the clerk logs the files a contractor handed in; the proposal is stored confidential and sealed until the opening, and the clerk sees the receipt and never the price (UI-BID-05, AC-ST-BID-004-1, UAT-AC448)', async ({ page }) => {
    const seeded = await seedPackage();
    const contractorId = await seedContractor('Công ty xây dựng E2E-A');
    await open(page, 'proposalClerk', seeded);
    await expect(page.getByRole('heading', { level: 1, name: vi['bid.proposals.page.title'] })).toBeVisible();
    await expect(page.getByTestId('opening')).toContainText(vi['bid.proposals.locked.text'].split('{date}')[0] as string);
    await expect(page.getByTestId('no-proposals')).toHaveText(vi['bid.proposals.none.notice']);

    await page.getByRole('button', { name: vi['bid.proposals.intake.action'] }).click();
    const dialog = page.getByRole('dialog');
    // What is missing is asked for before anything is sent.
    await dialog.getByRole('button', { name: vi['bid.proposals.intake.submit'] }).click();
    await expect(dialog.getByText(vi['bid.proposals.problem.files'])).toBeVisible();
    await dialog.getByLabel(vi['bid.proposals.field.contractor'], { exact: true }).selectOption(contractorId);
    await dialog.getByLabel(vi['bid.proposals.field.submittedAt'], { exact: true }).fill(vietnamLocal(-1));
    await dialog.getByLabel(vi['bid.proposals.field.price'], { exact: true }).fill('17650000000');
    await dialog.getByRole('button', { name: vi['bid.proposals.files.add'] }).click();
    // A file that is not a PDF is refused by the door and keeps the proposal from being sent.
    await dialog.getByLabel(vi['bid.proposals.file.pick'].replace('{n}', '1'), { exact: true }).setInputFiles({ name: 'ghi-chu.pdf', mimeType: 'text/plain', buffer: Buffer.from('not a pdf') });
    await expect(dialog.getByTestId('file-failed')).toHaveText(vi['bid.proposals.error.notPdf']);
    await dialog.getByLabel(vi['bid.proposals.file.pick'].replace('{n}', '1'), { exact: true }).setInputFiles({ name: 'ho-so-ky-thuat.pdf', mimeType: 'application/pdf', buffer: await pdf() });
    await expect(dialog.getByTestId('file-uploaded')).toBeVisible();
    await dialog.getByRole('button', { name: vi['bid.proposals.intake.submit'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const row = page.locator('tr[data-proposal-id]');
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('rowheader')).toHaveText('Công ty xây dựng E2E-A');
    await expect(row.getByTestId('access')).toHaveText(vi['bid.proposals.access.locked']);
    await expect(row.getByTestId('price')).toHaveText(vi['bid.proposals.price.hidden']);
    await expect(row.getByRole('button')).toHaveCount(0);

    const [stored] = await sql<{ id: string; status: string; classification: string; bid_price_vnd: string; created_by: string; opening: boolean }>(
      `select p.id, p.status, p.classification, p.bid_price_vnd::text, p.created_by,
              p.access_released_at = (select planned_at from machvon.procurement_milestone where package_id = p.package_id and milestone_kind = 'BID_OPENING') as opening
         from machvon.proposal p where p.package_id = $1`,
      [seeded.packageId],
    );
    expect(stored).toMatchObject({ status: 'RECEIVED', classification: 'CONFIDENTIAL', bid_price_vnd: '17650000000', created_by: membershipOf('proposalClerk'), opening: true });
    const files = await sql<{ part: string; classification: string; scan_status: string; subject_module: string; subject_id: string }>(
      `select pd.part, d.classification, v.scan_status, d.subject_module, d.subject_id
         from machvon.proposal_document pd join machvon.document_version v on v.id = pd.document_version_id join machvon.document d on d.id = v.document_id
        where pd.proposal_id = $1`,
      [stored?.id],
    );
    expect(files).toEqual([{ part: 'TECHNICAL', classification: 'CONFIDENTIAL', scan_status: 'CLEAN', subject_module: 'BID_PROPOSAL', subject_id: stored?.id }]);
    expect(await sql("select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = 'bid.proposal_received' and outcome = 'SUCCESS'", [stored?.id])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from machvon.outbox_event where aggregate_id = $1 and type = 'bid.proposal.received.v1'", [stored?.id])).toEqual([{ n: 1 }]);
  });

  test('a member of the evaluation team sees nothing of the proposal before the opening, declares, and opens it in full after it; the clerk still sees the receipt only (UI-BID-05, AC-ST-BID-004-1, UAT-AC448)', async ({ page }) => {
    const seeded = await seedPackage({ opening: 24, closing: 12 });
    const contractorId = await seedContractor('Công ty xây dựng E2E-B');
    const proposalId = await sealProposal(seeded, contractorId, '17650000000');

    await open(page, 'proposalEvaluator', seeded);
    await expect(page.getByTestId('no-proposals')).toHaveText(vi['bid.proposals.none.notice']);
    await expect(page.getByTestId('conflict-banner')).toContainText(vi['bid.conflict.required.notice']);
    await page.getByRole('button', { name: vi['bid.conflict.declare.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: vi['bid.conflict.declare.submit'] }).click();
    await expect(dialog.getByText(vi['bid.conflict.problem.answer'])).toBeVisible();
    await dialog.getByLabel(vi['bid.conflict.declare.no']).check();
    await dialog.getByRole('button', { name: vi['bid.conflict.declare.submit'] }).click();
    await expect(page.getByTestId('own-standing')).toHaveText(vi['bid.conflict.own.clear']);
    await expect(page.getByTestId('no-proposals')).toBeVisible();
    expect(await declaredBy(seeded.packageId, 'proposalEvaluator')).toMatchObject([{ has_conflict: false, decision: null, contractor_id: null }]);

    await openTheBids(seeded);
    await page.reload();
    await page.waitForSelector('[data-screen-id]');
    const row = page.locator(`tr[data-proposal-id="${proposalId}"]`);
    await expect(row.getByTestId('access')).toHaveText(vi['bid.proposals.access.full']);
    await expect(row.getByTestId('price')).toContainText('17.650.000.000');
    await row.getByRole('button', { name: vi['bid.proposals.open.aria'].replace('{name}', 'Công ty xây dựng E2E-B') }).click();
    const detail = page.getByTestId('proposal-detail');
    await expect(detail.getByTestId('detail-files')).toContainText('Đề xuất kỹ thuật');
    await expect(detail.getByTestId('detail-price')).toContainText('17.650.000.000');
    expect(await sql("select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = 'bid.proposal_opened' and actor_id = $2", [proposalId, membershipOf('proposalEvaluator')])).toEqual([{ n: 1 }]);

    // The clerk who received it sees the receipt and neither the price nor the file.
    await open(page, 'proposalClerk', seeded);
    const clerkRow = page.locator(`tr[data-proposal-id="${proposalId}"]`);
    await expect(clerkRow.getByTestId('access')).toHaveText(vi['bid.proposals.access.metadata']);
    await expect(clerkRow.getByTestId('price')).toHaveText(vi['bid.proposals.price.hidden']);
    await expect(clerkRow.getByRole('button')).toHaveCount(0);
  });

  test('a member who has not declared sees the proposal as one that waits for the declaration, with no price and no button (UI-BID-05, AC-ST-BID-004-2)', async ({ page }) => {
    const seeded = await seedPackage({ opening: 24, closing: 12 });
    const proposalId = await sealProposal(seeded, await seedContractor('Công ty xây dựng E2E-C'), '9000000000');
    await openTheBids(seeded);
    await open(page, 'proposalEvaluatorTwo', seeded);
    const row = page.locator(`tr[data-proposal-id="${proposalId}"]`);
    await expect(row.getByTestId('access')).toHaveText(vi['bid.proposals.access.declaration']);
    await expect(row.getByTestId('price')).toHaveText(vi['bid.proposals.price.hidden']);
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.getByTestId('conflict-banner')).toBeVisible();
  });

  test('a member who declares a relation with a bidder loses that bidder, the authority recuses them in the same screen, and the other bidders stay open to them (UI-BID-05, AC-ST-BID-004-2, UAT-AC450)', async ({ page }) => {
    const seeded = await seedPackage({ opening: 24, closing: 12 });
    const nt1 = await seedContractor('Công ty NT-1 E2E');
    const nt2 = await seedContractor('Công ty NT-2 E2E');
    const first = await sealProposal(seeded, nt1, '17650000000');
    const second = await sealProposal(seeded, nt2, '17000000000');
    await openTheBids(seeded);

    await open(page, 'proposalEvaluatorTwo', seeded);
    await page.getByRole('button', { name: vi['bid.conflict.declare.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(vi['bid.conflict.declare.yes']).check();
    await dialog.getByRole('button', { name: vi['bid.conflict.declare.submit'] }).click();
    await expect(dialog.getByText(vi['bid.conflict.problem.relation'])).toBeVisible();
    await dialog.getByLabel(vi['bid.conflict.field.relation']).fill('Giám đốc công ty NT-1 là anh em họ của tôi.');
    await dialog.getByLabel(vi['bid.conflict.field.contractor'], { exact: true }).selectOption(nt1);
    await dialog.getByRole('button', { name: vi['bid.conflict.declare.submit'] }).click();
    await expect(page.getByTestId('own-standing')).toHaveText(vi['bid.conflict.own.pending']);
    // Waiting for the decision: NT-1 does not exist for the member, NT-2 does.
    await expect(page.locator(`tr[data-proposal-id="${first}"]`)).toHaveCount(0);
    await expect(page.locator(`tr[data-proposal-id="${second}"]`).getByTestId('access')).toHaveText(vi['bid.proposals.access.full']);
    const [declaration] = await declaredBy(seeded.packageId, 'proposalEvaluatorTwo');
    expect(declaration).toMatchObject({ has_conflict: true, decision: null, contractor_id: nt1 });

    // The authority sees the declaration with the words and decides it.
    await open(page, 'proposalAuthority', seeded);
    const entry = page.locator(`tr[data-declaration-id="${declaration?.id}"]`);
    await expect(entry).toContainText('Giám đốc công ty NT-1 là anh em họ của tôi.');
    await expect(entry).toContainText('Công ty NT-1 E2E');
    await entry.getByRole('button', { name: vi['bid.conflict.decide.action'] }).click();
    const decision = page.getByRole('dialog');
    await decision.getByRole('button', { name: vi['bid.conflict.decide.submit'] }).click();
    await expect(decision.getByText(vi['bid.conflict.problem.decision'])).toBeVisible();
    await decision.getByLabel(vi['bid.conflict.field.decision'], { exact: true }).selectOption('RECUSED');
    await decision.getByLabel(vi['bid.conflict.field.reason']).fill('Mối quan hệ họ hàng gần; rút khỏi hồ sơ của NT-1.');
    await decision.getByRole('button', { name: vi['bid.conflict.decide.submit'] }).click();
    await expect(entry).toContainText(vi['bid.conflict.standing.recused']);
    expect(await declaredBy(seeded.packageId, 'proposalEvaluatorTwo')).toMatchObject([{ decision: 'RECUSED', version: '2' }]);
    expect(await sql("select reason, actor_id from machvon.audit_event where resource_id = $1 and action = 'bid.conflict_decided' and outcome = 'SUCCESS'", [declaration?.id])).toEqual([
      { reason: 'Mối quan hệ họ hàng gần; rút khỏi hồ sơ của NT-1.', actor_id: membershipOf('proposalAuthority') },
    ]);

    // After the decision NT-1 is still closed to the member and NT-2 is open.
    await open(page, 'proposalEvaluatorTwo', seeded);
    await expect(page.getByTestId('own-standing')).toHaveText(vi['bid.conflict.own.recused']);
    await expect(page.locator(`tr[data-proposal-id="${first}"]`)).toHaveCount(0);
    await expect(page.locator(`tr[data-proposal-id="${second}"]`).getByTestId('price')).toContainText('17.000.000.000');
  });
});
