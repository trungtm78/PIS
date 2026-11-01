import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { routeOf } from '../../dgv/test-support';
import { mountInSession } from '../../doc/test-support';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { ERROR_STATUSES, GUARDRAIL_STATUSES, isError, isGuardrail, maskPersonal, matches, shortId } from './model';
import TraceScreen from './TraceScreen';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const uuid = (n: number): string => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, 'f')}`;
const ROUTE = routeOf('LLM-14', 'FR-LLM-14');
const CCCD = '001099012345';
const PHONE = '0912345678';

const request = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  task_type: `summarise-${n}`,
  subject_module: 'PRJ',
  data_classification: 'INTERNAL',
  route_class: 'DOMESTIC_HOSTED',
  provider_code: 'VN1',
  model_id: 'viet-llm',
  status: 'COMPLETED',
  reject_code: null,
  cost_vnd: '1200.5',
  created_at: '2026-11-01T17:30:00Z',
  ...extra,
});
const decision = (n: number, extra: Record<string, unknown> = {}) => ({
  ai_request_id: uuid(n),
  data_classification: 'CONFIDENTIAL',
  classification_basis: [],
  policy_version_id: uuid(800),
  route_class: 'DOMESTIC_HOSTED',
  provider_code: 'VN1',
  model_id: 'viet-llm',
  status: 'FAILED',
  reject_code: 'AI_ROUTE_EXHAUSTED',
  attempts: [
    { id: uuid(700), attempt_no: 1, attempt_kind: 'PRIMARY', route_class: 'DOMESTIC_HOSTED', provider_code: 'VN1', model_id: 'viet-llm', outcome: 'TIMEOUT', latency_ms: 900, cost_vnd: '10.25' },
    { id: uuid(701), attempt_no: 2, attempt_kind: 'FALLBACK', route_class: 'SELF_HOSTED', provider_code: null, model_id: 'local', outcome: 'SUCCESS', latency_ms: null, cost_vnd: null },
  ],
  ...extra,
});

interface World {
  requests: Array<Record<string, unknown>>;
  more: Array<Record<string, unknown>>;
  decisions: Record<string, unknown>;
  failing: { requests?: Error; route?: Error; more?: Error };
}

function open(state: Partial<World> = {}, options: { permissions?: readonly string[] | undefined; path?: string } = {}): Harness & { world: World } {
  const world: World = { requests: [], more: [], decisions: {}, failing: {}, ...state };
  const h = harness((operation, input) => {
    const query = (input as { query?: Record<string, string> } | undefined)?.query ?? {};
    if (operation === 'listAiRequests') {
      if (query.cursor !== undefined) return world.failing.more ?? { items: world.more, next_cursor: null };
      return world.failing.requests ?? { items: world.requests, next_cursor: world.more.length > 0 || world.failing.more ? 'c2' : null };
    }
    if (operation === 'getAiRequestRoute') return world.failing.route ?? world.decisions[(input as { path: { id: string } }).path.id] ?? null;
    return new Error(`unexpected read ${operation}`);
  });
  mountInSession(<TraceScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : ['llm.audit.read'] }, options.path ?? '/llm/llm-14');
  return Object.assign(h, { world });
}

const reads = (h: Harness, operation: string): Array<{ query?: Record<string, string>; path?: Record<string, string> }> =>
  h.read.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { query?: Record<string, string>; path?: Record<string, string> });
const rowsOf = (): HTMLElement[] => within(screen.getByTestId('trace-table')).getAllByRole('row').slice(1);
const set = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};

afterEach(() => cleanup());

describe('the model of the traces (ST-LLM-009)', () => {
  it('hides identity numbers and telephone numbers whatever the way they are written, and leaves longer runs of digits alone', () => {
    expect(maskPersonal(`so ${CCCD} va ${PHONE}`)).toBe('so *** va ***');
    expect(maskPersonal('0912 345 678')).toBe('***');
    expect(maskPersonal('0912.345.678')).toBe('***');
    expect(maskPersonal('+84 912-345-678')).toBe('***');
    expect(maskPersonal('+84912345678')).toBe('***');
    expect(maskPersonal(`task-${CCCD}`)).toBe('task-***');
    expect(maskPersonal('1234567890123')).toBe('1234567890123');
    expect(maskPersonal('summarise-12')).toBe('summarise-12');
    expect(maskPersonal('')).toBe('');
  });

  it('tells a request that went wrong or was stopped, and one that a guardrail refused', () => {
    for (const status of ERROR_STATUSES) expect(isError({ status, rejectCode: null })).toBe(true);
    expect(isError({ status: 'COMPLETED', rejectCode: null })).toBe(false);
    expect(isError({ status: 'COMPLETED', rejectCode: 'NO_CITATION' })).toBe(true);
    for (const status of GUARDRAIL_STATUSES) expect(isGuardrail({ status })).toBe(true);
    expect(isGuardrail({ status: 'FAILED' })).toBe(false);
    expect(shortId(uuid(1))).toBe('a1b2c3d4');
  });

  it('finds words in the identifier, the task, the model, the provider and the rule', () => {
    const entry = { id: uuid(1), taskType: 'Summarise', modelId: 'viet-llm', providerCode: 'VN1', rejectCode: 'PROMPT_INJECTION' };
    for (const words of ['', '  ', 'a1b2', 'summ', 'VIET', 'vn1', 'injection']) expect(matches(entry, words)).toBe(true);
    expect(matches(entry, 'zzz')).toBe(false);
    expect(matches({ ...entry, modelId: null, providerCode: null, rejectCode: null }, 'viet')).toBe(false);
  });
});

describe('LLM-14 traces and errors', () => {
  it('lists each request with its task, model, class, route and the rule that stopped it, and nothing that was asked or answered', async () => {
    open({
      requests: [request(1), request(2, { status: 'REJECTED_POLICY', reject_code: 'PROMPT_INJECTION', route_class: null, model_id: null, provider_code: null, data_classification: 'CONFIDENTIAL' })],
    });
    expect(await screen.findByRole('heading', { level: 1, name: word('llm.trace.page.title') })).toBeTruthy();
    await screen.findByTestId('trace-table');
    const [good, refused] = rowsOf() as [HTMLElement, HTMLElement];
    expect(within(good).getByText('a1b2c3d4')).toBeTruthy();
    expect(within(good).getByText('viet-llm · VN1')).toBeTruthy();
    expect(within(good).getByText(word('llm.classification.internal'))).toBeTruthy();
    expect(within(good).getByText(word('llm.route.domestic'))).toBeTruthy();
    expect(refused.textContent).toContain(word('llm.requestStatus.rejectedPolicy'));
    expect(refused.textContent).toContain('PROMPT_INJECTION');
    expect(within(refused).getByText(word('llm.requests.noRoute'))).toBeTruthy();
    expect(within(refused).getByText('—')).toBeTruthy();
    expect(screen.getByTestId('trace-note').textContent).toBe(word('llm.trace.privacy.note'));
    expect(screen.getByRole('link', { name: word('llm.trace.guardrail.link') }).getAttribute('href')).toBe('/llm/llm-15');
  });

  it('shows no personal pattern in any field of a trace', async () => {
    const h = open(
      {
        requests: [request(1, { task_type: `extract-${CCCD} ${PHONE}`, subject_module: PHONE, model_id: `m ${CCCD}`, provider_code: PHONE, status: 'REJECTED_POLICY', reject_code: `RULE ${PHONE}` })],
        decisions: {
          [uuid(1)]: decision(1, {
            model_id: `m ${CCCD}`,
            provider_code: PHONE,
            reject_code: `RULE ${CCCD}`,
            attempts: [{ ...decision(1).attempts[0], model_id: `m ${CCCD}`, provider_code: PHONE, outcome: `ERR ${PHONE}` }],
          }),
        },
      },
      { path: `/llm/llm-14?trace=${uuid(1)}` },
    );
    await screen.findByTestId('trace-detail');
    await screen.findByTestId('detail-attempts');
    const page = document.body.textContent ?? '';
    expect(page).not.toContain(CCCD);
    expect(page).not.toContain(PHONE);
    expect(page).toContain('***');
    expect(h.read).toHaveBeenCalled();
  });

  it('asks the server for the filters and narrows to errors and to words on what was loaded', async () => {
    const h = open({
      requests: [request(1), request(2, { status: 'FAILED', reject_code: 'AI_ROUTE_EXHAUSTED', model_id: 'other-llm' }), request(3, { status: 'COMPLETED', reject_code: 'NO_CITATION' })],
    });
    await screen.findByTestId('trace-table');
    expect(rowsOf()).toHaveLength(3);
    fireEvent.click(screen.getByLabelText(word('llm.trace.filter.errors')));
    expect(rowsOf()).toHaveLength(2);
    set('trace-words', 'other');
    expect(rowsOf()).toHaveLength(1);
    set('trace-words', 'nothing like it');
    expect(screen.getByTestId('trace-none')).toBeTruthy();
    set('trace-words', '');
    fireEvent.click(screen.getByLabelText(word('llm.trace.filter.errors')));
    set('trace-status', 'FAILED');
    set('trace-route', 'SELF_HOSTED');
    set('trace-class', 'PERSONAL');
    set('trace-task', ' summarise ');
    await waitFor(() =>
      expect(
        reads(h, 'listAiRequests').some(
          (call) => call.query?.task_type === 'summarise' && call.query.status === 'FAILED' && call.query.route_class === 'SELF_HOSTED' && call.query.data_classification === 'PERSONAL',
        ),
      ).toBe(true),
    );
  });

  it('opens a trace to its calls with the outcome and the time each took, and closes it', async () => {
    const h = open({ requests: [request(1, { status: 'FAILED', reject_code: 'AI_ROUTE_EXHAUSTED' })], decisions: { [uuid(1)]: decision(1) } });
    await screen.findByTestId('trace-table');
    fireEvent.click(screen.getByRole('button', { name: word('llm.trace.open.action').replace('{id}', 'a1b2c3d4') }));
    const panel = await screen.findByTestId('trace-detail');
    await within(panel).findByTestId('detail-attempts');
    expect(reads(h, 'getAiRequestRoute')[0]?.path).toEqual({ id: uuid(1) });
    expect(within(panel).getByTestId('detail-id').textContent).toBe(uuid(1));
    expect(within(panel).getByTestId('detail-classification').textContent).toBe(word('llm.classification.confidential'));
    expect(within(panel).getByTestId('detail-route').textContent).toContain('viet-llm');
    expect(within(panel).getByTestId('detail-status').textContent).toContain(word('llm.rejectCode.routeExhausted'));
    expect(within(panel).getByTestId('detail-latency').textContent).toBe(word('llm.routing.attempts.ms').replace('{value}', '900'));
    const attempts = within(within(panel).getByTestId('detail-attempts')).getAllByRole('row').slice(1);
    expect(attempts).toHaveLength(2);
    expect(within(attempts[0] as HTMLElement).getByText(word('llm.outcome.timeout'))).toBeTruthy();
    expect(within(attempts[1] as HTMLElement).getAllByText('—')).toHaveLength(2);
    fireEvent.click(within(panel).getByRole('button', { name: word('llm.trace.detail.close') }));
    expect(screen.queryByTestId('trace-detail')).toBeNull();
  });

  it('shows a trace with no route, no call and no rule', async () => {
    open({ decisions: { [uuid(1)]: decision(1, { route_class: '', status: 'ADMITTED', reject_code: null, attempts: [] }) } }, { path: `/llm/llm-14?trace=${uuid(1)}` });
    const panel = await screen.findByTestId('trace-detail');
    await within(panel).findByTestId('detail-no-attempts');
    expect(within(panel).getByTestId('detail-route').textContent).toBe(word('llm.requests.noRoute'));
    expect(within(panel).getByTestId('detail-latency').textContent).toBe('—');
  });

  it('says so when the trace is not there, and when reading it fails', async () => {
    open({}, { path: `/llm/llm-14?trace=${uuid(5)}` });
    const panel = await screen.findByTestId('trace-detail');
    expect(await within(panel).findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open({ failing: { route: new Error('boom') } }, { path: `/llm/llm-14?trace=${uuid(5)}` });
    expect(await within(await screen.findByTestId('trace-detail')).findByText(word('states.error.title'))).toBeTruthy();
  });

  it('loads more pages, and keeps what is shown when a page fails', async () => {
    open({ requests: [request(1)], more: [request(2)] });
    await screen.findByTestId('trace-table');
    fireEvent.click(screen.getByTestId('trace-more'));
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    cleanup();
    open({ requests: [request(1)], failing: { more: new Error('boom') } });
    await screen.findByTestId('trace-table');
    fireEvent.click(screen.getByTestId('trace-more'));
    expect(await screen.findByTestId('trace-more-failed')).toBeTruthy();
    expect(rowsOf()).toHaveLength(1);
  });

  it('keeps the filters when the server has no request for them, so that they can be changed back', async () => {
    const h = open({ requests: [request(1)] });
    await screen.findByTestId('trace-table');
    h.world.requests = [];
    set('trace-status', 'FAILED');
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    expect((screen.getByLabelText(word('llm.requests.filter.status')) as HTMLSelectElement).value).toBe('FAILED');
    h.world.requests = [request(1)];
    set('trace-status', '');
    expect(await screen.findByTestId('trace-table')).toBeTruthy();
    expect(rowsOf()).toHaveLength(1);
  });

  it('shows the states of the list: empty, failed with a retry, and refused', async () => {
    open();
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = open({ failing: { requests: new Error('boom') } });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    h.world.failing = {};
    h.world.requests = [request(1)];
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByTestId('trace-table')).toBeTruthy();
    cleanup();
    open({ failing: { requests: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) } });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });

  it('is denied without the right to audit, and reads nothing', async () => {
    const h = open({ requests: [request(1)] }, { permissions: ['llm.eval.read'] });
    expect(await screen.findByTestId('trace-denied')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open({ requests: [request(1)] }, { permissions: undefined });
    expect(await screen.findByTestId('trace-table')).toBeTruthy();
  });
});
