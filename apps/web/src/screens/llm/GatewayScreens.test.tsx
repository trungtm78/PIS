import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import { BASELINE_POLICY, NO_FILTER, filterQuery, sharePercent, toRequest, toRequestPage, toRouteDecision } from './gateway-model';
import RequestsScreen from './RequestsScreen';
import RoutingScreen from './RoutingScreen';

const OVERVIEW = routeOf('LLM-01', 'FR-LLM-01');
const ROUTING = routeOf('LLM-05', 'FR-LLM-05');
const AUDITOR = ['llm.audit.read'];
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const rawRequest = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: id(n),
  task_type: 'SUMMARY',
  subject_module: 'BID',
  subject_id: null,
  data_classification: 'INTERNAL',
  route_class: 'DOMESTIC_HOSTED',
  provider_code: 'VN-HOST',
  model_id: 'dom-model',
  status: 'COMPLETED',
  reject_code: null,
  citations_count: 2,
  cost_vnd: '4318',
  requested_by: id(900),
  created_at: '2026-10-20T10:00:00.000Z',
  completed_at: '2026-10-20T10:00:02.000Z',
  version: 4,
  ...overrides,
});
const SUMMARY = { period_start: '2026-10-01', total: 1000, by_route: { DOMESTIC_HOSTED: 700, SELF_HOSTED: 250, INTERNATIONAL: 50 }, by_status: { COMPLETED: 940, REJECTED_POLICY: 30, FAILED: 25, REJECTED_NO_CITATION: 5 }, blocked: 30 };
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, next_cursor: null, as_of: '2026-10-28T00:00:00.000Z', summary: SUMMARY, ...extra });

const rawAttempt = (no: number, overrides: Record<string, unknown> = {}) => ({
  id: id(100 + no),
  ai_request_id: id(1),
  attempt_no: no,
  attempt_kind: no === 1 ? 'PRIMARY' : 'FALLBACK',
  route_class: no === 1 ? 'DOMESTIC_HOSTED' : 'SELF_HOSTED',
  provider_code: no === 1 ? 'VN-HOST' : 'SELF-1',
  model_id: no === 1 ? 'dom-model' : 'self-model',
  outcome: no === 1 ? 'PROVIDER_ERROR' : 'SUCCESS',
  latency_ms: 120,
  cost_vnd: no === 1 ? '0' : '4318',
  ...overrides,
});
const rawDecision = (overrides: Record<string, unknown> = {}) => ({
  ai_request_id: id(1),
  data_classification: 'CONFIDENTIAL',
  classification_basis: [{ document_version_id: id(50), classification: 'CONFIDENTIAL' }],
  policy_version_id: id(60),
  route_class: 'SELF_HOSTED',
  provider_code: 'SELF-1',
  model_id: 'self-model',
  status: 'COMPLETED',
  reject_code: null,
  attempts: [rawAttempt(1), rawAttempt(2)],
  ...overrides,
});

interface World {
  requests: unknown | Error;
  decision: unknown | Error;
}
const normal = (): World => ({ requests: page([rawRequest(1), rawRequest(2, { data_classification: 'PUBLIC', route_class: 'INTERNATIONAL', model_id: 'intl-model', provider_code: 'INTL-1' })]), decision: rawDecision() });

function client(world: World | ((operation: string, input: unknown) => unknown)) {
  const answer = typeof world === 'function' ? world : (operation: string) => (operation === 'listAiRequests' ? world.requests : operation === 'getAiRequestRoute' ? world.decision : new Error(`unexpected read ${operation}`));
  return harness((operation, input) => answer(operation, input));
}

afterEach(cleanup);

describe('the pure rules of the gateway records (ST-LLM-005)', () => {
  it('writes a share with two places from whole numbers, rounded half up, and none when there is nothing to divide', () => {
    expect(sharePercent(50, 1000)).toBe('5.00');
    expect(sharePercent(1, 3)).toBe('33.33');
    expect(sharePercent(2, 3)).toBe('66.67');
    expect(sharePercent(1, 8)).toBe('12.50');
    expect(sharePercent(1000, 1000)).toBe('100.00');
    expect(sharePercent(0, 1000)).toBe('0.00');
    expect(sharePercent(5, 0)).toBe('0.00');
  });

  it('reads a request as it is shown and keeps nothing that is not in the view', () => {
    const entry = toRequest({ ...rawRequest(1), input_sha256: 'a'.repeat(64), output_sha256: 'b'.repeat(64), classification_basis: [{ secret: 1 }] });
    expect(entry).toMatchObject({ taskType: 'SUMMARY', classification: 'INTERNAL', route: 'DOMESTIC_HOSTED', status: 'COMPLETED', citations: 2, costVnd: '4318' });
    expect(JSON.stringify(entry)).not.toMatch(/sha256|secret|a{64}/);
    expect(toRequest({ ...rawRequest(1), status: 'GONE' })).toBeUndefined();
    expect(toRequest({ ...rawRequest(1), data_classification: 'SECRET' })).toBeUndefined();
    expect(toRequest(null)).toBeUndefined();
    const read = toRequestPage(page([rawRequest(1), { nope: true }], { next_cursor: 'abc' }));
    expect([read.items.length, read.next, read.summary?.total, read.summary?.blocked]).toEqual([1, 'abc', 1000, 30]);
    expect(toRequestPage(null)).toEqual({ items: [], next: undefined, summary: undefined });
  });

  it('reads the route decision, names the baseline when no policy was in force, and drops what it cannot read', () => {
    expect(toRouteDecision(rawDecision())).toMatchObject({ classification: 'CONFIDENTIAL', policyVersionId: id(60), route: 'SELF_HOSTED', providerCode: 'SELF-1' });
    expect(toRouteDecision(rawDecision())?.attempts.map((attempt) => attempt.no)).toEqual([1, 2]);
    expect(toRouteDecision(rawDecision({ policy_version_id: BASELINE_POLICY }))?.policyVersionId).toBeNull();
    expect(toRouteDecision(rawDecision({ route_class: '', provider_code: '', model_id: '', attempts: [{ bad: 1 }], classification_basis: [{ nope: 1 }] }))).toMatchObject({ route: null, attempts: [], basis: [] });
    expect(toRouteDecision(rawDecision({ status: 'X' }))).toBeUndefined();
  });

  it('asks the server only for what was chosen', () => {
    expect(filterQuery(NO_FILTER)).toEqual({});
    expect(filterQuery({ status: 'FAILED', route: 'INTERNATIONAL', classification: 'PUBLIC', task: ' SUMMARY ' })).toEqual({ status: 'FAILED', route_class: 'INTERNATIONAL', data_classification: 'PUBLIC', task_type: 'SUMMARY' });
  });
});

describe('LLM-01 overview of the requests (ST-LLM-005, LLM F1)', () => {
  it('AC-ST-LLM-005-5: UAT-AC464 shows 50 of 1,000 requests as 5.00 percent international and 30 as blocked, and every international request as public', async () => {
    mount(<RequestsScreen route={OVERVIEW} />, client(normal()), { permissions: AUDITOR });
    const tiles = await screen.findByTestId('request-tiles');
    expect(tiles.querySelector('[data-tile="total"]')?.textContent).toContain('1,000');
    expect(tiles.querySelector('[data-tile="INTERNATIONAL"]')?.textContent).toContain('50');
    expect(tiles.querySelector('[data-share="INTERNATIONAL"]')?.textContent).toBe('5.00%');
    expect(tiles.querySelector('[data-share="DOMESTIC_HOSTED"]')?.textContent).toBe('70.00%');
    expect(tiles.querySelector('[data-tile="blocked"]')?.textContent).toContain('30');
    expect(tiles.querySelector('[data-tile="failed"]')?.textContent).toContain('30');
    expect(tiles.textContent).toContain(fill(vi_['llm.requests.month'], { month: '2026-10' }));
    expect(tiles.textContent).toContain(vi_['llm.requests.internationalNote']);
    const international = within(screen.getByTestId('request-table')).getAllByRole('row').filter((row) => row.getAttribute('data-route') === 'INTERNATIONAL');
    expect(international.length).toBe(1);
    expect(international.every((row) => row.getAttribute('data-classification') === 'PUBLIC')).toBe(true);
  });

  it('shows each request with its class, route, model, state and cost, links it to its route, and shows no content', async () => {
    const world = {
      ...normal(),
      requests: page([
        { ...rawRequest(1), input_sha256: 'a'.repeat(64), prompt: 'the national id 079203001234' },
        rawRequest(3, { status: 'REJECTED_POLICY', route_class: null, provider_code: null, model_id: null, reject_code: 'AI_ROUTE_NOT_ALLOWED', cost_vnd: null, data_classification: 'IMPORTANT_CORE' }),
      ]),
    };
    mount(<RequestsScreen route={OVERVIEW} />, client(world), { permissions: AUDITOR });
    const table = await screen.findByTestId('request-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('2026-10-20');
    expect(rows[0]?.textContent).toContain(vi_['llm.classification.internal']);
    expect(rows[0]?.textContent).toContain(vi_['llm.route.domestic']);
    expect(rows[0]?.textContent).toContain('dom-model');
    expect(rows[0]?.textContent).toContain(vi_['llm.requestStatus.completed']);
    expect(rows[0]?.textContent).toContain('4,318 ₫');
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: vi_['llm.requests.route'] }).getAttribute('href')).toBe(`/llm/llm-05?request=${id(1)}`);
    expect(rows[1]?.textContent).toContain(vi_['llm.requestStatus.rejectedPolicy']);
    expect(rows[1]?.textContent).toContain(vi_['llm.rejectCode.routeNotAllowed']);
    expect(rows[1]?.textContent).toContain(vi_['llm.classification.importantCore']);
    expect(rows[1]?.textContent).toContain('—');
    expect(document.body.textContent).not.toMatch(/079203001234|a{64}/);
  });

  it('narrows the list by what the reader chooses and asks the server for it', async () => {
    const user = userEvent.setup();
    const h = client(normal());
    mount(<RequestsScreen route={OVERVIEW} />, h, { permissions: AUDITOR });
    await screen.findByTestId('request-table');
    expect(h.read.mock.calls[0]).toEqual(['listAiRequests', { query: { limit: 50 } }]);
    await user.selectOptions(screen.getByLabelText(vi_['llm.requests.filter.status']), 'FAILED');
    await user.selectOptions(screen.getByLabelText(vi_['llm.requests.filter.route']), 'INTERNATIONAL');
    await user.selectOptions(screen.getByLabelText(vi_['llm.requests.filter.classification']), 'PUBLIC');
    await user.type(screen.getByLabelText(vi_['llm.requests.filter.task']), 'SUMMARY');
    await waitFor(() => expect(h.read.mock.calls.at(-1)).toEqual(['listAiRequests', { query: { limit: 50, status: 'FAILED', route_class: 'INTERNATIONAL', data_classification: 'PUBLIC', task_type: 'SUMMARY' } }]));
  });

  it('reads the next page when asked, and says when it could not', async () => {
    const user = userEvent.setup();
    const h = client((_operation, input) => {
      const cursor = (input as { query: { cursor?: string } }).query.cursor;
      if (cursor === undefined) return page([rawRequest(1)], { next_cursor: 'page-2' });
      return failure(500, 'INTERNAL_ERROR');
    });
    mount(<RequestsScreen route={OVERVIEW} />, h, { permissions: AUDITOR });
    await user.click(await screen.findByTestId('requests-more'));
    expect(await screen.findByTestId('requests-more-failed')).toBeTruthy();
    expect(within(screen.getByTestId('request-table')).getAllByRole('row').length).toBe(2);
    expect(h.read.mock.calls.at(-1)).toEqual(['listAiRequests', { query: { limit: 50, cursor: 'page-2' } }]);
  });

  describe('the standard states', () => {
    it.each([
      ['denied', { ...normal(), requests: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), requests: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), requests: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), requests: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-LLM-01 shows the %s state', async (_name, world, text) => {
      mount(<RequestsScreen route={OVERVIEW} />, client(world), { permissions: AUDITOR });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-01 says that no request matches and shows no figure when there is nothing', async () => {
      mount(<RequestsScreen route={OVERVIEW} />, client({ ...normal(), requests: { items: [], next_cursor: null } }), { permissions: AUDITOR });
      expect((await screen.findByTestId('requests-none')).textContent).toBe(vi_['llm.requests.none']);
      expect(screen.queryByTestId('request-tiles')).toBeNull();
    });

    it('UI-LLM-01 shows the loading state first and names the page', () => {
      const h = harness(() => new Promise(() => undefined));
      mount(<RequestsScreen route={OVERVIEW} />, h, { permissions: AUDITOR });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.requests.page.title'] })).toBeTruthy();
    });
  });
});

describe('LLM-05 routing and fallback (ST-LLM-005, LLM F1)', () => {
  const at = `/?request=${id(1)}`;

  it('AC-ST-LLM-005-2: UAT-AC19 explains the class and the sources, the policy in force, the route it ended on and each attempt of a request that fell back', async () => {
    mount(<RoutingScreen route={ROUTING} />, client(normal()), { permissions: AUDITOR }, at);
    expect((await screen.findByTestId('routing-classification')).textContent).toBe(vi_['llm.classification.confidential']);
    expect(screen.getByTestId('routing-policy').textContent).toBe(id(60));
    expect(screen.getByTestId('routing-route').textContent).toBe(`${vi_['llm.route.selfHosted']} · SELF-1 · self-model`);
    expect(screen.getByTestId('routing-status').textContent).toBe(vi_['llm.requestStatus.completed']);
    expect(screen.getByTestId('routing-sources').textContent).toContain(id(50).slice(0, 8));
    const rows = within(screen.getByTestId('attempt-table')).getAllByRole('row').slice(1);
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain(vi_['llm.attemptKind.primary']);
    expect(rows[0]?.textContent).toContain(vi_['llm.outcome.providerError']);
    expect(rows[1]?.textContent).toContain(vi_['llm.attemptKind.fallback']);
    expect(rows[1]?.textContent).toContain(vi_['llm.route.selfHosted']);
    expect(rows[1]?.textContent).toContain('4,318 ₫');
    expect(rows.map((row) => row.getAttribute('data-route'))).toEqual(['DOMESTIC_HOSTED', 'SELF_HOSTED']);
  });

  it('AC-ST-LLM-005-2: UAT-AC19 says that every allowed route was tried when the request failed, and that no international attempt was made', async () => {
    const decision = rawDecision({ status: 'FAILED', reject_code: 'AI_ROUTE_EXHAUSTED', attempts: [rawAttempt(1), rawAttempt(2, { outcome: 'REFUSAL', cost_vnd: '0' })] });
    mount(<RoutingScreen route={ROUTING} />, client({ ...normal(), decision }), { permissions: AUDITOR }, at);
    const status = await screen.findByTestId('routing-status');
    expect(status.textContent).toContain(vi_['llm.requestStatus.failed']);
    expect(status.textContent).toContain(vi_['llm.rejectCode.routeExhausted']);
    const rows = within(screen.getByTestId('attempt-table')).getAllByRole('row').slice(1);
    expect(rows.some((row) => row.getAttribute('data-route') === 'INTERNATIONAL')).toBe(false);
    expect(rows[1]?.textContent).toContain(vi_['llm.outcome.refusal']);
  });

  it('names the baseline when no policy was in force, and shows a refused request with no attempt and no route', async () => {
    const decision = rawDecision({ policy_version_id: BASELINE_POLICY, status: 'REJECTED_POLICY', reject_code: 'AI_ROUTE_NOT_ALLOWED', route_class: '', provider_code: '', model_id: '', attempts: [], data_classification: 'IMPORTANT_CORE' });
    mount(<RoutingScreen route={ROUTING} />, client({ ...normal(), decision }), { permissions: AUDITOR }, at);
    expect((await screen.findByTestId('routing-policy')).textContent).toBe(vi_['llm.routing.baseline']);
    expect(screen.getByTestId('routing-route').textContent).toBe(vi_['llm.requests.noRoute']);
    expect(screen.getByTestId('routing-status').textContent).toContain(vi_['llm.rejectCode.routeNotAllowed']);
    expect(screen.getByTestId('routing-no-attempts').textContent).toBe(vi_['llm.routing.noAttempts']);
  });

  it('asks for a request first, offers the recent ones, and reads the route of the one chosen', async () => {
    const user = userEvent.setup();
    const h = client(normal());
    mount(<RoutingScreen route={ROUTING} />, h);
    expect((await screen.findByTestId('routing-pick')).textContent).toBe(vi_['llm.routing.pick']);
    const select = screen.getByLabelText(vi_['llm.routing.choose']);
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBe(3));
    expect(h.read.mock.calls.some((call) => call[0] === 'getAiRequestRoute')).toBe(false);
    await user.selectOptions(select, id(1));
    expect((await screen.findByTestId('routing-classification')).textContent).toBe(vi_['llm.classification.confidential']);
    expect(h.read.mock.calls.find((call) => call[0] === 'getAiRequestRoute')).toEqual(['getAiRequestRoute', { path: { id: id(1) } }]);
  });

  it('says so when the list of recent requests could not be read, and when the record of the request could not be understood', async () => {
    const { unmount } = mount(<RoutingScreen route={ROUTING} />, client((operation) => (operation === 'listAiRequests' ? failure(500, 'INTERNAL_ERROR') : rawDecision())), { permissions: AUDITOR });
    expect(await screen.findByTestId('routing-list-failed')).toBeTruthy();
    unmount();
    mount(<RoutingScreen route={ROUTING} />, client({ ...normal(), decision: { nothing: true } }), { permissions: AUDITOR }, at);
    expect((await screen.findByTestId('routing-unreadable')).textContent).toBe(vi_['llm.routing.unreadable']);
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
  ] as const)('UI-LLM-05 shows the %s state', async (_name, error, text) => {
    mount(<RoutingScreen route={ROUTING} />, client({ ...normal(), decision: error }), { permissions: AUDITOR }, at);
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
  });

  it('UI-LLM-05 shows the loading state first and names the page', () => {
    const h = harness(() => new Promise(() => undefined));
    mount(<RoutingScreen route={ROUTING} />, h, { permissions: AUDITOR }, at);
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(screen.getByRole('region', { name: vi_['llm.routing.page.title'] })).toBeTruthy();
  });
});

void vi;
