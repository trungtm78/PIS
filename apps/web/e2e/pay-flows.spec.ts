import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { membershipOf, sql } from './support/stack.ts';

/**
 * PAY-13 (the import of a Treasury statement file) in a real browser against the real API and database (apps/api/test/e2e-stack): the accountant imports a
 * statement and reads what became of each row, a file that comes again changes nothing, a row with the same key and other content leaves the first as it is and
 * waits for an owner, a code the crosswalk does not know is quarantined with its reason and creates no master entry, and the database holds the import, its
 * rows, the transactions, the items, the audit rows and the events. The confirmation by hand has no screen yet, so its four-eyes rule is checked through the API.
 * The file goes through the picker: it is uploaded (scanned, stored, its header read) as soon as it is picked, and the import is the next step.
 */

const PROJECT = 'DA-PAY';
const OFFICE = 'KB-CB-1';
const HEADER = 'document_no,document_date,project_code,treasury_office_code,amount_vnd,confirmed_at,payee_account';
const ACCOUNT = '0123456789';
const RUN = randomUUID().slice(0, 6).toUpperCase();

const line = (no: string, amount: string | number, options: { office?: string; account?: string } = {}): string =>
  `${no}-${RUN},2026-10-15,${PROJECT},${options.office ?? OFFICE},${amount},2026-10-16,${options.account ?? ACCOUNT}`;
const csv = (...lines: string[]): string => [HEADER, ...lines].join('\n') + '\n';

async function open(page: Page, user: string, importId?: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/pay/pay-13?devUser=${user}${importId === undefined ? '' : `&import=${importId}`}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** Picks a file in the browser and waits until it is uploaded and its header read; returns the hash the screen shows for it. */
async function pick(page: Page, content: string, name = 'statement.csv'): Promise<string> {
  await page.getByLabel(vi['pay.import.form.file.label'], { exact: true }).setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content, 'utf8') });
  await expect(page.getByTestId('staged-name')).toHaveText(name);
  return (await page.getByTestId('staged-hash').textContent()) ?? '';
}

/** Picks a file and imports it; returns the hash of the file. */
async function submitFile(page: Page, content: string, name = 'statement.csv'): Promise<string> {
  const sha = await pick(page, content, name);
  await page.getByRole('button', { name: vi['pay.import.form.submit.action'] }).click();
  return sha;
}

const countsOf = async (page: Page): Promise<string[]> => [
  (await page.getByTestId('count-total').textContent()) ?? '',
  (await page.getByTestId('count-new').textContent()) ?? '',
  (await page.getByTestId('count-duplicate').textContent()) ?? '',
  (await page.getByTestId('count-conflict').textContent()) ?? '',
  (await page.getByTestId('count-error').textContent()) ?? '',
];

const transactionsOf = (prefix: string) =>
  sql<{ id: string; external_id: string; amount_vnd: string; source_kind: string; match_status: string; import_id: string }>(
    "select id, external_id, amount_vnd::text as amount_vnd, source_kind, match_status, import_id from machvon.treasury_transaction where external_id like $1 order by external_id",
    [`KBNN_FILE|${prefix}%${RUN}%`],
  );

test.describe.configure({ mode: 'serial' });

test.describe('PAY-13 Treasury statement import', () => {
  let secondImportId = '';
  let secondContent = '';
  let secondSha = '';

  test('the accountant imports a statement, reads what became of every row, and the same file again changes nothing (AC-ST-PAY-006-1, AC-ST-PAY-006-2, AC-ST-PAY-006-4, UI-PAY-13)', async ({ page }) => {
    const masters = (await sql<{ n: number }>("select count(*)::int as n from machvon.master_record where master_type = 'TREASURY_OFFICE'"))[0]?.n;
    const first = csv(line('DUP', 1000), line('CON', 2000));
    await open(page, 'treasuryImporter');
    await expect(page.getByRole('heading', { level: 1, name: vi['pay.import.page.title'] })).toBeVisible();
    // The verdict on the adapter is on the screen before anything is imported: the layout is proposed and the Treasury API is missing.
    await expect(page.getByTestId('adapter-file')).toHaveText(vi['pay.import.adapterStatus.proposed.text']);
    await expect(page.getByTestId('adapter-api')).toHaveText(vi['pay.import.adapterStatus.missing.text']);
    await expect(page.getByTestId('adapter-assumption')).toHaveText(vi['pay.import.adapter.assumption.notice']);

    // The form is checked on the screen first.
    await page.getByRole('button', { name: vi['pay.import.form.submit.action'] }).click();
    await expect(page.getByText(vi['pay.import.fileError.required.text'])).toBeVisible();

    // The file is checked as soon as it is picked: it has the columns of the layout, and nothing is imported yet.
    const firstSha = await pick(page, first, 'sao-ke-dau.csv');
    await expect(page.getByTestId('layout-ok')).toHaveText(vi['pay.import.staged.layoutOk.text']);
    expect(await sql('select count(*)::int as n from machvon.treasury_import where file_sha256 = $1', [firstSha])).toEqual([{ n: 0 }]);
    await page.getByRole('button', { name: vi['pay.import.form.submit.action'] }).click();
    await expect(page.getByTestId('summary')).toBeVisible();
    expect(await sql('select file_name from machvon.treasury_import where file_sha256 = $1', [firstSha])).toEqual([{ file_name: 'sao-ke-dau.csv' }]);
    expect(await countsOf(page)).toEqual(['2', '2', '0', '0', '0']);
    await expect(page.getByTestId('status')).toHaveText(vi['pay.import.status.applied.text']);
    await expect(page.getByTestId('adapter-version')).toHaveText('ASSUMED-2026.1');
    expect((await transactionsOf('DUP')).length + (await transactionsOf('CON')).length).toBe(2);

    // The second file: three new rows, the first repeated, the second with another amount, a malformed row and a code the crosswalk does not know.
    secondContent = csv(line('N1', 3000), line('N2', 4000), line('N3', 5000), line('DUP', 1000), line('CON', 2500), line('BAD', '12x'), line('UNM', 700, { office: 'KB-NOPE' }));
    const original = (await transactionsOf('CON'))[0];
    secondSha = await submitFile(page, secondContent, 'sao-ke-hai.csv');
    await expect(page.getByTestId('status')).toHaveText(vi['pay.import.status.partial.text']);
    expect(await countsOf(page)).toEqual(['7', '3', '1', '1', '2']);
    await expect(page.getByTestId('answer')).toContainText(vi['pay.import.answer.partial.notice'].replace('{total}', '7').replace('{created}', '3').replace('{duplicate}', '1').replace('{conflict}', '1').replace('{error}', '2'));
    secondImportId = new URL(page.url()).searchParams.get('import') ?? '';
    expect(secondImportId).not.toBe('');
    await expect(page.getByTestId('file-hash')).toHaveText(secondSha);

    // The earlier imports are listed, the newest first, and the second is the one on screen.
    const recent = page.getByTestId('recent-row');
    await expect(recent.first()).toHaveAttribute('data-import-id', secondImportId);
    await expect(recent.first()).toContainText('sao-ke-hai.csv');
    await expect(recent.first()).toHaveAttribute('aria-current', 'true');

    // Every line says what became of it, and the quarantine names the reason and the owner and hides the account number.
    const lines = page.getByTestId('line-row');
    await expect(lines).toHaveCount(7);
    expect(await lines.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-outcome')))).toEqual(['NEW', 'NEW', 'NEW', 'DUPLICATE', 'CONFLICT', 'ERROR', 'ERROR']);
    const quarantine = page.getByTestId('quarantine-row');
    await expect(quarantine).toHaveCount(2);
    await expect(quarantine.nth(0)).toContainText(vi['pay.import.rowError.amountInvalid.text']);
    await expect(quarantine.nth(1)).toContainText(vi['pay.import.rowError.crosswalkMissing.text']);
    await expect(quarantine.nth(0).getByTestId('masked')).toContainText('***789');
    await expect(page.locator('body')).not.toContainText(ACCOUNT);
    const owner = (await sql<{ display_name: string }>('select display_name from machvon.tenant_user_directory where membership_id = $1', [membershipOf('treasuryImporter')]))[0]?.display_name ?? '';
    await expect(quarantine.nth(0)).toContainText(owner);

    // The row with the same key and other content waits for an owner with both figures; the first transaction is untouched.
    const differences = page.getByTestId('difference-row');
    await expect(differences).toHaveCount(2);
    for (const text of ['2.000', '2.500', '+500', owner]) await expect(differences.filter({ hasText: vi['pay.import.difference.duplicateConflict.text'] })).toContainText(text);
    await expect(differences.filter({ hasText: vi['pay.import.difference.crosswalkMissing.text'] })).toBeVisible();
    const certified = (await page.getByTestId('certified-amount').textContent()) ?? '';
    const claimed = (await sql<{ n: string }>("select count(*)::text as n from machvon.file_import_row where connector_code = 'TREASURY_STATEMENT_FILE'"))[0]?.n;
    await expect(page.getByTestId('certified-rows')).toHaveText(claimed ?? '');

    // The database holds what the screen says.
    expect((await transactionsOf('N')).map((row) => [row.amount_vnd, row.source_kind, row.match_status, row.import_id])).toEqual([
      ['3000', 'FILE_IMPORT', 'UNMATCHED', secondImportId],
      ['4000', 'FILE_IMPORT', 'UNMATCHED', secondImportId],
      ['5000', 'FILE_IMPORT', 'UNMATCHED', secondImportId],
    ]);
    expect(await transactionsOf('CON')).toEqual([original]);
    expect((await transactionsOf('CON'))[0]?.amount_vnd).toBe('2000');
    expect(await transactionsOf('UNM')).toEqual([]);
    expect(await sql('select count(*)::int as n from machvon.master_record where master_type = \'TREASURY_OFFICE\'')).toEqual([{ n: masters }]);
    expect(await sql<{ status: string; row_total: number; row_new: number; row_duplicate: number; row_conflict: number; row_error: number }>('select status, row_total, row_new, row_duplicate, row_conflict, row_error from machvon.treasury_import where id = $1', [secondImportId])).toEqual([
      { status: 'PARTIALLY_APPLIED', row_total: 7, row_new: 3, row_duplicate: 1, row_conflict: 1, row_error: 2 },
    ]);
    expect(await sql('select kind, internal_amount_vnd::text as internal, confirmed_amount_vnd::text as confirmed, difference_vnd::text as difference, owner_membership_id, status from machvon.reconciliation_item where treasury_transaction_id = $1', [original?.id])).toEqual([
      { kind: 'DUPLICATE_CONFLICT', internal: '2000', confirmed: '2500', difference: '500', owner_membership_id: membershipOf('treasuryImporter'), status: 'OPEN' },
    ]);
    expect(await sql("select error_code from machvon.file_import_quarantine where import_id = $1 order by line", [secondImportId])).toEqual([{ error_code: 'AMOUNT_INVALID' }, { error_code: 'CROSSWALK_MISSING' }]);
    expect(await sql("select action from machvon.audit_event where resource_id = $1", [secondImportId])).toEqual([{ action: 'pay.treasury_import_applied' }]);
    expect(await sql("select type from machvon.outbox_event where aggregate_id = $1 and type like 'pay.%'", [secondImportId])).toEqual([{ type: 'pay.treasury_import.applied.v1' }]);

    // The same file again: the screen tells it was imported, shows the first import, and nothing is created or added to the total.
    const before = (await sql<{ n: number }>('select count(*)::int as n from machvon.treasury_transaction'))[0]?.n;
    await submitFile(page, secondContent, 'sao-ke-hai.csv');
    await expect(page.getByTestId('answer')).toContainText(vi['pay.import.answer.already.notice'].replace('{total}', '7'));
    await expect(page.getByTestId('certified-amount')).toHaveText(certified);
    expect(await countsOf(page)).toEqual(['7', '3', '1', '1', '2']);
    expect(await sql('select count(*)::int as n from machvon.treasury_transaction')).toEqual([{ n: before }]);
    expect(await sql('select count(*)::int as n from machvon.treasury_import where file_sha256 = $1', [secondSha])).toEqual([{ n: 1 }]);
    expect(await sql("select action from machvon.audit_event where resource_id = $1 order by occurred_at, id", [secondImportId])).toEqual([{ action: 'pay.treasury_import_applied' }, { action: 'pay.treasury_import_repeated' }]);
  });

  test('a file that lacks required columns is told before the import and is not imported; a file of another kind is refused at the upload; the list opens an earlier import (AC-ST-PAY-006-1)', async ({ page }) => {
    await open(page, 'treasuryImporter');
    const wrong = 'document_no,amount_vnd\nX-1,1000\n';
    const wrongSha = await pick(page, wrong, 'sai-khuon-dang.csv');
    const missing = [vi['pay.import.field.documentDate.label'], vi['pay.import.field.projectCode.label'], vi['pay.import.field.officeCode.label'], vi['pay.import.field.confirmedAt.label']].join(', ');
    await expect(page.getByTestId('layout-bad')).toHaveText(vi['pay.import.staged.layoutBad.text'].replace('{columns}', missing));
    await page.getByRole('button', { name: vi['pay.import.form.submit.action'] }).click();
    await expect(page.getByText(vi['pay.import.fileError.layout.text'].replace('{columns}', missing))).toBeVisible();
    expect(await sql('select count(*)::int as n from machvon.treasury_import where file_sha256 = $1', [wrongSha])).toEqual([{ n: 0 }]);
    // The connector stays active: a file the platform does not read is told to the person, it does not stop the next import.
    expect(await sql("select count(*)::int as n from machvon.integration_cursor where connector_code = 'TREASURY_STATEMENT_FILE' and status <> 'ACTIVE'")).toEqual([{ n: 0 }]);

    // A file that is not a table is refused when it is picked.
    await page.getByLabel(vi['pay.import.form.file.label'], { exact: true }).setInputFiles({ name: 'anh.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) });
    await expect(page.getByTestId('problem')).toHaveText(vi['pay.import.problem.fileType.error']);
    await expect(page.getByTestId('staged')).toHaveCount(0);

    // A corrected file is taken.
    const good = csv(line('H1', 100));
    await submitFile(page, good);
    await expect(page.getByTestId('summary')).toBeVisible();
    expect(await countsOf(page)).toEqual(['1', '1', '0', '0', '0']);

    // The list opens an earlier import.
    await page.getByTestId('recent-row').filter({ hasText: 'sao-ke-hai.csv' }).getByRole('button').click();
    await expect(page.getByTestId('file-hash')).toHaveText(secondSha);
    expect(await countsOf(page)).toEqual(['7', '3', '1', '1', '2']);
  });

  test('someone who only reads imports sees the result without the form, and someone who may not read is refused (read-only, denied)', async ({ page }) => {
    expect(secondImportId).not.toBe('');
    await open(page, 'treasuryReader', secondImportId);
    await expect(page.getByTestId('summary')).toBeVisible();
    expect(await countsOf(page)).toEqual(['7', '3', '1', '1', '2']);
    await expect(page.getByTestId('read-only')).toHaveText(vi['pay.import.readOnly.denied.notice']);
    await expect(page.getByRole('button', { name: vi['pay.import.form.submit.action'] })).toHaveCount(0);
    await expect(page.getByTestId('recent-row').first()).toBeVisible();
    // The server refuses an import from someone who holds only the read.
    const refused = await apiCall('treasuryReader', 'POST', '/treasury-imports', { body: { file_object_id: randomUUID(), file_sha256: secondSha, source_kind: 'STATEMENT_FILE' } });
    expect((await apiCall('treasuryReader', 'POST', '/treasury-imports/files', { body: {} })).status).toBe(403);
    expect(refused.status).toBe(403);

    await open(page, 'nobody', secondImportId);
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByTestId('summary')).toHaveCount(0);
    // An import of the tenant is not found under an address that is not an import.
    await open(page, 'treasuryReader', randomUUID());
    await expect(page.getByTestId('import-missing')).toHaveText(vi['pay.import.notFound.notice']);
  });

  test('the person who drafted or sent a payment request may not confirm it with the Treasury; another accountant may, and an amount that is not the net opens a difference (four-eyes)', async () => {
    const requests = await sql<{ id: string; request_no: string }>("select id, request_no from machvon.payment_request where request_no like 'HS-PAY-%' order by request_no");
    expect(requests).toHaveLength(4);
    const evidence = (await sql<{ id: string }>("select id from machvon.document_version where object_key = 'tenants/e2e/treasury-evidence.pdf'"))[0]?.id;
    const body = (request: string, no: string, amount: string): Record<string, unknown> => ({
      payment_request_id: request,
      document_no: `${no}-${RUN}`,
      document_date: '2026-10-15',
      amount_vnd: amount,
      confirmed_at: '2026-10-16T02:00:00Z',
      evidence_document_version_id: evidence,
    });
    const [exact, mismatch] = [requests[0]?.id ?? '', requests[1]?.id ?? ''];

    const self = await apiCall('treasuryMaker', 'POST', '/treasury-transactions', { body: body(exact, 'M1', '5000000') });
    expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect(await sql('select count(*)::int as n from machvon.treasury_transaction where payment_request_id = $1', [exact])).toEqual([{ n: 0 }]);
    // Someone who holds no permission to confirm is refused before the rule is reached.
    expect((await apiCall('treasuryReader', 'POST', '/treasury-transactions', { body: body(exact, 'M1', '5000000') })).status).toBe(403);

    const confirmed = await apiCall('treasuryChecker', 'POST', '/treasury-transactions', { body: body(exact, 'M1', '5000000') });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toMatchObject({ status: 'UNMATCHED', reconciliation_item_id: null });
    expect(await sql('select source_kind, match_status, payment_request_id, created_by from machvon.treasury_transaction where id = $1', [confirmed.json.resource_id])).toEqual([
      { source_kind: 'MANUAL_CONFIRMED', match_status: 'UNMATCHED', payment_request_id: exact, created_by: membershipOf('treasuryChecker') },
    ]);
    const again = await apiCall('treasuryChecker', 'POST', '/treasury-transactions', { body: body(exact, 'M2', '5000000') });
    expect([again.status, again.json.code]).toEqual([409, 'TREASURY_TRANSACTION_DUPLICATE']);

    const off = await apiCall('treasuryChecker', 'POST', '/treasury-transactions', { body: body(mismatch, 'M3', '5000500') });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ status: 'EXCEPTION', reconciliation_item_id: expect.any(String) });
    expect(await sql('select kind, internal_amount_vnd::text as internal, confirmed_amount_vnd::text as confirmed, difference_vnd::text as difference, owner_membership_id from machvon.reconciliation_item where id = $1', [off.json.reconciliation_item_id])).toEqual([
      { kind: 'AMOUNT_MISMATCH', internal: '5000000', confirmed: '5000500', difference: '500', owner_membership_id: membershipOf('treasuryChecker') },
    ]);
    expect(await sql("select action from machvon.audit_event where resource_id = $1", [confirmed.json.resource_id])).toEqual([{ action: 'pay.treasury_transaction_confirmed' }]);
  });

  test('the Treasury callback is refused without the signing key of its provider: the adapter is MISSING and nothing is accepted unsigned', async () => {
    const reply = await apiCall('owner', 'POST', '/integrations/treasury/callbacks', {
      body: { provider_event_id: `evt-${RUN}`, provider: 'KBNN_MOCK', document_no: `CB-${RUN}`, document_date: '2026-10-15', project_code: PROJECT, amount_vnd: '1000', direction: 'PAYMENT', confirmed_at: '2026-10-16T02:00:00Z', signature: 'a'.repeat(64) },
    });
    expect([reply.status, reply.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    expect(await sql('select count(*)::int as n from machvon.integration_event_inbox where event_key = $1', [`evt-${RUN}`])).toEqual([{ n: 0 }]);
  });
});
