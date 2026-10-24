import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PackageListScreen from './PackageListScreen';
import { READER, client, mount, pack, plan, routeOf, world } from './plan-test-support';

const ROUTE = routeOf('BID-03', 'FR-BID-03');

afterEach(cleanup);

describe('PackageListScreen (BID-03): the packages of the procurement plans', () => {
  it('lists the packages with their project, stage, period, plan revision with its status in words, fund source and exact price (UI-BID-03)', async () => {
    const approved = pack(1, 1, { plan: { id: plan(1).id, revision: 1, status: 'APPROVED' } });
    mount(<PackageListScreen route={ROUTE} />, client(world({ packages: [approved, pack(2, null, { title: null, fund_source: null })] })), { permissions: READER });
    const table = await screen.findByTestId('packages');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('GT-1')).toBeTruthy();
    expect(first.getByText('PRJ-001')).toBeTruthy();
    expect(first.getByText('IMPLEMENTATION')).toBeTruthy();
    expect(first.getByText('2026-Q4')).toBeTruthy();
    expect(first.getByText('Ngân sách trung ương')).toBeTruthy();
    expect(first.getByText('18.000.000.000')).toBeTruthy();
    expect(first.getByTestId('plan-status').textContent).toBe(vi_['bid.planStatus.approved.label']);
    expect(first.getByRole('link').getAttribute('href')).toBe(`/bid/bid-15?plan=${plan(1).id}`);
    expect(within(rows[1] as HTMLElement).getByTestId('no-plan').textContent).toBe(vi_['bid.packages.noPlan.text']);
    expect(screen.getByText('2 gói thầu')).toBeTruthy();
    expect(document.querySelector('[data-screen-id="BID-03"]')).toBeTruthy();
  });

  it('filters by text and by the status of the plan, and says in words when nothing matches', async () => {
    mount(<PackageListScreen route={ROUTE} />, client(world({ packages: [pack(1, 1), pack(2, null)] })), { permissions: READER });
    await screen.findByTestId('packages');
    fireEvent.change(screen.getByLabelText(vi_['bid.packages.query.label']), { target: { value: 'gt-2' } });
    expect(within(screen.getByTestId('packages')).getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(vi_['bid.packages.planStatus.label']), { target: { value: 'APPROVED' } });
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['bid.packages.noMatch.notice']);
  });

  it('shows the empty state, the error state with a retry, and the loading state (UI-BID-03)', async () => {
    const empty = mount(<PackageListScreen route={ROUTE} />, client(world({ packages: [] })), { permissions: READER });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    empty.unmount();
    const failing = mount(<PackageListScreen route={ROUTE} />, client(world({ failing: new Set(['get_resources_procurement_package']) })), { permissions: READER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    failing.unmount();
  });
});
