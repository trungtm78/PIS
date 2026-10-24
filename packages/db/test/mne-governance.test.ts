import { randomUUID } from 'node:crypto';
import { DocumentStore } from '../src/document-store';
import { MneFormStore } from '../src/mne-form-store';
import type { MneFormInput, MneFormPackEntry, MneFormRow } from '../src/mne-form-store';
import { MneObligationRuleStore } from '../src/mne-obligation-rule-store';
import type { MneRuleInput, MneRulePackEntry, MneRuleRow } from '../src/mne-obligation-rule-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const forms = new MneFormStore();
const rules = new MneObligationRuleStore();

const MAKER = 1;
const CHECKER = 2;
const THIRD = 3;
const TEMPLATE = 'MNE-TEST-TEMPLATE';
const LEGAL_BASIS = 'Circular 44/2026/TT-BTC [CXN-10]';

const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

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
const nextCode = (prefix: string): string => `${prefix}-${(counter += 1)}`;

const formInput = (overrides: Partial<MneFormInput> = {}): MneFormInput => ({
  formCode: nextCode('F'),
  title: 'Overall report, half year',
  reportKind: 'OVERALL_SEMIANNUAL',
  legalBasis: LEGAL_BASIS,
  effectiveFrom: '2026-01-01',
  schemaJson: { tables: [] },
  docTemplateCode: TEMPLATE,
  exportFormats: ['XLSX', 'PDF'],
  ...overrides,
});

const draftForm = (overrides: Partial<MneFormInput> = {}, member = MAKER, tenant = TENANT_A): Promise<MneFormRow> => as(member, (tx) => forms.create(tx, formInput(overrides), memberId(member)), tenant);
const publishForm = (row: { id: string; version: number }, member = CHECKER, tenant = TENANT_A) => as(member, (tx) => forms.publish(tx, row.id, row.version, memberId(member)), tenant);
const publishedForm = async (overrides: Partial<MneFormInput> = {}, tenant = TENANT_A): Promise<MneFormRow> => (await publishForm(await draftForm(overrides, MAKER, tenant), CHECKER, tenant)).record;

const ruleInput = (formId: string, overrides: Partial<MneRuleInput> = {}): MneRuleInput => ({
  ruleCode: nextCode('R'),
  formId,
  reportingRole: 'INVESTOR',
  recipient: 'Department of Finance',
  frequency: 'SEMIANNUAL',
  dueRuleJson: { period: 'H1', month: 7, day: 10 },
  legalBasis: LEGAL_BASIS,
  effectiveFrom: '2026-01-01',
  ...overrides,
});
const draftRule = (formId: string, overrides: Partial<MneRuleInput> = {}, member = MAKER, tenant = TENANT_A): Promise<MneRuleRow> =>
  as(member, (tx) => rules.create(tx, ruleInput(formId, overrides), memberId(member)), tenant);
const publishRule = (row: { id: string; version: number }, member = CHECKER, tenant = TENANT_A) => as(member, (tx) => rules.publish(tx, row.id, row.version, memberId(member)), tenant);
const publishedRule = async (formId: string, overrides: Partial<MneRuleInput> = {}): Promise<MneRuleRow> => (await publishRule(await draftRule(formId, overrides))).record;

/** A published DOC template of a code, as the platform pack would leave it. */
async function seedTemplate(code: string, effectiveFrom = '2026-01-01', tenant = TENANT_A): Promise<void> {
  const [profile] = await owner<{ id: string }>("select id from machvon.document_layout_profile where profile_code = 'ND30_A4_STANDARD'", [], tenant);
  await owner(
    `insert into machvon.document_template
       (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, watermark_text,
        origin, content_sha256, effective_from, status, published_at, created_by, updated_by)
     values ($1, $2, $3, 1, 'REPORT_MONITORING', 'BC', 'Template', $4, '[{"kind":"paragraph","text":"{{body}}"}]'::jsonb, '{"required":["body"]}'::jsonb, 'Legal basis', 'Waiting',
        'PLATFORM_PACK', repeat('c', 64), $5::date, 'PUBLISHED', now(), $6, $6)`,
    [tenant, randomUUID(), code, (profile as { id: string }).id, effectiveFrom, memberId(MAKER)],
    tenant,
  );
}

describe('MNE report forms and obligation rules (ST-MNE-001, MNE F1, BR-MNE-01)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const member of [MAKER, CHECKER, THIRD]) await harness.seedMembership(tenant, member, 1);
      await harness.tenants.withTenant(contextFor(tenant, memberId(MAKER)), (tx) => new DocumentStore().seedDefaults(tx, memberId(MAKER)));
      await seedTemplate(TEMPLATE, '2026-01-01', tenant);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('drafting and publishing a form', () => {
    it('drafts the first revision as a working assumption and numbers the next revision of the same code', async () => {
      const first = await draftForm({ formCode: 'REV-CODE' });
      expect(first).toMatchObject({ revision: 1, status: 'DRAFT', version: 1, origin: 'TENANT', legalConfirmationRef: null, approvedBy: null, createdBy: memberId(MAKER) });
      expect(first.exportFormats).toEqual(['XLSX', 'PDF']);
      expect(first.docTemplateId).not.toBeNull();
      const second = await draftForm({ formCode: 'REV-CODE', effectiveFrom: '2026-07-01' });
      expect(second.revision).toBe(2);
    });

    it('AC-ST-MNE-001-2: refuses the publication of a revision by its author (403 SELF_APPROVAL_DENIED)', async () => {
      const draft = await draftForm();
      expect(await refusal(publishForm(draft, MAKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await as(MAKER, (tx) => forms.find(tx, draft.id)))?.status).toBe('DRAFT');
    });

    it('publishes a revision by another person and records who, and when', async () => {
      const { record, closed } = await publishForm(await draftForm());
      expect(record).toMatchObject({ status: 'PUBLISHED', approvedBy: memberId(CHECKER), version: 2 });
      expect(closed).toEqual([]);
      const [row] = await owner<{ published_at: string | null }>('select published_at::text as published_at from machvon.mne_report_form where id = $1', [record.id]);
      expect(row?.published_at).not.toBeNull();
    });

    it('answers a stale version with 409 VERSION_CONFLICT and an unknown form with 404', async () => {
      const draft = await draftForm();
      expect(await refusal(as(CHECKER, (tx) => forms.publish(tx, draft.id, 7, memberId(CHECKER))))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as(CHECKER, (tx) => forms.publish(tx, randomUUID(), 1, memberId(CHECKER))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('does not publish a revision twice', async () => {
      const { record } = await publishForm(await draftForm());
      expect(await refusal(publishForm(record, THIRD))).toEqual({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
    });

    it('keeps a form of one tenant out of the other (a form id of another tenant is unknown)', async () => {
      const draft = await draftForm();
      expect(await as(MAKER, (tx) => forms.find(tx, draft.id), TENANT_B)).toBeUndefined();
      expect(await refusal(as(CHECKER, (tx) => forms.publish(tx, draft.id, 1, memberId(CHECKER)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('the DOC template of a form', () => {
    it('AC-ST-MNE-001-2: refuses a form whose DOC template does not exist (422 DOC_TEMPLATE_MISSING)', async () => {
      expect(await refusal(draftForm({ docTemplateCode: 'MNE-NO-SUCH-TEMPLATE' }))).toEqual({ code: 'DOC_TEMPLATE_MISSING', status: 422, detail: 'doc_template_code' });
    });

    it('wants the template to be in force on the day the form starts', async () => {
      await seedTemplate('MNE-LATE-TEMPLATE', '2026-09-01');
      expect(await refusal(draftForm({ docTemplateCode: 'MNE-LATE-TEMPLATE', effectiveFrom: '2026-01-01' }))).toMatchObject({ code: 'DOC_TEMPLATE_MISSING' });
      expect((await draftForm({ docTemplateCode: 'MNE-LATE-TEMPLATE', effectiveFrom: '2026-09-01' })).status).toBe('DRAFT');
    });

    it('checks the template again at publication: a template retired in between refuses the form', async () => {
      await seedTemplate('MNE-GONE-TEMPLATE');
      const draft = await draftForm({ docTemplateCode: 'MNE-GONE-TEMPLATE' });
      await owner("update machvon.document_template set status = 'RETIRED', retired_at = now(), retired_by = $2, retirement_reason = 'withdrawn for the test' where template_code = $1", ['MNE-GONE-TEMPLATE', memberId(MAKER)]);
      expect(await refusal(publishForm(draft))).toEqual({ code: 'DOC_TEMPLATE_MISSING', status: 422, detail: 'doc_template_code' });
    });
  });

  describe('the effective periods of a code', () => {
    it('AC-ST-MNE-001-2: refuses a revision whose range overlaps a published one (409 FORM_RANGE_OVERLAP)', async () => {
      const code = nextCode('OVL');
      await publishedForm({ formCode: code, effectiveFrom: '2026-01-01', effectiveUntil: '2026-07-01' });
      for (const effectiveFrom of ['2026-06-01', '2026-01-01']) {
        expect(await refusal(draftForm({ formCode: code, effectiveFrom }))).toEqual({ code: 'FORM_RANGE_OVERLAP', status: 409, detail: 'effective_from' });
      }
      // The day the first one ends is free: the period is half open.
      expect((await draftForm({ formCode: code, effectiveFrom: '2026-07-01' })).revision).toBe(2);
    });

    it('lets an open-ended revision be taken over by a later one, which retires it on its start date', async () => {
      const code = nextCode('TAKE');
      const first = await publishedForm({ formCode: code, effectiveFrom: '2026-01-01' });
      const { record, closed } = await publishForm(await draftForm({ formCode: code, effectiveFrom: '2026-07-01' }));
      expect(closed).toEqual([{ id: first.id, revision: 1, effectiveUntil: '2026-07-01' }]);
      expect(record).toMatchObject({ revision: 2, status: 'PUBLISHED', effectiveUntil: null });
      const retired = await as(MAKER, (tx) => forms.find(tx, first.id));
      expect(retired).toMatchObject({ status: 'RETIRED', effectiveUntil: '2026-07-01', version: first.version + 1 });
      // BR-MNE-02: the revision in force is the one of the day, a retired one still serves the days it covered.
      expect((await as(MAKER, (tx) => forms.inForce(tx, code, '2026-06-30')))?.id).toBe(first.id);
      expect((await as(MAKER, (tx) => forms.inForce(tx, code, '2026-07-01')))?.id).toBe(record.id);
      expect(await as(MAKER, (tx) => forms.inForce(tx, code, '2025-12-31'))).toBeUndefined();
    });

    it('refuses a later revision that is closed while an open-ended one is in force, and a draft that starts before the one in force', async () => {
      const code = nextCode('CLOSED');
      await publishedForm({ formCode: code, effectiveFrom: '2026-03-01' });
      expect(await refusal(draftForm({ formCode: code, effectiveFrom: '2026-06-01', effectiveUntil: '2026-09-01' }))).toMatchObject({ code: 'FORM_RANGE_OVERLAP' });
      expect(await refusal(draftForm({ formCode: code, effectiveFrom: '2026-02-01' }))).toMatchObject({ code: 'FORM_RANGE_OVERLAP' });
    });

    it('checks the period again at publication: two drafts of the same code cannot both be published over each other', async () => {
      const code = nextCode('RACE');
      const first = await draftForm({ formCode: code, effectiveFrom: '2026-01-01' });
      const second = await draftForm({ formCode: code, effectiveFrom: '2026-01-01' });
      await publishForm(first);
      expect(await refusal(publishForm(second))).toMatchObject({ code: 'FORM_RANGE_OVERLAP', status: 409 });
    });

    it('lets two writers race on one code: the periods never overlap and exactly one revision stays open-ended', async () => {
      const code = nextCode('CONC');
      const drafts = await Promise.all([draftForm({ formCode: code, effectiveFrom: '2026-01-01' }), draftForm({ formCode: code, effectiveFrom: '2026-01-02' })]);
      const outcomes = await Promise.allSettled(drafts.map((draft) => publishForm(draft)));
      // Taken one after the other the later start takes over from the earlier one, or the earlier start finds the later one in force and is refused.
      expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
      for (const outcome of outcomes) if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: 'FORM_RANGE_OVERLAP', status: 409 });
      const open = await owner<{ n: string }>("select count(*)::text as n from machvon.mne_report_form where form_code = $1 and status = 'PUBLISHED' and effective_until is null", [code]);
      expect(Number(open[0]?.n)).toBe(1);
    });
  });

  describe('validation', () => {
    it.each([
      ['form_code', { formCode: 'has space' }],
      ['form_code', { formCode: '' }],
      ['report_kind', { reportKind: 'SOMETHING' }],
      ['effective_from', { effectiveFrom: '2026-02-30' }],
      ['effective_until', { effectiveUntil: '2026-01-01' }],
      ['effective_until', { effectiveUntil: '2025-12-31' }],
      ['schema_json', { schemaJson: ['not', 'an', 'object'] }],
      ['schema_json', { schemaJson: null }],
      ['export_formats', { exportFormats: [] }],
      ['export_formats', { exportFormats: ['XLSX', 'XLSX'] }],
      ['export_formats', { exportFormats: ['DOCX'] }],
      ['title', { title: 'ab' }],
      ['legal_basis', { legalBasis: '  ' }],
      ['legal_basis', { legalBasis: 'x'.repeat(2001) }],
      ['legal_confirmation_ref', { legalConfirmationRef: 'x'.repeat(51) }],
      ['doc_template_code', { docTemplateCode: ' ' }],
      ['watermark_text', { watermarkText: 'ab' }],
    ] as Array<[string, Partial<MneFormInput>]>)('refuses a form whose %s is wrong (%j)', async (field, overrides) => {
      expect(await refusal(draftForm(overrides))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    });

    it('keeps the confirmation reference and the watermark of a revision as written, and a blank reference as no reference', async () => {
      const confirmed = await draftForm({ legalConfirmationRef: ' CXN-10-OK ', watermarkText: 'Waiting for confirmation' });
      expect(confirmed).toMatchObject({ legalConfirmationRef: 'CXN-10-OK', watermarkText: 'Waiting for confirmation' });
      expect((await draftForm({ legalConfirmationRef: '   ' })).legalConfirmationRef).toBeNull();
    });
  });

  describe('the catalogue read', () => {
    it('lists by code and revision with the date and the report kind filters, and pages with a keyset', async () => {
      const code = nextCode('LIST');
      const first = await publishedForm({ formCode: code, reportKind: 'OVERALL_ANNUAL', effectiveFrom: '2030-01-01' });
      await publishForm(await draftForm({ formCode: code, reportKind: 'OVERALL_ANNUAL', effectiveFrom: '2031-01-01' }));
      const draft = await draftForm({ formCode: code, reportKind: 'OVERALL_ANNUAL', effectiveFrom: '2032-01-01' });
      const inCode = (rows: MneFormRow[]): MneFormRow[] => rows.filter((row) => row.formCode === code);
      const all = inCode(await as(MAKER, (tx) => forms.list(tx, {}, { limit: 200 })));
      expect(all.map((row) => [row.revision, row.status])).toEqual([[1, 'RETIRED'], [2, 'PUBLISHED'], [3, 'DRAFT']]);
      // On a date, only the revisions of any status but DRAFT whose period holds it.
      expect(inCode(await as(MAKER, (tx) => forms.list(tx, { effectiveOn: '2030-06-01' }, { limit: 200 }))).map((row) => row.id)).toEqual([first.id]);
      expect(inCode(await as(MAKER, (tx) => forms.list(tx, { effectiveOn: '2032-06-01' }, { limit: 200 }))).map((row) => row.revision)).toEqual([2]);
      expect(inCode(await as(MAKER, (tx) => forms.list(tx, { reportKind: 'WEEKLY_QUICK' }, { limit: 200 })))).toEqual([]);
      const page = await as(MAKER, (tx) => forms.list(tx, {}, { limit: 1, after: { formCode: code, revision: 1 } }));
      expect(page[0]).toMatchObject({ formCode: code, revision: 2 });
      expect(draft.revision).toBe(3);
    });
  });

  describe('what the database keeps even against a caller that bypasses the store', () => {
    it('refuses a change of the content of a revision, a deletion and a self-approval written directly', async () => {
      const draft = await draftForm();
      const update = (sql: string, params: unknown[] = []) =>
        refusal(as(CHECKER, async (tx) => {
          await tx.query(sql, params);
        }));
      expect(await update('update machvon.mne_report_form set legal_basis = $2 where id = $1', [draft.id, 'rewritten'])).toEqual({ code: 'DB', status: 0, sqlState: '42501' });
      expect(await update('update machvon.mne_report_form set schema_json = $2::jsonb where id = $1', [draft.id, '{}'])).toMatchObject({ sqlState: '42501' });
      expect(await update('delete from machvon.mne_report_form where id = $1', [draft.id])).toMatchObject({ sqlState: '42501' });
      // The checker must differ from the maker in the row itself.
      expect(await update("update machvon.mne_report_form set status = 'PUBLISHED', approved_by = created_by, published_at = now() where id = $1", [draft.id])).toMatchObject({ sqlState: '42501' });
      expect(await update("update machvon.mne_report_form set status = 'RETIRED', retired_at = now() where id = $1", [draft.id])).toMatchObject({ sqlState: '42501' });
    });

    it('refuses to move a published period, to widen it, to approve again and to publish over another period', async () => {
      const code = nextCode('GUARD');
      const row = await publishedForm({ formCode: code });
      const update = (sql: string, params: unknown[] = []) =>
        refusal(as(CHECKER, async (tx) => {
          await tx.query(sql, params);
        }));
      expect(await update('update machvon.mne_report_form set effective_from = $2::date where id = $1', [row.id, '2025-01-01'])).toMatchObject({ sqlState: '42501' });
      expect(await update('update machvon.mne_report_form set approved_by = $2 where id = $1', [row.id, memberId(THIRD)])).toMatchObject({ sqlState: '42501' });
      expect(await update('update machvon.mne_report_form set effective_until = $2::date where id = $1', [row.id, '2026-02-01'])).toEqual({ code: 'DB', status: 0, sqlState: '42501' });
      expect(await update("update machvon.mne_report_form set status = 'DRAFT' where id = $1", [row.id])).toMatchObject({ sqlState: '42501' });
      // The exclusion constraint has the last word on an overlap written around the store.
      const direct = await owner<{ id: string }>(
        `insert into machvon.mne_report_form (tenant_id, id, form_code, title, report_kind, legal_basis, effective_from, schema_json, doc_template_code, export_formats, revision, status, published_at, created_by, updated_by)
         select tenant_id, gen_random_uuid(), form_code, title, report_kind, legal_basis, '2026-06-01', schema_json, doc_template_code, export_formats, 9, 'DRAFT', null, created_by, updated_by from machvon.mne_report_form where id = $1 returning id`,
        [row.id],
      );
      const clash = await refusal(owner("update machvon.mne_report_form set status = 'PUBLISHED', approved_by = $2, published_at = now() where id = $1", [direct[0]?.id, memberId(THIRD)]));
      expect(clash).toMatchObject({ code: 'DB', sqlState: '23P01' });
    });

    it('refuses a retirement that carries no end date', async () => {
      const code = nextCode('RETIRE');
      const row = await publishedForm({ formCode: code });
      expect(await refusal(owner("update machvon.mne_report_form set status = 'RETIRED', retired_at = now() where id = $1", [row.id]))).toMatchObject({ sqlState: '23514' });
    });
  });

  describe('obligation rules', () => {
    it('drafts a rule against a published form, reads the formula as data and numbers revisions per code', async () => {
      const form = await publishedForm();
      const rule = await draftRule(form.id, { ruleCode: 'RULE-NUMBERED' });
      expect(rule).toMatchObject({ revision: 1, status: 'DRAFT', formId: form.id, formCode: form.formCode, reportingRole: 'INVESTOR', frequency: 'SEMIANNUAL' });
      expect(rule.dueRuleJson).toEqual({ period: 'H1', month: 7, day: 10 });
      expect((await draftRule(form.id, { ruleCode: 'RULE-NUMBERED', effectiveFrom: '2026-07-01' })).revision).toBe(2);
    });

    it('AC-ST-MNE-001-2: refuses the publication of a rule by its author (403 SELF_APPROVAL_DENIED)', async () => {
      const draft = await draftRule((await publishedForm()).id);
      expect(await refusal(publishRule(draft, MAKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    });

    it('refuses a rule whose form is a draft, is not in force on the day the rule starts, or is not a form of the tenant (422 FORM_NOT_EFFECTIVE)', async () => {
      const draft = await draftForm();
      expect(await refusal(draftRule(draft.id))).toEqual({ code: 'FORM_NOT_EFFECTIVE', status: 422, detail: 'form_id' });
      const closed = await publishedForm({ effectiveFrom: '2026-01-01', effectiveUntil: '2026-07-01' });
      expect(await refusal(draftRule(closed.id, { effectiveFrom: '2026-07-01' }))).toMatchObject({ code: 'FORM_NOT_EFFECTIVE' });
      expect(await refusal(draftRule(closed.id, { effectiveFrom: '2025-12-31' }))).toMatchObject({ code: 'FORM_NOT_EFFECTIVE' });
      expect((await draftRule(closed.id, { effectiveFrom: '2026-06-30' })).status).toBe('DRAFT');
      // A form of another tenant is unknown, not "not effective".
      const foreign = await publishedForm({}, TENANT_B);
      expect(await refusal(draftRule(foreign.id))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'form_id' });
    });

    it('refuses a formula that cannot be evaluated, naming the field', async () => {
      const form = await publishedForm();
      expect(await refusal(draftRule(form.id, { dueRuleJson: { period: 'H1', month: 13, day: 10 } }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'due_rule_json.month' });
      expect(await refusal(draftRule(form.id, { frequency: 'WEEKLY', dueRuleJson: { period: 'H1' } }))).toMatchObject({ detail: 'due_rule_json.period' });
      expect(await refusal(draftRule(form.id, { dueRuleJson: 'text' }))).toMatchObject({ detail: 'due_rule_json' });
    });

    it.each([
      ['rule_code', { ruleCode: 'bad code' }],
      ['reporting_role', { reportingRole: 'MINISTER' }],
      ['frequency', { frequency: 'DAILY' }],
      ['recipient', { recipient: 'x' }],
      ['effective_from', { effectiveFrom: '2026-13-01' }],
      ['effective_until', { effectiveUntil: '2026-01-01' }],
      ['legal_basis', { legalBasis: '' }],
      ['legal_confirmation_ref', { legalConfirmationRef: 'x'.repeat(51) }],
    ] as Array<[string, Partial<MneRuleInput>]>)('refuses a rule whose %s is wrong (%j)', async (field, overrides) => {
      const form = await publishedForm();
      expect(await refusal(draftRule(form.id, overrides))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    });

    it('takes a rule over by a later open-ended revision and refuses any other overlap of the code', async () => {
      const form = await publishedForm();
      const code = nextCode('RTAKE');
      const first = await publishedRule(form.id, { ruleCode: code, effectiveFrom: '2026-01-01' });
      const { record, closed } = await publishRule(await draftRule(form.id, { ruleCode: code, effectiveFrom: '2026-07-01', dueRuleJson: { period: 'H1', month: 7, day: 15 } }));
      expect(closed).toEqual([{ id: first.id, revision: 1, effectiveUntil: '2026-07-01' }]);
      expect(record.status).toBe('PUBLISHED');
      expect(await as(MAKER, (tx) => rules.find(tx, first.id))).toMatchObject({ status: 'RETIRED', effectiveUntil: '2026-07-01' });
      expect(await refusal(draftRule(form.id, { ruleCode: code, effectiveFrom: '2026-03-01' }))).toEqual({ code: 'EFFECTIVE_RANGE_OVERLAP', status: 409, detail: 'effective_from' });
    });

    it('reads the rules whose period meets a window, retired ones included', async () => {
      const form = await publishedForm({ effectiveFrom: '2030-01-01' });
      const code = nextCode('RWIN');
      const first = await publishedRule(form.id, { ruleCode: code, effectiveFrom: '2030-01-01' });
      const second = (await publishRule(await draftRule(form.id, { ruleCode: code, effectiveFrom: '2031-01-01' }))).record;
      await draftRule(form.id, { ruleCode: code, effectiveFrom: '2033-01-01' });
      const inWindow = async (from: string, until: string): Promise<string[]> => (await as(MAKER, (tx) => rules.inWindow(tx, { from, until }))).filter((rule) => rule.ruleCode === code).map((rule) => rule.id);
      expect(await inWindow('2030-01-01', '2031-01-01')).toEqual([first.id]);
      expect(await inWindow('2030-06-01', '2032-01-01')).toEqual([first.id, second.id]);
      expect(await inWindow('2031-01-01', '2032-01-01')).toEqual([second.id]);
      expect(await inWindow('2029-01-01', '2030-01-01')).toEqual([]);
    });

    it('lists the revisions newest first, narrowed by role, form code and status, and pages by the creation time', async () => {
      const form = await publishedForm();
      const first = await publishedRule(form.id, { ruleCode: nextCode('RLIST'), reportingRole: 'INVESTOR' });
      const second = await draftRule(form.id, { ruleCode: nextCode('RLIST'), reportingRole: 'PROVINCIAL_PEOPLE_COMMITTEE' });
      const mine = (rows: MneRuleRow[]): string[] => rows.filter((row) => row.formCode === form.formCode).map((row) => row.id);
      expect(mine(await as(MAKER, (tx) => rules.list(tx, {}, { limit: 200 })))).toEqual([second.id, first.id]);
      expect(mine(await as(MAKER, (tx) => rules.list(tx, { reportingRole: 'INVESTOR', formCode: form.formCode }, { limit: 200 })))).toEqual([first.id]);
      expect(mine(await as(MAKER, (tx) => rules.list(tx, { status: 'DRAFT', formCode: form.formCode }, { limit: 200 })))).toEqual([second.id]);
      expect(await as(MAKER, (tx) => rules.list(tx, { formCode: form.formCode, status: 'RETIRED' }, { limit: 200 }))).toEqual([]);
      const head = await as(MAKER, (tx) => rules.list(tx, { formCode: form.formCode }, { limit: 1 }));
      expect(head.map((row) => row.id)).toEqual([second.id]);
      const tail = await as(MAKER, (tx) => rules.list(tx, { formCode: form.formCode }, { limit: 5, after: { createdAtKey: (head[0] as MneRuleRow).createdAtKey, id: (head[0] as MneRuleRow).id } }));
      expect(tail.map((row) => row.id)).toEqual([first.id]);
      expect(await refusal(as(MAKER, (tx) => rules.list(tx, {}, { limit: 5, after: { createdAtKey: 'yesterday', id: randomUUID() } })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor' });
      expect(await as(MAKER, (tx) => rules.list(tx, {}, { limit: 200 }), TENANT_B)).toEqual([]);
    });

    it('refuses to publish a rule twice, with a stale version, or for an unknown id', async () => {
      const rule = (await publishRule(await draftRule((await publishedForm()).id))).record;
      expect(await refusal(publishRule(rule, THIRD))).toEqual({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
      const draft = await draftRule((await publishedForm()).id);
      expect(await refusal(as(CHECKER, (tx) => rules.publish(tx, draft.id, 9, memberId(CHECKER))))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(as(CHECKER, (tx) => rules.publish(tx, randomUUID(), 1, memberId(CHECKER))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await as(MAKER, (tx) => rules.find(tx, draft.id), TENANT_B)).toBeUndefined();
    });

    it('refuses a change of the formula of a stored rule written around the store', async () => {
      const rule = await draftRule((await publishedForm()).id);
      expect(await refusal(as(MAKER, async (tx) => {
        await tx.query("update machvon.mne_obligation_rule set due_rule_json = '{}'::jsonb where id = $1", [rule.id]);
      }))).toMatchObject({ sqlState: '42501' });
    });
  });

  describe('the platform pack', () => {
    const PACK_VERSION = '2026.10.1';
    const packForm = (formCode: string, overrides: Partial<MneFormPackEntry> = {}): MneFormPackEntry => ({ ...formInput({ formCode }), watermarkText: 'Waiting for legal confirmation [CXN-10]', ...overrides });
    const packRule = (ruleCode: string, formCode: string, overrides: Partial<MneRulePackEntry> = {}): MneRulePackEntry => {
      const { formId: ignored, ...rest } = ruleInput('', { ruleCode });
      void ignored;
      return { ...rest, formCode, ...overrides };
    };

    it('loads forms and rules as published working assumptions, once, and upgrades them with a newer pack version', async () => {
      const code = nextCode('PACKF');
      const ruleCode = nextCode('PACKR');
      const first = await as(MAKER, (tx) => forms.loadPack(tx, PACK_VERSION, [packForm(code)], memberId(MAKER)));
      expect(first).toEqual({ inserted: [code], upgraded: [], unchanged: [], skipped: [] });
      const firstRules = await as(MAKER, (tx) => rules.loadPack(tx, PACK_VERSION, [packRule(ruleCode, code)], memberId(MAKER)));
      expect(firstRules).toEqual({ inserted: [ruleCode], upgraded: [], unchanged: [], skipped: [] });
      const [loaded] = await as(MAKER, (tx) => forms.list(tx, {}, { limit: 200 })).then((rows) => rows.filter((row) => row.formCode === code));
      expect(loaded).toMatchObject({ status: 'PUBLISHED', origin: 'PLATFORM_PACK', packVersion: PACK_VERSION, approvedBy: null, legalConfirmationRef: null, watermarkText: 'Waiting for legal confirmation [CXN-10]' });
      // Loading again changes nothing.
      expect(await as(MAKER, (tx) => forms.loadPack(tx, PACK_VERSION, [packForm(code)], memberId(MAKER)))).toMatchObject({ unchanged: [code], inserted: [] });
      expect(await as(MAKER, (tx) => rules.loadPack(tx, PACK_VERSION, [packRule(ruleCode, code)], memberId(MAKER)))).toMatchObject({ unchanged: [ruleCode], inserted: [] });
      // A newer pack version takes over from the revision in force on its own start date.
      const upgraded = await as(MAKER, (tx) => forms.loadPack(tx, '2026.11.0', [packForm(code, { effectiveFrom: '2026-07-01', legalConfirmationRef: 'CXN-10-SIGNED' })], memberId(MAKER)));
      expect(upgraded).toMatchObject({ upgraded: [code] });
      expect((await as(MAKER, (tx) => forms.inForce(tx, code, '2026-06-30')))?.revision).toBe(1);
      expect(await as(MAKER, (tx) => forms.inForce(tx, code, '2026-07-01'))).toMatchObject({ revision: 2, legalConfirmationRef: 'CXN-10-SIGNED' });
      const upgradedRules = await as(MAKER, (tx) => rules.loadPack(tx, '2026.11.0', [packRule(ruleCode, code, { effectiveFrom: '2026-07-01' })], memberId(MAKER)));
      expect(upgradedRules).toMatchObject({ upgraded: [ruleCode] });
    });

    it('leaves a code that the tenant revised itself, a pack that cannot take over, a missing DOC template and a missing form alone', async () => {
      const own = await publishedForm();
      expect(await as(MAKER, (tx) => forms.loadPack(tx, PACK_VERSION, [packForm(own.formCode, { effectiveFrom: '2027-01-01' })], memberId(MAKER)))).toMatchObject({
        skipped: [{ formCode: own.formCode, reason: 'TENANT_REVISION' }],
      });
      const code = nextCode('PACKS');
      await as(MAKER, (tx) => forms.loadPack(tx, PACK_VERSION, [packForm(code, { effectiveFrom: '2026-06-01' })], memberId(MAKER)));
      expect(await as(MAKER, (tx) => forms.loadPack(tx, '2026.12.0', [packForm(code, { effectiveFrom: '2026-01-01' })], memberId(MAKER)))).toMatchObject({
        skipped: [{ formCode: code, reason: 'NOT_SUPERSEDABLE' }],
      });
      const noTemplate = nextCode('PACKT');
      expect(await as(MAKER, (tx) => forms.loadPack(tx, PACK_VERSION, [packForm(noTemplate, { docTemplateCode: 'MNE-NO-SUCH-TEMPLATE' })], memberId(MAKER)))).toMatchObject({
        skipped: [{ formCode: noTemplate, reason: 'DOC_TEMPLATE_MISSING' }],
      });
      expect(await as(MAKER, (tx) => rules.loadPack(tx, PACK_VERSION, [packRule(nextCode('PACKR'), noTemplate)], memberId(MAKER)))).toMatchObject({
        skipped: [{ reason: 'FORM_NOT_EFFECTIVE' }],
      });
      const taken = nextCode('PACKR');
      const ownForm = await publishedForm();
      await publishedRule(ownForm.id, { ruleCode: taken });
      expect(await as(MAKER, (tx) => rules.loadPack(tx, PACK_VERSION, [packRule(taken, ownForm.formCode, { effectiveFrom: '2027-01-01' })], memberId(MAKER)))).toMatchObject({
        skipped: [{ ruleCode: taken, reason: 'TENANT_REVISION' }],
      });
      const packed = nextCode('PACKR');
      await as(MAKER, (tx) => rules.loadPack(tx, PACK_VERSION, [packRule(packed, code, { effectiveFrom: '2026-06-01' })], memberId(MAKER)));
      expect(await as(MAKER, (tx) => rules.loadPack(tx, '2026.12.0', [packRule(packed, code, { effectiveFrom: '2026-06-01' })], memberId(MAKER)))).toMatchObject({
        skipped: [{ ruleCode: packed, reason: 'NOT_SUPERSEDABLE' }],
      });
    });
  });
});
