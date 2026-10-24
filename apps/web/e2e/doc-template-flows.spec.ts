import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * DOC-14 in a real browser against the real API and database (apps/api/test/e2e-stack): a template is drafted by one person (the draft has no
 * form on the screen, so it goes through the API as the drafter), published by a second and legally confirmed by a third. The screen offers
 * each person only their own step, and the server refuses the step that the screen hides (the same person twice, or a person without the
 * permission). What the screen changed is looked up in the database.
 */

const unique = (): string => `E2E-TPL-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 100)}`;
const WATERMARK = 'UNCONFIRMED LEGAL BASIS [CXN-10]';
const LEGAL_BASIS = 'Thông tư 44/2026/TT-BTC [CXN-10]';
const ADMIN = membershipOf('templateAdmin');
const PUBLISHER = membershipOf('templatePublisher');
const LEGAL = membershipOf('legalOfficer');

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/doc/doc-14?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** Narrows the library to one template code, so the rows of the other flows and of the platform pack are out of the way. */
async function find(page: Page, code: string): Promise<void> {
  await page.getByLabel(vi['doc.templates.search.label'], { exact: true }).fill(code);
  await page.getByRole('button', { name: vi['doc.templates.filter.action'], exact: true }).click();
}

const rowOf = (page: Page, code: string, revision = 1) => page.locator('tr[data-template-id]', { hasText: code }).filter({ hasText: vi['doc.templates.revision.pill'].replace('{revision}', String(revision)) });

interface TemplateRow {
  revision: number;
  status: string;
  confirmation_status: string;
  created_by: string;
  approved_by: string | null;
  legal_confirmed_by: string | null;
  legal_confirmation_ref: string | null;
  legal_evidence_document_id: string | null;
  effective_from: string;
  effective_until: string | null;
  retirement_reason: string | null;
  version: string;
}

const revisionsOf = (code: string): Promise<TemplateRow[]> =>
  sql(
    `select revision, status, confirmation_status, created_by, approved_by, legal_confirmed_by, legal_confirmation_ref, legal_evidence_document_id, effective_from::text, effective_until::text, retirement_reason, version::text
       from machvon.document_template where template_code = $1 order by revision`,
    [code],
  );

async function layoutProfile(): Promise<string> {
  const rows = await sql<{ id: string }>("select id from machvon.document_layout_profile where tenant_id = $1 and status = 'PUBLISHED' limit 1", [stackInfo().tenants.A]);
  if (rows[0] === undefined) throw new Error('the stack has no published layout profile');
  return rows[0].id;
}

/** A document of the library the legal confirmation can name as its evidence. */
async function evidenceDocument(): Promise<string> {
  const rows = await sql<{ document_id: string }>('select document_id from machvon.outgoing_document where id = $1', [stackInfo().documents.visualSigned]);
  if (rows[0] === undefined) throw new Error('the stack has no document to serve as evidence');
  return rows[0].document_id;
}

interface Drafted {
  id: string;
  version: number;
}

async function draft(code: string, period: { from: string; until?: string }): Promise<Drafted> {
  const reply = await apiCall('templateAdmin', 'POST', '/document-templates', {
    body: {
      template_code: code,
      group_code: 'REPORT_MONITORING',
      doc_type_code: 'BC',
      title: 'Báo cáo giám sát thử nghiệm',
      layout_profile_id: await layoutProfile(),
      body_blocks: { blocks: [{ kind: 'heading', text: '{{title}}' }, { kind: 'paragraph', text: '{{body}}' }] },
      placeholder_schema: { required: ['title', 'body'] },
      legal_basis: LEGAL_BASIS,
      effective_from: period.from,
      ...(period.until === undefined ? {} : { effective_until: period.until }),
      watermark_text: WATERMARK,
    },
  });
  expect([reply.status, reply.json.status]).toEqual([200, 'DRAFT']);
  return { id: reply.json.resource_id as string, version: reply.json.resource_version as number };
}

test.describe('DOC-14 template library', () => {
  test('a template is drafted, published by a second person and legally confirmed by a third, and nobody takes two steps (AC-ST-DOC-006-1)', async ({ page }) => {
    const code = unique();
    const { id, version } = await draft(code, { from: '2026-01-01' });

    // The drafter holds the permission to publish, but the screen offers the step to someone else; the server says the same.
    await open(page, 'templateAdmin');
    await expect(page.getByRole('heading', { level: 1, name: vi['doc.templates.page.title'] })).toBeVisible();
    await find(page, code);
    const asDrafted = rowOf(page, code);
    await expect(asDrafted.locator('[data-lifecycle]')).toHaveText(vi['doc.templates.state.draft']);
    await expect(asDrafted.locator('[data-confirmation="pending"]')).toHaveText('Chờ xác nhận [CXN-10]');
    await expect(asDrafted.getByText(vi['doc.templates.publish.other.hint'])).toBeVisible();
    await expect(asDrafted.getByRole('button', { name: vi['doc.templates.publish.action'] })).toHaveCount(0);
    const selfPublish = await apiCall('templateAdmin', 'POST', `/document-templates/${id}/publish`, { version });
    expect([selfPublish.status, selfPublish.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect((await revisionsOf(code))[0]).toMatchObject({ status: 'DRAFT', approved_by: null, version: '1' });

    // A second person publishes it: the template is in force, still waiting for the legal confirmation, and its renders carry the watermark.
    await open(page, 'templatePublisher');
    await find(page, code);
    await rowOf(page, code).getByRole('button', { name: vi['doc.templates.publish.label'].replace('{code}', code).replace('{revision}', '1') }).click();
    const publishForm = page.getByRole('form', { name: vi['doc.templates.publish.title'].replace('{code}', code).replace('{revision}', '1') });
    await publishForm.getByRole('button', { name: vi['doc.templates.publish.confirm.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: vi['doc.templates.publish.done.notice'].replace('{code}', code) })).toBeVisible();
    expect(await revisionsOf(code)).toEqual([
      {
        revision: 1,
        status: 'PUBLISHED',
        confirmation_status: 'PENDING_CONFIRMATION',
        created_by: ADMIN,
        approved_by: PUBLISHER,
        legal_confirmed_by: null,
        legal_confirmation_ref: null,
        legal_evidence_document_id: null,
        effective_from: '2026-01-01',
        effective_until: null,
        retirement_reason: null,
        version: '2',
      },
    ]);
    const published = rowOf(page, code);
    await expect(published.locator('[data-lifecycle]')).toHaveText(vi['doc.templates.state.published']);
    await expect(published.locator('[data-confirmation="pending"]')).toHaveText('Chờ xác nhận [CXN-10]');
    await expect(published.getByText(vi['doc.templates.watermark.text'].replace('{text}', WATERMARK))).toBeVisible();

    // The publisher holds the permission to confirm but published it: the step is for someone else, and the server refuses it too.
    await expect(published.getByText(vi['doc.templates.legal.other.hint'])).toBeVisible();
    await expect(published.getByRole('button', { name: vi['doc.templates.legal.action'] })).toHaveCount(0);
    const evidence = await evidenceDocument();
    const body = { legal_confirmation_ref: 'CXN-10', evidence_document_id: evidence };
    const selfConfirm = await apiCall('templatePublisher', 'POST', `/document-templates/${id}/legal-confirmation`, { version: 2, body });
    expect([selfConfirm.status, selfConfirm.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    // Whoever lacks the permission is refused as well, and the screen shows them no step.
    const noPermission = await apiCall('templateAdmin', 'POST', `/document-templates/${id}/legal-confirmation`, { version: 2, body });
    expect([noPermission.status, noPermission.json.code]).toEqual([403, 'SCOPE_DENIED']);
    expect((await revisionsOf(code))[0]).toMatchObject({ confirmation_status: 'PENDING_CONFIRMATION', legal_confirmed_by: null, version: '2' });

    // The third person confirms: empty fields and a short reference are refused before they are sent, an unknown evidence document by the server.
    await open(page, 'legalOfficer');
    await find(page, code);
    await rowOf(page, code).getByRole('button', { name: vi['doc.templates.legal.label'].replace('{code}', code).replace('{revision}', '1') }).click();
    const legalForm = page.getByRole('form', { name: vi['doc.templates.legal.title'].replace('{code}', code).replace('{revision}', '1') });
    const confirmButton = legalForm.getByRole('button', { name: vi['doc.templates.legal.confirm.action'] });
    await confirmButton.click();
    await expect(legalForm.locator('[data-field="reference"]').getByText(vi['doc.templates.field.required'])).toBeVisible();
    await expect(legalForm.locator('[data-field="evidence"]').getByText(vi['doc.templates.field.required'])).toBeVisible();
    await legalForm.getByLabel(vi['doc.templates.legal.reference.label'], { exact: true }).fill('CX');
    await legalForm.getByLabel(vi['doc.templates.legal.evidence.label'], { exact: true }).fill('not-a-uuid');
    await confirmButton.click();
    await expect(legalForm.locator('[data-field="reference"]').getByText(vi['doc.templates.field.tooShort'])).toBeVisible();
    await expect(legalForm.locator('[data-field="evidence"]').getByText(vi['doc.templates.field.uuid'])).toBeVisible();
    await legalForm.getByLabel(vi['doc.templates.legal.reference.label'], { exact: true }).fill('CXN-10');
    await legalForm.getByLabel(vi['doc.templates.legal.evidence.label'], { exact: true }).fill('00000000-0000-4000-8000-00000000dead');
    await confirmButton.click();
    await expect(legalForm.getByRole('alert').filter({ hasText: vi['doc.templates.problem.invalid.text'] })).toBeVisible();
    expect((await revisionsOf(code))[0]).toMatchObject({ confirmation_status: 'PENDING_CONFIRMATION', legal_confirmed_by: null });

    await legalForm.getByLabel(vi['doc.templates.legal.evidence.label'], { exact: true }).fill(evidence);
    await confirmButton.click();
    await expect(page.getByRole('status').filter({ hasText: vi['doc.templates.legal.done.notice'].replace('{code}', code) })).toBeVisible();
    expect(await revisionsOf(code)).toEqual([
      {
        revision: 1,
        status: 'PUBLISHED',
        confirmation_status: 'CONFIRMED',
        created_by: ADMIN,
        approved_by: PUBLISHER,
        legal_confirmed_by: LEGAL,
        legal_confirmation_ref: 'CXN-10',
        legal_evidence_document_id: evidence,
        effective_from: '2026-01-01',
        effective_until: null,
        retirement_reason: null,
        version: '3',
      },
    ]);
    const confirmed = rowOf(page, code);
    await expect(confirmed.locator('[data-confirmation="confirmed"]')).toHaveText(vi['doc.templates.confirmation.confirmed']);
    await expect(confirmed.getByText(vi['doc.templates.confirmation.reference'].replace('{reference}', 'CXN-10'))).toBeVisible();
    await expect(confirmed.getByText(vi['doc.templates.watermark.text'].replace('{text}', WATERMARK))).toHaveCount(0);
    // The layout profile of the stack still waits for its own confirmation, and the library says that renders keep the watermark for that reason.
    await expect(confirmed.getByText(vi['doc.templates.layout.pending'])).toBeVisible();
    for (const action of ['doc.templates.publish.action', 'doc.templates.legal.action'] as const) {
      await expect(confirmed.getByRole('button', { name: vi[action] })).toHaveCount(0);
    }
    expect(
      await sql("select action from machvon.audit_event where resource_id = $1 and action like 'document_template.%' and outcome = 'SUCCESS' order by occurred_at", [id]),
    ).toEqual([{ action: 'document_template.draft' }, { action: 'document_template.publish' }, { action: 'document_template.confirm_legal' }]);
  });

  test('revisions are in force by date, an overlapping revision is refused, and a draft is retired for a stated reason (AC-ST-DOC-006-2)', async ({ page }) => {
    const code = unique();
    const first = await draft(code, { from: '2026-01-01', until: '2027-01-01' });
    expect((await apiCall('templatePublisher', 'POST', `/document-templates/${first.id}/publish`, { version: first.version })).status).toBe(200);
    const second = await draft(code, { from: '2027-01-01' });
    const overlapping = await draft(code, { from: '2026-03-01', until: '2026-06-01' });
    expect(second.id).not.toBe(overlapping.id);

    await open(page, 'templatePublisher');
    await find(page, code);
    await expect(page.locator('tr[data-template-id]', { hasText: code })).toHaveCount(3);
    await rowOf(page, code, 2).getByRole('button', { name: vi['doc.templates.publish.label'].replace('{code}', code).replace('{revision}', '2') }).click();
    await page.getByRole('form', { name: vi['doc.templates.publish.title'].replace('{code}', code).replace('{revision}', '2') }).getByRole('button', { name: vi['doc.templates.publish.confirm.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: vi['doc.templates.publish.done.notice'].replace('{code}', code) })).toBeVisible();

    // The third revision lies inside the period of the first: the server refuses it and it stays a draft.
    await rowOf(page, code, 3).getByRole('button', { name: vi['doc.templates.publish.label'].replace('{code}', code).replace('{revision}', '3') }).click();
    const overlapForm = page.getByRole('form', { name: vi['doc.templates.publish.title'].replace('{code}', code).replace('{revision}', '3') });
    await overlapForm.getByRole('button', { name: vi['doc.templates.publish.confirm.action'] }).click();
    await expect(overlapForm.getByRole('alert').filter({ hasText: vi['doc.templates.problem.rangeOverlap.text'] })).toBeVisible();
    expect((await revisionsOf(code)).map((row) => [row.revision, row.status, row.effective_from, row.effective_until])).toEqual([
      [1, 'PUBLISHED', '2026-01-01', '2027-01-01'],
      [2, 'PUBLISHED', '2027-01-01', null],
      [3, 'DRAFT', '2026-03-01', '2026-06-01'],
    ]);

    // The library shows the revision in force on a day: the last day of the first, then the first day of the second.
    await page.getByLabel(vi['doc.templates.asOf.label'], { exact: true }).fill('2026-12-31');
    await page.getByRole('button', { name: vi['doc.templates.filter.action'], exact: true }).click();
    await expect(page.locator('tr[data-template-id]', { hasText: code })).toHaveCount(1);
    await expect(rowOf(page, code, 1)).toBeVisible();
    await page.getByLabel(vi['doc.templates.asOf.label'], { exact: true }).fill('2027-01-01');
    await page.getByRole('button', { name: vi['doc.templates.filter.action'], exact: true }).click();
    await expect(page.locator('tr[data-template-id]', { hasText: code })).toHaveCount(1);
    await expect(rowOf(page, code, 2)).toBeVisible();

    // Whoever manages templates retires the refused draft, for a reason of at least ten characters.
    await open(page, 'templateAdmin');
    await find(page, code);
    await rowOf(page, code, 3).getByRole('button', { name: vi['doc.templates.retire.label'].replace('{code}', code).replace('{revision}', '3') }).click();
    const retireForm = page.getByRole('form', { name: vi['doc.templates.retire.title'].replace('{code}', code).replace('{revision}', '3') });
    await retireForm.getByLabel(vi['doc.templates.retire.reason.label'], { exact: true }).fill('ngắn');
    await retireForm.getByRole('button', { name: vi['doc.templates.retire.confirm.action'] }).click();
    await expect(retireForm.getByText(vi['doc.templates.field.tooShort'])).toBeVisible();
    expect((await revisionsOf(code))[2]?.status).toBe('DRAFT');
    await retireForm.getByLabel(vi['doc.templates.retire.reason.label'], { exact: true }).fill('Khoảng hiệu lực trùng với bản đã công bố');
    await retireForm.getByRole('button', { name: vi['doc.templates.retire.confirm.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: vi['doc.templates.retire.done.notice'].replace('{code}', code) })).toBeVisible();
    expect((await revisionsOf(code))[2]).toMatchObject({ status: 'RETIRED', retirement_reason: 'Khoảng hiệu lực trùng với bản đã công bố' });
  });

  test('a reader sees the library without any step, and a member without the right to read gets the denied state', async ({ page }) => {
    const code = unique();
    await draft(code, { from: '2026-01-01' });
    await open(page, 'templateReader');
    await find(page, code);
    await expect(rowOf(page, code)).toBeVisible();
    await expect(rowOf(page, code).getByRole('button')).toHaveCount(0);

    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-template-id]')).toHaveCount(0);
  });
});
