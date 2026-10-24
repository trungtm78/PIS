import { ADMIN, APPROVER, EVERYTHING, INVESTORS, MneApp, NOBODY, OUTSIDE, READER, SCOPED, TENANT_B, unitId } from './mne-app';
import type { Reply } from './mne-app';

jest.setTimeout(120_000);

const app = new MneApp();
const etag = (version: number): string => `"${version}"`;
const ALL_INVESTORS = [...INVESTORS, OUTSIDE];

const formBody = (formCode: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  form_code: formCode,
  title: 'Overall report',
  report_kind: 'OVERALL_SEMIANNUAL',
  legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
  effective_from: '2026-01-01',
  schema_json: { tables: [] },
  doc_template_code: 'MNE-TT44-M02',
  export_formats: ['XLSX'],
  ...overrides,
});
const ruleBody = (formId: string, ruleCode: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  rule_code: ruleCode,
  form_id: formId,
  reporting_role: 'INVESTOR',
  recipient: 'Department of Finance',
  frequency: 'SEMIANNUAL',
  due_rule_json: { period: 'H1', month: 7, day: 10 },
  legal_basis: 'Circular 44/2026/TT-BTC, report before 10 July [CXN-10]',
  effective_from: '2026-01-01',
  ...overrides,
});

async function publishedForm(formCode: string, overrides: Record<string, unknown> = {}, tenantId?: string): Promise<string> {
  const options = tenantId === undefined ? {} : { tenantId };
  const created = await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody(formCode, overrides), ...options });
  expect(created.status).toBe(200);
  const published = await app.call('POST', `/mne-forms/${created.json.resource_id as string}/publish`, { member: APPROVER, ifMatch: etag(1), ...options });
  expect(published.status).toBe(200);
  return created.json.resource_id as string;
}

async function publishedRule(formId: string, ruleCode: string, overrides: Record<string, unknown> = {}, tenantId?: string): Promise<string> {
  const options = tenantId === undefined ? {} : { tenantId };
  const created = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(formId, ruleCode, overrides), ...options });
  expect(created.status).toBe(200);
  const published = await app.call('POST', `/mne-obligation-rules/${created.json.resource_id as string}/publish`, { member: APPROVER, ifMatch: etag(1), ...options });
  expect(published.status).toBe(200);
  return created.json.resource_id as string;
}

/** The two rules of the design for the investors: OVERALL_SEMIANNUAL (10 July) and OVERALL_ANNUAL (10 February of the next year). */
async function publishDesignRules(): Promise<void> {
  const half = await publishedForm('TT44-M02');
  const year = await publishedForm('TT44-M03', { report_kind: 'OVERALL_ANNUAL', doc_template_code: 'MNE-TT44-M03' });
  await publishedRule(half, 'OVERALL_SEMIANNUAL');
  await publishedRule(year, 'OVERALL_ANNUAL', { frequency: 'ANNUAL', due_rule_json: { period: 'YEAR', month: 2, day: 10, year_offset: 1 }, legal_basis: 'Circular 44/2026/TT-BTC, report before 10 February [CXN-10]' });
}

const generate = (body: Record<string, unknown>, member = ADMIN, tenantId?: string, key?: string): Promise<Reply> =>
  app.call('POST', '/mne-obligations/generate', { member, body, ...(tenantId === undefined ? {} : { tenantId }), ...(key === undefined ? {} : { key }) });
const calendar = (query = '', member = READER, tenantId?: string): Promise<Reply> => app.call('GET', `/mne-obligations${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

describe('obligation rules and the filing calendar API (ST-MNE-001, MNE F1, F2)', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);
  afterEach(async () => {
    await app.reset();
    await app.reset(TENANT_B);
  });

  describe('AC-ST-MNE-001-1: the calendar is generated from rules that are data', () => {
    it('AC-ST-MNE-001-1: gives every investor H1-2026 due 2026-07-10 and YEAR-2026 due 2027-02-10 with the legal basis and the CXN label, and a second run adds nothing', async () => {
      await publishDesignRules();
      const first = await generate({ report_year: 2026 });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'GENERATED', resource_version: 1, created: 8, existing: 0, periods: 2, unresolved_roles: [] });
      const shown = await calendar('?report_year=2026&limit=200');
      expect(shown.status).toBe(200);
      expect(shown.json.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const rows = items(shown);
      expect(rows).toHaveLength(8);
      for (const unit of ALL_INVESTORS) {
        const own = rows.filter((row) => row.scope_unit_id === unitId(unit));
        expect(own.map((row) => [row.period_label, row.due_date, row.form_code])).toEqual([
          ['H1-2026', '2026-07-10', 'TT44-M02'],
          ['YEAR-2026', '2027-02-10', 'TT44-M03'],
        ]);
      }
      expect(rows[0]).toMatchObject({
        reporting_role: 'INVESTOR',
        recipient: 'Department of Finance',
        legal_basis: 'Circular 44/2026/TT-BTC, report before 10 July [CXN-10]',
        cxn_refs: ['CXN-10'],
        awaiting_confirmation: true,
        status: 'DRAFT',
        is_late: expect.any(Boolean),
        days_late: expect.any(Number),
        rule_code: 'OVERALL_SEMIANNUAL',
        rule_revision: 1,
        form_revision: 1,
      });
      expect(rows[0]).toHaveProperty('mne_report_id');
      expect(rows[0]).toHaveProperty('obligation_rule_id');
      const second = await generate({ report_year: 2026 });
      expect(second.json).toMatchObject({ created: 0, existing: 8 });
      expect(await app.count('select count(*)::text as n from machvon.mne_report')).toBe(8);
    });

    it('AC-ST-MNE-001-1: a retried generation with the same key replays the first answer', async () => {
      await publishDesignRules();
      const first = await generate({ report_year: 2026 }, ADMIN, undefined, 'generate-2026-retry-001');
      const retry = await generate({ report_year: 2026 }, ADMIN, undefined, 'generate-2026-retry-001');
      expect(retry.json).toEqual(first.json);
      expect(await app.count('select count(*)::text as n from machvon.mne_report')).toBe(8);
    });

    it('audits the run, and announces it only when it wrote something', async () => {
      await publishDesignRules();
      const before = await app.count("select count(*)::text as n from machvon.outbox_event where type = 'mne.obligations.generated.v1'");
      const first = await generate({ report_year: 2026 });
      await generate({ report_year: 2026 });
      expect(await app.count("select count(*)::text as n from machvon.outbox_event where type = 'mne.obligations.generated.v1'")).toBe(before + 1);
      expect(await app.count("select count(*)::text as n from machvon.audit_event where action = 'mne.obligations_generated' and outcome = 'SUCCESS'")).toBeGreaterThanOrEqual(2);
      expect(first.json.resource_id).toEqual(expect.any(String));
    });

    it('refuses a year that no rule covers (422 NO_EFFECTIVE_RULE) and a body that is not a year', async () => {
      const none = await generate({ report_year: 2026 });
      expect([none.status, none.json.code]).toEqual([422, 'NO_EFFECTIVE_RULE']);
      await publishDesignRules();
      const bad = await generate({ report_year: 1900 });
      expect([bad.status, bad.json.code, bad.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'report_year']);
      expect((await generate({})).status).toBe(400);
      expect((await generate({ report_year: 2026, extra: true })).json.code).toBe('FIELD_NOT_ALLOWED');
    });
  });

  describe('rules: maker and checker, effectivity', () => {
    it('AC-ST-MNE-001-2: refuses the publication of a rule by its author (403 SELF_APPROVAL_DENIED)', async () => {
      const formId = await publishedForm('TT44-M02');
      const created = await app.call('POST', '/mne-obligation-rules', { member: EVERYTHING, body: ruleBody(formId, 'OVERALL_SEMIANNUAL') });
      const refused = await app.call('POST', `/mne-obligation-rules/${created.json.resource_id as string}/publish`, { member: EVERYTHING, ifMatch: etag(1) });
      expect([refused.status, refused.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    });

    it('refuses a rule whose form is not effective (422 FORM_NOT_EFFECTIVE) or unknown (422 VALIDATION_FAILED)', async () => {
      const draftForm = await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody('TT44-M02') });
      const notEffective = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(draftForm.json.resource_id as string, 'R1') });
      expect([notEffective.status, notEffective.json.code]).toEqual([422, 'FORM_NOT_EFFECTIVE']);
      const unknown = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody('00000000-0000-4000-8000-0000000000aa', 'R1') });
      expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'form_id']);
    });

    it('refuses a formula that cannot be evaluated, a missing legal basis and an overlapping revision', async () => {
      const formId = await publishedForm('TT44-M02');
      const formula = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(formId, 'R1', { due_rule_json: { period: 'H1', month: 13, day: 1 } }) });
      expect([formula.status, formula.json.code, formula.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'due_rule_json.month']);
      const basis = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(formId, 'R1', { legal_basis: undefined }) });
      expect([basis.status, basis.json.code]).toEqual([422, 'LEGAL_BASIS_REQUIRED']);
      await publishedRule(formId, 'R1');
      const overlap = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(formId, 'R1', { effective_from: '2026-01-01' }) });
      expect([overlap.status, overlap.json.code]).toEqual([409, 'EFFECTIVE_RANGE_OVERLAP']);
    });

    it('keeps rights apart: the author cannot publish, the approver cannot draft, the reader does neither', async () => {
      const formId = await publishedForm('TT44-M02');
      expect((await app.call('POST', '/mne-obligation-rules', { member: APPROVER, body: ruleBody(formId, 'R1') })).status).toBe(403);
      expect((await app.call('POST', '/mne-obligation-rules', { member: READER, body: ruleBody(formId, 'R1') })).status).toBe(403);
      const created = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(formId, 'R1') });
      expect(created.json).toMatchObject({ status: 'DRAFT', revision: 1 });
      expect((await app.call('POST', `/mne-obligation-rules/${created.json.resource_id as string}/publish`, { member: ADMIN, ifMatch: etag(1) })).status).toBe(403);
      const stale = await app.call('POST', `/mne-obligation-rules/${created.json.resource_id as string}/publish`, { member: APPROVER, ifMatch: etag(4) });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await generate({ report_year: 2026 }, APPROVER)).status).toBe(403);
      expect((await generate({ report_year: 2026 }, READER)).status).toBe(403);
    });

    it('UAT-AC299: a rule revision that takes over on 2027-01-01 gives the 2027 report its own deadline, 2026 keeps the first', async () => {
      const formId = await publishedForm('TT44-M02');
      await publishedRule(formId, 'OVERALL_SEMIANNUAL', { effective_from: '2026-01-01' });
      const second = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(formId, 'OVERALL_SEMIANNUAL', { effective_from: '2027-01-01', due_rule_json: { period: 'H1', month: 7, day: 15 } }) });
      expect(second.json.revision).toBe(2);
      expect((await app.call('POST', `/mne-obligation-rules/${second.json.resource_id as string}/publish`, { member: APPROVER, ifMatch: etag(1) })).status).toBe(200);
      await generate({ report_year: 2026 });
      await generate({ report_year: 2027 });
      const rows = items(await calendar('?limit=200'));
      expect(rows.filter((row) => row.report_year === 2026).map((row) => [row.rule_revision, row.due_date])).toEqual(ALL_INVESTORS.map(() => [1, '2026-07-10']));
      expect(rows.filter((row) => row.report_year === 2027).map((row) => [row.rule_revision, row.due_date])).toEqual(ALL_INVESTORS.map(() => [2, '2027-07-15']));
    });
  });

  describe('the list of rules', () => {
    const rules = (query = '', member = READER, tenantId?: string): Promise<Reply> => app.call('GET', `/mne-obligation-rules${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

    it('lists every revision of the tenant newest first with its formula, its confirmation label and who made and approved it', async () => {
      const formId = await publishedForm('TT44-M02');
      const first = await publishedRule(formId, 'LIST-A');
      const draft = await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(formId, 'LIST-B', { reporting_role: 'PROVINCIAL_PEOPLE_COMMITTEE', recipient: 'Bộ Tài chính' }) });
      const reply = await rules('?limit=50');
      expect(reply.status).toBe(200);
      expect(items(reply).map((row) => [row.id, row.status])).toEqual([[draft.json.resource_id, 'DRAFT'], [first, 'PUBLISHED']]);
      expect(items(reply)[1]).toMatchObject({
        rule_code: 'LIST-A',
        revision: 1,
        form_id: formId,
        form_code: 'TT44-M02',
        reporting_role: 'INVESTOR',
        frequency: 'SEMIANNUAL',
        due_rule_json: { period: 'H1', month: 7, day: 10 },
        legal_confirmation_ref: null,
        awaiting_confirmation: true,
        cxn_refs: ['CXN-10'],
        effective_from: '2026-01-01',
        effective_until: null,
        origin: 'TENANT',
        version: 2,
      });
      expect(items(reply)[1]?.approved_by).toEqual(expect.any(String));
      expect(items(reply)[0]?.approved_by).toBeNull();
      expect(reply.json.next_cursor).toBeNull();
    });

    it('narrows by reporting role, form code and status, and pages newest first with a cursor', async () => {
      const half = await publishedForm('TT44-M02');
      const year = await publishedForm('TT44-M03', { doc_template_code: 'MNE-TT44-M03' });
      await publishedRule(half, 'PAGE-1');
      await publishedRule(year, 'PAGE-2', { reporting_role: 'PROJECT_OWNER_AGENCY' });
      await app.call('POST', '/mne-obligation-rules', { member: ADMIN, body: ruleBody(year, 'PAGE-3') });
      expect(items(await rules('?reporting_role=PROJECT_OWNER_AGENCY')).map((row) => row.rule_code)).toEqual(['PAGE-2']);
      expect(items(await rules('?form_code=TT44-M03')).map((row) => row.rule_code)).toEqual(['PAGE-3', 'PAGE-2']);
      expect(items(await rules('?status=DRAFT')).map((row) => row.rule_code)).toEqual(['PAGE-3']);
      expect(items(await rules('?status=RETIRED'))).toEqual([]);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Reply = await rules(`?limit=1${cursor === null ? '' : `&cursor=${cursor}`}`);
        seen.push(...items(page).map((row) => row.rule_code as string));
        cursor = page.json.next_cursor as string | null;
      } while (cursor !== null);
      expect(seen).toEqual(['PAGE-3', 'PAGE-2', 'PAGE-1']);
    });

    it('refuses a malformed filter or cursor, answers nobody without the read permission and keeps the rules of a tenant out of the other', async () => {
      await publishedRule(await publishedForm('TT44-M02'), 'TENANT-A-RULE');
      for (const query of ['?reporting_role=MINISTER', '?status=DONE', '?form_code=has space', '?limit=0', '?cursor=not-a-cursor']) {
        const reply = await rules(query);
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const forged = await rules(`?cursor=${Buffer.from(JSON.stringify(['yesterday', '00000000-0000-4000-8000-0000000000aa'])).toString('base64url')}`);
      expect([forged.status, forged.json.detail]).toEqual([422, 'cursor']);
      expect((await rules('', NOBODY)).status).toBe(403);
      expect(items(await rules('', ADMIN, TENANT_B))).toEqual([]);
    });
  });

  describe('scope and tenancy', () => {
    it('lets a caller who reaches one branch generate and read that branch only, and refuses a unit outside it (403 SCOPE_DENIED)', async () => {
      await publishDesignRules();
      const scoped = await generate({ report_year: 2026 }, SCOPED);
      expect(scoped.json).toMatchObject({ created: 6 });
      const outside = await generate({ report_year: 2026, scope_unit_id: unitId(OUTSIDE) }, SCOPED);
      expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const unknown = await generate({ report_year: 2026, scope_unit_id: '00000000-0000-4000-8000-0000000000aa' }, SCOPED);
      expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'scope_unit_id']);
      expect(await generate({ report_year: 2026 }, ADMIN).then((reply) => reply.json)).toMatchObject({ created: 2, existing: 6 });
      expect(items(await calendar('?limit=200', SCOPED))).toHaveLength(6);
      expect(items(await calendar('?limit=200', READER))).toHaveLength(8);
      expect(items(await calendar(`?scope_unit_id=${unitId(OUTSIDE)}`, SCOPED))).toEqual([]);
    });

    it('answers nobody without the read permission, and keeps the calendar of a tenant out of the other', async () => {
      await publishDesignRules();
      await generate({ report_year: 2026 });
      expect((await calendar('', NOBODY)).status).toBe(403);
      expect(items(await calendar('', ADMIN, TENANT_B))).toEqual([]);
      const foreign = await generate({ report_year: 2026 }, ADMIN, TENANT_B);
      expect([foreign.status, foreign.json.code]).toEqual([422, 'NO_EFFECTIVE_RULE']);
    });

    it('pages the calendar by due date with a cursor and refuses a malformed filter or cursor', async () => {
      await publishDesignRules();
      await generate({ report_year: 2026 });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Reply = await calendar(`?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`);
        seen.push(...items(page).map((row) => row.mne_report_id as string));
        cursor = page.json.next_cursor as string | null;
      } while (cursor !== null);
      expect(new Set(seen).size).toBe(8);
      for (const query of ['?report_year=26', '?report_year=abc', '?scope_unit_id=nope', '?status=DONE', '?limit=0', '?cursor=not-a-cursor']) {
        const reply = await calendar(query);
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      expect(items(await calendar('?status=DRAFT'))).toHaveLength(8);
      expect(items(await calendar('?status=ISSUED'))).toEqual([]);
    });
  });
});
