import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { routeOf } from '../test-support';
import { mountInSession } from '../../doc/test-support';
import ReconciliationScreen from './ReconciliationScreen';
import { DATASET, client, commandsOf, difference, problem, recon, reconId, uuid, world } from './test-support';
import type { Harness, World } from './test-support';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const ROUTE = routeOf('DGV-09', 'FR-DGV-09');
const PERMISSIONS = ['data.quality.read', 'data.quality.run', 'data.catalog.read'];
const P1 = uuid('0080', 1);
const P2 = uuid('0080', 2);
const P3 = uuid('0080', 3);

const detailOf = (n: number, overrides: Record<string, unknown> = {}) =>
  recon(n, {
    differences: [difference(P1, 'AMOUNT', 'BOTH', '200000000', '100000000'), difference(P2, 'MISSING', 'A_ONLY', '15000000', '0'), difference(P3, 'MISSING', 'B_ONLY', '0', '70000000')],
    differences_count: 3,
    ...overrides,
  });

function open(state: Partial<World> = {}, options: { mode?: 'FULL' | 'READ_ONLY'; permissions?: readonly string[]; command?: (operation: string, input: unknown) => unknown; path?: string } = {}): Harness & { state: World } {
  const full = world(state);
  const h = client(full, options.command);
  mountInSession(<ReconciliationScreen route={ROUTE} />, h, { permissions: options.permissions ?? PERMISSIONS, ...(options.mode === undefined ? {} : { mode: options.mode }) }, options.path ?? '/dgv/dgv-09');
  return { ...h, state: full };
}

const rows = (): string[] => Array.from(document.querySelectorAll('[data-recon]')).map((row) => row.getAttribute('data-recon') as string);
const dialog = (): HTMLElement => screen.getByRole('dialog');
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const grouped = (value: string): string => new Intl.NumberFormat('vi', { maximumFractionDigits: 0 }).format(BigInt(value));

afterEach(() => cleanup());

describe('ReconciliationScreen (DGV-09): the Treasury against the accepted report', () => {
  it('UI-DGV-09: lists the reconciliations with their result and the two totals apart, never as one number', async () => {
    open({ reconciliations: [recon(2, { result: 'MATCHED', total_a_vnd: '10', total_b_vnd: '10', difference_vnd: '0', incident_id: null }), recon(1)] });
    await screen.findByTestId('reconciliations');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('dgv.recon.title'));
    expect(rows()).toEqual([reconId(2), reconId(1)]);
    const different = document.querySelector(`[data-recon="${reconId(1)}"]`) as HTMLElement;
    expect(within(different).getByTestId('result').textContent).toBe(word('dgv.recon.result.different'));
    expect(different.textContent).toContain(grouped('385000000'));
    expect(different.textContent).toContain(grouped('300000000'));
    expect(within(different).getByTestId('difference').textContent).toBe(grouped('85000000'));
    expect(within(document.querySelector(`[data-recon="${reconId(2)}"]`) as HTMLElement).getByTestId('result').textContent).toBe(word('dgv.recon.result.matched'));
    expect(screen.getByText(word('dgv.recon.footer.reference').replace('{id}', 'DGV-09').replace('{req}', 'FR-DGV-09'))).toBeTruthy();
  });

  it('narrows the list by result and says when there is none', async () => {
    const h = open({ reconciliations: [recon(2, { result: 'MATCHED', incident_id: null }), recon(1)] });
    await screen.findByTestId('reconciliations');
    fireEvent.change(document.getElementById('recon-filter-result') as HTMLElement, { target: { value: 'MATCHED' } });
    await waitFor(() => expect(rows()).toEqual([reconId(2)]));
    expect(
      h.read.mock.calls
        .filter((call) => call[0] === 'listReconciliations')
        .map((call) => (call[1] as { query: Record<string, unknown> }).query)
        .at(-1),
    ).toEqual({ limit: 50, result: 'MATCHED' });
    fireEvent.change(document.getElementById('recon-filter-result') as HTMLElement, { target: { value: 'WITHIN_TOLERANCE' } });
    expect((await screen.findByTestId('no-reconciliations')).textContent).toBe(word('dgv.recon.none.notice'));
  });

  it('AC-ST-DGV-004-1: opens a reconciliation with the two totals side by side, the difference, the count by kind, each difference with its kind and a link to the incident', async () => {
    open({ reconciliations: [recon(1)], details: [detailOf(1, { by_kind: { MISSING: 2, TIMING: 0, REVERSAL: 0, MAPPING: 0, AMOUNT: 1 } })] }, { path: `/dgv/dgv-09?recon=${reconId(1)}` });
    expect((await screen.findByTestId('detail-title')).textContent).toBe('PAY-DIS-MONTH · 2026-10');
    expect(within(screen.getByTestId('side-a')).getByText(grouped('385000000'))).toBeTruthy();
    expect(within(screen.getByTestId('side-b')).getByText(grouped('300000000'))).toBeTruthy();
    expect(within(screen.getByTestId('gap')).getByText(grouped('85000000'))).toBeTruthy();
    expect(screen.getByTestId('side-a').textContent).toContain('PAY.treasury_transaction');
    expect(screen.getByTestId('side-b').textContent).toContain('DIS.report_accepted');
    const kinds = Object.fromEntries(
      Array.from(document.querySelectorAll('[data-kind]'))
        .filter((item) => item.tagName === 'LI')
        .map((item) => [item.getAttribute('data-kind'), item.querySelector('strong')?.textContent]),
    );
    expect(kinds).toEqual({ MISSING: '2', TIMING: '0', REVERSAL: '0', MAPPING: '0', AMOUNT: '1' });
    const table = screen.getByTestId('differences');
    expect(Array.from(table.querySelectorAll('[data-difference]')).map((row) => [row.getAttribute('data-difference'), row.getAttribute('data-kind')])).toEqual([
      [P1, 'AMOUNT'],
      [P2, 'MISSING'],
      [P3, 'MISSING'],
    ]);
    expect(within(table.querySelector(`[data-difference="${P3}"]`) as HTMLElement).getByText(word('dgv.recon.side.bOnly'))).toBeTruthy();
    expect(screen.getByTestId('to-incident').getAttribute('href')).toBe(`/dgv/dgv-08?incident=${uuid('0070', 1)}`);
    expect(screen.queryByTestId('truncated')).toBeNull();
  });

  it('says so when the differences kept are fewer than there were, and when there is none; a reconciliation that was not found says so', async () => {
    open({ reconciliations: [recon(2)], details: [detailOf(2, { differences_truncated: true, differences_count: 1200 })] }, { path: `/dgv/dgv-09?recon=${reconId(2)}` });
    expect((await screen.findByTestId('truncated')).textContent).toBe(word('dgv.recon.differences.truncated').replace('{shown}', '3').replace('{total}', '1200'));
    cleanup();
    open({ reconciliations: [recon(3, { result: 'MATCHED', incident_id: null })], details: [recon(3, { result: 'MATCHED', incident_id: null, differences: [], by_kind: { MISSING: 0, TIMING: 0, REVERSAL: 0, MAPPING: 0, AMOUNT: 0 } })] }, { path: `/dgv/dgv-09?recon=${reconId(3)}` });
    expect((await screen.findByTestId('no-differences')).textContent).toBe(word('dgv.recon.differences.none'));
    expect(screen.queryByTestId('to-incident')).toBeNull();
    cleanup();
    open({}, { path: `/dgv/dgv-09?recon=${reconId(9)}` });
    expect((await screen.findByTestId('detail-missing')).textContent).toBe(word('dgv.recon.detail.missing'));
  });

  it('runs a reconciliation after the form is complete, on the sources and the basis the server knows, and opens the one that was made', async () => {
    const h = open({ reconciliations: [], details: [detailOf(1)] }, { command: () => ({ resource_id: reconId(1), resource_version: 1, status: 'DIFFERENT' }) });
    await screen.findByTestId('no-reconciliations');
    fireEvent.click(screen.getByRole('button', { name: word('dgv.recon.run.action') }));
    // The sources and the basis are told, not chosen.
    expect(within(dialog()).getByTestId('run-basis').textContent).toContain('PAY.treasury_transaction');
    expect(within(dialog()).getByTestId('run-basis').textContent).toContain('DIS.report_accepted');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.recon.run.submit') }));
    expect(within(dialog()).getByText(word('dgv.source.problem.required'))).toBeTruthy();
    expect(commandsOf(h, 'runReconciliation')).toHaveLength(0);
    type('run-period', '2026-13');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.recon.run.submit') }));
    expect(within(dialog()).getByText(word('dgv.source.problem.invalidPeriod'))).toBeTruthy();
    type('run-period', '2026-10');
    type('run-tolerance', '-5');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.recon.run.submit') }));
    expect(within(dialog()).getByText(word('dgv.source.problem.invalidAmount'))).toBeTruthy();
    type('run-tolerance', '1000');
    await waitFor(() => expect(document.querySelector(`#run-dataset option[value="${DATASET.id}"]`)).not.toBeNull());
    type('run-dataset', DATASET.id);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.recon.run.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'runReconciliation')).toEqual([
      { body: { recon_code: 'PAY-DIS-MONTH', source_a: 'PAY.treasury_transaction', source_b: 'DIS.report_accepted', as_of_period: '2026-10', basis: 'VND, ngày Kho bạc thanh toán', tolerance_vnd: '1000', dataset_id: DATASET.id }, attempt: expect.anything() },
    ]);
    expect((await screen.findByTestId('detail-title')).textContent).toBe('PAY-DIS-MONTH · 2026-10');
  });

  it('tells the person why a run was refused: a month that is not closed, sources that cannot be compared, a dataset that cannot be named', async () => {
    let refusal = problem('SNAPSHOT_NOT_FOUND', 422, 'as_of_period');
    open({}, { command: () => refusal });
    await screen.findByTestId('no-reconciliations');
    fireEvent.click(screen.getByRole('button', { name: word('dgv.recon.run.action') }));
    type('run-period', '2026-10');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.recon.run.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('dgv.source.error.noClosedMonth'));
    refusal = problem('BASIS_MISMATCH', 422, 'basis');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.recon.run.submit') }));
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('dgv.source.error.basis')));
    refusal = problem('VALIDATION_FAILED', 422, 'dataset_id');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.recon.run.submit') }));
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('dgv.source.error.datasetMissing')));
    refusal = problem('SCOPE_DENIED', 403);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.recon.run.submit') }));
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('dgv.source.error.denied')));
  });

  it('shows no button to run to a person who may read the reconciliations and not run one', async () => {
    open({ reconciliations: [recon(1)] }, { permissions: ['data.quality.read', 'data.catalog.read'] });
    await screen.findByTestId('reconciliations');
    expect(screen.queryByRole('button', { name: word('dgv.recon.run.action') })).toBeNull();
  });

  it('shows no button to run while the tenant is read-only', async () => {
    open({ reconciliations: [recon(1)] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('reconciliations');
    expect(screen.queryByRole('button', { name: word('dgv.recon.run.action') })).toBeNull();
  });
});
