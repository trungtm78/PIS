import { randomUUID } from 'node:crypto';
import { fileSha256, importMappingOf, defaultGovernanceRule, validateRuleParams } from '@machvon/kernel';
import type { ImportMapping, IndicatorEntry } from '@machvon/kernel';
import { IndImportAdapter } from '../src/ind-import';
import { IndDictionaryStore, IndEntryRuleStore, IndFigureStore, IndMappingStore } from '../src/ind-store';
import { FileImportStore } from '../src/file-import-store';
import { previewFileImport } from '../src/file-import-preview';
import type { TenantTx } from '../src/tenant-database';
import { seedAs, seedBidPackage, everything, nothing } from './support/bid-proposal-fixtures';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const dictionary = new IndDictionaryStore();
const entryRules = new IndEntryRuleStore();
const mappings = new IndMappingStore();
const figures = new IndFigureStore();
const imports = new FileImportStore();
const MAKER = 1;
const CHECKER = 2;
const NOW = new Date('2026-11-08T03:00:00Z');
const DAY = '2026-11-08';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const bytes = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

const versions = new Map<string, number>();
/** An approved version of a rule, made by the maker and approved by the checker, in force from the day (or the day given). */
async function approveRule(type: string, code: string, params: Record<string, unknown>, options: { from?: string; to?: string | null; status?: 'APPROVED' | 'RETIRED' } = {}): Promise<string> {
  const key = `${type}/${code}`;
  const version = (versions.get(key) ?? 0) + 1;
  versions.set(key, version);
  const id = randomUUID();
  const status = options.status ?? 'APPROVED';
  await owner(
    `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, effective_to, reason, created_by, submitted_by, submitted_at, approved_by, approved_at, retired_by, retired_at, retire_reason)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::date, $9::date, 'Test approval of the rule', $10, $10, now(), $11, now(), $12, $13::timestamptz, $14)`,
    [TENANT_A, id, type, code, version, status, JSON.stringify(params), options.from ?? '2026-01-01', options.to ?? null, memberId(MAKER), memberId(CHECKER), status === 'RETIRED' ? memberId(CHECKER) : null, status === 'RETIRED' ? new Date().toISOString() : null, status === 'RETIRED' ? 'Test retirement' : null],
  );
  return id;
}

async function seedPeriod(code: string, status: 'OPEN' | 'LOCKED' = 'OPEN'): Promise<string> {
  const id = randomUUID();
  await seedAs(harness, [
    [
      status === 'OPEN'
        ? `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
           values ($1, $2, $3, 1, date '2026-10-01', date '2026-10-31', date '2026-11-05' + interval '3 hours', $4, 'MONTH', 2026, 'OPEN', gen_random_uuid(), $5, $5)`
        : `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by, soft_closed_at, locked_at, locked_by)
           values ($1, $2, $3, 1, date '2026-09-01', date '2026-09-30', date '2026-10-05' + interval '3 hours', $4, 'MONTH', 2026, 'LOCKED', gen_random_uuid(), $5, $5, now(), now(), $5)`,
      [TENANT_A, id, code, `CAL-${code}`, memberId(MAKER)],
    ],
  ]);
  return id;
}

const total = (projectId: string): Promise<string | undefined> => as((tx) => figures.totalInvestment(tx, projectId));
const entered = async (code: string): Promise<IndicatorEntry> => {
  const found = await as((tx) => dictionary.find(tx, code, DAY));
  if (found === undefined) throw new Error(`no indicator ${code}`);
  return found;
};

const MAPPING_COLUMNS = {
  name: 'Form with a row for each project',
  layout: 'COLUMNS',
  number_format: 'VN',
  project_column: 'Project',
  period_column: 'Period',
  lines: [
    { indicator: 'TOTAL_INVESTMENT', source: 'Total investment', scale: 'ONE' },
    { indicator: 'EQUITY_CAPITAL', source: 'Equity', scale: 'ONE' },
    { indicator: 'LOAN_CAPITAL', source: 'Loan', scale: 'ONE' },
    { indicator: 'CUMULATIVE_YTD', source: 'Cumulative', scale: 'ONE' },
  ],
};

describe('the indicator dictionary, the rules at entry, the mappings and the figures (IND-1)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
      for (const member of [MAKER, CHECKER]) await harness.seedMembership(tenant, member, 1);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the dictionary', () => {
    it('lists the starting indicators as defaults and puts an approved version of the tenant ahead of its default, with who made and approved it', async () => {
      const before = await as((tx) => dictionary.list(tx, DAY, { enterable: true }));
      expect(before.map((one) => one.code)).toContain('TOTAL_INVESTMENT');
      expect(before.every((one) => one.origin === 'DEFAULT' && one.unverified)).toBe(true);
      const ruleId = await approveRule('KPI_DEFINITION', 'TOTAL_INVESTMENT', { ...validateRuleParams('KPI_DEFINITION', (defaultGovernanceRule('KPI_DEFINITION', 'TOTAL_INVESTMENT') as { params: Record<string, unknown> }).params), vat_basis: 'EXCLUDING_VAT' });
      const after = await entered('TOTAL_INVESTMENT');
      expect(after).toMatchObject({ origin: 'RULE', version: 1, vatBasis: 'EXCLUDING_VAT', ruleId, unverified: false });
      const history = await as((tx) => dictionary.versions(tx, 'TOTAL_INVESTMENT'));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ version: 1, status: 'APPROVED', createdBy: memberId(MAKER), approvedBy: memberId(CHECKER) });
    });

    it('does not show the dictionary of one tenant to another and finds nothing for a code nobody defined', async () => {
      expect(await as((tx) => dictionary.find(tx, 'NO_SUCH_CODE', DAY))).toBeUndefined();
      const other = await as((tx) => dictionary.find(tx, 'TOTAL_INVESTMENT', DAY), MAKER, TENANT_B);
      expect(other).toMatchObject({ origin: 'DEFAULT', version: 0 });
    });
  });

  describe('the rules at entry', () => {
    it('keeps the starting rules as templates: with none approved an entry sees no rule and is never blocked', async () => {
      const catalogue = await as((tx) => entryRules.catalogue(tx, DAY));
      expect(catalogue.find((view) => view.rule.code === 'CUMULATIVE_NOT_ABOVE_TOTAL')).toMatchObject({ origin: 'DEFAULT', active: false, unverified: true });
      expect(catalogue.some((view) => view.active)).toBe(false);
      const verdict = await as((tx) => entryRules.check(tx, { surface: 'DIS_REPORT', asOf: DAY, facts: { values: { CUMULATIVE: '9', TOTAL_INVESTMENT: '1' } } }));
      expect(verdict).toEqual({ violations: [], blocking: [], warnings: [], evaluated: [], skipped: [] });
    });

    it('holds an entry to the rule once the tenant approved it, on the surfaces the rule names, from the day it is in force', async () => {
      const params = validateRuleParams('DATA_ENTRY_RULE', { check: 'CUMULATIVE_NOT_ABOVE_TOTAL', severity: 'BLOCK', fields: ['CUMULATIVE'], total_field: 'TOTAL_INVESTMENT', message: 'Cumulative above the total', surfaces: ['DIS_REPORT'] });
      await approveRule('DATA_ENTRY_RULE', 'CUMULATIVE_NOT_ABOVE_TOTAL', params);
      const over = await as((tx) => entryRules.check(tx, { surface: 'DIS_REPORT', asOf: DAY, facts: { values: { CUMULATIVE: '9', TOTAL_INVESTMENT: '1' } } }));
      expect(over.blocking).toHaveLength(1);
      expect(over.blocking[0]).toMatchObject({ ruleCode: 'CUMULATIVE_NOT_ABOVE_TOTAL', ruleVersion: 1, message: 'Cumulative above the total' });
      const otherSurface = await as((tx) => entryRules.check(tx, { surface: 'PRJ_PROJECT', asOf: DAY, facts: { values: { CUMULATIVE: '9', TOTAL_INVESTMENT: '1' } } }));
      expect(otherSurface.violations).toEqual([]);
      const before = await as((tx) => entryRules.check(tx, { surface: 'DIS_REPORT', asOf: '2025-12-31', facts: { values: { CUMULATIVE: '9', TOTAL_INVESTMENT: '1' } } }));
      expect(before.violations).toEqual([]);
      const catalogue = await as((tx) => entryRules.catalogue(tx, DAY));
      expect(catalogue.find((view) => view.rule.code === 'CUMULATIVE_NOT_ABOVE_TOTAL')).toMatchObject({ origin: 'RULE', active: true, effectiveFrom: '2026-01-01' });
    });

    it('reads the mandatory fields of the dictionary for a rule that asks for them, and a version that was stopped no longer holds', async () => {
      await approveRule('DATA_ENTRY_RULE', 'MANDATORY_FIELDS', validateRuleParams('DATA_ENTRY_RULE', { check: 'FIELD_REQUIRED', severity: 'BLOCK', fields: ['MANDATORY_FIELDS'], message: 'Fields are required', surfaces: ['INDICATOR_ENTRY'] }));
      const missing = await as((tx) => entryRules.check(tx, { surface: 'INDICATOR_ENTRY', asOf: DAY, facts: { values: { PLAN_YEAR: '5' } } }));
      expect(missing.blocking[0]?.fields).toEqual(['CUMULATIVE']);
      await approveRule('DATA_ENTRY_RULE', 'RETIRED_ONE', validateRuleParams('DATA_ENTRY_RULE', { check: 'FIELD_REQUIRED', severity: 'BLOCK', fields: ['PLAN_YEAR'], message: 'Plan is required' }), { from: '2026-01-01', to: '2026-06-30', status: 'RETIRED' });
      const later = await as((tx) => entryRules.check(tx, { surface: 'INDICATOR_ENTRY', asOf: DAY, facts: { values: { CUMULATIVE: '1' } } }));
      expect(later.violations).toEqual([]);
      expect((await as((tx) => entryRules.inForce(tx, DAY))).map((rule) => rule.code)).toEqual(['CUMULATIVE_NOT_ABOVE_TOTAL', 'MANDATORY_FIELDS']);
    });
  });

  describe('the mappings', () => {
    it('lists the samples as templates, refuses a file read through one, and takes an approved mapping with its version and approver', async () => {
      const catalogue = await as((tx) => mappings.catalogue(tx, DAY));
      expect(catalogue.map((view) => view.mapping.code)).toEqual(expect.arrayContaining(['SAMPLE_COLUMNS_FORM', 'SAMPLE_ROWS_FORM']));
      expect(catalogue.every((view) => !view.active)).toBe(true);
      expect(await refusal(as((tx) => mappings.approved(tx, 'SAMPLE_COLUMNS_FORM', DAY)))).toMatchObject({ code: 'IND_MAPPING_NOT_APPROVED', status: 409 });
      expect(await refusal(as((tx) => mappings.approved(tx, 'NO_SUCH_FORM', DAY)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const ruleId = await approveRule('INDICATOR_IMPORT_MAPPING', 'MONTHLY_FORM', validateRuleParams('INDICATOR_IMPORT_MAPPING', MAPPING_COLUMNS));
      const approved = await as((tx) => mappings.approved(tx, 'MONTHLY_FORM', DAY));
      expect(approved).toMatchObject({ code: 'MONTHLY_FORM', version: 1, ruleId, origin: 'RULE', unverified: false });
      const history = await as((tx) => mappings.versions(tx, 'MONTHLY_FORM'));
      expect(history[0]).toMatchObject({ approvedBy: memberId(CHECKER), createdBy: memberId(MAKER) });
      const usage = await as(async (tx) => dictionary.usage(tx, await entered('LOAN_CAPITAL'), DAY));
      expect(usage.mappings).toEqual(expect.arrayContaining([{ code: 'MONTHLY_FORM', source: 'Loan', active: true }]));
    });
  });

  describe('the figures', () => {
    it('writes the first revision, skips the same value, asks a reason for a correction and keeps every revision', async () => {
      const { projectId } = await seedBidPackage(harness);
      const period = await seedPeriod('2026-10');
      const indicator = await entered('PLAN_YEAR');
      const write = (value: string, reason?: string) => as((tx) => figures.write(tx, { projectId, periodId: period, indicator, value, reason, source: { kind: 'ENTRY' } }, memberId(MAKER), NOW));
      const first = await write('1000');
      expect(first).toMatchObject({ kind: 'CREATED', row: { revision: 1, value: '1000', unit: 'VND', source: 'ENTRY', definitionVersion: 0, reason: null } });
      expect(await write('1000.0')).toMatchObject({ kind: 'UNCHANGED', row: { revision: 1 } });
      expect(await refusal(write('1200'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(write('1200', 'short'.slice(0, 4)))).toMatchObject({ detail: 'reason' });
      const revised = await write('1200', 'The adjusted plan was published');
      expect(revised).toMatchObject({ kind: 'REVISED', row: { revision: 2, value: '1200', reason: 'The adjusted plan was published' } });
      const history = await as((tx) => figures.history(tx, projectId, period, 'PLAN_YEAR'));
      expect(history.map((row) => [row.revision, row.value])).toEqual([[2, '1200'], [1, '1000']]);
      const current = await as((tx) => figures.current(tx, projectId, period));
      expect(current.get('PLAN_YEAR')).toMatchObject({ revision: 2, value: '1200' });
    });

    it('keeps the figures append-only for every role and money whole, and shows them only to their own tenant', async () => {
      const { projectId } = await seedBidPackage(harness);
      const period = await seedPeriod('2026-10-B');
      const indicator = await entered('EXECUTED_PERIOD');
      const row = (await as((tx) => figures.write(tx, { projectId, periodId: period, indicator, value: '77', source: { kind: 'ENTRY' } }, memberId(MAKER), NOW))).row;
      expect(await databaseRefusal(owner('update machvon.ind_figure set value = 78 where id = $1', [row.id]))).toMatch(/append-only/);
      expect(await databaseRefusal(owner('delete from machvon.ind_figure where id = $1', [row.id]))).toMatch(/append-only/);
      expect(await databaseRefusal(as((tx) => tx.query('update machvon.ind_figure set value = 78 where id = $1::uuid', [row.id])))).toMatch(/permission denied|append-only/);
      expect(await databaseRefusal(owner(`insert into machvon.ind_figure (tenant_id, id, project_id, period_id, indicator_code, revision, value, unit, definition_version, source, reason, entered_by) values ($1, gen_random_uuid(), $2, $3, 'EXECUTED_PERIOD', 9, 1.5, 'VND', 0, 'ENTRY', 'A reason in words', $4)`, [TENANT_A, projectId, period, memberId(MAKER)]))).toMatch(/ind_figure_whole_chk/);
      expect(await databaseRefusal(owner(`insert into machvon.ind_figure (tenant_id, id, project_id, period_id, indicator_code, revision, value, unit, definition_version, source, reason, entered_by) values ($1, gen_random_uuid(), $2, $3, 'EXECUTED_PERIOD', 9, 1, 'VND', 0, 'IMPORT', 'A reason in words', $4)`, [TENANT_A, projectId, period, memberId(MAKER)]))).toMatch(/ind_figure_import_chk/);
      expect((await as((tx) => figures.current(tx, projectId, period), MAKER, TENANT_B)).size).toBe(0);
    });

    it('reads the figures in the scope of the caller and the total investment of the register', async () => {
      const { projectId } = await seedBidPackage(harness);
      const period = await seedPeriod('2026-10-C');
      const indicator = await entered('DISBURSED_PERIOD');
      await as((tx) => figures.write(tx, { projectId, periodId: period, indicator, value: '5', source: { kind: 'ENTRY' } }, memberId(MAKER), NOW));
      expect((await as((tx) => figures.list(tx, { projectId }, everything, 50))).map((row) => row.indicatorCode)).toEqual(['DISBURSED_PERIOD']);
      expect(await as((tx) => figures.list(tx, { projectId }, nothing, 50))).toEqual([]);
      expect(await total(projectId)).toBe('1000');
      expect(await refusal(as((tx) => figures.project(tx, projectId, nothing, everything)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await refusal(as((tx) => figures.project(tx, projectId, everything, nothing)))).toMatchObject({ code: 'SCOPE_DENIED' });
    });
  });

  describe('the import of a form', () => {
    const mappingOf = async (): Promise<ImportMapping> => as((tx) => mappings.approved(tx, 'MONTHLY_FORM', DAY));
    const HEADER = 'Project,Period,Total investment,Equity,Loan,Cumulative';

    async function adapterFor(scope = everything, extra: { mapping?: ImportMapping; periodId?: string } = {}): Promise<IndImportAdapter> {
      const mapping = extra.mapping ?? (await mappingOf());
      const indicators = await as((tx) => dictionary.list(tx, DAY));
      const rules = await as((tx) => entryRules.inForce(tx, DAY, 'INDICATOR_IMPORT'));
      return new IndImportAdapter({ mapping, context: {}, indicators, rules, scope, actor: memberId(MAKER), now: NOW, periodId: extra.periodId });
    }

    const run = async (file: Uint8Array, adapter: IndImportAdapter) =>
      as((tx) => imports.run(tx, { adapter, bytes: file, fileObjectKey: `tenants/${TENANT_A}/import/${randomUUID()}`, expectedSha256: fileSha256(file), importedBy: memberId(MAKER), fallbackOwnerId: memberId(MAKER), correlationId: randomUUID(), now: NOW }));

    it('previews and applies a file: figures written with the file, the line and the version of the mapping, a repeat of the file changes nothing', async () => {
      const { projectCode, projectId } = await seedBidPackage(harness);
      const period = await seedPeriod('2026-10-D');
      const file = bytes(HEADER, `${projectCode},2026-10-D,"1.000","400","600","250"`);
      const preview = await as((tx) => adaptedPreview(tx, file));
      expect(preview.counts).toMatchObject({ total: 1, valid: 1, errors: 0 });
      expect(preview.rows[0]).toMatchObject({ status: 'VALID', outcome: 'CREATE', businessKey: `${projectCode}|2026-10-D` });
      expect(preview.formatVersion).toBe('MONTHLY_FORM.v1');
      const adapter = await adapterFor();
      const result = await run(file, adapter);
      expect(result).toMatchObject({ outcome: 'APPLIED', counts: { total: 1, applied: 1, quarantined: 0, differencesOpened: 0 } });
      expect(adapter.written).toEqual({ figures: 4, unchanged: 0, differences: 0 });
      const current = await as((tx) => figures.current(tx, projectId, period));
      expect([...current.keys()].sort()).toEqual(['CUMULATIVE_YTD', 'EQUITY_CAPITAL', 'LOAN_CAPITAL', 'TOTAL_INVESTMENT']);
      expect(current.get('LOAN_CAPITAL')).toMatchObject({ value: '600', source: 'IMPORT', importId: result.importId, importLine: 2, mappingCode: 'MONTHLY_FORM', mappingVersion: 1, revision: 1 });
      expect(await run(file, await adapterFor())).toMatchObject({ outcome: 'ALREADY_IMPORTED' });
      const again = await as((tx) => adaptedPreview(tx, file));
      expect(again.alreadyApplied).toBe(true);
    });

    async function adaptedPreview(tx: TenantTx, file: Uint8Array) {
      return previewFileImport(tx, await adapterFor(), file);
    }

    it('opens a difference for a figure that the register holds with another number, and never overwrites it', async () => {
      const { projectCode, projectId } = await seedBidPackage(harness);
      const period = await seedPeriod('2026-10-E');
      const indicator = await entered('EQUITY_CAPITAL');
      await as((tx) => figures.write(tx, { projectId, periodId: period, indicator, value: '300', source: { kind: 'ENTRY' } }, memberId(MAKER), NOW));
      const file = bytes(HEADER, `${projectCode},2026-10-E,"1.000","400","600","250"`);
      const preview = await as((tx) => adaptedPreview(tx, file));
      expect(preview.rows[0]).toMatchObject({ status: 'VALID', outcome: 'CREATE_AND_DIFFERENCE' });
      const result = await run(file, await adapterFor());
      expect(result.counts).toMatchObject({ applied: 1, differencesOpened: 1 });
      const current = await as((tx) => figures.current(tx, projectId, period));
      expect(current.get('EQUITY_CAPITAL')).toMatchObject({ value: '300', source: 'ENTRY', revision: 1 });
      expect(current.get('TOTAL_INVESTMENT')).toMatchObject({ value: '1000', source: 'IMPORT' });
      const items = await owner<{ code: string; expected: string; actual: string }>(`select code, expected_value as expected, actual_value as actual from machvon.file_import_reconciliation_item where import_id = $1`, [result.importId]);
      expect(items).toEqual([{ code: 'IND_FIGURE_DIFFERS', expected: '300', actual: '400' }]);
    });

    it('quarantines a row the register or the rules refuse, with its line, field and code', async () => {
      const { projectCode } = await seedBidPackage(harness);
      await seedPeriod('2026-10-F');
      await seedPeriod('2026-09-F', 'LOCKED');
      await approveRule('DATA_ENTRY_RULE', 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', validateRuleParams('DATA_ENTRY_RULE', { check: 'PARTS_EQUAL_TOTAL', severity: 'BLOCK', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL_INVESTMENT', tolerance: 0, message: 'Equity plus loan must equal the total', surfaces: ['INDICATOR_IMPORT'] }));
      const file = bytes(HEADER, `${projectCode},2026-10-F,"1.000","400","500","250"`, `NO-SUCH-PROJECT,2026-10-F,"1.000","400","600","250"`, `${projectCode},2026-12-X,"1.000","400","600","250"`, `${projectCode},2026-09-F,"1.000","400","600","250"`, `${projectCode},2026-10-F,"1.000","400","600","250"`);
      const adapter = await adapterFor();
      const result = await run(file, adapter);
      expect(result.counts).toMatchObject({ total: 5, applied: 1, quarantined: 4 });
      const refused = await as((tx) => imports.quarantined(tx, result.importId, 20));
      expect(refused.map((row) => `${row.line}:${row.errorCode}:${row.field}`).sort()).toEqual(['2:ENTRY_RULE_BLOCKED:EQUITY_PLUS_DEBT_EQUALS_TOTAL', '3:PROJECT_UNKNOWN:project', '4:PERIOD_UNKNOWN:period', '5:PERIOD_LOCKED:period']);
    });

    it('refuses a project outside the scope of the caller as unknown, and an indicator that is derived or not defined', async () => {
      const { projectCode } = await seedBidPackage(harness);
      await seedPeriod('2026-10-G');
      const file = bytes(HEADER, `${projectCode},2026-10-G,"1.000","400","600","250"`);
      const blind = await run(file, await adapterFor(nothing));
      expect(blind.counts).toMatchObject({ applied: 0, quarantined: 1 });
      const derived: ImportMapping = { ...importMappingOf(defaultGovernanceRule('INDICATOR_IMPORT_MAPPING', 'SAMPLE_COLUMNS_FORM') as NonNullable<ReturnType<typeof defaultGovernanceRule>>), code: 'WITH_DERIVED', ruleId: randomUUID(), version: 1 };
      const withDerived: ImportMapping = { ...derived, projectColumn: 'Project', periodColumn: 'Period', lines: [{ indicator: 'REMAINING_YEAR', source: 'Left', scale: 'ONE', required: false }, { indicator: 'NOT_DEFINED', source: 'Other', scale: 'ONE', required: false }] };
      const derivedFile = bytes('Project,Period,Left', `${projectCode},2026-10-G,5`);
      const refusedDerived = await run(derivedFile, await adapterFor(everything, { mapping: withDerived }));
      expect(refusedDerived.counts).toMatchObject({ applied: 0, quarantined: 1 });
      const refused = await as((tx) => imports.quarantined(tx, refusedDerived.importId, 5));
      expect(refused[0]).toMatchObject({ errorCode: 'INDICATOR_NOT_ENTERABLE', field: 'REMAINING_YEAR' });
    });
  });
});
