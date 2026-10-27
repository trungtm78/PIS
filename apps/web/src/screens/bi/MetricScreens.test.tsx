import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import MetricCatalogueScreen from './MetricCatalogueScreen';
import MetricDefinitionScreen from './MetricDefinitionScreen';
import RegistrationScreen from './RegistrationScreen';
import { DATASET, ID, rawMetric, sum } from './test-support';

const route = (id: string) => routeOf(id, `FR-${id}`);
const MANAGER = ['bi.metric.manage'];
const READER = ['metric_definition.read'];
const TENANT_ID = '00000000-0000-4000-8000-0000000000a2';
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const platform = rawMetric();
const tenantDraft = rawMetric({ id: TENANT_ID, code: 't_rate', origin: 'TENANT_UI', status: 'DRAFT', source_commit: null, definition_sha256: null, aggregation_type: 'additive', numerator_ast: null, denominator_ast: null, expression_ast: sum('A'), unit: 'VND' });

interface World {
  rows: unknown[] | Error;
  one?: unknown;
}

/** A client whose `readAll` answers the registry and whose `read` answers one revision. */
function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFT', resource_id: TENANT_ID })) {
  const h = harness((operation, input) => {
    if (operation !== 'get_resources_metric_definition_id') return new Error(`unexpected read ${operation}`);
    expect((input as { path: { id: string } }).path.id).toBeTruthy();
    return world.one instanceof Error ? world.one : (world.one ?? new Error('no revision'));
  }, command);
  const readAll = vi.fn((operation: string) => {
    if (operation !== 'get_resources_metric_definition') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    return world.rows instanceof Error ? Promise.reject(world.rows) : Promise.resolve(world.rows);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('BI-05 catalogue of metrics (ST-BI-001, BI 3 F1)', () => {
  it('AC-ST-BI-001-1: UAT-AC471 lists a metric of the platform with its formula, its unit and the commit it came from, says it is read-only, and opens its definition', async () => {
    mount(<MetricCatalogueScreen route={route('BI-05')} />, client({ rows: [platform, tenantDraft] }), { permissions: READER });
    const table = await screen.findByTestId('metric-table');
    const row = table.querySelector(`[data-metric-id="${ID}"]`) as HTMLElement;
    expect(within(row).getByText('SUM(GIAI_NGAN) / SUM(KE_HOACH_TTG)')).toBeTruthy();
    expect(within(row).getByText('c1a2b3c')).toBeTruthy();
    expect(within(row).getByText('percent')).toBeTruthy();
    expect(within(row).getByText(vi_['bi.metric.origin.platform'])).toBeTruthy();
    expect(within(row).getByRole('link').getAttribute('href')).toBe(`/bi/bi-06?id=${ID}`);
    expect(screen.getByTestId('metric-readonly-note').textContent).toBe(vi_['bi.catalogue.platformNote']);
    for (const name of ['code', 'formula', 'unit', 'owner', 'origin', 'commit', 'glossary']) {
      expect(within(table).getByRole('columnheader', { name: vi_[`bi.catalogue.column.${name}` as keyof typeof vi_] })).toBeTruthy();
    }
  });

  it('narrows the list by origin and says so when the origin has none', async () => {
    const user = userEvent.setup();
    mount(<MetricCatalogueScreen route={route('BI-05')} />, client({ rows: [platform] }), { permissions: READER });
    await screen.findByTestId('metric-table');
    await user.selectOptions(screen.getByLabelText(vi_['bi.catalogue.filter.origin']), 'TENANT_UI');
    expect((await screen.findByTestId('metric-no-rows')).textContent).toBe(vi_['bi.catalogue.noRows']);
    await user.selectOptions(screen.getByLabelText(vi_['bi.catalogue.filter.origin']), 'PLATFORM_CODE');
    expect(document.querySelector(`[data-metric-id="${ID}"]`)).toBeTruthy();
  });

  it('offers to draft a metric to whoever may, and to nobody else, and to nobody while the tenant is read-only', async () => {
    mount(<MetricCatalogueScreen route={route('BI-05')} />, client({ rows: [platform] }), { permissions: MANAGER });
    expect((await screen.findByRole('link', { name: vi_['bi.catalogue.create.link'] })).getAttribute('href')).toBe('/bi/bi-06');
    cleanup();
    mount(<MetricCatalogueScreen route={route('BI-05')} />, client({ rows: [platform] }), { permissions: READER });
    await screen.findByTestId('metric-table');
    expect(screen.queryByRole('link', { name: vi_['bi.catalogue.create.link'] })).toBeNull();
    cleanup();
    mount(<MetricCatalogueScreen route={route('BI-05')} />, client({ rows: [platform] }), { permissions: MANAGER, mode: 'READ_ONLY' });
    await screen.findByTestId('metric-table');
    expect(screen.queryByRole('link', { name: vi_['bi.catalogue.create.link'] })).toBeNull();
    expect(screen.getByRole('link', { name: vi_['bi.catalogue.registration.link'] }).getAttribute('href')).toBe('/bi/bi-15');
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', [], vi_['states.empty.title']],
      ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ] as Array<[string, unknown[] | Error, string]>)('UI-BI-05 shows the %s state', async (_name, rows, title) => {
      mount(<MetricCatalogueScreen route={route('BI-05')} />, client({ rows }), { permissions: READER });
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-BI-05 shows the loading state first, names the page, and retries after an error', async () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<MetricCatalogueScreen route={route('BI-05')} />, h, { permissions: READER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['bi.catalogue.page.title'] })).toBeTruthy();
      cleanup();
      const world: World = { rows: failure(500, 'INTERNAL_ERROR') };
      mount(<MetricCatalogueScreen route={route('BI-05')} />, client(world), { permissions: READER });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      world.rows = [platform];
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('metric-table')).toBeTruthy();
    });
  });
});

describe('BI-06 definition of a metric (ST-BI-001, BI 3 F1)', () => {
  it('AC-ST-BI-001-1: UAT-AC471 shows a revision of the platform read-only with its commit and hash, and no form', async () => {
    mount(<MetricDefinitionScreen route={route('BI-06')} />, client({ rows: [], one: platform }), { permissions: MANAGER }, `/?id=${ID}`);
    const view = await screen.findByTestId('metric-view');
    expect(view.getAttribute('data-origin')).toBe('PLATFORM_CODE');
    expect(within(view).getByText('SUM(GIAI_NGAN) / SUM(KE_HOACH_TTG)')).toBeTruthy();
    expect(within(view).getByText('c1a2b3c')).toBeTruthy();
    expect(within(view).getByText('a'.repeat(64))).toBeTruthy();
    expect(within(view).getByText(vi_['bi.metric.nullPolicy.notZero'])).toBeTruthy();
    expect(screen.getByTestId('metric-platform-note').textContent).toBe(vi_['bi.definition.platformNote']);
    expect(screen.queryByRole('button', { name: vi_['bi.definition.save'] })).toBeNull();
  });

  it('shows a revision of the tenant without the note of the platform, and a revision that is not there as an error', async () => {
    mount(<MetricDefinitionScreen route={route('BI-06')} />, client({ rows: [], one: tenantDraft }), { permissions: READER }, `/?id=${TENANT_ID}`);
    expect((await screen.findByTestId('metric-view')).getAttribute('data-origin')).toBe('TENANT_UI');
    expect(screen.queryByTestId('metric-platform-note')).toBeNull();
    cleanup();
    mount(<MetricDefinitionScreen route={route('BI-06')} />, client({ rows: [], one: failure(404, 'RESOURCE_NOT_FOUND') }), { permissions: READER }, `/?id=${ID}`);
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    mount(<MetricDefinitionScreen route={route('BI-06')} />, client({ rows: [], one: failure(403, 'SCOPE_DENIED') }), { permissions: READER }, `/?id=${ID}`);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });

  it('AC-ST-BI-001-2: UAT-AC472 drafts a ratio from a numerator and a denominator, and sends the tree the editor built', async () => {
    const user = userEvent.setup();
    const h = client({ rows: [] });
    mount(<MetricDefinitionScreen route={route('BI-06')} />, h, { permissions: MANAGER });
    await user.clear(screen.getByLabelText(vi_['bi.definition.field.code']));
    await user.type(screen.getByLabelText(vi_['bi.definition.field.code']), 't_rate');
    await user.type(screen.getByLabelText(vi_['bi.definition.field.grain']), 'project');
    await user.selectOptions(screen.getByLabelText(vi_['bi.definition.field.aggregation']), 'ratio');
    await user.type(screen.getByLabelText(vi_['bi.definition.field.unit']), 'percent');
    // A ratio has a numerator and a denominator, each an aggregate over a field; the formula of a metric that is not a ratio is not asked.
    expect(document.querySelector('[data-operand="expression"]')).toBeNull();
    const numerator = document.querySelector('[data-operand="numerator"]') as HTMLElement;
    const denominator = document.querySelector('[data-operand="denominator"]') as HTMLElement;
    await user.type(within(numerator).getByLabelText(vi_['bi.definition.operandField.label']), 'GIAI_NGAN');
    await user.selectOptions(within(denominator).getByLabelText(vi_['bi.definition.aggregate.label']), 'sum');
    await user.type(within(denominator).getByLabelText(vi_['bi.definition.operandField.label']), 'KE_HOACH_TTG');
    await user.type(screen.getByLabelText(vi_['bi.definition.field.dimensions']), 'unit, fund');
    await user.type(screen.getByLabelText(vi_['bi.definition.field.dataset']), DATASET);
    await user.type(screen.getByLabelText(vi_['bi.definition.field.from']), '2026-01-01');
    await user.click(screen.getByRole('button', { name: vi_['bi.definition.save'] }));
    expect((await screen.findByTestId('metric-saved')).textContent).toBe(vi_['bi.definition.saved']);
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('createTenantMetricDefinition');
    expect(input.body).toEqual({
      code: 't_rate',
      grain: 'project',
      aggregation_type: 'ratio',
      expression_ast: { op: 'div', args: [sum('GIAI_NGAN'), sum('KE_HOACH_TTG')] },
      numerator_ast: sum('GIAI_NGAN'),
      denominator_ast: sum('KE_HOACH_TTG'),
      unit: 'percent',
      null_policy: 'NULL_NOT_ZERO',
      dimension_codes: ['unit', 'fund'],
      dataset_id: DATASET,
      effective_from: '2026-01-01',
    });
  });

  it('names each field that is wrong and sends nothing until they are right', async () => {
    const user = userEvent.setup();
    const h = client({ rows: [] });
    mount(<MetricDefinitionScreen route={route('BI-06')} />, h, { permissions: MANAGER });
    await user.click(screen.getByRole('button', { name: vi_['bi.definition.save'] }));
    expect(await screen.findByText(vi_['bi.metric.problem.invalidCode'])).toBeTruthy();
    expect(screen.getAllByText(vi_['bi.metric.problem.required']).length).toBeGreaterThanOrEqual(4);
    expect(h.command).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(vi_['bi.definition.field.dimensions']), 'bad dimension');
    await user.click(screen.getByRole('button', { name: vi_['bi.definition.save'] }));
    expect(await screen.findByText(vi_['bi.metric.problem.invalidDimension'])).toBeTruthy();
  });

  it.each([
    ['RATIO_REQUIRES_NUMERATOR_DENOMINATOR', undefined, vi_['bi.metric.refused.ratio']],
    ['EXPRESSION_NOT_ALLOWED', 'expression', vi_['bi.metric.refused.expression']],
    ['PLATFORM_METRIC_READ_ONLY', 'code', vi_['bi.metric.refused.platformReadOnly']],
    ['DIMENSION_NOT_IN_DATASET', 'fund', fill(vi_['bi.metric.refused.dimension'], { field: 'fund' })],
    ['VALIDATION_FAILED', 'dataset_id', fill(vi_['bi.metric.refused.invalid'], { field: 'dataset_id' })],
    ['INTERNAL_ERROR', undefined, vi_['bi.metric.refused.general']],
  ])('AC-ST-BI-001-2: UAT-AC472 says what the server refused: %s', async (code, detail, message) => {
    const user = userEvent.setup();
    mount(<MetricDefinitionScreen route={route('BI-06')} />, client({ rows: [] }, () => failure(code === 'INTERNAL_ERROR' ? 500 : 422, code, detail)), { permissions: MANAGER });
    await user.clear(screen.getByLabelText(vi_['bi.definition.field.code']));
    await user.type(screen.getByLabelText(vi_['bi.definition.field.code']), 'disbursement_rate_x');
    // A valid form of a code that is not tenant's is refused on the screen first; here the code is the tenant's and the refusal comes from the server.
    await user.clear(screen.getByLabelText(vi_['bi.definition.field.code']));
    await user.type(screen.getByLabelText(vi_['bi.definition.field.code']), 't_rate');
    await user.type(screen.getByLabelText(vi_['bi.definition.field.grain']), 'project');
    await user.type(screen.getByLabelText(vi_['bi.definition.field.unit']), 'VND');
    await user.type(within(document.querySelector('[data-operand="expression"]') as HTMLElement).getByLabelText(vi_['bi.definition.operandField.label']), 'A');
    await user.type(screen.getByLabelText(vi_['bi.definition.field.dataset']), DATASET);
    await user.type(screen.getByLabelText(vi_['bi.definition.field.from']), '2026-01-01');
    await user.click(screen.getByRole('button', { name: vi_['bi.definition.save'] }));
    await waitFor(() => expect(screen.getByTestId('metric-refused').textContent).toBe(message));
  });

  it('shows no form to whoever may not draft, nor while the tenant is read-only', async () => {
    mount(<MetricDefinitionScreen route={route('BI-06')} />, client({ rows: [] }), { permissions: READER });
    expect((await screen.findByTestId('metric-form-denied')).textContent).toBe(vi_['bi.definition.noPermission']);
    cleanup();
    mount(<MetricDefinitionScreen route={route('BI-06')} />, client({ rows: [] }), { permissions: MANAGER, mode: 'READ_ONLY' });
    expect(await screen.findByTestId('metric-form-denied')).toBeTruthy();
  });

  it('UI-BI-06 shows the loading state of a revision first and names the page', async () => {
    const h = harness(() => new Promise(() => undefined));
    mount(<MetricDefinitionScreen route={route('BI-06')} />, h, { permissions: READER }, `/?id=${ID}`);
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(screen.getByRole('region', { name: vi_['bi.definition.page.title'] })).toBeTruthy();
  });
});

describe('BI-15 registration of metrics from source (ST-BI-001, BI 3 F1)', () => {
  it('AC-ST-BI-001-1: UAT-AC471 lists the commits that brought metrics, with what each added, revised and retired, and says where the log of the syncs is missing', async () => {
    const rows = [
      rawMetric({ id: '1', code: 'a', revision: 1, status: 'SUPERSEDED', source_commit: 'c1a2b3c', created_at: '2026-10-01T00:00:00.000Z' }),
      rawMetric({ id: '2', code: 'a', revision: 2, status: 'CERTIFIED', source_commit: 'c4d5e6f', created_at: '2026-10-02T00:00:00.000Z' }),
      rawMetric({ id: '3', code: 'b', revision: 1, status: 'RETIRED', source_commit: 'c1a2b3c', created_at: '2026-10-01T00:00:00.000Z' }),
      tenantDraft,
    ];
    mount(<RegistrationScreen route={route('BI-15')} />, client({ rows }), { permissions: READER });
    const table = await screen.findByTestId('registration-table');
    const [latest, first] = [...table.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(latest?.getAttribute('data-commit')).toBe('c4d5e6f');
    expect([...(latest?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent)).toEqual(['c4d5e6f', vi_['bi.registration.noLog'], '0', '1', '0', '1', vi_['bi.registration.status.applied'], vi_['bi.registration.noLog']]);
    expect([...(first?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent).slice(2, 6)).toEqual(['2', '0', '1', '0']);
    for (const name of ['commit', 'hash', 'added', 'revised', 'retired', 'status', 'error']) {
      expect(within(table).getByRole('columnheader', { name: vi_[`bi.registration.column.${name}` as keyof typeof vi_] })).toBeTruthy();
    }
    expect(screen.getByRole('link', { name: vi_['bi.registration.back'] }).getAttribute('href')).toBe('/bi/bi-05');
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', [tenantDraft], vi_['states.empty.title']],
      ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ] as Array<[string, unknown[] | Error, string]>)('UI-BI-15 shows the %s state', async (_name, rows, title) => {
      mount(<RegistrationScreen route={route('BI-15')} />, client({ rows }), { permissions: READER });
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-BI-15 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<RegistrationScreen route={route('BI-15')} />, h, { permissions: READER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['bi.registration.page.title'] })).toBeTruthy();
    });
  });
});
