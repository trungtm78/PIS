import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * ISS-10 (escalation board) and the escalation form of ISS-04 in a real browser against the real API and database (apps/api/test/e2e-stack), with the job
 * issue-sla running there every two seconds: an issue that is far past its deadline is escalated to the unit (level 2) and to the task force (level 3), once
 * each, and is never closed; the member of the task force accepts the escalation to it and a person who is not in the task force is not offered it; the
 * coordinator raises another issue to the task force by hand; someone who only reads sees the board and nothing else. What the screens changed is looked
 * up in the database. The spec makes its own category, policy, task force and issues.
 */

const CATEGORY_KEY = 'E2E_ISS4_CATEGORY';
const POLICY_CODE = 'E2E-ISS4-SLA-HIGH';
const TASK_FORCE_CODE = 'E2E-TF-ISS4';

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface EscalationRow {
  id: string;
  level: number;
  status: string;
  trigger: string;
  task_force_id: string | null;
  target_unit_id: string | null;
  accepted_by: string | null;
}

const escalationsOf = (issueId: string) =>
  sql<EscalationRow>('select id, level, status, "trigger", task_force_id, target_unit_id, accepted_by from machvon.issue_escalation where issue_id = $1 order by level', [issueId]);
const issueRow = async (issueId: string) =>
  (await sql<{ status: string; escalation_level: number; overdue_since: Date | null; closed_at: Date | null; version: string }>('select status, escalation_level, overdue_since, closed_at, version::text as version from machvon.issue where id = $1', [issueId]))[0];

let category = '';
let policyId = '';
let taskForceId = '';

/** Inserts an issue that is being worked, opened `openedDaysAgo` days ago with its deadline `dueInDays` days from now (negative: past). */
async function seedIssue(title: string, openedDaysAgo: number, dueInDays: number): Promise<string> {
  const tenant = stackInfo().tenants.A;
  const issueId = randomUUID();
  const [project] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-01'");
  const [unit] = await sql<{ id: string }>("select id from machvon.organization_unit where code = 'CB-SKHDT-QLDA'");
  const code = `VM-2026-9${String(Math.floor(Math.random() * 90_000) + 10_000)}`;
  await sql(
    `insert into machvon.issue (tenant_id, id, code, project_id, category_version_id, severity, title, description, owner_unit_id, sla_policy_id, status, version, assignee_id, reported_by,
                                opened_at, response_due_at, responded_at, due_at, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'HIGH', $6, 'Vướng mắc dùng để kiểm thử leo thang', $7, $8, 'IN_PROGRESS', 3, $9, $10,
             now() - ($11 || ' days')::interval, now() - ($11 || ' days')::interval + interval '4 hours', now() - ($11 || ' days')::interval + interval '1 hour', now() + ($12 || ' days')::interval, $10, $10)`,
    [tenant, issueId, code, project?.id, category, title, unit?.id, policyId, membershipOf('issueHandler'), membershipOf('issueCoordinator'), String(openedDaysAgo), String(dueInDays)],
  );
  return issueId;
}

test.describe.configure({ mode: 'serial' });

test.describe('ISS-10 escalation board and the escalation form of ISS-04', () => {
  test.beforeAll(async () => {
    const tenant = stackInfo().tenants.A;
    const actor = membershipOf('owner');
    const record = randomUUID();
    category = randomUUID();
    policyId = randomUUID();
    taskForceId = randomUUID();
    await sql("insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $3, 'EFFECTIVE', $4, $4)", [tenant, record, CATEGORY_KEY, actor]);
    await sql(
      `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
       values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, 'Vướng mắc leo thang', '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $5, $5)`,
      [tenant, category, record, CATEGORY_KEY, actor],
    );
    await sql('update machvon.master_record set current_version_id = $2 where id = $1', [record, category]);
    await sql(
      `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
       values ($1, $2, $3, 1, $4, $5, 'HIGH', 'WORKDAY_VN', 4, 16, date_trunc('year', now())::date, 'ACTIVE', $6, $6)`,
      [tenant, policyId, POLICY_CODE, category, record, actor],
    );
    // The task force that answers for the units under the Department, with one member who is not its lead.
    const [department] = await sql<{ id: string }>("select id from machvon.organization_unit where code = 'CB-SKHDT'");
    await sql(
      `insert into machvon.task_force (tenant_id, id, code, name, purpose, lead_membership_id, scope_unit_id, valid_from, status, created_by, updated_by)
       values ($1, $2, $3, 'Tổ công tác kiểm thử leo thang', 'Giải quyết vướng mắc quá hạn', $4, $5, date '2026-01-01', 'ACTIVE', $6, $6)`,
      [tenant, taskForceId, TASK_FORCE_CODE, membershipOf('issueTaskForce'), department?.id, actor],
    );
  });

  test('the job escalates a late issue to the unit and to the task force once each and never closes it; only a member of the task force may accept the escalation to it (AC-ST-ISS-004-1, AC-ST-ISS-004-2)', async ({ page }) => {
    const title = `Quá hạn cần leo thang ${Date.now().toString(36).toUpperCase()}`;
    const issueId = await seedIssue(title, 40, -30);

    // The job runs every two seconds: both levels appear, and a second run changes nothing.
    await expect.poll(async () => (await escalationsOf(issueId)).map((row) => row.level), { timeout: 30_000 }).toEqual([2, 3]);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const levels = await escalationsOf(issueId);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toMatchObject({ level: 2, status: 'OPEN', trigger: 'SLA_AUTO', task_force_id: null });
    expect(levels[1]).toMatchObject({ level: 3, status: 'OPEN', trigger: 'SLA_AUTO', task_force_id: taskForceId });
    expect(await issueRow(issueId)).toMatchObject({ status: 'ESCALATED', escalation_level: 3, closed_at: null });
    expect((await issueRow(issueId))?.overdue_since).not.toBeNull();

    // A person who answers for units but is not in the task force sees both escalations and may accept only the one to the unit.
    await open(page, 'issueStranger', '/iss/iss-10');
    await expect(page.getByRole('heading', { level: 1, name: vi['iss.board.page.title'] })).toBeVisible();
    const cardOf = (level: number) => page.locator(`section[data-level="${level}"] article`, { hasText: title });
    await expect(cardOf(3)).toBeVisible();
    await expect(cardOf(3).getByRole('button', { name: vi['iss.board.accept.action'] })).toHaveCount(0);
    await expect(cardOf(2).getByRole('button', { name: vi['iss.board.accept.action'] })).toBeVisible();
    await expect(cardOf(3)).toContainText(TASK_FORCE_CODE);

    // The member of the task force accepts the escalation to it; the issue goes back to work and stays open.
    await open(page, 'issueTaskForce', '/iss/iss-10');
    await cardOf(3).getByLabel(vi['iss.board.accept.note.label']).fill('Tổ công tác nhận xử lý.');
    await cardOf(3).getByRole('button', { name: vi['iss.board.accept.action'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['iss.board.accept.done']);
    const accepted = await escalationsOf(issueId);
    expect(accepted[1]).toMatchObject({ level: 3, status: 'ACCEPTED', accepted_by: membershipOf('issueTaskForce') });
    expect(accepted[0]?.status).toBe('OPEN');
    expect(await issueRow(issueId)).toMatchObject({ status: 'IN_PROGRESS', closed_at: null });
    await expect(page.locator(`section[data-level="3"] article`, { hasText: title }).getByTestId('accept-state')).toHaveAttribute('data-state', 'accepted');

    // The person in charge of the unit accepts the escalation to the unit; the original issue is still open.
    await open(page, 'issueStranger', '/iss/iss-10');
    await cardOf(2).getByRole('button', { name: vi['iss.board.accept.action'] }).click();
    await expect(page.getByTestId('done')).toBeVisible();
    expect((await escalationsOf(issueId)).map((row) => row.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(await issueRow(issueId)).toMatchObject({ status: 'IN_PROGRESS', closed_at: null });

    // The workspace of the issue shows the escalations and leads to the board.
    await open(page, 'issueEscalator', `/iss/iss-04?id=${issueId}`);
    await expect(page.getByTestId('escalations').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('escalations')).toContainText(TASK_FORCE_CODE);
  });

  test('the coordinator raises a working issue to the task force by hand, keeping its deadline; no lower level is offered afterwards (AC-ST-ISS-004-1)', async ({ page }) => {
    const title = `Leo thang thủ công ${Date.now().toString(36).toUpperCase()}`;
    const issueId = await seedIssue(title, 1, 10);
    const [before] = await sql<{ due_at: Date }>('select due_at from machvon.issue where id = $1', [issueId]);

    await open(page, 'issueEscalator', `/iss/iss-04?id=${issueId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['iss.extension.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-escalations')).toBeVisible();
    // An empty form sends nothing.
    await page.getByRole('button', { name: vi['iss.extension.escalate.action'] }).click();
    await expect(page.locator('[data-field="escalate-level"]').getByText(vi['iss.field.required.error'])).toBeVisible();
    expect(await escalationsOf(issueId)).toEqual([]);
    await page.getByLabel(vi['iss.extension.escalate.level.label'], { exact: true }).selectOption('3');
    await expect(page.getByTestId('task-force')).toContainText(TASK_FORCE_CODE);
    await page.getByLabel(vi['iss.extension.escalate.reason.label'], { exact: true }).fill('Cần tổ công tác vào cuộc sớm.');
    await page.getByRole('button', { name: vi['iss.extension.escalate.action'] }).click();
    await expect(page.getByTestId('done')).toHaveText(vi['iss.extension.escalate.done']);

    const rows = await escalationsOf(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 3, status: 'OPEN', trigger: 'MANUAL', task_force_id: taskForceId });
    expect(await issueRow(issueId)).toMatchObject({ status: 'ESCALATED', escalation_level: 3, closed_at: null });
    const [after] = await sql<{ due_at: Date }>('select due_at from machvon.issue where id = $1', [issueId]);
    expect(after?.due_at).toEqual(before?.due_at);
    const events = await sql<{ event_kind: string }>('select event_kind from machvon.issue_event where issue_id = $1 order by created_at, id', [issueId]);
    expect(events.map((event) => event.event_kind)).toEqual(['ESCALATED']);

    // The issue is ESCALATED and at the highest level: nothing more is offered, and the list says what was done.
    await open(page, 'issueEscalator', `/iss/iss-04?id=${issueId}`);
    await expect(page.getByTestId('escalations').locator('li')).toHaveCount(1);
    await expect(page.getByRole('button', { name: vi['iss.extension.escalate.action'] })).toHaveCount(0);
  });

  test('someone who only reads sees the board and is offered nothing to accept or raise', async ({ page }) => {
    await open(page, 'issueReader', '/iss/iss-10');
    await expect(page.getByRole('heading', { level: 1, name: vi['iss.board.page.title'] })).toBeVisible();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['iss.board.accept.action'] })).toHaveCount(0);
    const [issue] = await sql<{ id: string }>("select id from machvon.issue where title like 'Quá hạn cần leo thang%' order by created_at desc limit 1");
    await open(page, 'issueReader', `/iss/iss-04?id=${issue?.id ?? ''}`);
    await expect(page.getByTestId('escalations')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['iss.extension.escalate.action'] })).toHaveCount(0);
  });
});
