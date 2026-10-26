import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { READER, client, detailRecord, mount, overviewRecord, rateRecord, routeOf, world } from '../test-support';
import OverviewScreen from './OverviewScreen';

const ROUTE = routeOf('AUD-01', 'FR-AUD-01');
const ID = detailRecord(1).id as string;

afterEach(cleanup);

const open = (overview: Record<string, unknown> | undefined = overviewRecord()) => {
  mount(<OverviewScreen route={ROUTE} />, client(world({ overview })), { permissions: READER, path: '/aud/aud-01' });
};

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';

describe('AUD-01 overview of inspections and audits', () => {
  it('shows the engagements being worked, what is open and overdue, the money and the two rates with their numerators and denominators (UI-AUD-01)', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['aud.overview.page.title'] })).toBeTruthy();
    await screen.findByTestId('tiles');
    expect(text('tile-engagements')).toContain('5');
    expect(text('tile-engagements')).toContain(vi_['aud.overview.tile.engagements.parts'].replace('{ongoing}', '2').replace('{followUp}', '3'));
    expect(within(screen.getByTestId('tile-open')).getByText('7')).toBeTruthy();
    expect(within(screen.getByTestId('tile-overdue')).getByText('2')).toBeTruthy();
    expect(text('tile-money')).toContain('1.250.000.000');
    expect(text('tile-money')).toContain(vi_['aud.overview.tile.money.parts'].replace('{recovered}', '500.000.000').replace('{remaining}', '750.000.000'));
    expect(text('overview-rate-money')).toBe(`40,00% ${vi_['aud.recovery.rate.parts'].replace('{numerator}', '500.000.000').replace('{denominator}', '1.250.000.000')}`);
    expect(text('overview-rate-count')).toBe(`12,50% ${vi_['aud.recovery.rate.parts'].replace('{numerator}', '1').replace('{denominator}', '8')}`);
    expect(screen.getByTestId('confidential-note').textContent).toBe(vi_['aud.overview.confidential.note']);
    expect(screen.queryByTestId('exceptions-note')).toBeNull();
  });

  it('names the engagements of the watch list with what is open and overdue in each, its money and links to its file and its ledger', async () => {
    open();
    await screen.findByTestId('tiles');
    const rows = Array.from(document.querySelectorAll('tr[data-engagement-id]')).map((row) => within(row as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([['TTCP-2026-001Thanh tra đầu tư cầu số 1', vi_['aud.engagementStatus.followUp'], '4', '2', '800.000.000', '500.000.000', `${vi_['aud.overview.watch.open.link']}${vi_['aud.overview.watch.recovery.link']}`]]);
    expect(screen.getByRole('link', { name: vi_['aud.overview.watch.open.link'] }).getAttribute('href')).toBe(`/aud/aud-03?engagement=${ID}`);
    expect(screen.getByRole('link', { name: vi_['aud.overview.watch.recovery.link'] }).getAttribute('href')).toBe(`/aud/aud-08?engagement=${ID}`);
    expect(screen.getByRole('link', { name: vi_['aud.overview.engagements.link'] }).getAttribute('href')).toBe('/aud/aud-02');
  });

  it('says a rate is not applicable, never 0 percent, and the watch list is empty in words, when there is nothing in the scope', async () => {
    open(overviewRecord({ engagements: [], amount_vnd: '0', recovered_vnd: '0', remaining_vnd: '0', money_rate: rateRecord('0', '0', null), count_rate: rateRecord('0', '0', null), recommendations_open: 0, recommendations_overdue: 0 }));
    await screen.findByTestId('tiles');
    expect(text('overview-rate-money')).toContain(vi_['aud.recovery.rate.na']);
    expect(screen.getByTestId('no-engagements').textContent).toBe(vi_['aud.overview.watch.none']);
  });

  it('tells how many recoveries of PAY wait for the accountant, in words, when there are any', async () => {
    open(overviewRecord({ exceptions_open: 3 }));
    expect((await screen.findByTestId('exceptions-note')).textContent).toBe(vi_['aud.overview.exceptions.note'].replace('{count}', '3'));
    expect(screen.getByTestId('exceptions-note').getAttribute('role')).toBe('status');
  });

  describe('the seven states', () => {
    it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
      mount(<OverviewScreen route={ROUTE} />, client(world({ overview: overviewRecord() })), { permissions: READER, path: '/aud/aud-01' });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByTestId('tiles')).toBeTruthy();
      cleanup();
      const failing = (error: Error) => {
        const state = world({ overview: overviewRecord() });
        state.failing.set('getAuditOverview', error);
        return client(state);
      };
      mount(<OverviewScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER, path: '/aud/aud-01' });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mount(<OverviewScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER, path: '/aud/aud-01' });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mount(<OverviewScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER, path: '/aud/aud-01' });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<OverviewScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER, path: '/aud/aud-01' });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });
});
