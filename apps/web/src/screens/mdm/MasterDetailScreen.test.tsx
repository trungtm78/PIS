import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterDetailScreen from './MasterDetailScreen';
import { READER, STEWARD, change, client, mount, record, routeOf, version, world } from './test-support';

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

  it('AC-ST-MDM-002-2: shows the alias the tenant set on an entry of the platform beside the name of the platform, and says nothing when there is none', async () => {
    const platform = record(1, { namespace: 'PLATFORM', label: 'Ngân sách trung ương', alias_label: 'Vốn NSTW', alias_order: 2 });
    mount(<MasterDetailScreen route={ROUTE} />, client(world({ records: [platform] })), READER, `${AT}&ns=PLATFORM`);
    await ready();
    expect(within(screen.getByTestId('entry')).getByText('Ngân sách trung ương')).toBeTruthy();
    expect(screen.getByTestId('alias').textContent).toBe(vi_['mdm.detail.alias.text'].replace('{label}', 'Vốn NSTW').replace('{order}', '2'));
    cleanup();
    mount(<MasterDetailScreen route={ROUTE} />, client(world({ records: [record(1, { alias_label: 'Chỉ tên', alias_order: null })] })), READER, AT);
    await ready();
    expect(screen.getByTestId('alias').textContent).toBe(vi_['mdm.detail.alias.text'].replace('{label}', 'Chỉ tên').replace('{order}', vi_['mdm.detail.alias.unset']));
    cleanup();
    mount(<MasterDetailScreen route={ROUTE} />, client(world()), READER, AT);
    await ready();
    expect(screen.queryByTestId('alias')).toBeNull();
  });

  it('picks up a draft that was saved and not sent, and submits it after its impact has been read', async () => {
    const draft = change(1, { status: 'DRAFT', version: 1 });
    const state = world({ records: [record(1, { open_change_request_id: draft.id })], changes: [draft] });
    const h = client(state, () => ({ operation_id: 'o', status: 'IN_REVIEW', resource_version: 2, resource_id: draft.id }));
    mount(<MasterDetailScreen route={ROUTE} />, h, STEWARD, AT);
    await ready();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('form', { name: vi_['mdm.impact.step.title'] })).toBeTruthy());
    expect(screen.getByTestId('pending').textContent).toContain(vi_['mdm.detail.draft.notice']);
    await user.click(screen.getByRole('checkbox', { name: vi_['mdm.impact.read.label'] }));
    await user.click(screen.getByRole('button', { name: vi_['mdm.impact.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitMasterChangeRequest', expect.objectContaining({ path: { id: draft.id }, ifMatchVersion: 1 })));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['mdm.impact.step.title'] })).toBeNull());
  });

  it('offers the request again when a reviewer returns it to a draft while the screen stays open', async () => {
    const draft = change(1, { status: 'DRAFT', version: 1 });
    const state = world({ records: [record(1, { open_change_request_id: draft.id })], changes: [draft] });
    const h = client(state, () => {
      state.changes[0] = change(1, { status: 'IN_REVIEW', version: 2 });
      return { operation_id: 'o', status: 'IN_REVIEW', resource_version: 2, resource_id: draft.id };
    });
    const view = mount(<MasterDetailScreen route={ROUTE} />, h, STEWARD, AT);
    await ready();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('form', { name: vi_['mdm.impact.step.title'] })).toBeTruthy());
    await user.click(screen.getByRole('checkbox', { name: vi_['mdm.impact.read.label'] }));
    await user.click(screen.getByRole('button', { name: vi_['mdm.impact.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['mdm.impact.step.title'] })).toBeNull());
    await view.queries.invalidateQueries();
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toContain(vi_['mdm.detail.pending.notice']));
    expect(screen.queryByRole('form', { name: vi_['mdm.impact.step.title'] })).toBeNull();
    // The reviewer returns it: a draft again, with a new version.
    state.changes[0] = change(1, { status: 'DRAFT', version: 3 });
    await view.queries.invalidateQueries();
    await waitFor(() => expect(screen.getByRole('form', { name: vi_['mdm.impact.step.title'] })).toBeTruthy());
    expect(screen.getByTestId('pending').textContent).toContain(vi_['mdm.detail.draft.notice']);
  });

  it('does not offer to submit a request that is already with the reviewers, or to someone who may not propose', async () => {
    const waiting = change(1, { status: 'IN_REVIEW' });
    mount(<MasterDetailScreen route={ROUTE} />, client(world({ records: [record(1, { open_change_request_id: waiting.id })], changes: [waiting] })), STEWARD, AT);
    await ready();
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toContain(vi_['mdm.detail.pending.notice']));
    expect(screen.queryByRole('form', { name: vi_['mdm.impact.step.title'] })).toBeNull();
    cleanup();
    const draft = change(1, { status: 'DRAFT', version: 1 });
    mount(<MasterDetailScreen route={ROUTE} />, client(world({ records: [record(1, { open_change_request_id: draft.id })], changes: [draft] })), READER, AT);
    await ready();
    await waitFor(() => expect(screen.getByRole('form', { name: vi_['mdm.impact.step.title'] })).toBeTruthy());
    expect(screen.queryByRole('button', { name: vi_['mdm.impact.submit.action'] })).toBeNull();
  });

  it('opens the entry of the platform that the address names, not the entry of the tenant with the same key', async () => {
    const state = world({ records: [record(1, { label: 'Của tenant' }), record(1, { namespace: 'PLATFORM', label: 'Của nền tảng' })] });
    mount(<MasterDetailScreen route={ROUTE} />, client(state), STEWARD, `${AT}&ns=PLATFORM`);
    await ready();
    expect(within(screen.getByTestId('entry')).getByText('Của nền tảng')).toBeTruthy();
    expect(screen.getByText(vi_['mdm.detail.history.action']).getAttribute('href')).toBe('/mdm/mdm-28?type=SECTOR&key=GT-1&ns=PLATFORM');
    cleanup();
    mount(<MasterDetailScreen route={ROUTE} />, client(state), STEWARD, AT);
    await ready();
    expect(within(screen.getByTestId('entry')).getByText('Của tenant')).toBeTruthy();
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
