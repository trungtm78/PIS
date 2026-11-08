import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import LineageScreen, { pathLine } from './LineageScreen';
import TrustScreen, { trustReason } from './TrustScreen';
import { toFreshness, toLineage, toScorecard } from './trust-model';
import { translator } from '../../i18n';

const READER = ['home.read', 'bi.query', 'bi.lineage.read'];
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const dataset = (code: string, over: Record<string, unknown> = {}, freshness: Record<string, unknown> = {}) => ({
  code,
  title: `${code} title`,
  module: code === 'DS-DISB' ? 'DIS' : 'CTR',
  dataset_id: null,
  built_at: '2027-10-10T00:00:00.000Z',
  as_of_period: 'W41',
  quality_badge: 'PASSED',
  certification: 'CERTIFIED',
  freshness: { status: 'FRESH', age_hours: 10, sla_hours: 192, overdue_hours: null, null_reason: null, ...freshness },
  sla_version: 'builtin',
  unverified: true,
  ...over,
});
const freshness = (datasets: unknown[], over: Record<string, unknown> = {}) => ({
  as_of: '2027-10-20T00:00:00.000Z',
  datasets,
  stale_count: datasets.filter((one) => (one as { freshness: { status: string } }).freshness.status === 'STALE').length,
  no_data_count: datasets.filter((one) => (one as { freshness: { status: string } }).freshness.status === 'NO_DATA').length,
  info: { formula: 'Age against the SLA', source: 'Dataset catalogue', as_of: '2026-11-08', rule_version: 'builtin', unverified: true },
  ...over,
});
const dims = (scores: Array<number | null>, codes = ['FRESHNESS', 'QUALITY', 'CERTIFICATION']) => codes.map((code, index) => ({ code, weight: 40, score: scores[index] ?? null, null_reason: scores[index] === null ? 'NOT_ASSESSED' : null }));
const card = (over: Record<string, unknown> = {}) => ({
  as_of: '2027-10-20',
  snapshot_id: 's1',
  unit_as_of_date: '2027-10-12',
  modules: [
    { module: 'DIS', datasets: ['DS-DISB'], composite: 84, band: 'GOOD', null_reason: null, used_dimensions: 3, dimensions: dims([100, 100, 20]) },
    { module: 'CTR', datasets: ['DS-CTR'], composite: null, band: null, null_reason: 'TOO_FEW_DIMENSIONS', used_dimensions: 1, dimensions: dims([null, null, 100]) },
  ],
  units: [{ unit_id: 'u1', code: 'BAN', name: 'Ban Bac', composite: 66.7, band: 'FAIR', null_reason: null, used_dimensions: 2, dimensions: dims([50, null, 100], ['COMPLETENESS', 'COVERAGE', 'TIMELINESS']) }],
  module_info: { formula: 'Weighted mean', source: 'Scorecard rule', as_of: '2026-11-08', rule_version: 'builtin', unverified: true },
  unit_info: { formula: 'Weighted mean of units', source: 'Scorecard rule', as_of: '2026-11-08', rule_version: 'builtin', unverified: true },
  ...over,
});

function client(answers: { freshness?: () => unknown; card?: () => unknown; lineage?: (query: Record<string, unknown>) => unknown } = {}): Harness {
  return harness((operation, input) => {
    if (operation === 'getDataFreshness') return (answers.freshness ?? (() => freshness([dataset('DS-DISB'), dataset('DS-CTR', {}, { status: 'STALE', age_hours: 240, overdue_hours: 48 })])))();
    if (operation === 'getDataTrustScorecard') return (answers.card ?? (() => card()))();
    if (operation === 'getMetricLineageGraph') return (answers.lineage ?? lineage)(((input as { query?: Record<string, unknown> }).query ?? {}) as Record<string, unknown>);
    return new Error(`unexpected read ${operation}`);
  });
}

const catalogue = [
  { kind: 'MODULE', nodes: [{ id: 'MODULE:DIS', key: 'DIS', label: 'DIS', module: null }] },
  { kind: 'TABLE', nodes: [{ id: 'TABLE:period_snapshot_line', key: 'period_snapshot_line', label: 'period_snapshot_line', module: 'DIS' }] },
  { kind: 'DATASET', nodes: [{ id: 'DATASET:DS-DISB', key: 'DS-DISB', label: 'DS-DISB', module: 'DIS' }] },
  { kind: 'METRIC', nodes: [{ id: 'METRIC:disbursement_rate', key: 'disbursement_rate', label: 'disbursement_rate', module: null }] },
  { kind: 'KPI', nodes: [] },
];
function lineage(query: Record<string, unknown>) {
  const base = { counts: { nodes: 4, edges: 3 }, catalogue, edges: [], unresolved: [{ kind: 'TABLE_WITHOUT_MODULE', key: 'mystery_table' }] };
  if (query.node === undefined) return { ...base, trace: null };
  const up = query.direction !== 'DOWNSTREAM';
  return {
    ...base,
    trace: {
      root: query.node,
      direction: up ? 'UPSTREAM' : 'DOWNSTREAM',
      nodes: [
        { id: 'METRIC:disbursement_rate', kind: 'METRIC', key: 'disbursement_rate', label: 'disbursement_rate', module: null },
        { id: 'DATASET:DS-DISB', kind: 'DATASET', key: 'DS-DISB', label: 'DS-DISB', module: 'DIS' },
        { id: 'TABLE:period_snapshot_line', kind: 'TABLE', key: 'period_snapshot_line', label: 'period_snapshot_line', module: 'DIS' },
        { id: 'MODULE:DIS', kind: 'MODULE', key: 'DIS', label: 'DIS', module: null },
      ],
      paths: up ? [['METRIC:disbursement_rate', 'DATASET:DS-DISB', 'TABLE:period_snapshot_line', 'MODULE:DIS']] : [],
    },
  };
}

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

describe('BI-23 freshness and the scorecard (G3-7)', () => {
  const ROUTE = routeOf('BI-23', 'FR-BI-23');

  it('shows each dataset against its SLA, says "stale data" by itself and keeps a dataset with no build as no data', async () => {
    mount(<TrustScreen route={ROUTE} />, client(), { permissions: READER });
    const table = await screen.findByTestId('freshness-table');
    const rows = within(table).getAllByTestId('freshness-row');
    expect(rows[0]?.getAttribute('data-status')).toBe('FRESH');
    expect(rows[1]?.getAttribute('data-status')).toBe('STALE');
    expect(rows[1]?.textContent).toContain(tr('ana.trust.status.stale'));
    expect(rows[1]?.textContent).toContain(fill(tr('ana.trust.fresh.overdue'), { hours: 48 }));
    expect(screen.getByTestId('trust-stale').textContent).toContain(fill(tr('ana.trust.banner.body'), { count: 1 }));
    expect(screen.getByTestId('ana-unverified')).toBeTruthy();
  });

  it('says plainly a dataset that was never built has no data, not that it is fresh', async () => {
    mount(<TrustScreen route={ROUTE} />, client({ freshness: () => freshness([dataset('DS-CTR', { built_at: null, quality_badge: null, certification: null }, { status: 'NO_DATA', age_hours: null, null_reason: 'NEVER_BUILT' })]) }), { permissions: READER });
    const row = await screen.findByTestId('freshness-row');
    expect(row.textContent).toContain(tr('ana.trust.status.noData'));
    expect(row.textContent).toContain(tr('ana.trust.na.neverBuilt'));
    expect(screen.queryByTestId('trust-stale')).toBeNull();
  });

  it('shows the module and unit scorecards: scores as numbers, N/A with the reason, the composite and its band', async () => {
    mount(<TrustScreen route={ROUTE} />, client(), { permissions: READER });
    const modules = await screen.findByTestId('module-table');
    const dis = within(modules).getAllByTestId('module-row')[0] as HTMLElement;
    expect(within(dis).getByTestId('dim-FRESHNESS').textContent).toBe('100');
    expect(within(dis).getByTestId('composite').textContent).toContain('84');
    expect(within(dis).getByTestId('composite').textContent).toContain(tr('ana.trust.band.good'));
    const ctr = within(modules).getAllByTestId('module-row')[1] as HTMLElement;
    expect(within(ctr).getByTestId('composite').textContent).toContain(tr('ana.common.na'));
    expect(within(ctr).getByTestId('composite').textContent).toContain(tr('ana.trust.na.tooFew'));
    const unit = within(screen.getByTestId('unit-table')).getByTestId('unit-row');
    expect(within(unit).getByTestId('dim-COVERAGE').textContent).toContain(tr('ana.common.na'));
    expect(within(unit).getByTestId('composite').textContent).toContain('66.7');
    expect(within(unit).getByTestId('composite').textContent).toContain(tr('ana.trust.band.fair'));
  });

  it('says there are no units when there is no snapshot, and keeps the freshness when the scorecard cannot be read', async () => {
    mount(<TrustScreen route={ROUTE} />, client({ card: () => card({ snapshot_id: null, unit_as_of_date: null, units: [] }) }), { permissions: READER });
    expect(await screen.findByText(tr('ana.trust.unit.none'))).toBeTruthy();
    cleanup();
    mount(<TrustScreen route={ROUTE} />, client({ card: () => new Error('boom') }), { permissions: READER });
    expect(await screen.findByTestId('freshness-table')).toBeTruthy();
    expect((await screen.findByTestId('scorecard-error')).textContent).toBe(tr('ana.trust.scorecard.error'));
  });

  it('shows the empty, error and denied states', async () => {
    mount(<TrustScreen route={ROUTE} />, client({ freshness: () => freshness([]) }), { permissions: READER });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<TrustScreen route={ROUTE} />, client({ freshness: () => new Error('boom') }), { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<TrustScreen route={ROUTE} />, client({ freshness: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) }), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
  });

  it('turns every reason into words and reads wrong answers as nothing', () => {
    const reasons = ['NEVER_BUILT', 'NOT_ASSESSED', 'NO_CERTIFICATION', 'NO_PROJECTS', 'NOT_SCORED', 'NOT_READABLE', 'TOO_FEW_DIMENSIONS'];
    expect(new Set(reasons.map((reason) => trustReason(translator.t, reason))).size).toBe(reasons.length);
    expect(trustReason(translator.t, 'NEW')).toBe(tr('ana.trust.na.other'));
    expect(toFreshness({})).toBeUndefined();
    expect(toScorecard({ modules: [] })).toBeUndefined();
    expect(toFreshness({ datasets: [{ code: 'X' }] })?.datasets).toEqual([]);
  });
});

describe('BI-24 where a number comes from (G3-11)', () => {
  const ROUTE = routeOf('BI-24', 'FR-BI-24');

  it('asks to choose a node first, lists the gaps, and traces a metric upstream to the module', async () => {
    const h = client();
    mount(<LineageScreen route={ROUTE} />, h, { permissions: READER });
    expect((await screen.findByTestId('lineage-hint')).textContent).toBe(tr('ana.lineage.trace.hint'));
    expect(screen.getByTestId('lineage-gaps').textContent).toContain('mystery_table');
    fireEvent.change(screen.getByTestId('lineage-node'), { target: { value: 'METRIC:disbursement_rate' } });
    const path = await screen.findByTestId('lineage-path');
    expect(path.textContent).toContain('disbursement_rate');
    expect(path.textContent).toContain('DS-DISB');
    expect(path.textContent).toContain('period_snapshot_line');
    expect(path.textContent).toContain('DIS');
    expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, unknown> }).query.node === 'METRIC:disbursement_rate' && (call[1] as { query: Record<string, unknown> }).query.direction === 'UPSTREAM')).toBe(true);
  });

  it('moves the root to any node of a path by a button, and goes downstream and to another depth', async () => {
    const h = client();
    mount(<LineageScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByTestId('lineage-hint');
    fireEvent.change(screen.getByTestId('lineage-node'), { target: { value: 'METRIC:disbursement_rate' } });
    fireEvent.click(await screen.findByTestId('lineage-go-TABLE:period_snapshot_line'));
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, unknown> }).query.node === 'TABLE:period_snapshot_line')).toBe(true));
    fireEvent.change(screen.getByTestId('lineage-direction'), { target: { value: 'DOWNSTREAM' } });
    expect((await screen.findByTestId('lineage-nothing')).textContent).toBe(tr('ana.lineage.trace.nothingDown'));
    fireEvent.change(screen.getByTestId('lineage-depth'), { target: { value: '2' } });
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, unknown> }).query.depth === 2)).toBe(true));
  });

  it('lists the nodes of the chosen kind and says when there are none', async () => {
    mount(<LineageScreen route={ROUTE} />, client(), { permissions: READER });
    await screen.findByTestId('lineage-hint');
    fireEvent.change(screen.getByTestId('lineage-kind'), { target: { value: 'KPI' } });
    expect(screen.getByText(tr('ana.lineage.pick.none'))).toBeTruthy();
    fireEvent.change(screen.getByTestId('lineage-kind'), { target: { value: 'TABLE' } });
    expect(within(screen.getByTestId('lineage-node')).getByText('period_snapshot_line')).toBeTruthy();
  });

  it('shows the error, empty and denied states and reads wrong answers as nothing', async () => {
    mount(<LineageScreen route={ROUTE} />, client({ lineage: () => new Error('boom') }), { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<LineageScreen route={ROUTE} />, client({ lineage: () => ({ counts: { nodes: 0, edges: 0 }, catalogue: [], trace: null, edges: [], unresolved: [] }) }), { permissions: READER });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<LineageScreen route={ROUTE} />, client({ lineage: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) }), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
    expect(toLineage({})).toBeUndefined();
    expect(pathLine(['a', 'b'], new Map(), 'UPSTREAM')).toBe('a ← b');
    expect(pathLine(['a', 'b'], new Map(), 'DOWNSTREAM')).toBe('a → b');
    expect(fill(tr('ana.lineage.trace.go'), { node: 'x' })).toContain('x');
  });
});
