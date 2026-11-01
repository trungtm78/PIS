import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { routeOf } from '../../dgv/test-support';
import { mountInSession } from '../../doc/test-support';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import CompareScreen from './CompareScreen';
import { METRICS, durationSeconds, groupByRoute, metricCell, toCompareRun } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0313'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('LLM-13', 'FR-LLM-13');
const ALL = ['ai_eval_run.read', 'model_profile_version.read', 'llm.eval.read'];
const DATASET = uuid(1);
const OTHER_DATASET = uuid(2);

const dataset = (id: string, code: string) => ({
  id,
  dataset_code: code,
  revision: 1,
  task_type: 'summarise',
  source: 'SYNTHETIC',
  max_classification: 'INTERNAL',
  case_count: 40,
  injection_cases: 4,
  status: 'ACTIVE',
});
const profile = (n: number, model: string) => ({
  id: uuid(100 + n),
  task_type: 'summarise',
  revision: n,
  model_id: model,
  status: 'PUBLISHED',
  routing_policy: { routes: ['DOMESTIC_HOSTED'], thresholds: {} },
  version: 1,
});
const thresholds = { citation_precision_min: 0.9, unsupported_claim_rate_max: 0.05, injection_resistance_min: 0.95, schema_valid_rate_min: 0.98 };
const run = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(200 + n),
  profile_version_id: uuid(101),
  dataset_version_id: DATASET,
  route_class: 'DOMESTIC_HOSTED',
  model_ref_id: null,
  metrics: { citation_precision: 0.97, unsupported_claim_rate: 0.01, injection_resistance: 1, schema_valid_rate: 0.995 },
  thresholds,
  passed: true,
  failures: [],
  review_status: 'SIGNED_PASS',
  cost_vnd: '1250000.5',
  started_by: uuid(7),
  started_at: '2026-11-01T01:00:00Z',
  finished_at: '2026-11-01T01:02:30Z',
  signed_by: uuid(8),
  signed_at: '2026-11-01T17:30:00Z',
  signature_decision: 'PASS',
  signature_comment: 'Đạt trên tập synthetic.',
  version: 2,
  ...extra,
});

interface World {
  datasets: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  failing: Set<string>;
}

function open(state: Partial<World> = {}, options: { permissions?: readonly string[] | undefined; path?: string } = {}): Harness & { world: World } {
  const world: World = {
    datasets: [dataset(DATASET, 'DS-A'), dataset(OTHER_DATASET, 'DS-B')],
    runs: [
      run(1),
      run(2, {
        id: uuid(202),
        profile_version_id: uuid(102),
        review_status: 'SIGNED_FAIL',
        passed: false,
        failures: ['citation_precision', 'unsupported_claim_rate'],
        metrics: { citation_precision: 0.8, unsupported_claim_rate: 0.09, injection_resistance: 1, schema_valid_rate: 0.99 },
        signature_comment: null,
      }),
    ],
    profiles: [profile(1, 'viet-llm'), profile(2, 'other-llm')],
    failing: new Set(),
    ...state,
  };
  const h = harness(() => new Error('unexpected read'));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (world.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'listAiEvalDatasets':
        return Promise.resolve(world.datasets);
      case 'get_resources_ai_eval_run':
        return Promise.resolve(world.runs);
      case 'get_resources_model_profile_version':
        return Promise.resolve(world.profiles);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  mountInSession(<CompareScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : ALL }, options.path ?? '/llm/llm-13');
  return Object.assign(h, { world });
}

const readAllNames = (h: Harness): string[] => (h.client.readAll as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0] as string);
const choose = (id: string): void => {
  fireEvent.change(screen.getByLabelText(word('llm.compare.dataset.label')), { target: { value: id } });
};

afterEach(() => cleanup());

describe('the model of the comparison (ST-LLM-009)', () => {
  it('reads a run with its signature and leaves out what is not one', () => {
    const read = toCompareRun(run(1));
    expect(read).toMatchObject({ route: 'DOMESTIC_HOSTED', status: 'SIGNED_PASS', passed: true, costVnd: '1250000.5', signedBy: uuid(8), signatureComment: 'Đạt trên tập synthetic.' });
    expect(toCompareRun(run(2, { metrics: 'x', thresholds: null, passed: 'yes', failures: 'x', cost_vnd: 3, started_at: 3, signed_by: null, signature_comment: null }))).toMatchObject({
      metrics: null,
      thresholds: null,
      passed: null,
      failures: [],
      costVnd: '0',
      startedAt: null,
      signedBy: null,
    });
    expect(toCompareRun(run(3, { metrics: { citation_precision: 'x', unsupported_claim_rate: 0.1 } }))?.metrics).toEqual({ unsupported_claim_rate: 0.1 });
    for (const bad of [null, [], {}, run(4, { review_status: 'LOST' }), run(4, { route_class: 'MARS' }), run(4, { id: 4 }), run(4, { profile_version_id: null }), run(4, { dataset_version_id: null })])
      expect(toCompareRun(bad)).toBeUndefined();
  });

  it('measures how long a run took, in whole seconds, and none when it did not finish', () => {
    expect(durationSeconds({ startedAt: '2026-11-01T01:00:00Z', finishedAt: '2026-11-01T01:02:30.400Z' })).toBe(150);
    expect(durationSeconds({ startedAt: null, finishedAt: '2026-11-01T01:02:30Z' })).toBeNull();
    expect(durationSeconds({ startedAt: '2026-11-01T01:00:00Z', finishedAt: null })).toBeNull();
    expect(durationSeconds({ startedAt: 'x', finishedAt: 'y' })).toBeNull();
    expect(durationSeconds({ startedAt: '2026-11-01T02:00:00Z', finishedAt: '2026-11-01T01:00:00Z' })).toBeNull();
  });

  it('groups the runs of one dataset by route, leaves out the ones set aside, and puts the latest first', () => {
    const runs = [
      toCompareRun(run(1)),
      toCompareRun(run(2, { finished_at: '2026-11-02T01:00:00Z' })),
      toCompareRun(run(3, { review_status: 'SUPERSEDED' })),
      toCompareRun(run(4, { dataset_version_id: OTHER_DATASET })),
      toCompareRun(run(5, { route_class: 'INTERNATIONAL' })),
      toCompareRun(run(6, { finished_at: null })),
    ].flatMap((entry) => entry ?? []);
    const groups = groupByRoute(runs, DATASET);
    expect(groups.map((group) => group.route)).toEqual(['DOMESTIC_HOSTED', 'INTERNATIONAL']);
    expect(groups[0]?.runs.map((entry) => entry.id)).toEqual([uuid(202), uuid(201), uuid(206)]);
    expect(groupByRoute(runs, uuid(99))).toEqual([]);
  });

  it('gives a metric with its threshold, and says it failed only when the run lists it', () => {
    const failed = toCompareRun(run(1, { failures: ['unsupported_claim_rate'] })) as NonNullable<ReturnType<typeof toCompareRun>>;
    expect(metricCell(failed, 'citation_precision', 'min')).toEqual({ value: 0.97, threshold: 0.9, failed: false });
    expect(metricCell(failed, 'unsupported_claim_rate', 'max')).toEqual({ value: 0.01, threshold: 0.05, failed: true });
    expect(metricCell({ metrics: null, thresholds: null, failures: [] }, 'citation_precision', 'min')).toEqual({ value: null, threshold: null, failed: false });
    expect(METRICS.map((entry) => entry.metric)).toHaveLength(4);
  });
});

describe('LLM-13 comparison of model evaluations', () => {
  it('compares the runs of a dataset route by route, with each metric against its threshold, the cost, the run time and the signature', async () => {
    open({}, { path: `/llm/llm-13?dataset=${DATASET}` });
    expect(await screen.findByRole('heading', { level: 1, name: word('llm.compare.page.title') })).toBeTruthy();
    const section = await screen.findByRole('region', { name: word('llm.route.domestic') });
    const rows = within(section).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const failing = rows.find((row) => row.getAttribute('data-run-id') === uuid(202)) as HTMLElement;
    const passing = rows.find((row) => row.getAttribute('data-run-id') === uuid(201)) as HTMLElement;
    expect(within(failing).getByText('other-llm')).toBeTruthy();
    expect(failing.querySelector('[data-metric="citation_precision"]')?.textContent).toContain('0.8');
    expect(failing.querySelector('[data-metric="citation_precision"]')?.textContent).toContain(word('llm.compare.threshold.min').replace('{value}', '0.9'));
    expect(failing.querySelector('[data-metric="citation_precision"]')?.getAttribute('data-failed')).toBe('true');
    expect(failing.querySelector('[data-metric="unsupported_claim_rate"]')?.textContent).toContain(word('llm.compare.threshold.max').replace('{value}', '0.05'));
    expect(failing.querySelector('[data-metric="injection_resistance"]')?.getAttribute('data-failed')).toBe('false');
    expect(within(failing).getByText(word('llm.runStatus.signedFail'))).toBeTruthy();
    expect(within(passing).getByText(word('llm.runStatus.signedPass'))).toBeTruthy();
    expect(within(passing).getByText(word('llm.compare.duration.seconds').replace('{value}', '150'))).toBeTruthy();
    expect(within(passing).getByText('1,250,000.5 ₫')).toBeTruthy();
    expect(within(passing).getByText('Đạt trên tập synthetic.')).toBeTruthy();
    expect(within(passing).getByText(word('llm.compare.signed.text').replace('{by}', uuid(8).slice(0, 8)).replace('{day}', '2026-11-02'))).toBeTruthy();
    expect(
      within(passing)
        .getByRole('link', { name: word('llm.compare.release.link') })
        .getAttribute('href'),
    ).toBe(`/llm/llm-17?profile=${uuid(101)}`);
    expect(screen.queryByTestId('compare-single')).toBeNull();
  });

  it('chooses the dataset, tells when there is one run only or none, and drops the choice', async () => {
    open({ runs: [run(1), run(3, { dataset_version_id: OTHER_DATASET, profile_version_id: uuid(999), signed_by: null, signed_at: null, started_at: null })] });
    await screen.findByTestId('compare-pick');
    choose(DATASET);
    expect(await screen.findByTestId('compare-single')).toBeTruthy();
    choose(OTHER_DATASET);
    expect(await screen.findByText(uuid(999).slice(0, 8))).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    choose('');
    expect(await screen.findByTestId('compare-pick')).toBeTruthy();
  });

  it('says so when a dataset has no run and when the dataset asked for is not known', async () => {
    open({ runs: [] }, { path: `/llm/llm-13?dataset=${DATASET}` });
    expect(await screen.findByTestId('compare-none')).toBeTruthy();
    cleanup();
    open({}, { path: `/llm/llm-13?dataset=${uuid(77)}` });
    expect(await screen.findByTestId('compare-unknown')).toBeTruthy();
    expect(screen.getByTestId('compare-pick')).toBeTruthy();
  });

  it('is empty when there is no dataset and fails as a whole when one read fails, with a retry that reads again', async () => {
    open({ datasets: [] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = open({ failing: new Set(['get_resources_ai_eval_run']) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    h.world.failing.clear();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByTestId('compare-pick')).toBeTruthy();
  });

  it('is denied without any one of the three rights to read, and reads nothing', async () => {
    for (const missing of ALL) {
      const h = open({}, { permissions: ALL.filter((permission) => permission !== missing) });
      expect(await screen.findByTestId('compare-denied')).toBeTruthy();
      expect(readAllNames(h)).toEqual([]);
      expect(h.read).not.toHaveBeenCalled();
      cleanup();
    }
    open({}, { permissions: undefined });
    expect(await screen.findByTestId('compare-pick')).toBeTruthy();
  });

  it('waits for every read before it shows anything', async () => {
    const h = open();
    await waitFor(() => expect(readAllNames(h).sort()).toEqual(['get_resources_ai_eval_run', 'get_resources_model_profile_version', 'listAiEvalDatasets']));
  });
});
