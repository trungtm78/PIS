import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * ISS-04 (extension of the deadline) and ISS-07 (verification and closing) in a real browser against the real API and database
 * (apps/api/test/e2e-stack). The handler reports the work done with evidence; the handler is not offered the closing although their role holds it (the
 * database refuses it too); a different person confirms and closes it, or gives the result back with the reason, and reopens a closed issue. An
 * independent person extends the deadline twice and the third extension is not offered; the handler cannot approve their own. Someone who only reads can
 * read and nothing else. What the screens changed is looked up in the database.
 *
 * The spec makes its own category and policy (the stack seeds two categories that the SLA policy spec counts).
 */

const CATEGORY_KEY = 'E2E_ISS3_CATEGORY';
const CATEGORY_LABEL = `${CATEGORY_KEY} · Vướng mắc đóng và gia hạn`;
const POLICY_CODE = 'E2E-ISS3-SLA-HIGH';
const PROJECT_LABEL = 'DA-01 · Dự án thử';
const QLDA_LABEL = 'CB-SKHDT-QLDA · Ban Quản lý dự án';
const HOUR_MS = 3_600_000;
const VIETNAM_OFFSET_MS = 7 * HOUR_MS;
const unique = (): string => `Đóng vướng mắc ${Date.now().toString(36).toUpperCase()}`;

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

interface IssueRow {
  id: string;
  status: string;
  version: string;
  assignee_id: string | null;
  verifier_id: string | null;
  closed_by: string | null;
  closed_at: Date | null;
  resolved_at: Date | null;
  due_at: Date;
  extension_count: number;
  reopen_count: number;
}

const issueByTitle = async (title: string): Promise<IssueRow | undefined> =>
  (
    await sql<IssueRow>(
      `select id, status, version::text as version, assignee_id, verifier_id, closed_by, closed_at, resolved_at, due_at, extension_count, reopen_count from machvon.issue where title = $1`,
      [title],
    )
  )[0];

const eventsOf = async (issueId: string): Promise<string[]> =>
  (await sql<{ event_kind: string }>('select event_kind from machvon.issue_event where issue_id = $1 order by created_at, id', [issueId])).map((row) => row.event_kind);

/** A version of a document scanned clean that an issue can name as evidence. */
async function seedEvidence(): Promise<string> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CV', 'Biên bản bàn giao', 'INTERNAL', $3, $3)`,
    [stackInfo().tenants.A, documentId, membershipOf('owner')],
  );
  await sql(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
    [stackInfo().tenants.A, versionId, documentId, `tenants/e2e/${versionId}.pdf`],
  );
  return versionId;
}

/** Reports an issue as the coordinator, gives it to the handler, and has the handler start it; answers the row (IN_PROGRESS, version 3). */
async function working(page: Page, title: string): Promise<IssueRow> {
  await open(page, 'issueCoordinator', '/iss/iss-02');
  await field(page, vi['iss.create.project.label']).selectOption({ label: PROJECT_LABEL });
  await field(page, vi['iss.create.unit.label']).selectOption({ label: QLDA_LABEL });
  await field(page, vi['iss.create.category.label']).selectOption({ label: CATEGORY_LABEL });
  await field(page, vi['iss.create.severity.label']).selectOption({ label: vi['iss.severity.high.text'] });
  await field(page, vi['iss.create.title.label']).fill(title);
  await field(page, vi['iss.create.description.label']).fill('Vướng mắc dùng để kiểm thử đóng và gia hạn.');
  await page.getByRole('button', { name: vi['iss.create.submit.action'] }).click();
  await expect(page.getByTestId('created')).toBeVisible();
  const created = await issueByTitle(title);
  const issueId = created?.id ?? '';
  await open(page, 'issueCoordinator', `/iss/iss-03?id=${issueId}`);
  await field(page, vi['iss.workspace.assign.assignee.label']).selectOption(membershipOf('issueHandler'));
  await page.getByRole('button', { name: vi['iss.workspace.assign.action'] }).click();
  await expect(page.getByTestId('assigned')).toBeVisible();
  await open(page, 'issueHandler', `/iss/iss-03?id=${issueId}`);
  await page.getByRole('button', { name: vi['iss.workspace.start.action'] }).click();
  await expect(page.getByTestId('status')).toHaveText(vi['iss.status.inProgress.text']);
  const started = await issueByTitle(title);
  expect(started).toMatchObject({ status: 'IN_PROGRESS', version: '3', assignee_id: membershipOf('issueHandler') });
  return started as IssueRow;
}

/** The value of a `datetime-local` field for an instant, read as Vietnam time. */
const localInput = (instant: Date): string => new Date(instant.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 16);

test.describe.configure({ mode: 'serial' });

test.describe('ISS-04 and ISS-07 closing and extension', () => {
  let evidence = '';

  test.beforeAll(async () => {
    const tenant = stackInfo().tenants.A;
    const actor = membershipOf('owner');
    const record = randomUUID();
    const version = randomUUID();
    await sql("insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $3, 'EFFECTIVE', $4, $4)", [tenant, record, CATEGORY_KEY, actor]);
    await sql(
      `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
       values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, 'Vướng mắc đóng và gia hạn', '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $5, $5)`,
      [tenant, version, record, CATEGORY_KEY, actor],
    );
    await sql('update machvon.master_record set current_version_id = $2 where id = $1', [record, version]);
    await sql(
      `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
       values ($1, $2, $3, 1, $4, $5, 'HIGH', 'WORKDAY_VN', 4, 16, date_trunc('year', now())::date, 'ACTIVE', $6, $6)`,
      [tenant, randomUUID(), POLICY_CODE, version, record, actor],
    );
    evidence = await seedEvidence();
  });

  test('the handler reports the work done with evidence, cannot close it, a different person closes it and then reopens it (AC-ST-ISS-003-1)', async ({ page }) => {
    const title = unique();
    const issue = await working(page, title);
    const issueId = issue.id;

    // The handler asks for the verification: the result and the evidence the policy requires.
    await open(page, 'issueHandler', `/iss/iss-07?id=${issueId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['iss.verification.page.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['iss.verification.request.action'] }).click();
    await expect(page.locator('[data-field="request-evidence"]').getByText(vi['iss.verification.evidenceRequired.error'])).toBeVisible();
    expect((await issueByTitle(title))?.status).toBe('IN_PROGRESS');
    await field(page, vi['iss.verification.request.note.label']).fill('Đã chi trả và bàn giao mặt bằng.');
    await field(page, vi['iss.verification.request.evidence.label']).fill(evidence);
    await page.getByRole('button', { name: vi['iss.verification.request.action'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['iss.verification.request.done']);
    expect(await issueByTitle(title)).toMatchObject({ status: 'PENDING_VERIFICATION', version: '4', verifier_id: null, closed_by: null });
    expect((await issueByTitle(title))?.resolved_at).not.toBeNull();

    // The handler holds the permission to close and is not offered it; the database refuses what the screen does not offer.
    await open(page, 'issueHandler', `/iss/iss-07?id=${issueId}`);
    await expect(page.getByTestId('independence')).toHaveText(vi['iss.verification.independence.notice']);
    await expect(page.getByRole('button', { name: vi['iss.verification.close.action'] })).toHaveCount(0);
    await expect(page.getByTestId('result-evidence')).toContainText(evidence);
    await expect(
      sql("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = assignee_id, verifier_id = assignee_id where id = $1", [issueId]),
    ).rejects.toThrow(/issue_verifier_chk/);
    expect((await issueByTitle(title))?.status).toBe('PENDING_VERIFICATION');

    // A different person reads the result and the evidence and closes the issue.
    await open(page, 'issueVerifier', `/iss/iss-07?id=${issueId}`);
    await expect(page.getByTestId('result-note')).toHaveText('Đã chi trả và bàn giao mặt bằng.');
    await expect(page.getByTestId('result-evidence')).toContainText(evidence);
    await page.getByRole('button', { name: vi['iss.verification.close.action'] }).click();
    await expect(page.locator('[data-field="close-note"]').getByText(vi['iss.field.required.error'])).toBeVisible();
    await field(page, vi['iss.verification.close.note.label']).fill('Đã kiểm tra tại hiện trường.');
    await page.getByRole('button', { name: vi['iss.verification.close.action'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['iss.verification.close.done']);
    const closed = await issueByTitle(title);
    expect(closed).toMatchObject({ status: 'CLOSED', version: '5', closed_by: membershipOf('issueVerifier'), verifier_id: membershipOf('issueVerifier') });
    expect(closed?.closed_at).not.toBeNull();
    expect(await eventsOf(issueId)).toEqual(['CREATED', 'ASSIGNED', 'STARTED', 'VERIFICATION_REQUESTED', 'CLOSED']);

    // The closed issue is reopened with the reason, within the window.
    await open(page, 'issueVerifier', `/iss/iss-07?id=${issueId}`);
    await expect(page.getByTestId('reopen-window')).toBeVisible();
    await field(page, vi['iss.verification.reopen.reason.label']).fill('Hàng rào lại bị đổ.');
    await page.getByRole('button', { name: vi['iss.verification.reopen.action'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['iss.verification.reopen.done']);
    expect(await issueByTitle(title)).toMatchObject({ status: 'REOPENED', version: '6', reopen_count: 1, closed_by: null, verifier_id: null });
    expect(await eventsOf(issueId)).toEqual(['CREATED', 'ASSIGNED', 'STARTED', 'VERIFICATION_REQUESTED', 'CLOSED', 'REOPENED']);
  });

  test('the verifier gives a result back with the reason and the handler is told in the timeline (AC-ST-ISS-003-1)', async ({ page }) => {
    const title = unique();
    const issue = await working(page, title);
    await open(page, 'issueHandler', `/iss/iss-07?id=${issue.id}`);
    await field(page, vi['iss.verification.request.note.label']).fill('Đã xử lý xong.');
    await field(page, vi['iss.verification.request.evidence.label']).fill(evidence);
    await page.getByRole('button', { name: vi['iss.verification.request.action'] }).click();
    await expect(page.getByTestId('done')).toBeVisible();

    await open(page, 'issueVerifier', `/iss/iss-07?id=${issue.id}`);
    await page.getByRole('button', { name: vi['iss.verification.refuse.action'] }).click();
    await expect(page.locator('[data-field="refuse-note"]').getByText(vi['iss.field.required.error'])).toBeVisible();
    await field(page, vi['iss.verification.refuse.note.label']).fill('Ảnh không thấy hàng rào.');
    await page.getByRole('button', { name: vi['iss.verification.refuse.action'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['iss.verification.refuse.done']);
    expect(await issueByTitle(title)).toMatchObject({ status: 'ASSIGNED', assignee_id: membershipOf('issueHandler'), resolved_at: null });
    expect(await eventsOf(issue.id)).toEqual(['CREATED', 'ASSIGNED', 'STARTED', 'VERIFICATION_REQUESTED', 'REASSIGNED']);
  });

  test('an independent person extends the deadline twice and then no more; the handler cannot approve their own (AC-ST-ISS-003-2)', async ({ page }) => {
    const title = unique();
    const issue = await working(page, title);
    const issueId = issue.id;

    await open(page, 'issueHandler', `/iss/iss-04?id=${issueId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['iss.extension.page.title'] })).toBeVisible();
    await expect(page.getByTestId('extension-unavailable')).toHaveText(vi['iss.extension.extend.handler.notice']);
    await expect(page.getByRole('button', { name: vi['iss.extension.extend.action'] })).toHaveCount(0);

    await open(page, 'issueExtender', `/iss/iss-04?id=${issueId}`);
    await expect(page.getByTestId('extension-count')).toHaveText(vi['iss.extension.extend.count.text'].replace('{used}', '0').replace('{limit}', '2'));
    // A date that is not later is refused before anything is sent.
    await field(page, vi['iss.extension.extend.dueAt.label']).fill(localInput(new Date(issue.due_at.getTime() - HOUR_MS)));
    await field(page, vi['iss.extension.extend.reason.label']).fill('Hộ dân xin thêm thời gian.');
    await page.getByRole('button', { name: vi['iss.extension.extend.action'] }).click();
    await expect(page.locator('[data-field="extend-due"]').getByText(vi['iss.extension.dueAtNotLater.error'])).toBeVisible();
    expect((await issueByTitle(title))?.extension_count).toBe(0);

    let due = issue.due_at;
    for (const used of [0, 1]) {
      due = new Date(due.getTime() + HOUR_MS);
      await field(page, vi['iss.extension.extend.dueAt.label']).fill(localInput(due));
      await field(page, vi['iss.extension.extend.reason.label']).fill(`Gia hạn lần ${used + 1}.`);
      await page.getByRole('button', { name: vi['iss.extension.extend.action'] }).click();
      await expect(page.getByTestId('done')).toHaveText(vi['iss.extension.extend.done']);
      const extended = await issueByTitle(title);
      expect(extended?.extension_count).toBe(used + 1);
      expect(extended?.due_at.toISOString()).toBe(due.toISOString().slice(0, 16) + ':00.000Z');
      await open(page, 'issueExtender', `/iss/iss-04?id=${issueId}`);
    }
    await expect(page.getByTestId('extension-exhausted')).toHaveText(vi['iss.extension.extend.exhausted.notice']);
    await expect(page.getByRole('button', { name: vi['iss.extension.extend.action'] })).toBeDisabled();
    await expect(page.getByTestId('extensions').locator('li')).toHaveCount(2);
    expect(await eventsOf(issueId)).toEqual(['CREATED', 'ASSIGNED', 'STARTED', 'EXTENDED', 'EXTENDED']);
    // The deadline cannot be stretched by anything but a counted extension.
    await expect(sql("update machvon.issue set due_at = due_at + interval '1 day' where id = $1", [issueId])).rejects.toThrow(/counted extension/);
  });

  test('someone who only reads sees the screens and is offered no command', async ({ page }) => {
    const [issue] = await sql<{ id: string }>("select id from machvon.issue where title like 'Đóng vướng mắc%' order by created_at desc limit 1");
    await open(page, 'issueReader', `/iss/iss-07?id=${issue?.id ?? ''}`);
    await expect(page.getByTestId('action-summary')).toBeVisible();
    await expect(page.getByTestId('read-only')).toHaveText(vi['iss.verification.nothing.notice']);
    await open(page, 'issueReader', `/iss/iss-04?id=${issue?.id ?? ''}`);
    await expect(page.getByTestId('extension-unavailable')).toHaveText(vi['iss.workspace.actions.denied.notice']);
    await expect(page.getByRole('button', { name: vi['iss.extension.extend.action'] })).toHaveCount(0);
  });
});
