import { ND30_A4_STANDARD } from '@machvon/kernel';
import { BLOCKS } from './template-app';
import { ADMIN, AUTHOR, BRANCH, NOBODY, READER, RENDERER, SECOND_LEGAL, TENANT_A, TENANT_B, TemplateApp } from './template-app';
import type { Reply } from './template-app';

jest.setTimeout(120_000);

const app = new TemplateApp();
const owner = <T extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<T[]> => app.harness.owner<T>(tenant, [[sql, params]]);
const clone = <R>(value: unknown): R => JSON.parse(JSON.stringify(value)) as R;
let counter = 0;
/** The day before today: a revision that starts then is the one in force now. */
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** The body of a revision as a case edits it: the members it reaches into are typed, the rest is whatever the contract carries. */
interface Draft {
  margins_mm: Record<string, unknown>;
  element_styles: Record<string, Record<string, unknown> | undefined>;
  signature_layout: Record<string, Record<string, unknown> | undefined>;
  number_field_layout: Record<string, unknown>;
  [member: string]: unknown;
}

/** Sets a member of a part of the body that the case reaches into. */
function put(target: Record<string, unknown> | undefined, member: string, value: unknown): void {
  if (target === undefined) throw new Error(`no part to put ${member} into`);
  target[member] = value;
}

/** The body of a revision of the default profile, with the changes a case makes. */
function body(change: (draft: Draft) => void = () => undefined, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  const draft: Draft = {
    profile_code: `UAT-LAYOUT-${counter}`,
    margins_mm: clone(ND30_A4_STANDARD.marginsMm),
    font_family: ND30_A4_STANDARD.fontFamily,
    font_substitute: ND30_A4_STANDARD.fontSubstitute,
    element_styles: clone(ND30_A4_STANDARD.elementStyles),
    signature_layout: clone(ND30_A4_STANDARD.signatureLayout),
    number_field_layout: clone(ND30_A4_STANDARD.numberFieldLayout),
    watermark_policy: { text: 'CHO XAC NHAN' },
    legal_basis: 'Nghi dinh 30/2020/ND-CP, Phu luc I',
    effective_from: '2027-01-01',
  };
  change(draft);
  return { ...draft, ...overrides };
}

const create = (payload: Record<string, unknown>, member = ADMIN, tenantId?: string): Promise<Reply> => app.call('POST', '/document-layout-profiles', { member, body: payload, ...(tenantId === undefined ? {} : { tenantId }) });
const publish = (id: string, version: number, member = AUTHOR): Promise<Reply> => app.call('POST', `/document-layout-profiles/${id}/publish`, { member, ifMatch: `"${version}"` });
const detail = (id: string, member = READER, tenantId?: string): Promise<Reply> => app.call('GET', `/document-layout-profiles/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const rows = (code: string): Promise<Array<{ revision: number; status: string }>> => owner('select revision, status from machvon.document_layout_profile where profile_code = $1 order by revision', [code]);

describe('layout profile governance (ST-DOC-016)', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);

  describe('AC-ST-DOC-016-1 / UAT-AC415: the legal ranges of Appendix I', () => {
    it('drafts a revision of the default profile, with the values of BR-DOC-13, as revision 1 of its code, and shows it', async () => {
      const payload = body();
      const made = await create(payload);
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1, revision: 1 } });
      const shown = await detail(made.json.resource_id as string);
      expect(shown.json).toMatchObject({
        profile_code: payload.profile_code,
        revision: 1,
        status: 'DRAFT',
        confirmation_status: 'PENDING_CONFIRMATION',
        margins_mm: ND30_A4_STANDARD.marginsMm,
        font_substitute: 'Tinos',
        effective_from: '2027-01-01',
        effective_until: null,
        approved_by: null,
      });
      expect((shown.json.signature_layout as { sealBox: unknown }).sealBox).toEqual(ND30_A4_STANDARD.signatureLayout.sealBox);
    });

    it('AC-ST-DOC-016-1: a margin of 18 mm is 422 LAYOUT_OUT_OF_LEGAL_RANGE and no revision is created', async () => {
      const payload = body((draft) => put(draft.margins_mm, 'top', 18));
      const refused = await create(payload);
      expect(refused).toMatchObject({ status: 422, json: { code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail: 'marginsMm.top' } });
      expect(await rows(payload.profile_code as string)).toEqual([]);
    });

    it.each([
      ['a margin on the left of 36 mm', (draft: Draft) => put(draft.margins_mm, 'left', 36), 'marginsMm.left'],
      ['a margin on the right of 14 mm', (draft: Draft) => put(draft.margins_mm, 'right', 14), 'marginsMm.right'],
      ['a body of 16 pt', (draft: Draft) => put(draft.element_styles.body, 'sizePt', 16), 'elementStyles.body.sizePt'],
      ['a national title of 14 pt', (draft: Draft) => put(draft.element_styles.nationalTitle, 'sizePt', 14), 'elementStyles.nationalTitle.sizePt'],
      ['a seal that does not meet the signature', (draft: Draft) => put(draft.signature_layout.sealBox, 'xMm', 10), 'signatureLayout.sealBox'],
      ['a seal that covers half of the signature', (draft: Draft) => put(draft.signature_layout.sealBox, 'widthMm', 60), 'signatureLayout.sealBox'],
      ['a seal that is beside the signature, not over it', (draft: Draft) => put(draft.signature_layout.sealBox, 'yMm', 0), 'signatureLayout.sealBox'],
      ['both boxes of the signature moved off the page', (draft: Draft) => { put(draft.signature_layout.leaderBox, 'yMm', 400); put(draft.signature_layout.sealBox, 'yMm', 410); }, 'signatureLayout.leaderBox'],
      ['a box of the number fields that is not on the page', (draft: Draft) => put(draft.number_field_layout, 'date', { xMm: 300, yMm: 50, widthMm: 60, heightMm: 6 }), 'numberFieldLayout.date'],
      ['a seal that has no height', (draft: Draft) => put(draft.signature_layout.sealBox, 'heightMm', 0), 'signatureLayout.sealBox'],
    ])('refuses %s', async (_label, change, detailName) => {
      const payload = body(change);
      expect(await create(payload)).toMatchObject({ status: 422, json: { code: 'LAYOUT_OUT_OF_LEGAL_RANGE', detail: detailName } });
      expect(await rows(payload.profile_code as string)).toEqual([]);
    });

    it('refuses a body that is not a profile (422 VALIDATION_FAILED), a legal basis that is blank (422 LEGAL_BASIS_REQUIRED) and a code or a day that is not one', async () => {
      expect(await create(body((draft) => (draft.margins_mm = { ...draft.margins_mm, left: '30' })))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'margins_mm' } });
      expect(await create(body((draft) => put(draft.element_styles, 'body', 7)))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'element_styles.body' } });
      expect(await create(body(() => undefined, { legal_basis: '    ' }))).toMatchObject({ status: 422, json: { code: 'LEGAL_BASIS_REQUIRED' } });
      expect(await create(body(() => undefined, { legal_basis: 'x'.repeat(2001) }))).toMatchObject({ status: 422, json: { detail: 'legal_basis' } });
      expect(await create(body(() => undefined, { profile_code: 'lower case' }))).toMatchObject({ status: 422, json: { detail: 'profile_code' } });
      expect(await create(body(() => undefined, { effective_from: '2027-02-30' }))).toMatchObject({ status: 422, json: { detail: 'effective_from' } });
      expect(await create(body(() => undefined, { effective_until: '2026-12-31' }))).toMatchObject({ status: 422, json: { detail: 'effective_until' } });
      expect(await create(body(() => undefined, { effective_until: '2027-13-01' }))).toMatchObject({ status: 422, json: { detail: 'effective_until' } });
      expect(await create(body(() => undefined, { font_family: ' ' }))).toMatchObject({ status: 422, json: { detail: 'font_family' } });
      expect(await create(body(() => undefined, { legal_confirmation_ref: 'x'.repeat(51) }))).toMatchObject({ status: 422, json: { detail: 'legal_confirmation_ref' } });
    });

    it('numbers the revisions of a code one after the other', async () => {
      const first = body();
      expect((await create(first)).json.revision).toBe(1);
      const second = await create({ ...first, effective_from: '2028-01-01', legal_confirmation_ref: '  CXN-DOC-01  ' });
      expect(second.json.revision).toBe(2);
      expect((await detail(second.json.resource_id as string)).json.legal_confirmation_ref).toBe('CXN-DOC-01');
      expect(await rows(first.profile_code as string)).toEqual([
        { revision: 1, status: 'DRAFT' },
        { revision: 2, status: 'DRAFT' },
      ]);
    });
  });

  describe('publishing', () => {
    it('is the step of someone else (403 SELF_APPROVAL_DENIED); the revision then takes over from the open-ended one before it, which ends on the day the new one starts', async () => {
      const code = `UAT-PUB-${(counter += 1)}`;
      // The drafter who also holds the right to publish is still not the one who publishes their own draft.
      const first = await create(body(() => undefined, { profile_code: code, effective_from: '2027-01-01' }), SECOND_LEGAL);
      const firstId = first.json.resource_id as string;
      expect(await publish(firstId, 1, SECOND_LEGAL)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await publish(firstId, 1, ADMIN)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await detail(firstId)).json).toMatchObject({ status: 'DRAFT', approved_by: null });
      expect(await publish(firstId, 5)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await publish(firstId, 1)).toMatchObject({ status: 200, json: { status: 'PUBLISHED', resource_version: 2 } });
      expect((await detail(firstId)).json).toMatchObject({ status: 'PUBLISHED', effective_until: null });
      expect(await publish(firstId, 2)).toMatchObject({ status: 409, json: { code: 'LAYOUT_STATE_INVALID' } });

      const second = await create(body(() => undefined, { profile_code: code, effective_from: '2028-01-01' }));
      expect(await publish(second.json.resource_id as string, 1)).toMatchObject({ status: 200, json: { status: 'PUBLISHED' } });
      expect((await detail(firstId)).json).toMatchObject({ status: 'PUBLISHED', effective_until: '2028-01-01', version: 3 });
      const [audit] = await owner<{ safe_diff: { closed_revisions: Array<{ revision: number; effective_until: string }> } }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'document_layout_profile.publish'", [second.json.resource_id]);
      expect(audit?.safe_diff.closed_revisions).toEqual([expect.objectContaining({ revision: 1, effective_until: '2028-01-01' })]);
      const [event] = await owner<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'doc.layout_published.v1'", [second.json.resource_id]);
      expect(event?.payload).toMatchObject({ profile_code: code, revision: 2, effective_from: '2028-01-01' });
    });

    it('is 409 TEMPLATE_RANGE_OVERLAP when a closed period would overlap a published revision, or a revision would start before one that is published', async () => {
      const code = `UAT-OVL-${(counter += 1)}`;
      const base = await create(body(() => undefined, { profile_code: code, effective_from: '2027-06-01' }));
      expect((await publish(base.json.resource_id as string, 1)).status).toBe(200);
      const closed = await create(body(() => undefined, { profile_code: code, effective_from: '2027-09-01', effective_until: '2027-12-31' }));
      expect(await publish(closed.json.resource_id as string, 1)).toMatchObject({ status: 409, json: { code: 'TEMPLATE_RANGE_OVERLAP' } });
      const earlier = await create(body(() => undefined, { profile_code: code, effective_from: '2027-01-01' }));
      expect(await publish(earlier.json.resource_id as string, 1)).toMatchObject({ status: 409, json: { code: 'TEMPLATE_RANGE_OVERLAP' } });
      expect((await detail(closed.json.resource_id as string)).json.status).toBe('DRAFT');
      expect((await detail(base.json.resource_id as string)).json).toMatchObject({ status: 'PUBLISHED', effective_until: null });
    });
  });

  describe('a new revision of the layout of a profile that templates stand on', () => {
    it('makes the layout of the template count as unconfirmed while the revision in force is not confirmed, so that a document rendered on either is issued under the override of BR-DOC-10', async () => {
      const layoutOf = async (): Promise<string | undefined> => {
        const items = (await app.call('GET', '/document-templates?limit=200', { member: READER })).json.items as Array<{ template_code: string; layout_confirmation_status: string }>;
        return items.find((entry) => entry.template_code === 'QD-DEFAULT')?.layout_confirmation_status;
      };
      await app.setLayoutConfirmed(true);
      try {
        expect(await layoutOf()).toBe('CONFIRMED');
        const made = await create(body(() => undefined, { profile_code: 'ND30_A4_STANDARD', effective_from: YESTERDAY }));
        expect(made.status).toBe(200);
        expect((await publish(made.json.resource_id as string, 1)).status).toBe(200);
        // The revision that took over waits for its confirmation: the layout of the template no longer counts as confirmed.
        expect(await layoutOf()).toBe('PENDING_CONFIRMATION');
        // A document may have been rendered on the revision that waited: a later revision that is confirmed does not make the layout confirmed while that one is not.
        const later = await create(body(() => undefined, { profile_code: 'ND30_A4_STANDARD', effective_from: new Date().toISOString().slice(0, 10) }));
        expect(later.status).toBe(200);
        expect((await publish(later.json.resource_id as string, 1)).status).toBe(200);
        await owner("update machvon.document_layout_profile set confirmation_status = 'CONFIRMED', legal_confirmation_ref = 'CXN-DOC-01' where id = $1", [later.json.resource_id]);
        expect(await layoutOf()).toBe('PENDING_CONFIRMATION');
        await app.setLayoutConfirmed(true);
        expect(await layoutOf()).toBe('CONFIRMED');
      } finally {
        await app.setLayoutConfirmed(false);
      }
    });

    it('is the layout of the render of a date from the day it takes over: the template stays as it is, the render of the days before keeps the old revision, and no render is refused', async () => {
      const render = (asOf: string): Promise<Reply> => app.call('POST', '/document-renders', { member: RENDERER, body: { template_code: 'QD-DEFAULT', as_of_date: asOf, payload: { title: 'Decision', body: 'The body.', agency: 'Project board', place: 'Cao Bang' } } });
      const before = await render('2026-10-23');
      expect(before.status).toBe(200);
      const made = await create(body(() => undefined, { profile_code: 'ND30_A4_STANDARD', effective_from: '2027-01-01' }));
      expect(made.status).toBe(200);
      expect((await publish(made.json.resource_id as string, 1)).status).toBe(200);
      expect((await detail(app.layoutProfileId)).json).toMatchObject({ status: 'PUBLISHED', effective_until: YESTERDAY });
      const during = await render('2026-12-31');
      const after = await render('2027-02-01');
      expect([during.status, after.status]).toEqual([200, 200]);
      // The render of a day before the takeover is the same bytes as before the new revision existed.
      expect((await render('2026-10-23')).json.sha256).toBe(before.json.sha256);
    });
  });

  describe('a template that stands on a later revision of its layout', () => {
    it('is not served by an earlier revision on a date before the revision it stands on starts (422 PROFILE_NOT_PUBLISHED), and is rendered on it from then on', async () => {
      const code = `UAT-BACK-${(counter += 1)}`;
      const first = await create(body(() => undefined, { profile_code: code, effective_from: '2026-01-01' }));
      expect((await publish(first.json.resource_id as string, 1)).status).toBe(200);
      const second = await create(body(() => undefined, { profile_code: code, effective_from: '2027-01-01' }));
      expect((await publish(second.json.resource_id as string, 1)).status).toBe(200);
      const template = await app.call('POST', '/document-templates', {
        member: ADMIN,
        body: {
          template_code: `UAT-BACK-TPL-${counter}`,
          group_code: 'REPORT_MONITORING',
          doc_type_code: 'BC',
          title: 'Report on a later layout',
          layout_profile_id: second.json.resource_id,
          body_blocks: BLOCKS,
          placeholder_schema: { required: ['title', 'body'] },
          legal_basis: 'Circular 44/2026/TT-BTC',
          effective_from: '2026-01-01',
          watermark_text: 'UNCONFIRMED',
        },
      });
      expect(template.status).toBe(200);
      expect((await app.call('POST', `/document-templates/${template.json.resource_id as string}/publish`, { member: AUTHOR, ifMatch: '"1"' })).status).toBe(200);
      const render = (asOf: string): Promise<Reply> =>
        app.call('POST', '/document-renders', { member: RENDERER, body: { template_code: `UAT-BACK-TPL-${counter}`, as_of_date: asOf, payload: { title: 'Report', body: 'The body.', agency: 'Project board', place: 'Cao Bang' } } });
      expect(await render('2026-06-01')).toMatchObject({ status: 422, json: { code: 'PROFILE_NOT_PUBLISHED' } });
      expect((await render('2027-02-01')).status).toBe(200);
    });
  });

  describe('who may do what, and what is shown', () => {
    it('belongs to the whole tenant: a reader or a stranger cannot draft or publish, a grant over a branch does not reach them, and another tenant sees nothing', async () => {
      const payload = body();
      expect(await create(payload, READER)).toMatchObject({ status: 403 });
      expect(await create(payload, NOBODY)).toMatchObject({ status: 403 });
      expect(await create(payload, BRANCH)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      const made = await create(payload);
      const id = made.json.resource_id as string;
      expect(await publish(id, 1, READER)).toMatchObject({ status: 403 });
      expect(await publish(id, 1, BRANCH)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await publish(id, 1, SECOND_LEGAL)).toMatchObject({ status: 200 });
      expect((await detail(id, ADMIN, TENANT_B)).status).toBe(404);
      expect((await app.call('GET', '/document-layout-profiles', { member: ADMIN, tenantId: TENANT_B })).json.items).toEqual([expect.objectContaining({ profile_code: 'ND30_A4_STANDARD' })]);
      expect((await detail('00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
      expect((await app.call('GET', '/document-layout-profiles', { member: NOBODY })).status).toBe(403);
    });

    it('is listed by code and revision a page at a time, narrowed by code and status, and a filter that is not one is 422', async () => {
      const code = `UAT-LST-${(counter += 1)}`;
      for (const from of ['2029-01-01', '2030-01-01', '2031-01-01']) expect((await create(body(() => undefined, { profile_code: code, effective_from: from }))).status).toBe(200);
      const first = await app.call('GET', `/document-layout-profiles?profile_code=${code}&limit=2`, { member: READER });
      expect((first.json.items as Array<{ revision: number }>).map((item) => item.revision)).toEqual([1, 2]);
      const cursor = first.json.next_cursor as string;
      const second = await app.call('GET', `/document-layout-profiles?profile_code=${code}&limit=2&cursor=${encodeURIComponent(cursor)}`, { member: READER });
      expect((second.json.items as Array<{ revision: number }>).map((item) => item.revision)).toEqual([3]);
      expect(second.json.next_cursor).toBeNull();
      expect(((await app.call('GET', `/document-layout-profiles?profile_code=${code}&status=PUBLISHED`, { member: READER })).json.items as unknown[])).toEqual([]);
      expect(await app.call('GET', '/document-layout-profiles?status=SOON', { member: READER })).toMatchObject({ status: 422, json: { detail: 'status' } });
      expect(await app.call('GET', '/document-layout-profiles?cursor=bad', { member: READER })).toMatchObject({ status: 422 });
    });
  });

  describe('the database keeps what the application checked', () => {
    it('does not let a profile outside the legal ranges in, change after it is written, move by itself, or be deleted', async () => {
      const made = await create(body());
      const id = made.json.resource_id as string;
      // The ranges: the same ones, behind the application (the owner role skips the guard of the content, not the constraint).
      await expect(owner("update machvon.document_layout_profile set margins_mm = '{\"top\": 18, \"bottom\": 20, \"left\": 30, \"right\": 15}'::jsonb where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document_layout_profile set signature_layout = jsonb_set(signature_layout, '{sealBox,xMm}', '10') where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document_layout_profile set element_styles = element_styles - 'body' where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document_layout_profile set margins_mm = '{}'::jsonb where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document_layout_profile set signature_layout = jsonb_set(jsonb_set(signature_layout, '{leaderBox,yMm}', '400'), '{sealBox,yMm}', '410') where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document_layout_profile set number_field_layout = jsonb_set(number_field_layout, '{date,xMm}', '300') where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document_layout_profile set number_field_layout = '{}'::jsonb where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document_layout_profile set signature_layout = jsonb_set(signature_layout, '{sealBox,yMm}', '0') where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document_layout_profile set signature_layout = jsonb_set(signature_layout, '{sealBox,heightMm}', '0') where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document_layout_profile set signature_layout = signature_layout #- '{sealBox,yMm}' where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      // The guard of the content, as the application role would meet it.
      const asApp = async (sql: string, params: unknown[]): Promise<string | undefined> => {
        try {
          await app.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: '00000000-0000-4000-8000-000000000001', scopeVersion: 1 }, (tx) => tx.query(sql, params));
          return undefined;
        } catch (error) {
          return (error as { code?: string }).code;
        }
      };
      expect(await asApp("update machvon.document_layout_profile set legal_basis = 'changed' where id = $1::uuid", [id])).toBe('42501');
      expect(await asApp("update machvon.document_layout_profile set status = 'SUPERSEDED' where id = $1::uuid", [id])).toBe('42501');
      expect(await asApp('update machvon.document_layout_profile set approved_by = created_by where id = $1::uuid', [id])).toBe('42501');
      expect(await asApp("update machvon.document_layout_profile set effective_until = date '2099-01-01' where id = $1::uuid", [id])).toBe('42501');
      expect(await asApp('delete from machvon.document_layout_profile where id = $1::uuid', [id])).toBe('42501');
      expect((await detail(id)).json).toMatchObject({ status: 'DRAFT', legal_basis: expect.stringContaining('Nghi dinh') });
    });
  });
});
