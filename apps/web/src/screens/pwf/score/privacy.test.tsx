import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import { isNeverCachedPath } from '../../../pwa/cache-policy';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionValue } from '../../../session/SessionContext';
import { PLATFORM_TENANT } from '../../sas/test-support';
import MyScoreScreen from './MyScoreScreen';
import ScoreDetailScreen from './ScoreDetailScreen';
import { SCORE_ROOT } from './hooks';
import UnitScoreboardScreen from './UnitScoreboardScreen';
import { LINE_ID, OTHER, SCORE_ALL, comparison, line, linePage, myScore, periodPage, routeOf, row, serve, text, uuid } from './test/fixtures';

// The screen is a set of tabs and every panel stays in the page (hidden when not chosen): the checks of what a panel holds reach it by role whether or not its tab is the open one. Which tab is open is checked on its own.
beforeAll(() => {
  configure({ defaultHidden: true });
});
afterAll(() => {
  configure({ defaultHidden: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cachedScores = (queries: QueryClient) => queries.getQueryCache().getAll().filter((query) => query.queryKey[0] === SCORE_ROOT);

const SECRET = 'rất-riêng-tư';
const reads = () =>
  serve(
    {
      getMyStaffScore: { items: [myScore()], next_cursor: null, as_of: '2026-11-12T03:00:00.000Z' },
      compareStaffScoreLines: comparison(),
      getStaffScoreLine: line({ membership_id: OTHER, display_name: 'Trần Thị Bình', can_respond: false, responses: [{ id: uuid(1), line_id: LINE_ID, body: SECRET.repeat(3), status: 'OPEN', submitted_at: '2027-01-06T03:00:00.000Z', handled_by: null, handled_at: null, conclusion: null, approval_instance_id: null }] }),
      listStaffScorePeriods: periodPage(),
      listStaffScoreLines: linePage([row(1), row(2)]),
      getEffectiveGovernanceRule: new Error('not read here'),
    },
    {},
  );

interface Options {
  membershipId?: string;
  permissions?: readonly string[];
}

function sessionOf({ membershipId = PLATFORM_TENANT.membershipId, permissions = SCORE_ALL }: Options): SessionValue {
  return {
    tenant: { ...PLATFORM_TENANT, membershipId },
    tenants: [PLATFORM_TENANT],
    user: { displayName: 'Admin', initials: 'AD' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions,
  };
}

/** A page whose session can be changed by a button: the membership and its rights are what a revoked right or a switch of person changes. */
function Page({ initial, children }: { initial: Options; children: (change: (next: Options) => void) => React.ReactNode }) {
  const [options, setOptions] = useState(initial);
  return <SessionContext.Provider value={sessionOf(options)}>{children(setOptions)}</SessionContext.Provider>;
}

function render2(initial: Options, screenOf: () => React.ReactNode, path = '/') {
  const h = reads();
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let change: (next: Options) => void = () => undefined;
  const result = render(
    <QueryClientProvider client={queries}>
      <ApiClientProvider client={h.client}>
        <MemoryRouter initialEntries={[path]}>
          <Page initial={initial}>
            {(set) => {
              change = set;
              return screenOf();
            }}
          </Page>
        </MemoryRouter>
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { ...result, queries, h, change: (next: Options) => act(() => change(next)) };
}

describe('scores are never left behind on the page (BR-PWF-40, R33)', () => {
  it('keeps no score in the cache once the screen of another person score is gone', async () => {
    const { queries, unmount } = render2({}, () => <ScoreDetailScreen route={routeOf('PWF-13')} />, `/pwf/pwf-13?id=${LINE_ID}`);
    await screen.findByRole('table');
    expect(cachedScores(queries).length).toBeGreaterThan(0);
    unmount();
    expect(cachedScores(queries)).toEqual([]);
  });

  it('keeps no score of a unit in the cache once the scoreboard is gone', async () => {
    const { queries, unmount } = render2({}, () => <UnitScoreboardScreen route={routeOf('PWF-12')} />);
    await screen.findByRole('table');
    expect(cachedScores(queries).length).toBeGreaterThan(0);
    unmount();
    expect(cachedScores(queries)).toEqual([]);
  });

  it('keeps no score of the person in the cache once their own screen is gone', async () => {
    const { queries, unmount } = render2({}, () => <MyScoreScreen route={routeOf('PWF-11')} />);
    await screen.findByTestId('my-period');
    expect(cachedScores(queries).length).toBeGreaterThan(0);
    unmount();
    expect(cachedScores(queries)).toEqual([]);
  });

  it('puts the tenant and the membership in every key, so one membership never reads what another cached', async () => {
    const { queries } = render2({}, () => <UnitScoreboardScreen route={routeOf('PWF-12')} />);
    await screen.findByRole('table');
    for (const query of cachedScores(queries)) {
      expect(query.queryKey[1]).toBe(PLATFORM_TENANT.id);
      expect(query.queryKey[2]).toBe(PLATFORM_TENANT.membershipId);
      expect(query.queryKey[3]).toBe([...SCORE_ALL].sort().join(','));
    }
  });

  it('removes what was read for a membership when the signed-in membership changes', async () => {
    const view = render2({}, () => <MyScoreScreen route={routeOf('PWF-11')} />);
    await screen.findByTestId('my-period');
    const first = cachedScores(view.queries).map((query) => query.queryHash);
    expect(first.length).toBeGreaterThan(0);
    await view.change({ membershipId: uuid(777) });
    await screen.findByTestId('my-period');
    const second = cachedScores(view.queries);
    expect(second.every((query) => query.queryKey[2] === uuid(777))).toBe(true);
    expect(second.some((query) => first.includes(query.queryHash))).toBe(false);
  });

  it('drops the scores read under the old rights when the rights of the membership change (a revoked right shows nothing the next render)', async () => {
    const view = render2({}, () => <UnitScoreboardScreen route={routeOf('PWF-12')} />);
    await screen.findByRole('table');
    expect(cachedScores(view.queries).length).toBeGreaterThan(0);
    await view.change({ permissions: ['staff_score.read_own'] });
    await screen.findByRole('alert');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Người 1')).toBeNull();
    expect(cachedScores(view.queries).filter((query) => query.state.data !== undefined && query.queryKey[4] === 'lines')).toEqual([]);
  });

  it('shows no score of another person while the rights are checked again after a downgrade from reading the unit to reading only the own score (the detail of a score)', async () => {
    const view = render2({ permissions: ['staff_score.read_unit', 'pwf.read'] }, () => <ScoreDetailScreen route={routeOf('PWF-13')} />, `/pwf/pwf-13?id=${LINE_ID}`);
    expect(await screen.findByText(/Trần Thị Bình/)).toBeTruthy();
    expect(screen.getByTestId('detail')).toBeTruthy();
    // The server has not answered yet under the new rights: nothing read under the old ones stays on the page.
    view.h.read.mockImplementation(() => new Promise(() => undefined));
    await view.change({ permissions: ['staff_score.read_own', 'pwf.read'] });
    expect(screen.queryByText(/Trần Thị Bình/)).toBeNull();
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(screen.queryByText(SECRET.repeat(3))).toBeNull();
    expect(cachedScores(view.queries).filter((query) => query.queryKey[4] === 'line' && query.state.data !== undefined)).toEqual([]);
  });

  it('reads again every time a screen asks: a score is never served stale', async () => {
    const view = render2({}, () => <MyScoreScreen route={routeOf('PWF-11')} />);
    await screen.findByTestId('my-period');
    const mine = cachedScores(view.queries).find((query) => query.queryKey[4] === 'mine');
    expect(mine?.isStale()).toBe(true);
    expect(mine?.options.gcTime).toBe(0);
  });

  it('writes nothing to the storage of the browser while scores are shown', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const view = render2({}, () => <ScoreDetailScreen route={routeOf('PWF-13')} />, `/pwf/pwf-13?id=${LINE_ID}`);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.contribution.showFacts.action') }));
    view.unmount();
    expect(local).not.toHaveBeenCalled();
  });

  it('logs no score, name or response to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    const mine = render2({}, () => <MyScoreScreen route={routeOf('PWF-11')} />);
    await screen.findByTestId('my-period');
    mine.unmount();
    const other = render2({}, () => <ScoreDetailScreen route={routeOf('PWF-13')} />, `/pwf/pwf-13?id=${LINE_ID}`);
    await screen.findByRole('table');
    other.unmount();
    const logged = spies.flatMap((spy) => spy.mock.calls.flat().map((value) => String(value))).join(' ');
    for (const secret of ['82.5', 'Trần Thị Bình', SECRET, 'Nguyễn Văn An']) expect(logged).not.toContain(secret);
  });

  it('is never kept by the service worker: the paths of the scores are never cached', () => {
    for (const path of ['/me/staff-scores', '/staff-score-periods', '/staff-score-periods/1/lines', '/staff-score-periods/1/export', '/staff-score-lines/1', '/staff-score-lines/compare', '/staff-score-adjustments/1/decide', '/staff-score-responses/1/handle', '/v1/staff-score-lines/1']) {
      expect(isNeverCachedPath(path.startsWith('/v1/') ? path : path)).toBe(true);
    }
  });
});
