import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterEditScreen from './MasterEditScreen';
import { READER, STEWARD, change, client, mount, record, routeOf, version, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('MDM-26', 'FR-MDM-26');
const AT = '/mdm/mdm-26?type=SECTOR&key=GT-1';
const OPENED = change(1, { change_kind: 'UPDATE', status: 'DRAFT', version: 1, created_by: '00000000-0000-4000-8000-0000000000e9' });
const problem = (code: string) => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const formReady = () => waitFor(() => expect((screen.getByLabelText(vi_['mdm.edit.name.label']) as HTMLInputElement).value).toBe('Giao thông 1'));

function acceptingServer(state: World, log: Array<[string, unknown]> = []) {
  return (operation: string, input: unknown): unknown => {
    log.push([operation, input]);
    if (operation === 'createMasterChangeRequest') {
      state.changes.push(OPENED);
      return { operation_id: 'o1', status: 'DRAFT', resource_version: 1, resource_id: OPENED.id };
    }
    return { operation_id: 'o2', status: 'IN_REVIEW', resource_version: 2, resource_id: OPENED.id };
  };
}

describe('MasterEditScreen (MDM-26)', () => {
  it('starts from the version in force and refuses a date that is not after its start', async () => {
    const h = client(world({ versions: [version(1, 1, { attributes: { group: 'infrastructure' }, legal_basis: 'Decision 1' })] }));
    mount(<MasterEditScreen route={ROUTE} />, h, STEWARD, AT);
    await formReady();
    expect((screen.getByLabelText(vi_['mdm.edit.attributes.label']) as HTMLTextAreaElement).value).toContain('"group": "infrastructure"');
    expect((screen.getByLabelText(vi_['mdm.edit.legalBasis.label']) as HTMLTextAreaElement).value).toBe('Decision 1');
    expect(screen.getByText(vi_['mdm.edit.effectiveFrom.hint'].replace('{from}', '2024-01-01'))).toBeTruthy();
    const user = userEvent.setup();
    set(vi_['mdm.edit.effectiveFrom.label'], '2024-01-01');
    set(vi_['mdm.edit.reason.label'], 'Renamed by decision 12');
    await user.click(screen.getByRole('button', { name: vi_['mdm.edit.save.action'] }));
    expect(await screen.findByText(vi_['mdm.field.order.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('keeps the end date of the version in force unless it is changed', async () => {
    mount(<MasterEditScreen route={ROUTE} />, client(world({ versions: [version(1, 1, { valid_until: '2030-12-31' })] })), STEWARD, AT);
    await formReady();
    expect((screen.getByLabelText(vi_['mdm.edit.validUntil.label']) as HTMLInputElement).value).toBe('2030-12-31');
  });

  it('opens the change request from the new date, shows its stored impact and submits it after it has been read', async () => {
    const state = world({ versions: [version(1, 1)] });
    const log: Array<[string, unknown]> = [];
    mount(<MasterEditScreen route={ROUTE} />, client(state, acceptingServer(state, log)), STEWARD, AT);
    await formReady();
    const user = userEvent.setup();
    set(vi_['mdm.edit.name.label'], 'Giao thông vận tải');
    set(vi_['mdm.edit.effectiveFrom.label'], '2025-06-01');
    set(vi_['mdm.edit.reason.label'], 'Renamed by decision 12');
    await user.click(screen.getByRole('button', { name: vi_['mdm.edit.save.action'] }));
    await waitFor(() => expect(screen.getByTestId('impact')).toBeTruthy());
    expect(log[0]).toEqual([
      'createMasterChangeRequest',
      expect.objectContaining({
        body: {
          change_kind: 'UPDATE',
          master_type: 'SECTOR',
          master_record_id: record(1).id,
          proposed: { label: 'Giao thông vận tải', attributes: { group: 'infrastructure' }, parent_record_id: null, valid_until: null, legal_basis: null },
          effective_from: '2025-06-01',
          reason: 'Renamed by decision 12',
        },
      }),
    ]);
    expect(screen.getByText(vi_['mdm.edit.draft.saved.notice'])).toBeTruthy();
    const submit = screen.getByRole('button', { name: vi_['mdm.impact.submit.action'] });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: vi_['mdm.impact.read.label'] }));
    await user.click(submit);
    await waitFor(() => expect(screen.getByText(vi_['mdm.create.submitted.notice'], { exact: false })).toBeTruthy());
    expect(log[1]).toEqual(['submitMasterChangeRequest', expect.objectContaining({ path: { id: OPENED.id }, ifMatchVersion: 1 })]);
  });

  it('says what the server refused', async () => {
    mount(<MasterEditScreen route={ROUTE} />, client(world({ versions: [version(1, 1)] }), () => problem('EFFECTIVE_RANGE_OVERLAP')), STEWARD, AT);
    await formReady();
    set(vi_['mdm.edit.effectiveFrom.label'], '2025-06-01');
    set(vi_['mdm.edit.reason.label'], 'Renamed by decision 12');
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.edit.save.action'] }));
    expect((await screen.findByText(vi_['mdm.problem.overlap.error'])).closest('[role="alert"]')).not.toBeNull();
  });

  it('says why an entry cannot be changed: not in force, or a request already open', async () => {
    mount(<MasterEditScreen route={ROUTE} />, client(world({ records: [record(1, { status: 'RETIRED' })] })), STEWARD, AT);
    expect(await screen.findByTestId('not-in-force')).toBeTruthy();
    cleanup();
    mount(<MasterEditScreen route={ROUTE} />, client(world({ records: [record(1, { open_change_request_id: 'c1' })] })), STEWARD, AT);
    expect((await screen.findByTestId('change-open')).querySelector('a')?.getAttribute('href')).toBe('/mdm/mdm-27?type=SECTOR&key=GT-1');
  });

  it('says that no entry is chosen or found, and shows the error state when the entry cannot be read', async () => {
    mount(<MasterEditScreen route={ROUTE} />, client(world()), STEWARD, '/mdm/mdm-26');
    expect(await screen.findByTestId('no-record')).toBeTruthy();
    cleanup();
    mount(<MasterEditScreen route={ROUTE} />, client(world()), STEWARD, '/mdm/mdm-26?type=SECTOR&key=NOPE');
    expect(await screen.findByTestId('no-record')).toBeTruthy();
    cleanup();
    mount(<MasterEditScreen route={ROUTE} />, client(world({ failing: new Set(['searchMasterRecords']) })), STEWARD, AT);
    expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
  });

  it('is read-only for someone without the permission', async () => {
    mount(<MasterEditScreen route={ROUTE} />, client(world({ versions: [version(1, 1)] })), READER, AT);
    await formReady();
    expect(screen.getByText(vi_['mdm.readOnly.denied.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['mdm.edit.save.action'] })).toBeNull();
  });
});
