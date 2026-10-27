import { createHash, randomUUID } from 'node:crypto';
import { ADMIN, AUTHOR, BLOCKS, BRANCH, LEGAL, NOBODY, READER, RENDERER, SECOND_LEGAL, TENANT_A, TENANT_B, TemplateApp, memberId } from './template-app';
import type { Reply } from './template-app';
import { pageTexts } from './support/pdf-pages-text';

jest.setTimeout(120_000);

const app = new TemplateApp();
const AS_OF = '2026-10-23';
const WATERMARK = 'UNCONFIRMED LEGAL BASIS [CXN-10]';
let counter = 0;

const templateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  counter += 1;
  return {
    template_code: `API-TPL-${counter}`,
    group_code: 'REPORT_MONITORING',
    doc_type_code: 'BC',
    title: 'Monitoring report',
    layout_profile_id: app.layoutProfileId,
    body_blocks: BLOCKS,
    placeholder_schema: { required: ['title', 'body'] },
    legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
    effective_from: '2026-01-01',
    watermark_text: WATERMARK,
    ...overrides,
  };
};
const PAYLOAD = { title: 'Report', body: 'The report body.', agency: 'Project board', place: 'Cao Bang' };

const etag = (version: number): string => `"${version}"`;
const draft = (overrides: Record<string, unknown> = {}, member = ADMIN): Promise<Reply> => app.call('POST', '/document-templates', { member, body: templateBody(overrides) });
const publish = (id: string, version: number, member = AUTHOR): Promise<Reply> => app.call('POST', `/document-templates/${id}/publish`, { member, ifMatch: etag(version) });
const confirm = (id: string, version: number, member = LEGAL, body: Record<string, unknown> = {}): Promise<Reply> =>
  app.call('POST', `/document-templates/${id}/legal-confirmation`, {
    member,
    ifMatch: etag(version),
    body: { legal_confirmation_ref: 'CXN-10', evidence_document_id: app.evidenceDocumentId, ...body },
  });
const retire = (id: string, version: number, member = ADMIN, reason = 'The form was withdrawn by its issuer'): Promise<Reply> =>
  app.call('POST', `/document-templates/${id}/retirement`, { member, ifMatch: etag(version), body: { reason } });
const render = (code: string, asOf = AS_OF, payload: Record<string, unknown> = PAYLOAD): Promise<Reply> =>
  app.call('POST', '/document-renders', { member: RENDERER, body: { template_code: code, as_of_date: asOf, payload } });
const detail = (id: string, member = READER, tenantId?: string): Promise<Reply> => app.call('GET', `/document-templates/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

async function liveTemplate(overrides: Record<string, unknown> = {}): Promise<{ id: string; code: string; version: number }> {
  const created = await draft(overrides);
  expect(created.status).toBe(200);
  const id = created.json.resource_id as string;
  const published = await publish(id, 1);
  expect(published.status).toBe(200);
  return { id, code: (await detail(id)).json.template_code as string, version: published.json.resource_version as number };
}

async function storedFile(versionId: string): Promise<{ bytes: Uint8Array; checksum: string; templateId: string | null }> {
  const [row] = await app.harness.owner<{ object_key: string; checksum: string; template_id: string | null }>(TENANT_A, [
    ['select object_key, checksum, template_id from machvon.document_version where id = $1', [versionId]],
  ]);
  const stored = await app.files.get(row?.object_key ?? '');
  return { bytes: stored?.bytes ?? new Uint8Array(), checksum: row?.checksum ?? '', templateId: row?.template_id ?? null };
}

describe('document template library API (ST-DOC-006)', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);

  describe('the three separated steps (AC-ST-DOC-006-1)', () => {
    it('AC-ST-DOC-006-1: refuses self approval, publishes with the watermark, refuses a confirmer without the permission, needs a reference, then confirms: new renders have no watermark and older ones keep it', async () => {
      await app.setLayoutConfirmed(true);
      try {
        const created = await draft({ template_code: 'UAT-424-MNE-TT44-M03' });
        expect(created.status).toBe(200);
        expect(created.json).toMatchObject({ status: 'DRAFT', resource_version: 1, revision: 1 });
        expect(created.headers.get('etag')).toBe('"1"');
        const id = created.json.resource_id as string;

        const self = await publish(id, 1, ADMIN);
        expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
        expect((await detail(id)).json).toMatchObject({ status: 'DRAFT', approved_by: null });

        const published = await publish(id, 1, AUTHOR);
        expect(published.status).toBe(200);
        expect(published.json).toMatchObject({ status: 'PUBLISHED', resource_version: 2 });

        const before = await render('UAT-424-MNE-TT44-M03');
        expect(before.status).toBe(200);
        expect(before.json).toMatchObject({ watermarked: true });
        const beforeFile = await storedFile(before.json.version_id as string);
        expect((await pageTexts(beforeFile.bytes)).every((texts) => texts.includes(WATERMARK))).toBe(true);

        const notAllowed = await confirm(id, 2, ADMIN);
        expect([notAllowed.status, notAllowed.json.code]).toEqual([403, 'SCOPE_DENIED']);

        const empty = await confirm(id, 2, LEGAL, { legal_confirmation_ref: '' });
        expect([empty.status, empty.json.code, empty.json.detail]).toEqual([422, 'CONFIRMATION_REF_REQUIRED', 'legal_confirmation_ref']);
        const missing = await app.call('POST', `/document-templates/${id}/legal-confirmation`, { member: LEGAL, ifMatch: etag(2), body: { evidence_document_id: app.evidenceDocumentId } });
        expect([missing.status, missing.json.code]).toEqual([422, 'CONFIRMATION_REF_REQUIRED']);
        const blank = await confirm(id, 2, LEGAL, { legal_confirmation_ref: '     ' });
        expect([blank.status, blank.json.code]).toEqual([422, 'CONFIRMATION_REF_REQUIRED']);

        const confirmed = await confirm(id, 2, LEGAL);
        expect(confirmed.status).toBe(200);
        expect(confirmed.json).toMatchObject({ status: 'CONFIRMED', resource_version: 3 });

        const row = (await detail(id)).json;
        expect(row).toMatchObject({
          confirmation_status: 'CONFIRMED',
          legal_confirmation_ref: 'CXN-10',
          legal_confirmed_by: memberId(LEGAL),
          legal_evidence_document_id: app.evidenceDocumentId,
          approved_by: memberId(AUTHOR),
          created_by: memberId(ADMIN),
          renders_watermarked: false,
          status: 'PUBLISHED',
        });
        expect(typeof row.legal_confirmed_at).toBe('string');

        const after = await render('UAT-424-MNE-TT44-M03');
        expect(after.json).toMatchObject({ watermarked: false });
        const afterFile = await storedFile(after.json.version_id as string);
        expect((await pageTexts(afterFile.bytes)).some((texts) => texts.includes(WATERMARK))).toBe(false);
        // The file rendered before the confirmation is the same bytes with the same digest, watermark included.
        const again = await storedFile(before.json.version_id as string);
        expect(again.checksum).toBe(beforeFile.checksum);
        expect(createHash('sha256').update(again.bytes).digest('hex')).toBe(beforeFile.checksum);
        expect((await pageTexts(again.bytes)).every((texts) => texts.includes(WATERMARK))).toBe(true);

        expect(await app.count("select count(*) as n from machvon.audit_event where action = 'document_template.confirm_legal' and resource_id = $1", [id])).toBe(1);
        expect(await app.count("select count(*) as n from machvon.audit_event where action = 'document_template.publish' and resource_id = $1", [id])).toBe(1);
        expect(await app.count("select count(*) as n from machvon.audit_event where action = 'document_template.draft' and resource_id = $1", [id])).toBe(1);
        expect(await app.count("select count(*) as n from machvon.outbox_event where aggregate_id = $1 and type in ('doc.template_drafted.v1', 'doc.template_published.v1', 'doc.template_confirmed.v1')", [id])).toBe(3);
      } finally {
        await app.setLayoutConfirmed(false);
      }
    });

    it('keeps the watermark of new renders while the layout profile waits for its confirmation, although the template is confirmed', async () => {
      const live = await liveTemplate({ template_code: 'API-LAYOUT-WAIT' });
      expect((await confirm(live.id, live.version)).status).toBe(200);
      const view = (await detail(live.id)).json;
      expect(view).toMatchObject({ confirmation_status: 'CONFIRMED', layout_confirmation_status: 'PENDING_CONFIRMATION', renders_watermarked: true });
      expect((await render('API-LAYOUT-WAIT')).json).toMatchObject({ watermarked: true });
    });

    it('refuses the drafter, the publisher and a second confirmation of the same revision', async () => {
      // SECOND_LEGAL holds every template permission besides the confirmation of a colleague: a confirmer is never the drafter or the publisher.
      const ownDraft = await draft({ template_code: 'API-CONFIRM-SOD-DRAFTER' }, SECOND_LEGAL);
      const ownId = ownDraft.json.resource_id as string;
      expect((await publish(ownId, 1, AUTHOR)).status).toBe(200);
      const drafter = await confirm(ownId, 2, SECOND_LEGAL);
      expect([drafter.status, drafter.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await detail(ownId)).json).toMatchObject({ confirmation_status: 'PENDING_CONFIRMATION', version: 2 });

      const created = await draft({ template_code: 'API-CONFIRM-SOD-PUBLISHER' });
      const id = created.json.resource_id as string;
      expect((await publish(id, 1, SECOND_LEGAL)).status).toBe(200);
      const publisher = await confirm(id, 2, SECOND_LEGAL);
      expect([publisher.status, publisher.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await confirm(id, 2, LEGAL)).status).toBe(200);
      const second = await confirm(id, 3, SECOND_LEGAL);
      expect([second.status, second.json.code]).toEqual([409, 'TEMPLATE_STATE_INVALID']);
    });

    it('needs an evidence document of the tenant and a published revision, and takes the version that was read', async () => {
      const created = await draft({ template_code: 'API-CONFIRM-STATE' });
      const id = created.json.resource_id as string;
      const early = await confirm(id, 1);
      expect([early.status, early.json.code]).toEqual([409, 'TEMPLATE_STATE_INVALID']);
      await publish(id, 1);
      const unknownEvidence = await confirm(id, 2, LEGAL, { evidence_document_id: randomUUID() });
      expect([unknownEvidence.status, unknownEvidence.json.code, unknownEvidence.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'evidence_document_id']);
      const stale = await confirm(id, 1);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const noMatch = await app.call('POST', `/document-templates/${id}/legal-confirmation`, { member: LEGAL, body: { legal_confirmation_ref: 'CXN-10', evidence_document_id: app.evidenceDocumentId } });
      expect(noMatch.status).toBe(428);
      const withNote = await confirm(id, 2, LEGAL, { note: ' checked against the gazette ' });
      expect(withNote.status).toBe(200);
      expect((await detail(id)).json.legal_confirmation_note).toBe('checked against the gazette');
    });

    it('lets only the holder of each permission take each step', async () => {
      const created = await draft({ template_code: 'API-PERMISSIONS' });
      const id = created.json.resource_id as string;
      for (const member of [AUTHOR, LEGAL, READER, RENDERER, NOBODY]) {
        const reply = await draft({}, member);
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      for (const member of [LEGAL, READER, RENDERER, NOBODY]) {
        const reply = await publish(id, 1, member);
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      for (const member of [AUTHOR, LEGAL, READER, NOBODY]) {
        const reply = await retire(id, 1, member);
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      for (const member of [ADMIN, AUTHOR, READER, RENDERER, NOBODY]) {
        const reply = await confirm(id, 1, member);
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      for (const member of [RENDERER, NOBODY]) {
        expect((await app.call('GET', '/document-templates', { member })).status).toBe(403);
        expect((await detail(id, member)).status).toBe(403);
      }
      expect((await detail(id)).json).toMatchObject({ status: 'DRAFT', version: 1 });
    });
  });

  describe('the scope of the library', () => {
    it('keeps every step of the library from a grant on a branch of the tree: the templates belong to the whole tenant (DOC 2)', async () => {
      const own = await draft({ template_code: 'API-BRANCH-SCOPE' });
      expect(own.status).toBe(200);
      const id = own.json.resource_id as string;
      const drafted = await draft({}, BRANCH);
      expect([drafted.status, drafted.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const published = await publish(id, 1, BRANCH);
      expect([published.status, published.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await publish(id, 1)).status).toBe(200);
      const confirmed = await confirm(id, 2, BRANCH);
      expect([confirmed.status, confirmed.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const retired = await retire(id, 2, BRANCH);
      expect([retired.status, retired.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await detail(id)).json).toMatchObject({ status: 'PUBLISHED', confirmation_status: 'PENDING_CONFIRMATION', version: 2 });
    });
  });

  describe('effective dating (AC-ST-DOC-006-2)', () => {
    it('AC-ST-DOC-006-2: renders each date from the revision in force, refuses an overlapping revision, and keeps what was rendered', async () => {
      const code = 'DOC-CV-GIAI-TRINH-T';
      const rev1 = await draft({ template_code: code, effective_from: '2026-01-01', effective_until: '2027-01-01', title: 'Revision one' });
      const rev2 = await draft({ template_code: code, effective_from: '2027-01-01', title: 'Revision two' });
      const ids = [rev1.json.resource_id as string, rev2.json.resource_id as string];
      expect([rev1.json.revision, rev2.json.revision]).toEqual([1, 2]);
      for (const id of ids) expect((await publish(id, 1)).status).toBe(200);

      const onLastDay = await render(code, '2026-12-31');
      const onFirstDay = await render(code, '2027-01-01');
      const first = await storedFile(onLastDay.json.version_id as string);
      const second = await storedFile(onFirstDay.json.version_id as string);
      expect(first.templateId).toBe(ids[0]);
      expect(second.templateId).toBe(ids[1]);

      const rev3 = await draft({ template_code: code, effective_from: '2027-03-01', effective_until: '2027-12-31', title: 'Revision three' });
      expect(rev3.status).toBe(200);
      const overlap = await publish(rev3.json.resource_id as string, 1);
      expect([overlap.status, overlap.json.code]).toEqual([409, 'TEMPLATE_RANGE_OVERLAP']);
      expect((await detail(rev3.json.resource_id as string)).json).toMatchObject({ status: 'DRAFT', version: 1 });

      // A document made with revision 1 keeps its template and its file when that revision is retired.
      expect((await retire(ids[0] as string, 2)).status).toBe(200);
      const kept = await storedFile(onLastDay.json.version_id as string);
      expect(kept).toMatchObject({ templateId: ids[0], checksum: first.checksum });
      const gone = await render(code, '2026-12-31');
      expect([gone.status, gone.json.code]).toEqual([422, 'TEMPLATE_NOT_EFFECTIVE']);
      expect((await render(code, '2027-06-01')).status).toBe(200);
    });

    it('lets an open-ended revision take over from the one in force and says so in the audit trail', async () => {
      const code = 'API-TAKEOVER';
      const first = await draft({ template_code: code, effective_from: '2026-01-01' });
      const second = await draft({ template_code: code, effective_from: '2026-07-01' });
      await publish(first.json.resource_id as string, 1);
      expect((await publish(second.json.resource_id as string, 1)).status).toBe(200);
      const earlier = (await detail(first.json.resource_id as string)).json;
      expect(earlier).toMatchObject({ status: 'PUBLISHED', effective_until: '2026-07-01', version: 3 });
      expect(await app.count("select count(*) as n from machvon.audit_event where action = 'document_template.publish' and resource_id = $1 and safe_diff::text like '%closed_revisions%'", [second.json.resource_id])).toBe(1);
      const backdated = await draft({ template_code: code, effective_from: '2026-03-01' });
      const refused = await publish(backdated.json.resource_id as string, 1);
      expect([refused.status, refused.json.code]).toEqual([409, 'TEMPLATE_RANGE_OVERLAP']);
    });
  });

  describe('the platform pack waiting for confirmation (AC-ST-DOC-006-3)', () => {
    it('AC-ST-DOC-006-3: a pack template waiting for confirmation renders with the watermark on every page and the library shows its CXN label', async () => {
      const loaded = await app.loadPack();
      expect(loaded.inserted).toContain('MNE-TT44-M02');
      expect(loaded.skipped).toEqual([]);
      const long = { ...PAYLOAD, period: 'First half of 2026', subject: 'Subject', body: 'Monitoring finding. '.repeat(700) };
      const rendered = await render('MNE-TT44-M02', '2026-10-22', long);
      expect(rendered.status).toBe(200);
      expect(rendered.json.watermarked).toBe(true);
      expect(rendered.json.page_count as number).toBeGreaterThan(1);
      const file = await storedFile(rendered.json.version_id as string);
      const pages = await pageTexts(file.bytes);
      expect(pages).toHaveLength(rendered.json.page_count as number);
      expect(pages.every((texts) => texts.includes('CHƯA XÁC NHẬN PHÁP LÝ [CXN-10]'))).toBe(true);

      const listed = await app.call('GET', '/document-templates?group_code=REPORT_MONITORING&as_of_date=2026-10-22', { member: READER });
      const items = (listed.json.items as Array<Record<string, unknown>>).filter((item) => item.origin === 'PLATFORM_PACK');
      expect(items.map((item) => item.template_code)).toEqual(['MNE-CV3665-WEEKLY', 'MNE-TT44-M02', 'MNE-TT44-M03', 'MNE-TT44-M04', 'MNE-TT44-M05', 'MNE-TT44-M06', 'MNE-TT44-M07', 'MNE-TT44-M08', 'MNE-TT44-M09', 'MNE-TT44-M10']);
      // The weekly quick report waits for CXN-11 (CV 3665), the monitoring reports of Circular 44 for CXN-10.
      expect(items[0]).toMatchObject({ template_code: 'MNE-CV3665-WEEKLY', cxn_refs: ['CXN-11'], watermark_text: 'CHƯA XÁC NHẬN PHÁP LÝ [CXN-11]', form_code: 'CV3665-WEEKLY', confirmation_status: 'PENDING_CONFIRMATION' });
      expect(items[1]).toMatchObject({
        confirmation_status: 'PENDING_CONFIRMATION',
        cxn_refs: ['CXN-10'],
        watermark_text: 'CHƯA XÁC NHẬN PHÁP LÝ [CXN-10]',
        form_code: 'M02',
        origin: 'PLATFORM_PACK',
        pack_version: '2026.10.1',
        status: 'PUBLISHED',
        renders_watermarked: true,
      });
      expect(items[1]).not.toHaveProperty('body_blocks');
    });

    it('loads the pack once: a second load changes nothing', async () => {
      const before = await app.count('select count(*) as n from machvon.document_template');
      const again = await app.loadPack();
      expect(again.inserted).toEqual([]);
      expect(again.unchanged.length).toBeGreaterThan(20);
      expect(await app.count('select count(*) as n from machvon.document_template')).toBe(before);
    });

    it('lets the legal officer confirm a pack template without a drafter or publisher of their own, and the label disappears', async () => {
      const [row] = await app.harness.owner<{ id: string; version: string }>(TENANT_A, [["select id, version::text as version from machvon.document_template where template_code = 'DOC-CV-BAO-CAO-VUONG-MAC'"]]);
      const confirmed = await confirm(row?.id ?? '', Number(row?.version), LEGAL, { legal_confirmation_ref: 'CXN-ND30-OK' });
      expect(confirmed.status).toBe(200);
      const view = (await detail(row?.id ?? '')).json;
      expect(view).toMatchObject({ confirmation_status: 'CONFIRMED', legal_confirmation_ref: 'CXN-ND30-OK', cxn_refs: [], approved_by: null });
    });
  });

  describe('validation and idempotency', () => {
    it('answers a missing legal basis with LEGAL_BASIS_REQUIRED and a malformed body with the general problems', async () => {
      const noBasis = await draft({ legal_basis: '' });
      expect([noBasis.status, noBasis.json.code, noBasis.json.detail]).toEqual([422, 'LEGAL_BASIS_REQUIRED', 'legal_basis']);
      const blankBasis = await draft({ legal_basis: '   ' });
      expect([blankBasis.status, blankBasis.json.code]).toEqual([422, 'LEGAL_BASIS_REQUIRED']);
      const withoutBasis = Object.fromEntries(Object.entries(templateBody()).filter(([field]) => field !== 'legal_basis'));
      const absent = await app.call('POST', '/document-templates', { member: ADMIN, body: withoutBasis });
      expect([absent.status, absent.json.code]).toEqual([422, 'LEGAL_BASIS_REQUIRED']);
      const extra = await draft({ approved_by: memberId(AUTHOR) });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const list = await draft({ body_blocks: BLOCKS.blocks });
      expect([list.status, list.json.code]).toEqual([400, 'INVALID_REQUEST']);
      const wrapped = await draft({ body_blocks: { blocks: [], other: 1 } });
      expect([wrapped.status, wrapped.json.code, wrapped.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'body_blocks']);
      const empty = await draft({ body_blocks: { blocks: [] } });
      expect([empty.status, empty.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const bad = await draft({ placeholder_schema: { required: ['title', 'missing_in_body'] } });
      expect([bad.status, bad.json.code]).toEqual([422, 'PLACEHOLDER_SCHEMA_INVALID']);
      const lower = await draft({ template_code: 'lower-case-code' });
      expect([lower.status, lower.json.code, lower.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'template_code']);
      const profile = await draft({ layout_profile_id: randomUUID() });
      expect([profile.status, profile.json.code]).toEqual([422, 'PROFILE_NOT_PUBLISHED']);
      const range = await draft({ effective_from: '2026-05-01', effective_until: '2026-05-01' });
      expect([range.status, range.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('refuses a second template that takes a form code, and replays a retried draft without a second revision', async () => {
      const first = await draft({ template_code: 'API-FORM-A', form_code: '77.a/TT' });
      expect(first.status).toBe(200);
      const clash = await draft({ template_code: 'API-FORM-B', form_code: '77.a/TT' });
      expect([clash.status, clash.json.code]).toEqual([409, 'FORM_CODE_DUPLICATE']);
      const body = templateBody({ template_code: 'API-REPLAY' });
      const key = `replay-${randomUUID()}`;
      const one = await app.call('POST', '/document-templates', { member: ADMIN, body, key });
      const two = await app.call('POST', '/document-templates', { member: ADMIN, body, key });
      expect(two.json).toEqual(one.json);
      expect(two.headers.get('idempotency-replayed')).toBe('true');
      expect(await app.count("select count(*) as n from machvon.document_template where template_code = 'API-REPLAY'")).toBe(1);
    });

    it('retires a draft or a published revision with a reason, once', async () => {
      const created = await draft({ template_code: 'API-RETIRE' });
      const id = created.json.resource_id as string;
      const short = await retire(id, 1, ADMIN, 'too short');
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const retired = await retire(id, 1);
      expect(retired.json).toMatchObject({ status: 'RETIRED', resource_version: 2 });
      const row = (await detail(id)).json;
      expect(row).toMatchObject({ status: 'RETIRED', retirement_reason: 'The form was withdrawn by its issuer' });
      expect(typeof row.retired_at).toBe('string');
      const again = await retire(id, 2);
      expect([again.status, again.json.code]).toEqual([409, 'TEMPLATE_STATE_INVALID']);
      const publishRetired = await publish(id, 2);
      expect([publishRetired.status, publishRetired.json.code]).toEqual([409, 'TEMPLATE_STATE_INVALID']);
      expect(await app.count("select count(*) as n from machvon.audit_event where action = 'document_template.retire' and resource_id = $1 and reason is not null", [id])).toBe(1);
    });
  });

  describe('reading', () => {
    it('lists with filters and pages, and refuses malformed parameters', async () => {
      for (const n of [1, 2, 3]) await draft({ template_code: `API-LIST-${n}`, group_code: 'TREASURY_FORM' });
      const all = await app.call('GET', '/document-templates?group_code=TREASURY_FORM', { member: READER });
      const codes = (all.json.items as Array<{ template_code: string }>).map((item) => item.template_code);
      expect(codes).toEqual(expect.arrayContaining(['API-LIST-1', 'API-LIST-2', 'API-LIST-3']));
      const first = await app.call('GET', '/document-templates?group_code=TREASURY_FORM&limit=2', { member: READER });
      expect((first.json.items as unknown[]).length).toBe(2);
      expect(typeof first.json.next_cursor).toBe('string');
      const second = await app.call('GET', `/document-templates?group_code=TREASURY_FORM&limit=2&cursor=${String(first.json.next_cursor)}`, { member: READER });
      const firstCodes = (first.json.items as Array<{ template_code: string }>).map((item) => item.template_code);
      const secondCodes = (second.json.items as Array<{ template_code: string }>).map((item) => item.template_code);
      expect(secondCodes[0]).not.toBe(firstCodes[1]);
      expect(secondCodes.every((code) => !firstCodes.includes(code))).toBe(true);
      const drafts = await app.call('GET', '/document-templates?status=DRAFT&group_code=TREASURY_FORM', { member: READER });
      expect((drafts.json.items as Array<{ status: string }>).every((item) => item.status === 'DRAFT')).toBe(true);
      const future = await app.call('GET', '/document-templates?group_code=TREASURY_FORM&as_of_date=2025-01-01', { member: READER });
      expect(future.json.items).toEqual([]);
      for (const query of ['group_code=NOPE', 'status=NOPE', 'as_of_date=2026-02-30', 'as_of_date=today', 'limit=0', 'cursor=%21%21', `cursor=${Buffer.from(JSON.stringify(['no-revision', randomUUID()])).toString('base64url')}`]) {
        const reply = await app.call('GET', `/document-templates?${query}`, { member: READER });
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
    });

    it('shows the detail with the body, the history of the code and who did what', async () => {
      const code = 'API-DETAIL';
      const first = await draft({ template_code: code });
      const second = await draft({ template_code: code, effective_from: '2027-01-01' });
      const view = (await detail(second.json.resource_id as string)).json;
      expect(view).toMatchObject({
        template_code: code,
        revision: 2,
        body_blocks: BLOCKS,
        placeholder_schema: { required: ['title', 'body'] },
        created_by: memberId(ADMIN),
        approved_by: null,
        legal_confirmed_by: null,
        published_at: null,
        cxn_refs: ['CXN-10'],
      });
      expect(view.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((view.revisions as Array<{ id: string; revision: number }>).map((revision) => [revision.id, revision.revision])).toEqual([
        [first.json.resource_id, 1],
        [second.json.resource_id, 2],
      ]);
      const missing = await detail(randomUUID());
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await app.call('GET', '/document-templates/not-a-uuid', { member: READER })).status).toBe(422);
    });

    it('keeps the library of a tenant out of reach of another tenant', async () => {
      const mine = await draft({ template_code: 'API-TENANT-A-ONLY' });
      const id = mine.json.resource_id as string;
      expect((await detail(id, ADMIN, TENANT_B)).status).toBe(404);
      const listed = await app.call('GET', '/document-templates', { member: ADMIN, tenantId: TENANT_B });
      expect((listed.json.items as Array<{ template_code: string }>).some((item) => item.template_code === 'API-TENANT-A-ONLY')).toBe(false);
      const foreign = [
        await app.call('POST', `/document-templates/${id}/publish`, { member: ADMIN, tenantId: TENANT_B, ifMatch: '"1"' }),
        await app.call('POST', `/document-templates/${id}/retirement`, { member: ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: 'Isolation foreign retire' } }),
        await app.call('POST', `/document-templates/${id}/legal-confirmation`, { member: ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: { legal_confirmation_ref: 'CXN-10', evidence_document_id: app.evidenceDocumentId } }),
      ];
      for (const reply of foreign) expect([reply.status, reply.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await detail(id)).json).toMatchObject({ status: 'DRAFT', version: 1 });
    });
  });
});
