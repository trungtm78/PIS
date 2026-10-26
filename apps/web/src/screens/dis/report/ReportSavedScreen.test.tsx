import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { MAKER, REPORT, client, mount, reportRecord, routeOf, world } from './test-support';
import ReportSavedScreen from './ReportSavedScreen';

const ROUTE = routeOf('DIS-18', 'FR-DIS-18');
const PATH = `/dis/dis-18?report=${REPORT}`;

afterEach(cleanup);

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';

describe('DIS-18 draft saved', () => {
  it('AC-ST-DIS-003-5 / UI-DIS-04: gives the code of the draft, the period, the project and what it adds up to, and moves the focus to the heading', async () => {
    mount(<ReportSavedScreen route={ROUTE} />, client(world({ details: { [REPORT]: reportRecord() } })), { permissions: MAKER, path: PATH });
    const heading = await screen.findByRole('heading', { level: 1, name: vi_['dis.reportSaved.page.title'] });
    await screen.findByTestId('saved-code');
    expect(document.activeElement).toBe(heading);
    expect(text('saved-note')).toBe(vi_['dis.reportSaved.note']);
    expect(text('saved-code')).toBe('DA-2027-001/2027-W01/r1');
    expect(text('saved-period')).toBe(vi_['dis.reportEdit.period.value'].replace('{code}', '2027-W01').replace('{start}', '2027-01-04').replace('{end}', '2027-01-10'));
    expect(text('saved-project')).toBe('DA-2027-001 · Cầu qua sông');
    expect(text('saved-total')).toBe(vi_['dis.reportSaved.total.value'].replace('{amount}', '420.000.000').replace('{ctmtqg}', '40.000.000'));
    expect(screen.getByRole('link', { name: vi_['dis.reportSaved.continue.link'] }).getAttribute('href')).toBe(`/dis/dis-04?report=${REPORT}`);
    // The link above the title and the one among the next steps lead to the same list.
    expect(screen.getAllByRole('link', { name: vi_['dis.reportSaved.list.link'] }).map((link) => link.getAttribute('href'))).toEqual(['/dis/dis-01', '/dis/dis-01']);
  });

  it('asks to open a report from the list when none is chosen, and shows the empty state for one that is not found', async () => {
    mount(<ReportSavedScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: '/dis/dis-18' });
    expect((await screen.findByTestId('saved-choose')).textContent).toBe(vi_['dis.reportSaved.choose.text']);
    cleanup();
    mount(<ReportSavedScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
    const failing = (error: Error) => {
      const state = world({ details: { [REPORT]: reportRecord() } });
      state.failing.set('getReportRevision', error);
      return client(state);
    };
    mount(<ReportSavedScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<ReportSavedScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    mount(<ReportSavedScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    mount(<ReportSavedScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});
