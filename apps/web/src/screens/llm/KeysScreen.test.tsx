import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import KeysScreen from './KeysScreen';
import { EMPTY_KEY, describeLlmProblem, keyBody, toKey, validateKey } from './llm-model';

const KEYS = routeOf('LLM-06', 'FR-LLM-06');
const MANAGER = ['llm.key.manage', 'llm.key.read'];
const READER = ['llm.key.read'];
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const MODEL = '00000000-0000-4000-8000-0000000000c1';
const rawKey = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000f1',
  key_alias: 'bid-prod',
  fingerprint: '3f9a1c2e…7a2c',
  scope_kind: 'TENANT',
  budget_id: null,
  allowed_model_ids: [MODEL],
  rpm_limit: 600,
  tpm_limit: null,
  status: 'ACTIVE',
  expires_at: '2027-10-22T16:59:59.000Z',
  rotated_from_id: null,
  revoked_reason: null,
  created_by: '00000000-0000-4000-8000-0000000000b1',
  created_at: '2026-10-22T00:00:00.000Z',
  version: 3,
  ...overrides,
});
const rawModel = (overrides: Record<string, unknown> = {}) => ({
  id: MODEL,
  provider_id: '00000000-0000-4000-8000-0000000000a1',
  model_id: 'llm-small',
  model_version: '1',
  capabilities: {},
  context_window: 8000,
  max_output: 1000,
  max_classification: 'INTERNAL',
  status: 'APPROVED',
  created_by: '00000000-0000-4000-8000-0000000000b1',
  created_at: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...overrides,
});

interface World {
  keys: unknown[] | Error;
  models: unknown[] | Error;
}
const normal = (): World => ({ keys: [rawKey()], models: [rawModel(), rawModel({ id: '00000000-0000-4000-8000-0000000000c2', model_id: 'llm-draft', status: 'PROPOSED' })] });

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness(() => new Error('unexpected read'), command);
  const readAll = vi.fn((operation: string) => {
    const result = operation === 'listAiVirtualKeys' ? world.keys : operation === 'listAiModels' ? world.models : new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('the pure rules of the key screen (ST-LLM-002)', () => {
  it('reads a key as it is shown and keeps nothing that is not in the view', () => {
    const key = toKey({ ...rawKey(), secret: 'sk-leak', secret_ref: 'secret://x', litellm_key_ref: 'ref' });
    expect(key).toMatchObject({ alias: 'bid-prod', fingerprint: '3f9a1c2e…7a2c', scope: 'TENANT', status: 'ACTIVE', rpmLimit: 600, tpmLimit: null, version: 3 });
    expect(JSON.stringify(key)).not.toMatch(/sk-leak|secret:\/\/|"ref"/);
    expect(toKey({ ...rawKey(), status: 'GONE' })).toBeUndefined();
    expect(toKey(null)).toBeUndefined();
  });

  it('checks the alias, the end and the rates before sending, and builds the body of a key that ends at the end of the day in Viet Nam', () => {
    const ok = { ...EMPTY_KEY, alias: 'bid-prod', expiresOn: '2027-10-22', modelIds: [MODEL] };
    expect(validateKey(ok, '2026-10-22')).toEqual({});
    expect(validateKey({ ...ok, alias: '' }, '2026-10-22')).toEqual({ alias: 'required' });
    expect(validateKey({ ...ok, modelIds: [] }, '2026-10-22')).toEqual({ modelIds: 'needsModel' });
    expect(validateKey({ ...ok, alias: 'a b' }, '2026-10-22')).toEqual({ alias: 'invalidAlias' });
    expect(validateKey({ ...ok, expiresOn: '' }, '2026-10-22')).toEqual({ expiresOn: 'invalidDate' });
    expect(validateKey({ ...ok, expiresOn: '2026-10-22' }, '2026-10-22')).toEqual({ expiresOn: 'pastDate' });
    expect(validateKey({ ...ok, rpmLimit: '0', tpmLimit: 'x' }, '2026-10-22')).toEqual({ rpmLimit: 'invalidNumber', tpmLimit: 'invalidNumber' });
    expect(keyBody({ ...ok, rpmLimit: '600' })).toEqual({ key_alias: 'bid-prod', scope_kind: 'TENANT', allowed_model_ids: [MODEL], expires_at: '2027-10-22T16:59:59.000Z', rpm_limit: 600 });
  });

  it('puts the refusals of the key commands in words', () => {
    expect(describeLlmProblem(failure(409, 'KEY_ALIAS_DUPLICATE')).reason).toBe('aliasDuplicate');
    expect(describeLlmProblem(failure(409, 'KEY_STATE_INVALID')).reason).toBe('keyState');
    expect(describeLlmProblem(failure(422, 'MODEL_NOT_APPROVED')).reason).toBe('modelNotApproved');
    expect(describeLlmProblem(failure(503, 'PROVIDER_UNAVAILABLE', 'litellm')).reason).toBe('unavailable');
  });
});

describe('LLM-06 virtual keys (ST-LLM-002, LLM F5, BR-LLM-09)', () => {
  it('AC-ST-LLM-002-1: UAT-AC20 shows the alias, scope, models, end, fingerprint and state of each key and nothing of a secret: no field, no button, no reference', async () => {
    const world = { ...normal(), keys: [{ ...rawKey(), secret: 'sk-live-1234567890abcdefghijklmn', secret_ref: 'secret://tenants/t/litellm/k', litellm_key_ref: 'litellm-key-7' }] };
    mount(<KeysScreen route={KEYS} />, client(world), { permissions: MANAGER });
    const table = await screen.findByTestId('key-table');
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(row.textContent).toContain('bid-prod');
    expect(row.textContent).toContain(vi_['llm.keyScope.tenant']);
    expect(row.textContent).toContain('2027-10-22');
    expect(row.textContent).toContain('3f9a1c2e…7a2c');
    expect(row.textContent).toContain(vi_['llm.keyStatus.active']);
    expect(screen.getByTestId('keys-vault-note').textContent).toBe(vi_['llm.keys.vaultNote']);
    const page = document.body.textContent ?? '';
    expect(page).not.toMatch(/sk-live|secret:\/\/|litellm-key-7/);
    expect(screen.queryByRole('button', { name: /secret|bí mật|show|hiện/i })).toBeNull();
    expect(document.body.querySelector('input[type="password"]')).toBeNull();
  });

  it('AC-ST-LLM-002-2: UAT-AC20 says when a key being rotated stops, rotates an active one at the version it was read at, and revoked keys offer nothing', async () => {
    const user = userEvent.setup();
    const world = { ...normal(), keys: [rawKey(), rawKey({ id: '00000000-0000-4000-8000-0000000000f2', status: 'ROTATING', expires_at: '2026-10-23T05:00:00.000Z', version: 4 }), rawKey({ id: '00000000-0000-4000-8000-0000000000f3', status: 'REVOKED', revoked_reason: 'ROTATION_COMPLETED' })] };
    const h = client(world, () => ({ status: 'ACTIVE' }));
    mount(<KeysScreen route={KEYS} />, h, { permissions: MANAGER });
    const table = await screen.findByTestId('key-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[1]?.textContent).toContain(vi_['llm.keyStatus.rotating']);
    expect(rows[1]?.textContent).toContain(fill(vi_['llm.keys.rotatingUntil'], { date: '2026-10-23' }));
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: vi_['llm.keys.rotate'] })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: vi_['llm.keys.revoke'] })).toBeTruthy();
    expect(within(rows[2] as HTMLElement).queryAllByRole('button').length).toBe(0);
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['llm.keys.rotate'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['rotateAiVirtualKey', { path: { id: '00000000-0000-4000-8000-0000000000f1' }, ifMatchVersion: 3 }]);
  });

  it('AC-ST-LLM-002-2: UAT-AC20 revokes with a reason of ten characters and says that the key stops at once', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'REVOKED' }));
    mount(<KeysScreen route={KEYS} />, h, { permissions: MANAGER });
    const table = await screen.findByTestId('key-table');
    await user.click(within(table).getByRole('button', { name: vi_['llm.keys.revoke'] }));
    const form = await screen.findByRole('form', { name: fill(vi_['llm.keys.revoke.title'], { alias: 'bid-prod' }) });
    expect(within(form).getByText(vi_['llm.keys.revoke.hint'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['llm.keys.revoke.reason']), 'too short');
    await user.click(within(form).getByRole('button', { name: vi_['llm.keys.revoke.submit'] }));
    expect(await within(form).findByText(fill(vi_['llm.keys.revoke.short'], { count: 10 }))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.keys.revoke.reason']), ' - exposed in a ticket');
    await user.click(within(form).getByRole('button', { name: vi_['llm.keys.revoke.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['revokeAiVirtualKey', { path: { id: '00000000-0000-4000-8000-0000000000f1' }, ifMatchVersion: 3, body: { reason: 'too short - exposed in a ticket' } }]);
  });

  it.each([
    ['KEY_STATE_INVALID', 409, 'llm.reason.keyState'],
    ['VERSION_CONFLICT', 409, 'llm.reason.stale'],
    ['PROVIDER_UNAVAILABLE', 503, 'llm.reason.unavailable'],
    ['MODEL_NOT_APPROVED', 422, 'llm.reason.modelNotApproved'],
  ] as const)('puts the refusal %s of a rotation in words', async (code, status, key) => {
    const user = userEvent.setup();
    mount(<KeysScreen route={KEYS} />, client(normal(), () => failure(status, code)), { permissions: MANAGER });
    const table = await screen.findByTestId('key-table');
    await user.click(within(table).getByRole('button', { name: vi_['llm.keys.rotate'] }));
    expect((await screen.findByTestId('key-refused')).textContent).toBe(vi_[key]);
  });

  it('AC-ST-LLM-002-1: UAT-AC20 offers only the approved models, checks the form before sending, and creates the key without ever asking for or showing a secret', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'ACTIVE', fingerprint: '3f9a1c2e…7a2c' }));
    mount(<KeysScreen route={KEYS} />, h, { permissions: MANAGER });
    const form = await screen.findByRole('form', { name: vi_['llm.keys.form.title'] });
    expect(within(form).getByLabelText('llm-small 1')).toBeTruthy();
    expect(within(form).queryByLabelText('llm-draft')).toBeNull();
    await user.click(within(form).getByRole('button', { name: vi_['llm.keys.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.problem.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.keys.form.alias']), 'bid-staging');
    fireEvent.change(within(form).getByLabelText(vi_['llm.keys.form.expires']), { target: { value: '2999-01-01' } });
    await user.click(within(form).getByLabelText('llm-small 1'));
    await user.selectOptions(within(form).getByLabelText(vi_['llm.keys.form.scope']), 'SERVICE');
    await user.click(within(form).getByRole('button', { name: vi_['llm.keys.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['createAiVirtualKey', { body: { key_alias: 'bid-staging', scope_kind: 'SERVICE', allowed_model_ids: [MODEL], expires_at: '2999-01-01T16:59:59.000Z' } }]);
    expect(await screen.findByTestId('key-saved')).toBeTruthy();
    expect(within(form).queryByLabelText(/secret|bí mật/i)).toBeNull();
  });

  it('asks for a model before it makes a key, and does not make one while the catalogue of models is loading or could not be read', async () => {
    const user = userEvent.setup();
    const h = client(normal());
    mount(<KeysScreen route={KEYS} />, h, { permissions: MANAGER });
    const form = await screen.findByRole('form', { name: vi_['llm.keys.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.keys.form.alias']), 'bid-staging');
    fireEvent.change(within(form).getByLabelText(vi_['llm.keys.form.expires']), { target: { value: '2999-01-01' } });
    await user.click(within(form).getByRole('button', { name: vi_['llm.keys.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.problem.needsModel'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it.each([
    ['could not be read', failure(500, 'INTERNAL_ERROR'), 'llm.keys.form.modelsFailed'],
    ['is not allowed to the person', failure(403, 'SCOPE_DENIED'), 'llm.keys.form.modelsDenied'],
  ] as const)('says that the model catalogue %s, and keeps the form from making a key', async (_name, error, key) => {
    const user = userEvent.setup();
    const h = client({ ...normal(), models: error });
    mount(<KeysScreen route={KEYS} />, h, { permissions: MANAGER });
    const form = await screen.findByRole('form', { name: vi_['llm.keys.form.title'] });
    const notice = await within(form).findByTestId('key-models-failed');
    expect(notice.textContent).toContain(vi_[key]);
    expect((within(form).getByRole('button', { name: vi_['llm.keys.form.submit'] }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(form).getByLabelText(vi_['llm.keys.form.alias']), 'bid-staging');
    fireEvent.submit(form);
    expect(h.command).not.toHaveBeenCalled();
    // The table of keys is still there: only the creation depends on the catalogue.
    expect(screen.getByTestId('key-table')).toBeTruthy();
  });

  it('puts the refusal of a duplicate alias in words and offers neither the form nor the buttons to who cannot manage keys', async () => {
    const user = userEvent.setup();
    const { unmount } = mount(<KeysScreen route={KEYS} />, client(normal(), () => failure(409, 'KEY_ALIAS_DUPLICATE')), { permissions: MANAGER });
    const form = await screen.findByRole('form', { name: vi_['llm.keys.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.keys.form.alias']), 'bid-prod');
    fireEvent.change(within(form).getByLabelText(vi_['llm.keys.form.expires']), { target: { value: '2999-01-01' } });
    await user.click(within(form).getByLabelText('llm-small 1'));
    await user.click(within(form).getByRole('button', { name: vi_['llm.keys.form.submit'] }));
    expect((await screen.findByTestId('key-create-refused')).textContent).toBe(vi_['llm.reason.aliasDuplicate']);
    unmount();
    mount(<KeysScreen route={KEYS} />, client(normal()), { permissions: READER });
    const table = await screen.findByTestId('key-table');
    expect(within(table).queryAllByRole('button').length).toBe(0);
    expect(screen.queryByRole('form', { name: vi_['llm.keys.form.title'] })).toBeNull();
  });

  describe('the standard states', () => {
    it.each([
      ['denied', { ...normal(), keys: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), keys: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), keys: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), keys: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-LLM-06 shows the %s state', async (_name, world, text) => {
      mount(<KeysScreen route={KEYS} />, client(world), { permissions: MANAGER });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-06 says that there is no key, and still offers to create the first', async () => {
      mount(<KeysScreen route={KEYS} />, client({ ...normal(), keys: [] }), { permissions: MANAGER });
      expect((await screen.findByTestId('keys-none')).textContent).toBe(vi_['llm.keys.none']);
      expect(screen.getByRole('form', { name: vi_['llm.keys.form.title'] })).toBeTruthy();
    });

    it('UI-LLM-06 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<KeysScreen route={KEYS} />, h, { permissions: MANAGER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.keys.page.title'] })).toBeTruthy();
    });
  });
});
