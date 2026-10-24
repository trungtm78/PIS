import { randomUUID } from 'node:crypto';
import { DocumentStore } from '../src/document-store';
import { DocumentTemplateStore } from '../src/document-template-store';
import type { NewTemplateRevision, TemplateDetail, TemplatePack } from '../src/document-template-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new DocumentTemplateStore();
const documents = new DocumentStore();

const DRAFTER = 1;
const PUBLISHER = 2;
const LEGAL = 3;
const BLOCKS = [
  { kind: 'heading', text: '{{title}}' },
  { kind: 'paragraph', text: '{{body}}' },
];
const SCHEMA = { required: ['title', 'body'] };

const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; sqlState?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    if (e.status === undefined) return { code: 'DB', status: 0, sqlState: e.code };
    return { code: e.code ?? '', status: e.status, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

let counter = 0;
const profiles: Record<string, string> = {};

function input(tenant: string, overrides: Partial<NewTemplateRevision> = {}): NewTemplateRevision {
  counter += 1;
  return {
    templateCode: `DOC-TEST-${counter}`,
    groupCode: 'DECISION',
    docTypeCode: 'QD',
    title: 'Test template',
    layoutProfileId: profiles[tenant] ?? '',
    bodyBlocks: BLOCKS,
    placeholderSchema: SCHEMA,
    legalBasis: 'Decree 30/2020/ND-CP',
    effectiveFrom: '2026-01-01',
    actor: memberId(DRAFTER),
    ...overrides,
  };
}

const draft = (overrides: Partial<NewTemplateRevision> = {}, tenant = TENANT_A): Promise<TemplateDetail> => as(DRAFTER, (tx) => store.create(tx, input(tenant, overrides)), tenant);
const publish = (record: { id: string; version: number }, member = PUBLISHER, tenant = TENANT_A) => as(member, (tx) => store.publish(tx, record.id, record.version, memberId(member)), tenant);
const published = async (overrides: Partial<NewTemplateRevision> = {}, tenant = TENANT_A): Promise<TemplateDetail> => (await publish(await draft(overrides, tenant), PUBLISHER, tenant)).record;

let evidenceId = '';
const confirm = (record: { id: string; version: number }, member = LEGAL, reference = 'CXN-10', evidence = evidenceId) =>
  as(member, (tx) => store.confirmLegalBasis(tx, record.id, record.version, { reference, evidenceDocumentId: evidence }, memberId(member)));

describe('DocumentTemplateStore (template library with separated legal confirmation, ST-DOC-006)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const member of [DRAFTER, PUBLISHER, LEGAL]) await harness.seedMembership(tenant, member, 1);
      const seeded = await harness.tenants.withTenant(contextFor(tenant, memberId(DRAFTER)), (tx) => documents.seedDefaults(tx, memberId(DRAFTER)));
      profiles[tenant] = seeded.layoutProfileId;
    }
    evidenceId = (await as(LEGAL, (tx) => documents.insertDocument(tx, { docKind: 'REFERENCE', docTypeCode: 'QD', title: 'Legal opinion', classification: 'INTERNAL', createdBy: memberId(LEGAL) }))).id;
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('drafting a revision', () => {
    it('drafts a revision of the tenant, waiting for confirmation with the watermark of its layout profile, and numbers the next one', async () => {
      const first = await draft({ templateCode: 'DOC-DRAFTING' });
      expect(first).toMatchObject({
        revision: 1,
        status: 'DRAFT',
        origin: 'TENANT',
        confirmationStatus: 'PENDING_CONFIRMATION',
        packVersion: null,
        version: 1,
        approvedBy: null,
        legalConfirmedBy: null,
        layoutConfirmationStatus: 'PENDING_CONFIRMATION',
        createdBy: memberId(DRAFTER),
      });
      expect(first.watermarkText).toBe('CHO XÁC NHẬN');
      expect(first.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      const second = await draft({ templateCode: 'DOC-DRAFTING', watermarkText: 'Not confirmed [CXN-99]', title: 'Second revision' });
      expect(second).toMatchObject({ revision: 2, watermarkText: 'Not confirmed [CXN-99]' });
      expect((await as(DRAFTER, (tx) => store.revisionsOf(tx, 'DOC-DRAFTING'))).map((row) => row.revision)).toEqual([1, 2]);
    });

    it('does not let a draft be rendered: templateFor only sees published revisions', async () => {
      const created = await draft({ templateCode: 'DOC-DRAFT-HIDDEN' });
      expect(created.status).toBe('DRAFT');
      await expect(as(DRAFTER, (tx) => documents.templateFor(tx, { templateCode: 'DOC-DRAFT-HIDDEN' }, '2026-06-01'))).rejects.toMatchObject({ code: 'TEMPLATE_NOT_EFFECTIVE' });
    });

    it('keeps the reference a drafter proposes without confirming anything', async () => {
      const created = await draft({ legalConfirmationRef: ' CXN-10 ' });
      expect(created).toMatchObject({ legalConfirmationRef: 'CXN-10', confirmationStatus: 'PENDING_CONFIRMATION', legalConfirmedBy: null });
    });

    it('refuses a missing legal basis, a bad code, group, dates and text, each naming the field', async () => {
      expect(await refusal(draft({ legalBasis: '   ' }))).toEqual({ code: 'LEGAL_BASIS_REQUIRED', status: 422, detail: 'legal_basis' });
      expect(await refusal(draft({ templateCode: 'lower case' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'template_code' });
      expect(await refusal(draft({ groupCode: 'NOPE' as never }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'group_code' });
      expect(await refusal(draft({ effectiveFrom: '2026-02-30' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_from' });
      expect(await refusal(draft({ effectiveUntil: '2026-01-01' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
      expect(await refusal(draft({ effectiveFrom: '2026-13-01' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_from' });
      expect(await refusal(draft({ legalBasis: 'x'.repeat(2001) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'legal_basis' });
      expect(await refusal(draft({ title: ' ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'title' });
      expect(await refusal(draft({ watermarkText: 'ab' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'watermark_text' });
    });

    it('refuses a body or a placeholder schema the renderer could not use', async () => {
      expect(await refusal(draft({ bodyBlocks: [] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'body_blocks' });
      expect(await refusal(draft({ bodyBlocks: 'text' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'body_blocks' });
      expect(await refusal(draft({ bodyBlocks: [{ kind: 'image', text: 'x' }] }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(draft({ bodyBlocks: [{ kind: 'paragraph', text: 'x', extra: 1 }] }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(draft({ bodyBlocks: [{ kind: 'paragraph', text: '   ' }] }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(draft({ bodyBlocks: [{ kind: 'paragraph', text: 'x'.repeat(5001) }] }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(draft({ bodyBlocks: [{ kind: 'paragraph', text: 'bell \u0007' }] }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(draft({ bodyBlocks: [{ kind: 'paragraph', text: 'open {{ brace' }], placeholderSchema: {} }))).toEqual({ code: 'PLACEHOLDER_SCHEMA_INVALID', status: 422, detail: 'body_blocks' });
      expect(await refusal(draft({ bodyBlocks: [{ kind: 'paragraph', text: '{{a..b}}' }], placeholderSchema: {} }))).toMatchObject({ code: 'PLACEHOLDER_SCHEMA_INVALID' });
      expect(await refusal(draft({ placeholderSchema: { required: ['title', 'body', 'unused'] } }))).toEqual({ code: 'PLACEHOLDER_SCHEMA_INVALID', status: 422, detail: 'placeholder_schema' });
      expect(await refusal(draft({ placeholderSchema: { required: ['title', 'title'] } }))).toMatchObject({ code: 'PLACEHOLDER_SCHEMA_INVALID' });
      expect(await refusal(draft({ placeholderSchema: { required: 'title' } }))).toMatchObject({ code: 'PLACEHOLDER_SCHEMA_INVALID' });
      expect(await refusal(draft({ placeholderSchema: { required: ['bad path'] } }))).toMatchObject({ code: 'PLACEHOLDER_SCHEMA_INVALID' });
      expect(await refusal(draft({ placeholderSchema: { optional: [] } }))).toMatchObject({ code: 'PLACEHOLDER_SCHEMA_INVALID' });
      expect(await refusal(draft({ placeholderSchema: [] }))).toMatchObject({ code: 'PLACEHOLDER_SCHEMA_INVALID' });
      const ok = await draft({ bodyBlocks: [{ kind: 'paragraph', text: 'Dear {{ recipient.name }}' }], placeholderSchema: { required: ['recipient.name'] } });
      expect(ok.placeholderSchema).toEqual({ required: ['recipient.name'] });
      const optional = await draft({ bodyBlocks: [{ kind: 'paragraph', text: 'Plain' }], placeholderSchema: {} });
      expect(optional.placeholderSchema).toEqual({ required: [] });
    });

    it('refuses a layout profile that is not published, and a form code that another template already uses', async () => {
      expect(await refusal(draft({ layoutProfileId: randomUUID() }))).toEqual({ code: 'PROFILE_NOT_PUBLISHED', status: 422, detail: 'layout_profile_id' });
      await draft({ templateCode: 'DOC-FORM-A', formCode: '99.a/TT' });
      expect(await refusal(draft({ templateCode: 'DOC-FORM-B', formCode: '99.a/TT' }))).toEqual({ code: 'FORM_CODE_DUPLICATE', status: 409, detail: 'form_code' });
      // A new revision of the same code keeps its form code.
      expect((await draft({ templateCode: 'DOC-FORM-A', formCode: '99.a/TT' })).revision).toBe(2);
    });

    it('needs a watermark: a profile without one and a draft without one is refused', async () => {
      await harness.owner(TENANT_A, [["update machvon.document_layout_profile set watermark_policy = '{\"text\":\"\"}'::jsonb where id = $1", [profiles[TENANT_A]]]]);
      try {
        expect(await refusal(draft())).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'watermark_text' });
        expect((await draft({ watermarkText: 'Own watermark text' })).watermarkText).toBe('Own watermark text');
      } finally {
        await harness.owner(TENANT_A, [["update machvon.document_layout_profile set watermark_policy = '{\"text\":\"CHO X\\u00c1C NH\\u1eacN\"}'::jsonb where id = $1", [profiles[TENANT_A]]]]);
      }
    });

    it('lets two drafts of one code race and numbers both', async () => {
      const results = await Promise.all([draft({ templateCode: 'DOC-RACE' }), draft({ templateCode: 'DOC-RACE' }), draft({ templateCode: 'DOC-RACE' })]);
      expect(results.map((row) => row.revision).sort()).toEqual([1, 2, 3]);
    });
  });

  describe('publishing', () => {
    it('publishes a draft for someone other than its drafter and writes the approval once (AC-ST-DOC-006-1)', async () => {
      const created = await draft();
      expect(await refusal(publish(created, DRAFTER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const { record, closed } = await publish(created);
      expect(closed).toEqual([]);
      expect(record).toMatchObject({ status: 'PUBLISHED', approvedBy: memberId(PUBLISHER), version: 2, confirmationStatus: 'PENDING_CONFIRMATION' });
      expect(record.publishedAt).toBeInstanceOf(Date);
      expect(await refusal(publish({ id: created.id, version: 2 }))).toEqual({ code: 'TEMPLATE_STATE_INVALID', status: 409, detail: 'status' });
      // The published revision is found by the renderer, still waiting for confirmation.
      const found = await as(PUBLISHER, (tx) => documents.templateFor(tx, { templateCode: created.templateCode }, '2026-06-01'));
      expect(found).toMatchObject({ id: created.id, confirmationStatus: 'PENDING_CONFIRMATION' });
    });

    it('refuses a stale version and an unknown template', async () => {
      const created = await draft();
      const stale = await refusal(publish({ id: created.id, version: 7 }));
      expect(stale).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(publish({ id: randomUUID(), version: 1 }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('serves each date from the revision in force and refuses a third revision that overlaps (AC-ST-DOC-006-2)', async () => {
      const code = 'DOC-CV-GIAI-TRINH-T';
      const rev1 = await published({ templateCode: code, effectiveFrom: '2026-01-01', effectiveUntil: '2027-01-01', title: 'Revision one' });
      const rev2 = await published({ templateCode: code, effectiveFrom: '2027-01-01', title: 'Revision two' });
      const at = (date: string) => as(PUBLISHER, (tx) => documents.templateFor(tx, { templateCode: code }, date));
      expect((await at('2026-12-31')).id).toBe(rev1.id);
      expect((await at('2027-01-01')).id).toBe(rev2.id);
      const rev3 = await draft({ templateCode: code, effectiveFrom: '2027-03-01', effectiveUntil: '2027-12-31', title: 'Revision three' });
      expect(await refusal(publish(rev3))).toEqual({ code: 'TEMPLATE_RANGE_OVERLAP', status: 409, detail: 'effective_from' });
      const unchanged = await as(PUBLISHER, (tx) => store.find(tx, rev3.id));
      expect(unchanged).toMatchObject({ status: 'DRAFT', version: 1, approvedBy: null });
    });

    it('lets an open-ended revision take over from the one in force on its start date, and refuses one that starts earlier', async () => {
      const code = 'DOC-TAKEOVER';
      const first = await published({ templateCode: code, effectiveFrom: '2026-01-01' });
      const second = await draft({ templateCode: code, effectiveFrom: '2026-07-01' });
      const { closed } = await publish(second);
      expect(closed).toEqual([{ id: first.id, revision: 1, effectiveUntil: '2026-07-01' }]);
      const earlier = await as(PUBLISHER, (tx) => store.find(tx, first.id));
      expect(earlier).toMatchObject({ status: 'PUBLISHED', effectiveUntil: '2026-07-01', version: 3 });
      expect((await as(PUBLISHER, (tx) => documents.templateFor(tx, { templateCode: code }, '2026-06-30'))).id).toBe(first.id);
      expect((await as(PUBLISHER, (tx) => documents.templateFor(tx, { templateCode: code }, '2026-07-01'))).id).toBe(second.id);
      // A revision that starts before the one in force cannot take over from it.
      const backdated = await draft({ templateCode: code, effectiveFrom: '2026-03-01' });
      expect((await refusal(publish(backdated))).code).toBe('TEMPLATE_RANGE_OVERLAP');
      // A closed period inside the one in force is an overlap too.
      const inside = await draft({ templateCode: code, effectiveFrom: '2026-09-01', effectiveUntil: '2026-10-01' });
      expect((await refusal(publish(inside))).code).toBe('TEMPLATE_RANGE_OVERLAP');
    });

    it('lets publishes of different codes and of the same code race without losing the exclusion', async () => {
      const code = 'DOC-RACE-PUBLISH';
      const drafts = await Promise.all([draft({ templateCode: code, effectiveFrom: '2026-01-01' }), draft({ templateCode: code, effectiveFrom: '2026-01-01' })]);
      const outcomes = await Promise.allSettled(drafts.map((row) => publish(row)));
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as { code: string }).code).toBe('TEMPLATE_RANGE_OVERLAP');
    });
  });

  describe('legal confirmation', () => {
    it('is recorded by a third person with a reference and the evidence, and only once (AC-ST-DOC-006-1)', async () => {
      const live = await published({ templateCode: 'DOC-CONFIRM-1' });
      expect(await refusal(confirm(live, DRAFTER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(confirm(live, PUBLISHER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(confirm(live, LEGAL, ''))).toEqual({ code: 'CONFIRMATION_REF_REQUIRED', status: 422, detail: 'legal_confirmation_ref' });
      expect(await refusal(confirm(live, LEGAL, '  ab '))).toMatchObject({ code: 'CONFIRMATION_REF_REQUIRED' });
      expect(await refusal(confirm(live, LEGAL, 'x'.repeat(51)))).toMatchObject({ code: 'CONFIRMATION_REF_REQUIRED' });
      expect(await refusal(confirm(live, LEGAL, 'CXN-10', randomUUID()))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'evidence_document_id' });
      const confirmed = await confirm(live);
      expect(confirmed).toMatchObject({
        confirmationStatus: 'CONFIRMED',
        legalConfirmationRef: 'CXN-10',
        legalConfirmedBy: memberId(LEGAL),
        legalEvidenceDocumentId: evidenceId,
        legalConfirmationNote: null,
        status: 'PUBLISHED',
        version: 3,
      });
      expect(confirmed.legalConfirmedAt).toBeInstanceOf(Date);
      expect(await refusal(confirm({ id: live.id, version: 3 }))).toEqual({ code: 'TEMPLATE_STATE_INVALID', status: 409, detail: 'status' });
    });

    it('keeps an optional note, and needs a published revision at the version that was read', async () => {
      const code = 'DOC-CONFIRM-2';
      const created = await draft({ templateCode: code });
      expect((await refusal(confirm(created))).code).toBe('TEMPLATE_STATE_INVALID');
      const live = (await publish(created)).record;
      expect((await refusal(confirm({ id: live.id, version: 1 }))).code).toBe('VERSION_CONFLICT');
      const confirmed = await as(LEGAL, (tx) => store.confirmLegalBasis(tx, live.id, live.version, { reference: 'CXN-DOC-06', evidenceDocumentId: evidenceId, note: ' checked against the gazette ' }, memberId(LEGAL)));
      expect(confirmed.legalConfirmationNote).toBe('checked against the gazette');
      expect(await refusal(as(LEGAL, (tx) => store.confirmLegalBasis(tx, randomUUID(), 1, { reference: 'CXN-10', evidenceDocumentId: evidenceId }, memberId(LEGAL))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('is refused for a template drafted by the legal officer, and for a publisher who is the confirmer', async () => {
      const own = await as(LEGAL, (tx) => store.create(tx, input(TENANT_A, { actor: memberId(LEGAL) })));
      const live = (await publish(own)).record;
      expect(await refusal(confirm(live, LEGAL))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    });
  });

  describe('retirement', () => {
    it('retires a published revision with a reason, takes it out of rendering and refuses a second retirement', async () => {
      const live = await published({ templateCode: 'DOC-RETIRE-1' });
      expect(await refusal(as(LEGAL, (tx) => store.retire(tx, live.id, live.version, 'short', memberId(LEGAL))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      const retired = await as(LEGAL, (tx) => store.retire(tx, live.id, live.version, ' The form was withdrawn by its issuer ', memberId(LEGAL)));
      expect(retired).toMatchObject({ status: 'RETIRED', retirementReason: 'The form was withdrawn by its issuer', version: 3 });
      expect(retired.retiredAt).toBeInstanceOf(Date);
      await expect(as(LEGAL, (tx) => documents.templateFor(tx, { templateCode: 'DOC-RETIRE-1' }, '2026-06-01'))).rejects.toMatchObject({ code: 'TEMPLATE_NOT_EFFECTIVE' });
      expect((await refusal(as(LEGAL, (tx) => store.retire(tx, live.id, 3, 'Retiring the same revision twice', memberId(LEGAL))))).code).toBe('TEMPLATE_STATE_INVALID');
      expect((await refusal(publish({ id: live.id, version: 3 }))).code).toBe('TEMPLATE_STATE_INVALID');
    });

    it('retires a draft, and the period it held can be published again by another revision', async () => {
      const code = 'DOC-RETIRE-2';
      const abandoned = await draft({ templateCode: code });
      const retired = await as(DRAFTER, (tx) => store.retire(tx, abandoned.id, 1, 'Drafted by mistake, never used', memberId(DRAFTER)));
      expect(retired.status).toBe('RETIRED');
      const next = await published({ templateCode: code });
      expect(next.revision).toBe(2);
    });

    it('does not retire a confirmed template without keeping its confirmation on the row', async () => {
      const live = await published({ templateCode: 'DOC-RETIRE-3' });
      const confirmed = await confirm(live);
      const retired = await as(LEGAL, (tx) => store.retire(tx, confirmed.id, confirmed.version, 'Superseded by a new form', memberId(LEGAL)));
      expect(retired).toMatchObject({ status: 'RETIRED', confirmationStatus: 'CONFIRMED', legalConfirmationRef: 'CXN-10' });
    });
  });

  describe('reading', () => {
    it('lists by group, status and the date a revision is in force, and pages in code and revision order', async () => {
      const prefix = 'DOC-LIST';
      await published({ templateCode: `${prefix}-A`, groupCode: 'OFFICIAL_LETTER', effectiveFrom: '2026-01-01', effectiveUntil: '2026-06-01' });
      await published({ templateCode: `${prefix}-A`, groupCode: 'OFFICIAL_LETTER', effectiveFrom: '2026-06-01' });
      await draft({ templateCode: `${prefix}-B`, groupCode: 'TREASURY_FORM' });
      await published({ templateCode: `${prefix}-C`, groupCode: 'OFFICIAL_LETTER', effectiveFrom: '2030-01-01' });
      const codes = async (filter: Parameters<DocumentTemplateStore['list']>[1], limit = 100) =>
        (await as(DRAFTER, (tx) => store.list(tx, filter, { limit }))).filter((row) => row.templateCode.startsWith(prefix)).map((row) => `${row.templateCode}#${row.revision}`);
      expect(await codes({})).toEqual([`${prefix}-A#1`, `${prefix}-A#2`, `${prefix}-B#1`, `${prefix}-C#1`]);
      expect(await codes({ groupCode: 'TREASURY_FORM' })).toEqual([`${prefix}-B#1`]);
      expect(await codes({ status: 'DRAFT' })).toEqual([`${prefix}-B#1`]);
      expect(await codes({ asOfDate: '2026-03-01' })).toEqual([`${prefix}-A#1`, `${prefix}-B#1`]);
      expect(await codes({ asOfDate: '2026-06-01' })).toEqual([`${prefix}-A#2`, `${prefix}-B#1`]);
      expect(await codes({ asOfDate: '2026-06-01', groupCode: 'OFFICIAL_LETTER' })).toEqual([`${prefix}-A#2`]);
      const page = await as(DRAFTER, (tx) => store.list(tx, {}, { limit: 3, after: { templateCode: `${prefix}-A`, revision: 1 } }));
      expect(page.slice(0, 3).map((row) => `${row.templateCode}#${row.revision}`)).toEqual([`${prefix}-A#2`, `${prefix}-B#1`, `${prefix}-C#1`]);
      expect(page[0]).not.toHaveProperty('bodyBlocks');
    });

    it('keeps the library of a tenant out of reach of another tenant', async () => {
      const mine = await published({ templateCode: 'DOC-TENANT-A-ONLY' });
      expect(await as(DRAFTER, (tx) => store.find(tx, mine.id), TENANT_B)).toBeUndefined();
      const listed = await as(DRAFTER, (tx) => store.list(tx, {}, { limit: 200 }), TENANT_B);
      expect(listed.some((row) => row.templateCode === 'DOC-TENANT-A-ONLY')).toBe(false);
      expect(await refusal(as(PUBLISHER, (tx) => store.publish(tx, mine.id, 1, memberId(PUBLISHER)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await as(DRAFTER, (tx) => store.revisionsOf(tx, 'DOC-TENANT-A-ONLY'), TENANT_B)).toEqual([]);
    });
  });

  describe('the guard of the table (V1220)', () => {
    const direct = (member: number, sql: string, params: unknown[]) => refusal(as(member, (tx) => tx.query(sql, params)));

    it('refuses to change the content of a revision, in any state, for the application role', async () => {
      const created = await draft();
      for (const [column, value] of [
        ['title', "'Changed'"],
        ['legal_basis', "'Changed'"],
        ['body_blocks', "'[]'::jsonb"],
        ['effective_from', "'2025-01-01'"],
        ['revision', '9'],
        ['origin', "'PLATFORM_PACK'"],
      ] as const) {
        expect((await direct(DRAFTER, `update machvon.document_template set ${column} = ${value} where id = $1::uuid`, [created.id])).sqlState).toBe('42501');
      }
    });

    it('never deletes or truncates a revision, but lets the owner (migrations, support) do so', async () => {
      const created = await draft();
      expect((await direct(DRAFTER, 'delete from machvon.document_template where id = $1::uuid', [created.id])).sqlState).toBe('42501');
      expect((await direct(DRAFTER, 'truncate machvon.document_template', [])).sqlState).toBeDefined();
      await harness.owner(TENANT_A, [['delete from machvon.document_template where id = $1', [created.id]]]);
    });

    it('allows only the moves of the lifecycle and writes the approval, the confirmation and the retirement once', async () => {
      const created = await draft();
      // A draft cannot jump to PUBLISHED without naming the approver, or to SUPERSEDED.
      expect((await direct(PUBLISHER, "update machvon.document_template set status = 'PUBLISHED' where id = $1::uuid", [created.id])).sqlState).toBe('42501');
      expect((await direct(PUBLISHER, "update machvon.document_template set status = 'SUPERSEDED' where id = $1::uuid", [created.id])).sqlState).toBe('42501');
      expect((await direct(PUBLISHER, "update machvon.document_template set approved_by = $2::uuid where id = $1::uuid", [created.id, memberId(PUBLISHER)])).sqlState).toBe('42501');
      const live = (await publish(created)).record;
      expect((await direct(LEGAL, 'update machvon.document_template set approved_by = $2::uuid where id = $1::uuid', [live.id, memberId(LEGAL)])).sqlState).toBe('42501');
      expect((await direct(LEGAL, "update machvon.document_template set status = 'DRAFT' where id = $1::uuid", [live.id])).sqlState).toBe('42501');
      // The period of a published revision is only shortened.
      await as(LEGAL, (tx) => tx.query("update machvon.document_template set effective_until = '2030-01-01' where id = $1::uuid", [live.id]));
      expect((await direct(LEGAL, "update machvon.document_template set effective_until = '2031-01-01' where id = $1::uuid", [live.id])).sqlState).toBe('42501');
      expect((await direct(LEGAL, 'update machvon.document_template set effective_until = null where id = $1::uuid', [live.id])).sqlState).toBe('42501');
      // The confirmation: not without evidence, not by the drafter or the publisher, not for a draft, and not undone.
      const confirmSql = `update machvon.document_template set confirmation_status = 'CONFIRMED', legal_confirmation_ref = 'CXN-10', legal_confirmed_by = $2::uuid,
          legal_confirmed_at = now(), legal_evidence_document_id = $3 where id = $1::uuid`;
      expect((await direct(LEGAL, confirmSql, [live.id, memberId(LEGAL), null])).sqlState).toBe('42501');
      expect((await direct(LEGAL, confirmSql, [live.id, memberId(DRAFTER), evidenceId])).sqlState).toBe('42501');
      expect((await direct(LEGAL, confirmSql, [live.id, memberId(PUBLISHER), evidenceId])).sqlState).toBe('42501');
      const other = await draft();
      expect((await direct(LEGAL, confirmSql, [other.id, memberId(LEGAL), evidenceId])).sqlState).toBe('42501');
      await as(LEGAL, (tx) => tx.query(confirmSql, [live.id, memberId(LEGAL), evidenceId]));
      expect((await direct(LEGAL, "update machvon.document_template set confirmation_status = 'PENDING_CONFIRMATION' where id = $1::uuid", [live.id])).sqlState).toBe('42501');
      expect((await direct(LEGAL, "update machvon.document_template set legal_confirmation_ref = 'OTHER-REF' where id = $1::uuid", [live.id])).sqlState).toBe('42501');
      // The retirement is written once, by the move to RETIRED, and a retired revision names who, when and why.
      expect((await direct(LEGAL, "update machvon.document_template set retirement_reason = 'late reason' where id = $1::uuid", [live.id])).sqlState).toBe('42501');
      expect((await direct(LEGAL, "update machvon.document_template set status = 'RETIRED' where id = $1::uuid", [live.id])).sqlState).toBe('23514');
      const retire = "update machvon.document_template set status = 'RETIRED', retired_at = now(), retired_by = $2::uuid, retirement_reason = 'Withdrawn for good' where id = $1::uuid";
      await as(LEGAL, (tx) => tx.query(retire, [live.id, memberId(LEGAL)]));
      expect((await direct(LEGAL, "update machvon.document_template set retirement_reason = 'rewritten' where id = $1::uuid", [live.id])).sqlState).toBe('42501');
      expect((await direct(LEGAL, "update machvon.document_template set status = 'PUBLISHED' where id = $1::uuid", [live.id])).sqlState).toBe('42501');
    });

    it('requires an approver for a published tenant revision and keeps a pack version for the pack only', async () => {
      const created = await draft();
      const insertSql = (status: string, origin: string, pack: string | null) =>
        harness.owner(TENANT_A, [
          [
            `insert into machvon.document_template (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema,
               legal_basis, watermark_text, origin, pack_version, content_sha256, effective_from, status, created_by, updated_by)
             values ($1, gen_random_uuid(), $2, 1, 'OTHER', 'QD', 'Direct', $3, '[]'::jsonb, '{}'::jsonb, 'basis', 'wm', $4, $5, repeat('a', 64), '2026-01-01', $6, $7, $7)`,
            [TENANT_A, `DOC-DIRECT-${randomUUID().slice(0, 8)}`, created.layoutProfileId, origin, pack, status, memberId(DRAFTER)],
          ],
        ]);
      await expect(insertSql('PUBLISHED', 'TENANT', null)).rejects.toMatchObject({ code: '23514' });
      await expect(insertSql('DRAFT', 'TENANT', '2026.1')).rejects.toMatchObject({ code: '23514' });
      await expect(insertSql('PUBLISHED', 'PLATFORM_PACK', '2026.1')).resolves.toBeDefined();
    });
  });

  describe('the platform pack', () => {
    const body = [
      { kind: 'heading', text: '{{title}}' },
      { kind: 'paragraph', text: '{{body}}' },
    ];
    const entry = (code: string, overrides: Record<string, unknown> = {}) => ({
      templateCode: code,
      groupCode: 'REPORT_MONITORING' as const,
      docTypeCode: 'BC',
      formCode: `FORM-${code}`,
      title: `Template ${code}`,
      sourceModule: 'MNE',
      layoutProfileCode: 'ND30_A4_STANDARD',
      bodyBlocks: body,
      placeholderSchema: SCHEMA,
      legalBasis: 'Circular 44/2026/TT-BTC [CXN-10]',
      watermarkText: 'WAITING FOR LEGAL CONFIRMATION [CXN-10]',
      effectiveFrom: '2026-01-01',
      ...overrides,
    });
    const pack = (version: string, ...entries: Array<ReturnType<typeof entry>>): TemplatePack => ({ packVersion: version, templates: entries });
    const load = (loaded: TemplatePack, tenant = TENANT_A) => as(DRAFTER, (tx) => store.loadPack(tx, loaded, memberId(DRAFTER)), tenant);

    it('loads published templates that wait for confirmation with the watermark of the pack, and loading again changes nothing (AC-ST-DOC-006-3)', async () => {
      const loaded = pack('2026.10.1', entry('PACK-M02'), entry('PACK-M03'));
      expect(await load(loaded)).toEqual({ inserted: ['PACK-M02', 'PACK-M03'], upgraded: [], unchanged: [], skipped: [] });
      const [m02] = await as(DRAFTER, (tx) => store.revisionsOf(tx, 'PACK-M02'));
      expect(m02).toMatchObject({ origin: 'PLATFORM_PACK', packVersion: '2026.10.1', status: 'PUBLISHED', confirmationStatus: 'PENDING_CONFIRMATION', watermarkText: 'WAITING FOR LEGAL CONFIRMATION [CXN-10]', revision: 1 });
      const found = await as(DRAFTER, (tx) => documents.templateFor(tx, { formCode: 'FORM-PACK-M02' }, '2026-10-22'));
      expect(found).toMatchObject({ templateCode: 'PACK-M02', confirmationStatus: 'PENDING_CONFIRMATION', watermarkText: 'WAITING FOR LEGAL CONFIRMATION [CXN-10]' });
      expect(await load(loaded)).toEqual({ inserted: [], upgraded: [], unchanged: ['PACK-M02', 'PACK-M03'], skipped: [] });
      expect(await as(DRAFTER, (tx) => store.revisionsOf(tx, 'PACK-M02'))).toHaveLength(1);
      // Another tenant has none of them until it loads the pack itself.
      expect(await as(DRAFTER, (tx) => store.revisionsOf(tx, 'PACK-M02'), TENANT_B)).toEqual([]);
      expect(await load(loaded, TENANT_B)).toMatchObject({ inserted: ['PACK-M02', 'PACK-M03'] });
    });

    it('takes over with a newer pack version, leaves a code the tenant revised alone, and says when a revision cannot take over', async () => {
      await load(pack('1', entry('PACK-UP'), entry('PACK-OWN'), entry('PACK-OLD')));
      const own = await as(DRAFTER, (tx) => store.revisionsOf(tx, 'PACK-OWN'));
      const tenantRevision = await as(DRAFTER, (tx) =>
        store.create(tx, input(TENANT_A, { templateCode: 'PACK-OWN', formCode: 'FORM-PACK-OWN', effectiveFrom: '2026-06-01' })),
      );
      expect(tenantRevision.revision).toBe(own.length + 1);
      const result = await load(pack('2', entry('PACK-UP', { effectiveFrom: '2026-09-01' }), entry('PACK-OWN', { effectiveFrom: '2026-09-01' }), entry('PACK-OLD', { effectiveFrom: '2025-01-01' })));
      expect(result).toEqual({
        inserted: [],
        upgraded: ['PACK-UP'],
        unchanged: [],
        skipped: [
          { templateCode: 'PACK-OWN', reason: 'TENANT_REVISION' },
          { templateCode: 'PACK-OLD', reason: 'NOT_SUPERSEDABLE' },
        ],
      });
      const up = await as(DRAFTER, (tx) => store.revisionsOf(tx, 'PACK-UP'));
      expect(up.map((row) => [row.revision, row.packVersion, row.effectiveFrom, row.effectiveUntil])).toEqual([
        [1, '1', '2026-01-01', '2026-09-01'],
        [2, '2', '2026-09-01', null],
      ]);
    });

    it('refuses a pack whose layout profile is not published, whose body is broken or whose form code is taken', async () => {
      expect(await refusal(load(pack('3', entry('PACK-BAD-PROFILE', { layoutProfileCode: 'NO_SUCH_PROFILE' }))))).toMatchObject({ code: 'PROFILE_NOT_PUBLISHED' });
      expect(await refusal(load(pack('3', entry('PACK-BAD-BODY', { bodyBlocks: [] }))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'body_blocks' });
      await draft({ templateCode: 'PACK-FORM-OWNER', formCode: 'FORM-TAKEN' });
      expect(await refusal(load(pack('3', entry('PACK-FORM-CLASH', { formCode: 'FORM-TAKEN' }))))).toMatchObject({ code: 'FORM_CODE_DUPLICATE' });
      // A failed load leaves nothing behind.
      expect(await as(DRAFTER, (tx) => store.revisionsOf(tx, 'PACK-BAD-BODY'))).toEqual([]);
    });

    it('turns a collision with a period that is not open-ended into an overlap', async () => {
      await load(pack('4', entry('PACK-CLOSED', { effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31' })));
      expect(await refusal(load(pack('5', entry('PACK-CLOSED', { effectiveFrom: '2026-06-01' }))))).toMatchObject({ code: 'TEMPLATE_RANGE_OVERLAP' });
    });
  });
});
