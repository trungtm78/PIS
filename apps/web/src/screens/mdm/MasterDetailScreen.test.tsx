import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterDetailScreen from './MasterDetailScreen';
import { READER, STEWARD, client, mount, record, routeOf, version, world } from './test-support';

const ROUTE = routeOf('MDM-27', 'FR-MDM-27');
const AT = '/mdm/mdm-27?type=SECTOR&key=GT-1';

afterEach(cleanup);

const ready = () => waitFor(() => expect(screen.getByTestId('entry')).toBeTruthy());

describe('MasterDetailScreen (MDM-27)', () => {
  it('shows the entry with the version in force, its attributes and the places that use it', async () => {
    const state = world({
      versions: [version(1, 2, { legal_basis: 'Decision 12', attributes: { group: 'transport', rank: 2 } })],
      usage: { master_record_id: record(1).id, as_of: null, counts: { 'project.sector_master_version_id': 2, 'contractor.master_record_id': 1 }, total: 3, samples: [{ reference: 'project.sector_master_version_id', id: 'p-1' }] },
    });
    mount(<MasterDetailScreen route={ROUTE} />, client(state), READER, AT);
    await ready();
    const entry = within(screen.getByTestId('entry'));
    expect(entry.getByText('GT-1')).toBeTruthy();
    expect(entry.getByText('Giao thông 1')).toBeTruthy();
    expect(entry.getByText(vi_['mdm.status.record.effective'])).toBeTruthy();
    expect(entry.getByText(`2024-01-01 → ${vi_['mdm.detail.validity.open']}`)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Decision 12')).toBeTruthy());
    expect(entry.getByText('#2')).toBeTruthy();
    const attributes = within(screen.getByTestId('attributes'));
    expect(attributes.getByText('group').closest('tr')?.textContent).toContain('transport');
    expect(attributes.getByText('rank').closest('tr')?.textContent).toContain('2');
    await waitFor(() => expect(screen.getByTestId('impact').getAttribute('data-impact-total')).toBe('3'));
    expect(document.querySelector('[data-reference="project.sector_master_version_id"]')?.textContent).toContain('2');
    expect(within(screen.getByTestId('samples')).getByText('p-1', { exact: false })).toBeTruthy();
  });

  it('says so when nothing refers to the entry, and when the places cannot be read', async () => {
    mount(<MasterDetailScreen route={ROUTE} />, client(world()), READER, AT);
    await waitFor(() => expect(screen.getByText(vi_['mdm.impact.none.text'])).toBeTruthy());
    cleanup();
    mount(<MasterDetailScreen route={ROUTE} />, client(world({ failing: new Set(['getMasterRecordUsages']) })), READER, AT);
    expect((await screen.findByText(vi_['mdm.detail.usage.error'])).closest('[role="alert"]')).not.toBeNull();
  });

  it('offers the change only to someone who may propose, on an entry in force that has no request open', async () => {
    mount(<MasterDetailScreen route={ROUTE} />, client(world()), STEWARD, AT);
    await ready();
    expect(screen.getByText(vi_['mdm.detail.edit.action']).getAttribute('href')).toBe('/mdm/mdm-26?type=SECTOR&key=GT-1');
    expect(screen.getByText(vi_['mdm.detail.history.action']).getAttribute('href')).toBe('/mdm/mdm-28?type=SECTOR&key=GT-1');
    cleanup();
    mount(<MasterDetailScreen route={ROUTE} />, client(world()), READER, AT);
    await ready();
    expect(screen.queryByText(vi_['mdm.detail.edit.action'])).toBeNull();
    cleanup();
    mount(<MasterDetailScreen route={ROUTE} />, client(world({ records: [record(1, { open_change_request_id: 'c1' })] })), STEWARD, AT);
    await ready();
    expect(screen.queryByText(vi_['mdm.detail.edit.action'])).toBeNull();
    expect(screen.getByTestId('pending').textContent).toContain(vi_['mdm.detail.pending.notice']);
  });

  it('does not offer the change on an entry that is retired', async () => {
    mount(<MasterDetailScreen route={ROUTE} />, client(world({ records: [record(1, { status: 'RETIRED' })] })), STEWARD, AT);
    await ready();
    expect(screen.queryByText(vi_['mdm.detail.edit.action'])).toBeNull();
    expect(screen.getByText(vi_['mdm.status.record.retired'])).toBeTruthy();
  });

  it('says that no entry is chosen, or that it does not exist', async () => {
    mount(<MasterDetailScreen route={ROUTE} />, client(world()), READER, '/mdm/mdm-27');
    expect(await screen.findByTestId('no-record')).toBeTruthy();
    cleanup();
    mount(<MasterDetailScreen route={ROUTE} />, client(world()), READER, '/mdm/mdm-27?type=SECTOR&key=NOPE');
    expect(await screen.findByTestId('no-record')).toBeTruthy();
  });

  it('shows the error state when the entry cannot be read', async () => {
    mount(<MasterDetailScreen route={ROUTE} />, client(world({ failing: new Set(['searchMasterRecords']) })), READER, AT);
    expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
  });
});
