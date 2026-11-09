import {
  AGENCY_REQUEST_DEFAULT,
  CONFIG_CODE_PATTERN,
  DIS_WEEKLY_CODE,
  INTERNAL_OVERVIEW_DEFAULT,
  KPI_HOME_DEFAULTS,
  MOF_LAYOUTS,
  PROTECTED_RECEIVERS,
  REPORT_FORM_CATALOGUE,
  REPORT_LAYOUT_RULE_TYPE,
  builtInDefault,
  compileLayoutConfig,
  documentSheetOf,
  formDocumentOf,
  illustrativeLayoutData,
  layoutHashOf,
  refineLayoutConfig,
  ruleTypeOf,
  validateRuleParams,
} from '../src/index.ts';
import type { LayoutConfig, ReportIndicatorDefinition } from '../src/index.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const definitions: Record<string, ReportIndicatorDefinition> = Object.fromEntries(
  Object.entries(KPI_HOME_DEFAULTS).map(([code, one]) => {
    const params = one.params as { name: string; unit: ReportIndicatorDefinition['unit']; period: ReportIndicatorDefinition['period']; decimals: number };
    return [code, { code, name: params.name, unit: params.unit, decimals: params.decimals, period: params.period, version: 1 }];
  }),
);
const PERIOD = { kind: 'QUARTER', year: 2026, index: 3 } as const;
const CODE = 'CFG_AGENCY_REQUEST';

describe('the rule type REPORT_LAYOUT (R23)', () => {
  it('is registered with provenance and two starting layouts that pass their own schema', () => {
    const type = ruleTypeOf(REPORT_LAYOUT_RULE_TYPE);
    expect(type.ownerModule).toBe('RPT');
    expect(type.legalStatus).toBe('UNVERIFIED');
    expect(Object.keys(type.defaults).sort()).toEqual(['CFG_AGENCY_REQUEST', 'CFG_INTERNAL_OVERVIEW']);
    for (const code of Object.keys(type.defaults)) expect(() => validateRuleParams(REPORT_LAYOUT_RULE_TYPE, builtInDefault(REPORT_LAYOUT_RULE_TYPE, code)?.params)).not.toThrow();
    expect(type.codePattern).toBe(CONFIG_CODE_PATTERN);
  });

  it('keeps the codes of code-owned forms out: no official code fits the pattern and no official receiver is allowed', () => {
    const pattern = new RegExp(CONFIG_CODE_PATTERN);
    for (const entry of REPORT_FORM_CATALOGUE) expect(pattern.test(entry.code)).toBe(false);
    for (const layout of MOF_LAYOUTS) expect(pattern.test(layout.code)).toBe(false);
    expect(pattern.test(DIS_WEEKLY_CODE)).toBe(false);
    expect(PROTECTED_RECEIVERS).toEqual(expect.arrayContaining(['PVN', 'HPM', 'MOF']));
    const config = clone(AGENCY_REQUEST_DEFAULT);
    for (const receiver of ['PVN', 'hpm', 'MOF']) expect(refineLayoutConfig({ ...config, receiver })).toBe('receiver');
  });

  it('refuses a layout that is not a form: no indicators and no groups, repeats, columns without groups, a table with no name', () => {
    const base = clone(AGENCY_REQUEST_DEFAULT);
    expect(refineLayoutConfig(base as unknown as Record<string, unknown>)).toBeUndefined();
    const bad = (change: Partial<LayoutConfig>): string | undefined => refineLayoutConfig({ ...base, ...change } as unknown as Record<string, unknown>);
    expect(bad({ indicators: [], groups: [], columns: [] })).toBe('indicators');
    expect(bad({ indicators: [{ code: 'PLAN_TOTAL' }, { code: 'PLAN_TOTAL' }] })).toBe('indicators');
    expect(bad({ columns: [{ key: 'plan_year' }, { key: 'plan_year' }] })).toBe('columns');
    expect(bad({ groups: [{ key: 'a', title: 'A' }, { key: 'a', title: 'B' }] })).toBe('groups');
    expect(bad({ groups: [], columns: [{ key: 'plan_year' }] })).toBe('columns');
    expect(bad({ columns: [{ key: 'plan_year' }] })).toBe('columns');
    expect(bad({ columns: [{ key: 'project_name' }, { key: 'rate_year' }] })).toBe('columns');
    expect(bad({ agency: undefined })).toBe('agency');
    expect(bad({ kind: 'INTERNAL', receiver: 'INTERNAL' })).toBe('agency');
    expect(bad({ signatures: ['PREPARER', 'PREPARER'] })).toBe('signatures');
  });

  it('is judged by the schema of the rule store: unknown keys, an unknown column and a code that is not a code are refused', () => {
    const base = clone(AGENCY_REQUEST_DEFAULT);
    const check = (params: unknown): void => void validateRuleParams(REPORT_LAYOUT_RULE_TYPE, params);
    expect(() => check({ ...base, cells: [] })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
    expect(() => check({ ...base, columns: [{ key: 'free_cell' }] })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
    expect(() => check({ ...base, indicators: [{ code: 'lower case' }] })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
    expect(() => check({ ...base, groups: [{ key: 'Bad Key', title: 'x' }] })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
  });
});

describe('compiling a configuration into a layout of the report engine', () => {
  const compiled = compileLayoutConfig(CODE, 'v1', clone(AGENCY_REQUEST_DEFAULT), { names: { PLAN_TOTAL: 'Total plan' } });

  it('makes a valid DEMO layout for a demo configuration, with the mark, the requesting body and one dataset per group', () => {
    expect(compiled.layout.status).toBe('DEMO');
    expect(compiled.layout.code).toBe(CODE);
    expect(compiled.layout.version).toBe('v1');
    expect(compiled.layout.formRef).toBeNull();
    expect(compiled.datasets).toEqual(['projects_construction', 'projects_purchase_repair']);
    expect(compiled.receiver).toBe('AGENCY');
    expect(compiled.periodKind).toBe('QUARTER');
    const words = compiled.layout.preface.flatMap((row) => row.cells.map((cell) => (cell.binding.kind === 'TEXT' ? cell.binding.text : '')));
    expect(words[0]).toContain('MẪU DEMO');
    expect(words.some((word) => word.startsWith('Kính gửi: '))).toBe(true);
    expect(words).toContain('Total plan');
  });

  it('makes a READY layout for a live configuration: a table of the chosen indicators in the chosen order', () => {
    const config = clone(INTERNAL_OVERVIEW_DEFAULT);
    config.indicators = [{ code: 'PLAN_TOTAL', title: 'My plan' }, { code: 'DISBURSED_TREASURY' }];
    const internal = compileLayoutConfig('CFG_MY_VIEW', 'v2', config);
    expect(internal.layout.status).toBe('READY');
    expect(internal.layout.columns.map((column) => column.key)).toEqual(['no', 'indicator', 'value']);
    const rows = internal.layout.body.filter((row) => row.kind === 'NOTE' && row.cells.some((cell) => cell.binding.kind === 'INDICATOR'));
    expect(rows.map((row) => (row.cells[0]?.binding as { text: string }).text)).toEqual(['1', '2']);
    expect(rows.map((row) => (row.cells[2]?.binding as { code: string }).code)).toEqual(['PLAN_TOTAL', 'DISBURSED_TREASURY']);
    expect((rows[0]?.cells[1]?.binding as { text: string }).text).toBe('My plan');
    expect(internal.datasets).toEqual([]);
  });

  it('puts the columns in the order and with the titles the user chose', () => {
    const config = clone(AGENCY_REQUEST_DEFAULT);
    config.columns = [{ key: 'project_name', title: 'Name' }, { key: 'cumulative_year' }, { key: 'plan_year', title: 'Plan' }, { key: 'rate_year' }];
    const made = compileLayoutConfig(CODE, 'v3', config);
    expect(made.layout.columns.map((column) => [column.key, column.header[0]])).toEqual([
      ['no', 'STT'],
      ['project_name', 'Name'],
      ['cumulative_year', 'Lũy kế từ đầu năm'],
      ['plan_year', 'Plan'],
      ['rate_year', 'Tỷ lệ so kế hoạch năm (%)'],
    ]);
  });

  it('gives another hash for another version or another choice and the same hash for the same', () => {
    const again = compileLayoutConfig(CODE, 'v1', clone(AGENCY_REQUEST_DEFAULT), { names: { PLAN_TOTAL: 'Total plan' } });
    expect(layoutHashOf(again.layout, null)).toBe(layoutHashOf(compiled.layout, null));
    expect(layoutHashOf(compileLayoutConfig(CODE, 'v2', clone(AGENCY_REQUEST_DEFAULT), { names: { PLAN_TOTAL: 'Total plan' } }).layout, null)).not.toBe(layoutHashOf(compiled.layout, null));
    expect(layoutHashOf(compileLayoutConfig(CODE, 'v1', { ...clone(AGENCY_REQUEST_DEFAULT), totals: false }).layout, null)).not.toBe(layoutHashOf(compiled.layout, null));
  });

  it('refuses a code that is not a configured one', () => {
    expect(() => compileLayoutConfig('PVN-MONTHLY', 'v1', clone(AGENCY_REQUEST_DEFAULT))).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => compileLayoutConfig('CFG_', 'v1', clone(AGENCY_REQUEST_DEFAULT))).toThrow();
  });
});

describe('the illustrative preview of a configured layout', () => {
  const compiled = compileLayoutConfig(CODE, 'v1', clone(AGENCY_REQUEST_DEFAULT));
  const data = illustrativeLayoutData(clone(AGENCY_REQUEST_DEFAULT), PERIOD, definitions);
  const document = formDocumentOf(compiled.layout, null, data);
  const sheet = documentSheetOf(document);

  it('fills every cell of the form: no issue, all formulas worked out, the same data every time', () => {
    expect(document.grid.issues).toEqual([]);
    expect(sheet.unevaluated).toEqual([]);
    expect(JSON.stringify(illustrativeLayoutData(clone(AGENCY_REQUEST_DEFAULT), PERIOD, definitions))).toBe(JSON.stringify(data));
    expect(Object.keys(data.datasets)).toEqual(compiled.datasets);
  });

  it('adds the group subtotals into the grand total, in the scale of the form', () => {
    const planCol = compiled.layout.columns.find((column) => column.key === 'plan_year')?.col as number;
    const totals = sheet.rows.filter((row) => row.kind === 'TOTAL');
    expect(totals).toHaveLength(3);
    const value = (row: (typeof totals)[number]): number => row.cells.find((cell) => cell.col === planCol)?.value as number;
    const sumOf = (dataset: string): number => (data.datasets[dataset] ?? []).reduce((sum, record) => sum + Number(record.plan_year) / 1_000_000, 0);
    expect(value(totals[0] as (typeof totals)[number])).toBeCloseTo(sumOf('projects_construction'), 6);
    expect(value(totals[1] as (typeof totals)[number])).toBeCloseTo(sumOf('projects_purchase_repair'), 6);
    expect(value(totals[2] as (typeof totals)[number])).toBeCloseTo(sumOf('projects_construction') + sumOf('projects_purchase_repair'), 6);
  });

  it('leaves an indicator the register does not define without a figure and says so, never a made-up number', () => {
    const config = clone(AGENCY_REQUEST_DEFAULT);
    config.indicators = [{ code: 'NOT_IN_THE_REGISTER' }];
    const made = illustrativeLayoutData(config, PERIOD, definitions);
    expect(made.figures).toEqual([]);
    const filled = formDocumentOf(compileLayoutConfig(CODE, 'v1', config).layout, null, made);
    expect(filled.grid.issues.some((one) => one.code === 'NO_DEFINITION')).toBe(true);
  });

  it('without data for the groups (a live form before its provider is connected) leaves the cells empty and reports the datasets', () => {
    const config = { ...clone(AGENCY_REQUEST_DEFAULT), demo: false };
    const live = compileLayoutConfig(CODE, 'v4', config).layout;
    const filled = formDocumentOf(live, null, { period: PERIOD, meta: { ORG_NAME: 'Org' }, definitions, figures: [], datasets: {} });
    expect(filled.grid.issues.filter((one) => one.code === 'DATASET_MISSING')).toHaveLength(2);
  });
});
