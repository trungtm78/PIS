import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { routeOf } from '../../dgv/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import * as labels from './labels';
import { EMPTY_RUN, RECONCILIATION_STATUSES, describeProblem, direction, money, runBody, toReconciliation, toReconciliationPage, toRunResult, validateRun } from './model';
import RoutingLogScreen from './RoutingLogScreen';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0210'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('LLM-21', 'FR-LLM-21');
const ALL = ['llm.audit.read', 'llm.finops'];

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
  classification_basis: [{ document_version_id: uuid(900), classification: 'CONFIDENTIAL' }],
  policy_version_id: uuid(800),
  route_class: 'DOMESTIC_HOSTED',
  provider_code: 'VN1',
  model_id: 'viet-llm',
  status: 'COMPLETED',
  reject_code: null,
  attempts: [
    {
      id: uuid(700),
      attempt_no: 1,
      attempt_kind: 'PRIMARY',
      route_class: 'DOMESTIC_HOSTED',
      provider_code: 'VN1',
      model_id: 'viet-llm',
      outcome: 'TIMEOUT',
      latency_ms: 900,
      cost_vnd: '10.25',
    },
    {
      id: uuid(701),
      attempt_no: 2,
      attempt_kind: 'FALLBACK',
      route_class: 'SELF_HOSTED',
      provider_code: null,
      model_id: 'local',
      outcome: 'SUCCESS',
      latency_ms: null,
      cost_vnd: null,
    },
  ],
  ...extra,
});
const reconciliation = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(500 + n),
  provider_id: uuid(600),
  provider_code: 'VN1',
  invoice_ref: `VN1-2026-${n}`,
  invoice_amount: '3180000.00000000',
  currency: 'VND',
  period_from: '2026-10-01',
  period_to: '2026-10-31',
  attempts_total: '3120000',
  variance: '60000.00000000',
  tolerance_pct: '0.50000000',
  attempt_count: 1250,
  pending_attempt_ids: [uuid(701), uuid(702), uuid(703)],
  reconciled_attempt_ids: [uuid(704)],
  reservations_settled: 0,
  status: 'VARIANCE',
  owner_id: uuid(1),
  run_count: 1,
  last_run_at: '2026-11-01T17:30:00Z',
  created_at: '2026-11-01T17:30:00Z',
  version: 1,
  ...extra,
});

interface World {
  requests: Array<Record<string, unknown>>;
  more: Array<Record<string, unknown>>;
  decisions: Record<string, unknown>;
  recs: Array<Record<string, unknown>>;
  recsMore: Array<Record<string, unknown>>;
  failing: {
    requests?: Error;
    route?: Error;
    recs?: Error;
    moreRequests?: Error;
    moreRecs?: Error;
  };
  loading: boolean;
}

function open(
  state: Partial<World> = {},
  options: {
    permissions?: readonly string[] | undefined;
    mode?: 'FULL' | 'READ_ONLY';
    command?: (operation: string, input: unknown) => unknown;
  } = {},
): Harness & { world: World } {
  const world: World = {
    requests: [],
    more: [],
    decisions: {},
    recs: [],
    recsMore: [],
    failing: {},
    loading: false,
    ...state,
  };
  const h = baseHarness((operation, input) => {
    const query = (input as { query?: Record<string, string> } | undefined)?.query ?? {};
    if (world.loading) return new Promise(() => undefined) as unknown as Error;
    if (operation === 'listAiRequests') {
      if (query.cursor !== undefined) return world.failing.moreRequests ?? { items: world.more, next_cursor: null };
      return (
        world.failing.requests ?? {
          items: world.requests,
          next_cursor: world.more.length > 0 || world.failing.moreRequests ? 'c2' : null,
        }
      );
    }
    if (operation === 'getAiRequestRoute') {
      if (world.failing.route !== undefined) return world.failing.route;
      return world.decisions[(input as { path: { id: string } }).path.id] ?? null;
    }
    if (operation === 'listAiInvoiceReconciliations') {
      if (query.cursor !== undefined) return world.failing.moreRecs ?? { items: world.recsMore, next_cursor: null };
      const rows = query.status === undefined ? world.recs : world.recs.filter((row) => row.status === query.status);
      return (
        world.failing.recs ?? {
          items: rows,
          next_cursor: world.recsMore.length > 0 || world.failing.moreRecs ? 'r2' : null,
        }
      );
    }
    return new Error(`unexpected read ${operation}`);
  }, options.command);
  mountInSession(
    <RoutingLogScreen route={ROUTE} />,
    h,
    {
      permissions: 'permissions' in options ? options.permissions : ALL,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    },
    '/llm/llm-21',
  );
  return Object.assign(h, { world });
}

const reads = (h: Harness, operation: string): Array<{ query?: Record<string, string>; path?: Record<string, string> }> =>
  h.read.mock.calls
    .filter((call) => call[0] === operation)
    .map(
      (call) =>
        call[1] as {
          query?: Record<string, string>;
          path?: Record<string, string>;
        },
    );
const commands = (h: Harness): Array<{ body: Record<string, unknown> }> =>
  h.command.mock.calls.filter((call) => call[0] === 'reconcileAiInvoice').map((call) => call[1] as { body: Record<string, unknown> });
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, {
    target: { value },
  });
};
const fillRun = (values: Partial<Record<'run-ref' | 'run-amount' | 'run-currency' | 'run-from' | 'run-to', string>> = {}): void => {
  const all = {
    'run-ref': 'VN1-2026-10',
    'run-amount': '3180000',
    'run-currency': 'vnd',
    'run-from': '2026-10-01',
    'run-to': '2026-10-31',
    ...values,
  };
  for (const [id, value] of Object.entries(all)) type(id, value);
};
const runForm = (): HTMLElement => screen.getByRole('form', { name: word('llm.routelog.run.title') });
const submitRun = (): void => {
  fireEvent.click(
    within(runForm()).getByRole('button', {
      name: word('llm.routelog.run.submit'),
    }),
  );
};

afterEach(() => cleanup());

describe('the model of the routing log and the reconciliation (ST-LLM-008)', () => {
  it('shows an amount exactly: grouped, the zeros at the end of the fraction left out, the minus kept', () => {
    expect(money('3180000.00000000')).toBe('3,180,000');
    expect(money('-60000.50000000')).toBe('-60,000.5');
    expect(money('0.00000001')).toBe('0.00000001');
    expect(money('-0.00000001')).toBe('-0.00000001');
    expect(money('-0.00000000')).toBe('0');
    expect(money('123456789012345678901234567890.12')).toBe('123,456,789,012,345,678,901,234,567,890.12');
    expect(money('not money')).toBe('not money');
  });

  it('says which way the invoice differs, by the sign and never by arithmetic', () => {
    expect(direction('0.00000000')).toBe('none');
    expect(direction('-0.00000000')).toBe('none');
    expect(direction('60000')).toBe('higher');
    expect(direction('-8000.1')).toBe('lower');
    expect(direction('0.00000001')).toBe('higher');
  });

  it('reads a reconciliation and leaves out what is not one', () => {
    const read = toReconciliation(reconciliation(1));
    expect(read).toMatchObject({
      providerCode: 'VN1',
      invoiceRef: 'VN1-2026-1',
      variance: '60000.00000000',
      tolerancePct: '0.50000000',
      attemptCount: 1250,
      reconciledCount: 1,
      reservationsSettled: 0,
      status: 'VARIANCE',
      runCount: 1,
      version: 1,
    });
    expect(read?.pendingAttemptIds).toEqual([uuid(701), uuid(702), uuid(703)]);
    expect(
      toReconciliation(
        reconciliation(2, {
          pending_attempt_ids: 'x',
          reconciled_attempt_ids: [1, 'a'],
          tolerance_pct: 'x',
          owner_id: null,
          last_run_at: null,
          attempt_count: 'x',
          period_from: 3,
        }),
      ),
    ).toMatchObject({
      pendingAttemptIds: [],
      reconciledCount: 1,
      tolerancePct: '0',
      ownerId: null,
      lastRunAt: null,
      attemptCount: 0,
      periodFrom: '',
    });
    for (const bad of [
      null,
      [],
      {},
      reconciliation(3, { status: 'LOST' }),
      reconciliation(3, { variance: 60000 }),
      reconciliation(3, { variance: 'x' }),
      reconciliation(3, { invoice_amount: null }),
      reconciliation(3, { attempts_total: '1e5' }),
      reconciliation(3, { id: 3 }),
      reconciliation(3, { provider_code: 3 }),
      reconciliation(3, { invoice_ref: 3 }),
      reconciliation(3, { currency: 3 }),
    ])
      expect(toReconciliation(bad)).toBeUndefined();
    expect(
      toReconciliationPage({
        items: [reconciliation(1), { id: 'x' }],
        next_cursor: 'n',
      }),
    ).toMatchObject({ next: 'n' });
    expect(
      toReconciliationPage({
        items: [reconciliation(1), { id: 'x' }],
        next_cursor: 'n',
      }).items,
    ).toHaveLength(1);
    expect(toReconciliationPage({ items: 'x', next_cursor: null })).toEqual({
      items: [],
      next: undefined,
    });
    expect(toReconciliationPage('x')).toEqual({ items: [], next: undefined });
  });

  it('checks the run before it is sent, and builds what is sent', () => {
    expect(validateRun(EMPTY_RUN)).toEqual({
      invoiceRef: 'required',
      invoiceAmount: 'required',
      periodFrom: 'required',
      periodTo: 'required',
    });
    expect(
      validateRun({
        invoiceRef: 'x'.repeat(121),
        invoiceAmount: '1e5',
        currency: 'V',
        periodFrom: '2026-13-01',
        periodTo: 'x',
      }),
    ).toEqual({
      invoiceRef: 'invalid',
      invoiceAmount: 'invalid',
      currency: 'invalid',
      periodFrom: 'invalid',
      periodTo: 'invalid',
    });
    expect(
      validateRun({
        invoiceRef: 'VN1',
        invoiceAmount: '1',
        currency: '',
        periodFrom: '2026-10-31',
        periodTo: '2026-10-01',
      }),
    ).toEqual({ currency: 'required', periodTo: 'invalid' });
    expect(
      validateRun({
        invoiceRef: 'VN1',
        invoiceAmount: '0.123456789',
        currency: 'VND',
        periodFrom: '2026-10-01',
        periodTo: '2026-10-31',
      }),
    ).toEqual({ invoiceAmount: 'invalid' });
    const good = {
      invoiceRef: ' VN1-2026-10 ',
      invoiceAmount: ' 3180000.5 ',
      currency: ' vnd ',
      periodFrom: '2026-10-01',
      periodTo: '2026-10-31',
    };
    expect(validateRun(good)).toEqual({});
    expect(runBody(good)).toEqual({
      invoice_ref: 'VN1-2026-10',
      invoice_amount: '3180000.5',
      currency: 'VND',
      period_from: '2026-10-01',
      period_to: '2026-10-31',
    });
  });

  it('reads the answer of a run, and nothing when it has not the figures', () => {
    expect(
      toRunResult({
        status: 'VARIANCE',
        variance: '60000',
        attempts_total: '3120000',
        pending_attempt_ids: [uuid(1), uuid(2)],
        reservations_settled: 3,
      }),
    ).toEqual({
      status: 'VARIANCE',
      variance: '60000',
      attemptsTotal: '3120000',
      pendingCount: 2,
      reservationsSettled: 3,
    });
    expect(
      toRunResult({
        status: 'RECONCILED',
        variance: '-8000',
        attempts_total: '3172000',
      }),
    ).toMatchObject({ pendingCount: 0, reservationsSettled: 0 });
    for (const bad of [
      null,
      'x',
      {},
      { status: 'LOST', variance: '1', attempts_total: '1' },
      { status: 'VARIANCE', variance: 1, attempts_total: '1' },
      { status: 'VARIANCE', variance: '1', attempts_total: null },
    ])
      expect(toRunResult(bad)).toBeUndefined();
  });

  it('says what a refusal means, and has a word for everything it names', () => {
    const cases: Array<[string, string]> = [
      ['RECONCILE_PERIOD_OPEN', 'periodOpen'],
      ['CURRENCY_MISMATCH', 'currency'],
      ['DUPLICATE_KEY', 'duplicate'],
      ['SCOPE_DENIED', 'scope'],
      ['PERMISSION_DENIED', 'scope'],
      ['VALIDATION_FAILED', 'validation'],
      ['OTHER', 'general'],
    ];
    for (const [code, reason] of cases)
      expect(describeProblem(problem(409, code, 'invoice_ref'))).toEqual({
        reason,
        detail: 'invoice_ref',
      });
    expect(describeProblem(problem(409, 'SCOPE_DENIED'))).toEqual({
      reason: 'scope',
      detail: '',
    });
    expect(describeProblem(new Error('x'))).toEqual({
      reason: 'general',
      detail: '',
    });
    const t = (key: string, values?: Record<string, string | number>): string => (values === undefined ? key : `${key}:${Object.values(values).join(',')}`);
    for (const one of RECONCILIATION_STATUSES) expect(labels.statusLabel(t, one)).toMatch(/^llm\.routelog\.rec\.status\./);
    for (const one of ['none', 'higher', 'lower'] as const) expect(labels.directionLabel(t, one)).toMatch(/^llm\.routelog\.rec\.dir\./);
    for (const [, reason] of cases) expect(labels.problemMessage(t, { reason: reason as never, detail: 'f' })).toMatch(/^llm\.routelog\.problem\./);
  });
});

const states: Array<[string, Error, string]> = [
  ['denied', problem(403, 'SCOPE_DENIED'), word('states.denied.title')],
  [
    'offline',
    new ApiError({
      status: 0,
      code: NETWORK_ERROR_CODE,
      correlationId: 'c',
      extensions: {},
    }),
    word('states.offline.title'),
  ],
  ['error', problem(500, 'INTERNAL_ERROR'), word('states.error.title')],
  ['signed out', problem(401, 'SESSION_EXPIRED'), word('states.signedOut.title')],
];

describe('RoutingLogScreen (LLM-21): the routing log (ST-LLM-008, UI-LLM-21)', () => {
  it('UI-LLM-21: lists the requests with the route, provider and model each ended on, and why one was refused', async () => {
    open({
      requests: [
        request(1),
        request(2, {
          route_class: null,
          provider_code: null,
          model_id: null,
          status: 'REJECTED_POLICY',
          reject_code: 'AI_ROUTE_NOT_ALLOWED',
          cost_vnd: null,
        }),
      ],
    });
    const table = await screen.findByTestId('log-table');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('llm.routelog.title'));
    const row = (n: number) => table.querySelector(`[data-request-id="${uuid(n)}"]`) as HTMLElement;
    expect(within(row(1)).getByTestId('log-route-cell').textContent).toBe(`${word('llm.route.domestic')} · VN1 · viet-llm`);
    expect(row(1).textContent).toContain('2026-11-02');
    expect(row(1).textContent).toContain('summarise-1');
    expect(row(1).textContent).toContain(word('llm.requestStatus.completed'));
    expect(within(row(2)).getByTestId('log-route-cell').textContent).toBe(word('llm.requests.noRoute'));
    expect(row(2).getAttribute('data-route')).toBe('NONE');
    expect(row(2).textContent).toContain(word('llm.rejectCode.routeNotAllowed'));
    expect(screen.queryByTestId('log-none')).toBeNull();
  });

  it('narrows the log by what the read supports: state, route, class and task', async () => {
    const h = open({ requests: [request(1)] });
    await screen.findByTestId('log-table');
    fireEvent.change(document.getElementById('log-status') as HTMLElement, {
      target: { value: 'FAILED' },
    });
    fireEvent.change(document.getElementById('log-route') as HTMLElement, {
      target: { value: 'SELF_HOSTED' },
    });
    fireEvent.change(document.getElementById('log-class') as HTMLElement, {
      target: { value: 'PUBLIC' },
    });
    type('log-task', ' summarise ');
    await waitFor(() =>
      expect(reads(h, 'listAiRequests').at(-1)?.query).toMatchObject({
        status: 'FAILED',
        route_class: 'SELF_HOSTED',
        data_classification: 'PUBLIC',
        task_type: 'summarise',
      }),
    );
    expect(reads(h, 'listAiRequests')[0]?.query).not.toHaveProperty('status');
  });

  it('says there is no request, and reads the next page when asked, telling when it fails', async () => {
    open({});
    expect((await screen.findByTestId('log-none')).textContent).toBe(word('llm.requests.none'));
    cleanup();
    open({ requests: [request(1)], more: [request(2)] });
    await screen.findByTestId('log-table');
    fireEvent.click(await screen.findByTestId('log-more'));
    await waitFor(() => expect(document.querySelector(`[data-request-id="${uuid(2)}"]`)).not.toBeNull());
    expect(screen.queryByTestId('log-more')).toBeNull();
    cleanup();
    open({
      requests: [request(1)],
      failing: { moreRequests: problem(500, 'INTERNAL_ERROR') },
    });
    fireEvent.click(await screen.findByTestId('log-more'));
    expect((await screen.findByTestId('log-more-failed')).textContent).toBe(word('llm.requests.moreFailed'));
    expect(document.querySelector(`[data-request-id="${uuid(1)}"]`)).not.toBeNull();
  });

  it('UI-LLM-21: opens a request to the class and why, the policy, the route and every attempt, and closes it again', async () => {
    const h = open({
      requests: [request(1)],
      decisions: { [uuid(1)]: decision(1) },
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: fill(word('llm.routelog.log.open'), {
          task: 'summarise-1',
          day: '2026-11-02',
        }),
      }),
    );
    const panel = await screen.findByTestId('route-detail');
    await within(panel).findByTestId('route-classification');
    expect(reads(h, 'getAiRequestRoute')[0]?.path).toEqual({ id: uuid(1) });
    expect(within(panel).getByTestId('route-classification').textContent).toBe(word('llm.classification.confidential'));
    expect(within(panel).getByTestId('route-sources').textContent).toContain(uuid(900).slice(0, 8));
    expect(within(panel).getByTestId('route-policy').textContent).toBe(uuid(800));
    expect(within(panel).getByTestId('route-route').textContent).toBe(`${word('llm.route.domestic')} · VN1 · viet-llm`);
    expect(within(panel).getByTestId('route-status').textContent).toBe(word('llm.requestStatus.completed'));
    const attempts = within(panel).getByTestId('route-attempts').querySelectorAll('tbody tr');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.textContent).toContain(word('llm.attemptKind.primary'));
    expect(attempts[0]?.textContent).toContain('10.25 ₫');
    expect(attempts[0]?.textContent).toContain(fill(word('llm.routing.attempts.ms'), { value: 900 }));
    expect(attempts[1]?.textContent).toContain(word('llm.attemptKind.fallback'));
    expect(attempts[1]?.textContent).toContain('—');
    expect(panel.textContent).not.toMatch(/prompt|response/i);
    fireEvent.click(
      within(panel).getByRole('button', {
        name: word('llm.routelog.log.close'),
      }),
    );
    expect(screen.queryByTestId('route-detail')).toBeNull();
  });

  it('shows a refused request with the baseline policy, no source and no attempt', async () => {
    open({
      requests: [request(1)],
      decisions: {
        [uuid(1)]: decision(1, {
          policy_version_id: '00000000-0000-0000-0000-000000000000',
          classification_basis: [],
          route_class: null,
          status: 'REJECTED_POLICY',
          reject_code: 'AI_ROUTE_NOT_ALLOWED',
          attempts: [],
        }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /summarise-1/ }));
    const panel = await screen.findByTestId('route-detail');
    expect((await within(panel).findByTestId('route-policy')).textContent).toBe(word('llm.routing.baseline'));
    expect(within(panel).getByTestId('route-sources').textContent).toBe(word('llm.routing.noSources'));
    expect(within(panel).getByTestId('route-route').textContent).toBe(word('llm.requests.noRoute'));
    expect(within(panel).getByTestId('route-status').textContent).toContain(word('llm.rejectCode.routeNotAllowed'));
    expect(within(panel).getByTestId('route-no-attempts').textContent).toBe(word('llm.routing.noAttempts'));
  });

  it('shows the empty state for a route decision that cannot be read, and the error state when it fails', async () => {
    open({ requests: [request(1)] });
    fireEvent.click(await screen.findByRole('button', { name: /summarise-1/ }));
    expect(await within(await screen.findByTestId('route-detail')).findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open({
      requests: [request(1)],
      failing: { route: problem(500, 'INTERNAL_ERROR') },
    });
    fireEvent.click(await screen.findByRole('button', { name: /summarise-1/ }));
    expect(await within(await screen.findByTestId('route-detail')).findByText(word('states.error.title'))).toBeTruthy();
  });

  it.each(states)('UI-LLM-21 shows the %s state when the log cannot be read, and the reconciliation still shows', async (_name, answer, title) => {
    open({ failing: { requests: answer }, recs: [reconciliation(1)] });
    const section = await screen.findByTestId('log-section');
    expect(await within(section).findByText(title)).toBeTruthy();
    expect(await screen.findByTestId('reconcile-table')).toBeTruthy();
  });

  it('UI-LLM-21 shows the loading state while it reads', async () => {
    open({ loading: true });
    expect(
      (
        await screen.findAllByRole('status', {
          name: word('states.loading.label'),
        })
      ).length,
    ).toBe(2);
  });
});

describe('RoutingLogScreen (LLM-21): the invoice reconciliation (ST-LLM-008, UAT-AC462)', () => {
  it('UI-LLM-21: lists the reconciliations with the variance exactly and the state', async () => {
    open({
      recs: [
        reconciliation(1),
        reconciliation(2, {
          status: 'RECONCILED',
          variance: '-8000.00000000',
          invoice_amount: '3112000',
          attempts_total: '3120000',
        }),
      ],
    });
    const table = await screen.findByTestId('reconcile-table');
    const row = (n: number) => table.querySelector(`[data-reconciliation="${uuid(500 + n)}"]`) as HTMLElement;
    expect(within(row(1)).getByTestId('variance').textContent).toBe('60,000 VND');
    expect(within(row(1)).getByTestId('status').textContent).toBe(word('llm.routelog.rec.status.variance'));
    expect(row(1).textContent).toContain('3,180,000 VND');
    expect(row(1).textContent).toContain('3,120,000 VND');
    expect(row(1).textContent).toContain('2026-10-01 đến 2026-10-31');
    expect(row(1).textContent).toContain('VN1-2026-1');
    expect(within(row(2)).getByTestId('variance').textContent).toBe('-8,000 VND');
    expect(within(row(2)).getByTestId('status').textContent).toBe(word('llm.routelog.rec.status.reconciled'));
    expect(row(2).getAttribute('data-status')).toBe('RECONCILED');
  });

  it('narrows the list by state', async () => {
    const h = open({
      recs: [reconciliation(1), reconciliation(2, { status: 'RECONCILED' })],
    });
    await screen.findByTestId('reconcile-table');
    fireEvent.change(document.getElementById('reconcile-status') as HTMLElement, { target: { value: 'RECONCILED' } });
    await waitFor(() => expect(reads(h, 'listAiInvoiceReconciliations').at(-1)?.query).toMatchObject({ status: 'RECONCILED' }));
    await waitFor(() => expect(document.querySelectorAll('[data-reconciliation]')).toHaveLength(1));
    expect(reads(h, 'listAiInvoiceReconciliations')[0]?.query).not.toHaveProperty('status');
  });

  it('UI-LLM-21, UAT-AC462: opens a variance to the attempts against the invoice, the tolerance, the attempts waiting for usage and the owner', async () => {
    open({ recs: [reconciliation(1)] });
    fireEvent.click(
      await screen.findByRole('button', {
        name: fill(word('llm.routelog.rec.open'), { ref: 'VN1-2026-1' }),
      }),
    );
    const panel = await screen.findByTestId('reconcile-detail');
    expect(within(panel).getByTestId('detail-attempts').textContent).toBe('3,120,000 VND');
    expect(within(panel).getByTestId('detail-invoice').textContent).toBe('3,180,000 VND');
    expect(within(panel).getByTestId('detail-variance').textContent).toBe(`60,000 VND · ${word('llm.routelog.rec.dir.higher')}`);
    expect(within(panel).getByTestId('detail-variance').getAttribute('data-direction')).toBe('higher');
    expect(within(panel).getByTestId('detail-tolerance').textContent).toBe('0.5%');
    expect(within(panel).getByTestId('detail-counted').textContent).toBe(
      fill(word('llm.routelog.rec.detail.countedText'), {
        count: 1250,
        reconciled: 1,
      }),
    );
    expect(within(panel).getByTestId('detail-pending').textContent).toBe('3');
    expect(within(panel).getByTestId('detail-settled').textContent).toBe('0');
    expect(within(panel).getByTestId('detail-owner').textContent).toBe(uuid(1).slice(0, 8));
    expect(within(panel).getByTestId('detail-runs').textContent).toBe(
      fill(word('llm.routelog.rec.detail.runsText'), {
        count: 1,
        at: '2026-11-02',
      }),
    );
    expect(within(panel).getByTestId('pending-list').querySelectorAll('li')).toHaveLength(3);
    expect(within(panel).queryByTestId('no-pending')).toBeNull();
    fireEvent.click(
      within(panel).getByRole('button', {
        name: word('llm.routelog.rec.close'),
      }),
    );
    expect(screen.queryByTestId('reconcile-detail')).toBeNull();
  });

  it('shows an invoice lower than the attempts with its minus, and a reconciled one with nothing pending and no owner', async () => {
    open({
      recs: [
        reconciliation(1, {
          status: 'RECONCILED',
          variance: '-8000.00000000',
          pending_attempt_ids: [],
          owner_id: null,
          last_run_at: null,
          reservations_settled: 3,
        }),
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: /VN1-2026-1/ }));
    const panel = await screen.findByTestId('reconcile-detail');
    expect(within(panel).getByTestId('detail-variance').textContent).toBe(`-8,000 VND · ${word('llm.routelog.rec.dir.lower')}`);
    expect(within(panel).getByTestId('no-pending').textContent).toBe(word('llm.routelog.rec.detail.noPending'));
    expect(within(panel).getByTestId('detail-settled').textContent).toBe('3');
    expect(within(panel).getByTestId('detail-owner').textContent).toBe('—');
    expect(within(panel).getByTestId('detail-runs').textContent).toContain('—');
    cleanup();
    open({ recs: [reconciliation(1, { variance: '0' })] });
    fireEvent.click(await screen.findByRole('button', { name: /VN1-2026-1/ }));
    expect((await screen.findByTestId('detail-variance')).textContent).toBe(`0 VND · ${word('llm.routelog.rec.dir.none')}`);
  });

  it('says there is none, and reads the next page when asked, telling when it fails', async () => {
    open({});
    expect((await screen.findByTestId('reconcile-none')).textContent).toBe(word('llm.routelog.rec.none'));
    cleanup();
    open({ recs: [reconciliation(1)], recsMore: [reconciliation(2)] });
    await screen.findByTestId('reconcile-table');
    fireEvent.click(await screen.findByTestId('reconcile-more'));
    await waitFor(() => expect(document.querySelectorAll('[data-reconciliation]')).toHaveLength(2));
    cleanup();
    open({
      recs: [reconciliation(1)],
      failing: { moreRecs: problem(500, 'INTERNAL_ERROR') },
    });
    fireEvent.click(await screen.findByTestId('reconcile-more'));
    expect((await screen.findByTestId('reconcile-more-failed')).textContent).toBe(word('llm.requests.moreFailed'));
    expect(document.querySelectorAll('[data-reconciliation]')).toHaveLength(1);
  });

  it.each(states)('UI-LLM-21 shows the %s state when the reconciliations cannot be read, and keeps the run form', async (_name, answer, title) => {
    open({ failing: { recs: answer }, requests: [request(1)] });
    const section = await screen.findByTestId('reconcile-section');
    expect(await within(section).findByText(title)).toBeTruthy();
    expect(
      within(section).getByRole('form', {
        name: word('llm.routelog.run.title'),
      }),
    ).toBeTruthy();
    expect(await screen.findByTestId('log-table')).toBeTruthy();
  });

  it('UAT-AC462: checks the run first, sends it, shows the variance and the attempts that wait, and runs again once the usage is in', async () => {
    let answer: unknown = {
      operation_id: 'o',
      status: 'VARIANCE',
      resource_version: 1,
      resource_id: uuid(501),
      variance: '60000.00000000',
      attempts_total: '3120000.00000000',
      pending_attempt_ids: [uuid(701), uuid(702), uuid(703)],
      reservations_settled: 0,
    };
    const h = open({ recs: [] }, { command: () => answer });
    await screen.findByTestId('reconcile-none');
    submitRun();
    expect((await within(runForm()).findAllByText(word('llm.routelog.run.required'))).length).toBe(4);
    expect(h.command).not.toHaveBeenCalled();
    fillRun({
      'run-ref': '',
      'run-amount': '1e5',
      'run-currency': 'V',
      'run-from': '2026-10-31',
      'run-to': '2026-10-01',
    });
    submitRun();
    expect((await within(runForm()).findAllByText(word('llm.routelog.run.invalid'))).length).toBe(3);
    fillRun();
    submitRun();
    const result = await screen.findByTestId('run-result');
    expect(result.getAttribute('data-status')).toBe('VARIANCE');
    expect(result.textContent).toBe(
      fill(word('llm.routelog.run.result'), {
        status: word('llm.routelog.rec.status.variance'),
        variance: '60,000',
        total: '3,120,000',
        pending: 3,
        settled: 0,
      }),
    );
    expect(commands(h)[0]?.body).toEqual({
      invoice_ref: 'VN1-2026-10',
      invoice_amount: '3180000',
      currency: 'VND',
      period_from: '2026-10-01',
      period_to: '2026-10-31',
    });
    // The form keeps its figures: the same run is asked again when the late usage is in, with a key of its own.
    expect((document.getElementById('run-ref') as HTMLInputElement).value).toBe('VN1-2026-10');
    answer = {
      operation_id: 'o',
      status: 'RECONCILED',
      resource_version: 2,
      resource_id: uuid(501),
      variance: '8000',
      attempts_total: '3172000',
      pending_attempt_ids: [],
      reservations_settled: 3,
    };
    submitRun();
    await waitFor(() => expect(screen.getByTestId('run-result').getAttribute('data-status')).toBe('RECONCILED'));
    expect(commands(h)).toHaveLength(2);
    const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
    expect(new Set(keys).size).toBe(2);
    expect(reads(h, 'listAiInvoiceReconciliations').length).toBeGreaterThan(1);
  });

  it('says nothing was settled when the answer has not the figures', async () => {
    open(
      {},
      {
        command: () => ({
          operation_id: 'o',
          status: 'RECONCILED',
          resource_version: 1,
        }),
      },
    );
    await screen.findByTestId('reconcile-none');
    fillRun();
    submitRun();
    await waitFor(() => expect(screen.getByRole('button', { name: word('llm.routelog.run.submit') }).hasAttribute('disabled')).toBe(false));
    expect(screen.queryByTestId('run-result')).toBeNull();
  });

  it.each([
    ['RECONCILE_PERIOD_OPEN', 409, 'periodOpen', 'llm.routelog.problem.periodOpen'],
    ['CURRENCY_MISMATCH', 422, 'currency', 'llm.routelog.problem.currency'],
    ['DUPLICATE_KEY', 409, 'duplicate', 'llm.routelog.problem.duplicate'],
    ['SCOPE_DENIED', 403, 'scope', 'llm.routelog.problem.scope'],
    ['VALIDATION_FAILED', 422, 'validation', 'llm.routelog.problem.validation'],
    ['SOMETHING', 500, 'general', 'llm.routelog.problem.general'],
  ])('shows the refusal of the server (%s) and no result', async (code, status, reason, key) => {
    open({}, { command: () => Promise.reject(problem(status, code, 'invoice_ref')) });
    await screen.findByTestId('reconcile-none');
    fillRun();
    submitRun();
    const refusal = await screen.findByTestId('run-refusal');
    expect(refusal.getAttribute('data-reason')).toBe(reason);
    expect(refusal.textContent).toBe(fill(word(key), { field: 'invoice_ref' }));
    expect(screen.queryByTestId('run-result')).toBeNull();
  });

  it('sends the same attempt for the same figures again after an answer that was lost', async () => {
    const h = open({}, { command: () => Promise.reject(problem(503, 'UNAVAILABLE')) });
    await screen.findByTestId('reconcile-none');
    fillRun();
    submitRun();
    await screen.findByTestId('run-refusal');
    submitRun();
    await waitFor(() => expect(commands(h)).toHaveLength(2));
    const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
    expect(keys[0]).toBe(keys[1]);
  });

  it('gives no run form to a session that is read only', async () => {
    open({ recs: [reconciliation(1)] }, { mode: 'READ_ONLY' });
    expect(await screen.findByTestId('reconcile-table')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });
});

describe('RoutingLogScreen (LLM-21): the permissions of the two parts', () => {
  it('UI-LLM-21: without the right to read the log, shows the denied state and reads no request', async () => {
    const h = open({ recs: [reconciliation(1)] }, { permissions: ['llm.finops'] });
    expect(await screen.findByTestId('reconcile-table')).toBeTruthy();
    expect(within(screen.getByTestId('log-denied')).getByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByTestId('log-section')).toBeNull();
    expect(reads(h, 'listAiRequests')).toHaveLength(0);
  });

  it('UI-LLM-21: without the right to reconcile, shows the denied state, no form and reads no reconciliation', async () => {
    const h = open({ requests: [request(1)] }, { permissions: ['llm.audit.read'] });
    expect(await screen.findByTestId('log-table')).toBeTruthy();
    expect(within(screen.getByTestId('reconcile-denied')).getByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    expect(reads(h, 'listAiInvoiceReconciliations')).toHaveLength(0);
  });

  it('shows both parts to a session whose permissions are not known yet', async () => {
    open({ requests: [request(1)], recs: [reconciliation(1)] }, { permissions: undefined });
    expect(await screen.findByTestId('log-table')).toBeTruthy();
    expect(await screen.findByTestId('reconcile-table')).toBeTruthy();
  });
});
