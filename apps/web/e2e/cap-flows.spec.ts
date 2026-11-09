import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql } from './support/stack.ts';

/**
 * CAP-16 (appropriation book), CAP-04 (fund source tree) and CAP-14 (central support and revenue increase) in a real browser against the real
 * API and database (apps/api/test/e2e-stack): the planner registers the capital a decision assigned, a different person publishes it, a change of
 * the amount is a new revision that replaces the published line, the registrant never decides on their own line (the screen offers no button and
 * the server refuses the call), and the support capital is a group of its own. What the screens changed is looked up in the database.
 */

/**
 * The edition the stack serves (MACHVON_EDITION, which the stack and the browser build both read): the enterprise register lists other origins than the public one, one budget level and a kind of decision document
 * (ENT-3e), so the flows that are not about a particular origin register the first line the edition accepts.
 */
const ENTERPRISE = (process.env.MACHVON_EDITION ?? process.env.VITE_EDITION) === 'enterprise';
/** The line the form opens on, in the words of the database and of the screen. */
const FIRST = ENTERPRISE ? { origin: 'GROUP_ASSIGNED', level: 'ALL', kind: 'GROUP_RESOLUTION' } : { origin: 'PM_ASSIGNED', level: 'CENTRAL', kind: null };
/** A second kind of line, chosen on the form: a board-approved line opens on the first kind the pack lists for it, the resolution of the company (fnd-taxonomy origin_decisions). */
const SECOND = ENTERPRISE
  ? { origin: 'BOARD_APPROVED', originLabel: vi['cap.origin.boardApproved.label'], level: 'ALL', levelLabel: vi['cap.level.all.label'], kind: 'COMPANY_RESOLUTION' }
  : { origin: 'LOCAL_ADDED', originLabel: vi['cap.origin.localAdded.label'], level: 'LOCAL', levelLabel: vi['cap.level.local.label'], kind: null };

/** The decision documents the stack seeds in tenant A (apps/api/test/e2e-stack): 1 to 4. */
const docId = (n: number): string => `00000000-0000-4000-005d-${n.toString(16).padStart(12, '0')}`;
const CITATION = (n: number): string => `QD-E2E-${n}/2026`;

async function open(page: Page, user: string, path = '/cap/cap-16'): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface AppropriationRow {
  id: string;
  status: string;
  origin: string;
  budget_level: string;
  decision_kind: string | null;
  plan_year: number;
  amount_vnd: string;
  allocated_total_vnd: string;
  revision: number;
  supersedes_id: string | null;
  created_by: string;
  approved_by: string | null;
  decision_document_id: string;
  fund_key: string;
}

const linesOf = (year: number): Promise<AppropriationRow[]> =>
  sql(
    `select a.id, a.status, a.origin, a.budget_level, a.decision_kind, a.plan_year, a.amount_vnd::text as amount_vnd, a.allocated_total_vnd::text as allocated_total_vnd, a.revision,
            a.supersedes_id, a.created_by, a.approved_by, a.decision_document_id, r.business_key as fund_key
       from machvon.appropriation a
       join machvon.master_record_version v on v.id = a.fund_source_version_id
       join machvon.master_record r on r.id = v.master_record_id
      where a.plan_year = $1 order by a.revision, a.created_at`,
    [year],
  );

const form = (page: Page, title: string): Locator => page.getByRole('form', { name: title });
const field = (scope: Locator, label: string): Locator => scope.getByLabel(label, { exact: true });
const rowOf = (page: Page, id: string): Locator => page.locator(`tr[data-appropriation-id="${id}"]`);

interface Entry {
  fund: string;
  year: string;
  amount: string;
  doc: number;
  authority: string;
  origin?: string;
  level?: string;
  /** The label of the kind of decision document (enterprise edition). */
  kind?: string;
}

async function register(page: Page, entry: Entry): Promise<void> {
  await page.getByRole('button', { name: vi['cap.book.register.action'] }).click();
  const panel = form(page, vi['cap.book.form.new.title']);
  await field(panel, vi['cap.form.fund.label']).selectOption({ label: entry.fund });
  await field(panel, vi['cap.form.year.label']).fill(entry.year);
  if (entry.origin !== undefined) await field(panel, vi['cap.form.origin.label']).selectOption({ label: entry.origin });
  if (entry.level !== undefined) await field(panel, vi['cap.form.level.label']).selectOption({ label: entry.level });
  if (entry.kind !== undefined) await field(panel, vi['cap.form.decisionKind.label']).selectOption({ label: entry.kind });
  await field(panel, vi['cap.form.amount.label']).fill(entry.amount);
  await field(panel, vi['cap.form.decision.label']).fill(docId(entry.doc));
  await field(panel, vi['cap.form.authority.label']).fill(entry.authority);
  await panel.getByRole('button', { name: vi['cap.form.submit.action'] }).click();
}

async function decide(page: Page, id: string, decision: 'approve' | 'reject', reason: string): Promise<void> {
  const row = rowOf(page, id);
  await row.locator(`[data-decision="${decision}"]`).click();
  const decisionForm = page.getByTestId('decision-row').getByRole('form', { name: vi['cap.book.decision.title'] });
  await field(decisionForm, decision === 'approve' ? vi['cap.book.reason.approve.label'] : vi['cap.book.reason.reject.label']).fill(reason);
  await decisionForm.getByRole('button', { name: decision === 'approve' ? vi['cap.book.decision.approve.action'] : vi['cap.book.decision.reject.action'] }).click();
}

test.describe('CAP-16 appropriation book', () => {
  test('the planner registers the capital of a decision, a different person publishes it, and a change of the amount is a revision that replaces it, never below what is allocated (AC-ST-CAP-001-1, AC-ST-CAP-001-3)', async ({ page }) => {
    await open(page, 'capPlanner');
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.book.page.title'] })).toBeVisible();

    // An empty form sends nothing: every required field says so and the database has nothing for the year.
    await page.getByRole('button', { name: vi['cap.book.register.action'] }).click();
    const panel = form(page, vi['cap.book.form.new.title']);
    await panel.getByRole('button', { name: vi['cap.form.submit.action'] }).click();
    for (const id of ['cap-fund', 'cap-year', 'cap-amount', 'cap-decision', 'cap-authority']) {
      await expect(panel.locator(`[data-field="${id}"]`).getByText(vi['cap.field.required.error'])).toBeVisible();
    }
    expect(await linesOf(2027)).toEqual([]);

    // The amount is typed in millions of dong; the exact dong the server will record is shown under it.
    await field(panel, vi['cap.form.fund.label']).selectOption({ label: 'NSTW · Ngân sách trung ương' });
    await field(panel, vi['cap.form.year.label']).fill('2027');
    await field(panel, vi['cap.form.amount.label']).fill('150');
    await expect(panel.getByTestId('exact-amount')).toHaveText(vi['cap.form.amountExact.text'].replace('{amount}', '150.000.000'));
    await field(panel, vi['cap.form.decision.label']).fill(docId(1));
    await field(panel, vi['cap.form.authority.label']).fill('Thủ tướng Chính phủ');
    await panel.getByRole('button', { name: vi['cap.form.submit.action'] }).click();
    await expect(panel).toBeHidden();
    const [draft] = await linesOf(2027);
    expect(draft).toMatchObject({ status: 'DRAFT', origin: FIRST.origin, budget_level: FIRST.level, decision_kind: FIRST.kind, amount_vnd: '150000000', allocated_total_vnd: '0', revision: 1, supersedes_id: null, created_by: membershipOf('capPlanner'), approved_by: null, decision_document_id: docId(1), fund_key: 'NSTW' });
    const first = draft?.id ?? '';
    await expect(rowOf(page, first)).toHaveAttribute('data-origin', FIRST.origin);
    await expect(rowOf(page, first).locator('[data-status]')).toHaveText(vi['cap.status.draft.label']);
    await expect(rowOf(page, first)).toContainText(CITATION(1));
    // The planner holds no approval permission: the draft offers no decision, and a draft is not in the total (of the year: the book holds the capital of other years too).
    await expect(rowOf(page, first).locator('[data-decision]')).toHaveCount(0);
    await field(page.getByRole('search', { name: vi['cap.book.filters.title'] }), vi['cap.book.year.label']).selectOption('2027');
    await expect(page.getByTestId('totals').locator('.cap-money').first()).toHaveAttribute('data-vnd', '0');

    // The same decision cannot assign the same capital twice.
    await register(page, { fund: 'NSTW · Ngân sách trung ương', year: '2027', amount: '90', doc: 1, authority: 'Thủ tướng Chính phủ' });
    await expect(page.getByRole('alert').filter({ hasText: vi['cap.problem.duplicate.error'] })).toBeVisible();
    expect(await linesOf(2027)).toHaveLength(1);

    // A different person decides. A reason that is too short does not send.
    await open(page, 'capApprover');
    await expect(page.getByRole('button', { name: vi['cap.book.register.action'] })).toHaveCount(0);
    await rowOf(page, first).locator('[data-decision="approve"]').click();
    const approveForm = page.getByTestId('decision-row').getByRole('form', { name: vi['cap.book.decision.title'] });
    await field(approveForm, vi['cap.book.reason.approve.label']).fill('đủ');
    await expect(approveForm.getByRole('button', { name: vi['cap.book.decision.approve.action'] })).toBeDisabled();
    await field(approveForm, vi['cap.book.reason.approve.label']).fill('Đúng văn bản giao của Thủ tướng');
    await approveForm.getByRole('button', { name: vi['cap.book.decision.approve.action'] }).click();
    await expect(rowOf(page, first).locator('[data-status]')).toHaveText(vi['cap.status.published.label']);
    expect((await linesOf(2027))[0]).toMatchObject({ status: 'PUBLISHED', approved_by: membershipOf('capApprover'), created_by: membershipOf('capPlanner') });
    await field(page.getByRole('search', { name: vi['cap.book.filters.title'] }), vi['cap.book.year.label']).selectOption('2027');
    const totals = page.getByTestId('totals').locator('.cap-money');
    await expect(totals.nth(0)).toHaveAttribute('data-vnd', '150000000');
    await expect(totals.nth(2)).toHaveAttribute('data-vnd', '150000000');

    // 60 million of it is allocated to projects (the allocation command belongs to another story: its effect is written the way that command does).
    await sql(
      `begin; select set_config('app.cap_allocation_write', 'on', true); update machvon.appropriation set allocated_total_vnd = 60000000 where id = '${first}'; commit`,
    );
    await open(page, 'capPlanner');
    await expect(rowOf(page, first).getByTestId('remaining').locator('.cap-money')).toHaveAttribute('data-vnd', '90000000');

    // A revision below what is allocated is refused and nothing is written.
    await rowOf(page, first).locator('[data-action="revise"]').click();
    const below = form(page, vi['cap.book.form.revision.title'].replace('{fund}', 'NSTW').replace('{year}', '2027'));
    await field(below, vi['cap.form.amount.label']).fill('50');
    await field(below, vi['cap.form.decision.label']).fill(docId(2));
    await below.getByRole('button', { name: vi['cap.form.submit.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['cap.problem.belowAllocated.error'] })).toBeVisible();
    expect(await linesOf(2027)).toHaveLength(1);

    // The planner revises the published line: a new draft names the one it replaces; the published one stays in force until the revision is decided.
    await open(page, 'capPlanner');
    await rowOf(page, first).locator('[data-action="revise"]').click();
    const revision = form(page, vi['cap.book.form.revision.title'].replace('{fund}', 'NSTW').replace('{year}', '2027'));
    await expect(field(revision, vi['cap.form.fund.label'])).toBeDisabled();
    await field(revision, vi['cap.form.amount.label']).fill('200');
    await field(revision, vi['cap.form.decision.label']).fill(docId(2));
    await revision.getByRole('button', { name: vi['cap.form.submit.action'] }).click();
    await expect(revision).toBeHidden();
    const lines = await linesOf(2027);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: first, status: 'PUBLISHED', amount_vnd: '150000000', revision: 1 });
    expect(lines[1]).toMatchObject({ status: 'DRAFT', amount_vnd: '200000000', revision: 2, supersedes_id: first, decision_document_id: docId(2) });
    const second = lines[1]?.id ?? '';
    // A second revision of the same line is refused while the first one waits.
    await rowOf(page, first).locator('[data-action="revise"]').click();
    const another = form(page, vi['cap.book.form.revision.title'].replace('{fund}', 'NSTW').replace('{year}', '2027'));
    await field(another, vi['cap.form.amount.label']).fill('210');
    await field(another, vi['cap.form.decision.label']).fill(docId(3));
    await another.getByRole('button', { name: vi['cap.form.submit.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['cap.problem.revisionPending.error'] })).toBeVisible();
    expect(await linesOf(2027)).toHaveLength(2);

    await open(page, 'capApprover');
    await decide(page, second, 'approve', 'Văn bản điều chỉnh giá trị giao');
    await expect(rowOf(page, second).locator('[data-status]')).toHaveText(vi['cap.status.published.label']);
    await expect(rowOf(page, first)).toHaveCount(0);
    await expect(rowOf(page, second)).toContainText(vi['cap.book.revision.label'].replace('{revision}', '2'));
    const after = await linesOf(2027);
    expect(after.map((line) => [line.revision, line.status, line.amount_vnd])).toEqual([
      [1, 'SUPERSEDED', '150000000'],
      [2, 'PUBLISHED', '200000000'],
    ]);
    expect(after[1]?.approved_by).toBe(membershipOf('capApprover'));
    // What was allocated follows the line to its revision, and the remainder is the new amount less it.
    expect(after[1]?.allocated_total_vnd).toBe('60000000');
    await expect(rowOf(page, second).getByTestId('remaining').locator('.cap-money')).toHaveAttribute('data-vnd', '140000000');
  });

  test('the registrant never decides on their own line: the screen offers no decision and the server refuses it, and another person publishes or rejects it (AC-ST-CAP-001-1)', async ({ page }) => {
    const authorization: string[] = [];
    page.on('request', (request) => {
      const header = request.headers().authorization;
      if (header !== undefined && request.url().includes('/api/')) authorization.push(header);
    });
    // The owner holds every permission, the approval of the capital among them.
    await open(page, 'owner');
    await register(page, { fund: 'NSDP · Ngân sách địa phương', year: '2028', amount: '40', doc: 3, authority: 'Hội đồng nhân dân tỉnh', origin: SECOND.originLabel, level: SECOND.levelLabel });
    await expect(page.getByRole('form', { name: vi['cap.book.form.new.title'] })).toBeHidden();
    const [draft] = await linesOf(2028);
    expect(draft).toMatchObject({ status: 'DRAFT', origin: SECOND.origin, budget_level: SECOND.level, decision_kind: SECOND.kind, fund_key: 'NSDP', created_by: membershipOf('owner') });
    const id = draft?.id ?? '';
    await expect(rowOf(page, id).getByText(vi['cap.book.ownDraft.notice'])).toBeVisible();
    await expect(rowOf(page, id).locator('[data-decision]')).toHaveCount(0);

    // The server refuses the same decision sent by hand with the owner's own session.
    const token = authorization[authorization.length - 1] ?? '';
    expect(token).toMatch(/^Bearer /);
    const refused = await page.request.post(`/api/appropriations/${id}/decision`, {
      headers: { authorization: token, 'idempotency-key': randomUUID(), 'if-match': '"1"', 'content-type': 'application/json' },
      data: { decision: 'approve', reason: 'Tự duyệt dòng do chính mình lập' },
    });
    expect(refused.status()).toBe(403);
    expect(await refused.text()).toContain('SELF_APPROVAL_DENIED');
    expect((await linesOf(2028))[0]).toMatchObject({ status: 'DRAFT', approved_by: null });

    // Another person publishes it: the local capital is a line of its own, by origin, with the remainder shown.
    await open(page, 'capApprover');
    await decide(page, id, 'approve', 'Nghị quyết của Hội đồng nhân dân tỉnh');
    await expect(rowOf(page, id).locator('[data-status]')).toHaveText(vi['cap.status.published.label']);
    await expect(rowOf(page, id).locator(`[data-origin="${SECOND.origin}"]`)).toHaveText(SECOND.originLabel);
    await expect(rowOf(page, id).getByTestId('remaining').locator('.cap-money')).toHaveAttribute('data-vnd', '40000000');
    expect((await linesOf(2028))[0]).toMatchObject({ status: 'PUBLISHED', approved_by: membershipOf('capApprover'), created_by: membershipOf('owner') });
    await field(page.getByRole('search', { name: vi['cap.book.filters.title'] }), vi['cap.book.origin.label']).selectOption(FIRST.origin);
    await expect(rowOf(page, id)).toHaveCount(0);

    // A second draft of the owner is rejected by another person for a stated reason; a rejected draft leaves the book.
    await open(page, 'owner');
    await register(page, { fund: 'NSTW · Ngân sách trung ương', year: '2028', amount: '10', doc: 3, authority: 'Thủ tướng Chính phủ' });
    await expect(page.getByRole('form', { name: vi['cap.book.form.new.title'] })).toBeHidden();
    const rejected = (await linesOf(2028)).find((line) => line.id !== id);
    expect(rejected).toMatchObject({ status: 'DRAFT', origin: FIRST.origin, fund_key: 'NSTW' });
    const rejectedId = rejected?.id ?? '';
    await open(page, 'capApprover');
    await decide(page, rejectedId, 'reject', 'Văn bản giao chưa đủ căn cứ');
    await expect(rowOf(page, rejectedId)).toHaveCount(0);
    await expect(rowOf(page, id)).toHaveCount(1);
    expect((await linesOf(2028)).find((line) => line.id === rejectedId)).toMatchObject({ status: 'REJECTED', approved_by: null });
    expect(await sql("select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = 'capital.appropriation_rejected' and reason = $2", [rejectedId, 'Văn bản giao chưa đủ căn cứ'])).toEqual([{ n: 1 }]);
  });

  test('someone who only reads the book cannot register or decide, and someone without the read permission is refused the screen', async ({ page }) => {
    const before = await sql<{ n: number }>('select count(*)::int as n from machvon.appropriation');
    await open(page, 'capReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.book.page.title'] })).toBeVisible();
    await expect(page.getByText(vi['cap.readOnly.denied.notice'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['cap.book.register.action'] })).toHaveCount(0);
    await expect(page.locator('[data-decision], [data-action="revise"]')).toHaveCount(0);

    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByTestId('book')).toHaveCount(0);
    expect(await sql<{ n: number }>('select count(*)::int as n from machvon.appropriation')).toEqual(before);
  });
});

test.describe('CAP-04 fund sources and CAP-14 support capital', () => {
  // Central support and revenue increase are origins of the public pack; the enterprise pack lists the resolution of the group and the decision of the company instead (the next test).
  test.skip(ENTERPRISE, 'the origins of the support capital belong to the public pack');
  test('published support capital is a group of its own on CAP-14, and the fund tree of CAP-04 shows it under its source with the ODA lending badge (AC-ST-CAP-001-2)', async ({ page }) => {
    await open(page, 'capPlanner');
    await register(page, {
      fund: 'ODA-NONLEND · Vốn ODA không vay lại',
      year: '2029',
      amount: '75,5',
      doc: 4,
      authority: 'Bộ Tài chính',
      origin: vi['cap.origin.centralSupport.label'],
    });
    await expect(page.getByRole('form', { name: vi['cap.book.form.new.title'] })).toBeHidden();
    const [draft] = await linesOf(2029);
    expect(draft).toMatchObject({ status: 'DRAFT', origin: 'CENTRAL_SUPPORT', amount_vnd: '75500000', fund_key: 'ODA-NONLEND' });
    const id = draft?.id ?? '';
    await register(page, {
      fund: 'NSDP · Ngân sách địa phương',
      year: '2029',
      amount: '30',
      doc: 4,
      authority: 'Sở Tài chính',
      origin: vi['cap.origin.revenueIncrease.label'],
      level: vi['cap.level.local.label'],
    });
    await expect(page.getByRole('form', { name: vi['cap.book.form.new.title'] })).toBeHidden();
    const increase = (await linesOf(2029)).find((line) => line.origin === 'REVENUE_INCREASE');
    expect(increase).toMatchObject({ status: 'DRAFT', amount_vnd: '30000000', budget_level: 'LOCAL', fund_key: 'NSDP' });
    const increaseId = increase?.id ?? '';

    // A draft is in no total: CAP-14 and CAP-04 show published capital only.
    await open(page, 'capReader', '/cap/cap-14');
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.support.page.title'] })).toBeVisible();
    await expect(page.locator(`tr[data-appropriation-id="${id}"]`)).toHaveCount(0);
    await open(page, 'capReader', '/cap/cap-04');
    await expect(page.locator(`li[data-appropriation-id="${id}"]`)).toHaveCount(0);

    await open(page, 'capApprover');
    await decide(page, id, 'approve', 'Văn bản hỗ trợ có mục tiêu');
    await expect(rowOf(page, id).locator('[data-status]')).toHaveText(vi['cap.status.published.label']);
    await decide(page, increaseId, 'approve', 'Số tăng thu được cấp có thẩm quyền xác nhận');
    await expect(rowOf(page, increaseId).locator('[data-status]')).toHaveText(vi['cap.status.published.label']);

    // The two kinds of support are two groups, each with its own total, and neither is merged into the capital the Prime Minister assigned.
    await open(page, 'capReader', '/cap/cap-14');
    const group = page.locator('[data-origin-group="CENTRAL_SUPPORT"]');
    await expect(group).toBeVisible();
    await expect(group.locator(`tr[data-appropriation-id="${id}"]`)).toContainText(CITATION(4));
    await expect(group.locator(`tr[data-appropriation-id="${increaseId}"]`)).toHaveCount(0);
    await expect(page.locator('[data-origin-group="PM_ASSIGNED"]')).toHaveCount(0);
    await expect(group.getByTestId('total-CENTRAL_SUPPORT').locator('.cap-money').first()).toHaveAttribute('data-vnd', '75500000');
    const revenue = page.locator('[data-origin-group="REVENUE_INCREASE"]');
    await expect(revenue.locator(`tr[data-appropriation-id="${increaseId}"]`)).toBeVisible();
    await expect(revenue.getByTestId('total-REVENUE_INCREASE').locator('.cap-money').first()).toHaveAttribute('data-vnd', '30000000');

    await open(page, 'capReader', '/cap/cap-04');
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.fund.page.title'] })).toBeVisible();
    const source = page.locator('li[data-fund-source="ODA-NONLEND"]');
    await expect(source.getByTestId('onlending')).toHaveText(vi['cap.fund.oda.grant.label']);
    await expect(source.locator(`li[data-appropriation-id="${id}"]`)).toContainText(CITATION(4));
    await expect(page.locator('li[data-category="ODA"]')).toBeVisible();
    await expect(page.getByTestId('grand-total')).toBeVisible();
  });
});

test.describe('CAP-16 in the enterprise edition (ENT-3e)', () => {
  test.skip(!ENTERPRISE, 'the origins, the level and the kinds of decision document belong to the enterprise pack');

  test('the form opens on a line the pack accepts, the kinds follow the origin, and the register keeps the kind of the document that backs the line (AC-ST-CAP-001-1)', async ({ page }) => {
    await open(page, 'capPlanner');
    await page.getByRole('button', { name: vi['cap.book.register.action'] }).click();
    const panel = form(page, vi['cap.book.form.new.title']);
    // Nothing but the required fields is needed: the origin, the single level and the kind of document are already ones the pack accepts.
    await expect(field(panel, vi['cap.form.origin.label'])).toHaveValue('GROUP_ASSIGNED');
    await expect(field(panel, vi['cap.form.level.label'])).toHaveValue('ALL');
    await expect(field(panel, vi['cap.form.decisionKind.label'])).toHaveValue('GROUP_RESOLUTION');
    await expect(field(panel, vi['cap.form.origin.label']).locator('option')).toHaveCount(3);
    await expect(field(panel, vi['cap.form.level.label']).locator('option')).toHaveCount(1);
    // The company's own origin takes the kinds of the company.
    await field(panel, vi['cap.form.origin.label']).selectOption('BOARD_APPROVED');
    await expect(field(panel, vi['cap.form.decisionKind.label'])).toHaveValue('COMPANY_RESOLUTION');
    await field(panel, vi['cap.form.decisionKind.label']).selectOption('COMPANY_DECISION');
    await field(panel, vi['cap.form.fund.label']).selectOption({ label: 'NSDP · Ngân sách địa phương' });
    await field(panel, vi['cap.form.year.label']).fill('2031');
    await field(panel, vi['cap.form.amount.label']).fill('250');
    await field(panel, vi['cap.form.decision.label']).fill(docId(4));
    await field(panel, vi['cap.form.authority.label']).fill('Hội đồng thành viên Tổng công ty');
    await panel.getByRole('button', { name: vi['cap.form.submit.action'] }).click();
    await expect(panel).toBeHidden();
    const [draft] = await linesOf(2031);
    expect(draft).toMatchObject({ status: 'DRAFT', origin: 'BOARD_APPROVED', budget_level: 'ALL', decision_kind: 'COMPANY_DECISION', amount_vnd: '250000000', fund_key: 'NSDP', created_by: membershipOf('capPlanner') });
    await expect(rowOf(page, draft?.id ?? '')).toHaveAttribute('data-origin', 'BOARD_APPROVED');
  });
});
