import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { reportingPeriods } from '@machvon/kernel';
import { DocumentStore } from '../src/document-store';
import { BASELINE_PACK, applyBaseline, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import { MneFormStore } from '../src/mne-form-store';
import type { MneFormInput, MneFormRow } from '../src/mne-form-store';
import { MneObligationRuleStore } from '../src/mne-obligation-rule-store';
import type { MneRuleInput, MneRuleRow } from '../src/mne-obligation-rule-store';
import { MneObligationStore } from '../src/mne-obligation-store';
import type { MneObligationRow } from '../src/mne-obligation-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const forms = new MneFormStore();
const rules = new MneObligationRuleStore();
const obligations = new MneObligationStore();

const MAKER = 1;
const CHECKER = 2;
const WORKER = '00000000-0000-4000-8000-000000000000';
const ROOT = 1;
const INVESTORS = [2, 3, 4];
const OTHER_BRANCH = 5;
const COMMITTEE = 6;
const LEGAL_BASIS = 'Circular 44/2026/TT-BTC [CXN-10]';
const TODAY = '2026-06-01';
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });
const calendarEntry = BASELINE_PACK.entries.find((entry) => entry.masterType === 'CALENDAR') as BaselineEntry;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(MAKER)), work);
const asWorker = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function seedTemplate(code: string, tenant = TENANT_A): Promise<void> {
  const [profile] = await owner<{ id: string }>("select id from machvon.document_layout_profile where profile_code = 'ND30_A4_STANDARD'", [], tenant);
  await owner(
    `insert into machvon.document_template
       (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, watermark_text,
        origin, content_sha256, effective_from, status, published_at, created_by, updated_by)
     values ($1, $2, $3, 1, 'REPORT_MONITORING', 'BC', 'Template', $4, '[{"kind":"paragraph","text":"{{body}}"}]'::jsonb, '{"required":["body"]}'::jsonb, 'Legal basis', 'Waiting',
        'PLATFORM_PACK', repeat('c', 64), '2026-01-01', 'PUBLISHED', now(), $5, $5)`,
    [tenant, randomUUID(), code, (profile as { id: string }).id, memberId(MAKER)],
    tenant,
  );
}

const formInput = (formCode: string, overrides: Partial<MneFormInput> = {}): MneFormInput => ({
  formCode,
  title: 'Overall report',
  reportKind: 'OVERALL_SEMIANNUAL',
  legalBasis: LEGAL_BASIS,
  effectiveFrom: '2026-01-01',
  schemaJson: { tables: [] },
  docTemplateCode: 'MNE-OBLIGATION-TEMPLATE',
  exportFormats: ['XLSX'],
  ...overrides,
});
const publishedForm = async (formCode: string, overrides: Partial<MneFormInput> = {}, tenant = TENANT_A): Promise<MneFormRow> => {
  const draft = await as((tx) => forms.create(tx, formInput(formCode, overrides), memberId(MAKER)), tenant);
  return (await harness.tenants.withTenant(contextFor(tenant, memberId(CHECKER)), (tx) => forms.publish(tx, draft.id, draft.version, memberId(CHECKER)))).record;
};

const ruleInput = (formId: string, ruleCode: string, overrides: Partial<MneRuleInput> = {}): MneRuleInput => ({
  ruleCode,
  formId,
  reportingRole: 'INVESTOR',
  recipient: 'Department of Finance',
  frequency: 'SEMIANNUAL',
  dueRuleJson: { period: 'H1', month: 7, day: 10 },
  legalBasis: LEGAL_BASIS,
  effectiveFrom: '2026-01-01',
  ...overrides,
});
const publishedRule = async (formId: string, ruleCode: string, overrides: Partial<MneRuleInput> = {}, tenant = TENANT_A): Promise<MneRuleRow> => {
  const draft = await as((tx) => rules.create(tx, ruleInput(formId, ruleCode, overrides), memberId(MAKER)), tenant);
  return (await harness.tenants.withTenant(contextFor(tenant, memberId(CHECKER)), (tx) => rules.publish(tx, draft.id, draft.version, memberId(CHECKER)))).record;
};

const generate = (year: number, extra: { scopeUnitId?: string; scope?: ScopeBuilder; today?: string } = {}, tenant = TENANT_A) =>
  as((tx) => obligations.generate(tx, { year, today: extra.today ?? TODAY, actor: memberId(MAKER), scope: extra.scope ?? EVERYTHING, scopeUnitId: extra.scopeUnitId }), tenant);
const listAll = (filter: { reportYear?: number; scopeUnitId?: string; status?: string } = {}, scope: ScopeBuilder = EVERYTHING, today = TODAY, tenant = TENANT_A): Promise<MneObligationRow[]> =>
  as((tx) => obligations.list(tx, filter, { limit: 500 }, scope, today), tenant);
const shells = async (tenant = TENANT_A): Promise<number> => Number((await owner<{ n: string }>('select count(*)::text as n from machvon.mne_report', [], tenant))[0]?.n);
const reset = (tenant = TENANT_A): Promise<unknown[]> =>
  harness.owner(tenant, [['delete from machvon.mne_report'], ['delete from machvon.mne_obligation_rule'], ['delete from machvon.mne_report_form'], ['delete from machvon.work_calendar_version']]);

/** The two rules of the design (OVERALL_SEMIANNUAL before 10 July, OVERALL_ANNUAL before 10 February of the next year) for the investors. */
async function publishDesignRules(): Promise<{ half: MneRuleRow; year: MneRuleRow; halfForm: MneFormRow; yearForm: MneFormRow }> {
  const halfForm = await publishedForm('TT44-M02');
  const yearForm = await publishedForm('TT44-M03', { reportKind: 'OVERALL_ANNUAL' });
  const half = await publishedRule(halfForm.id, 'OVERALL_SEMIANNUAL');
  const year = await publishedRule(yearForm.id, 'OVERALL_ANNUAL', { dueRuleJson: { period: 'YEAR', month: 2, day: 10, year_offset: 1 }, frequency: 'ANNUAL' });
  return { half, year, halfForm, yearForm };
}

describe('MneObligationStore (the filing calendar, ST-MNE-001, MNE F2, BR-MNE-02, BR-MNE-03)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        ...INVESTORS.map((n) => ({ n, path: `/${unitId(ROOT)}/${unitId(n)}/`, parent: ROOT })),
        { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
        { n: COMMITTEE, path: `/${unitId(COMMITTEE)}/` },
      ]);
      for (const member of [MAKER, CHECKER]) await harness.seedMembership(tenant, member, ROOT);
      await owner('update machvon.organization_unit set is_investor = true where id = any($1::uuid[])', [INVESTORS.map(unitId)], tenant);
      await owner("update machvon.organization_unit set unit_type = 'GOVERNING_BODY' where id = $1", [unitId(COMMITTEE)], tenant);
      await harness.tenants.withTenant(contextFor(tenant, memberId(MAKER)), (tx) => new DocumentStore().seedDefaults(tx, memberId(MAKER)));
      await seedTemplate('MNE-OBLIGATION-TEMPLATE', tenant);
    }
    // The reporting calendar of tenant A (MDM, CALENDAR) for the weekly reports; tenant B has none.
    await asWorker((tx) => applyBaseline(tx, sealPack('MNE-A-1', [calendarEntry]), WORKER));
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    await reset();
    await reset(TENANT_B);
  });

  describe('half-year and yearly obligations', () => {
    it('AC-ST-MNE-001-1: generates H1 due 2026-07-10 and YEAR due 2027-02-10 for every investor with the CXN label, and a second run adds nothing', async () => {
      const { half, year } = await publishDesignRules();
      const first = await generate(2026);
      expect(first).toEqual({ created: 6, existing: 0, periods: 2, unresolvedRoles: [] });
      const rows = await listAll({ reportYear: 2026 });
      expect(rows).toHaveLength(6);
      for (const unit of INVESTORS) {
        const own = rows.filter((row) => row.scopeUnitId === unitId(unit));
        expect(own.map((row) => [row.periodLabel, row.dueDate, row.ruleCode, row.formCode])).toEqual([
          ['H1-2026', '2026-07-10', 'OVERALL_SEMIANNUAL', 'TT44-M02'],
          ['YEAR-2026', '2027-02-10', 'OVERALL_ANNUAL', 'TT44-M03'],
        ]);
      }
      const label = rows[0] as MneObligationRow;
      expect(label).toMatchObject({ status: 'DRAFT', reportingRole: 'INVESTOR', recipient: 'Department of Finance', ruleLegalBasis: LEGAL_BASIS, ruleLegalConfirmationRef: null, formLegalConfirmationRef: null, ruleRevision: 1, formRevision: 1 });
      expect(label.obligationRuleId).toBe(half.id);
      expect(rows.find((row) => row.periodLabel === 'YEAR-2026')?.obligationRuleId).toBe(year.id);
      const second = await generate(2026);
      expect(second).toEqual({ created: 0, existing: 6, periods: 2, unresolvedRoles: [] });
      expect(await shells()).toBe(6);
    });

    it('writes DRAFT shells with an empty payload and no snapshot, signed by the actor', async () => {
      await publishDesignRules();
      await generate(2026);
      const [row] = await owner<{ status: string; payload_json: unknown; snapshot_id: string | null; project_id: string | null; revision: number; created_by: string; is_late: boolean }>(
        'select status, payload_json, snapshot_id, project_id, revision, created_by, is_late from machvon.mne_report limit 1',
      );
      expect(row).toEqual({ status: 'DRAFT', payload_json: {}, snapshot_id: null, project_id: null, revision: 1, created_by: memberId(MAKER), is_late: false });
    });

    it('writes only what is missing: a new investor gets the obligations of a year already generated', async () => {
      await publishDesignRules();
      await generate(2026);
      await owner('update machvon.organization_unit set is_investor = true where id = $1', [unitId(COMMITTEE)]);
      try {
        expect(await generate(2026)).toMatchObject({ created: 2, existing: 6 });
      } finally {
        await owner('update machvon.organization_unit set is_investor = false where id = $1', [unitId(COMMITTEE)]);
      }
    });

    it('two runs that race write each shell once', async () => {
      await publishDesignRules();
      const runs = await Promise.all([generate(2026), generate(2026), generate(2026)]);
      expect(runs.reduce((sum, run) => sum + run.created, 0)).toBe(6);
      expect(await shells()).toBe(6);
    });

    it('UAT-AC286: uses the form revision and the rule revision in force on the last day of each period (BR-MNE-02)', async () => {
      const first = await publishedForm('TT44-M02', { effectiveFrom: '2026-01-01' });
      const second = await publishedForm('TT44-M02', { effectiveFrom: '2027-01-01', title: 'Overall report, revision 2' });
      const r1 = await publishedRule(first.id, 'OVERALL_SEMIANNUAL', { effectiveFrom: '2026-01-01' });
      const r2 = await publishedRule(second.id, 'OVERALL_SEMIANNUAL', { effectiveFrom: '2027-01-01', dueRuleJson: { period: 'H1', month: 7, day: 15 } });
      await generate(2026);
      await generate(2027);
      const rows = await listAll();
      expect(rows.filter((row) => row.reportYear === 2026).map((row) => [row.formRevision, row.ruleRevision, row.dueDate, row.obligationRuleId])).toEqual(
        INVESTORS.map(() => [1, 1, '2026-07-10', r1.id]),
      );
      expect(rows.filter((row) => row.reportYear === 2027).map((row) => [row.formRevision, row.ruleRevision, row.dueDate, row.obligationRuleId])).toEqual(
        INVESTORS.map(() => [2, 2, '2027-07-15', r2.id]),
      );
    });

    it('a rule that ended before the end of the period does not give an obligation for it', async () => {
      const form = await publishedForm('TT44-M02');
      await publishedRule(form.id, 'OVERALL_SEMIANNUAL', { effectiveFrom: '2026-01-01', effectiveUntil: '2026-06-30' });
      expect(await refusal(generate(2026))).toEqual({ code: 'NO_EFFECTIVE_RULE', status: 422, detail: 'report_year' });
      expect(await shells()).toBe(0);
    });

    it('UAT-AC296: refuses the year when the form of a rule in force is not effective on the last day of the period (422 FORM_NOT_EFFECTIVE)', async () => {
      const form = await publishedForm('TT44-M02', { effectiveFrom: '2026-01-01', effectiveUntil: '2026-06-01' });
      await publishedRule(form.id, 'OVERALL_SEMIANNUAL', { effectiveFrom: '2026-01-01' });
      expect(await refusal(generate(2026))).toEqual({ code: 'FORM_NOT_EFFECTIVE', status: 422, detail: 'form_code' });
      // Nothing is written by a run that fails.
      expect(await shells()).toBe(0);
    });

    it('moves a deadline that falls on a day off to the next working day only when the rule says so (BR-MNE-03)', async () => {
      const form = await publishedForm('TT44-M02');
      const other = await publishedForm('TT44-M03');
      await publishedRule(form.id, 'PLAIN', { dueRuleJson: { period: 'H1', month: 7, day: 11 } });
      await publishedRule(other.id, 'SHIFTED', { dueRuleJson: { period: 'H1', month: 7, day: 11, shift_on_holiday: true, calendar_code: 'WORKDAY_VN' } });
      await owner(
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, $2, 'WORKDAY_VN', 2026, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, randomUUID(), memberId(MAKER)],
      );
      await generate(2026);
      const rows = await listAll({ scopeUnitId: unitId(2) });
      // 2026-07-11 is a Saturday: the plain rule keeps it, the shifting one files on Monday 13 July.
      expect(rows.map((row) => [row.ruleCode, row.dueDate])).toEqual([
        ['PLAIN', '2026-07-11'],
        ['SHIFTED', '2026-07-13'],
      ]);
    });

    it('refuses a shifting rule whose working calendar is not published for the year (422 CALENDAR_NOT_EFFECTIVE)', async () => {
      const form = await publishedForm('TT44-M02');
      await publishedRule(form.id, 'SHIFTED', { dueRuleJson: { period: 'H1', month: 7, day: 11, shift_on_holiday: true, calendar_code: 'NO_SUCH_CALENDAR' } });
      expect(await refusal(generate(2026))).toEqual({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422, detail: 'calendar_code' });
    });

    it('ignores the rules that wait for an event of a project (the obligation is made when the event happens)', async () => {
      const form = await publishedForm('TT44-M04', { reportKind: 'PROJECT_START' });
      await publishedRule(form.id, 'START', { frequency: 'EVENT', dueRuleJson: { event: 'PROJECT_START', days_after: 30 } });
      expect(await refusal(generate(2026))).toMatchObject({ code: 'NO_EFFECTIVE_RULE' });
    });

    it('refuses a year that no rule covers and a year that is not a year', async () => {
      expect(await refusal(generate(2026))).toEqual({ code: 'NO_EFFECTIVE_RULE', status: 422, detail: 'report_year' });
      await publishDesignRules();
      for (const year of [1999, 3000, 2026.5]) expect(await refusal(generate(year))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'report_year' });
    });
  });

  describe('who owes a report', () => {
    it('writes the obligations of the committee, the owner agencies of projects and tells which role no unit holds', async () => {
      const form = await publishedForm('TT44-M02');
      await publishedRule(form.id, 'COMMITTEE', { reportingRole: 'PROVINCIAL_PEOPLE_COMMITTEE', recipient: 'Ministry of Finance' });
      await publishedRule(form.id, 'OWNERS', { reportingRole: 'PROJECT_OWNER_AGENCY' });
      await publishedRule(form.id, 'PLANNING', { reportingRole: 'PLANNING_AGENCY' });
      const admin = new Client({ connectionString: harness.database.adminUrl });
      await admin.connect();
      try {
        await admin.query('set session_replication_role = replica');
        await admin.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
           values ($1, $2, 'P1', 'Project 1', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1), ($1, $5, 'P2', 'Project 2', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1), ($1, $6, 'P3', 'Project 3', $7, $4, 'INTERNAL', 1000, 'CONCEPT', 1)`,
          [TENANT_A, randomUUID(), unitId(OTHER_BRANCH), randomUUID(), randomUUID(), randomUUID(), unitId(3)],
        );
      } finally {
        await admin.end();
      }
      const result = await generate(2026);
      // One unit for the committee, two distinct owner units for three projects, none for the planning agency.
      expect(result).toEqual({ created: 3, existing: 0, periods: 3, unresolvedRoles: ['PLANNING_AGENCY'] });
      const rows = await listAll();
      expect(rows.filter((row) => row.ruleCode === 'COMMITTEE').map((row) => [row.scopeUnitId, row.recipient])).toEqual([[unitId(COMMITTEE), 'Ministry of Finance']]);
      expect(rows.filter((row) => row.ruleCode === 'OWNERS').map((row) => row.scopeUnitId).sort()).toEqual([unitId(3), unitId(OTHER_BRANCH)].sort());
      await owner("delete from machvon.project where tenant_id = $1", [TENANT_A]);
    });

    it('does not oblige a unit that is no longer active', async () => {
      await publishDesignRules();
      await owner("update machvon.organization_unit set status = 'Dissolved' where id = $1", [unitId(2)]);
      try {
        expect((await generate(2026)).created).toBe(4);
      } finally {
        await owner("update machvon.organization_unit set status = 'Active' where id = $1", [unitId(2)]);
      }
    });
  });

  describe('the scope of the caller', () => {
    const branch: ScopeBuilder = (first) => ({ sql: `starts_with(u.path, $${first})`, params: [`/${unitId(ROOT)}/`] });
    const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });

    it('generates and lists only for the units of the scope', async () => {
      await publishDesignRules();
      await owner('update machvon.organization_unit set is_investor = true where id = $1', [unitId(OTHER_BRANCH)]);
      try {
        expect(await generate(2026, { scope: branch })).toMatchObject({ created: 6 });
        expect(await owner('select distinct scope_unit_id from machvon.mne_report order by 1')).toHaveLength(3);
        // The other branch is not generated by a caller who does not reach it, and does not see what another caller generated for it.
        expect(await generate(2026)).toMatchObject({ created: 2, existing: 6 });
        expect(await listAll({}, branch)).toHaveLength(6);
        expect(await listAll({}, EVERYTHING)).toHaveLength(8);
        expect(await listAll({}, nothing)).toEqual([]);
      } finally {
        await owner('update machvon.organization_unit set is_investor = false where id = $1', [unitId(OTHER_BRANCH)]);
      }
    });

    it('narrows a run to one unit, refuses a unit outside the scope (403) and a unit nobody knows (422)', async () => {
      await publishDesignRules();
      expect(await generate(2026, { scopeUnitId: unitId(3) })).toMatchObject({ created: 2, existing: 0 });
      expect(await owner('select distinct scope_unit_id from machvon.mne_report')).toEqual([{ scope_unit_id: unitId(3) }]);
      expect(await refusal(generate(2026, { scopeUnitId: unitId(OTHER_BRANCH), scope: branch }))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(generate(2026, { scopeUnitId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'scope_unit_id' });
    });

    it('keeps the calendar of a tenant out of the other (AC-ST-MNE-001-1 for a second tenant)', async () => {
      await publishDesignRules();
      await generate(2026);
      expect(await listAll({}, EVERYTHING, TODAY, TENANT_B)).toEqual([]);
      const form = await publishedForm('TT44-M02', {}, TENANT_B);
      await publishedRule(form.id, 'OVERALL_SEMIANNUAL', {}, TENANT_B);
      expect(await generate(2026, {}, TENANT_B)).toMatchObject({ created: 3 });
      expect(await shells(TENANT_A)).toBe(6);
    });
  });

  describe('weekly obligations from the reporting calendar', () => {
    it('writes one shell per week of the calendar in force, due on the weekday of the rule', async () => {
      const form = await publishedForm('CV3665-WEEKLY', { reportKind: 'WEEKLY_QUICK', docTemplateCode: 'MNE-OBLIGATION-TEMPLATE' });
      await publishedRule(form.id, 'WEEKLY_QUICK', { reportingRole: 'PROVINCIAL_PEOPLE_COMMITTEE', frequency: 'WEEKLY', recipient: 'Ministry of Finance', dueRuleJson: { weekly: 'FRI', time: '16:00' } });
      const result = await generate(2027, { today: '2026-12-15' });
      const weeks = reportingPeriods({ weekStartsOn: 'SATURDAY', deadlineWeekday: 'FRIDAY', deadlineTime: '10:00', timezone: 'Asia/Ho_Chi_Minh' }, 2027);
      expect(result).toMatchObject({ created: weeks.length, existing: 0, periods: weeks.length });
      const rows = await listAll({ reportYear: 2027 });
      expect(rows.map((row) => row.periodLabel).sort()).toEqual(weeks.map((week) => week.code).sort());
      for (const row of rows) expect(new Date(`${row.dueDate}T00:00:00Z`).getUTCDay()).toBe(5);
      expect(rows[0]).toMatchObject({ reportingRole: 'PROVINCIAL_PEOPLE_COMMITTEE', formCode: 'CV3665-WEEKLY', scopeUnitId: unitId(COMMITTEE) });
      expect((await generate(2027, { today: '2026-12-15' })).created).toBe(0);
    });

    it('refuses a weekly rule when the tenant has no reporting calendar (422 CALENDAR_NOT_EFFECTIVE)', async () => {
      const form = await publishedForm('CV3665-WEEKLY', { reportKind: 'WEEKLY_QUICK' }, TENANT_B);
      await publishedRule(form.id, 'WEEKLY_QUICK', { reportingRole: 'PROVINCIAL_PEOPLE_COMMITTEE', frequency: 'WEEKLY', dueRuleJson: { weekly: 'FRI' } }, TENANT_B);
      expect(await refusal(generate(2027, { today: '2026-12-15' }, TENANT_B))).toEqual({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422, detail: 'calendar' });
    });
  });

  describe('reading the calendar', () => {
    it('pages by due date, filters by year, unit and status and counts the days late today (BR-MNE-04)', async () => {
      await publishDesignRules();
      await generate(2026);
      const all = await listAll();
      expect(all.map((row) => row.dueDate)).toEqual([...all.map((row) => row.dueDate)].sort());
      const first = await as((tx) => obligations.list(tx, {}, { limit: 4 }, EVERYTHING, TODAY));
      const next = await as((tx) => obligations.list(tx, {}, { limit: 4, after: { dueDate: (first[3] as MneObligationRow).dueDate, id: (first[3] as MneObligationRow).id } }, EVERYTHING, TODAY));
      expect([...first, ...next].map((row) => row.id)).toEqual(all.map((row) => row.id).slice(0, first.length + next.length));
      expect(await listAll({ reportYear: 2027 })).toEqual([]);
      expect(await listAll({ status: 'APPROVED' })).toEqual([]);
      expect(await listAll({ scopeUnitId: unitId(4) })).toHaveLength(2);
      // On 12 July the half-year reports are 2 days late, the yearly ones are not due yet.
      const late = await listAll({ scopeUnitId: unitId(4) }, EVERYTHING, '2026-07-12');
      expect(late.map((row) => [row.periodLabel, row.isLate, row.daysLate])).toEqual([['H1-2026', true, 2], ['YEAR-2026', false, 0]]);
      // The due day itself is still in time.
      expect((await listAll({ scopeUnitId: unitId(4) }, EVERYTHING, '2026-07-10'))[0]).toMatchObject({ isLate: false, daysLate: 0 });
    });

    it('does not count today for a report that was filed: the filing decides', async () => {
      await publishDesignRules();
      await generate(2026);
      const file = (unit: number, late: boolean) =>
        owner("update machvon.mne_report set status = 'SUBMITTED_EXTERNAL', is_late = $3, doc_document_id = $1, payload_sha256 = repeat('a', 64) where scope_unit_id = $2 and period_label = 'H1-2026'", [randomUUID(), unitId(unit), late]);
      await file(2, false);
      await file(3, true);
      const rows = await listAll({}, EVERYTHING, '2027-01-01');
      const h1 = (unit: number): MneObligationRow | undefined => rows.find((row) => row.scopeUnitId === unitId(unit) && row.periodLabel === 'H1-2026');
      expect(h1(2)).toMatchObject({ status: 'SUBMITTED_EXTERNAL', isLate: false, daysLate: 0 });
      // The day of the filing is not kept by this table, so a late filing has no count of days here.
      expect(h1(3)).toMatchObject({ status: 'SUBMITTED_EXTERNAL', isLate: true, daysLate: null });
      expect(h1(4)).toMatchObject({ status: 'DRAFT', isLate: true, daysLate: 175 });
    });
  });
});
