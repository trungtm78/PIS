import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * MNE-02 (report form catalogue) and MNE-01 (filing calendar) in a real browser against the real API and database (apps/api/test/e2e-stack):
 * a form revision is drafted on the screen by one person and published by a second, a later revision takes over from the one in force, the
 * rules are drafted and published on the same screen by the same two people (the obligation rules panel of MNE-02; the calendar test prepares its own through the API), and the year is generated on
 * MNE-01: the obligations of the investors and of the project owner agencies appear with their form, level, due date, recipient and the
 * [CXN-nn] label, a second run adds nothing, and the role that no unit holds is reported instead of invented. The four-eyes rule is checked
 * on the screen (it offers the step to someone else) and on the server (it refuses the author). What the screens changed is looked up in the
 * database. The DOC template the forms point at is drafted and published through the API as in doc-template-flows.spec.ts.
 */

// Three codes are made within the same millisecond and the page finds a row by the text of its code: a code that is the beginning of another one (a random part of 11 against one of 112) would match its rows too,
// so the random part has a fixed width and a counter keeps two codes of one run apart.
let uniqueCounter = 0;
const unique = (): string => {
  uniqueCounter += 1;
  return `E2E-MNE-${Date.now().toString(36).toUpperCase()}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}${String(uniqueCounter).padStart(4, '0')}`;
};
/** The Vietnam date today, the day the screens judge a deadline by. */
const today = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const YEAR = Number(today().slice(0, 4));
const DAY_MS = 86_400_000;
const ADMIN = membershipOf('mneAdmin');
const APPROVER = membershipOf('mneApprover');
const BASIS = 'Thông tư 44/2026/TT-BTC, mẫu thử nghiệm [CXN-10]';
const RECIPIENT = 'Sở Tài chính tỉnh Cao Bằng';

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** The DOC template the forms of this file point at: drafted by the template administrator and published by the second person, once. */
let template: Promise<string> | undefined;

async function docTemplate(): Promise<string> {
  template ??= (async () => {
    const code = `${unique()}-TPL`;
    const profile = await sql<{ id: string }>("select id from machvon.document_layout_profile where tenant_id = $1 and status = 'PUBLISHED' limit 1", [stackInfo().tenants.A]);
    if (profile[0] === undefined) throw new Error('the stack has no published layout profile');
    const drafted = await apiCall('templateAdmin', 'POST', '/document-templates', {
      body: {
        template_code: code,
        group_code: 'REPORT_MONITORING',
        doc_type_code: 'BC',
        title: 'Báo cáo giám sát đầu tư thử nghiệm',
        layout_profile_id: profile[0].id,
        body_blocks: { blocks: [{ kind: 'heading', text: '{{title}}' }, { kind: 'paragraph', text: '{{body}}' }] },
        placeholder_schema: { required: ['title', 'body'] },
        legal_basis: BASIS,
        effective_from: '2026-01-01',
        watermark_text: 'UNCONFIRMED LEGAL BASIS [CXN-10]',
      },
    });
    expect([drafted.status, drafted.json.status]).toEqual([200, 'DRAFT']);
    const published = await apiCall('templatePublisher', 'POST', `/document-templates/${drafted.json.resource_id as string}/publish`, { version: drafted.json.resource_version as number });
    expect(published.status).toBe(200);
    return code;
  })();
  return template;
}

interface FormRow {
  id: string;
  revision: number;
  status: string;
  created_by: string;
  approved_by: string | null;
  legal_confirmation_ref: string | null;
  effective_from: string;
  effective_until: string | null;
  published: boolean;
  version: string;
}

const revisionsOf = (code: string): Promise<FormRow[]> =>
  sql(
    `select id::text, revision, status, created_by::text, approved_by::text, legal_confirmation_ref, effective_from::text, effective_until::text,
            published_at is not null as published, version::text
       from machvon.mne_report_form where form_code = $1 order by revision`,
    [code],
  );

/** A form revision drafted by the administrator and published by the approver through the API (the catalogue screen is tested on its own). */
async function publishedForm(code: string, kind: string): Promise<string> {
  const drafted = await apiCall('mneAdmin', 'POST', '/mne-forms', {
    body: {
      form_code: code,
      title: `Báo cáo ${code}`,
      report_kind: kind,
      legal_basis: BASIS,
      effective_from: `${YEAR}-01-01`,
      schema_json: {},
      doc_template_code: await docTemplate(),
      export_formats: ['XLSX'],
    },
  });
  expect([drafted.status, drafted.json.status]).toEqual([200, 'DRAFT']);
  const id = drafted.json.resource_id as string;
  expect((await apiCall('mneApprover', 'POST', `/mne-forms/${id}/publish`, { version: drafted.json.resource_version as number })).status).toBe(200);
  return id;
}

interface RuleSpec {
  code: string;
  formId: string;
  role: string;
  frequency: 'SEMIANNUAL' | 'ANNUAL';
  due: Record<string, unknown>;
  basis: string;
}

/** A rule drafted by the administrator, refused when the administrator publishes it, and published by the approver. */
async function publishedRule(rule: RuleSpec): Promise<void> {
  const drafted = await apiCall('mneAdmin', 'POST', '/mne-obligation-rules', {
    body: {
      rule_code: rule.code,
      form_id: rule.formId,
      reporting_role: rule.role,
      recipient: RECIPIENT,
      frequency: rule.frequency,
      due_rule_json: rule.due,
      legal_basis: rule.basis,
      effective_from: `${YEAR}-01-01`,
    },
  });
  expect([drafted.status, drafted.json.status]).toEqual([200, 'DRAFT']);
  const id = drafted.json.resource_id as string;
  const version = drafted.json.resource_version as number;
  const self = await apiCall('mneAdmin', 'POST', `/mne-obligation-rules/${id}/publish`, { version });
  expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
  expect(await sql('select status, approved_by::text from machvon.mne_obligation_rule where id = $1', [id])).toEqual([{ status: 'DRAFT', approved_by: null }]);
  expect((await apiCall('mneApprover', 'POST', `/mne-obligation-rules/${id}/publish`, { version })).status).toBe(200);
  expect(await sql('select status, approved_by::text from machvon.mne_obligation_rule where id = $1', [id])).toEqual([{ status: 'PUBLISHED', approved_by: APPROVER }]);
}

const formRow = (page: Page, code: string, revision: number): Locator =>
  page.locator(`tr[data-form-code="${code}"]`).filter({ hasText: vi['mne.forms.revision.pill'].replace('{revision}', String(revision)) });

const withParams = (text: string, params: Record<string, string>): string => Object.entries(params).reduce((result, [key, value]) => result.replace(`{${key}}`, value), text);

/** The days between two Vietnam dates. */
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

test.describe('MNE-02 report form catalogue', () => {
  test('a revision is drafted on the screen, published by a second person, and a later revision takes over from the one in force (AC-ST-MNE-001-2)', async ({ page }) => {
    const code = unique();
    const templateCode = await docTemplate();
    await open(page, 'mneAdmin', '/mne/mne-02');
    await expect(page.getByRole('heading', { level: 1, name: vi['mne.forms.page.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['mne.forms.create.open.action'] }).click();
    const form = page.getByRole('form', { name: vi['mne.forms.create.title'] });
    const save = form.getByRole('button', { name: vi['mne.forms.create.submit.action'] });
    const fill = async (label: string, value: string): Promise<void> => form.getByLabel(label, { exact: true }).fill(value);

    // An empty form sends nothing: every mandatory field says so and the database has nothing.
    await save.click();
    for (const field of ['revision-code', 'revision-title', 'revision-kind', 'revision-template', 'revision-from', 'revision-basis']) {
      await expect(form.locator(`[data-field="${field}"]`).getByText(vi['mne.forms.field.required'])).toBeVisible();
    }
    expect(await revisionsOf(code)).toEqual([]);

    // A DOC template that does not exist is refused by the server (422 DOC_TEMPLATE_MISSING) and nothing is saved.
    await fill(vi['mne.forms.create.code.label'], code);
    await fill(vi['mne.forms.create.name.label'], 'Báo cáo giám sát tổng thể 6 tháng (thử nghiệm)');
    await form.getByLabel(vi['mne.forms.create.kind.label'], { exact: true }).selectOption('OVERALL_SEMIANNUAL');
    await fill(vi['mne.forms.create.template.label'], 'KHONG-CO-MAU-NAY');
    await fill(vi['mne.forms.create.from.label'], `${YEAR}-01-01`);
    await fill(vi['mne.forms.create.basis.label'], BASIS);
    await save.click();
    await expect(form.getByRole('alert').filter({ hasText: vi['mne.forms.problem.templateMissing.text'] })).toBeVisible();
    expect(await revisionsOf(code)).toEqual([]);

    // With the template of the library the draft is saved; the maker holds the permission to approve, but the screen leaves the step to someone else.
    await fill(vi['mne.forms.create.template.label'], templateCode);
    await save.click();
    await expect(page.getByRole('status').filter({ hasText: withParams(vi['mne.forms.create.done.notice'], { code }) })).toBeVisible();
    const [draft] = await revisionsOf(code);
    expect(draft).toMatchObject({ revision: 1, status: 'DRAFT', created_by: ADMIN, approved_by: null, legal_confirmation_ref: null, effective_from: `${YEAR}-01-01`, effective_until: null, published: false, version: '1' });
    const asDrafted = formRow(page, code, 1);
    await expect(asDrafted.locator('[data-lifecycle="DRAFT"]')).toHaveText(vi['mne.forms.state.draft']);
    await expect(asDrafted.locator('[data-confirmation="pending"]')).toHaveText(withParams(vi['mne.forms.confirmation.pending'], { tags: '[CXN-10]' }));
    await expect(asDrafted).toContainText(vi['mne.forms.kind.overallSemiannual']);
    await expect(asDrafted.getByRole('link', { name: withParams(vi['mne.forms.template.link.label'], { code: templateCode }) })).toHaveAttribute('href', '/doc/doc-14');
    await expect(asDrafted.getByText(vi['mne.forms.publish.other.hint'])).toBeVisible();
    await expect(asDrafted.getByRole('button', { name: vi['mne.forms.publish.action'] })).toHaveCount(0);
    const selfPublish = await apiCall('mneAdmin', 'POST', `/mne-forms/${draft?.id ?? ''}/publish`, { version: 1 });
    expect([selfPublish.status, selfPublish.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect((await revisionsOf(code))[0]).toMatchObject({ status: 'DRAFT', approved_by: null, published: false, version: '1' });

    // The second person publishes it: the revision is in force from its start date, waiting for its legal confirmation.
    await open(page, 'mneApprover', '/mne/mne-02');
    await formRow(page, code, 1).getByRole('button', { name: withParams(vi['mne.forms.publish.label'], { code, revision: '1' }) }).click();
    await page.getByRole('form', { name: withParams(vi['mne.forms.publish.title'], { code, revision: '1' }) }).getByRole('button', { name: vi['mne.forms.publish.confirm.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: withParams(vi['mne.forms.publish.done.notice'], { code, revision: '1' }) })).toBeVisible();
    expect(await revisionsOf(code)).toEqual([{ ...draft, status: 'PUBLISHED', approved_by: APPROVER, published: true, version: '2' }]);
    const published = formRow(page, code, 1);
    await expect(published.locator('[data-lifecycle="PUBLISHED"]')).toHaveText(vi['mne.forms.state.published']);
    await expect(published).toContainText(withParams(vi['mne.forms.period.open'], { from: `${YEAR}-01-01` }));
    await expect(published).toContainText(vi['mne.forms.phase.inForce']);
    await expect(published.getByRole('button')).toHaveCount(0);
    await expect(page.getByTestId('awaiting-banner')).toBeVisible();
    // The approver may not draft: the catalogue offers them no new revision.
    await expect(page.getByRole('button', { name: vi['mne.forms.create.open.action'] })).toHaveCount(0);

    // A new revision that starts on the day of the one in force overlaps it: the server refuses it and nothing is saved (409 FORM_RANGE_OVERLAP).
    await open(page, 'mneAdmin', '/mne/mne-02');
    await page.getByRole('button', { name: vi['mne.forms.create.open.action'] }).click();
    const next = page.getByRole('form', { name: vi['mne.forms.create.title'] });
    const nextFill = async (label: string, value: string): Promise<void> => next.getByLabel(label, { exact: true }).fill(value);
    await nextFill(vi['mne.forms.create.code.label'], code);
    await nextFill(vi['mne.forms.create.name.label'], 'Báo cáo giám sát tổng thể 6 tháng (bản 2)');
    await next.getByLabel(vi['mne.forms.create.kind.label'], { exact: true }).selectOption('OVERALL_SEMIANNUAL');
    await nextFill(vi['mne.forms.create.template.label'], templateCode);
    await nextFill(vi['mne.forms.create.from.label'], `${YEAR}-01-01`);
    await nextFill(vi['mne.forms.create.basis.label'], BASIS);
    await next.getByRole('button', { name: vi['mne.forms.create.submit.action'] }).click();
    await expect(next.getByRole('alert').filter({ hasText: vi['mne.forms.problem.rangeOverlap.text'] })).toBeVisible();
    expect(await revisionsOf(code)).toHaveLength(1);

    // Starting later, with the reference of the legal confirmation, it is saved; once the approver publishes it, it ends the earlier one the day it starts.
    await nextFill(vi['mne.forms.create.from.label'], `${YEAR}-07-01`);
    await nextFill(vi['mne.forms.create.reference.label'], 'CXN-10');
    await next.getByRole('button', { name: vi['mne.forms.create.submit.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: withParams(vi['mne.forms.create.done.notice'], { code }) })).toBeVisible();
    expect((await revisionsOf(code)).map((row) => [row.revision, row.status, row.legal_confirmation_ref])).toEqual([
      [1, 'PUBLISHED', null],
      [2, 'DRAFT', 'CXN-10'],
    ]);
    await open(page, 'mneApprover', '/mne/mne-02');
    await formRow(page, code, 2).getByRole('button', { name: withParams(vi['mne.forms.publish.label'], { code, revision: '2' }) }).click();
    await page.getByRole('form', { name: withParams(vi['mne.forms.publish.title'], { code, revision: '2' }) }).getByRole('button', { name: vi['mne.forms.publish.confirm.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: withParams(vi['mne.forms.publish.done.notice'], { code, revision: '2' }) })).toBeVisible();
    const revisions = await revisionsOf(code);
    expect(revisions.map((row) => [row.revision, row.status, row.effective_from, row.effective_until, row.approved_by])).toEqual([
      [1, 'RETIRED', `${YEAR}-01-01`, `${YEAR}-07-01`, APPROVER],
      [2, 'PUBLISHED', `${YEAR}-07-01`, null, APPROVER],
    ]);
    await expect(formRow(page, code, 1).locator('[data-lifecycle="RETIRED"]')).toHaveText(vi['mne.forms.state.retired']);
    await expect(formRow(page, code, 1)).toContainText(withParams(vi['mne.forms.period.closed'], { from: `${YEAR}-01-01`, until: `${YEAR}-06-30` }));
    await expect(formRow(page, code, 2).locator('[data-confirmation="confirmed"]')).toHaveText(withParams(vi['mne.forms.confirmation.reference'], { reference: 'CXN-10' }));
    await expect(formRow(page, code, 2)).toContainText(withParams(vi['mne.forms.period.open'], { from: `${YEAR}-07-01` }));
    expect(
      await sql("select action from machvon.audit_event where action like 'mne.form_%' and outcome = 'SUCCESS' and resource_id = any($1::uuid[]) order by occurred_at", [revisions.map((row) => row.id)]),
    ).toEqual([{ action: 'mne.form_drafted' }, { action: 'mne.form_published' }, { action: 'mne.form_drafted' }, { action: 'mne.form_published' }]);

    // The catalogue shows the revision in force on a day: the last day of the first, then the first day of the second.
    const filter = page.getByRole('form', { name: vi['mne.forms.filter.title'] });
    await filter.getByLabel(vi['mne.forms.filter.effectiveOn.label'], { exact: true }).fill(`${YEAR}-06-30`);
    await filter.getByRole('button', { name: vi['mne.forms.filter.action'] }).click();
    await expect(page.locator(`tr[data-form-code="${code}"]`)).toHaveCount(1);
    await expect(formRow(page, code, 1)).toBeVisible();
    await filter.getByLabel(vi['mne.forms.filter.effectiveOn.label'], { exact: true }).fill(`${YEAR}-07-01`);
    await filter.getByRole('button', { name: vi['mne.forms.filter.action'] }).click();
    await expect(page.locator(`tr[data-form-code="${code}"]`)).toHaveCount(1);
    await expect(formRow(page, code, 2)).toBeVisible();
  });

  test('someone who only reads sees the catalogue without a step, and a member without the right to read gets the denied state', async ({ page }) => {
    const code = unique();
    const draft = await apiCall('mneAdmin', 'POST', '/mne-forms', {
      body: { form_code: code, title: `Báo cáo ${code}`, report_kind: 'EVALUATION', legal_basis: BASIS, effective_from: `${YEAR}-01-01`, schema_json: {}, doc_template_code: await docTemplate(), export_formats: ['PDF'] },
    });
    expect(draft.status).toBe(200);
    const before = await revisionsOf(code);

    await open(page, 'mneReader', '/mne/mne-02');
    await expect(page.getByRole('heading', { level: 1, name: vi['mne.forms.page.title'] })).toBeVisible();
    await expect(formRow(page, code, 1)).toBeVisible();
    await expect(formRow(page, code, 1).locator('[data-lifecycle="DRAFT"]')).toHaveText(vi['mne.forms.state.draft']);
    await expect(formRow(page, code, 1).getByRole('button')).toHaveCount(0);
    await expect(formRow(page, code, 1).getByText(vi['mne.forms.publish.other.hint'])).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['mne.forms.create.open.action'] })).toHaveCount(0);
    // The server says the same to a reader who calls the commands.
    const refusedDraft = await apiCall('mneReader', 'POST', '/mne-forms', {
      body: { form_code: `${code}-X`, title: 'Báo cáo thử', report_kind: 'EVALUATION', legal_basis: BASIS, effective_from: `${YEAR}-01-01`, schema_json: {}, doc_template_code: await docTemplate(), export_formats: ['PDF'] },
    });
    expect([refusedDraft.status, refusedDraft.json.code]).toEqual([403, 'SCOPE_DENIED']);
    const refusedPublish = await apiCall('mneReader', 'POST', `/mne-forms/${before[0]?.id ?? ''}/publish`, { version: 1 });
    expect([refusedPublish.status, refusedPublish.json.code]).toEqual([403, 'SCOPE_DENIED']);
    expect(await revisionsOf(code)).toEqual(before);
    expect(await revisionsOf(`${code}-X`)).toEqual([]);

    await open(page, 'nobody', '/mne/mne-02');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-form-code]')).toHaveCount(0);
  });
});

interface RuleRevision {
  id: string;
  revision: number;
  status: string;
  created_by: string;
  approved_by: string | null;
  effective_from: string;
  effective_until: string | null;
  due: string;
  version: string;
}

const ruleRevisionsOf = (code: string): Promise<RuleRevision[]> =>
  sql(
    `select id::text, revision, status, created_by::text, approved_by::text, effective_from::text, effective_until::text, due_rule_json::text as due, version::text
       from machvon.mne_obligation_rule where rule_code = $1 order by revision`,
    [code],
  );

const ruleRow = (page: Page, code: string, revision: number): Locator =>
  page.locator(`tr[data-rule-code="${code}"]`).filter({ hasText: vi['mne.forms.revision.pill'].replace('{revision}', String(revision)) });

test.describe('MNE-02 obligation rules', () => {
  test('a rule is drafted on the screen with a formula the server checks, published by a second person, and a later revision takes over from the one in force (AC-ST-MNE-001-2)', async ({ page }) => {
    const code = unique();
    const rule = `${code}-R`;
    // The planning agency is the level no unit holds in the data model: the rule published here is real data but gives the calendar of the other flows no obligation.
    await publishedForm(code, 'OVERALL_SEMIANNUAL');
    await open(page, 'mneAdmin', '/mne/mne-02');
    await expect(page.getByRole('heading', { level: 2, name: vi['mne.rules.page.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['mne.rules.create.open.action'] }).click();
    const form = page.getByRole('form', { name: vi['mne.rules.create.title'] });
    const save = form.getByRole('button', { name: vi['mne.rules.create.submit.action'] });
    const fill = async (label: string, value: string): Promise<void> => form.getByLabel(label, { exact: true }).fill(value);

    // An empty form sends nothing: every mandatory field says so and the database has nothing.
    await save.click();
    for (const field of ['rule-code', 'rule-form', 'rule-role', 'rule-frequency', 'rule-recipient', 'rule-from', 'rule-basis']) {
      await expect(form.locator(`[data-field="${field}"]`).getByText(vi['mne.forms.field.required'])).toBeVisible();
    }
    expect(await ruleRevisionsOf(rule)).toEqual([]);

    // A formula the server cannot evaluate is refused naming the field, and nothing is saved (422 VALIDATION_FAILED).
    await fill(vi['mne.rules.create.code.label'], rule);
    await form.getByLabel(vi['mne.rules.create.form.label'], { exact: true }).selectOption({ label: withParams(vi['mne.rules.create.form.option'], { code, revision: '1' }) });
    await form.getByLabel(vi['mne.rules.create.role.label'], { exact: true }).selectOption('PLANNING_AGENCY');
    await form.getByLabel(vi['mne.rules.create.frequency.label'], { exact: true }).selectOption('SEMIANNUAL');
    await fill(vi['mne.rules.create.recipient.label'], RECIPIENT);
    await fill(vi['mne.rules.create.from.label'], `${YEAR}-01-01`);
    await fill(vi['mne.rules.create.basis.label'], BASIS);
    await fill(vi['mne.rules.create.due.label'], '{"period":"H1","month":13,"day":10}');
    await save.click();
    await expect(form.getByRole('alert').filter({ hasText: 'due_rule_json.month' })).toBeVisible();
    expect(await ruleRevisionsOf(rule)).toEqual([]);

    // With a formula that holds it is saved; the maker holds the permission to approve, but the screen leaves the step to someone else.
    await fill(vi['mne.rules.create.due.label'], '{"period":"H1","month":7,"day":10}');
    await save.click();
    await expect(page.getByRole('status').filter({ hasText: withParams(vi['mne.rules.create.done.notice'], { code: rule }) })).toBeVisible();
    const [draft] = await ruleRevisionsOf(rule);
    expect(draft).toMatchObject({ revision: 1, status: 'DRAFT', created_by: ADMIN, approved_by: null, effective_from: `${YEAR}-01-01`, effective_until: null, version: '1' });
    expect(JSON.parse(draft?.due ?? '{}')).toEqual({ period: 'H1', month: 7, day: 10 });
    const asDrafted = ruleRow(page, rule, 1);
    await expect(asDrafted.locator('[data-lifecycle="DRAFT"]')).toHaveText(vi['mne.forms.state.draft']);
    await expect(asDrafted).toContainText(code);
    await expect(asDrafted).toContainText(vi['mne.calendar.role.planningAgency']);
    await expect(asDrafted).toContainText(vi['mne.rules.frequency.semiannual']);
    await expect(asDrafted).toContainText('period=H1 month=7 day=10');
    await expect(asDrafted).toContainText(RECIPIENT);
    await expect(asDrafted.locator('[data-confirmation="pending"]')).toHaveText(withParams(vi['mne.forms.confirmation.pending'], { tags: '[CXN-10]' }));
    await expect(asDrafted.getByText(vi['mne.forms.publish.other.hint'])).toBeVisible();
    await expect(asDrafted.getByRole('button')).toHaveCount(0);
    const selfPublish = await apiCall('mneAdmin', 'POST', `/mne-obligation-rules/${draft?.id ?? ''}/publish`, { version: 1 });
    expect([selfPublish.status, selfPublish.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect((await ruleRevisionsOf(rule))[0]).toMatchObject({ status: 'DRAFT', approved_by: null, version: '1' });

    // The second person publishes it; they may publish but not draft (the screen offers them no new rule).
    await open(page, 'mneApprover', '/mne/mne-02');
    await expect(page.getByRole('button', { name: vi['mne.rules.create.open.action'] })).toHaveCount(0);
    await ruleRow(page, rule, 1).getByRole('button', { name: withParams(vi['mne.rules.publish.label'], { code: rule, revision: '1' }) }).click();
    await page.getByRole('form', { name: withParams(vi['mne.rules.publish.title'], { code: rule, revision: '1' }) }).getByRole('button', { name: vi['mne.forms.publish.confirm.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: withParams(vi['mne.rules.publish.done.notice'], { code: rule, revision: '1' }) })).toBeVisible();
    expect(await ruleRevisionsOf(rule)).toEqual([{ ...draft, status: 'PUBLISHED', approved_by: APPROVER, version: '2' }]);
    await expect(ruleRow(page, rule, 1).locator('[data-lifecycle="PUBLISHED"]')).toHaveText(vi['mne.forms.state.published']);
    await expect(ruleRow(page, rule, 1).getByRole('button')).toHaveCount(0);

    // A revision that starts on the day of the one in force overlaps it: refused, nothing saved (409). Starting later it is saved.
    await open(page, 'mneAdmin', '/mne/mne-02');
    await page.getByRole('button', { name: vi['mne.rules.create.open.action'] }).click();
    const next = page.getByRole('form', { name: vi['mne.rules.create.title'] });
    const nextFill = async (label: string, value: string): Promise<void> => next.getByLabel(label, { exact: true }).fill(value);
    await nextFill(vi['mne.rules.create.code.label'], rule);
    await next.getByLabel(vi['mne.rules.create.form.label'], { exact: true }).selectOption({ label: withParams(vi['mne.rules.create.form.option'], { code, revision: '1' }) });
    await next.getByLabel(vi['mne.rules.create.role.label'], { exact: true }).selectOption('PLANNING_AGENCY');
    await next.getByLabel(vi['mne.rules.create.frequency.label'], { exact: true }).selectOption('SEMIANNUAL');
    await nextFill(vi['mne.rules.create.recipient.label'], RECIPIENT);
    await nextFill(vi['mne.rules.create.from.label'], `${YEAR}-01-01`);
    await nextFill(vi['mne.rules.create.basis.label'], BASIS);
    await nextFill(vi['mne.rules.create.due.label'], '{"period":"H1","month":7,"day":15}');
    await next.getByRole('button', { name: vi['mne.rules.create.submit.action'] }).click();
    await expect(next.getByRole('alert').filter({ hasText: vi['mne.forms.problem.rangeOverlap.text'] })).toBeVisible();
    expect(await ruleRevisionsOf(rule)).toHaveLength(1);
    await nextFill(vi['mne.rules.create.from.label'], `${YEAR}-07-01`);
    await next.getByRole('button', { name: vi['mne.rules.create.submit.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: withParams(vi['mne.rules.create.done.notice'], { code: rule }) })).toBeVisible();

    // Published by the approver it ends the earlier revision on the day it starts.
    await open(page, 'mneApprover', '/mne/mne-02');
    await ruleRow(page, rule, 2).getByRole('button', { name: withParams(vi['mne.rules.publish.label'], { code: rule, revision: '2' }) }).click();
    await page.getByRole('form', { name: withParams(vi['mne.rules.publish.title'], { code: rule, revision: '2' }) }).getByRole('button', { name: vi['mne.forms.publish.confirm.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: withParams(vi['mne.rules.publish.done.notice'], { code: rule, revision: '2' }) })).toBeVisible();
    const revisions = await ruleRevisionsOf(rule);
    expect(revisions.map((row) => [row.revision, row.status, row.effective_from, row.effective_until, row.approved_by])).toEqual([
      [1, 'RETIRED', `${YEAR}-01-01`, `${YEAR}-07-01`, APPROVER],
      [2, 'PUBLISHED', `${YEAR}-07-01`, null, APPROVER],
    ]);
    await expect(ruleRow(page, rule, 1).locator('[data-lifecycle="RETIRED"]')).toHaveText(vi['mne.forms.state.retired']);
    await expect(ruleRow(page, rule, 1)).toContainText(withParams(vi['mne.forms.period.closed'], { from: `${YEAR}-01-01`, until: `${YEAR}-06-30` }));
    await expect(ruleRow(page, rule, 2)).toContainText('period=H1 month=7 day=15');
    await expect(ruleRow(page, rule, 2)).toContainText(withParams(vi['mne.forms.period.open'], { from: `${YEAR}-07-01` }));
    expect(
      await sql("select action from machvon.audit_event where action like 'mne.obligation_rule_%' and outcome = 'SUCCESS' and resource_id = any($1::uuid[]) order by occurred_at", [revisions.map((row) => row.id)]),
    ).toEqual([{ action: 'mne.obligation_rule_drafted' }, { action: 'mne.obligation_rule_published' }, { action: 'mne.obligation_rule_drafted' }, { action: 'mne.obligation_rule_published' }]);
  });

  test('someone who only reads sees the rules without a step, and a member without the right to read gets no panel', async ({ page }) => {
    const code = unique();
    const rule = `${code}-R`;
    const formId = await publishedForm(code, 'OVERALL_ANNUAL');
    const drafted = await apiCall('mneAdmin', 'POST', '/mne-obligation-rules', {
      body: {
        rule_code: rule,
        form_id: formId,
        reporting_role: 'PROJECT_OWNER_AGENCY',
        recipient: RECIPIENT,
        frequency: 'ANNUAL',
        due_rule_json: { period: 'YEAR', month: 2, day: 10, year_offset: 1 },
        legal_basis: BASIS,
        effective_from: `${YEAR}-01-01`,
      },
    });
    expect(drafted.status).toBe(200);
    const before = await ruleRevisionsOf(rule);

    await open(page, 'mneReader', '/mne/mne-02');
    await expect(page.getByRole('heading', { level: 2, name: vi['mne.rules.page.title'] })).toBeVisible();
    await expect(ruleRow(page, rule, 1)).toBeVisible();
    await expect(ruleRow(page, rule, 1)).toContainText(vi['mne.calendar.role.projectOwnerAgency']);
    await expect(ruleRow(page, rule, 1)).toContainText('period=YEAR month=2 day=10 year_offset=1');
    await expect(ruleRow(page, rule, 1).getByRole('button')).toHaveCount(0);
    await expect(ruleRow(page, rule, 1).getByText(vi['mne.forms.publish.other.hint'])).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['mne.rules.create.open.action'] })).toHaveCount(0);
    // The server says the same to a reader who calls the commands.
    const refusedDraft = await apiCall('mneReader', 'POST', '/mne-obligation-rules', {
      body: { rule_code: `${rule}-X`, form_id: formId, reporting_role: 'INVESTOR', recipient: RECIPIENT, frequency: 'ANNUAL', due_rule_json: { period: 'YEAR', month: 2, day: 10, year_offset: 1 }, legal_basis: BASIS, effective_from: `${YEAR}-01-01` },
    });
    expect([refusedDraft.status, refusedDraft.json.code]).toEqual([403, 'SCOPE_DENIED']);
    const refusedPublish = await apiCall('mneReader', 'POST', `/mne-obligation-rules/${before[0]?.id ?? ''}/publish`, { version: 1 });
    expect([refusedPublish.status, refusedPublish.json.code]).toEqual([403, 'SCOPE_DENIED']);
    expect(await ruleRevisionsOf(rule)).toEqual(before);
    expect(await ruleRevisionsOf(`${rule}-X`)).toEqual([]);

    await open(page, 'nobody', '/mne/mne-02');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByTestId('rules-panel')).toHaveCount(0);
  });
});

test.describe('MNE-01 filing calendar', () => {
  test('the year is generated from the rules in force: every investor and project owner agency has its obligations with the CXN label, a second run adds nothing, and a role no unit holds is reported (AC-ST-MNE-001-1, AC-ST-MNE-001-3)', async ({ page }) => {
    const tenant = stackInfo().tenants.A;
    const half = unique();
    const annual = unique();
    const evaluation = unique();
    const halfRule = `${half}-R`;
    const annualRule = `${annual}-R`;
    const planningRule = `${evaluation}-R`;
    const halfForm = await publishedForm(half, 'OVERALL_SEMIANNUAL');
    const annualForm = await publishedForm(annual, 'OVERALL_ANNUAL');
    const evaluationForm = await publishedForm(evaluation, 'EVALUATION');
    const halfBasis = 'Thông tư 44/2026/TT-BTC, báo cáo 6 tháng trước ngày 10 tháng 7 [CXN-10]';
    const annualBasis = 'Thông tư 44/2026/TT-BTC, báo cáo năm trước ngày 10 tháng 2 năm sau [CXN-13]';
    // The judgement of the rule documents is that a deadline "before the 10th" is stored as the 10th; nothing here shifts for a holiday.
    await publishedRule({ code: halfRule, formId: halfForm, role: 'INVESTOR', frequency: 'SEMIANNUAL', due: { period: 'H1', month: 7, day: 10 }, basis: halfBasis });
    await publishedRule({ code: annualRule, formId: annualForm, role: 'PROJECT_OWNER_AGENCY', frequency: 'ANNUAL', due: { period: 'YEAR', month: 2, day: 10, year_offset: 1 }, basis: annualBasis });
    await publishedRule({ code: planningRule, formId: evaluationForm, role: 'PLANNING_AGENCY', frequency: 'ANNUAL', due: { period: 'YEAR', month: 3, day: 31, year_offset: 1 }, basis: BASIS });

    // The units the data model says owe a report: the investors by their flag, the owner agencies by the projects they own (the register of the stack holds more than one).
    const investors = (await sql<{ code: string }>("select code from machvon.organization_unit where tenant_id = $1 and is_investor and status = 'Active' order by code", [tenant])).map((row) => row.code);
    const owners = (
      await sql<{ code: string }>(
        "select distinct u.code from machvon.project p join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = p.owner_unit_id where p.tenant_id = $1 and u.status = 'Active' order by u.code",
        [tenant],
      )
    ).map((row) => row.code);
    expect(investors).toEqual(expect.arrayContaining(['CB-SKHDT-QLDA', 'CB-SKHDT-VP']));
    expect(owners).toContain('CB-SKHDT');
    const reportsOf = async (): Promise<Array<{ rule_code: string; n: number }>> =>
      sql(
        `select r.rule_code, count(*)::int as n from machvon.mne_report m join machvon.mne_obligation_rule r on r.id = m.obligation_rule_id
          where m.tenant_id = $1 and m.report_year = $2 and r.rule_code = any($3::text[]) group by r.rule_code order by r.rule_code`,
        [tenant, YEAR, [halfRule, annualRule, planningRule]],
      );
    const yearTotal = async (): Promise<number> => (await sql<{ n: number }>('select count(*)::int as n from machvon.mne_report where tenant_id = $1 and report_year = $2', [tenant, YEAR]))[0]?.n ?? 0;
    const runs = async (): Promise<number> =>
      (await sql<{ n: number }>("select count(*)::int as n from machvon.audit_event where action = 'mne.obligations_generated' and outcome = 'SUCCESS'"))[0]?.n ?? 0;
    expect(await reportsOf()).toEqual([]);
    const existingBefore = await yearTotal();
    const runsBefore = await runs();

    await open(page, 'mneAdmin', '/mne/mne-01');
    await expect(page.getByRole('heading', { level: 1, name: vi['mne.calendar.page.title'] })).toBeVisible();
    const generate = page.getByRole('form', { name: vi['mne.calendar.generate.title'] });
    const yearField = generate.getByLabel(vi['mne.calendar.generate.year.label'], { exact: true });
    await expect(yearField).toHaveValue(String(YEAR));

    // A year that is not four digits is stopped before it is sent.
    await yearField.fill('99');
    await generate.getByRole('button', { name: vi['mne.calendar.generate.action'] }).click();
    await expect(generate.locator('[data-field="generate-year"]').getByText(vi['mne.calendar.generate.year.error'])).toBeVisible();
    expect(await runs()).toBe(runsBefore);
    await yearField.fill(String(YEAR));

    // The first run writes one obligation per unit of each role; the planning agency has no unit in the data model, so its rule yields none and the answer says so.
    await generate.getByRole('button', { name: vi['mne.calendar.generate.action'] }).click();
    const created = investors.length + owners.length;
    await expect(page.getByTestId('generated')).toHaveText(withParams(vi['mne.calendar.generate.done.notice'], { created: String(created), existing: String(existingBefore) }));
    await expect(page.getByTestId('unresolved')).toHaveText(withParams(vi['mne.calendar.generate.unresolved.warning'], { roles: vi['mne.calendar.role.planningAgency'] }));
    expect(await reportsOf()).toEqual(
      [
        { rule_code: halfRule, n: investors.length },
        { rule_code: annualRule, n: owners.length },
      ].sort((left, right) => left.rule_code.localeCompare(right.rule_code)),
    );
    expect(await runs()).toBe(runsBefore + 1);
    const shells = await sql<{ status: string; created_by: string; payload: string; is_late: boolean }>(
      `select m.status, m.created_by::text, m.payload_json::text as payload, m.is_late from machvon.mne_report m join machvon.mne_obligation_rule r on r.id = m.obligation_rule_id
        where m.tenant_id = $1 and r.rule_code = any($2::text[])`,
      [tenant, [halfRule, annualRule]],
    );
    expect(shells).toHaveLength(created);
    for (const shell of shells) expect(shell).toMatchObject({ status: 'DRAFT', created_by: ADMIN, payload: '{}' });

    // The calendar lists them by due date in the month they fall due, with the form, the level, the unit, the period, the recipient and the CXN label of the legal basis.
    const rowsOf = (formCode: string): Locator => page.locator('tr[data-report-id]').filter({ hasText: formCode });
    const unitRow = (formCode: string, unit: string): Locator => rowsOf(formCode).filter({ has: page.locator('code', { hasText: new RegExp(`^${unit}$`) }) });
    await expect(rowsOf(half)).toHaveCount(investors.length);
    await expect(rowsOf(annual)).toHaveCount(owners.length);
    await expect(rowsOf(evaluation)).toHaveCount(0);
    const dueHalf = `${YEAR}-07-10`;
    const lateDays = daysBetween(dueHalf, today());
    for (const unit of investors) {
      const row = unitRow(half, unit);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(vi['mne.calendar.role.investor']);
      await expect(row).toContainText(`H1-${YEAR}`);
      await expect(row.locator('time')).toHaveAttribute('datetime', dueHalf);
      await expect(row).toContainText(RECIPIENT);
      await expect(row).toContainText(halfBasis);
      await expect(row.locator('[data-confirmation="pending"]')).toHaveText(withParams(vi['mne.forms.confirmation.pending'], { tags: '[CXN-10]' }));
      await expect(row).toContainText(vi['mne.calendar.status.draft']);
      // Past its due date and not filed, the row says how many days late; before it, it says nothing of the kind.
      if (lateDays > 0) await expect(row.locator('.ui-pill.ui-tone-danger')).toHaveText(withParams(vi['mne.calendar.late.text'], { days: String(lateDays) }));
      else await expect(row.locator('.ui-pill.ui-tone-danger')).toHaveCount(0);
    }
    for (const unit of owners) {
      const row = unitRow(annual, unit);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(vi['mne.calendar.role.projectOwnerAgency']);
      await expect(row).toContainText(`YEAR-${YEAR}`);
      await expect(row.locator('time')).toHaveAttribute('datetime', `${YEAR + 1}-02-10`);
      await expect(row.locator('[data-confirmation="pending"]')).toHaveText(withParams(vi['mne.forms.confirmation.pending'], { tags: '[CXN-13]' }));
      await expect(row.locator('.ui-pill.ui-tone-danger')).toHaveCount(0);
    }
    await expect(page.locator('[data-month]', { has: unitRow(half, investors[0] ?? '') })).toHaveAttribute('data-month', `${YEAR}-07`);
    await expect(page.getByRole('heading', { level: 2, name: withParams(vi['mne.calendar.month.heading'], { month: '07', year: String(YEAR) }) })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: withParams(vi['mne.calendar.month.heading'], { month: '02', year: String(YEAR + 1) }) })).toBeVisible();

    // The second run adds nothing: the answer counts every obligation as existing and the database holds the same rows.
    await generate.getByRole('button', { name: vi['mne.calendar.generate.action'] }).click();
    await expect(page.getByTestId('generated')).toHaveText(withParams(vi['mne.calendar.generate.done.notice'], { created: '0', existing: String(existingBefore + created) }));
    expect(await yearTotal()).toBe(existingBefore + created);
    expect(await reportsOf()).toEqual(
      [
        { rule_code: halfRule, n: investors.length },
        { rule_code: annualRule, n: owners.length },
      ].sort((left, right) => left.rule_code.localeCompare(right.rule_code)),
    );
    expect(await runs()).toBe(runsBefore + 2);
    await expect(rowsOf(half)).toHaveCount(investors.length);
    await expect(rowsOf(annual)).toHaveCount(owners.length);

    // The status filter narrows the calendar: nothing of this year has been approved.
    const status = page.getByLabel(vi['mne.calendar.filter.status.label'], { exact: true });
    await status.selectOption('APPROVED');
    await expect(page.locator('tr[data-report-id]')).toHaveCount(0);
    await status.selectOption('DRAFT');
    await expect(rowsOf(half)).toHaveCount(investors.length);
  });

  test('someone who only reads sees the calendar without the generation, the server refuses their command, and a member without the right to read gets the denied state (AC-ST-MNE-001-3)', async ({ page }) => {
    const before = (await sql<{ n: number }>('select count(*)::int as n from machvon.mne_report'))[0]?.n ?? 0;
    await open(page, 'mneReader', '/mne/mne-01');
    await expect(page.getByRole('heading', { level: 1, name: vi['mne.calendar.page.title'] })).toBeVisible();
    await expect(page.getByLabel(vi['mne.calendar.filter.year.label'], { exact: true })).toHaveValue(String(YEAR));
    await expect(page.getByRole('form', { name: vi['mne.calendar.generate.title'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['mne.calendar.generate.action'] })).toHaveCount(0);
    const refused = await apiCall('mneReader', 'POST', '/mne-obligations/generate', { body: { report_year: YEAR } });
    expect([refused.status, refused.json.code]).toEqual([403, 'SCOPE_DENIED']);
    // The approver does not generate either: that step belongs to whoever manages the calendar.
    await open(page, 'mneApprover', '/mne/mne-01');
    await expect(page.getByRole('form', { name: vi['mne.calendar.generate.title'] })).toHaveCount(0);
    expect((await sql<{ n: number }>('select count(*)::int as n from machvon.mne_report'))[0]?.n ?? 0).toBe(before);

    await open(page, 'nobody', '/mne/mne-01');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-report-id]')).toHaveCount(0);
    // The session of this fixture user carries no list of grants (the server decides), so the panel stays on the screen; the server refuses what it sends.
    await page.getByRole('form', { name: vi['mne.calendar.generate.title'] }).getByRole('button', { name: vi['mne.calendar.generate.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['mne.calendar.problem.scopeDenied.text'] })).toBeVisible();
    const refusedGeneration = await apiCall('nobody', 'POST', '/mne-obligations/generate', { body: { report_year: YEAR } });
    expect([refusedGeneration.status, refusedGeneration.json.code]).toEqual([403, 'SCOPE_DENIED']);
  });
});
