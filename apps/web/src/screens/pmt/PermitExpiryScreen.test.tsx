import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PermitExpiryScreen from './PermitExpiryScreen';
import { client, mount, permitId, projectId, world } from './dossier-test-support';
import type { World } from './dossier-test-support';
import { routeOf } from './test-support';

const ROUTE = routeOf('PMT-05', 'FR-PMT-05');
const READER = ['permit.read'];

afterEach(cleanup);

const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: permitId(n),
  dossier_id: `00000000-0000-4000-8000-0101${String(n).padStart(8, '0')}`,
  permit_type_code: `PERMIT_${n}`,
  permit_type_name: `Giấy phép ${n}`,
  permit_no: `GP-00${n}/2026`,
  status: 'ISSUED',
  valid_until: '2026-11-20',
  days_left: 27,
  alert_level: 2,
  alert_threshold_days: 30,
  project: { id: projectId(n), code: `DA-2026-00${n}`, name: `Dự án số ${n}` },
  responsible: { membership_id: '00000000-0000-4000-8000-000000000001', display_name: 'Nguyễn Văn A' },
  version: 1,
  ...overrides,
});

/** The board of the day: a permit past its last day, one on its last day, one 10 days away, one 27 days away and one 100 days away. */
function board(): World {
  const rows = [
    row(1, { status: 'EXPIRED', valid_until: '2026-10-14', days_left: -10, alert_level: 4, alert_threshold_days: 0 }),
    row(2, { valid_until: '2026-10-24', days_left: 0, alert_level: 4, alert_threshold_days: 0 }),
    row(3, { valid_until: '2026-11-03', days_left: 10, alert_level: 3, alert_threshold_days: 15 }),
    row(4),
    row(5, { valid_until: '2027-02-01', days_left: 100, alert_level: 0, alert_threshold_days: null, responsible: null, permit_no: null, permit_type_code: null }),
  ];
  return world({ expiring: (query) => (query.within_days === 365 ? [...rows, row(6, { valid_until: '2027-09-01', days_left: 311, alert_level: 0, alert_threshold_days: null })] : rows) });
}

const open = (state: World, options: { permissions?: readonly string[] | undefined; path?: string } = {}) => {
  const h = client(state);
  mount(<PermitExpiryScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, ...(options.path === undefined ? {} : { path: options.path }) });
  return h;
};
const ready = () => waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
const rowOf = (n: number): HTMLElement => document.querySelector(`[data-permit-id="${permitId(n)}"]`) as HTMLElement;

describe('PermitExpiryScreen (PMT-05): the permits that run out', () => {
  it('lists the permits within the 60-day window and the expired ones that wait for a renewal, with how many days are left and the level of alert (AC-ST-PMT-006-1)', async () => {
    const h = open(board());
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pmt.expiry.page.title']);
    expect(h.client.readAll).toHaveBeenCalledWith('listExpiringPermits', { query: { within_days: 60 } });
    expect(Array.from(document.querySelectorAll('tbody tr')).map((tr) => tr.getAttribute('data-urgency'))).toEqual(['EXPIRED', 'LAST_DAY', 'SOON', 'AHEAD', 'AHEAD']);
    // Past its day: how long ago, and a way to renew it.
    expect(within(rowOf(1)).getByTestId('left').textContent).toBe('Quá hạn 10 ngày');
    expect(within(rowOf(1)).getByTestId('level').textContent).toBe(vi_['pmt.expiry.level.expired']);
    expect(within(rowOf(1)).getByTestId('open-permit').textContent).toBe(vi_['pmt.expiry.renew.action']);
    expect(within(rowOf(1)).getByTestId('open-permit').getAttribute('href')).toBe(`/pmt/pmt-02?permit=${permitId(1)}`);
    // The last day, and 15 / 30 days.
    expect(within(rowOf(2)).getByTestId('level').textContent).toBe(vi_['pmt.expiry.level.lastDay']);
    expect(within(rowOf(2)).getByTestId('left').textContent).toBe('0');
    expect(within(rowOf(3)).getByTestId('level').textContent).toBe('Còn 15 ngày');
    expect(within(rowOf(4)).getByTestId('level').textContent).toBe('Còn 30 ngày');
    expect(within(rowOf(4)).getByTestId('left').textContent).toBe('27');
    expect(within(rowOf(4)).getByTestId('open-permit').textContent).toBe(vi_['pmt.expiry.open.action']);
    // A permit not at a threshold yet, with no number, no code and no one in charge.
    expect(within(rowOf(5)).getByTestId('level').textContent).toBe(vi_['pmt.expiry.level.none']);
    expect(rowOf(5).querySelector('th')?.textContent).toBe('Giấy phép 5 ');
    expect(rowOf(5).textContent).toContain(vi_['pmt.expiry.owner.none']);
    expect(rowOf(4).textContent).toContain('GP-004/2026');
    expect(rowOf(4).textContent).toContain('Nguyễn Văn A');
    expect(rowOf(4).textContent).toContain('DA-2026-004');
    expect(screen.getByTestId('summary').textContent).toBe('4 giấy phép sắp hết hạn, 1 đã hết hạn chưa được thay.');
    expect(screen.getByTestId('no-renewal').textContent).toBe(vi_['pmt.expiry.note.noRenewal']);
  });

  it('reads the window the person picks, and the window of the address', async () => {
    const h = open(board());
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['pmt.expiry.window.label']), { target: { value: '365' } });
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(6));
    expect(h.client.readAll).toHaveBeenLastCalledWith('listExpiringPermits', { query: { within_days: 365 } });
    fireEvent.change(screen.getByLabelText(vi_['pmt.expiry.window.label']), { target: { value: '60' } });
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(5));
    cleanup();

    const again = open(board(), { path: '/?days=30' });
    await ready();
    expect(again.client.readAll).toHaveBeenCalledWith('listExpiringPermits', { query: { within_days: 30 } });
    expect((screen.getByLabelText(vi_['pmt.expiry.window.label']) as HTMLSelectElement).value).toBe('30');
    cleanup();
    // A window the board does not offer falls back to the default.
    const odd = open(board(), { path: '/?days=7' });
    await ready();
    expect(odd.client.readAll).toHaveBeenCalledWith('listExpiringPermits', { query: { within_days: 60 } });
  });

  it('says so when nothing runs out, and keeps the window to change', async () => {
    open(world({ expiring: () => [] }));
    await waitFor(() => expect(screen.getByTestId('nothing')).toBeTruthy());
    expect(screen.getByTestId('nothing').textContent).toBe('Không có giấy phép nào hết hạn trong 60 ngày tới.');
    expect(screen.getByLabelText(vi_['pmt.expiry.window.label'])).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('leaves out an answer that is not a permit of the board', async () => {
    open(world({ expiring: () => [row(1), { id: 'x' }, row(2, { status: 'PLANNED' }), row(3, { alert_level: 9 })] }));
    await ready();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('shows the error state when the read fails', async () => {
    const failing = world({ expiring: () => [] });
    failing.failing.add('listExpiringPermits');
    open(failing);
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });
});
