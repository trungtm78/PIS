import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import CommandCenterScreen from './CommandCenterScreen';
import OverviewScreen from './OverviewScreen';
import { homeRoot } from './hooks';

const CC = routeOf('HOME-09', 'FR-HOME-09');
const OV = routeOf('HOME-01', 'FR-HOME-01');
const READER = ['home.read'];
const S40 = '00000000-0000-4000-8000-0000000000f2';
const S41 = '00000000-0000-4000-8000-0000000000f3';
const NORTH = '00000000-0000-4000-8000-000000000012';
const TENANT = '00000000-0000-4000-8000-00000000000a';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

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
    tile('DISBURSEMENT_RATE_TOTAL', { value: '48.0000', denominator: '1250000000000', formula: 'disbursed_treasury_vnd / (plan_pm_assigned_vnd + plan_local_added_vnd) * 100' }),
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

/** `answers` is what the server says to a read with no snapshot named (the latest), `pinned` to one that names a snapshot. */
function client(answers: { latest: () => unknown; units?: unknown[] }): Harness {
  const h = harness((operation) => {
    if (operation !== 'getCommandCenter') return new Error(`unexpected read ${operation}`);
    return answers.latest();
  });
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown> }).readAll = (operation) => (operation === 'get_resources_organization_unit' ? Promise.resolve(answers.units ?? []) : Promise.reject(new Error(`unexpected readAll ${operation}`)));
  return h;
}

afterEach(cleanup);

describe('HOME-09 command center (ST-HOME-001, BR-HOME-01)', () => {
  it('AC-ST-HOME-001-1: UAT-AC266 shows every tile with its scope, day, snapshot, unit of measure and formula, and the two rates side by side over the same numerator', async () => {
    mount(<CommandCenterScreen route={CC} />, client({ latest: () => body() }), { permissions: READER });
    const rates = await screen.findByTestId('home-rates');
    const pm = rates.querySelector('[data-rate="pm"]') as HTMLElement;
    const total = rates.querySelector('[data-rate="total"]') as HTMLElement;
    expect(pm.parentElement).toBe(total.parentElement);
    expect(within(pm).getByTestId('tile-value-DISBURSEMENT_RATE_PM').textContent).toBe('60.0000%');
    expect(within(total).getByTestId('tile-value-DISBURSEMENT_RATE_TOTAL').textContent).toBe('48.0000%');
    // The same numerator over the two plans, with the words DIS-19 uses.
    expect(within(pm).getByTestId('tile-sums-DISBURSEMENT_RATE_PM').textContent).toContain('600.000.000.000');
    expect(within(total).getByTestId('tile-sums-DISBURSEMENT_RATE_TOTAL').textContent).toContain('600.000.000.000');
    expect(pm.textContent).toContain(vi_['dis.rates.col.ratePm']);
    expect(total.textContent).toContain(vi_['dis.rates.col.rateTotal']);
    // The CXN-03 tooltip: the formula is a proposal.
    expect(pm.getAttribute('title')).toContain('CXN-03');
    expect(within(pm).getByTestId('tile-definition-DISBURSEMENT_RATE_PM').textContent).toContain('CXN-03');
    expect(within(pm).getByTestId('tile-formula-DISBURSEMENT_RATE_PM').textContent).toContain('plan_pm_assigned_vnd');
    expect(within(pm).getByTestId('tile-measure-DISBURSEMENT_RATE_PM').textContent).toBe(vi_['home.tile.measure.percent']);
    // The amounts, each with its unit of measure.
    expect(screen.getByTestId('tile-value-PLAN_TOTAL').textContent).toBe(fill(vi_['home.tile.value.vnd'], { value: '1.250.000.000.000' }));
    expect(screen.getByTestId('tile-measure-PLAN_TOTAL').textContent).toBe(vi_['home.tile.measure.vnd']);
    // The context of all of them, above them.
    const context = screen.getByTestId('home-context');
    expect(context.compareDocumentPosition(rates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('context-scope').textContent).toBe(fill(vi_['home.context.scope.all'], { projects: 3 }));
    expect(screen.getByTestId('context-as-of').textContent).toBe('2027-10-12');
    expect(screen.getByTestId('context-snapshot').getAttribute('title')).toBe(S40);
    expect(screen.getByTestId('context-cutoff').textContent).toBe('2027-10-12');
  });

  it('gives each tile the way to its source, carrying its signed token and nothing else', async () => {
    mount(<CommandCenterScreen route={CC} />, client({ latest: () => body() }), { permissions: READER });
    const rates = await screen.findByTestId('home-rates');
    const link = within(rates.querySelector('[data-rate="pm"]') as HTMLElement).getByRole('link');
    expect(link.getAttribute('href')).toBe('/home/home-10?token=token-DISBURSEMENT_RATE_PM.sig');
  });

  it('AC-ST-HOME-001-3: UAT-AC268 says "no data" for a figure the Treasury has none of, never 0, and counts the projects without data in the footer', async () => {
    const missing = body({
      tiles: [
        tile('DISBURSEMENT_RATE_PM', { value: null, null_reason: 'NO_DATA', numerator: null }),
        tile('DISBURSEMENT_RATE_TOTAL', { value: null, null_reason: 'NO_DATA', numerator: null }),
        tile('DISBURSED_TREASURY', { unit: 'VND', value: null, null_reason: 'NO_DATA', numerator: null, denominator: null }),
        tile('PLAN_TOTAL', { unit: 'VND', value: '1250000000000', numerator: null, denominator: null }),
      ],
      projects_without_data: 1,
    });
    mount(<CommandCenterScreen route={CC} />, client({ latest: () => missing }), { permissions: READER });
    await screen.findByTestId('home-rates');
    for (const code of ['DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL', 'DISBURSED_TREASURY']) {
      expect(screen.getByTestId(`tile-value-${code}`).textContent).toBe(vi_['home.tile.nullReason.noData']);
      expect(screen.getByTestId(`tile-value-${code}`).textContent).not.toMatch(/^0/);
    }
    expect(screen.getByTestId('without-data').textContent).toBe(fill(vi_['home.footer.withoutData'], { count: 1 }));
  });

  it('AC-ST-HOME-001-4: UAT-AC270 loads without data governance and says the quality is not assessed', async () => {
    mount(<CommandCenterScreen route={CC} />, client({ latest: () => body() }), { permissions: READER });
    const context = await screen.findByTestId('home-context');
    expect(within(context).getByText(vi_['home.quality.notAssessed'])).toBeTruthy();
  });

  it('counts what waits and leads to the screen of each', async () => {
    mount(<CommandCenterScreen route={CC} />, client({ latest: () => body() }), { permissions: READER });
    const waiting = await screen.findByTestId('home-waiting');
    const row = (name: string) => waiting.querySelector(`[data-count="${name}"]`) as HTMLElement;
    expect(row('warnings').textContent).toContain(fill(vi_['home.counts.warnings'], { count: 3 }));
    expect(row('explanations').textContent).toContain(fill(vi_['home.counts.explanations'], { count: 2 }));
    expect(row('reallocations').textContent).toContain(fill(vi_['home.counts.reallocations'], { count: 1 }));
    expect(within(row('warnings')).getByRole('link').getAttribute('href')).toBe('/home/home-03');
    expect(within(row('explanations')).getByRole('link').getAttribute('href')).toBe('/home/home-02');
    expect(within(row('reallocations')).getByRole('link').getAttribute('href')).toBe('/cap/cap-19');
  });

  describe('AC-ST-HOME-001-5: UI-HOME-09 empty, stale and new-data states', () => {
    it('shows the empty state with the way to the snapshots when nothing is frozen', async () => {
      mount(<CommandCenterScreen route={CC} />, client({ latest: () => failure(404, 'RESOURCE_NOT_FOUND') }), { permissions: READER });
      const empty = await screen.findByTestId('home-empty');
      expect(within(empty).getByText(vi_['home.empty.title'])).toBeTruthy();
      expect(within(empty).getByRole('link', { name: vi_['home.empty.link'] }).getAttribute('href')).toBe('/dis/dis-21');
    });

    it('shows the figures of a snapshot older than eight days, and says it is old', async () => {
      mount(<CommandCenterScreen route={CC} />, client({ latest: () => body({ freshness: 'STALE' }) }), { permissions: READER });
      expect((await screen.findByTestId('stale-notice')).textContent).toBe(vi_['home.fresh.stale']);
      expect(screen.getByTestId('tile-value-DISBURSEMENT_RATE_PM').textContent).toBe('60.0000%');
    });

    it('says a snapshot has become stale by its day, although the server called it fresh when it was read', async () => {
      mount(<CommandCenterScreen route={CC} />, client({ latest: () => body({ freshness: 'FRESH', as_of_date: '2020-01-01' }) }), { permissions: READER });
      expect((await screen.findByTestId('stale-notice')).textContent).toBe(vi_['home.fresh.stale']);
      cleanup();
      mount(<CommandCenterScreen route={CC} />, client({ latest: () => body({ freshness: 'FRESH', as_of_date: '2999-01-01' }) }), { permissions: READER });
      await screen.findByTestId('home-rates');
      expect(screen.queryByTestId('stale-notice')).toBeNull();
    });

    it('learns from the background reading that the snapshot on the screen has aged past the limit, with no click and no new snapshot', async () => {
      let latest: unknown = body({ freshness: 'FRESH', as_of_date: '2999-01-01' });
      const view = mount(<CommandCenterScreen route={CC} />, client({ latest: () => latest }), { permissions: READER });
      await screen.findByTestId('home-rates');
      expect(screen.queryByTestId('stale-notice')).toBeNull();
      latest = body({ freshness: 'STALE', as_of_date: '2999-01-01' });
      await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
      expect((await screen.findByTestId('stale-notice')).textContent).toBe(vi_['home.fresh.stale']);
      expect(screen.queryByTestId('new-data-banner')).toBeNull();
    });

    it('hides the figures and says so when the background reading finds that the right was taken away, and keeps them through a network failure of it', async () => {
      let latest: unknown = body();
      const view = mount(<CommandCenterScreen route={CC} />, client({ latest: () => latest }), { permissions: READER });
      await screen.findByTestId('home-rates');
      latest = new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' });
      await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.getByTestId('home-rates')).toBeTruthy();
      latest = failure(403, 'SCOPE_DENIED');
      await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(screen.queryByTestId('home-rates')).toBeNull();
      expect(screen.queryByTestId('home-waiting')).toBeNull();
    });

    it('reads the figures again, over the same snapshot, when the background reading finds that the scope of the reader is not the one they were read in, and does not show the old ones meanwhile', async () => {
      let scope = { unit_id: null, denominator_kind: null, projects: 3, scope_hash: 'h1' };
      const h = client({ latest: () => body() });
      h.read.mockImplementation((operation: string, input?: unknown) => {
        if (operation !== 'getCommandCenter') return Promise.reject(new Error('unexpected'));
        const named = (input as { query?: { snapshot_id?: string } }).query?.snapshot_id;
        return Promise.resolve(body({ snapshot_id: named ?? S40, scope }));
      });
      const view = mount(<CommandCenterScreen route={CC} />, h, { permissions: READER });
      await screen.findByTestId('home-rates');
      expect(screen.getByTestId('context-scope').textContent).toBe(fill(vi_['home.context.scope.all'], { projects: 3 }));
      // The access of the reader is narrowed: the server now reads them in another scope.
      scope = { unit_id: null, denominator_kind: null, projects: 1, scope_hash: 'h2' };
      await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
      await waitFor(() => expect(screen.getByTestId('context-scope').textContent).toBe(fill(vi_['home.context.scope.all'], { projects: 1 })));
      const reread = h.read.mock.calls.map((call) => (call[1] as { query: Record<string, string> }).query).filter((query) => query.snapshot_id !== undefined);
      expect(reread.length).toBeGreaterThan(0);
      expect(reread.every((query) => query.snapshot_id === S40)).toBe(true);
    });

    it('does not bring the old figures back when the retry after a refusal is refused too, and shows them again when the right is back', async () => {
      const user = userEvent.setup();
      let answer: unknown = body();
      const view = mount(<CommandCenterScreen route={CC} />, client({ latest: () => answer }), { permissions: READER });
      await screen.findByTestId('home-rates');
      answer = failure(403, 'FORBIDDEN');
      await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
      await screen.findByText(vi_['states.denied.title']);
      await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByTestId('home-rates')).toBeNull();
      expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
      answer = body();
      await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('home-rates')).toBeTruthy();
    });

    it('drops what was read under a right that was taken away: a later failure of the poll, of any kind, does not bring the figures back', async () => {
      let answer: unknown = body();
      const view = mount(<CommandCenterScreen route={CC} />, client({ latest: () => answer }), { permissions: READER });
      await screen.findByTestId('home-rates');
      answer = failure(403, 'FORBIDDEN');
      await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
      await screen.findByText(vi_['states.denied.title']);
      for (const later of [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), failure(500, 'INTERNAL_ERROR')]) {
        answer = later;
        await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(screen.queryByTestId('home-rates')).toBeNull();
        expect(screen.queryByTestId('home-waiting')).toBeNull();
      }
    });

    it('keeps the old figures hidden when the refusal is of the scope and the retry is refused as well', async () => {
      const user = userEvent.setup();
      let answer: unknown = body();
      const view = mount(<CommandCenterScreen route={CC} />, client({ latest: () => answer }), { permissions: READER });
      await screen.findByTestId('home-rates');
      answer = failure(403, 'SCOPE_DENIED');
      await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
      await screen.findByText(vi_['states.denied.title']);
      await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByTestId('home-rates')).toBeNull();
      expect(screen.queryByTestId('home-waiting')).toBeNull();
    });

    it('finds the first snapshot when the page was opened before anything was frozen, and shows it when the leader takes it', async () => {
      const user = userEvent.setup();
      let answer: unknown = failure(404, 'RESOURCE_NOT_FOUND');
      const view = mount(<CommandCenterScreen route={CC} />, client({ latest: () => answer }), { permissions: READER });
      await screen.findByTestId('home-empty');
      expect(screen.queryByTestId('new-data-banner')).toBeNull();
      answer = body();
      await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
      expect(await screen.findByTestId('new-data-banner')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: vi_['home.banner.refresh'] }));
      expect(await screen.findByTestId('home-rates')).toBeTruthy();
      expect(screen.queryByTestId('home-empty')).toBeNull();
    });

    it('offers a newer snapshot in a banner without changing the figures, and shows it when the leader takes it', async () => {
      const user = userEvent.setup();
      let latest: unknown = body();
      const h = client({ latest: () => latest });
      const view = mount(<CommandCenterScreen route={CC} />, h, { permissions: READER });
      await screen.findByTestId('home-rates');
      expect(screen.queryByTestId('new-data-banner')).toBeNull();
      // A newer snapshot is frozen while the leader reads: the poll sees it, the figures do not move.
      latest = body({ snapshot_id: S41, as_of_date: '2027-10-19', tiles: [tile('DISBURSEMENT_RATE_PM', { value: '70.0000' }), tile('DISBURSEMENT_RATE_TOTAL', { value: '56.0000' })] });
      await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
      expect(await screen.findByTestId('new-data-banner')).toBeTruthy();
      expect(screen.getByTestId('tile-value-DISBURSEMENT_RATE_PM').textContent).toBe('60.0000%');
      expect(screen.getByTestId('context-as-of').textContent).toBe('2027-10-12');
      // Focus and reconnection do not change them either.
      window.dispatchEvent(new Event('focus'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.getByTestId('tile-value-DISBURSEMENT_RATE_PM').textContent).toBe('60.0000%');
      await user.click(screen.getByRole('button', { name: vi_['home.banner.refresh'] }));
      await waitFor(() => expect(screen.getByTestId('tile-value-DISBURSEMENT_RATE_PM').textContent).toBe('70.0000%'));
      expect(screen.getByTestId('context-as-of').textContent).toBe('2027-10-19');
      await waitFor(() => expect(screen.queryByTestId('new-data-banner')).toBeNull());
    });
  });

  it('moves the counts of what waits with the background reading while the figures of the snapshot stand (a warning resolved, no new snapshot)', async () => {
    let latest: unknown = body();
    const view = mount(<CommandCenterScreen route={CC} />, client({ latest: () => latest }), { permissions: READER });
    const waiting = await screen.findByTestId('home-waiting');
    expect(waiting.querySelector('[data-count="warnings"]')?.textContent).toContain(fill(vi_['home.counts.warnings'], { count: 3 }));
    latest = body({ open_warnings: 1, overdue_explanations: 0, pending_reallocations: 4, tiles: [tile('DISBURSEMENT_RATE_PM', { value: '99.0000' }), tile('DISBURSEMENT_RATE_TOTAL', { value: '98.0000' })] });
    await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
    await waitFor(() => expect(screen.getByTestId('home-waiting').querySelector('[data-count="warnings"]')?.textContent).toContain(fill(vi_['home.counts.warnings'], { count: 1 })));
    expect(screen.getByTestId('home-waiting').querySelector('[data-count="explanations"]')?.textContent).toContain(fill(vi_['home.counts.explanations'], { count: 0 }));
    expect(screen.getByTestId('home-waiting').querySelector('[data-count="reallocations"]')?.textContent).toContain(fill(vi_['home.counts.reallocations'], { count: 4 }));
    // The figures belong to the snapshot, and the snapshot did not change.
    expect(screen.getByTestId('tile-value-DISBURSEMENT_RATE_PM').textContent).toBe('60.0000%');
    expect(screen.queryByTestId('new-data-banner')).toBeNull();
  });

  describe('the answers that are not figures', () => {
    it.each([
      ['a snapshot that is not frozen', failure(422, 'SNAPSHOT_NOT_FROZEN'), vi_['home.problem.notFrozen']],
      ['a unit that is not the reader\'s', failure(403, 'SCOPE_DENIED'), vi_['home.problem.unitDenied']],
      ['a figure that cannot be given', failure(422, 'METRIC_UNAVAILABLE'), vi_['home.problem.unavailable']],
      ['a request that is not valid', failure(422, 'VALIDATION_FAILED'), vi_['home.problem.validation']],
    ])('says %s in words and shows no figure', async (_name, error, text) => {
      mount(<CommandCenterScreen route={CC} />, client({ latest: () => error }), { permissions: READER });
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.queryByTestId('home-rates')).toBeNull();
    });

    it('does not show a figure whose answer lacks the day, the snapshot or the formula (BR-HOME-01)', async () => {
      mount(<CommandCenterScreen route={CC} />, client({ latest: () => body({ as_of_date: undefined }) }), { permissions: READER });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      expect(screen.queryByTestId('home-rates')).toBeNull();
    });
  });

  describe('the seven standard states', () => {
    it.each([
      ['denied', failure(403, 'FORBIDDEN'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('UI-HOME-09 shows the %s state', async (_name, error, title) => {
      mount(<CommandCenterScreen route={CC} />, client({ latest: () => error }), { permissions: READER });
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-HOME-09 shows the loading state first, names the page, and retries after an error', async () => {
      mount(<CommandCenterScreen route={CC} />, harness(() => new Promise(() => undefined)), { permissions: READER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['home.cc.page.title'] })).toBeTruthy();
      cleanup();
      let failing = true;
      mount(<CommandCenterScreen route={CC} />, client({ latest: () => (failing ? failure(500, 'INTERNAL_ERROR') : body()) }), { permissions: READER });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('home-rates')).toBeTruthy();
    });
  });
});

describe('HOME-01 executive overview (ST-HOME-001)', () => {
  const units = [
    { id: NORTH, code: 'N', name: 'Bắc', parent_id: null, valid_from: '2026-01-01', valid_until: null, unit_type: 'DEPARTMENT', administrative_code: null, is_investor: false, legal_basis_ref: null, status: 'ACTIVE', successor_id: null, depth: 0, version: 1 },
  ];

  it('AC-ST-HOME-001-6: UI-HOME-01 shows the year, the unit and the day the figures are as of, with the same figures as the command center', async () => {
    mount(<OverviewScreen route={OV} />, client({ latest: () => body(), units }), { permissions: READER });
    await screen.findByTestId('home-rates');
    expect(screen.getByTestId('filter-year').textContent).toBe('2027');
    expect(screen.getByTestId('filter-as-of').textContent).toBe('2027-10-12');
    expect(screen.getByLabelText(vi_['home.filter.unit.label'])).toBeTruthy();
    expect(screen.getByTestId('tile-value-DISBURSEMENT_RATE_PM').textContent).toBe('60.0000%');
    expect(screen.getByTestId('tile-value-DISBURSEMENT_RATE_TOTAL').textContent).toBe('48.0000%');
  });

  it('AC-ST-HOME-001-6: UI-HOME-01 reads the unit the person chooses, and says which unit the figures are of', async () => {
    const user = userEvent.setup();
    const h = client({
      latest: () => body(),
      units,
    });
    h.read.mockImplementation((operation: string, input?: unknown) => {
      if (operation !== 'getCommandCenter') return Promise.reject(new Error('unexpected'));
      const unit = (input as { query?: { unit_id?: string } }).query?.unit_id;
      return Promise.resolve(unit === NORTH ? body({ scope: { unit_id: NORTH, denominator_kind: null, projects: 1, scope_hash: 'h' }, tiles: [tile('DISBURSEMENT_RATE_PM', { value: '55.0000' }), tile('DISBURSEMENT_RATE_TOTAL', { value: '44.0000' })] }) : body());
    });
    mount(<OverviewScreen route={OV} />, h, { permissions: READER });
    await screen.findByTestId('home-rates');
    await user.selectOptions(await screen.findByLabelText(vi_['home.filter.unit.label']), NORTH);
    await waitFor(() => expect(screen.getByTestId('tile-value-DISBURSEMENT_RATE_PM').textContent).toBe('55.0000%'));
    expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, string> }).query.unit_id === NORTH)).toBe(true);
    expect(screen.getByTestId('context-scope').textContent).toBe(fill(vi_['home.context.scope.unit'], { unit: 'Bắc', projects: 1 }));
  });

  it('AC-ST-HOME-001-6: UI-HOME-01 keeps the snapshot on the screen when the unit changes, and moves to a newer one only when the leader takes it', async () => {
    const user = userEvent.setup();
    let latest: unknown = body();
    const h = client({ latest: () => latest, units });
    h.read.mockImplementation((operation: string, input?: unknown) => {
      const query = (input as { query?: { snapshot_id?: string; unit_id?: string } }).query ?? {};
      if (operation !== 'getCommandCenter') return Promise.reject(new Error('unexpected'));
      // A request that names no snapshot is answered with the latest; one that names a snapshot, with that one.
      if (query.snapshot_id === S40) return Promise.resolve(body({ scope: { unit_id: query.unit_id ?? null, denominator_kind: null, projects: query.unit_id === undefined ? 3 : 1, scope_hash: 'h' } }));
      return Promise.resolve(latest);
    });
    const view = mount(<OverviewScreen route={OV} />, h, { permissions: READER });
    await screen.findByTestId('home-rates');
    latest = body({ snapshot_id: S41, as_of_date: '2027-10-19' });
    await view.queries.invalidateQueries({ queryKey: [...homeRoot(TENANT), 'latest'] });
    await screen.findByTestId('new-data-banner');
    await user.selectOptions(await screen.findByLabelText(vi_['home.filter.unit.label']), NORTH);
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, string> }).query.unit_id === NORTH)).toBe(true));
    // The unit was read over the snapshot on the screen, not over the newer one (the background reading names no snapshot, it only asks which is the latest and what waits).
    const narrowed = h.read.mock.calls.map((call) => (call[1] as { query: Record<string, string> }).query).filter((query) => query.unit_id === NORTH && query.snapshot_id !== undefined);
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.every((query) => query.snapshot_id === S40)).toBe(true);
    expect(screen.getByTestId('context-as-of').textContent).toBe('2027-10-12');
    // Going back to the whole scope does not ask again either, and is of the same snapshot.
    await user.selectOptions(screen.getByLabelText(vi_['home.filter.unit.label']), '');
    await waitFor(() => expect(screen.getByTestId('context-scope').textContent).toBe(fill(vi_['home.context.scope.all'], { projects: 3 })));
    expect(screen.getByTestId('context-as-of').textContent).toBe('2027-10-12');
    // The banner is how the leader moves to the newer snapshot.
    await user.click(screen.getByRole('button', { name: vi_['home.banner.refresh'] }));
    await waitFor(() => expect(screen.getByTestId('context-as-of').textContent).toBe('2027-10-19'));
  });

  it('AC-ST-HOME-001-6: UI-HOME-01 says the figures are of a unit when the name of the unit cannot be read, and never that they are of everything', async () => {
    const narrowed = body({ scope: { unit_id: NORTH, denominator_kind: null, projects: 1, scope_hash: 'h' } });
    mount(<OverviewScreen route={OV} />, client({ latest: () => narrowed, units: [] }), { permissions: READER }, `/?unit=${NORTH}`);
    const scope = await screen.findByTestId('context-scope');
    expect(scope.textContent).not.toBe(fill(vi_['home.context.scope.all'], { projects: 1 }));
    expect(scope.textContent).toBe(fill(vi_['home.context.scope.unit'], { unit: '00000000…0012', projects: 1 }));
  });

  it('AC-ST-HOME-001-6: UI-HOME-01 works without the list of units: the filter is left out, the figures are there', async () => {
    mount(<OverviewScreen route={OV} />, client({ latest: () => body(), units: [] }), { permissions: READER });
    await screen.findByTestId('home-rates');
    expect(screen.queryByLabelText(vi_['home.filter.unit.label'])).toBeNull();
  });

  it.each([
    ['empty', failure(404, 'RESOURCE_NOT_FOUND'), 'home-empty'],
    ['denied', failure(403, 'FORBIDDEN'), undefined],
  ])('AC-ST-HOME-001-6: UI-HOME-01 shows the %s state and keeps the filters', async (_name, error, testId) => {
    mount(<OverviewScreen route={OV} />, client({ latest: () => error, units }), { permissions: READER });
    if (testId !== undefined) expect(await screen.findByTestId(testId)).toBeTruthy();
    else expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(screen.getByTestId('filter-as-of')).toBeTruthy();
  });
});
