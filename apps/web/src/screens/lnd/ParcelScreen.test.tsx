import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ParcelScreen from './ParcelScreen';
import { DOCUMENT, OFFICER, OTHER_PROJECT, PROJECT, READER, client, deadline, mount, parcel, routeOf, world } from './test-support';

const ROUTE = routeOf('LND-02', 'FR-LND-02');
const OK = { operation_id: 'o', status: 'SURVEYED', resource_version: 2, resource_id: parcel(1).id };
const PATH = `/lnd/lnd-02?project=${PROJECT}`;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const worldOf = () =>
  world({
    parcels: [
      parcel(1),
      parcel(2, { land_use_group: 'NON_AGRICULTURAL_RESIDENTIAL', owner_unit_name: 'Trung tâm phát triển quỹ đất', address_text: null, status: 'DISPUTED' }),
      parcel(3, { recovery_notice_on: '2026-07-01', notice_days_applied: 90, deadline: deadline(), status: 'PLAN_DRAFTED' }),
      parcel(4, { recovery_notice_on: '2026-01-01', notice_days_applied: 90, status: 'PAID', deadline: deadline({ status: 'SATISFIED', satisfied_on: '2026-04-05', due_on: '2026-04-01', started_on: '2026-01-01', awaiting_confirmation: false }) }),
    ],
  });
/** The code of the parcel is marked in its cell; the row is the table row around it. */
const rowOf = (n: number): HTMLElement => (document.querySelector(`[data-parcel-id="${parcel(n).id}"]`) as HTMLElement).closest('tr') as HTMLElement;
const ready = () => screen.findByTestId('parcels');

describe('ParcelScreen (LND-02): the parcels of a project and the notice of recovery', () => {
  it('UI-LND-02: asks for a project first and lists the parcels of the one chosen', async () => {
    const h = client(worldOf());
    mount(<ParcelScreen route={ROUTE} />, h, { permissions: OFFICER, path: '/lnd/lnd-02' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(vi_['lnd.parcels.project.notice']);
    expect(screen.queryByTestId('parcels')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['lnd.parcels.create.action'] })).toBeNull();
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcels.project.label']), { target: { value: PROJECT } });
    await ready();
    expect(Array.from(document.querySelectorAll('[data-parcel-id]'))).toHaveLength(4);
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcels.project.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-project')).toBeTruthy();
  });

  it('AC-ST-LND-001-2, UI-LND-02: shows the code, the unit, the land use, the areas and the notice of a parcel, and has no column for a person', async () => {
    mount(<ParcelScreen route={ROUTE} />, client(worldOf()), { permissions: OFFICER, path: PATH });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['lnd.parcels.page.title']);
    expect(screen.getByTestId('privacy-note').textContent).toBe(vi_['lnd.parcels.privacy.note']);
    const headers = Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent);
    expect(headers).toEqual([
      vi_['lnd.parcels.column.code'],
      vi_['lnd.parcels.column.unit'],
      vi_['lnd.parcels.column.landUse'],
      vi_['lnd.parcels.column.area'],
      vi_['lnd.parcels.column.affected'],
      vi_['lnd.parcels.column.notice'],
      vi_['lnd.parcels.column.status'],
      vi_['lnd.parcels.column.action'],
    ]);
    expect(rowOf(1).querySelector('td')?.textContent).toBe('TB-1/10');
    expect(within(rowOf(1)).getByText('UBND xã An Phú')).toBeTruthy();
    expect(within(rowOf(1)).getByText(vi_['lnd.landUse.agricultural.label'])).toBeTruthy();
    expect(within(rowOf(1)).getByTestId('notice').textContent).toBe(vi_['lnd.notice.none.label']);
    expect(within(rowOf(2)).getByText(vi_['lnd.landUse.nonAgriculturalResidential.label'])).toBeTruthy();
    expect(within(rowOf(2)).getByTestId('status').textContent).toBe(vi_['lnd.parcelStatus.disputed.label']);
  });

  it('AC-ST-LND-001-1: says the notice date, the days, the day it falls due, the rule and its legal basis, and that the rule waits for its confirmation', async () => {
    mount(<ParcelScreen route={ROUTE} />, client(worldOf()), { permissions: OFFICER, path: PATH });
    await ready();
    const row = rowOf(3);
    expect(within(row).getByTestId('notice').textContent).toContain(vi_['lnd.parcels.notice.line'].replace('{on}', '2026-07-01').replace('{days}', '90').replace('{due}', '2026-09-29'));
    expect(within(row).getByTestId('notice-basis').textContent).toContain(vi_['lnd.timer.noticeAgricultural90.label']);
    expect(within(row).getByTestId('notice-basis').textContent).toContain('CXN-12');
    expect(within(row).getByTestId('notice-awaiting').textContent).toBe(vi_['lnd.parcels.notice.awaiting'].replace('{cxn}', 'CXN-12'));
    expect(within(row).getByTestId('notice-state').textContent).toBeTruthy();
    const ended = rowOf(4);
    expect(within(ended).getByTestId('notice-state').textContent).toBe(vi_['lnd.notice.satisfied.label']);
    expect(within(ended).queryByTestId('notice-awaiting')).toBeNull();
  });

  it('filters by a word, by status and by section, and says when nothing matches', async () => {
    mount(<ParcelScreen route={ROUTE} />, client(worldOf()), { permissions: OFFICER, path: PATH });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcels.query.label']), { target: { value: 'quỹ đất' } });
    expect(Array.from(document.querySelectorAll('[data-parcel-id]'))).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcels.query.label']), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcels.status.label']), { target: { value: 'PAID' } });
    expect(Array.from(document.querySelectorAll('[data-parcel-id]')).map((tr) => tr.getAttribute('data-parcel-id'))).toEqual([parcel(4).id]);
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcels.status.label']), { target: { value: '' } });
    await screen.findByRole('option', { name: 'KM-0-3' });
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcels.section.label'], { selector: 'select' }), { target: { value: '00000000-0000-4000-8000-000300000001' } });
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['lnd.parcels.noMatch.notice']);
  });

  it('says so when the project has no parcel yet, and when the read fails it offers a retry', async () => {
    const empty = world({ parcels: [] });
    mount(<ParcelScreen route={ROUTE} />, client(empty), { permissions: OFFICER, path: PATH });
    expect((await screen.findByTestId('no-match')).textContent).toBe(vi_['lnd.parcels.empty.notice']);
    cleanup();
    const broken = worldOf();
    broken.failing.add('listLandParcels');
    mount(<ParcelScreen route={ROUTE} />, client(broken), { permissions: OFFICER, path: PATH });
    expect(await screen.findByRole('button', { name: /thử lại|retry/i })).toBeTruthy();
  });

  it('AC-ST-LND-001-1: records the notice of a parcel that has none, under its version, and offers it for no other', async () => {
    const h = client(worldOf(), () => OK);
    mount(<ParcelScreen route={ROUTE} />, h, { permissions: OFFICER, path: PATH });
    await ready();
    expect(within(rowOf(3)).queryByRole('button')).toBeNull();
    expect(within(rowOf(4)).queryByRole('button')).toBeNull();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.parcels.notice.aria'].replace('{code}', 'TB-1/10') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.noticeDialog.date.label']), { target: { value: '2026-07-01' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.noticeDialog.document.label']), { target: { value: DOCUMENT } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('recordRecoveryNotice', expect.objectContaining({ path: { id: parcel(1).id }, ifMatchVersion: 1, body: { notice_on: '2026-07-01', notice_document_version_id: DOCUMENT } }));
  });

  it('declares a parcel and creates a section for the project that is open', async () => {
    const h = client(worldOf(), () => OK);
    mount(<ParcelScreen route={ROUTE} />, h, { permissions: OFFICER, path: PATH });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.parcels.create.action'] }));
    expect(within(screen.getByRole('dialog')).getByLabelText(vi_['lnd.parcelDialog.unit.label'])).toBeTruthy();
    await screen.findByRole('option', { name: 'Trung tâm phát triển quỹ đất' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: vi_['lnd.dialog.cancel.action'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.parcels.section.action'] }));
    expect(within(screen.getByRole('dialog')).getByLabelText(vi_['lnd.sectionDialog.code.label'])).toBeTruthy();
  });

  it('shows a reader the parcels and no button to change them; a read-only session too', async () => {
    mount(<ParcelScreen route={ROUTE} />, client(worldOf()), { permissions: READER, path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.parcels.create.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['lnd.parcels.section.action'] })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('import-denied')).toBeTruthy();
    cleanup();
    mount(<ParcelScreen route={ROUTE} />, client(worldOf()), { permissions: OFFICER, mode: 'READ_ONLY', path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.parcels.create.action'] })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button')).toBeNull();
  });

  it('starts over when the project in the address is another one', async () => {
    const state = worldOf();
    state.parcels.push(parcel(9, { project_id: OTHER_PROJECT }));
    mount(<ParcelScreen route={ROUTE} />, client(state), { permissions: OFFICER, path: `/lnd/lnd-02?project=${OTHER_PROJECT}` });
    await ready();
    expect(Array.from(document.querySelectorAll('[data-parcel-id]')).map((tr) => tr.getAttribute('data-parcel-id'))).toEqual([parcel(9).id]);
  });
});
