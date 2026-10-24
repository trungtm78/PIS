import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PRJ-17 (who answers for a project) and PRJ-18 (the task forces) in a real browser against the real API and database (apps/api/test/e2e-stack):
 * the office that administers assignments on the whole tenant makes the leader in charge of a project, is refused a second one while the first
 * is in force, ends the first with a day and a reason and makes another; founds a task force, seats a member for a project and dissolves it, which
 * ends every open term; someone who only reads sees the register and the forces without a form. What the screens changed is looked up in the
 * database, and PRJ-01 shows the name of the leader once it is assigned.
 */

const unique = (): string => `E2E_${Date.now().toString(36).toUpperCase()}_${Math.floor(Math.random() * 1000)}`;
/** The Vietnam date `days` days from now, the clock the screens and the API judge dates by. */
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
const tenantA = (): string => stackInfo().tenants.A;
const UNIT_CODE = 'CB-SKHDT-QLDA';
// The people of the stack are named after their membership: the display name is "E2E " and the last two characters of the id.
const LEADER_NAME = 'E2E b2';
const LEADER_USER = 'projectViewer';
const MEMBER_USER = 'projectManager';

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** A project of the department of its own, so that the register of the test is the only one of its project. */
async function seedProject(code: string): Promise<string> {
  const projectId = randomUUID();
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1' limit 1", [tenantA()]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, 'B', $7, $7)`,
    [tenantA(), projectId, code, `Dự án ${code}`, stackInfo().units.A[UNIT_CODE], area?.id, membershipOf('owner')],
  );
  return projectId;
}

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

interface AssignmentRow {
  leader_membership_id: string;
  accountability_role: string;
  status: string;
  valid_until: string | null;
  end_reason: string | null;
  version: string;
}

const assignmentsOf = (projectId: string) =>
  sql<AssignmentRow>(
    'select leader_membership_id, accountability_role, status, valid_until::text as valid_until, end_reason, version::text as version from machvon.project_accountability where project_id = $1 order by valid_from, created_at',
    [projectId],
  );

test.describe('PRJ-17 and PRJ-18 accountability and task forces', () => {
  test('the office makes the leader in charge, is refused a second one, ends the first with a reason and makes another; PRJ-01 shows the name (AC-ST-PRJ-005-1)', async ({ page }) => {
    const code = unique();
    const projectId = await seedProject(code);
    await open(page, 'accountabilityAdmin', '/prj/prj-17');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.accountability.page.title'] })).toBeVisible();
    await expect(page.getByTestId('whole-tenant-notice')).toHaveCount(0);

    // An empty form sends nothing.
    await page.getByRole('button', { name: vi['prj.accountability.assign.submit.action'], exact: true }).click();
    await expect(page.locator('[data-field="assign-project"]').getByText(vi['prj.accountability.field.required.error'])).toBeVisible();
    expect(await assignmentsOf(projectId)).toEqual([]);

    await field(page, vi['prj.accountability.assign.project.label']).selectOption({ label: `${code} Dự án ${code}` });
    await field(page, vi['prj.accountability.assign.leader.label']).selectOption({ value: membershipOf(LEADER_USER) });
    await field(page, vi['prj.accountability.assign.from.label']).fill(inDays(-10));
    await page.getByRole('button', { name: vi['prj.accountability.assign.submit.action'], exact: true }).click();
    await expect(page.getByTestId('assign-saved')).toBeVisible();
    const row = page.locator('tr[data-assignment-id]', { hasText: code });
    await expect(row).toBeVisible();
    await expect(row).toContainText(LEADER_NAME);
    await expect(row.getByText(vi['prj.accountability.status.active.label'])).toBeVisible();
    const [first] = await assignmentsOf(projectId);
    expect(first).toMatchObject({ leader_membership_id: membershipOf('projectViewer'), accountability_role: 'LEADER_IN_CHARGE', status: 'ACTIVE', valid_until: null, version: '1' });
    expect(await sql("select count(*)::int as n from machvon.audit_event where action = 'project.leader_assigned' and resource_id = $1", [projectId])).toEqual([{ n: 1 }]);

    // A second leader in charge is refused while the first is in force, and nothing is written.
    await field(page, vi['prj.accountability.assign.project.label']).selectOption({ label: `${code} Dự án ${code}` });
    await field(page, vi['prj.accountability.assign.leader.label']).selectOption({ value: membershipOf(MEMBER_USER) });
    await field(page, vi['prj.accountability.assign.from.label']).fill(inDays(-5));
    await page.getByRole('button', { name: vi['prj.accountability.assign.submit.action'], exact: true }).click();
    await expect(page.getByTestId('assign-refusal')).toHaveText(vi['prj.accountability.problem.leaderTaken.error']);
    expect(await assignmentsOf(projectId)).toHaveLength(1);

    // PRJ-01 shows the name of the leader in charge.
    await page.goto('/prj/prj-01?devUser=accountabilityAdmin');
    await expect(page.locator('tr[data-project-id]', { hasText: code })).toContainText(LEADER_NAME);

    // Ending needs a day and a reason; the row stays as history and the project has no leader in charge for the register.
    await page.goto('/prj/prj-17?devUser=accountabilityAdmin');
    await page.getByRole('button', { name: vi['prj.accountability.end.action'].replace('{project}', code) }).click();
    await page.getByRole('button', { name: vi['prj.accountability.end.submit.action'], exact: true }).click();
    await expect(page.locator('[data-field="end-reason"]').getByText(vi['prj.accountability.field.required.error'])).toBeVisible();
    await field(page, vi['prj.accountability.end.until.label']).fill(inDays(-6));
    await field(page, vi['prj.accountability.end.reason.label']).fill('Chuyển sang nhiệm vụ khác');
    await page.getByRole('button', { name: vi['prj.accountability.end.submit.action'], exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await assignmentsOf(projectId)).toEqual([expect.objectContaining({ status: 'ENDED', valid_until: inDays(-6), end_reason: 'Chuyển sang nhiệm vụ khác', version: '2' })]);
    await expect(page.locator('tr[data-assignment-id]', { hasText: code }).getByText(vi['prj.accountability.status.ended.label'])).toBeVisible();

    // The place is free from the day after: another leader in charge is made.
    await field(page, vi['prj.accountability.assign.project.label']).selectOption({ label: `${code} Dự án ${code}` });
    await field(page, vi['prj.accountability.assign.leader.label']).selectOption({ value: membershipOf(MEMBER_USER) });
    await field(page, vi['prj.accountability.assign.from.label']).fill(inDays(-5));
    await page.getByRole('button', { name: vi['prj.accountability.assign.submit.action'], exact: true }).click();
    await expect(page.getByTestId('assign-saved')).toBeVisible();
    expect((await assignmentsOf(projectId)).map((item) => [item.leader_membership_id, item.status])).toEqual([
      [membershipOf('projectViewer'), 'ENDED'],
      [membershipOf('projectManager'), 'ACTIVE'],
    ]);
  });

  test('the office founds a task force, seats a member for a project of its scope and dissolves it, which ends every open term (AC-ST-PRJ-005-2)', async ({ page }) => {
    const code = unique();
    const projectId = await seedProject(code);
    const forceCode = `TF-${code}`.slice(0, 30);
    await open(page, 'accountabilityAdmin', '/prj/prj-18');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.taskforce.page.title'] })).toBeVisible();

    await page.getByRole('button', { name: vi['prj.taskforce.create.submit.action'], exact: true }).click();
    await expect(page.locator('[data-field="force-code"]').getByText(vi['prj.accountability.field.required.error'])).toBeVisible();
    await field(page, vi['prj.taskforce.create.code.label']).fill(forceCode);
    await field(page, vi['prj.taskforce.create.name.label']).fill('Tổ công tác đôn đốc giải ngân kiểm thử');
    await field(page, vi['prj.taskforce.create.purpose.label']).fill('Đôn đốc giải ngân các dự án chậm của Ban QLDA');
    await field(page, vi['prj.taskforce.create.lead.label']).selectOption({ value: membershipOf(MEMBER_USER) });
    await field(page, vi['prj.taskforce.create.scope.label']).selectOption({ index: 1 });
    await field(page, vi['prj.taskforce.create.from.label']).fill(inDays(-3));
    await page.getByRole('button', { name: vi['prj.taskforce.create.submit.action'], exact: true }).click();
    await expect(page.getByTestId('create-saved')).toBeVisible();
    const [made] = await sql<{ id: string; status: string; version: string; lead_membership_id: string }>('select id, status, version::text as version, lead_membership_id from machvon.task_force where code = $1', [forceCode]);
    expect(made).toMatchObject({ status: 'ACTIVE', version: '1', lead_membership_id: membershipOf('projectManager') });

    // The same code again is refused by the server and nothing is written.
    await field(page, vi['prj.taskforce.create.code.label']).fill(forceCode);
    await field(page, vi['prj.taskforce.create.name.label']).fill('Tổ công tác trùng mã');
    await field(page, vi['prj.taskforce.create.purpose.label']).fill('Tổ công tác này dùng lại một mã đã có');
    await field(page, vi['prj.taskforce.create.lead.label']).selectOption({ value: membershipOf(MEMBER_USER) });
    await field(page, vi['prj.taskforce.create.scope.label']).selectOption({ index: 1 });
    await field(page, vi['prj.taskforce.create.from.label']).fill(inDays(-3));
    await page.getByRole('button', { name: vi['prj.taskforce.create.submit.action'], exact: true }).click();
    await expect(page.getByTestId('create-refusal')).toHaveText(vi['prj.accountability.problem.codeTaken.error']);
    expect(await sql('select count(*)::int as n from machvon.task_force where code = $1', [forceCode])).toEqual([{ n: 1 }]);

    const card = page.locator('[data-force-id]', { hasText: forceCode });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: vi['prj.taskforce.member.action'].replace('{code}', forceCode) }).click();
    await field(page, vi['prj.taskforce.member.person.label']).selectOption({ value: membershipOf(LEADER_USER) });
    await field(page, vi['prj.taskforce.member.project.label']).selectOption({ label: `${code} Dự án ${code}` });
    await field(page, vi['prj.taskforce.member.from.label']).fill(inDays(-2));
    await page.getByRole('button', { name: vi['prj.taskforce.member.submit.action'], exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await sql('select membership_id, member_role, project_id from machvon.task_force_member where task_force_id = $1 order by created_at', [made?.id])).toEqual([
      { membership_id: membershipOf('projectManager'), member_role: 'LEAD', project_id: null },
      { membership_id: membershipOf('projectViewer'), member_role: 'MEMBER', project_id: projectId },
    ]);

    await card.getByRole('button', { name: vi['prj.taskforce.dissolve.action'].replace('{code}', forceCode) }).click();
    await expect(page.getByTestId('dissolve-warning')).toHaveText(vi['prj.taskforce.dissolve.warning.text'].replace('{count}', '2'));
    await field(page, vi['prj.taskforce.dissolve.reason.label']).fill('Đã hoàn thành mục tiêu giải ngân');
    await page.getByRole('button', { name: vi['prj.taskforce.dissolve.submit.action'], exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await sql('select status from machvon.task_force where id = $1', [made?.id])).toEqual([{ status: 'DISSOLVED' }]);
    expect(await sql('select count(*)::int as n from machvon.task_force_member where task_force_id = $1 and valid_until is null', [made?.id])).toEqual([{ n: 0 }]);
    await expect(card.getByText(vi['prj.taskforce.status.dissolved.label'])).toBeVisible();
    await expect(card.getByRole('button', { name: vi['prj.taskforce.member.action'].replace('{code}', forceCode) })).toHaveCount(0);
  });

  test('someone who only reads sees the register and the forces without a form or an action', async ({ page }) => {
    await open(page, 'accountabilityReader', '/prj/prj-17');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.accountability.page.title'] })).toBeVisible();
    await expect(page.getByRole('form', { name: vi['prj.accountability.assign.title'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Kết thúc phân công/ })).toHaveCount(0);
    await open(page, 'accountabilityReader', '/prj/prj-18');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.taskforce.page.title'] })).toBeVisible();
    await expect(page.getByRole('form', { name: vi['prj.taskforce.create.title'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Giải thể tổ/ })).toHaveCount(0);
  });
});
