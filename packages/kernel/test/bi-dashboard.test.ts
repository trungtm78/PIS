import { describe, expect, it } from '@jest/globals';
import { DASHBOARD_CODE, parseDashboardDraft } from '../src/bi-dashboard';
import type { DraftInput } from '../src/bi-dashboard';

const M1 = '00000000-0000-4000-8000-0000000000a1';
const M2 = '00000000-0000-4000-8000-0000000000a2';
const D1 = '00000000-0000-4000-8000-0000000000d1';

const widget = (id: string, overrides: Record<string, unknown> = {}) => ({ id, kind: 'BAR', metric_version_id: M1, grid: { x: 0, y: 0, w: 6, h: 4 }, ...overrides });
const draft = (overrides: Partial<DraftInput> = {}): DraftInput => ({
  layout_json: { widgets: [widget('w1')] },
  breakpoints: { sm: 640, md: 1024 },
  metric_versions: [M1],
  filter_mappings: { period: 'bucket' },
  dataset_version_policy: 'LATEST_FROZEN',
  ...overrides,
});
const refusal = (input: DraftInput): string | undefined => {
  try {
    parseDashboardDraft(input);
    return undefined;
  } catch (error) {
    return (error as { detail?: string }).detail;
  }
};

describe('parseDashboardDraft (ST-BI-005)', () => {
  it('reads a draft whole, with the defaults of an empty layout and ids in lower case', () => {
    const parsed = parseDashboardDraft(draft({ metric_versions: [M1.toUpperCase(), M2], layout_json: { columns: 12, widgets: [widget('w1', { title: '  Giải ngân  ', metric_version_id: M1.toUpperCase(), dimension_code: 'unit' }), widget('w2', { kind: 'KPI', metric_version_id: M2, grid: { x: 6, y: 0, w: 6, h: 2 } })] } }));
    expect(parsed.metricVersionIds).toEqual([M1, M2]);
    expect(parsed.layout.columns).toBe(12);
    expect(parsed.layout.widgets[0]).toEqual({ id: 'w1', kind: 'BAR', title: 'Giải ngân', metricVersionId: M1, dimensionCode: 'unit', grid: { x: 0, y: 0, w: 6, h: 4 } });
    expect(parsed.layout.widgets[1]).toMatchObject({ kind: 'KPI', title: null, dimensionCode: null });
    expect(parsed.breakpoints).toEqual({ sm: 640, md: 1024 });
    expect(parsed.filterMappings).toEqual({ period: 'bucket' });
    expect(parsed.policy).toBe('LATEST_FROZEN');
    expect(parsed.pinnedDatasetVersionIds).toEqual([]);
    expect(parseDashboardDraft(draft({ layout_json: {}, metric_versions: [], breakpoints: {}, filter_mappings: {} })).layout).toEqual({ columns: 12, widgets: [] });
  });

  it('refuses a layout that is not a grid of separate tiles over the metrics of the version', () => {
    expect(refusal(draft({ layout_json: [] }))).toBe('layout_json');
    expect(refusal(draft({ layout_json: { widgets: [], css: 'x' } }))).toBe('layout_json.css');
    expect(refusal(draft({ layout_json: { columns: 0 } }))).toBe('layout_json.columns');
    expect(refusal(draft({ layout_json: { columns: 25 } }))).toBe('layout_json.columns');
    expect(refusal(draft({ layout_json: { widgets: 'x' } }))).toBe('layout_json.widgets');
    expect(refusal(draft({ layout_json: { widgets: Array.from({ length: 101 }, (_, i) => widget(`w${i}`, { grid: { x: 0, y: i, w: 1, h: 1 } })) } }))).toBe('layout_json.widgets');
    expect(refusal(draft({ layout_json: { widgets: ['x'] } }))).toBe('layout_json.widgets[0]');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { script: 1 })] } }))).toBe('layout_json.widgets[0].script');
    expect(refusal(draft({ layout_json: { widgets: [widget('bad id')] } }))).toBe('layout_json.widgets[0].id');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { kind: 'RADAR' })] } }))).toBe('layout_json.widgets[0].kind');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { title: '  ' })] } }))).toBe('layout_json.widgets[0].title');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { title: 'x'.repeat(201) })] } }))).toBe('layout_json.widgets[0].title');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { metric_version_id: M2 })] } }))).toBe('layout_json.widgets[0].metric_version_id');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { metric_version_id: 'x' })] } }))).toBe('layout_json.widgets[0].metric_version_id');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { dimension_code: 'Unit' })] } }))).toBe('layout_json.widgets[0].dimension_code');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { kind: 'KPI', dimension_code: 'unit' })] } }))).toBe('layout_json.widgets[0].dimension_code');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { grid: 'x' })] } }))).toBe('layout_json.widgets[0].grid');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1', { grid: { x: 0, y: 0, w: 6, h: 4, z: 1 } })] } }))).toBe('layout_json.widgets[0].grid.z');
    for (const grid of [{ x: -1, y: 0, w: 1, h: 1 }, { x: 0, y: -1, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 1 }, { x: 0, y: 0, w: 1, h: 0 }, { x: 8, y: 0, w: 5, h: 1 }, { x: 0, y: 0, w: 1, h: 51 }, { x: 0.5, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1 }]) {
      expect([grid, refusal(draft({ layout_json: { widgets: [widget('w1', { grid })] } }))]).toEqual([grid, 'layout_json.widgets[0].grid']);
    }
    expect(refusal(draft({ layout_json: { widgets: [widget('w1'), widget('w1', { grid: { x: 6, y: 0, w: 6, h: 4 } })] } }))).toBe('layout_json.widgets');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1'), widget('w2', { grid: { x: 5, y: 3, w: 2, h: 2 } })] } }))).toBe('layout_json.widgets');
    expect(refusal(draft({ layout_json: { widgets: [widget('w1'), widget('w2', { grid: { x: 6, y: 0, w: 6, h: 4 } }), widget('w3', { grid: { x: 0, y: 4, w: 12, h: 1 } })] } }))).toBeUndefined();
  });

  it('refuses metrics, breakpoints and filters that are not well made', () => {
    expect(refusal(draft({ metric_versions: [M1, M1] }))).toBe('metric_versions');
    expect(refusal(draft({ metric_versions: ['x'] }))).toBe('metric_versions');
    expect(refusal(draft({ metric_versions: 'x' as unknown as string[] }))).toBe('metric_versions');
    expect(refusal(draft({ metric_versions: Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), layout_json: {} }))).toBe('metric_versions');
    expect(refusal(draft({ breakpoints: [] }))).toBe('breakpoints');
    expect(refusal(draft({ breakpoints: { xs: 320 } }))).toBe('breakpoints.xs');
    expect(refusal(draft({ breakpoints: { sm: 319 } }))).toBe('breakpoints.sm');
    expect(refusal(draft({ breakpoints: { sm: 4001 } }))).toBe('breakpoints.sm');
    expect(refusal(draft({ breakpoints: { sm: 640.5 } }))).toBe('breakpoints.sm');
    expect(refusal(draft({ breakpoints: { sm: 1024, md: 1024 } }))).toBe('breakpoints.md');
    expect(refusal(draft({ breakpoints: { sm: 1024, md: 640 } }))).toBe('breakpoints.md');
    expect(refusal(draft({ filter_mappings: [] }))).toBe('filter_mappings');
    expect(refusal(draft({ filter_mappings: { Period: 'bucket' } }))).toBe('filter_mappings.Period');
    expect(refusal(draft({ filter_mappings: { period: 3 } }))).toBe('filter_mappings.period');
    expect(refusal(draft({ filter_mappings: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f_${i}x`, 'bucket'])) }))).toBe('filter_mappings');
  });

  it('judges the policy for the versions of the datasets: the latest frozen names none, a pinned one names at least one', () => {
    expect(parseDashboardDraft(draft({ dataset_version_policy: 'PINNED', pinned_dataset_version_ids: [D1.toUpperCase()] })).pinnedDatasetVersionIds).toEqual([D1]);
    expect(refusal(draft({ dataset_version_policy: 'PINNED' }))).toBe('pinned_dataset_version_ids');
    expect(refusal(draft({ dataset_version_policy: 'PINNED', pinned_dataset_version_ids: [] }))).toBe('pinned_dataset_version_ids');
    expect(refusal(draft({ dataset_version_policy: 'LATEST_FROZEN', pinned_dataset_version_ids: [D1] }))).toBe('pinned_dataset_version_ids');
    expect(refusal(draft({ dataset_version_policy: 'PINNED', pinned_dataset_version_ids: [D1, D1] }))).toBe('pinned_dataset_version_ids');
    expect(refusal(draft({ dataset_version_policy: 'NEWEST' }))).toBe('dataset_version_policy');
  });

  it('knows the shape of the code of a dashboard', () => {
    for (const ok of ['GIAI-NGAN', 'd1', 'A_b.c-9', 'x'.repeat(80)]) expect([ok, DASHBOARD_CODE.test(ok)]).toEqual([ok, true]);
    for (const bad of ['a', '-ab', ' ab', 'a b', 'x'.repeat(81), 'ab/c', '']) expect([bad, DASHBOARD_CODE.test(bad)]).toEqual([bad, false]);
  });
});
