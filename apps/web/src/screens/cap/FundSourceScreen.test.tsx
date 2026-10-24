import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import FundSourceScreen from './FundSourceScreen';
import { ODA, READER, client, line, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('CAP-04', 'FR-CAP-04');

afterEach(cleanup);

const ready = () => waitFor(() => expect(screen.getByTestId('tree')).toBeTruthy());
const category = (key: string): HTMLElement => document.querySelector(`[data-category="${key}"]`) as HTMLElement;

describe('FundSourceScreen (CAP-04): the tree of the fund sources', () => {
  it('draws the categories with the fund sources, their validity and the capital published by origin, and adds only the published lines (UI-CAP-04)', async () => {
    mount(<FundSourceScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.fund.page.title']);
    expect(Array.from(document.querySelectorAll('[data-category]')).map((node) => node.getAttribute('data-category'))).toEqual(['NSTW', 'NSDP']);
    // NSTW: the Prime Minister assigned 10,000 and the central support 20,000 are both on the source, apart from one another.
    const nstw = category('NSTW');
    expect(within(nstw).getByText(vi_['cap.category.nstw.label'])).toBeTruthy();
    expect(Array.from(nstw.querySelectorAll('[data-appropriation-id]')).map((node) => node.getAttribute('data-appropriation-id'))).toEqual([line(1).id, line(3).id]);
    expect(nstw.querySelector('summary')?.textContent).toContain('30.000');
    expect(within(nstw).getByText(`${vi_['cap.fund.validity.open'].replace('{from}', '2020-01-01')}`)).toBeTruthy();
    expect(category('NSDP').querySelector('summary')?.textContent).toContain('19.000');
    expect(screen.getByTestId('grand-total').textContent).toContain('49.000');
    // The programme of national targets is part of its parent: the screen says so and gives it no total.
    expect(screen.getByRole('note').textContent).toBe(vi_['cap.fund.ctmtqg.note']);
    expect(category('CTMTQG')).toBeNull();
  });

  it('shows ODA with its validity and whether it is on-lent, in words', async () => {
    const published = line(6, { fund_source: ODA, amount_vnd: '5000000000', allocated_total_vnd: '0', remaining_vnd: '5000000000' });
    mount(<FundSourceScreen route={ROUTE} />, client(world({ lines: [published] })), { permissions: READER });
    await ready();
    const oda = category('ODA');
    expect(within(oda).getByTestId('onlending').textContent).toBe(vi_['cap.fund.oda.lent.label']);
    expect(within(oda).getByText(vi_['cap.fund.validity.range'].replace('{from}', '2020-01-01').replace('{until}', '2030-12-31'))).toBeTruthy();
    cleanup();
    const grant = line(7, { fund_source: { ...ODA, onlending: false } });
    mount(<FundSourceScreen route={ROUTE} />, client(world({ lines: [grant] })), { permissions: READER });
    await ready();
    expect(within(category('ODA')).getByTestId('onlending').textContent).toBe(vi_['cap.fund.oda.grant.label']);
  });

  it('counts nothing for a draft: a register that has only drafts is empty here', async () => {
    mount(<FundSourceScreen route={ROUTE} />, client(world({ lines: [line(1, { status: 'DRAFT', version: 1 })] })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
  });

  it('shows the standard states: empty, denied and failed', async () => {
    mount(<FundSourceScreen route={ROUTE} />, client(world({ lines: [] })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
    cleanup();
    const denied = new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', detail: undefined, extensions: {} });
    mount(<FundSourceScreen route={ROUTE} />, client(world({ failing: new Map([['listAppropriations', denied]]) })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    cleanup();
    mount(<FundSourceScreen route={ROUTE} />, client(world({ failing: new Map([['listAppropriations', new Error('boom')]]) })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });

  it('links to the book of the appropriations', async () => {
    mount(<FundSourceScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.getByRole('link', { name: vi_['cap.fund.book.link'] }).getAttribute('href')).toBe('/cap/cap-16');
  });
});
