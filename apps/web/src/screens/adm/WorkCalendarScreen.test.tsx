import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { routeOf } from '../doc/test-support';
import { harness, mountInSession } from './security/test-support';
import WorkCalendarScreen from './WorkCalendarScreen';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-07', 'FR-ADM-07');
const MANAGER = ['adm.calendar.manage', 'adm.calendar.read'];

const row = (id: string, year: number, status: string) => ({
  id,
  calendar_code: 'VN-STD',
  year,
  revision: 1,
  working_days: [1, 2, 3, 4, 5],
  holidays: [{ date: `${year}-05-01`, name: 'Labour Day' }],
  compensated_workdays: [],
  legal_basis_ref: 'Labour Code 2019 art. 112',
  status,
  created_by: 'u1',
  published_by: status === 'Draft' ? null : 'u2',
  published_at: status === 'Draft' ? null : '2026-04-01T00:00:00Z',
  version: status === 'Draft' ? 1 : 2,
});

function withReads(readAll: (operation: string) => Promise<unknown[]>) {
  const h = harness(() => new Error('no read'));
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = readAll;
  return h;
}

afterEach(cleanup);

describe('WorkCalendarScreen (ADM-07)', () => {
  it('reads the versions of the tenant and shows them with the month grids of the one in force (AC-ST-ADM-010-3)', async () => {
    const h = withReads((operation) => (operation === 'get_resources_work_calendar_version' ? Promise.resolve([row('c2', 2027, 'Draft'), row('c1', 2026, 'Published')]) : Promise.reject(new Error('unexpected read'))));
    mountInSession(<WorkCalendarScreen route={ROUTE} />, h, { permissions: MANAGER });
    expect(await screen.findByTestId('version-in-view')).toBeTruthy();
    expect(document.querySelectorAll('[data-calendar-id][data-status]')).toHaveLength(2);
    expect(screen.getByTestId('version-in-view').getAttribute('data-calendar-id')).toBe('c1');
  });

  it('shows the loading state while the versions are read', () => {
    mountInSession(<WorkCalendarScreen route={ROUTE} />, withReads(() => new Promise(() => undefined)), { permissions: MANAGER });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('still offers the form to a tenant with no calendar: an empty register is not an empty screen', async () => {
    mountInSession(<WorkCalendarScreen route={ROUTE} />, withReads(() => Promise.resolve([])), { permissions: MANAGER });
    expect(await screen.findByText(vi_['adm.calendar.versions.empty'])).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['adm.calendar.draft.submit.action'] })).toBeTruthy();
  });

  it.each([
    ['denied', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), 'states.denied.title'],
    ['signedOut', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), 'states.signedOut.title'],
    ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), 'states.offline.title'],
    ['error', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), 'states.error.title'],
  ] as const)('shows the %s state when the versions cannot be read', async (_state, failure, key) => {
    mountInSession(<WorkCalendarScreen route={ROUTE} />, withReads(() => Promise.reject(failure)), { permissions: MANAGER });
    expect(await screen.findByText(vi_[key])).toBeTruthy();
  });

  it('reads again when the person retries after a failure', async () => {
    let calls = 0;
    const h = withReads(() => (++calls === 1 ? Promise.reject(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })) : Promise.resolve([row('c1', 2026, 'Published')])));
    mountInSession(<WorkCalendarScreen route={ROUTE} />, h, { permissions: MANAGER });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(screen.getByTestId('version-in-view')).toBeTruthy());
    expect(calls).toBe(2);
  });
});
