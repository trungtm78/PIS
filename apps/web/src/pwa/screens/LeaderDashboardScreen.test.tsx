import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeViolations, seriousViolations } from '../../test/axe';
import LeaderDashboardScreen from './LeaderDashboardScreen';
import { COMMAND_CENTER_PATH } from './LeaderDashboardScreen';
import { mountPwa, pwaClient, word } from './test-support';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const READER = ['home.read'];
const S40 = '00000000-0000-4000-8000-0000000000f2';
const S41 = '00000000-0000-4000-8000-0000000000f3';

const tile = (code: string, overrides: Record<string, unknown> = {}) => ({
  metric_code: code,
  value: '60.0000',
  numerator: '600000000000',
  denominator: '1000000000000',
  null_reason: null,
  unit: 'PERCENT',
  formula: 'disbursed_treasury_vnd / plan_pm_assigned_vnd * 100',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  context_token: `token-${code}.sig`,
  ...overrides,
});

const body = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: S40,
  snapshot_kind: 'PERIOD_CLOSE',
  as_of_date: '2027-10-12',
  treasury_cutoff_date: '2027-10-12',
  freshness: 'FRESH',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  legal_confirmation_refs: ['CXN-03'],
  scope: { unit_id: null, denominator_kind: null, projects: 3, scope_hash: 'h' },
  tiles: [
    tile('DISBURSEMENT_RATE_PM'),
    tile('DISBURSEMENT_RATE_TOTAL', { value: '48.0000', denominator: '1250000000000' }),
    tile('DISBURSED_TREASURY', { unit: 'VND', value: '600000000000', numerator: null, denominator: null }),
    tile('PLAN_PM_ASSIGNED', { unit: 'VND', value: '1000000000000', numerator: null, denominator: null }),
    tile('PLAN_TOTAL', { unit: 'VND', value: '1250000000000', numerator: null, denominator: null }),
  ],
  projects_without_data: 0,
  open_warnings: 3,
  overdue_explanations: 2,
  pending_reallocations: 1,
  quality_badge: 'NOT_ASSESSED',
  ...overrides,
});

const alerts = { view: 'scope', items: [], next_cursor: null, counts: { urgent: 0, action: 0, watch: 0, total: 0 }, unavailable_sources: [], as_of: '2027-10-12T08:00:00.000Z' };

function open(center: () => unknown, options: { permissions?: readonly string[] | undefined } = {}) {
  const h = pwaClient({
    read: (operation) => {
      if (operation === 'getCommandCenter') return center();
      if (operation === 'getMyWork' || operation === 'getMyWorkCounts') return alerts;
      return new Error(`unexpected read ${operation}`);
    },
  });
  const mounted = mountPwa(<LeaderDashboardScreen />, h, { permissions: 'permissions' in options ? options.permissions : READER, path: '/m/dashboard' });
  return { ...h, ...mounted };
}

afterEach(cleanup);

describe('LeaderDashboardScreen (PWA-03): the command center on the phone', () => {
  it('shows the context of every figure first, then the amount, the two rates side by side, the plan and what waits', async () => {
    open(() => body());
    const rates = await screen.findByTestId('pwa-rates');
    const context = screen.getByTestId('pwa-context');
    expect(context.compareDocumentPosition(rates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(context.compareDocumentPosition(screen.getByTestId('home-kpis')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(context.textContent).toContain('12/10/2027');
    const pm = rates.querySelector('[data-rate="pm"]') as HTMLElement;
    const total = rates.querySelector('[data-rate="total"]') as HTMLElement;
    expect(pm.parentElement).toBe(total.parentElement);
    expect(within(pm).getByTestId('tile-value-DISBURSEMENT_RATE_PM').textContent).toBe('60.0000%');
    expect(within(total).getByTestId('tile-value-DISBURSEMENT_RATE_TOTAL').textContent).toBe('48.0000%');
    // The unit of measure of the figures of money, and the waiting counts of the snapshot.
    expect(screen.getByTestId('home-kpis').textContent).toContain('3');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('pwa.dashboard.page.title'));
  });

  it('reads the same snapshot as the command center of the web (getCommandCenter) and shows the needs-action band', async () => {
    const h = open(() => body());
    await screen.findByTestId('pwa-rates');
    expect(h.read).toHaveBeenCalledWith('getCommandCenter', { query: {} });
    expect(await screen.findByTestId('pwa-band')).toBeInTheDocument();
  });

  it('links to the full command center for the drill-down', async () => {
    open(() => body());
    const link = await screen.findByTestId('pwa-full');
    expect(link.getAttribute('href')).toBe(COMMAND_CENTER_PATH);
  });

  it('goes back to the start page of the manager screens', async () => {
    open(() => body());
    await screen.findByTestId('pwa-rates');
    expect(screen.getByTestId('pwa-back').getAttribute('href')).toBe('/m');
  });

  it('shows a skeleton while loading and no figure, never a 0', async () => {
    open(() => new Promise(() => undefined));
    expect((await screen.findByRole('status', { name: word('states.loading.label') })).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('pwa-rates')).toBeNull();
    expect(screen.queryByTestId('home-kpis')).toBeNull();
  });

  it('says the reader may not see it when the right is missing, and reads nothing', async () => {
    const h = open(() => body(), { permissions: ['approval_task.read'] });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(h.read).not.toHaveBeenCalledWith('getCommandCenter', expect.anything());
  });

  it('names a failure in the standard states and retries in place', async () => {
    let failing = true;
    open(() => (failing ? failure(500, 'INTERNAL') : body()));
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('pwa-rates');
  });

  it('says it is offline when the network fails', async () => {
    open(() => failure(0, NETWORK_ERROR_CODE));
    expect(await screen.findByText(word('states.offline.title'))).toBeInTheDocument();
  });

  it('shows the card of a snapshot that does not exist yet, not an error and not zeros', async () => {
    open(() => failure(404, 'RESOURCE_NOT_FOUND'));
    expect(await screen.findByTestId('home-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('pwa-rates')).toBeNull();
  });

  it('offers a newer snapshot instead of changing the figures on the screen', async () => {
    let calls = 0;
    open(() => {
      calls += 1;
      return body({ snapshot_id: calls === 1 ? S40 : S41 });
    });
    await screen.findByTestId('pwa-rates');
    // The background reading of the latest snapshot finds another one: the banner offers it.
    expect(await screen.findByTestId('new-data-banner')).toBeInTheDocument();
    expect(screen.getByTestId('pwa-rates')).toBeInTheDocument();
  });

  it('keeps the page inside 360 px: no fixed width wider than the column', async () => {
    open(() => body());
    await screen.findByTestId('pwa-rates');
    // jsdom has no layout; the rule that matters is in the stylesheet: one column, a maximum width, no horizontal overflow of the screen.
    const css = readFileSync(join(__dirname, 'pwa.css'), 'utf8');
    expect(css).toMatch(/\.pwa-screen\s*\{[^}]*max-width:\s*720px/);
    expect(css).not.toMatch(/\bwidth:\s*\d{4,}px/);
  });

  it('has no serious accessibility violation', async () => {
    open(() => body());
    await screen.findByTestId('pwa-rates');
    await waitFor(() => expect(screen.getByTestId('pwa-band')).toBeInTheDocument());
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
