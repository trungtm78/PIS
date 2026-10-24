import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * DIS-22 (reasoned reopening of a locked period) in a real browser against the real API and database (apps/api/test/e2e-stack): a requester
 * asks for the projects of a locked period to be reopened with a reason and a window, a different person approves it for the hours they choose,
 * and only the projects named carry "reopened until hh:mm". The person who asked never decides (the screen disables the decision with the rule
 * as its tooltip and the server refuses the call), a window that has ended is Expired, and someone who only reads has no form and no button.
 * The period is never changed. What the screens changed is looked up in the database.
 */

const PERIOD_ID = randomUUID();
const PERIOD_CODE = 'E2E-REOPEN-W1';
const PROJECT_ONE = randomUUID();
const PROJECT_TWO = randomUUID();
const CODE_ONE = 'E2E-RP-001';
const CODE_TWO = 'E2E-RP-002';
const REASON = 'Kho bạc trả lại chứng từ do sai mã nguồn vốn';

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/dis/dis-22?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface ReopenRow {
  id: string;
  status: string;
  scope_kind: string;
  scope_project_ids: string[] | null;
  reason: string;
  requested_by: string;
  approved_by: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  requested_window_hours: number;
  window_hours: number | null;
  version: string;
}

const reopensOf = (): Promise<ReopenRow[]> =>
  sql<ReopenRow>(
    `select id, status, scope_kind, scope_project_ids, reason, requested_by, approved_by, decided_by, decision_reason, requested_window_hours,
            extract(epoch from (window_until - decided_at))::int / 3600 as window_hours, version::text as version
       from machvon.period_reopen where period_id = $1 order by created_at, id`,
    [PERIOD_ID],
  );

const periodState = async (): Promise<{ status: string; version: string }> => (await sql<{ status: string; version: string }>('select status, version::text as version from machvon.reporting_period where id = $1', [PERIOD_ID]))[0] ?? { status: '', version: '' };
const countOf = async (action: string, id: string): Promise<number> => (await sql<{ n: number }>('select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = $2', [id, action]))[0]?.n ?? 0;
const eventsOf = async (id: string): Promise<string[]> => (await sql<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at', [id])).map((row) => row.type);

const requestForm = (page: Page): Locator => page.getByTestId('reopen-form');
const rowOf = (page: Page, id: string): Locator => page.locator(`tr[data-reopen-id="${id}"]`);
const chip = vi['dis.reopen.window.active.chip'].split('{when}')[0]?.trim() ?? '';

async function fillRequest(form: Locator, project: string, reason: string, hours: string): Promise<void> {
  await form.getByLabel(vi['dis.reopen.form.period.label'], { exact: true }).selectOption(PERIOD_ID);
  await form.getByLabel(project, { exact: false }).check();
  await form.getByLabel(vi['dis.reopen.form.reason.label'], { exact: true }).fill(reason);
  await form.getByLabel(vi['dis.reopen.form.hours.label'], { exact: true }).fill(hours);
}

async function decideInBrowser(page: Page, id: string, decision: 'approve' | 'reject', reason: string, hours?: string): Promise<void> {
  await rowOf(page, id).locator(`[data-decision="${decision}"]`).click();
  const title = (decision === 'approve' ? vi['dis.reopen.decision.approve.title'] : vi['dis.reopen.decision.reject.title']).replace('{code}', PERIOD_CODE);
  const form = page.getByRole('form', { name: title });
  await form.getByLabel(vi['dis.reopen.decision.reason.label'], { exact: true }).fill(reason);
  if (hours !== undefined) await form.getByLabel(vi['dis.reopen.decision.hours.label'], { exact: true }).fill(hours);
  await form.getByRole('button', { name: decision === 'approve' ? vi['dis.reopen.decision.approve.confirm'] : vi['dis.reopen.decision.reject.confirm'] }).click();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const tenantId = stackInfo().tenants.A;
  const owner = membershipOf('owner');
  const ownerUnit = stackInfo().units.A['CB-SKHDT-QLDA'];
  const [calendar] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'CALENDAR' limit 1", [tenantId]);
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenantId]);
  // A locked week of a calendar of its own, in a year no other flow uses.
  await sql(
    `insert into machvon.reporting_period
       (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
     values ($1, $2, $3, 1, date '2022-01-01', date '2022-01-07', timestamptz '2022-01-07T03:00:00Z', 'E2E-REOPEN', 'WEEK', 2022, 'LOCKED',
             timestamptz '2022-01-07T03:05:00Z', timestamptz '2022-01-07T03:10:00Z', $4, $5, $4, $4)`,
    [tenantId, PERIOD_ID, PERIOD_CODE, owner, calendar?.id],
  );
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
     values ($1, $2, $3, 'Dự án đường vào thôn', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $4, $7, 'Dự án trường học xã', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
    [tenantId, PROJECT_ONE, CODE_ONE, PROJECT_TWO, ownerUnit, area?.id, CODE_TWO],
  );
});

test.afterAll(async () => {
  // The rows of this flow leave nothing behind for the other flows (the calendar of DIS-14, the register of PRJ-01).
  await sql('delete from machvon.period_reopen where period_id = $1', [PERIOD_ID]);
  await sql('delete from machvon.reporting_period where id = $1', [PERIOD_ID]);
  await sql('delete from machvon.project where id = any($1::uuid[])', [[PROJECT_ONE, PROJECT_TWO]]);
});

test.describe('DIS-22 reasoned reopening of a locked period', () => {
  test('a requester asks for one project with a reason and a window, a different person approves 48 hours, and only that project is marked as reopened (AC-ST-DIS-002-1, UAT-AC246)', async ({ page }) => {
    await open(page, 'reopenRequester');
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.reopen.page.title'] })).toBeVisible();
    await expect(page.getByTestId('empty-requests')).toBeVisible();
    const form = requestForm(page);

    // An empty form sends nothing: every required field says so.
    await form.getByRole('button', { name: vi['dis.reopen.form.submit.action'] }).click();
    await expect(form.getByText(vi['dis.reopen.field.required.error'])).toHaveCount(3);
    // A reason of three characters is stopped before it is sent, and the database has nothing.
    await form.getByLabel(vi['dis.reopen.form.period.label'], { exact: true }).selectOption(PERIOD_ID);
    await form.getByLabel(CODE_ONE, { exact: false }).check();
    await form.getByLabel(vi['dis.reopen.form.reason.label'], { exact: true }).fill('sai');
    await form.getByRole('button', { name: vi['dis.reopen.form.submit.action'] }).click();
    await expect(form.getByText(vi['dis.reopen.field.reasonShort.error'])).toBeVisible();
    expect(await reopensOf()).toEqual([]);

    await fillRequest(form, CODE_ONE, `  ${REASON}  `, '72');
    await form.getByRole('button', { name: vi['dis.reopen.form.submit.action'] }).click();
    await expect(page.getByTestId('reopen-done')).toHaveText(vi['dis.reopen.form.done.notice']);
    const [asked] = await reopensOf();
    expect(asked).toMatchObject({ status: 'REQUESTED', scope_kind: 'PROJECTS', scope_project_ids: [PROJECT_ONE], reason: REASON, requested_by: membershipOf('reopenRequester'), requested_window_hours: 72, approved_by: null, version: '1' });
    const id = asked?.id ?? '';
    expect(await countOf('dis.period_reopen_requested', id)).toBe(1);
    // The requester sees the request as theirs, with no decision to make.
    await expect(rowOf(page, id)).toContainText(vi['dis.reopen.queue.requester.mine']);
    await expect(rowOf(page, id)).toContainText(CODE_ONE);
    await expect(rowOf(page, id).locator('[data-decision]')).toHaveCount(0);

    // A different person approves 48 hours (the request asked for 72): the window opens for P-A-001 alone.
    await open(page, 'reopenApprover');
    await expect(page.getByTestId('reopen-form')).toHaveCount(0);
    await expect(rowOf(page, id)).toContainText(REASON);
    await expect(rowOf(page, id).locator('[data-decision="approve"]')).toBeEnabled();
    await decideInBrowser(page, id, 'approve', 'Chứng từ đã được đối chiếu', '48');
    await expect(rowOf(page, id)).toHaveAttribute('data-status', 'APPROVED');
    await expect(rowOf(page, id).getByTestId('window-chip')).toHaveCount(1);
    await expect(rowOf(page, id).getByTestId('window-chip')).toContainText(chip);
    await expect(rowOf(page, id).locator(`li[data-project-id="${PROJECT_ONE}"]`).getByTestId('window-chip')).toBeVisible();
    await expect(rowOf(page, id).locator(`li[data-project-id="${PROJECT_TWO}"]`)).toHaveCount(0);

    const [approved] = await reopensOf();
    expect(approved).toMatchObject({ id, status: 'APPROVED', approved_by: membershipOf('reopenApprover'), decided_by: membershipOf('reopenApprover'), decision_reason: 'Chứng từ đã được đối chiếu', window_hours: 48, version: '2' });
    // The period itself is untouched: it is still locked, at the version it had.
    expect(await periodState()).toEqual({ status: 'LOCKED', version: '1' });
    // The trace keeps who asked, who approved and the window; the approval is announced once.
    const [audit] = await sql<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'dis.period_reopen_approved'", [id]);
    expect(audit?.safe_diff).toMatchObject({ requested_by: membershipOf('reopenRequester'), approved_by: membershipOf('reopenApprover'), window_hours: 48, requested_window_hours: 72, project_ids: [PROJECT_ONE], period_code: PERIOD_CODE });
    await expect.poll(() => eventsOf(id)).toEqual(['period.reopened.v1']);
  });

  test('the person who asked never decides: the screen disables the decision with the separation rule, the server refuses the call, and another person rejects it with a reason (AC-ST-DIS-002-2)', async ({ page }) => {
    const authorization: string[] = [];
    page.on('request', (request) => {
      const header = request.headers().authorization;
      if (header !== undefined && request.url().includes('/api/')) authorization.push(header);
    });
    // The owner holds every permission, asking and approving among them.
    await open(page, 'owner');
    const form = requestForm(page);
    await fillRequest(form, CODE_TWO, REASON, '24');
    await form.getByRole('button', { name: vi['dis.reopen.form.submit.action'] }).click();
    await expect(page.getByTestId('reopen-done')).toBeVisible();
    const own = (await reopensOf()).find((row) => row.requested_by === membershipOf('owner'));
    expect(own).toMatchObject({ status: 'REQUESTED', scope_project_ids: [PROJECT_TWO] });
    const id = own?.id ?? '';
    for (const decision of ['approve', 'reject']) {
      const button = rowOf(page, id).locator(`[data-decision="${decision}"]`);
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('title', vi['dis.reopen.decision.own.tooltip']);
    }
    await expect(rowOf(page, id).getByTestId('own-request')).toHaveText(vi['dis.reopen.decision.own.tooltip']);

    // The server refuses the same decision sent by hand with the owner's own session, and nothing changes.
    const token = authorization[authorization.length - 1] ?? '';
    expect(token).toMatch(/^Bearer /);
    const refused = await page.request.post(`/api/period-reopens/${id}/decision`, {
      headers: { authorization: token, 'idempotency-key': randomUUID(), 'if-match': '"1"', 'content-type': 'application/json' },
      data: { decision: 'approve', reason: 'Tự duyệt đề nghị do chính mình lập', window_hours: 24 },
    });
    expect(refused.status()).toBe(403);
    expect(await refused.text()).toContain('SELF_APPROVAL_DENIED');
    expect((await reopensOf()).find((row) => row.id === id)).toMatchObject({ status: 'REQUESTED', approved_by: null, version: '1' });

    // Another person rejects it for a stated reason: nothing opens and nothing is announced.
    await open(page, 'reopenApprover');
    await decideInBrowser(page, id, 'reject', 'Chứng từ chưa đủ căn cứ');
    await expect(rowOf(page, id)).toHaveAttribute('data-status', 'REJECTED');
    await expect(rowOf(page, id).getByTestId('window-chip')).toHaveCount(0);
    expect((await reopensOf()).find((row) => row.id === id)).toMatchObject({ status: 'REJECTED', approved_by: null, decided_by: membershipOf('reopenApprover'), decision_reason: 'Chứng từ chưa đủ căn cứ', version: '2' });
    expect(await countOf('dis.period_reopen_rejected', id)).toBe(1);
    expect(await eventsOf(id)).toEqual([]);
    expect(await periodState()).toEqual({ status: 'LOCKED', version: '1' });
  });

  test('a window that has ended is Expired and marks no project, whether or not the job has stored it', async ({ page }) => {
    // An approval whose window ended three days ago: the request is born REQUESTED, then decided in the past (the table allows no other way in).
    const id = randomUUID();
    const tenantId = stackInfo().tenants.A;
    await sql(
      `insert into machvon.period_reopen (tenant_id, id, period_id, scope_kind, scope_project_ids, reason, requested_by, requested_window_hours, status, created_at, created_by, updated_by)
       values ($1, $2, $3, 'PROJECTS', $4::uuid[], $5, $6, 24, 'REQUESTED', now() - interval '4 days', $6, $6)`,
      [tenantId, id, PERIOD_ID, [PROJECT_ONE], REASON, membershipOf('reopenRequester')],
    );
    await sql(
      `update machvon.period_reopen set status = 'APPROVED', approved_by = $2, decided_by = $2, decided_at = now() - interval '3 days', decision_reason = 'Granted for a day',
         window_until = now() - interval '3 days' + interval '24 hours', version = 2 where id = $1`,
      [id, membershipOf('reopenApprover')],
    );
    try {
      await open(page, 'reopenApprover');
      await expect(rowOf(page, id)).toHaveAttribute('data-status', 'EXPIRED');
      await expect(rowOf(page, id).locator('.pill[data-status]')).toHaveText(vi['dis.calendar.reopenStatus.expired.text']);
      await expect(rowOf(page, id).getByTestId('window-chip')).toHaveCount(0);
      await expect(rowOf(page, id).locator('[data-decision]')).toHaveCount(0);
      // The calendar of DIS-14 tells the same.
      await page.goto('/dis/dis-14?devUser=reopenApprover');
      await page.locator('#calendar-year').selectOption('2022');
      await expect(page.locator(`tr[data-period-id="${PERIOD_ID}"]`).locator(`li[data-reopen-status="EXPIRED"]`)).toHaveCount(1);
    } finally {
      await sql('delete from machvon.period_reopen where id = $1', [id]);
    }
  });

  test('someone who only reads has no form and no decision, and someone without the read permission is refused the screen', async ({ page }) => {
    const before = (await reopensOf()).length;
    await open(page, 'periodReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.reopen.page.title'] })).toBeVisible();
    await expect(page.getByTestId('read-only')).toHaveText(vi['dis.reopen.readOnly.denied.notice']);
    await expect(page.getByTestId('reopen-form')).toHaveCount(0);
    await expect(page.locator('[data-decision]')).toHaveCount(0);
    // A reader sees the scope, the window and the status of a request, not the reason or the people.
    const row = page.locator('tr[data-reopen-id]').first();
    await expect(row).toBeVisible();
    await expect(page.getByText(REASON)).toHaveCount(0);

    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByTestId('reopen-queue')).toHaveCount(0);
    expect((await reopensOf()).length).toBe(before);
  });

  test('the approver cannot ask, and the requester cannot decide: each sees only the half of the screen their permission opens', async ({ page }) => {
    await open(page, 'reopenApprover');
    await expect(page.getByTestId('reopen-form')).toHaveCount(0);
    await open(page, 'reopenRequester');
    await expect(page.getByTestId('reopen-form')).toBeVisible();
    await expect(page.locator('[data-decision]')).toHaveCount(0);
  });
});
