import { ADMIN, APPROVER, EVERYTHING, MneApp, NOBODY, READER, TENANT_A, TENANT_B } from './mne-app';
import type { Reply } from './mne-app';

jest.setTimeout(120_000);

const app = new MneApp();
let counter = 0;

const formBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  counter += 1;
  return {
    form_code: `API-FORM-${counter}`,
    title: 'Overall report, half year',
    report_kind: 'OVERALL_SEMIANNUAL',
    legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
    effective_from: '2026-01-01',
    schema_json: { tables: [] },
    doc_template_code: 'MNE-TT44-M02',
    export_formats: ['XLSX', 'PDF'],
    ...overrides,
  };
};
const etag = (version: number): string => `"${version}"`;
const draft = (overrides: Record<string, unknown> = {}, member = ADMIN, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/mne-forms', { member, body: formBody(overrides), ...(tenantId === undefined ? {} : { tenantId }) });
const publish = (id: string, version: number, member = APPROVER, tenantId?: string): Promise<Reply> =>
  app.call('POST', `/mne-forms/${id}/publish`, { member, ifMatch: etag(version), ...(tenantId === undefined ? {} : { tenantId }) });
const list = (query = '', member = READER, tenantId?: string): Promise<Reply> => app.call('GET', `/mne-forms${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

async function liveForm(overrides: Record<string, unknown> = {}): Promise<{ id: string; formCode: string; version: number }> {
  const body = formBody(overrides);
  const created = await app.call('POST', '/mne-forms', { member: ADMIN, body });
  expect(created.status).toBe(200);
  const published = await publish(created.json.resource_id as string, 1);
  expect(published.status).toBe(200);
  return { id: created.json.resource_id as string, formCode: body.form_code as string, version: published.json.resource_version as number };
}

describe('report forms API (ST-MNE-001, MNE F1)', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);

  describe('drafting and publishing', () => {
    it('drafts a revision as data with its legal basis, answers an ETag, and lists it with the label of the confirmation it waits for', async () => {
      const created = await draft({ form_code: 'API-ROUND-TRIP' });
      expect(created.status).toBe(200);
      expect(created.json).toMatchObject({ status: 'DRAFT', resource_version: 1, revision: 1 });
      expect(created.headers.get('etag')).toBe('"1"');
      const [row] = items(await list('?report_kind=OVERALL_SEMIANNUAL')).filter((item) => item.form_code === 'API-ROUND-TRIP');
      expect(row).toMatchObject({
        id: created.json.resource_id,
        revision: 1,
        status: 'DRAFT',
        legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
        legal_confirmation_ref: null,
        awaiting_confirmation: true,
        cxn_refs: ['CXN-10'],
        doc_template_code: 'MNE-TT44-M02',
        export_formats: ['XLSX', 'PDF'],
        origin: 'TENANT',
        effective_from: '2026-01-01',
        effective_until: null,
      });
      expect(row?.doc_template_id).toEqual(expect.any(String));
      expect(row).not.toHaveProperty('schema_json');
    });

    it('AC-ST-MNE-001-2: refuses the publication by the author (403 SELF_APPROVAL_DENIED), then lets another person publish', async () => {
      const own = await app.call('POST', '/mne-forms', { member: EVERYTHING, body: formBody() });
      const id = own.json.resource_id as string;
      const refused = await publish(id, 1, EVERYTHING);
      expect([refused.status, refused.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(items(await list()).find((item) => item.id === id)).toMatchObject({ status: 'DRAFT', approved_by: null });
      expect((await publish(id, 1, APPROVER)).status).toBe(200);
    });

    it('AC-ST-MNE-001-2: refuses a revision whose range overlaps the previous one (409 FORM_RANGE_OVERLAP)', async () => {
      const first = await liveForm({ effective_from: '2026-01-01', effective_until: '2026-07-01' });
      const overlapping = await draft({ form_code: first.formCode, effective_from: '2026-06-01' });
      expect([overlapping.status, overlapping.json.code]).toEqual([409, 'FORM_RANGE_OVERLAP']);
      const next = await draft({ form_code: first.formCode, effective_from: '2026-07-01' });
      expect(next.status).toBe(200);
      expect(next.json.revision).toBe(2);
    });

    it('AC-ST-MNE-001-2: refuses a form whose DOC template is missing (422 DOC_TEMPLATE_MISSING)', async () => {
      const reply = await draft({ doc_template_code: 'MNE-NO-SUCH-TEMPLATE' });
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'DOC_TEMPLATE_MISSING', 'doc_template_code']);
    });

    it('takes an open-ended revision over by a later one and answers the revisions in force by date', async () => {
      const first = await liveForm({ effective_from: '2026-01-01' });
      const second = await draft({ form_code: first.formCode, effective_from: '2026-07-01', title: 'Overall report, revision 2' });
      expect((await publish(second.json.resource_id as string, 1)).status).toBe(200);
      const all = items(await list()).filter((item) => item.form_code === first.formCode);
      expect(all.map((item) => [item.revision, item.status, item.effective_until])).toEqual([[1, 'RETIRED', '2026-07-01'], [2, 'PUBLISHED', null]]);
      expect(items(await list('?effective_on=2026-06-30')).filter((item) => item.form_code === first.formCode).map((item) => item.revision)).toEqual([1]);
      expect(items(await list('?effective_on=2026-07-01')).filter((item) => item.form_code === first.formCode).map((item) => item.revision)).toEqual([2]);
    });

    it('needs the version of the form to publish it, and answers a stale one with 409 VERSION_CONFLICT', async () => {
      const created = await draft();
      const id = created.json.resource_id as string;
      const missing = await app.call('POST', `/mne-forms/${id}/publish`, { member: APPROVER });
      expect([missing.status, missing.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      const stale = await publish(id, 5);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect(stale.json.current_version).toBe(1);
      expect((await publish(id, 1)).headers.get('etag')).toBe('"2"');
    });

    it('answers a published revision published again with 409 REPORT_STATE_INVALID', async () => {
      const live = await liveForm();
      const again = await publish(live.id, live.version, EVERYTHING);
      expect([again.status, again.json.code]).toEqual([409, 'REPORT_STATE_INVALID']);
    });

    it('replays the answer of a retried draft and writes nothing twice (idempotency)', async () => {
      const body = formBody({ form_code: 'API-IDEMPOTENT' });
      const first = await app.call('POST', '/mne-forms', { member: ADMIN, body, key: 'idempotent-form-0001' });
      const retry = await app.call('POST', '/mne-forms', { member: ADMIN, body, key: 'idempotent-form-0001' });
      expect(retry.status).toBe(200);
      expect(retry.json.resource_id).toBe(first.json.resource_id);
      expect(await app.count("select count(*)::text as n from machvon.mne_report_form where form_code = 'API-IDEMPOTENT'")).toBe(1);
      const conflicting = await app.call('POST', '/mne-forms', { member: ADMIN, body: { ...body, title: 'A different title' }, key: 'idempotent-form-0001' });
      expect([conflicting.status, conflicting.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('audits and announces what happened, with the actor and the revision, in the same transaction', async () => {
      const created = await draft({ form_code: 'API-AUDITED' });
      const id = created.json.resource_id as string;
      await publish(id, 1);
      const audited = await app.harness.owner<{ action: string; outcome: string }>(TENANT_A, [
        ['select action, outcome from machvon.audit_event where resource_id = $1 order by occurred_at', [id]],
      ]);
      expect(audited.map((row) => [row.action, row.outcome])).toEqual([['mne.form_drafted', 'SUCCESS'], ['mne.form_published', 'SUCCESS']]);
      const events = await app.harness.owner<{ type: string }>(TENANT_A, [['select type from machvon.outbox_event where aggregate_id = $1 order by created_at', [id]]]);
      expect(events.map((row) => row.type)).toEqual(['mne.form.drafted.v1', 'mne.form.published.v1']);
    });
  });

  describe('who may do what', () => {
    it('lets the reader read and nobody else, and keeps drafting and publishing to their own permissions', async () => {
      expect((await draft({}, READER)).status).toBe(403);
      expect((await draft({}, APPROVER)).status).toBe(403);
      const created = await draft();
      expect((await publish(created.json.resource_id as string, 1, ADMIN)).status).toBe(403);
      expect((await publish(created.json.resource_id as string, 1, READER)).status).toBe(403);
      expect((await list('', NOBODY)).status).toBe(403);
      expect((await list('', APPROVER)).status).toBe(200);
    });

    it('keeps the forms of a tenant out of the other: a form id of another tenant is unknown (404) and the catalogue is empty', async () => {
      const created = await draft({ form_code: 'API-TENANT-A-ONLY' });
      const foreign = await publish(created.json.resource_id as string, 1, ADMIN, TENANT_B);
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(items(await list('', ADMIN, TENANT_B)).filter((item) => item.form_code === 'API-TENANT-A-ONLY')).toEqual([]);
      // Tenant B has the pack, so its own drafts work on its own templates.
      const own = await draft({ form_code: 'API-TENANT-B' }, ADMIN, TENANT_B);
      expect(own.status).toBe(200);
    });
  });

  describe('what the request must carry', () => {
    it.each([
      ['an unknown field', { extra: 1 }, 400, 'FIELD_NOT_ALLOWED'],
      ['no form code', { form_code: undefined }, 400, 'INVALID_REQUEST'],
      ['a report kind outside the list', { report_kind: 'SOMETHING' }, 422, 'VALIDATION_FAILED'],
      ['an export format outside the list', { export_formats: ['DOCX'] }, 422, 'VALIDATION_FAILED'],
      ['no export format', { export_formats: [] }, 422, 'VALIDATION_FAILED'],
      ['a period that ends before it starts', { effective_until: '2025-12-31' }, 422, 'VALIDATION_FAILED'],
      ['a date that does not exist', { effective_from: '2026-02-30' }, 422, 'VALIDATION_FAILED'],
      ['a structure that is not an object', { schema_json: [] }, 400, 'INVALID_REQUEST'],
      ['an empty legal basis', { legal_basis: '' }, 422, 'LEGAL_BASIS_REQUIRED'],
      ['no legal basis', { legal_basis: undefined }, 422, 'LEGAL_BASIS_REQUIRED'],
    ])('refuses %s', async (_name, overrides, status, code) => {
      const reply = await draft(overrides);
      expect([reply.status, reply.json.code]).toEqual([status, code]);
    });

    it('names the field and never echoes the value of a refused text', async () => {
      const reply = await draft({ form_code: 'has a space' });
      expect(reply.status).toBe(422);
      expect(reply.json.detail).toBe('form_code');
      expect(JSON.stringify(reply.json)).not.toContain('has a space');
    });
  });

  describe('the catalogue read', () => {
    it('pages by form code and revision with a cursor and refuses a malformed filter or cursor', async () => {
      const first = await liveForm({ form_code: 'API-PAGE', effective_from: '2040-01-01' });
      const second = await draft({ form_code: 'API-PAGE', effective_from: '2041-01-01' });
      expect((await publish(second.json.resource_id as string, 1)).status).toBe(200);
      const page = await list('?limit=1&report_kind=OVERALL_SEMIANNUAL');
      expect(items(page)).toHaveLength(1);
      expect(page.json.next_cursor).toEqual(expect.any(String));
      const seen = new Set<string>();
      let cursor = page.json.next_cursor as string | null;
      items(page).forEach((item) => seen.add(item.id as string));
      while (cursor !== null) {
        const next = await list(`?limit=1&report_kind=OVERALL_SEMIANNUAL&cursor=${cursor}`);
        items(next).forEach((item) => seen.add(item.id as string));
        cursor = next.json.next_cursor as string | null;
      }
      expect(seen.has(first.id)).toBe(true);
      expect(seen.has(second.json.resource_id as string)).toBe(true);
      for (const query of ['?effective_on=tomorrow', '?effective_on=2026-02-30', '?report_kind=SOMETHING', '?limit=0', '?cursor=not-a-cursor']) {
        const reply = await list(query);
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
    });
  });
});
