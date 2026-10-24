import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql } from './support/stack.ts';

/**
 * DOC-08 in a real browser against the real API and database (apps/api/test/e2e-stack): the records clerk issues a sealed document after the server verified both
 * of its signatures again, the legal officer issues one whose template is not confirmed with a written reason, a document whose bytes changed after the seal is refused
 * and stays sealed, and an issued document is sent to its recipients and followed to the last receipt. The stack seeds the documents (titles below) with real
 * signatures of a test authority it trusts; what a screen changed is looked up in the database. No mail transport and no OCSP service exist: the email channel fails
 * honestly, and the test authority answers that its certificates are not revoked.
 */

const TITLES = {
  confirmed: 'Quyet dinh cho phat hanh (mau da xac nhan)',
  override: 'Quyet dinh phat hanh kem ly do (mau chua xac nhan)',
  tampered: 'Quyet dinh bi sua sau khi dong dau',
  distribute: 'Quyet dinh dang phan phoi',
  visualSealed: 'Quyet dinh hien thi cho phat hanh',
  visualIssued: 'Quyet dinh hien thi da phan phoi',
  resend: 'Quyet dinh gui lai qua thu dien tu',
} as const;
const REASON = 'Phap che da xac nhan mau bang cong van so 12/PC';

async function idOf(title: string): Promise<string> {
  const [row] = await sql<{ id: string }>('select o.id from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where d.title = $1', [title]);
  if (row === undefined) throw new Error(`no document titled ${title}`);
  return row.id;
}

async function open(page: Page, user: string, title: string): Promise<string> {
  const id = await idOf(title);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/doc/doc-08?devUser=${user}&doc=${id}`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForSelector(`[data-document-id="${id}"]`);
  return id;
}

interface State {
  status: string;
  override: string | null;
  issued: number;
  delivered: number;
  acknowledged: number;
}

async function stateOf(id: string): Promise<State> {
  const [row] = await sql<{ status: string; override: string | null }>('select status, unconfirmed_override_reason as override from machvon.outgoing_document where id = $1', [id]);
  if (row === undefined) throw new Error('no such document');
  const [events] = await sql<{ issued: string; delivered: string; acknowledged: string }>(
    `select count(*) filter (where type = 'doc.issued.v1')::text as issued, count(*) filter (where type = 'doc.delivered.v1')::text as delivered,
            count(*) filter (where type = 'doc.acknowledged.v1')::text as acknowledged
       from machvon.outbox_event where aggregate_id = $1`,
    [id],
  );
  return { status: row.status, override: row.override, issued: Number(events?.issued), delivered: Number(events?.delivered), acknowledged: Number(events?.acknowledged) };
}

const rowsOf = (id: string) =>
  sql<{ id: string; recipient_name: string; channel: string; status: string; attempts: number; error_code: string | null }>(
    'select id, recipient_name, channel, status, attempts, error_code from machvon.document_distribution where outgoing_document_id = $1 order by channel',
    [id],
  );

test.describe('DOC-08: verify, issue and distribute', () => {
  test('the clerk issues a sealed document after its signatures were verified again, and the event goes out once', async ({ page }) => {
    const id = await open(page, 'docIssuer', TITLES.confirmed);
    expect(await stateOf(id)).toMatchObject({ status: 'SEALED', issued: 0 });
    const before = await sql<{ n: string }>('select count(*)::text as n from machvon.document_signature s join machvon.document d on d.current_version_id = s.document_version_id join machvon.outgoing_document o on o.document_id = d.id where o.id = $1', [id]);
    await expect(page.getByTestId('document-status')).toHaveText(vi['doc.distribution.status.sealed']);
    await expect(page.getByLabel(vi['doc.distribution.reason.label'])).toHaveCount(0);
    await page.getByRole('button', { name: vi['doc.distribution.issue.action'] }).click();
    await expect(page.getByText(vi['doc.distribution.done.issued'])).toBeVisible();
    await expect(page.getByTestId('document-status')).toHaveText(vi['doc.distribution.status.issued']);
    expect(await stateOf(id)).toMatchObject({ status: 'ISSUED', override: null, issued: 1 });
    const after = await sql<{ n: string }>('select count(*)::text as n from machvon.document_signature s join machvon.document d on d.current_version_id = s.document_version_id join machvon.outgoing_document o on o.document_id = d.id where o.id = $1', [id]);
    expect(Number(after[0]?.n) - Number(before[0]?.n)).toBe(2);
    const [audit] = await sql<{ n: string }>("select count(*)::text as n from machvon.audit_event where resource_id = $1 and action = 'outgoing_document.issue'", [id]);
    expect(audit?.n).toBe('1');
    // Issued, it is distributed: the form to send it to the recipients has taken the place of the issue form.
    await expect(page.getByRole('form', { name: vi['doc.distribution.dispatch.form'] })).toBeVisible();
    await expect(page.getByRole('form', { name: vi['doc.distribution.issue.form'] })).toHaveCount(0);
  });

  test('a clerk who may not confirm templates cannot issue a document with an unconfirmed template; the legal officer issues it with a written reason', async ({ page }) => {
    const id = await open(page, 'docIssuer', TITLES.override);
    await expect(page.getByText(vi['doc.distribution.watermark.notice'])).toBeVisible();
    await expect(page.getByLabel(vi['doc.distribution.reason.label'])).toBeDisabled();
    await expect(page.getByRole('button', { name: vi['doc.distribution.issue.action'] })).toBeDisabled();
    expect(await stateOf(id)).toMatchObject({ status: 'SEALED', issued: 0 });

    await open(page, 'docLegal', TITLES.override);
    const issue = page.getByRole('button', { name: vi['doc.distribution.issue.action'] });
    await issue.click();
    await expect(page.getByRole('alert')).toHaveText(vi['doc.distribution.reason.problem.required']);
    await page.getByLabel(vi['doc.distribution.reason.label']).fill('qua ngan');
    await issue.click();
    await expect(page.getByRole('alert')).toHaveText(vi['doc.distribution.reason.problem.tooShort']);
    expect(await stateOf(id)).toMatchObject({ status: 'SEALED', issued: 0 });
    await page.getByLabel(vi['doc.distribution.reason.label']).fill(REASON);
    await issue.click();
    await expect(page.getByText(vi['doc.distribution.done.issued'])).toBeVisible();
    await expect(page.getByText(vi['doc.distribution.override.notice'].replace('{reason}', REASON))).toBeVisible();
    expect(await stateOf(id)).toMatchObject({ status: 'ISSUED', override: REASON, issued: 1 });
    const [audit] = await sql<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'outgoing_document.issue'", [id]);
    expect(audit?.safe_diff).toMatchObject({ unconfirmed_override_reason: REASON });
  });

  test('a document whose bytes changed after the seal is refused with the finding, stays sealed and announces nothing', async ({ page }) => {
    const id = await open(page, 'docIssuer', TITLES.tampered);
    await page.getByRole('button', { name: vi['doc.distribution.issue.action'] }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(vi['doc.distribution.problem.signature']);
    await expect(alert).toContainText('DIGEST_MISMATCH');
    await expect(page.getByTestId('document-status')).toHaveText(vi['doc.distribution.status.sealed']);
    expect(await stateOf(id)).toMatchObject({ status: 'SEALED', issued: 0 });
    const [issuedAt] = await sql<{ issued_at: string | null }>('select issued_at from machvon.outgoing_document where id = $1', [id]);
    expect(issuedAt?.issued_at).toBeNull();
  });

  test('an issued document is sent to its recipients, delivered at the first receipt and acknowledged at the last', async ({ page }) => {
    const id = await open(page, 'docIssuer', TITLES.distribute);
    await page.getByLabel(vi['doc.distribution.dispatch.select.label'].replace('{name}', 'Phong Ke hoach')).check();
    await page.getByLabel(vi['doc.distribution.dispatch.select.label'].replace('{name}', 'So Tai chinh')).check();
    await page.getByRole('button', { name: vi['doc.distribution.dispatch.action'] }).click();
    await expect(page.getByText(vi['doc.distribution.done.sent'])).toBeVisible();
    // The inbox of the unit has it at once; the paper handover is only sent: the document is delivered, not yet acknowledged.
    expect(await rowsOf(id)).toMatchObject([
      { channel: 'INTERNAL', status: 'DELIVERED', recipient_name: 'Phong Ke hoach' },
      { channel: 'PAPER_HANDOVER', status: 'SENT', recipient_name: 'So Tai chinh' },
    ]);
    expect(await stateOf(id)).toMatchObject({ status: 'DELIVERED', delivered: 1, acknowledged: 0 });
    await expect(page.getByTestId('document-status')).toHaveText(vi['doc.distribution.status.delivered']);
    await expect(page.getByTestId('progress')).toHaveText(vi['doc.distribution.progress.text'].replace('{reached}', '1').replace('{total}', '2').replace('{acknowledged}', '0'));

    // Both recipients already have a row on their channel: sending again offers nothing new.
    await expect(page.getByLabel(vi['doc.distribution.dispatch.select.label'].replace('{name}', 'So Tai chinh'))).toBeDisabled();

    const receipt = async (name: string, reference: string): Promise<void> => {
      await page.locator('tr[data-distribution-id]', { hasText: name }).getByRole('button', { name: vi['doc.distribution.row.receipt.action'] }).click();
      await page.getByLabel(vi['doc.distribution.receipt.ref.label']).fill(reference);
      await page.getByRole('button', { name: vi['doc.distribution.receipt.submit.action'], exact: true }).click();
      await expect(page.getByRole('form', { name: vi['doc.distribution.receipt.form'] })).toHaveCount(0);
      await expect(page.locator('tr[data-distribution-id]', { hasText: name })).toHaveAttribute('data-status', 'ACKNOWLEDGED');
    };
    await receipt('Phong Ke hoach', 'BN-01');
    expect(await stateOf(id)).toMatchObject({ status: 'DELIVERED', acknowledged: 0 });
    await receipt('So Tai chinh', 'BN-02');
    expect(await stateOf(id)).toMatchObject({ status: 'ACKNOWLEDGED', delivered: 1, acknowledged: 1 });
    await expect(page.getByTestId('document-status')).toHaveText(vi['doc.distribution.status.acknowledged']);
    expect((await rowsOf(id)).map((row) => row.status)).toEqual(['ACKNOWLEDGED', 'ACKNOWLEDGED']);
    const [stored] = await sql<{ external_ref: string }>("select external_ref from machvon.document_distribution where outgoing_document_id = $1 and channel = 'PAPER_HANDOVER'", [id]);
    expect(stored?.external_ref).toBe('BN-02');
  });

  test('a message by email fails honestly while no mail transport exists, and sending it again changes the same row and nothing else', async ({ page }) => {
    const id = await open(page, 'docIssuer', TITLES.resend);
    const line = page.locator('tr[data-distribution-id]');
    await expect(line).toHaveAttribute('data-status', 'FAILED');
    await expect(line).toContainText(vi['doc.distribution.error.provider']);
    await line.getByRole('button', { name: vi['doc.distribution.row.retry.action'] }).click();
    await expect.poll(async () => (await rowsOf(id))[0]?.attempts).toBe(2);
    expect(await rowsOf(id)).toMatchObject([{ channel: 'EMAIL', status: 'FAILED', error_code: 'PROVIDER_UNAVAILABLE', attempts: 2 }]);
    await expect(page.getByTestId('document-status')).toHaveText(vi['doc.distribution.status.issued']);
    expect(await stateOf(id)).toMatchObject({ status: 'ISSUED', delivered: 0 });
  });

  test('a clerk who may only issue cannot distribute, and a reader sees the screen with nothing to change', async ({ page }) => {
    await open(page, 'docIssueOnly', TITLES.visualIssued);
    await expect(page.locator('tr[data-distribution-id]')).toHaveCount(2);
    await expect(page.getByRole('form', { name: vi['doc.distribution.dispatch.form'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['doc.distribution.row.receipt.action'] })).toHaveCount(0);

    const id = await open(page, 'docReader', TITLES.visualSealed);
    await expect(page.getByText(vi['doc.distribution.denied.issue'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['doc.distribution.issue.action'] })).toHaveCount(0);
    expect(await stateOf(id)).toMatchObject({ status: 'SEALED', issued: 0 });
  });
});
