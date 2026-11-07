import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import RankingScreen from './RankingScreen';
import { groupsOf, tablesFor, toRankings } from './warning-model';

const ROUTE = routeOf('HOME-04', 'FR-HOME-04');
const READER = ['home.read'];
const S40 = '00000000-0000-4000-8000-0000000000f2';
const U1 = '00000000-0000-4000-8000-000000000011';
const U2 = '00000000-0000-4000-8000-000000000012';
const U3 = '00000000-0000-4000-8000-000000000013';
const BN = 1_000_000_000;
const dong = (billions: number): string => String(billions * BN);

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

const row = (rank: number | null, id: string, code: string, plan: number, disbursed: number | null, rate: string | null, reason: string | null = null) => ({
  rank,
  unit: { id, code, name: `Ban ${code}` },
  plan_vnd: dong(plan),
  disbursed_vnd: disbursed === null ? null : dong(disbursed),
  rate_pct: rate,
  excluded_reason: reason,
});
const body = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: S40,
  as_of_date: '2027-10-12',
  treasury_cutoff_date: '2027-10-12',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  legal_confirmation_refs: ['CXN-03'],
  visibility: 'ALL',
  tables: [
    // FX-DIS-007: over the plan of the Prime Minister the second unit leads; over the whole plan the first does.
    { comparison_group: 'PROJECT_MANAGEMENT_BOARD', denominator_kind: 'PM_ASSIGNED', ranked: [row(1, U2, 'BQL-S', 500, 250, '50.0000'), row(2, U1, 'BQL-N', 1000, 140, '14.0000')], excluded: [row(null, U3, 'ROOT', 0, null, null, 'ZERO_DENOMINATOR')] },
    { comparison_group: 'PROJECT_MANAGEMENT_BOARD', denominator_kind: 'TOTAL_INCL_LOCAL', ranked: [row(1, U1, 'BQL-N', 1250, 140, '11.2000'), row(2, U2, 'BQL-S', 500, 40, '8.0000')], excluded: [row(null, U3, 'ROOT', 0, null, null, 'ZERO_DENOMINATOR')] },
    { comparison_group: 'COMMUNE', denominator_kind: 'PM_ASSIGNED', ranked: [row(1, U1, 'XA-1', 10, 5, '50.0000')], excluded: [] },
  ],
  ...overrides,
});

afterEach(cleanup);

describe('HOME-04 ranking (ST-HOME-003, HOME 3 F3, BR-HOME-06)', () => {
  it('AC-ST-HOME-003-3, AC-ST-HOME-003-4: UAT-AC04 shows a table for each denominator apart, with the 14% and the order of FX-DIS-007, and the unit with a plan of nothing left out with its reason', async () => {
    const user = userEvent.setup();
    mount(<RankingScreen route={ROUTE} />, harness(() => body()), { permissions: READER });
    const tables = await screen.findAllByTestId('ranking-table');
    // The plan of the Prime Minister first: two tables (the group of boards and the communes), and not one of the other denominator beside them.
    expect(tables.map((table) => table.getAttribute('data-table'))).toEqual(['PROJECT_MANAGEMENT_BOARD|PM_ASSIGNED', 'COMMUNE|PM_ASSIGNED']);
    const boards = tables[0] as HTMLElement;
    expect(Array.from(boards.querySelectorAll('tbody [data-unit-id]')).map((cell) => cell.getAttribute('data-unit-id'))).toEqual([U2, U1]);
    expect(within(boards).getByTestId(`rate-${U1}`).textContent).toBe('14.0000%');
    expect(within(boards).getByTestId('ranking-excluded').textContent).toContain(vi_['home.ranking.reason.zeroDenominator']);
    // The other denominator is another table, with another order.
    await user.selectOptions(screen.getByLabelText(vi_['home.ranking.denominator.label']), 'TOTAL_INCL_LOCAL');
    const total = (await screen.findAllByTestId('ranking-table'))[0] as HTMLElement;
    expect(total.getAttribute('data-table')).toBe('PROJECT_MANAGEMENT_BOARD|TOTAL_INCL_LOCAL');
    expect(Array.from(total.querySelectorAll('tbody [data-unit-id]')).map((cell) => cell.getAttribute('data-unit-id'))).toEqual([U1, U2]);
    expect(within(total).getByTestId(`rate-${U1}`).textContent).toBe('11.2000%');
  });

  it('narrows to one comparison group and clears the narrowing with the button of the filter panel', async () => {
    const user = userEvent.setup();
    mount(<RankingScreen route={ROUTE} />, harness(() => body()), { permissions: READER });
    expect(await screen.findAllByTestId('ranking-table')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Xóa bộ lọc' })).toBeNull();
    await user.selectOptions(screen.getByLabelText(vi_['home.ranking.group.label']), 'COMMUNE');
    await waitFor(() => expect(screen.getAllByTestId('ranking-table')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Xóa bộ lọc' }));
    await waitFor(() => expect(screen.getAllByTestId('ranking-table')).toHaveLength(2));
  });

  it('AC-ST-HOME-003-5: UI-HOME-04 shows the snapshot and the day, says the formulas are proposals, and says which units are shown when the tenant limits the ranking to the reader', async () => {
    mount(<RankingScreen route={ROUTE} />, harness(() => body({ visibility: 'OWN_ONLY' })), { permissions: READER });
    const context = await screen.findByTestId('ranking-context');
    expect(context.textContent).toBe(fill(vi_['home.ranking.snapshot'], { id: '00000000…00f2', date: '2027-10-12' }));
    expect(screen.getByText(fill(vi_['home.tile.definition.pending'], { ref: 'CXN-03' }))).toBeTruthy();
    expect(screen.getByTestId('ranking-own-only').textContent).toBe(vi_['home.ranking.visibility.ownOnly']);
  });

  it('narrows to a comparison group, and says there is no table when the group has none for the denominator', async () => {
    const user = userEvent.setup();
    mount(<RankingScreen route={ROUTE} />, harness(() => body()), { permissions: READER });
    await screen.findAllByTestId('ranking-table');
    await user.selectOptions(screen.getByLabelText(vi_['home.ranking.group.label']), 'COMMUNE');
    expect(screen.getAllByTestId('ranking-table')).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText(vi_['home.ranking.denominator.label']), 'TOTAL_INCL_LOCAL');
    expect(await screen.findByTestId('ranking-no-table')).toBeTruthy();
  });

  it('says no data for a ranked unit that has no rate, never 0', async () => {
    const odd = body({ tables: [{ comparison_group: 'G', denominator_kind: 'PM_ASSIGNED', ranked: [row(1, U1, 'A', 10, null, null)], excluded: [] }] });
    mount(<RankingScreen route={ROUTE} />, harness(() => odd), { permissions: READER });
    expect((await screen.findByTestId(`rate-${U1}`)).textContent).toBe(vi_['home.tile.nullReason.noData']);
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', body({ tables: [] }), vi_['states.empty.title']],
      ['not found (nothing is ranked yet)', failure(404, 'RESOURCE_NOT_FOUND'), vi_['states.error.title']],
      ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('AC-ST-HOME-003-5: UI-HOME-04 shows the %s state and keeps the filters', async (_name, reply, title) => {
      mount(<RankingScreen route={ROUTE} />, harness(() => reply), { permissions: READER });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByLabelText(vi_['home.ranking.denominator.label'])).toBeTruthy();
    });

    it('AC-ST-HOME-003-5: UI-HOME-04 shows the loading state first, names the page, and retries after an error', async () => {
      mount(<RankingScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: READER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['home.ranking.page.title'] })).toBeTruthy();
      cleanup();
      let failing = true;
      mount(<RankingScreen route={ROUTE} />, harness(() => (failing ? failure(500, 'INTERNAL_ERROR') : body())), { permissions: READER });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect((await screen.findAllByTestId('ranking-table')).length).toBeGreaterThan(0);
    });
  });
});

describe('the ranking as the screen reads it', () => {
  it('reads the tables apart, and leaves out a table without a denominator it knows or a unit without an id', () => {
    const ranking = toRankings(body({ tables: [...body().tables, { comparison_group: 'X', denominator_kind: 'GUESS', ranked: [], excluded: [] }, { comparison_group: '', denominator_kind: 'PM_ASSIGNED', ranked: [], excluded: [] }] }));
    expect(ranking?.tables).toHaveLength(3);
    expect(groupsOf(ranking as never)).toEqual(['PROJECT_MANAGEMENT_BOARD', 'COMMUNE']);
    expect(tablesFor(ranking as never, 'PM_ASSIGNED', '').map((table) => table.comparisonGroup)).toEqual(['PROJECT_MANAGEMENT_BOARD', 'COMMUNE']);
    expect(tablesFor(ranking as never, 'TOTAL_INCL_LOCAL', 'COMMUNE')).toEqual([]);
    expect(toRankings({ snapshot_id: '', as_of_date: '2027-10-12' })).toBeUndefined();
    expect(toRankings(null)).toBeUndefined();
    const odd = toRankings(body({ tables: [{ comparison_group: 'G', denominator_kind: 'PM_ASSIGNED', ranked: [{ rank: 1, unit: {} }, row(1, U1, 'A', 1, 1, '100.0000')], excluded: [] }] }));
    expect(odd?.tables[0]?.ranked).toHaveLength(1);
  });
});
