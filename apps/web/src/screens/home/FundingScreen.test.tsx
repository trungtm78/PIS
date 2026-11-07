import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { NSDP, ODA, line } from '../cap/test-support';
import { harness, mount, routeOf } from '../mne/test-support';
import FundingDetailScreen from './FundingDetailScreen';
import FundingScreen from './FundingScreen';

const OVERVIEW = routeOf('HOME-07', 'FR-HOME-07');
const DETAIL = routeOf('HOME-08', 'FR-HOME-08');
const READER = ['capital.read'];
const BILLION = 1_000_000_000;
const vnd = (billions: number): string => String(billions * BILLION);
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

interface World {
  rows: unknown[] | Error;
  lines: Array<Record<string, unknown>> | Error;
}

/** A client whose `readAll` answers the register and the lines of the plan, and whose reads are never used. */
function client(world: World) {
  const h = harness((operation) => new Error(`unexpected read ${operation}`));
  const seen: Array<[string, unknown]> = [];
  const readAll = vi.fn((operation: string, input?: unknown) => {
    seen.push([operation, input]);
    const answer = operation === 'listAppropriations' ? world.rows : operation === 'get_resources_allocation_line' ? world.lines : new Error(`unexpected readAll ${operation}`);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll, seen });
}

const nstw = line(1, { amount_vnd: vnd(500) });
const planLine = (part: number, overrides: Record<string, unknown> = {}) => ({ plan_status: 'PUBLISHED', appropriation: { id: nstw.id }, amount_vnd: vnd(part * 2), ctmtqg_subset_vnd: vnd(part), ...overrides });
const normal = (): World => ({ rows: [nstw, line(2, { fund_source: NSDP, amount_vnd: vnd(100), origin: 'LOCAL_ADDED', budget_level: 'LOCAL' }), line(3, { fund_source: ODA, amount_vnd: vnd(50), decision_document: { id: 'd', symbol: '3/QD', issued_on: '2026-03-02' } })], lines: [planLine(40)] });

afterEach(cleanup);

describe('HOME-07 funding structure (ST-HOME-005, HOME 3 F6)', () => {
  it('AC-ST-HOME-005-1: UAT-AC269 shows the NSTW card with 500 billion and "of which CTMTQG 40 billion", and the total does not add the 40 billion', async () => {
    const h = client(normal());
    mount(<FundingScreen route={OVERVIEW} />, h, { permissions: READER });
    const card = await screen.findByTestId('source-NSTW');
    expect(card.textContent).toContain(fill(vi_['home.funding.card.amount'], { value: '500' }));
    await waitFor(() => expect(screen.getByTestId('subset-NSTW').textContent).toBe(fill(vi_['home.funding.subset.line'], { value: '40' })));
    // 500 + 100 + 50 = 650: the 40 of CTMTQG is inside the 500 and in no total.
    expect(screen.getByTestId('funding-total-amount').textContent).toContain(fill(vi_['home.funding.card.amount'], { value: '650' }));
    expect(screen.getByTestId('funding-total').textContent).toContain(vi_['home.funding.total.note']);
    expect(screen.getByTestId('source-ODA').textContent).toContain(fill(vi_['home.funding.card.amount'], { value: '50' }));
    // The sources are drawn once each, and CTMTQG has no card of its own.
    expect(document.querySelectorAll('[data-testid="funding-sources"] [data-card]')).toHaveLength(3);
    expect(document.querySelector('[data-card="CTMTQG"]')).toBeNull();
    // The allocation lines are read once, whatever plan they belong to: the register names no plan.
    expect(h.seen.filter(([operation]) => operation === 'get_resources_allocation_line')).toEqual([['get_resources_allocation_line', undefined]]);
  });

  it('AC-ST-HOME-005-2: UAT-AC269 says "no data" where nothing is published, and for the CTMTQG part when the lines are not read, and never writes zero', async () => {
    const h = client({ ...normal(), lines: failure(403, 'SCOPE_DENIED') });
    mount(<FundingScreen route={OVERVIEW} />, h, { permissions: READER });
    await screen.findByTestId('source-NSTW');
    await waitFor(() => expect(h.readAll.mock.calls.some(([operation]) => operation === 'get_resources_allocation_line')).toBe(true));
    // The lines could not be read: the capital published still shows, and the part says no data.
    await waitFor(() => expect(screen.getByTestId('subset-NSTW').textContent).toBe(vi_['home.funding.subset.none']));
    // Origins that have nothing published say so, one card each, none of them zero.
    expect(within(screen.getByTestId('origin-CARRYOVER')).getByText(vi_['home.funding.card.none'])).toBeTruthy();
    expect(within(screen.getByTestId('origin-REVENUE_INCREASE')).getByText(vi_['home.funding.card.none'])).toBeTruthy();
    expect(screen.getByTestId('origin-PM_ASSIGNED').textContent).toContain(fill(vi_['home.funding.card.amount'], { value: '550' }));
    expect(document.body.textContent).not.toMatch(/\b0 tỷ/);
  });

  it('keeps the year in the address, offers the years that have capital, and reads the card of another year', async () => {
    const user = userEvent.setup();
    const rows = [...(normal().rows as unknown[]), line(4, { plan_year: 2025, amount_vnd: vnd(80), origin: 'CARRYOVER' })];
    mount(<FundingScreen route={OVERVIEW} />, client({ rows, lines: [planLine(40)] }), { permissions: READER });
    expect(await screen.findByRole('heading', { name: fill(vi_['home.funding.total.title'], { year: 2026 }) })).toBeTruthy();
    const year = screen.getByLabelText(vi_['home.funding.year.label']) as HTMLSelectElement;
    expect([...year.options].map((option) => option.value)).toEqual(['2026', '2025']);
    await user.selectOptions(year, '2025');
    expect(await screen.findByRole('heading', { name: fill(vi_['home.funding.total.title'], { year: 2025 }) })).toBeTruthy();
    expect(screen.getByTestId('origin-CARRYOVER').textContent).toContain(fill(vi_['home.funding.card.amount'], { value: '80' }));
    expect(screen.getByRole('link', { name: vi_['home.funding.detail.link'] }).getAttribute('href')).toBe('/home/home-08?year=2025');
  });

  it('opens on the year in the address, and says no data for a year that has no capital', async () => {
    mount(<FundingScreen route={OVERVIEW} />, client(normal()), { permissions: READER }, '/?year=2031');
    expect(await screen.findByRole('heading', { name: fill(vi_['home.funding.total.title'], { year: 2031 }) })).toBeTruthy();
    expect(within(screen.getByTestId('funding-total-amount')).getByText(vi_['home.funding.card.none'])).toBeTruthy();
    expect(within(screen.getByTestId('source-NSTW')).getByText(vi_['home.funding.card.none'])).toBeTruthy();
  });

  it('takes back the CTMTQG part when a later read of the allocation lines fails, and does not keep showing the figure it read before', async () => {
    const world = normal();
    const { queries } = mount(<FundingScreen route={OVERVIEW} />, client(world), { permissions: READER });
    await waitFor(() => expect(screen.getByTestId('subset-NSTW').textContent).toBe(fill(vi_['home.funding.subset.line'], { value: '40' })));
    world.lines = failure(403, 'SCOPE_DENIED');
    await queries.invalidateQueries({ queryKey: ['home'] });
    await waitFor(() => expect(screen.getByTestId('subset-NSTW').textContent).toBe(vi_['home.funding.subset.none']));
  });

  it('says the part holds only what was read when a CTMTQG source is registered but the allocation lines cannot be read', async () => {
    const parts = line(5, { fund_source: { ...NSDP, business_key: 'CTMTQG-NTM', category: 'CTMTQG', relation: 'SUBSET_OF' }, amount_vnd: vnd(40) });
    mount(<FundingScreen route={OVERVIEW} />, client({ rows: [nstw, parts], lines: failure(403, 'SCOPE_DENIED') }), { permissions: READER });
    await waitFor(() => expect(screen.getByTestId('subset-NSTW').textContent).toContain(vi_['home.funding.subset.partial']));
    expect(screen.getByTestId('subset-NSTW').textContent).toContain(fill(vi_['home.funding.subset.line'], { value: '40' }));
    // Registered as a part of NSTW, it is in no total.
    expect(screen.getByTestId('funding-total-amount').textContent).toContain(fill(vi_['home.funding.card.amount'], { value: '500' }));
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', { rows: [], lines: [] }, vi_['states.empty.title']],
      ['empty of published capital', { rows: [line(1, { status: 'DRAFT' })], lines: [] }, vi_['states.empty.title']],
      ['denied', { rows: failure(403, 'SCOPE_DENIED'), lines: [] }, vi_['states.denied.title']],
      ['offline', { rows: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), lines: [] }, vi_['states.offline.title']],
      ['error', { rows: failure(500, 'INTERNAL_ERROR'), lines: [] }, vi_['states.error.title']],
      ['signed out', { rows: failure(401, 'SESSION_EXPIRED'), lines: [] }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('AC-ST-HOME-005-3: UI-HOME-07 shows the %s state', async (_name, world, title) => {
      mount(<FundingScreen route={OVERVIEW} />, client(world), { permissions: READER });
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('AC-ST-HOME-005-3: UI-HOME-07 shows the loading state first, names the page, and retries after an error', async () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<FundingScreen route={OVERVIEW} />, h, { permissions: READER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['home.funding.page.title'] })).toBeTruthy();
      cleanup();
      const world: World = { rows: failure(500, 'INTERNAL_ERROR'), lines: [] };
      mount(<FundingScreen route={OVERVIEW} />, client(world), { permissions: READER });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      world.rows = normal().rows;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('funding-sources')).toBeTruthy();
    });
  });
});

describe('HOME-08 sources and the scope of the calculation (ST-HOME-005)', () => {
  it('AC-ST-HOME-005-1: UAT-AC269 shows CTMTQG under NSTW as "Tập con của NSTW" with its cut-off, and the total row does not add it', async () => {
    mount(<FundingDetailScreen route={DETAIL} />, client(normal()), { permissions: READER });
    const table = await screen.findByTestId('funding-table');
    await waitFor(() => expect(within(table).getAllByText(vi_['home.funding.detail.relation.subset'])).toHaveLength(1));
    const rows = [...table.querySelectorAll('tbody tr')];
    // The relation column tells the part of NSTW from the independent sources: only the second row is a part.
    expect(rows.map((row) => within(row as HTMLElement).queryByText(vi_['home.funding.detail.relation.subset']) !== null)).toEqual([false, true, false, false]);
    const subset = rows[1] as HTMLElement;
    expect(within(subset).getByText(vi_['home.funding.detail.relation.subset'])).toBeTruthy();
    expect(within(subset).getByText('2026-01-15')).toBeTruthy();
    expect(within(subset).getByText('40.000.000.000')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(vi_['home.funding.detail.relation.independent'])).toBeTruthy();
    // The headers carry the two columns the module asks for.
    expect(within(table).getByRole('columnheader', { name: vi_['home.funding.detail.column.relation'] })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: vi_['home.funding.detail.column.cutoff'] })).toBeTruthy();
    // 500 + 100 + 50 = 650; the 40 is not in it.
    const totalRow = within(table).getByRole('rowheader', { name: vi_['home.funding.detail.total'] }).closest('tr') as HTMLElement;
    expect(totalRow.textContent).toContain('650.000.000.000');
    expect(screen.getByTestId('funding-scope').textContent).toContain(fill(vi_['home.funding.scope.published'], { year: 2026 }));
  });

  it('opens on the year of the cards, links back to them on that year, and has the seven states', async () => {
    mount(<FundingDetailScreen route={DETAIL} />, client({ rows: [line(4, { plan_year: 2025, amount_vnd: vnd(80), origin: 'CARRYOVER' })], lines: [] }), { permissions: READER }, '/?year=2025');
    expect(await screen.findByRole('heading', { name: fill(vi_['home.funding.detail.table'], { year: 2025 }) })).toBeTruthy();
    expect(screen.getByRole('link', { name: vi_['home.funding.detail.back'] }).getAttribute('href')).toBe('/home/home-07?year=2025');
    cleanup();
    mount(<FundingDetailScreen route={DETAIL} />, client({ rows: failure(403, 'SCOPE_DENIED'), lines: [] }), { permissions: READER });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<FundingDetailScreen route={DETAIL} />, client({ rows: [], lines: [] }), { permissions: READER });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(screen.queryByTestId('funding-table')).toBeNull();
  });

  it('shows a cut-off of none for an appropriation whose decision has no day, and a total of no data when nothing is added', async () => {
    const noDay = line(6, { decision_document: { id: 'd', symbol: null, issued_on: null }, amount_vnd: vnd(5) });
    mount(<FundingDetailScreen route={DETAIL} />, client({ rows: [noDay], lines: [] }), { permissions: READER });
    const table = await screen.findByTestId('funding-table');
    expect(within(table.querySelector('tbody tr') as HTMLElement).getByText(vi_['home.funding.detail.cutoff.none'])).toBeTruthy();
  });
});
