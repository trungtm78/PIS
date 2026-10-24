import { ADMIN, APPROVER, BRANCH, MneApp, ROOT, TENANT_A, unitId } from './mne-app';
import type { Reply } from './mne-app';

jest.setTimeout(120_000);

/** A member who holds all four MNE write permissions, but only over the units under the branch. */
const BRANCH_ADMIN = 7;

const app = new MneApp();

const formBody = (code: string): Record<string, unknown> => ({
  form_code: code,
  title: 'Overall report, half year',
  report_kind: 'OVERALL_SEMIANNUAL',
  legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
  effective_from: '2026-01-01',
  schema_json: { tables: [] },
  doc_template_code: 'MNE-TT44-M02',
  export_formats: ['XLSX', 'PDF'],
});

const ruleBody = (formId: string, code: string): Record<string, unknown> => ({
  rule_code: code,
  form_id: formId,
  reporting_role: 'INVESTOR',
  frequency: 'SEMIANNUAL',
  due_rule_json: { period: 'H1', month: 7, day: 10 },
  recipient: 'Department of Finance',
  legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
  effective_from: '2026-01-01',
});

const code = (reply: Reply): unknown => reply.json.code;

/**
 * MNE 2: the forms and the filing rules belong to the tenant ("Quản trị mẫu biểu/lịch: Tenant", "Người duyệt mẫu biểu: Tenant"). The policy guard
 * only asks whether the caller holds the permission somewhere, so the commands themselves must ask for it on the whole tenant: a grant on a
 * branch must not draft or publish the form every unit files on, nor a rule that sets the deadline of every investor.
 */
describe('scope of the form and rule commands (ST-MNE-001, MNE 2)', () => {
  beforeAll(async () => {
    await app.start();
    const { harness } = app;
    await harness.seedMembership(TENANT_A, BRANCH_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 6, 'MNE_BRANCH_ADMIN', ['mne.form.manage', 'mne.form.approve', 'mne.calendar.manage', 'mne.calendar.approve', 'mne.read'], 40);
    await harness.seedGrants(TENANT_A, [{ n: 6, member: BRANCH_ADMIN, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] }]);
  }, 240_000);
  afterAll(() => app.stop(), 60_000);

  beforeEach(async () => {
    await app.reset();
  });

  it('refuses to draft a form on a grant over a branch, and writes nothing', async () => {
    const refused = await app.call('POST', '/mne-forms', { member: BRANCH_ADMIN, body: formBody('SCOPE-FORM') });
    expect([refused.status, code(refused)]).toEqual([403, 'SCOPE_DENIED']);
    expect(await app.count("select count(*) as n from machvon.mne_report_form where form_code = 'SCOPE-FORM'")).toBe(0);
    expect((await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody('SCOPE-FORM') })).status).toBe(200);
  });

  it('refuses to publish a form on a grant over a branch: the draft stays a draft', async () => {
    const drafted = await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody('SCOPE-FORM') });
    const id = drafted.json.resource_id as string;
    const refused = await app.call('POST', `/mne-forms/${id}/publish`, { member: BRANCH_ADMIN, ifMatch: '"1"' });
    expect([refused.status, code(refused)]).toEqual([403, 'SCOPE_DENIED']);
    expect(await app.harness.owner(TENANT_A, [['select status from machvon.mne_report_form where id = $1::uuid', [id]]])).toEqual([{ status: 'DRAFT' }]);
    expect((await app.call('POST', `/mne-forms/${id}/publish`, { member: APPROVER, ifMatch: '"1"' })).status).toBe(200);
  });

  it('refuses to draft and to publish an obligation rule on a grant over a branch', async () => {
    const form = await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody('SCOPE-FORM') });
    const formId = form.json.resource_id as string;
    expect((await app.call('POST', `/mne-forms/${formId}/publish`, { member: APPROVER, ifMatch: '"1"' })).status).toBe(200);

    const refusedDraft = await app.call('POST', '/mne-obligation-rules', { member: BRANCH_ADMIN, body: ruleBody(formId, 'SCOPE-RULE') });
    expect([refusedDraft.status, code(refusedDraft)]).toEqual([403, 'SCOPE_DENIED']);
    expect(await app.count("select count(*) as n from machvon.mne_obligation_rule where rule_code = 'SCOPE-RULE'")).toBe(0);

    const drafted = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(formId, 'SCOPE-RULE') });
    expect(drafted.status).toBe(200);
    const ruleId = drafted.json.resource_id as string;
    const refusedPublish = await app.call('POST', `/mne-obligation-rules/${ruleId}/publish`, { member: BRANCH_ADMIN, ifMatch: '"1"' });
    expect([refusedPublish.status, code(refusedPublish)]).toEqual([403, 'SCOPE_DENIED']);
    expect(await app.harness.owner(TENANT_A, [['select status from machvon.mne_obligation_rule where id = $1::uuid', [ruleId]]])).toEqual([{ status: 'DRAFT' }]);
    expect((await app.call('POST', `/mne-obligation-rules/${ruleId}/publish`, { member: APPROVER, ifMatch: '"1"' })).status).toBe(200);
  });
});
