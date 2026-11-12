import { AGENCY_REQUEST_DEFAULT, CONFIG_CODE_PREFIX, DIS_WEEKLY_LAYOUT, INTERNAL_OVERVIEW_DEFAULT, KPI_HOME_DEFAULTS } from '@machvon/kernel';
import type { LayoutConfig, ReportIndicatorDefinition } from '@machvon/kernel';
import { bundleOfConfig, isConfiguredCode } from '../../src/modules/reports/configured-forms';
import { ReportFormRegistry } from '../../src/modules/reports/form-registry';
import { renderReport } from '../../src/modules/reports/render';
import { disagreements, writeAll } from './three-writers';
import { illustrativeLayoutData } from '@machvon/kernel';

/** The forms a tenant configures without code (ENT-4b, R23): the bundle of a configuration, its three files, and the wall between configured forms and code-owned forms. */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const definitions: Record<string, ReportIndicatorDefinition> = Object.fromEntries(
  Object.entries(KPI_HOME_DEFAULTS).map(([code, one]) => {
    const params = one.params as { name: string; unit: ReportIndicatorDefinition['unit']; period: ReportIndicatorDefinition['period']; decimals: number };
    return [code, { code, name: params.name, unit: params.unit, decimals: params.decimals, period: params.period, version: 1 }];
  }),
);
const ISSUED_AT = new Date(Date.UTC(2026, 8, 30, 0, 0, 0));
const QUARTER = { kind: 'QUARTER', year: 2026, index: 3 } as const;
const MONTH = { kind: 'MONTH', year: 2026, index: 10 } as const;

describe('the bundle of a configured form', () => {
  it('is a DEMO form with illustrative data for a demo configuration, and a LIVE form with a provider otherwise', async () => {
    const demo = await bundleOfConfig('CFG_AGENCY_REQUEST', 'v0', clone(AGENCY_REQUEST_DEFAULT), definitions);
    expect(demo).toMatchObject({ dataSource: 'ILLUSTRATIVE', provider: null, receiver: 'AGENCY', periodKind: 'QUARTER', edition: 'public' });
    expect(demo.layout.status).toBe('DEMO');
    expect(demo.illustrative?.(QUARTER).datasets).toBeDefined();
    const live = await bundleOfConfig('CFG_INTERNAL_OVERVIEW', 'v0', clone(INTERNAL_OVERVIEW_DEFAULT), definitions);
    expect(live).toMatchObject({ dataSource: 'LIVE', provider: 'DIS_HOME', receiver: 'INTERNAL', periodKind: 'MONTH' });
    expect(live.layout.status).toBe('READY');
    expect(live.illustrative).toBeUndefined();
    const other = await bundleOfConfig('CFG_INTERNAL_OVERVIEW', 'v1', { ...clone(INTERNAL_OVERVIEW_DEFAULT), data_provider: 'ENT_FIGURES' }, definitions);
    expect(other.provider).toBe('ENT_FIGURES');
  });

  it('is accepted by the rules of the registry only as a bundle the process was not asked to hold: a code-owned registry refuses the prefix', async () => {
    const registry = new ReportFormRegistry();
    const bundle = await bundleOfConfig('CFG_AGENCY_REQUEST', 'v0', clone(AGENCY_REQUEST_DEFAULT), definitions);
    expect(() => registry.register(bundle)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'report_form_code_reserved' }));
    expect(() => registry.register({ ...bundle, layout: { ...DIS_WEEKLY_LAYOUT, code: `${CONFIG_CODE_PREFIX}WEEKLY` }, dataSource: 'LIVE', provider: 'DIS_HOME', illustrative: undefined })).toThrow(expect.objectContaining({ detail: 'report_form_code_reserved' }));
    expect(isConfiguredCode('CFG_AGENCY_REQUEST')).toBe(true);
    for (const code of ['PVN-MONTHLY', 'DIS-WEEKLY', 'MOF-DIS-WEEKLY', 'CFG_', 'cfg_x']) expect(isConfiguredCode(code)).toBe(false);
  });
});

describe('the three files of a configured form', () => {
  it('UAT-PLAN-3410: agree for the demo form for a Department, Board or Sector: cells, formulas, words and pages', async () => {
    const config = clone(AGENCY_REQUEST_DEFAULT);
    const bundle = await bundleOfConfig('CFG_AGENCY_REQUEST', 'v0', config, definitions);
    const made = await writeAll({ layout: bundle.layout, narrative: null, data: illustrativeLayoutData(config, QUARTER, definitions), template: (await bundle.templates()).xlsx, issuedAt: ISSUED_AT });
    expect(await disagreements(made)).toEqual([]);
    expect(made.document.stamp).toContain('DEMO');
    expect(made.drawn.some((text) => text.startsWith('Kính gửi: '))).toBe(true);
    expect(made.pdf.plan.pages).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('agree for the live internal overview, whose indicators the register defines but whose figures are not there yet: empty cells, never zeros', async () => {
    const bundle = await bundleOfConfig('CFG_INTERNAL_OVERVIEW', 'v0', clone(INTERNAL_OVERVIEW_DEFAULT), definitions);
    const data = { period: MONTH, meta: { ORG_NAME: 'Org' }, definitions, figures: [], datasets: {} };
    const made = await writeAll({ layout: bundle.layout, narrative: null, data, template: (await bundle.templates()).xlsx, issuedAt: ISSUED_AT });
    expect(await disagreements(made)).toEqual([]);
    expect(made.document.grid.issues.every((one) => one.code === 'NO_FIGURE')).toBe(true);
    expect(made.document.grid.issues.length).toBe(INTERNAL_OVERVIEW_DEFAULT.indicators.length);
  });

  it('UAT-PLAN-3410: are made by the engine like any form: a PDF with the hash of the layout, the same bytes twice, other bytes when a column moves', async () => {
    const config = clone(AGENCY_REQUEST_DEFAULT);
    const bundle = await bundleOfConfig('CFG_AGENCY_REQUEST', 'v0', config, definitions);
    const input = { layout: bundle.layout, narrative: null, xlsxTemplate: (await bundle.templates()).xlsx, data: illustrativeLayoutData(config, QUARTER, definitions), creator: 'MACHVON' };
    const one = await renderReport(input);
    const two = await renderReport(input);
    expect(Buffer.from(one.pdf).equals(Buffer.from(two.pdf))).toBe(true);
    expect(one.layoutSha256).toMatch(/^[0-9a-f]{64}$/);
    const moved: LayoutConfig = { ...clone(config), columns: [...clone(config).columns].reverse() };
    const bundleMoved = await bundleOfConfig('CFG_AGENCY_REQUEST', 'v1', moved, definitions);
    const three = await renderReport({ ...input, layout: bundleMoved.layout, data: illustrativeLayoutData(moved, QUARTER, definitions), xlsxTemplate: (await bundleMoved.templates()).xlsx });
    expect(three.layoutSha256).not.toBe(one.layoutSha256);
    expect(Buffer.from(three.pdf).equals(Buffer.from(one.pdf))).toBe(false);
  }, 120_000);
});
