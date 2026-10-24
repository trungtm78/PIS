import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { mountInSession } from '../adm/security/test-support';
import MasterCreateScreen from './MasterCreateScreen';
import { READER, STEWARD, change, client, mount, record, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('MDM-25', 'FR-MDM-25');
const NEW_RECORD = record(9, { status: 'DRAFT', business_key: 'NEW-1', label: 'Mới', valid_from: '2026-01-01', open_change_request_id: change(9).id });
const NEW_CHANGE = change(9, { change_kind: 'CREATE', status: 'DRAFT', business_key: 'NEW-1', version: 1, impact: { counts: {}, total: 0 }, master_record_version: 1 });
const problem = (code: string, detail?: string) => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

async function fillValid(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  set(vi_['mdm.create.type.label'], 'SECTOR');
  set(vi_['mdm.create.key.label'], 'NEW-1');
  set(vi_['mdm.create.name.label'], 'Mới');
  set(vi_['mdm.create.validFrom.label'], '2026-01-01');
  set(vi_['mdm.create.reason.label'], 'Initial catalogue entry');
  expect(user).toBeTruthy();
}

/** The world after the server accepted the proposal: the draft record and its change request exist. */
function acceptingServer(state: World, log: Array<[string, unknown]> = []) {
  return (operation: string, input: unknown): unknown => {
    log.push([operation, input]);
    if (operation === 'proposeMasterRecord') {
      state.records.push(NEW_RECORD);
      state.changes.push(NEW_CHANGE);
      return { operation_id: 'o1', status: 'DRAFT', resource_version: 1, resource_id: NEW_RECORD.id };
    }
    return { operation_id: 'o2', status: 'IN_REVIEW', resource_version: 2, resource_id: NEW_CHANGE.id };
  };
}

describe('MasterCreateScreen (MDM-25)', () => {
  it('names each problem of the form and sends nothing', async () => {
    const h = client(world(), () => ({}));
    mount(<MasterCreateScreen route={ROUTE} />, h, STEWARD);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: vi_['mdm.create.save.action'] }));
    expect((await screen.findAllByText(vi_['mdm.field.required.error'])).length).toBeGreaterThanOrEqual(4);
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['mdm.create.attributes.label'], '[1]');
    set(vi_['mdm.create.reason.label'], 'abc');
    await user.click(screen.getByRole('button', { name: vi_['mdm.create.save.action'] }));
    expect(screen.getByText(vi_['mdm.field.invalidJson.error'])).toBeTruthy();
    expect(screen.getByText(vi_['mdm.field.tooShort.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('saves the draft, shows the stored impact, and submits only after the person says they have read it', async () => {
    const state = world();
    const log: Array<[string, unknown]> = [];
    const h = client(state, acceptingServer(state, log));
    mount(<MasterCreateScreen route={ROUTE} />, h, STEWARD);
    const user = userEvent.setup();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: vi_['mdm.create.save.action'] }));
    await waitFor(() => expect(screen.getByTestId('impact')).toBeTruthy());
    expect(log[0]).toEqual([
      'proposeMasterRecord',
      expect.objectContaining({ body: { namespace: 'TENANT', master_type: 'SECTOR', business_key: 'NEW-1', label: 'Mới', attributes: {}, valid_from: '2026-01-01', reason: 'Initial catalogue entry' } }),
    ]);
    expect(screen.getByText(vi_['mdm.create.draft.saved.notice'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['mdm.create.type.label'])).toBeDisabled();
    const submit = screen.getByRole('button', { name: vi_['mdm.impact.submit.action'] });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: vi_['mdm.impact.read.label'] }));
    await user.click(submit);
    await waitFor(() => expect(screen.getByText(vi_['mdm.create.submitted.notice'], { exact: false })).toBeTruthy());
    expect(log[1]).toEqual(['submitMasterChangeRequest', expect.objectContaining({ path: { id: NEW_CHANGE.id }, ifMatchVersion: 1 })]);
    expect(screen.getByText(vi_['mdm.create.queue.link']).getAttribute('href')).toBe('/mdm/mdm-32');
    expect(screen.getByText(vi_['mdm.create.detail.link']).getAttribute('href')).toBe('/mdm/mdm-27?type=SECTOR&key=NEW-1');
  });

  it('sends the optional fields when they are filled and the parent from the entries in force of the same type', async () => {
    const state = world();
    const log: Array<[string, unknown]> = [];
    mount(<MasterCreateScreen route={ROUTE} />, client(state, acceptingServer(state, log)), STEWARD);
    const user = userEvent.setup();
    await fillValid(user);
    await waitFor(() => expect(screen.getByRole('option', { name: /GT-1/ })).toBeTruthy());
    expect(screen.queryByRole('option', { name: /NSTW/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText(vi_['mdm.create.parent.label']), record(1).id);
    set(vi_['mdm.create.validUntil.label'], '2030-01-01');
    set(vi_['mdm.create.legalBasis.label'], ' Decision 12 ');
    set(vi_['mdm.create.attributes.label'], '{"group":"transport"}');
    await user.click(screen.getByRole('button', { name: vi_['mdm.create.save.action'] }));
    await waitFor(() => expect(log).toHaveLength(1));
    expect((log[0]?.[1] as { body: unknown }).body).toMatchObject({ parent_record_id: record(1).id, valid_until: '2030-01-01', legal_basis: 'Decision 12', attributes: { group: 'transport' } });
  });

  it('says what the server refused: a duplicate key, a locked catalogue, and a field it did not accept', async () => {
    for (const [failure, expected] of [
      [problem('DUPLICATE_KEY'), vi_['mdm.problem.duplicateKey.error']],
      [problem('POLICY_LOCKED'), vi_['mdm.problem.policyLocked.error']],
      [problem('VALIDATION_FAILED', 'valid_until'), vi_['mdm.problem.validationField.error'].replace('{field}', 'valid_until')],
    ] as const) {
      const h = client(world(), () => failure);
      mount(<MasterCreateScreen route={ROUTE} />, h, STEWARD);
      const user = userEvent.setup();
      await fillValid(user);
      await user.click(screen.getByRole('button', { name: vi_['mdm.create.save.action'] }));
      expect((await screen.findByText(expected)).closest('[role="alert"]')).not.toBeNull();
      expect(screen.getByRole('button', { name: vi_['mdm.create.save.action'] })).toBeEnabled();
      cleanup();
    }
  });

  it('says why the request cannot be submitted when the server refuses it, and keeps the draft', async () => {
    const state = world();
    const base = acceptingServer(state);
    const h = client(state, (operation, input) => (operation === 'submitMasterChangeRequest' ? problem('IMPACT_NOT_COMPUTED') : base(operation, input)));
    mount(<MasterCreateScreen route={ROUTE} />, h, STEWARD);
    const user = userEvent.setup();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: vi_['mdm.create.save.action'] }));
    await user.click(await screen.findByRole('checkbox', { name: vi_['mdm.impact.read.label'] }));
    await user.click(screen.getByRole('button', { name: vi_['mdm.impact.submit.action'] }));
    expect((await screen.findByText(vi_['mdm.problem.impactNotComputed.error'])).closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText(vi_['mdm.create.submitted.notice'], { exact: false })).toBeNull();
  });

  it('shows that the impact could not be computed when the stored request has none, and keeps the submit button off', async () => {
    const state = world();
    const base = acceptingServer(state);
    const h = client(state, (operation, input) => {
      const answer = base(operation, input);
      if (operation === 'proposeMasterRecord') state.changes[state.changes.length - 1] = { ...NEW_CHANGE, impact: null };
      return answer;
    });
    mount(<MasterCreateScreen route={ROUTE} />, h, STEWARD);
    const user = userEvent.setup();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: vi_['mdm.create.save.action'] }));
    expect(await screen.findByText(vi_['mdm.impact.missing.error'])).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: vi_['mdm.impact.read.label'] }));
    expect(screen.getByRole('button', { name: vi_['mdm.impact.submit.action'] })).toBeDisabled();
  });

  it('is read-only for someone without the permission and while the tenant is suspended', async () => {
    mount(<MasterCreateScreen route={ROUTE} />, client(world()), READER);
    expect(screen.getByText(vi_['mdm.readOnly.denied.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['mdm.create.save.action'] })).toBeNull();
    expect(screen.getByLabelText(vi_['mdm.create.key.label'])).toBeDisabled();
    cleanup();
    mountInSession(<MasterCreateScreen route={ROUTE} />, client(world()), { permissions: STEWARD, mode: 'READ_ONLY' });
    expect(screen.getByText(vi_['mdm.readOnly.frozen.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['mdm.create.save.action'] })).toBeNull();
  });

  it('starts over when the tenant changes, so a draft of one tenant is never saved into another', async () => {
    const state = world();
    const view = mountInSession(<MasterCreateScreen route={ROUTE} />, client(state, acceptingServer(state)), { permissions: STEWARD });
    const user = userEvent.setup();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: vi_['mdm.create.save.action'] }));
    await screen.findByTestId('impact');
    view.rerenderWith({ permissions: STEWARD, tenant: { id: '00000000-0000-4000-8000-0000000000bb', name: 'Other', monogram: 'OT', membershipId: '00000000-0000-4000-8000-0000000000bc', theme: { themeId: 'tenant', version: 1, overlay: {} } } });
    expect(screen.queryByTestId('impact')).toBeNull();
    expect((screen.getByLabelText(vi_['mdm.create.key.label']) as HTMLInputElement).value).toBe('');
    expect(within(document.body).queryByText(vi_['mdm.create.draft.saved.notice'])).toBeNull();
  });
});
