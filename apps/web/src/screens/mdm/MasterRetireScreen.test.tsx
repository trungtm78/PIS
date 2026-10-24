import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterRetireScreen from './MasterRetireScreen';
import { READER, STEWARD, change, client, mount, record, routeOf, version, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('MDM-31', 'FR-MDM-31');
const AT = '/mdm/mdm-31?type=SECTOR&key=GT-1';
const OPENED = change(1, { change_kind: 'RETIRE', status: 'DRAFT', version: 1, proposed: {}, impact: { counts: {}, total: 0 } });
const policy = (overrides: Record<string, unknown> = {}) => ({ master_type: 'SECTOR', scope: 'TENANT_ONLY', retire_requires_successor: false, locked: false, source: 'BASELINE', platform_records: 0, tenant_records: 1, ...overrides });
const problem = (code: string) => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
const USED = { master_record_id: record(1).id, as_of: null, counts: { 'project.sector_master_version_id': 5 }, total: 5, samples: [] };

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

function accepting(state: World, log: Array<[string, unknown]> = []) {
  return (operation: string, input: unknown): unknown => {
    log.push([operation, input]);
    if (operation === 'createMasterChangeRequest') {
      state.changes.push(OPENED);
      return { operation_id: 'o1', status: 'DRAFT', resource_version: 1, resource_id: OPENED.id };
    }
    return { operation_id: 'o2', status: 'IN_REVIEW', resource_version: 2, resource_id: OPENED.id };
  };
}

const retirable = (overrides: Partial<World> = {}): World => world({ versions: [version(1, 1)], policies: [policy()], ...overrides });
const readyForm = () => waitFor(() => expect(screen.getByLabelText(vi_['mdm.retire.date.label'])).toBeEnabled());

describe('MasterRetireScreen (MDM-31)', () => {
  it('retires an entry that nothing uses without a successor, shows the stored impact and submits it after it has been read', async () => {
    const state = retirable();
    const log: Array<[string, unknown]> = [];
    mount(<MasterRetireScreen route={ROUTE} />, client(state, accepting(state, log)), STEWARD, AT);
    await readyForm();
    expect(screen.getByText(vi_['mdm.retire.successor.optional.hint'])).toBeTruthy();
    const user = userEvent.setup();
    set(vi_['mdm.retire.date.label'], '2026-01-01');
    set(vi_['mdm.retire.reason.label'], 'No longer used by any project');
    await user.click(screen.getByRole('button', { name: vi_['mdm.retire.save.action'] }));
    await waitFor(() => expect(screen.getByTestId('impact')).toBeTruthy());
    expect(log[0]).toEqual([
      'createMasterChangeRequest',
      expect.objectContaining({ body: { change_kind: 'RETIRE', master_type: 'SECTOR', master_record_id: record(1).id, proposed: {}, effective_from: '2026-01-01', reason: 'No longer used by any project' } }),
    ]);
    expect(screen.getByText(vi_['mdm.retire.draft.saved.notice'])).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: vi_['mdm.impact.read.label'] }));
    await user.click(screen.getByRole('button', { name: vi_['mdm.impact.submit.action'] }));
    await waitFor(() => expect(screen.getByText(vi_['mdm.create.submitted.notice'], { exact: false })).toBeTruthy());
    expect(log[1]).toEqual(['submitMasterChangeRequest', expect.objectContaining({ path: { id: OPENED.id }, ifMatchVersion: 1 })]);
  });

  it('requires a successor for an entry that is in use, and sends the one that is chosen (AC-ST-MDM-002-1)', async () => {
    const state = retirable({ usage: USED, records: [record(1), record(2, { master_type: 'SECTOR', business_key: 'GT-2', label: 'Giao thông 2' }), record(3, { master_type: 'SECTOR', business_key: 'GT-3', status: 'DRAFT' })] });
    const log: Array<[string, unknown]> = [];
    mount(<MasterRetireScreen route={ROUTE} />, client(state, accepting(state, log)), STEWARD, AT);
    await readyForm();
    expect(screen.getByTestId('in-use').textContent).toBe(vi_['mdm.retire.inUse.notice'].replace('{total}', '5'));
    expect(screen.getByText(vi_['mdm.retire.successor.required.hint'])).toBeTruthy();
    // Only the other entries in force of the type are offered: not the entry itself, not a draft.
    expect(screen.getByRole('option', { name: /GT-2/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /GT-3/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /GT-1/ })).toBeNull();
    const user = userEvent.setup();
    set(vi_['mdm.retire.date.label'], '2026-01-01');
    set(vi_['mdm.retire.reason.label'], 'Replaced by the new sector');
    await user.click(screen.getByRole('button', { name: vi_['mdm.retire.save.action'] }));
    expect(await screen.findByText(vi_['mdm.field.required.error'])).toBeTruthy();
    expect(log).toHaveLength(0);
    await user.selectOptions(screen.getByLabelText(vi_['mdm.retire.successor.label']), record(2).id);
    await user.click(screen.getByRole('button', { name: vi_['mdm.retire.save.action'] }));
    await waitFor(() => expect(log).toHaveLength(1));
    expect((log[0]?.[1] as { body: unknown }).body).toMatchObject({ successor_record_id: record(2).id });
  });

  it('requires a successor when the policy of the type asks for one, even when nothing uses the entry', async () => {
    mount(<MasterRetireScreen route={ROUTE} />, client(retirable({ policies: [policy({ retire_requires_successor: true })] })), STEWARD, AT);
    await readyForm();
    expect(screen.getByTestId('successor-policy')).toBeTruthy();
    expect(screen.getByText(vi_['mdm.retire.successor.required.hint'])).toBeTruthy();
  });

  it('refuses a date that is not after the start of the version in force, and a missing reason, and sends nothing', async () => {
    const h = client(retirable());
    mount(<MasterRetireScreen route={ROUTE} />, h, STEWARD, AT);
    await readyForm();
    set(vi_['mdm.retire.date.label'], '2024-01-01');
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.retire.save.action'] }));
    expect(await screen.findByText(vi_['mdm.field.order.error'])).toBeTruthy();
    expect(screen.getByText(vi_['mdm.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says what the server refused', async () => {
    mount(<MasterRetireScreen route={ROUTE} />, client(retirable(), () => problem('MASTER_IN_USE')), STEWARD, AT);
    await readyForm();
    set(vi_['mdm.retire.date.label'], '2026-01-01');
    set(vi_['mdm.retire.reason.label'], 'No longer used by any project');
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.retire.save.action'] }));
    expect((await screen.findByText(vi_['mdm.problem.inUse.error'])).closest('[role="alert"]')).not.toBeNull();
  });

  it('does not offer the request until the usage and the policy are read, and says when they cannot be', async () => {
    mount(<MasterRetireScreen route={ROUTE} />, client(retirable({ failing: new Set(['getMasterRecordUsages']) })), STEWARD, AT);
    expect((await screen.findByText(vi_['mdm.retire.read.error'])).closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: vi_['mdm.retire.save.action'] })).toBeDisabled();
    expect(screen.getByLabelText(vi_['mdm.retire.date.label'])).toBeDisabled();
  });

  it('says why an entry cannot be retired: not in force, or a request already open', async () => {
    mount(<MasterRetireScreen route={ROUTE} />, client(world({ records: [record(1, { status: 'RETIRED' })] })), STEWARD, AT);
    expect(await screen.findByTestId('not-in-force')).toBeTruthy();
    cleanup();
    mount(<MasterRetireScreen route={ROUTE} />, client(world({ records: [record(1, { open_change_request_id: 'c1' })] })), STEWARD, AT);
    expect(await screen.findByTestId('change-open')).toBeTruthy();
  });

  it('says that no entry is chosen or found, and is read-only for someone without the permission', async () => {
    mount(<MasterRetireScreen route={ROUTE} />, client(world()), STEWARD, '/mdm/mdm-31');
    expect(await screen.findByTestId('no-record')).toBeTruthy();
    cleanup();
    mount(<MasterRetireScreen route={ROUTE} />, client(world()), STEWARD, '/mdm/mdm-31?type=SECTOR&key=NOPE');
    expect(await screen.findByTestId('no-record')).toBeTruthy();
    cleanup();
    mount(<MasterRetireScreen route={ROUTE} />, client(retirable()), READER, AT);
    expect(await screen.findByText(vi_['mdm.readOnly.denied.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['mdm.retire.save.action'] })).toBeNull();
  });
});
