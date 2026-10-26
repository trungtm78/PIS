import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * LND-06 (the posting of a plan, the opinions on it and its approval) in a real browser against the real API and database (apps/api/test/e2e-stack): an officer posts a plan, which counts the days of the rule and
 * starts the timer; records the opinion of a household; cannot close the posting before its days are over; closes it once they are; the approver is refused while an opinion is open and approves when it is handled,
 * with a decision document; the trail carries ids and dates and never the words of an opinion; a reader sees the posting and no button that acts.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const POLICY = 'Nghị định 88/2024/NĐ-CP, Điều 21';
const PLACE = 'Trụ sở UBND xã Tân Hòa';
const WORDS = 'Giá nhà quá thấp so với thị trường';
const DAY = 24 * 60 * 60 * 1000;

const vietnamToday = (): string => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
const after = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

interface Seeded {
  projectId: string;
  householdId: string;
  householdCode: string;
  planId: string;
  planCode: string;
  documentId: string;
}

/** A project with a household of the unit and a plan of it that is a draft with a support in it, and a decision document that was scanned clean. */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('landPlanWriter');
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const projectId = randomUUID();
  const code = `E2E-PST-${Date.now().toString(36).toUpperCase()}-${projectId.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, code, `Dự án GPMB ${code}`, unit, area?.id, officer],
  );
  const householdId = randomUUID();
  const householdCode = `HH-Q${projectId.slice(0, 5).toUpperCase()}`;
  await sql(
    `insert into machvon.affected_household
       (tenant_id, id, project_id, owner_unit_id, household_code, head_name, head_name_enc, legal_basis, legal_basis_ref, retention_until, status, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'N***** V** A', decode('00', 'hex'), 'PUBLIC_TASK_LAND_LAW', 'Luật Đất đai 2024, Điều 87', date '2036-12-31', 'REGISTERED', 1, $6, $6)`,
    [tenant, householdId, projectId, unit, householdCode, officer],
  );
  const planId = randomUUID();
  const planCode = `PA-${projectId.slice(0, 6).toUpperCase()}`;
  await sql(
    `insert into machvon.compensation_plan (tenant_id, id, project_id, executor_unit_id, executor_kind, plan_code, status, created_by, updated_by, version)
     values ($1, $2, $3, $4, 'LAND_FUND_CENTRE', $5, 'DRAFT', $6, $6, 1)`,
    [tenant, planId, projectId, unit, planCode, officer],
  );
  await sql(
    `insert into machvon.compensation_plan_item (tenant_id, id, plan_id, household_id, owner_unit_id, item_kind, amount_vnd, legal_basis, created_by, updated_by, version)
     values ($1, $2, $3, $4, $5, 'SUPPORT_LIVELIHOOD', 10000000, $6, $7, $7, 1)`,
    [tenant, randomUUID(), planId, householdId, unit, POLICY, officer],
  );
  await sql('update machvon.compensation_plan set total_support_vnd = 10000000, version = 2 where id = $1', [planId]);
  const [clean] = await sql<{ id: string }>("select id from machvon.document_version where tenant_id = $1 and scan_status = 'CLEAN' limit 1", [tenant]);
  return { projectId, householdId, householdCode, planId, planCode, documentId: clean?.id ?? '' };
}

async function open(page: Page, user: string, aim: Seeded, plan = false): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/lnd/lnd-06?project=${aim.projectId}${plan ? `&plan=${aim.planId}` : ''}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** The 30 days of the posting are over: the posting and its timer are put 40 days back (the clock of a browser flow cannot wait for them). */
async function letTheDaysPass(planId: string): Promise<void> {
  await sql(`do $$ begin
    alter table machvon.compensation_plan disable trigger compensation_plan_guard;
    alter table machvon.land_deadline disable trigger land_deadline_facts_guard;
    update machvon.compensation_plan set posting_started_on = posting_started_on - 40, posting_ends_on = posting_ends_on - 40 where id = '${planId}';
    update machvon.land_deadline set started_on = started_on - 40, due_on = due_on - 40 where subject_id = '${planId}';
    alter table machvon.compensation_plan enable trigger compensation_plan_guard;
    alter table machvon.land_deadline enable trigger land_deadline_facts_guard;
  end $$`);
}

test.describe('LND-06: the posting of a plan, the opinions on it and its approval', () => {
  test('an officer posts a plan for the days of the rule, records an opinion, closes the posting once its days are over, and the approver approves when every opinion is handled (AC-ST-LND-006-1, UAT-AC377, UI-LND-06)', async ({ page }) => {
    const aim = await seed();
    const today = vietnamToday();
    await open(page, 'landPlanWriter', aim);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.posting.page.title'] })).toBeVisible();

    // The draft is posted from today at a place; the days are those of the rule, and the end is counted for the officer.
    const row = page.locator(`[data-plan-id="${aim.planId}"]`);
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.draft.label']);
    await row.getByRole('button', { name: vi['lnd.posting.post.aria'].replace('{code}', aim.planCode).replace('{revision}', '1') }).click();
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error'])).toBeVisible();
    await page.getByLabel(vi['lnd.posting.postDialog.place.label'], { exact: true }).fill(PLACE);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.posting.label']);
    await expect(row.getByTestId('start')).toHaveText(today);
    await expect(row.getByTestId('end')).toHaveText(after(today, 30));
    const [deadline] = await sql<{ timer_code: string; days_applied: number; status: string }>("select timer_code, days_applied, status from machvon.land_deadline where subject_id = $1", [aim.planId]);
    expect(deadline).toEqual({ timer_code: 'PLAN_POSTING_30', days_applied: 30, status: 'RUNNING' });

    // The posting is open: the days that are left are counted by the server's day, and the posting cannot be closed.
    await row.getByRole('button', { name: vi['lnd.posting.open.aria'].replace('{code}', aim.planCode).replace('{revision}', '1') }).click();
    const detail = page.getByTestId('posting-detail');
    await expect(detail.getByTestId('tile-end')).toContainText(after(today, 30));
    await expect(detail.getByTestId('tile-left')).toContainText('30');
    await expect(detail.getByTestId('timer')).toContainText(vi['lnd.timer.planPosting30.label']);
    await expect(detail.getByTestId('timer')).toContainText('CXN-12');
    await expect(detail.getByRole('button', { name: vi['lnd.posting.close.action'] })).toBeDisabled();
    await expect(detail.getByTestId('close-hint')).toHaveText(vi['lnd.posting.close.hint'].replace('{date}', after(today, 30)));

    // An opinion of the household is recorded.
    await detail.getByRole('button', { name: vi['lnd.posting.feedback.action'] }).click();
    await page.getByLabel(vi['lnd.posting.feedbackDialog.household.label'], { exact: true }).selectOption({ index: 1 });
    await page.getByLabel(vi['lnd.posting.feedbackDialog.channel.label'], { exact: true }).selectOption('MEETING');
    await page.getByLabel(vi['lnd.posting.feedbackDialog.summary.label'], { exact: true }).fill(WORDS);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    const opinion = page.locator('[data-feedback-id]');
    await expect(opinion).toHaveCount(1);
    await expect(opinion.getByTestId('feedback-status')).toHaveText(vi['lnd.feedbackStatus.open.label']);
    await expect(detail.getByTestId('tile-open')).toContainText('1');

    // The days pass; the posting is closed with a summary of the opinions.
    await letTheDaysPass(aim.planId);
    await open(page, 'landPlanWriter', aim, true);
    const closing = page.getByTestId('posting-detail').getByRole('button', { name: vi['lnd.posting.close.action'] });
    await expect(closing).toBeEnabled();
    await closing.click();
    await page.getByLabel(vi['lnd.posting.closeDialog.summary.label'], { exact: true }).fill('Một ý kiến về giá nhà');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.postingClosed.label']);
    await expect(page.getByTestId('summary')).toHaveText(vi['lnd.posting.summary.text'].replace('{summary}', 'Một ý kiến về giá nhà'));
    const [timer] = await sql<{ status: string }>('select status from machvon.land_deadline where subject_id = $1', [aim.planId]);
    expect(timer?.status).toBe('SATISFIED');

    // The approver is refused while an opinion is open.
    await open(page, 'landPlanApprover', aim, true);
    await page.getByTestId('posting-detail').getByRole('button', { name: vi['lnd.posting.approve.action'] }).click();
    await page.getByLabel(vi['lnd.posting.approveDialog.document.label'], { exact: true }).fill(aim.documentId);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['lnd.posting.problem.unresolved.error']);
    await page.getByRole('button', { name: vi['lnd.dialog.cancel.action'] }).click();
    await expect(page.getByRole('button', { name: vi['lnd.posting.handle.action'] })).toHaveCount(0);

    // The officer handles the opinion; the approver approves with the decision document.
    await open(page, 'landPlanWriter', aim, true);
    await page.getByRole('button', { name: vi['lnd.posting.handle.aria'].replace('{household}', aim.householdCode) }).click();
    await page.getByLabel(vi['lnd.posting.handleDialog.note.label'], { exact: true }).fill('Đã giải thích tại cuộc họp thôn');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.locator('[data-feedback-id]').getByTestId('feedback-status')).toHaveText(vi['lnd.feedbackStatus.handled.label']);
    await expect(page.getByTestId('posting-detail').getByTestId('tile-handled')).toContainText('1');
    await open(page, 'landPlanApprover', aim, true);
    await page.getByTestId('posting-detail').getByRole('button', { name: vi['lnd.posting.approve.action'] }).click();
    await page.getByLabel(vi['lnd.posting.approveDialog.document.label'], { exact: true }).fill(aim.documentId);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.approved.label']);
    await expect(page.getByTestId('approval')).toHaveText(vi['lnd.posting.approval.text'].replace('{approved}', today).replace('{due}', after(today, 30)));
    const [plan] = await sql<{ status: string; approved_on: string; payment_due_on: string; approved_by: string }>(
      'select status, approved_on::text as approved_on, payment_due_on::text as payment_due_on, approved_by from machvon.compensation_plan where id = $1',
      [aim.planId],
    );
    expect(plan).toEqual({ status: 'APPROVED', approved_on: today, payment_due_on: after(today, 30), approved_by: membershipOf('landPlanApprover') });
    const [household] = await sql<{ status: string }>('select status from machvon.affected_household where id = $1', [aim.householdId]);
    expect(household?.status).toBe('REGISTERED');

    const trail = await sql<{ action: string; diff: string }>(
      "select action, safe_diff::text as diff from machvon.audit_event where action like 'lnd.plan_%' and resource_id = $1 order by occurred_at",
      [aim.planId],
    );
    expect(trail.map((entry) => entry.action)).toEqual(['lnd.plan_posted', 'lnd.plan_feedback_recorded', 'lnd.plan_posting_closed', 'lnd.plan_feedback_handled', 'lnd.plan_approved']);
    for (const entry of trail) {
      expect(entry.diff).not.toContain(WORDS);
      expect(entry.diff).not.toContain('Đã giải thích');
      expect(entry.diff).not.toContain(PLACE);
    }
  });

  test('a reader sees the posting, its dates and the opinions, and no button that posts, records, handles, closes or approves (UI-LND-06)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'landPlanWriter', aim);
    const row = page.locator(`[data-plan-id="${aim.planId}"]`);
    await row.getByRole('button', { name: vi['lnd.posting.post.aria'].replace('{code}', aim.planCode).replace('{revision}', '1') }).click();
    await page.getByLabel(vi['lnd.posting.postDialog.place.label'], { exact: true }).fill(PLACE);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.posting.label']);

    await open(page, 'landPlanReader', aim, true);
    const reader = page.locator(`[data-plan-id="${aim.planId}"]`);
    await expect(reader.getByTestId('status')).toHaveText(vi['lnd.planStatus.posting.label']);
    await expect(reader.getByTestId('end')).toHaveText(after(vietnamToday(), 30));
    await expect(reader.getByRole('button')).toHaveCount(1);
    const detail = page.getByTestId('posting-detail');
    await expect(detail.getByTestId('tile-left')).toContainText('30');
    await expect(detail.getByRole('button')).toHaveCount(0);
  });
});
