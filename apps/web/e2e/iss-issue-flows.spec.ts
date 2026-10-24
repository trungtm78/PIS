import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * ISS-01 (board), ISS-02 (report) and ISS-03 (workspace) in a real browser against the real API and database (apps/api/test/e2e-stack): the
 * coordinator reports an issue under the SLA policy in force (a position is stored only with consent), gives it to a worker, a person who cannot
 * work it is refused as the assignee, the worker starts it and comments, and the coordinator moves it to another unit without moving its deadline
 * or the day it became overdue; someone who only reads can read and nothing else. What the screens changed is looked up in the database.
 *
 * The spec makes its own issue category and policy (the stack seeds two categories that the SLA policy spec counts), so it runs after iss-flows.
 */

const CATEGORY_KEY = 'E2E_ISS2_CATEGORY';
const CATEGORY_LABEL = `${CATEGORY_KEY} · Vướng mắc kiểm thử e2e`;
const POLICY_CODE = 'E2E-ISS2-SLA-CRITICAL';
const PROJECT_LABEL = 'DA-01 · Dự án thử';
const QLDA_LABEL = 'CB-SKHDT-QLDA · Ban Quản lý dự án';
const STC_LABEL = 'CB-STC · Sở Tài chính';
const unique = (): string => `Chậm bàn giao ${Date.now().toString(36).toUpperCase()}`;

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

interface IssueRow {
  id: string;
  code: string;
  status: string;
  version: string;
  severity: string;
  owner_unit_id: string;
  assignee_id: string | null;
  reported_by: string;
  responded_at: Date | null;
  due_at: Date;
  response_due_at: Date;
  overdue_since: Date | null;
  geo_consent: boolean;
  geo_lat: string | null;
  geo_lng: string | null;
  geo_accuracy_m: string | null;
  client_operation_id: string | null;
  sla_policy_code: string;
}

const issueByTitle = async (title: string): Promise<IssueRow | undefined> =>
  (
    await sql<IssueRow>(
      `select i.id, i.code, i.status, i.version::text as version, i.severity, i.owner_unit_id, i.assignee_id, i.reported_by, i.responded_at, i.due_at, i.response_due_at, i.overdue_since,
              i.geo_consent, i.geo_lat::text as geo_lat, i.geo_lng::text as geo_lng, i.geo_accuracy_m::text as geo_accuracy_m, i.client_operation_id::text as client_operation_id,
              p.code as sla_policy_code
         from machvon.issue i join machvon.issue_sla_policy p on p.id = i.sla_policy_id where i.title = $1`,
      [title],
    )
  )[0];

const eventsOf = async (issueId: string): Promise<string[]> =>
  (await sql<{ event_kind: string }>('select event_kind from machvon.issue_event where issue_id = $1 order by created_at, id', [issueId])).map((row) => row.event_kind);

const unitId = (code: string): Promise<string> => sql<{ id: string }>('select id from machvon.organization_unit where code = $1', [code]).then((rows) => rows[0]?.id ?? '');

const report = (page: Page) => page.getByRole('button', { name: vi['iss.create.submit.action'] }).click();

test.describe.configure({ mode: 'serial' });

test.describe('ISS-01 to ISS-03 issues', () => {
  test.beforeAll(async () => {
    // A category in force and the policy of its CRITICAL issues, valid since the start of the year, on the calendar the stack publishes.
    const tenant = stackInfo().tenants.A;
    const actor = membershipOf('owner');
    const record = randomUUID();
    const version = randomUUID();
    await sql("insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $3, 'EFFECTIVE', $4, $4)", [tenant, record, CATEGORY_KEY, actor]);
    await sql(
      `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
       values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, 'Vướng mắc kiểm thử e2e', '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $5, $5)`,
      [tenant, version, record, CATEGORY_KEY, actor],
    );
    await sql('update machvon.master_record set current_version_id = $2 where id = $1', [record, version]);
    await sql(
      `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
       values ($1, $2, $3, 1, $4, $5, 'CRITICAL', 'WORKDAY_VN', 4, 16, date_trunc('year', now())::date, 'ACTIVE', $6, $6)`,
      [tenant, randomUUID(), POLICY_CODE, version, record, actor],
    );
  });

  test('the coordinator reports an issue under the policy in force, with a position only when consent is given, and finds it in the board (AC-ST-ISS-002-2)', async ({ page }) => {
    const title = unique();
    await open(page, 'issueCoordinator', '/iss/iss-01');
    await expect(page.getByRole('heading', { level: 1, name: vi['iss.list.page.title'] })).toBeVisible();
    await page.getByRole('link', { name: vi['iss.list.create.action'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['iss.create.page.title'] })).toBeVisible();

    // An empty form sends nothing: every field says it is required and the database has nothing.
    await expect(field(page, vi['iss.create.category.label']).locator('option', { hasText: CATEGORY_LABEL })).toHaveCount(1);
    await report(page);
    await expect(page.locator('[data-field="issue-project"]').getByText(vi['iss.field.required.error'])).toBeVisible();
    await expect(page.locator('[data-field="issue-title"]').getByText(vi['iss.field.required.error'])).toBeVisible();
    expect(await issueByTitle(title)).toBeUndefined();

    await field(page, vi['iss.create.project.label']).selectOption({ label: PROJECT_LABEL });
    await field(page, vi['iss.create.unit.label']).selectOption({ label: QLDA_LABEL });
    await field(page, vi['iss.create.category.label']).selectOption({ label: CATEGORY_LABEL });
    await field(page, vi['iss.create.severity.label']).selectOption({ label: vi['iss.severity.critical.text'] });
    await field(page, vi['iss.create.title.label']).fill(title);
    await field(page, vi['iss.create.description.label']).fill('Hộ dân chưa nhận tiền bồi thường nên chưa bàn giao mặt bằng.');
    // The position is typed once the consent is given.
    await page.getByLabel(vi['iss.create.geo.consent.label']).check();
    await field(page, vi['iss.create.geo.lat.label']).fill('10.800000');
    await field(page, vi['iss.create.geo.lng.label']).fill('106.700000');
    await field(page, vi['iss.create.geo.accuracy.label']).fill('60');
    await report(page);
    await expect(page.getByTestId('created')).toBeVisible();

    const issue = await issueByTitle(title);
    expect(issue).toMatchObject({ status: 'OPEN', version: '1', severity: 'CRITICAL', owner_unit_id: await unitId('CB-SKHDT-QLDA'), assignee_id: null, reported_by: membershipOf('issueCoordinator'), sla_policy_code: POLICY_CODE });
    expect(issue?.code).toMatch(/^VM-\d{4}-\d{6}$/);
    expect(issue?.client_operation_id).not.toBeNull();
    expect((issue?.due_at.getTime() ?? 0) > (issue?.response_due_at.getTime() ?? 0)).toBe(true);
    expect(issue).toMatchObject({ geo_consent: true, geo_lat: '10.800000', geo_lng: '106.700000', geo_accuracy_m: '60.00' });
    expect(await eventsOf(issue?.id ?? '')).toEqual(['CREATED']);

    // The workspace shows the SLA it was opened under, the position with the warning of its accuracy, and the first event.
    await page.getByRole('link', { name: vi['iss.create.done.open'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(title) })).toBeVisible();
    await expect(page.getByTestId('sla')).toContainText(vi['iss.workspace.field.responseDue']);
    await expect(page.getByText(vi['iss.workspace.sla.policy.text'].replace('{code}', POLICY_CODE).replace('{revision}', '1'))).toBeVisible();
    await expect(page.getByTestId('geo-low-accuracy')).toBeVisible();
    await expect(page.getByTestId('timeline').locator('li')).toHaveCount(1);

    // The same issue without consent stores no position, and the board shows both under their status.
    const second = `${title} (không vị trí)`;
    await open(page, 'issueCoordinator', '/iss/iss-02');
    await field(page, vi['iss.create.project.label']).selectOption({ label: PROJECT_LABEL });
    await field(page, vi['iss.create.unit.label']).selectOption({ label: QLDA_LABEL });
    await field(page, vi['iss.create.category.label']).selectOption({ label: CATEGORY_LABEL });
    await field(page, vi['iss.create.severity.label']).selectOption({ label: vi['iss.severity.critical.text'] });
    await field(page, vi['iss.create.title.label']).fill(second);
    await field(page, vi['iss.create.description.label']).fill('Không lưu vị trí.');
    await report(page);
    await expect(page.getByTestId('created')).toBeVisible();
    expect(await issueByTitle(second)).toMatchObject({ geo_consent: false, geo_lat: null, geo_lng: null, geo_accuracy_m: null });
    await open(page, 'issueCoordinator', '/iss/iss-01');
    await expect(page.locator(`section[data-status="OPEN"] article`, { hasText: title })).toHaveCount(2);
  });

  test('the coordinator, who cannot read the member directory, is offered only the people who can work the issue and gives it to a worker; the worker starts it and comments; the coordinator moves it to another unit and the deadline and the days overdue stay (AC-ST-ISS-002-1)', async ({ page }) => {
    const title = unique();
    await open(page, 'issueCoordinator', '/iss/iss-02');
    await field(page, vi['iss.create.project.label']).selectOption({ label: PROJECT_LABEL });
    await field(page, vi['iss.create.unit.label']).selectOption({ label: QLDA_LABEL });
    await field(page, vi['iss.create.category.label']).selectOption({ label: CATEGORY_LABEL });
    await field(page, vi['iss.create.severity.label']).selectOption({ label: vi['iss.severity.critical.text'] });
    await field(page, vi['iss.create.title.label']).fill(title);
    await field(page, vi['iss.create.description.label']).fill('Chuyển đơn vị khi đã quá hạn.');
    await report(page);
    await expect(page.getByTestId('created')).toBeVisible();
    const created = await issueByTitle(title);
    const issueId = created?.id ?? '';
    const workspace = (user: string) => open(page, user, `/iss/iss-03?id=${issueId}`);

    // The coordinator holds no membership.read: the people come from the read scoped by the issue (CR-ISS-14). A reader cannot work an issue, so is not offered.
    await workspace('issueCoordinator');
    const assignee = field(page, vi['iss.workspace.assign.assignee.label']);
    await expect(assignee.locator(`option[value="${membershipOf('issueWorker')}"]`)).toHaveCount(1);
    await expect(assignee.locator(`option[value="${membershipOf('issueReader')}"]`)).toHaveCount(0);
    await expect(page.getByTestId('members-unavailable')).toHaveCount(0);
    expect((await issueByTitle(title))?.status).toBe('OPEN');

    // The worker can: the issue is assigned, and only the worker is offered the start.
    await assignee.selectOption(membershipOf('issueWorker'));
    await field(page, vi['iss.workspace.assign.note.label']).fill('Nhờ anh xử lý trong tuần');
    await page.getByRole('button', { name: vi['iss.workspace.assign.action'] }).click();
    await expect(page.getByTestId('assigned')).toBeVisible();
    expect(await issueByTitle(title)).toMatchObject({ status: 'ASSIGNED', version: '2', assignee_id: membershipOf('issueWorker') });
    await expect(page.getByTestId('status')).toHaveText(vi['iss.status.assigned.text']);
    await expect(page.getByRole('button', { name: vi['iss.workspace.start.action'] })).toHaveCount(0);

    await workspace('issueWorker');
    await expect(page.getByRole('button', { name: vi['iss.workspace.assign.action'] })).toHaveCount(0);
    await page.getByRole('button', { name: vi['iss.workspace.start.action'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['iss.status.inProgress.text']);
    const started = await issueByTitle(title);
    expect(started?.status).toBe('IN_PROGRESS');
    expect(started?.responded_at).not.toBeNull();
    await field(page, vi['iss.workspace.comment.note.label']).fill('Đã gặp hộ dân, hẹn ngày chi trả.');
    await page.getByRole('button', { name: vi['iss.workspace.comment.action'] }).click();
    await expect(page.getByTestId('commented')).toBeVisible();
    await expect(page.getByTestId('timeline').getByText('Đã gặp hộ dân, hẹn ngày chi trả.')).toBeVisible();
    expect(await eventsOf(issueId)).toEqual(['CREATED', 'ASSIGNED', 'STARTED', 'COMMENTED']);

    // The issue became overdue three days ago; the transfer to another unit keeps its deadlines and that day.
    await sql("update machvon.issue set overdue_since = now() - interval '3 days' where id = $1", [issueId]);
    const before = await issueByTitle(title);
    await workspace('issueCoordinator');
    await expect(page.getByTestId('due-state')).toContainText(vi['iss.due.overdue.badge']);
    await field(page, vi['iss.workspace.transfer.unit.label']).selectOption({ label: STC_LABEL });
    await field(page, vi['iss.workspace.transfer.reason.label']).fill('Công trình thuộc phạm vi Sở Tài chính.');
    await page.getByRole('button', { name: vi['iss.workspace.transfer.action'] }).click();
    await expect(page.getByTestId('transferred')).toBeVisible();
    const after = await issueByTitle(title);
    expect(after).toMatchObject({ status: 'IN_PROGRESS', owner_unit_id: await unitId('CB-STC'), assignee_id: membershipOf('issueWorker') });
    expect(after?.due_at).toEqual(before?.due_at);
    expect(after?.response_due_at).toEqual(before?.response_due_at);
    expect(after?.overdue_since).toEqual(before?.overdue_since);
    expect(await eventsOf(issueId)).toEqual(['CREATED', 'ASSIGNED', 'STARTED', 'COMMENTED', 'TRANSFERRED']);
    await expect(page.getByTestId('summary')).toContainText('Sở Tài chính');
    await expect(page.getByTestId('timeline').locator('li[data-kind="TRANSFERRED"]')).toContainText(STC_LABEL);
  });

  test('someone who only reads sees the board and the issue, and is offered no command; a worker cannot report an issue', async ({ page }) => {
    const [issue] = await sql<{ id: string; title: string }>("select id, title from machvon.issue where status = 'IN_PROGRESS' order by created_at desc limit 1");
    await open(page, 'issueReader', '/iss/iss-01');
    await expect(page.getByRole('heading', { level: 1, name: vi['iss.list.page.title'] })).toBeVisible();
    await expect(page.getByRole('link', { name: vi['iss.list.create.action'] })).toHaveCount(0);
    await expect(page.locator('article[data-issue-id]', { hasText: issue?.title ?? '' })).toBeVisible();

    await open(page, 'issueReader', `/iss/iss-03?id=${issue?.id ?? ''}`);
    await expect(page.getByTestId('summary')).toBeVisible();
    await expect(page.getByTestId('read-only')).toHaveText(vi['iss.workspace.actions.denied.notice']);
    for (const action of ['assign', 'comment', 'transfer', 'start'] as const) await expect(page.getByRole('button', { name: vi[`iss.workspace.${action}.action`] })).toHaveCount(0);

    await open(page, 'issueWorker', '/iss/iss-02');
    await expect(page.getByText(vi['iss.create.denied.notice'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['iss.create.submit.action'] })).toBeDisabled();
  });
});
