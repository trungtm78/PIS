import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { createTranslator, translator } from '../../i18n';
import { routeOf } from '../doc/test-support';
import { ConnectorsWorkspace } from './ConnectorsWorkspace';
import { adapterPill, connectorStatusLabel, connectorStatusPill, fieldMessage, modeLabel, problemMessage } from './connectors/labels';
import { toConnector } from './connectors/model';
import type { ConnectorView } from './connectors/model';
import { SECOND_TENANT, harness, mountInSession } from './security/test-support';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-09', 'FR-ADM-09');
const MANAGER = ['adm.integration.manage'];

const connector = (id: string, code: string, adapter: string, status = 'Draft', extra: Record<string, unknown> = {}): ConnectorView =>
  toConnector({ id, connector_code: code, adapter_status: adapter, mode: 'FILE_IMPORT', config: { directory: '/inbox' }, credential_secret_ref: null, mapping_version: null, status, version: 4, ...extra }) as ConnectorView;

const CONNECTORS: ConnectorView[] = [
  connector('c-proposed', 'treasury-file', 'PROPOSED'),
  connector('c-mock', 'procurement-mock', 'MOCK'),
  connector('c-verified', 'budget-file', 'VERIFIED', 'Active', { credential_secret_ref: 'secret://production/budget', mapping_version: 'v2', mode: 'LGSP' }),
  connector('c-missing', 'land-registry', 'MISSING', 'Disabled', { config: {} }),
];

const mount = (options: { connectors?: ConnectorView[]; permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; h?: ReturnType<typeof harness> } = {}) => {
  const h = options.h ?? harness(() => new Error('no read'));
  const view = mountInSession(<ConnectorsWorkspace route={ROUTE} connectors={options.connectors ?? CONNECTORS} />, h, {
    permissions: 'permissions' in options ? options.permissions : MANAGER,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  return { h, view };
};
const rowOf = (id: string): HTMLElement => document.querySelector(`[data-connector-id="${id}"]`) as HTMLElement;
const fill = async (code = 'new-connector'): Promise<void> => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(vi_['adm.connectors.form.code.label']), code);
};
const submit = (): Promise<void> => userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.connectors.form.submit.action'] }));

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

describe('ConnectorsWorkspace (ADM-09)', () => {
  it('shows each connector with the honest verdict on its adapter in the words of the cursors of master data: MOCK red, PROPOSED yellow (AC-ST-ADM-018-3, UI-ADM-09)', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.connectors.page.title']);
    expect(screen.getByTestId('honesty-note').textContent).toBe(vi_['adm.connectors.honesty.note']);
    expect([...document.querySelectorAll('[data-connector-id]')].map((row) => row.getAttribute('data-connector-id'))).toEqual(['c-verified', 'c-proposed', 'c-mock', 'c-missing'].sort((a, b) => (CONNECTORS.find((c) => c.id === a)?.connectorCode ?? '').localeCompare(CONNECTORS.find((c) => c.id === b)?.connectorCode ?? '')));
    const mock = within(rowOf('c-mock')).getByText(vi_['mdm.cursor.adapter.mock.pill']);
    expect(mock.className).toBe('pill red');
    const proposed = within(rowOf('c-proposed')).getByText(vi_['mdm.cursor.adapter.proposed.pill']);
    expect(proposed.className).toBe('pill warn');
    expect(within(rowOf('c-verified')).getByText(vi_['mdm.cursor.adapter.verified.pill']).className).toBe('pill');
    expect(within(rowOf('c-missing')).getByText(vi_['mdm.cursor.adapter.missing.pill']).className).toBe('pill gray');
  });

  it('shows the mode, the names of the configuration (never its values), the mapping version, the vault reference and the status', () => {
    mount();
    const verified = rowOf('c-verified');
    expect(within(verified).getByText(vi_['adm.connectors.mode.lgsp'])).toBeTruthy();
    expect(within(verified).getByText('directory')).toBeTruthy();
    expect(within(verified).getByText('v2')).toBeTruthy();
    expect(within(verified).getByText('secret://production/budget')).toBeTruthy();
    expect(within(verified).getByText(vi_['adm.connectors.status.active']).className).toBe('pill');
    expect(screen.queryByText('/inbox')).toBeNull();
    const missing = rowOf('c-missing');
    expect(within(missing).getByText(vi_['adm.connectors.config.none'])).toBeTruthy();
    expect(within(missing).getByText(vi_['adm.connectors.mapping.none'])).toBeTruthy();
    expect(within(missing).getByText(vi_['adm.connectors.credential.none'])).toBeTruthy();
    expect(within(missing).getByText(vi_['adm.connectors.status.disabled']).className).toBe('pill gray');
  });

  it('offers to activate only a connector whose adapter can ever run, and says why it does not for the others (BR-ADM-10)', () => {
    mount();
    expect(within(rowOf('c-proposed')).queryByRole('button', { name: vi_['adm.connectors.activate.action'] })).toBeNull();
    expect(within(rowOf('c-proposed')).getByTestId('not-activatable').textContent).toBe(vi_['adm.connectors.activate.blocked.hint']);
    expect(within(rowOf('c-missing')).getByTestId('not-activatable')).toBeTruthy();
    expect(within(rowOf('c-mock')).getByRole('button', { name: vi_['adm.connectors.activate.action'] })).toBeTruthy();
    expect(within(rowOf('c-verified')).queryByRole('button', { name: vi_['adm.connectors.activate.action'] })).toBeNull();
    expect(within(rowOf('c-verified')).getByRole('button', { name: vi_['adm.connectors.disable.action'] })).toBeTruthy();
    expect(within(rowOf('c-missing')).queryByRole('button', { name: vi_['adm.connectors.disable.action'] })).toBeNull();
  });

  describe('declaring a connector', () => {
    it('sends the body of the form and resets it, saying the connector is a draft', async () => {
      const { h } = mount({ h: harness(() => new Error('no read'), () => ({ resource_id: 'new', status: 'Draft', resource_version: 1 })) });
      await fill();
      await userEvent.setup().selectOptions(screen.getByLabelText(vi_['adm.connectors.form.mode.label']), 'API');
      await userEvent.setup().selectOptions(screen.getByLabelText(vi_['adm.connectors.form.adapter.label']), 'MOCK');
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.connectors.form.credential.label']), 'secret://production/new');
      await submit();
      expect((await screen.findByTestId('form-saved')).textContent).toBe(vi_['adm.connectors.form.saved.text']);
      expect(h.command).toHaveBeenCalledWith(
        'createIntegrationConnector',
        expect.objectContaining({ body: { connector_code: 'new-connector', mode: 'API', adapter_status: 'MOCK', config: {}, credential_secret_ref: 'secret://production/new' } }),
      );
      expect((screen.getByLabelText(vi_['adm.connectors.form.code.label']) as HTMLInputElement).value).toBe('');
    });

    it('offers the four words of the cursors as the adapter status and PROPOSED first', () => {
      mount();
      const options = [...(screen.getByLabelText(vi_['adm.connectors.form.adapter.label']) as HTMLSelectElement).options].map((option) => [option.value, option.textContent]);
      expect(options).toEqual([
        ['VERIFIED', vi_['mdm.cursor.adapter.verified.pill']],
        ['PROPOSED', vi_['mdm.cursor.adapter.proposed.pill']],
        ['MOCK', vi_['mdm.cursor.adapter.mock.pill']],
        ['MISSING', vi_['mdm.cursor.adapter.missing.pill']],
      ]);
      expect((screen.getByLabelText(vi_['adm.connectors.form.adapter.label']) as HTMLSelectElement).value).toBe('PROPOSED');
    });

    it('refuses a secret in the configuration, a credential that is not a reference and a bad code without asking the server', async () => {
      const { h } = mount();
      await submit();
      expect(await screen.findByText(vi_['adm.connectors.field.required'])).toBeTruthy();
      await fill('Bad Code');
      fireEvent.change(screen.getByLabelText(vi_['adm.connectors.form.config.label']), { target: { value: '{"password":"hunter2"}' } });
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.connectors.form.credential.label']), 'hunter2');
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.connectors.form.mapping.label']), 'no spaces');
      await submit();
      expect(await screen.findByText(vi_['adm.connectors.field.code'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.connectors.field.configSecret'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.connectors.field.credential'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.connectors.field.mapping'])).toBeTruthy();
      fireEvent.change(screen.getByLabelText(vi_['adm.connectors.form.config.label']), { target: { value: '{ nope' } });
      await submit();
      expect(await screen.findByText(vi_['adm.connectors.field.configJson'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it.each([
      ['CONNECTOR_CODE_TAKEN', 409, 'adm.connectors.problem.codeTaken'],
      ['VALIDATION_FAILED', 422, 'adm.connectors.problem.invalid'],
      ['SCOPE_DENIED', 403, 'adm.connectors.problem.denied'],
      ['INTERNAL_ERROR', 500, 'adm.connectors.problem.general'],
    ] as const)('says what happened when the declaration is answered %s', async (code, status, key) => {
      mount({ h: harness(() => new Error('no read'), () => new ApiError({ status, code, correlationId: 'c' })) });
      await fill();
      await submit();
      expect((await screen.findByTestId('form-problem')).textContent).toBe(vi_[key]);
    });

    it('forgets that a connector was declared as soon as the form changes', async () => {
      mount({ h: harness(() => new Error('no read'), () => ({ resource_id: 'new' })) });
      await fill();
      await submit();
      await screen.findByTestId('form-saved');
      await fill('-more');
      expect(screen.queryByTestId('form-saved')).toBeNull();
    });
  });

  describe('activating and disabling', () => {
    const open = async (id: string, action: string): Promise<void> => {
      await userEvent.setup().click(within(rowOf(id)).getByRole('button', { name: action }));
    };

    it('asks for a reason of 10 to 2000 characters and sends the version the person saw (AC-ST-ADM-018-1)', async () => {
      const { h } = mount({ h: harness(() => new Error('no read'), () => ({ resource_id: 'c-mock', status: 'Active', resource_version: 5 })) });
      await open('c-mock', vi_['adm.connectors.activate.action']);
      const panel = screen.getByTestId('move-panel');
      expect(within(panel).getByText('procurement-mock')).toBeTruthy();
      expect(within(panel).getByText(vi_['mdm.cursor.adapter.mock.pill']).className).toBe('pill red');
      const user = userEvent.setup();
      await user.click(within(panel).getByRole('button', { name: vi_['adm.connectors.move.confirm.action'] }));
      expect(await within(panel).findByText(vi_['adm.connectors.move.reason.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.type(within(panel).getByLabelText(vi_['adm.connectors.move.reason.label']), 'The test adapter of the pilot');
      await user.click(within(panel).getByRole('button', { name: vi_['adm.connectors.move.confirm.action'] }));
      await waitFor(() => expect(screen.queryByTestId('move-panel')).toBeNull());
      expect(h.command).toHaveBeenCalledWith('updateIntegrationConnector', expect.objectContaining({ path: { connectorId: 'c-mock' }, body: { status: 'Active', reason: 'The test adapter of the pilot' }, ifMatchVersion: 4 }));
    });

    it('sends a disabling the same way', async () => {
      const { h } = mount({ h: harness(() => new Error('no read'), () => ({ status: 'Disabled' })) });
      await open('c-verified', vi_['adm.connectors.disable.action']);
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.connectors.move.reason.label']), 'The agency changes its format');
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.connectors.move.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('updateIntegrationConnector', expect.objectContaining({ body: { status: 'Disabled', reason: 'The agency changes its format' } })));
    });

    it.each([
      [new ApiError({ status: 422, code: 'CONNECTOR_NOT_ACTIVATABLE', detail: 'MOCK_IN_PRODUCTION', correlationId: 'c' }), 'adm.connectors.problem.mockInProduction'],
      [new ApiError({ status: 422, code: 'CONNECTOR_NOT_ACTIVATABLE', detail: 'ADAPTER_NOT_VERIFIED', correlationId: 'c' }), 'adm.connectors.problem.adapterNotVerified'],
      [new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }), 'adm.connectors.problem.conflict'],
      [new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }), 'adm.connectors.problem.notFound'],
    ] as const)('says which rule refused the move and keeps the panel open', async (failure, key) => {
      mount({ h: harness(() => new Error('no read'), () => failure) });
      await open('c-mock', vi_['adm.connectors.activate.action']);
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.connectors.move.reason.label']), 'The test adapter of the pilot');
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.connectors.move.confirm.action'] }));
      expect((await screen.findByTestId('move-problem')).textContent).toBe(vi_[key]);
      expect(screen.getByTestId('move-panel')).toBeTruthy();
    });

    it('can be cancelled and starts over with an empty reason when opened again', async () => {
      mount();
      await open('c-mock', vi_['adm.connectors.activate.action']);
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.connectors.move.reason.label']), 'A reason long enough');
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.connectors.move.cancel.action'] }));
      expect(screen.queryByTestId('move-panel')).toBeNull();
      await open('c-mock', vi_['adm.connectors.activate.action']);
      expect((screen.getByLabelText(vi_['adm.connectors.move.reason.label']) as HTMLTextAreaElement).value).toBe('');
    });
  });

  describe('permissions', () => {
    it('shows no form and no action to a reader, nor while the tenant is suspended, and everything while the permissions are not known', () => {
      mount({ permissions: [] });
      expect(screen.queryByRole('button')).toBeNull();
      expect(document.querySelectorAll('[data-connector-id]')).toHaveLength(4);
      cleanup();
      mount({ permissions: MANAGER, mode: 'READ_ONLY' });
      expect(screen.queryByRole('button')).toBeNull();
      cleanup();
      mount({ permissions: undefined });
      expect(screen.getByRole('button', { name: vi_['adm.connectors.form.submit.action'] })).toBeTruthy();
    });

    it('says so when there is no connector', () => {
      mount({ connectors: [] });
      expect(screen.getByText(vi_['adm.connectors.list.empty'])).toBeTruthy();
      expect(document.querySelector('table')).toBeNull();
    });
  });

  it('starts the form over when the tenant is switched', async () => {
    const { view } = mount();
    await fill('typed-for-the-first');
    view.rerenderWith({ permissions: MANAGER, tenant: SECOND_TENANT });
    expect((screen.getByLabelText(vi_['adm.connectors.form.code.label']) as HTMLInputElement).value).toBe('');
  });

  it('shows the screen in English', () => {
    translator.setLocale('en');
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en_['adm.connectors.page.title']);
    expect(within(rowOf('c-mock')).getByText(en_['mdm.cursor.adapter.mock.pill'])).toBeTruthy();
  });
});

describe('the words of ADM-09', () => {
  it.each(['vi', 'en'] as const)('has a sentence of its own for every value in %s', (locale) => {
    const t = createTranslator({ locale, catalogues: { vi: vi_, en: en_ }, strict: true }).t;
    const all = [
      ...(['FILE_IMPORT', 'FILE_EXPORT', 'API', 'LGSP'] as const).map((mode) => modeLabel(t, mode)),
      ...(['Draft', 'Active', 'Disabled'] as const).map((status) => connectorStatusLabel(t, status)),
      ...(['required', 'code', 'configJson', 'configSecret', 'configSize', 'credential', 'mapping'] as const).map((problem) => fieldMessage(t, problem)),
      ...(['adapterNotVerified', 'mockInProduction', 'codeTaken', 'invalid', 'conflict', 'notFound', 'denied', 'session', 'general'] as const).map((reason) => problemMessage(t, { reason })),
    ];
    expect(all.every((text) => text !== '' && !text.startsWith('adm.connectors.'))).toBe(true);
  });

  it('colours the pills: MOCK red, PROPOSED yellow, the plain pill for VERIFIED and a draft amber', () => {
    expect([adapterPill('VERIFIED'), adapterPill('MOCK'), adapterPill('PROPOSED'), adapterPill('MISSING')]).toEqual(['pill', 'pill red', 'pill warn', 'pill gray']);
    expect([connectorStatusPill('Draft'), connectorStatusPill('Active'), connectorStatusPill('Disabled')]).toEqual(['pill warn', 'pill', 'pill gray']);
  });
});
