import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * DOC-02, DOC-03 and DOC-04 in a real browser against the real API and database (apps/api/test/e2e-stack): the drafter composes a decision from
 * the template in force and sends it for review, a reviewer other than the drafter checks the format and locks the final PDF, and the leader
 * signs that very file on DOC-05. The head who drafts and may also review is refused when approving their own document, the signer who lacks the
 * authority of the matrix is refused with the band, a returned draft shows its reason, and a reader sees the list and nothing to change.
 * What the screens changed is looked up in the database.
 */

const CHECKLIST = ['national_title', 'motto', 'agency_name', 'number_symbol', 'summary', 'body', 'signer_title', 'recipients'] as const;
const camel = (key: string): string => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
const unique = (): string => `E2E draft ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** The drafting unit of the stack: the one the seeded documents were drafted in, where the drafters hold their grants. */
async function draftingUnit(): Promise<string> {
  const [row] = await sql<{ drafting_unit_id: string }>('select drafting_unit_id from machvon.outgoing_document where id = $1', [stackInfo().documents.visualSigned]);
  if (row === undefined) throw new Error('the stack has no drafting unit');
  return row.drafting_unit_id;
}

interface DocumentRow {
  status: string;
  signer_user_id: string | null;
  drafter_user_id: string;
  payload_json: Record<string, unknown> | null;
  recipients: Array<{ name: string }>;
  title: string;
  current_version_id: string | null;
  version: string;
}

async function rowOf(id: string): Promise<DocumentRow> {
  const [row] = await sql<DocumentRow>(
    `select o.status, o.signer_user_id, o.drafter_user_id, o.payload_json, o.recipients, d.title, d.current_version_id, o.version::text as version
       from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where o.id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such document');
  return row;
}

async function createViaApi(user: string, title: string, signer: string): Promise<{ id: string; version: number }> {
  const unit = await draftingUnit();
  const reply = await apiCall(user, 'POST', '/outgoing-documents', {
    body: {
      doc_type_code: 'QD',
      template_code: 'QD-DEFAULT',
      title,
      drafting_unit_id: unit,
      payload: { agency: 'E2E Agency', place: 'Cao Bang', title, body: 'Text of the decision', amount_vnd: '1000000000' },
      recipients: [{ name: 'Department of Finance' }],
      signer_user_id: signer,
    },
  });
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return { id: reply.json.resource_id as string, version: reply.json.resource_version as number };
}

async function submitViaApi(user: string, id: string, version: number): Promise<number> {
  const reply = await apiCall(user, 'POST', `/outgoing-documents/${id}/review-submission`, { version });
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return reply.json.resource_version as number;
}

test.describe('DOC-02 compose, DOC-03 list, DOC-04 review', () => {
  test('the drafter composes and sends for review, the reviewer locks the final PDF and the leader signs it', async ({ page }) => {
    const title = unique();
    const unit = await draftingUnit();
    await open(page, 'docDrafter', '/doc/doc-02');
    await expect(page.getByRole('heading', { level: 1, name: vi['doc.editor.page.title'] })).toBeVisible();
    await expect(page.locator('#editor-type option[value="QD"]')).toHaveCount(1);
    await page.getByLabel(vi['doc.editor.type.label'], { exact: true }).selectOption('QD');
    await expect(page.getByLabel(vi['doc.editor.template.label'], { exact: true })).toHaveValue('QD-DEFAULT');
    await expect(page.getByText(vi['doc.editor.template.watermark'])).toBeVisible();
    await page.getByLabel(vi['doc.editor.unit.label'], { exact: true }).selectOption(unit);
    await page.getByLabel(vi['doc.editor.title.label'], { exact: true }).fill(title);
    await page.getByLabel(vi['doc.editor.field.agency'], { exact: true }).fill('People Committee of Cao Bang');
    await page.getByLabel(vi['doc.editor.field.place'], { exact: true }).fill('Cao Bang');
    await page.getByLabel(vi['doc.editor.field.amount'], { exact: true }).fill('1000000000');
    await page.locator('#editor-field-title').fill(`Decision ${title}`);
    await page.locator('#editor-field-body').fill('The capital plan of the year is assigned to the units of the annex.');
    await page.getByRole('button', { name: vi['doc.editor.recipient.add.action'] }).click();
    await page.getByLabel(vi['doc.editor.recipient.name'], { exact: true }).fill('Department of Finance');
    await page.getByLabel(vi['doc.editor.signer.label'], { exact: true }).fill(membershipOf('owner'));
    await page.getByRole('button', { name: vi['doc.editor.save.action'] }).click();
    await expect(page.getByText(vi['doc.editor.saved.notice'])).toBeVisible();

    const [created] = await sql<{ id: string }>('select o.id from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where d.title = $1', [title]);
    expect(created).toBeDefined();
    const id = created?.id ?? '';
    expect(await rowOf(id)).toMatchObject({ status: 'DRAFT', signer_user_id: membershipOf('owner'), drafter_user_id: membershipOf('docDrafter'), recipients: [{ kind: 'EXTERNAL_AGENCY', name: 'Department of Finance' }] });
    expect((await rowOf(id)).payload_json).toMatchObject({ agency: 'People Committee of Cao Bang', amount_vnd: '1000000000' });

    // A watermarked preview is rendered.
    await page.getByRole('button', { name: vi['doc.editor.preview.action'] }).click();
    await expect(page.getByText(vi['doc.editor.preview.watermarked'])).toBeVisible();
    // The drafter holds a grant on a branch of the tree, and the preview is a document of no unit: the file is not theirs to download.
    await expect(page.getByText(vi['doc.editor.preview.noLink'])).toBeVisible();

    await page.getByRole('button', { name: vi['doc.editor.submit.action'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['doc.review.page.title'] })).toBeVisible();
    expect((await rowOf(id)).status).toBe('IN_REVIEW');
    // The drafter sees the document but has nothing to decide.
    await expect(page.getByRole('button', { name: vi['doc.review.approve.action'] })).toHaveCount(0);

    await open(page, 'docReviewer', `/doc/doc-04?doc=${id}`);
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    await expect(page.getByRole('button', { name: vi['doc.review.approve.action'] })).toBeDisabled();
    for (const key of CHECKLIST) await page.getByLabel(vi[`doc.review.checklist.${camel(key)}` as keyof typeof vi], { exact: true }).check();
    await page.getByLabel(vi['doc.review.comment.label'], { exact: true }).fill('Format checked by the reviewer');
    await page.getByRole('button', { name: vi['doc.review.approve.action'] }).click();
    await expect(page.getByText(vi['doc.review.approved.notice'])).toBeVisible();

    const approved = await rowOf(id);
    expect(approved).toMatchObject({ status: 'SUBMITTED' });
    const [final] = await sql<{ checksum: string; stage: string; scan_status: string }>('select checksum, stage, scan_status from machvon.document_version where id = $1', [approved.current_version_id]);
    expect(final).toMatchObject({ stage: 'RENDERED_FINAL', scan_status: 'CLEAN' });
    await expect(page.locator('[data-final-sha]')).toHaveAttribute('data-final-sha', final?.checksum ?? 'missing');
    const events = await sql<{ kind: string }>('select kind from machvon.outgoing_document_event where outgoing_document_id = $1 order by seq', [id]);
    expect(events.map((event) => event.kind)).toEqual(['CREATED', 'REVIEW_REQUESTED', 'REVIEW_APPROVED']);

    // The leader signs the very file that was locked.
    await open(page, 'owner', `/doc/doc-05?doc=${id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['doc.signing.page.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['doc.signing.start.action'] }).click();
    await page.getByRole('button', { name: vi['doc.signing.complete.action'] }).click();
    await expect(page.getByText(vi['doc.signing.signed.notice'])).toBeVisible();
    const signed = await rowOf(id);
    expect(signed.status).toBe('SIGNED');
    const stages = await sql<{ stage: string }>('select stage from machvon.document_version where document_id = (select document_id from machvon.outgoing_document where id = $1) order by version', [id]);
    expect(stages.map((row) => row.stage)).toEqual(['RENDERED_FINAL', 'LEADER_SIGNED']);

    // DOC-03 lists the document with its state, to the drafter who may open it.
    await open(page, 'docDrafter', '/doc/doc-03');
    const row = page.locator('tr[data-document-id]', { hasText: title });
    await expect(row).toHaveAttribute('data-status', 'SIGNED');
    await expect(page.getByRole('link', { name: vi['doc.list.create.action'] })).toBeVisible();
  });

  test('the head who drafts cannot approve their own document: the screen holds the button back and the server refuses', async ({ page }) => {
    const created = await createViaApi('docHead', unique(), membershipOf('owner'));
    await submitViaApi('docHead', created.id, created.version);
    await open(page, 'docHead', `/doc/doc-04?doc=${created.id}`);
    await expect(page.getByText(vi['doc.review.own.notice'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['doc.review.approve.action'] })).toBeDisabled();

    const checklist = Object.fromEntries(CHECKLIST.map((key) => [key, true]));
    const refused = await apiCall('docHead', 'POST', `/outgoing-documents/${created.id}/review-decision`, { version: 2, body: { decision: 'APPROVE', format_checklist: checklist } });
    expect([refused.status, refused.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect((await rowOf(created.id)).status).toBe('IN_REVIEW');
    const denied = await sql<{ n: string }>("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action = 'command.denied:decideOutgoingDocumentReview' and safe_diff->>'code' = 'SELF_APPROVAL_DENIED'");
    expect(Number(denied[0]?.n)).toBeGreaterThan(0);
  });

  test('a signer without the authority of the matrix is refused with the reason, and the draft stays a draft', async ({ page }) => {
    const created = await createViaApi('docDrafter', unique(), membershipOf('docReviewer'));
    await open(page, 'docDrafter', `/doc/doc-02?doc=${created.id}`);
    await expect(page.getByLabel(vi['doc.editor.title.label'], { exact: true })).not.toHaveValue('');
    await page.getByRole('button', { name: vi['doc.editor.submit.action'] }).click();
    await expect(page.getByRole('alert')).toContainText(vi['doc.draft.authority.role']);
    expect((await rowOf(created.id)).status).toBe('DRAFT');
    const denied = await sql<{ n: string }>("select count(*) as n from machvon.audit_event where resource_id = $1 and outcome = 'DENIED'", [created.id]);
    expect(Number(denied[0]?.n)).toBe(1);
  });

  test('a returned draft shows its reason to the drafter, who can change it and send it again', async ({ page }) => {
    const title = unique();
    const created = await createViaApi('docDrafter', title, membershipOf('owner'));
    await submitViaApi('docDrafter', created.id, created.version);
    await open(page, 'docReviewer', `/doc/doc-04?doc=${created.id}`);
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    await page.getByRole('button', { name: vi['doc.review.return.action'] }).click();
    await expect(page.getByText(vi['doc.draft.field.required'])).toBeVisible();
    await page.getByLabel(vi['doc.review.return.reason.label'], { exact: true }).fill('The recipients of the annex are missing');
    await page.getByRole('button', { name: vi['doc.review.return.action'] }).click();
    await expect(page.getByText(vi['doc.review.returned.notice'])).toBeVisible();
    expect((await rowOf(created.id)).status).toBe('DRAFT');

    await open(page, 'docDrafter', `/doc/doc-02?doc=${created.id}`);
    await expect(page.getByText('The recipients of the annex are missing')).toBeVisible();
    await page.getByRole('button', { name: vi['doc.editor.recipient.add.action'] }).click();
    await page.getByPlaceholder(vi['doc.editor.recipient.name']).last().fill('Provincial archive');
    await page.getByRole('button', { name: vi['doc.editor.save.action'] }).click();
    await expect(page.getByText(vi['doc.editor.saved.notice'])).toBeVisible();
    await page.getByRole('button', { name: vi['doc.editor.submit.action'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['doc.review.page.title'] })).toBeVisible();
    const row = await rowOf(created.id);
    expect(row.status).toBe('IN_REVIEW');
    expect(row.recipients.map((recipient) => recipient.name)).toEqual(['Department of Finance', 'Provincial archive']);
    const events = await sql<{ kind: string; comment: string | null }>('select kind, comment from machvon.outgoing_document_event where outgoing_document_id = $1 order by seq', [created.id]);
    expect(events.map((event) => event.kind)).toEqual(['CREATED', 'REVIEW_REQUESTED', 'RETURNED', 'REVIEW_REQUESTED']);
    expect(events[2]?.comment).toBe('The recipients of the annex are missing');
  });

  test('a reader sees the list and the draft and has nothing to change', async ({ page }) => {
    const created = await createViaApi('docDrafter', unique(), membershipOf('owner'));
    await open(page, 'docReader', '/doc/doc-03');
    await expect(page.getByRole('heading', { level: 1, name: vi['doc.list.page.title'] })).toBeVisible();
    await expect(page.locator(`tr[data-document-id="${created.id}"]`)).toBeVisible();
    await expect(page.getByRole('link', { name: vi['doc.list.create.action'] })).toHaveCount(0);

    await open(page, 'docReader', `/doc/doc-02?doc=${created.id}`);
    await expect(page.getByLabel(vi['doc.editor.title.label'], { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: vi['doc.editor.save.action'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['doc.editor.submit.action'] })).toHaveCount(0);

    const refused = await apiCall('docReader', 'POST', `/outgoing-documents/${created.id}/review-submission`, { version: created.version });
    expect([refused.status, refused.json.code]).toEqual([403, 'SCOPE_DENIED']);
    expect((await rowOf(created.id)).status).toBe('DRAFT');
  });
});
