import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import AssetScreen from './AssetScreen';
import { ACCOUNTANT, DOCUMENT, READER, asset, assetId, client, handoverId, mount, routeOf, unitId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('AST-03', 'FR-AST-03');
const OK = { operation_id: 'o', status: 'REGISTERED', resource_version: 1, resource_id: assetId(9) };
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const amount = (value: bigint): string => new Intl.NumberFormat('vi').format(value);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; query?: string; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<AssetScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: `/ast/ast-03${options.query ?? ''}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const rows = (): string[] => Array.from(document.querySelectorAll('[data-asset]')).map((row) => row.getAttribute('data-asset') as string);
/** The code of the asset is marked in its cell; the row is the table row around it. */
const row = (id: string): HTMLElement => (document.querySelector(`[data-asset="${id}"]`) as HTMLElement).closest('tr') as HTMLElement;
const submit = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const commandsOf = (h: ReturnType<typeof client>, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });

describe('AssetScreen (AST-03): the asset dossier', () => {
  it('UI-AST-03: lists the assets with the handover, the unit that receives them, the value and what is left of the contract, the code elsewhere and the status', async () => {
    open(
      world({
        assets: [
          asset(2, { status: 'TRANSFERRED', transferred_on: '2026-10-24', external_asset_id: 'TS-1', warranty_until: '2027-10-24', allowed: { transfer: false } }),
          asset(1, { allowed: { transfer: true } }),
        ],
      }),
    );
    await screen.findByTestId('assets');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ast.asset.page.title']);
    expect(screen.getByText(text('ast.asset.footer.reference', { id: 'AST-03', req: 'FR-AST-03' }))).toBeTruthy();
    expect(rows()).toEqual([assetId(2), assetId(1)]);
    const registered = row(assetId(1));
    expect(within(registered).getByTestId('code').textContent).toBe('AS-001');
    expect(within(registered).getByTestId('name').textContent).toBe('Trạm bơm 1');
    expect(within(registered).getByTestId('handover').textContent).toBe('BG-001 · HD-A-002');
    expect(within(registered).getByTestId('unit').textContent).toBe('Sở Giao thông');
    expect(within(registered).getByTestId('value').textContent).toContain(text('ctr.value.amount', { amount: amount(3200000000n) }));
    expect(within(registered).getByTestId('value').textContent).toContain(vi_['ast.asset.basis.contractValue']);
    expect(within(registered).getByTestId('remaining').textContent).toBe(text('ast.asset.remaining.label', { left: amount(5000000000n), contract: amount(10000000000n) }));
    expect(within(registered).getByTestId('external').textContent).toBe(vi_['ast.asset.external.manual']);
    expect(within(registered).getByTestId('status').textContent).toBe(vi_['ast.asset.status.registered']);
    const transferred = row(assetId(2));
    expect(within(transferred).getByTestId('external').textContent).toBe('TS-1');
    expect(within(transferred).getByTestId('status').textContent).toBe(vi_['ast.asset.status.transferred']);
    expect(transferred.textContent).toContain(text('ast.asset.transferred.on', { day: '2026-10-24' }));
    expect(transferred.textContent).toContain(text('ast.asset.warranty.until', { day: '2027-10-24' }));
    expect(screen.queryByRole('button', { name: vi_['ast.asset.register.action'] })).toBeNull();
  });

  it('shows no figure to whoever may not see it, and says so', async () => {
    open(world({ assets: [asset(1, { value_vnd: null, value_basis: null, contract_assets_vnd: null, contract: { id: 'c', code: 'HD-A-002' } })] }));
    await screen.findByTestId('assets');
    const hidden = row(assetId(1));
    expect(within(hidden).getByTestId('value').textContent).toBe(vi_['ast.asset.value.hidden']);
    expect(within(hidden).queryByTestId('remaining')).toBeNull();
  });

  it('says when there is no asset, and offers the accepted handovers as a filter that narrows the list', async () => {
    open(world({ assets: [asset(1), asset(2, { handover: { id: handoverId(2), handover_no: 'BG-002', status: 'ACCEPTED' } })] }));
    await screen.findByTestId('assets');
    const options = Array.from((document.getElementById('assets-handover') as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual([vi_['ast.asset.filter.all'], 'BG-001 · HD-A-002', 'BG-002 · HD-A-002']);
    pick('assets-handover', handoverId(2));
    await waitFor(() => expect(rows()).toEqual([assetId(2)]));
    pick('assets-handover', handoverId(1));
    await waitFor(() => expect(rows()).toEqual([assetId(1)]));
    cleanup();
    open(world({ assets: [] }));
    expect((await screen.findByTestId('no-assets')).textContent).toBe(vi_['ast.asset.none.notice']);
  });

  it('reads the handover named in the address, and ignores one the scope does not hold', async () => {
    open(world({ assets: [asset(1), asset(2, { handover: { id: handoverId(2), handover_no: 'BG-002', status: 'ACCEPTED' } })] }), { query: `?handover=${handoverId(2)}` });
    await waitFor(() => expect(rows()).toEqual([assetId(2)]));
    cleanup();
    open(world({ assets: [asset(1)] }), { query: '?handover=00000000-0000-4000-8000-0000000000ff' });
    await waitFor(() => expect(rows()).toEqual([assetId(1)]));
  });

  it('still lists the assets for whoever may not read the handovers, without the filter or the button to register one', async () => {
    open(world({ assets: [asset(1)], failing: new Set(['get_resources_handover']) }), { permissions: ACCOUNTANT });
    await screen.findByTestId('assets');
    expect(document.getElementById('assets-handover')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['ast.asset.register.action'] })).toBeNull();
  });

  it('shows the state of a read that failed and reads again on retry', async () => {
    const state = world({ failing: new Set(['get_resources_asset_record']) });
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-assets');
    expect(h.read.mock.calls.filter((call) => call[0] === 'get_resources_asset_record').length).toBeGreaterThan(1);
  });

  describe('registering', () => {
    const fill = (values: Record<string, string>): void => {
      for (const [id, value] of Object.entries(values)) pick(id, value);
    };

    it('offers the button only to whoever may register, and not in a read-only session', async () => {
      open(world(), { permissions: ACCOUNTANT, mode: 'READ_ONLY' });
      await screen.findByTestId('no-assets');
      expect(screen.queryByRole('button', { name: vi_['ast.asset.register.action'] })).toBeNull();
    });

    it('asks for what an asset needs before it sends anything, and offers the accepted handovers and the units of the tenant only', async () => {
      const h = open(world(), { permissions: ACCOUNTANT });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.asset.register.action'] }));
      expect(Array.from((document.getElementById('asset-handover') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['ast.asset.field.handover.choose'],
        'BG-001 · HD-A-002',
        'BG-002 · HD-A-002',
      ]);
      await waitFor(() =>
        expect(Array.from((document.getElementById('asset-unit') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
          vi_['ast.asset.field.unit.choose'],
          'Sở Giao thông',
          'Ban Quản lý',
        ]),
      );
      submit(vi_['ast.asset.register.submit']);
      expect(within(dialog()).getAllByText(vi_['ast.asset.problem.required'])).toHaveLength(6);
      expect(commandsOf(h, 'registerAsset')).toHaveLength(0);
      fill({ 'asset-handover': handoverId(1), 'asset-code': 'AS-001', 'asset-name': 'Trạm bơm', 'asset-unit': unitId(1), 'asset-value': '12.5', 'asset-basis': 'CONTRACT_VALUE' });
      submit(vi_['ast.asset.register.submit']);
      expect(within(dialog()).getByText(vi_['ast.asset.problem.amount'])).toBeTruthy();
      expect(commandsOf(h, 'registerAsset')).toHaveLength(0);
    });

    it('AC-ST-AST-002-1, UAT-AC389: sends the asset with the project of the handover, once, and closes', async () => {
      const h = open(world(), { permissions: ACCOUNTANT, query: `?handover=${handoverId(1)}` });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.asset.register.action'] }));
      expect((document.getElementById('asset-handover') as HTMLSelectElement).value).toBe(handoverId(1));
      await waitFor(() => expect(Array.from((document.getElementById('asset-unit') as HTMLSelectElement).options)).toHaveLength(3));
      fill({
        'asset-code': ' AS-001 ',
        'asset-name': ' Trạm bơm ',
        'asset-unit': unitId(2),
        'asset-value': '5000000000',
        'asset-basis': 'APPRAISED_VALUE',
        'asset-funding': 'Ngân sách',
        'asset-warranty': '2027-10-24',
      });
      submit(vi_['ast.asset.register.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'registerAsset')).toEqual([
        expect.objectContaining({
          body: {
            project_id: '00000000-0000-4000-8000-000000010001',
            handover_id: handoverId(1),
            asset_code: 'AS-001',
            name: 'Trạm bơm',
            recipient_unit_id: unitId(2),
            value_vnd: '5000000000',
            value_basis: 'APPRAISED_VALUE',
            funding_origin: 'Ngân sách',
            warranty_until: '2027-10-24',
          },
        }),
      ]);
    });

    it('AC-ST-AST-002-1, UAT-AC389: says, in words, why the server refused, with the figures of a value above the contract', async () => {
      const cases: Array<[unknown, string]> = [
        [
          refusal('VALUE_EXCEEDS_CONTRACT', 422, { total_vnd: '10000000001', contract_value_vnd: '10000000000' }),
          `${vi_['ast.asset.error.valueExceeds']} ${text('ast.asset.error.amounts', { total: amount(10000000001n), contract: amount(10000000000n) })}`,
        ],
        [refusal('ASSET_CODE_DUPLICATE', 409), vi_['ast.asset.error.duplicate']],
        [refusal('HANDOVER_STATE_INVALID', 409), vi_['ast.asset.error.handoverState']],
        [refusal('SCOPE_DENIED', 403), vi_['ast.asset.error.denied']],
      ];
      for (const [error, expected] of cases) {
        open(world(), { permissions: ACCOUNTANT, command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['ast.asset.register.action'] }));
        await waitFor(() => expect(Array.from((document.getElementById('asset-unit') as HTMLSelectElement).options)).toHaveLength(3));
        fill({ 'asset-handover': handoverId(1), 'asset-code': 'AS-001', 'asset-name': 'Trạm bơm', 'asset-unit': unitId(1), 'asset-value': '1', 'asset-basis': 'CONTRACT_VALUE' });
        submit(vi_['ast.asset.register.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        cleanup();
      }
    });

    it('says so when the units cannot be read, and closes without sending from the cross and from the cancel button', async () => {
      const h = open(world({ failing: new Set(['get_resources_organization_unit']) }), { permissions: ACCOUNTANT });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.asset.register.action'] }));
      expect((await within(dialog()).findByTestId('units-failed')).textContent).toBe(vi_['ast.asset.field.unit.failed']);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ast.asset.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['ast.asset.register.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ast.asset.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(commandsOf(h, 'registerAsset')).toHaveLength(0);
    });
  });

  describe('transferring', () => {
    const transferable = () => world({ assets: [asset(1, { version: 4, allowed: { transfer: true } }), asset(2)] });

    it('offers the button only for an asset the server lets the caller transfer, and none in a read-only session', async () => {
      open(transferable());
      await screen.findByTestId('assets');
      expect(
        within(row(assetId(1)))
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual([vi_['ast.asset.transfer.action']]);
      expect(within(row(assetId(2))).queryByRole('button')).toBeNull();
      cleanup();
      open(transferable(), { mode: 'READ_ONLY' });
      await screen.findByTestId('assets');
      expect(within(row(assetId(1))).queryByRole('button')).toBeNull();
    });

    it('AC-ST-AST-002-1, UAT-AC389: asks for the day and the dossier of the commissioning, and sends the transfer under the version shown, with the code typed by hand', async () => {
      const h = open(transferable());
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.asset.transfer.action'] }));
      submit(vi_['ast.asset.transfer.submit']);
      expect(within(dialog()).getByText(vi_['ast.asset.problem.required'])).toBeTruthy();
      expect(commandsOf(h, 'transferAsset')).toHaveLength(0);
      pick('transfer-document', 'nope');
      submit(vi_['ast.asset.transfer.submit']);
      expect(within(dialog()).getByText(vi_['ast.asset.problem.uuid'])).toBeTruthy();
      pick('transfer-document', DOCUMENT);
      pick('transfer-day', '2020-01-01');
      pick('transfer-external', ' TS-2027-009 ');
      submit(vi_['ast.asset.transfer.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'transferAsset')).toEqual([
        {
          path: { id: assetId(1) },
          body: { transferred_on: '2020-01-01', commissioning_document_version_id: DOCUMENT, external_asset_id: 'TS-2027-009' },
          ifMatchVersion: 4,
          attempt: expect.anything(),
        },
      ]);
    });

    it('says why the server refused the transfer', async () => {
      for (const [code, key] of [
        ['ASSET_STATE_INVALID', 'ast.asset.error.assetState'],
        ['HANDOVER_NOT_ACCEPTED', 'ast.asset.error.handoverNotAccepted'],
        ['DOCUMENT_NOT_CLEAN', 'ast.asset.error.notClean'],
        ['VERSION_CONFLICT', 'ast.asset.error.versionConflict'],
      ] as const) {
        open(transferable(), { command: () => Promise.reject(refusal(code, 409)) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['ast.asset.transfer.action'] }));
        pick('transfer-document', DOCUMENT);
        submit(vi_['ast.asset.transfer.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key]);
        cleanup();
      }
    });
  });
});
