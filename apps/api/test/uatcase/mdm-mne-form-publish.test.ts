import { ADMIN, APPROVER, EVERYTHING, MneApp, TENANT_A, memberId } from '../mne/mne-app';
import type { Reply } from '../mne/mne-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';

jest.setTimeout(240_000);

/**
 * UAT-PLAN-73: the three refusals of the publication of a report form (BR-MNE-02) on a form code that has a revision in force: the author does not publish their own revision, a revision whose range overlaps the one in force is refused,
 * and a revision whose DOC template is gone is refused; none of the three becomes PUBLISHED. The drafts are made while nothing of the code is published (a draft that overlaps a published revision is refused at once), then the revision in force is published.
 */
const app = new MneApp();
const etag = (version: number): string => `"${version}"`;

const formBody = (formCode: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  form_code: formCode,
  title: 'Overall report, half year',
  report_kind: 'OVERALL_SEMIANNUAL',
  legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
  effective_from: '2026-01-01',
  schema_json: { tables: [] },
  doc_template_code: 'MNE-TT44-M02',
  export_formats: ['XLSX', 'PDF'],
  ...overrides,
});
const draft = (member: number, body: Record<string, unknown>): Promise<Reply> => app.call('POST', '/mne-forms', { member, body });
const publish = (member: number, formId: string, version = 1): Promise<Reply> => app.call('POST', `/mne-forms/${formId}/publish`, { member, ifMatch: etag(version) });
const idOf = (reply: Reply): string => reply.json.resource_id as string;
const statusOf = async (formId: string): Promise<string | undefined> => (await app.harness.owner<{ status: string }>(TENANT_A, [['select status from machvon.mne_report_form where id = $1', [formId]]]))[0]?.status;

describe('UAT-PLAN-73: a revision of a report form that cannot be published', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);

  it('goes red on a wrong answer (negative control)', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403, 'SELF_APPROVAL_DENIED'));
  });

  it('UAT-PLAN-73: the author is refused 403 SELF_APPROVAL_DENIED, the overlapping revision 409 FORM_RANGE_OVERLAP, the revision without a DOC template 422 DOC_TEMPLATE_MISSING, and none of the three is PUBLISHED', async () => {
    // A form code with a revision in force (F-1), and the revisions F-2 (drafted by user A, who also holds the right to publish) and F-3 (the same days as F-1).
    const code = 'UAT-PLAN-73-FORM';
    const inForce = await draft(ADMIN, formBody(code));
    const f2 = await draft(EVERYTHING, formBody(code));
    const f3 = await draft(ADMIN, formBody(code, { title: 'Overall report, the same half year again' }));
    for (const reply of [inForce, f2, f3]) assertStatus(reply, 200);
    assertStatus(await publish(APPROVER, idOf(inForce)), 200);
    // F-4 names a template that DOC has, and then DOC retires it before the publication.
    const f4 = await draft(ADMIN, formBody('UAT-PLAN-73-NO-TEMPLATE', { doc_template_code: 'MNE-TT44-M10' }));
    assertStatus(f4, 200);
    await app.harness.owner(TENANT_A, [
      ["update machvon.document_template set status = 'RETIRED', retired_at = now(), retired_by = $2, retirement_reason = 'withdrawn for the case' where template_code = $1", ['MNE-TT44-M10', memberId(ADMIN)]],
    ]);
    const before = await app.count("select count(*) as n from machvon.mne_report_form where status = 'PUBLISHED'");

    // Step 1: user A publishes the revision they drafted.
    const own = await publish(EVERYTHING, idOf(f2));
    assertStatus(own, 403, 'SELF_APPROVAL_DENIED');
    // Step 2: another person publishes F-3, whose days are already covered by the revision in force.
    const overlapping = await publish(APPROVER, idOf(f3));
    assertStatus(overlapping, 409, 'FORM_RANGE_OVERLAP');
    expect(overlapping.json.detail).toBe('effective_from');
    // Step 3: F-4, whose template is gone.
    const withoutTemplate = await publish(APPROVER, idOf(f4));
    assertStatus(withoutTemplate, 422, 'DOC_TEMPLATE_MISSING');
    expect(withoutTemplate.json.detail).toBe('doc_template_code');

    expect([await statusOf(idOf(f2)), await statusOf(idOf(f3)), await statusOf(idOf(f4))]).toEqual(['DRAFT', 'DRAFT', 'DRAFT']);
    expect(await app.count("select count(*) as n from machvon.mne_report_form where status = 'PUBLISHED'")).toBe(before);
    expect(await app.count("select count(*) as n from machvon.mne_report_form where form_code = $1 and status = 'PUBLISHED'", [code])).toBe(1);
  });
});
