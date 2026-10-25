import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { daysLeft, vietnamToday } from './model';
import WarrantyScreen from './WarrantyScreen';
import { GUARANTEE, MANAGER, READER, asset, assetId, client, contractId, handoverId, mount, routeOf, warranty, warrantyId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('AST-04', 'FR-AST-04');
const OK = { operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: warrantyId(9) };
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
  mount(<WarrantyScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: `/ast/ast-04${options.query ?? ''}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const rows = (): string[] => Array.from(document.querySelectorAll('[data-warranty]')).map((row) => row.getAttribute('data-warranty') as string);
const row = (id: string): HTMLElement => document.querySelector(`[data-warranty="${id}"]`) as HTMLElement;
const submit = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const commandsOf = (h: ReturnType<typeof client>, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown> }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown> });
const fill = (values: Record<string, string>): void => {
  for (const [id, value] of Object.entries(values)) pick(id, value);
};

describe('WarrantyScreen (AST-04): the warranty and what is held back', () => {
  it('UI-AST-04: lists the obligations with what they cover, the term and the days left, the rule they wait for, the guarantee, the amount held back, the claims and the status', async () => {
    open(
      world({
        warranties: [
          warranty(3, { status: 'CLOSED', closed_at: '2027-09-05T03:00:00.000000Z', ends_on: '2027-09-01' }),
          warranty(2, {
            status: 'EXPIRED',
            ends_on: '2026-01-01',
            starts_on: '2025-01-01',
            open_claims: 1,
            total_claims: 2,
            allowed: { close: true },
            guarantee: { id: GUARANTEE, guarantee_no: 'BL-1', issuer: 'Ngân hàng', amount_vnd: '500000000', expires_on: '2028-01-01' },
            asset: { id: assetId(1), asset_code: 'AS-001', name: 'Trạm bơm 1' },
          }),
          warranty(1, { construction_grade: null, rule: { version_id: 'v', awaiting_confirmation: false, cxn: null } }),
        ],
      }),
    );
    await screen.findByTestId('warranties');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ast.warranty.page.title']);
    expect(screen.getByText(text('ast.warranty.footer.reference', { id: 'AST-04', req: 'FR-AST-04' }))).toBeTruthy();
    expect(rows()).toEqual([warrantyId(3), warrantyId(2), warrantyId(1)]);

    const running = row(warrantyId(1));
    expect(within(running).getByTestId('scope').textContent).toBe('Phạm vi bảo hành 1');
    expect(within(running).getByTestId('handover').textContent).toBe('BG-001 · HD-A-002');
    expect(within(running).getByTestId('term').textContent).toBe(text('ast.warranty.term.range', { from: '2026-09-01', to: '2999-09-01' }));
    expect(running.textContent).toContain(`${text('ast.warranty.term.months', { months: 12 })} · ${vi_['ast.warranty.grade.unknown']}`);
    expect(within(running).getByTestId('left').textContent).toBe(text('ast.warranty.term.left', { days: daysLeft('2999-09-01', vietnamToday()) }));
    expect(within(running).queryByTestId('rule-waiting')).toBeNull();
    expect(within(running).getByTestId('guarantee').textContent).toBe(vi_['ast.warranty.guarantee.none']);
    expect(within(running).getByTestId('retention').textContent).toBe(text('ctr.value.amount', { amount: amount(150000000n) }));
    expect(within(running).getByTestId('claims').textContent).toBe(text('ast.warranty.claims.count', { open: 0, total: 0 }));
    expect(within(running).getByTestId('status').textContent).toBe(vi_['ast.warranty.status.active']);
    expect(within(running).queryByRole('button')).toBeNull();

    const expired = row(warrantyId(2));
    expect(within(expired).getByTestId('left').textContent).toBe(vi_['ast.warranty.term.over']);
    expect(within(expired).getByTestId('rule-waiting').textContent).toBe(text('ast.warranty.rule.waiting', { months: 12, cxn: 'CXN-EXE-04' }));
    expect(within(expired).getByTestId('guarantee').textContent).toContain('Ngân hàng · BL-1');
    expect(within(expired).getByTestId('guarantee').textContent).toContain(text('ctr.value.amount', { amount: amount(500000000n) }));
    expect(within(expired).getByTestId('asset').textContent).toBe('AS-001 · Trạm bơm 1');
    expect(within(expired).getByTestId('claims').textContent).toBe(text('ast.warranty.claims.count', { open: 1, total: 2 }));
    expect(within(expired).getByTestId('status').textContent).toBe(vi_['ast.warranty.status.expired']);
    expect(
      within(expired)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([vi_['ast.warranty.close.action']]);

    const closed = row(warrantyId(3));
    expect(within(closed).getByTestId('status').textContent).toBe(vi_['ast.warranty.status.closed']);
    expect(closed.textContent).toContain(text('ast.warranty.closed.on', { day: '2027-09-05' }));
    expect(within(closed).queryByTestId('left')).toBeNull();
  });

  it('says when there is no obligation, and offers the accepted handovers as a filter that narrows the list', async () => {
    open(world({ warranties: [warranty(1), warranty(2, { handover: { id: handoverId(2), handover_no: 'BG-002', status: 'ACCEPTED' } })] }));
    await screen.findByTestId('warranties');
    const options = Array.from((document.getElementById('warranty-filter') as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual([vi_['ast.warranty.filter.all'], 'BG-001 · HD-A-002', 'BG-002 · HD-A-002']);
    pick('warranty-filter', handoverId(2));
    await waitFor(() => expect(rows()).toEqual([warrantyId(2)]));
    pick('warranty-filter', '');
    await waitFor(() => expect(rows()).toEqual([warrantyId(1), warrantyId(2)]));
    cleanup();
    open(world({ warranties: [] }));
    expect((await screen.findByTestId('no-warranties')).textContent).toBe(vi_['ast.warranty.none.notice']);
  });

  it('reads the handover named in the address, and ignores one the scope does not hold', async () => {
    open(world({ warranties: [warranty(1), warranty(2, { handover: { id: handoverId(2), handover_no: 'BG-002', status: 'ACCEPTED' } })] }), { query: `?handover=${handoverId(2)}` });
    await waitFor(() => expect(rows()).toEqual([warrantyId(2)]));
    cleanup();
    open(world({ warranties: [warranty(1)] }), { query: '?handover=00000000-0000-4000-8000-0000000000ff' });
    await waitFor(() => expect(rows()).toEqual([warrantyId(1)]));
  });

  it('still lists the obligations for whoever may not read the handovers, without the filter or the button to create one', async () => {
    open(world({ warranties: [warranty(1)], failing: new Set(['get_resources_handover']) }), { permissions: MANAGER });
    await screen.findByTestId('warranties');
    expect(document.getElementById('warranty-filter')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['ast.warranty.create.action'] })).toBeNull();
  });

  it('shows the state of a read that failed and reads again on retry', async () => {
    const state = world({ failing: new Set(['listWarrantyObligations']) });
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-warranties');
    expect(h.read.mock.calls.filter((call) => call[0] === 'listWarrantyObligations').length).toBeGreaterThan(1);
  });

  describe('creating', () => {
    it('offers the button only to whoever may, and not in a read-only session', async () => {
      open(world(), { permissions: READER });
      await screen.findByTestId('no-warranties');
      expect(screen.queryByRole('button', { name: vi_['ast.warranty.create.action'] })).toBeNull();
      cleanup();
      open(world(), { permissions: MANAGER, mode: 'READ_ONLY' });
      await screen.findByTestId('no-warranties');
      expect(screen.queryByRole('button', { name: vi_['ast.warranty.create.action'] })).toBeNull();
    });

    it('asks for what an obligation needs before it sends anything, and offers the accepted handovers, the grades and the assets of the handover chosen', async () => {
      const h = open(world({ assets: [asset(1), asset(2, { handover: { id: handoverId(2), handover_no: 'BG-002', status: 'ACCEPTED' } })] }), { permissions: MANAGER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.warranty.create.action'] }));
      expect(Array.from((document.getElementById('warranty-handover') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['ast.warranty.field.handover.choose'],
        'BG-001 · HD-A-002',
        'BG-002 · HD-A-002',
      ]);
      expect(Array.from((document.getElementById('warranty-grade') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['ast.warranty.grade.unknown'],
        vi_['ast.warranty.grade.special'],
        vi_['ast.warranty.grade.i'],
        vi_['ast.warranty.grade.ii'],
        vi_['ast.warranty.grade.iii'],
        vi_['ast.warranty.grade.iv'],
      ]);
      expect(Array.from((document.getElementById('warranty-asset') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([vi_['ast.warranty.field.asset.whole']]);
      submit(vi_['ast.warranty.create.submit']);
      expect(within(dialog()).getAllByText(vi_['ast.warranty.problem.required'])).toHaveLength(4);
      expect(within(dialog()).getByText(vi_['ast.warranty.problem.cover'])).toBeTruthy();
      expect(commandsOf(h, 'registerAsset')).toHaveLength(0);
      expect(commandsOf(h, 'createWarrantyObligation')).toHaveLength(0);
      const assetOptions = (): Array<string | null> => Array.from((document.getElementById('warranty-asset') as HTMLSelectElement).options).map((option) => option.textContent);
      pick('warranty-handover', handoverId(1));
      await waitFor(() => expect(assetOptions()).toEqual([vi_['ast.warranty.field.asset.whole'], 'AS-001 · Trạm bơm 1']));
      pick('warranty-handover', handoverId(2));
      await waitFor(() => expect(assetOptions()).toEqual([vi_['ast.warranty.field.asset.whole'], 'AS-002 · Trạm bơm 2']));
    });

    it('AC-ST-AST-003-1, UAT-AC390: sends the obligation with the contract of the handover, once, and closes', async () => {
      const h = open(world(), { permissions: MANAGER, query: `?handover=${handoverId(1)}` });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.warranty.create.action'] }));
      expect((document.getElementById('warranty-handover') as HTMLSelectElement).value).toBe(handoverId(1));
      await waitFor(() => expect(Array.from((document.getElementById('warranty-asset') as HTMLSelectElement).options)).toHaveLength(2));
      fill({
        'warranty-asset': assetId(1),
        'warranty-scope': ' Toàn bộ nhà bơm ',
        'warranty-starts': '2026-09-01',
        'warranty-period': '12',
        'warranty-grade': 'II',
        'warranty-guarantee': GUARANTEE,
        'warranty-retention': '150000000',
      });
      submit(vi_['ast.warranty.create.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'createWarrantyObligation')).toEqual([
        expect.objectContaining({
          body: {
            contract_id: contractId(2),
            handover_id: handoverId(1),
            asset_id: assetId(1),
            scope_description: 'Toàn bộ nhà bơm',
            starts_on: '2026-09-01',
            period_months: 12,
            construction_grade: 'II',
            warranty_guarantee_id: GUARANTEE,
            retention_amount_vnd: '150000000',
          },
        }),
      ]);
    });

    it('AC-ST-AST-003-1, UAT-AC390: says, in words, why the server refused', async () => {
      const cases: Array<[unknown, string]> = [
        [refusal('WARRANTY_PERIOD_BELOW_MINIMUM', 422, { minimum_months: 12, period_months: 6 }), text('ast.warranty.error.belowMinimum', { minimum: 12, period: 6 })],
        [refusal('NO_EFFECTIVE_RULE'), vi_['ast.warranty.error.noRule']],
        [refusal('GUARANTEE_REQUIRED'), vi_['ast.warranty.error.guaranteeRequired']],
        [refusal('HANDOVER_NOT_ACCEPTED'), vi_['ast.warranty.error.handoverNotAccepted']],
        [refusal('WARRANTY_STATE_INVALID', 409), vi_['ast.warranty.error.stateInvalid']],
        [refusal('SCOPE_DENIED', 403), vi_['ast.warranty.error.denied']],
      ];
      for (const [error, expected] of cases) {
        open(world(), { permissions: MANAGER, command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['ast.warranty.create.action'] }));
        fill({ 'warranty-handover': handoverId(1), 'warranty-scope': 'Nhà bơm', 'warranty-starts': '2026-09-01', 'warranty-period': '6', 'warranty-retention': '1' });
        submit(vi_['ast.warranty.create.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        cleanup();
      }
    });

    it('closes without sending from the cross and from the cancel button', async () => {
      const h = open(world(), { permissions: MANAGER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.warranty.create.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ast.warranty.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['ast.warranty.create.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ast.warranty.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(commandsOf(h, 'createWarrantyObligation')).toHaveLength(0);
    });
  });

  describe('closing', () => {
    const closable = () => world({ warranties: [warranty(1, { status: 'EXPIRED', ends_on: '2026-01-01', starts_on: '2025-01-01', allowed: { close: true } }), warranty(2)] });

    it('offers the button only for an obligation the server lets the caller close, and none in a read-only session', async () => {
      open(closable(), { permissions: MANAGER });
      await screen.findByTestId('warranties');
      expect(
        within(row(warrantyId(1)))
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual([vi_['ast.warranty.close.action']]);
      expect(within(row(warrantyId(2))).queryByRole('button')).toBeNull();
      cleanup();
      open(closable(), { permissions: MANAGER, mode: 'READ_ONLY' });
      await screen.findByTestId('warranties');
      expect(within(row(warrantyId(1))).queryByRole('button')).toBeNull();
    });

    it('AC-ST-AST-003-2, UAT-AC392: says what closing lets happen, and sends the note once', async () => {
      const h = open(closable(), { permissions: MANAGER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.warranty.close.action'] }));
      expect(within(dialog()).getByTestId('close-notice').textContent).toBe(vi_['ast.warranty.close.notice']);
      pick('warranty-note', 'x'.repeat(2001));
      submit(vi_['ast.warranty.close.submit']);
      expect(within(dialog()).getByText(vi_['ast.warranty.problem.tooLong'])).toBeTruthy();
      expect(commandsOf(h, 'closeWarrantyObligation')).toHaveLength(0);
      pick('warranty-note', ' Đã xử lý hết ');
      submit(vi_['ast.warranty.close.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'closeWarrantyObligation')).toEqual([expect.objectContaining({ path: { id: warrantyId(1) }, body: { note: 'Đã xử lý hết' } })]);
    });

    it('AC-ST-AST-003-2, UAT-AC392: says which claims are still open, and that the warranty has not run out', async () => {
      const cases: Array<[unknown, string]> = [
        [refusal('OPEN_WARRANTY_CLAIMS', 422, { open_claims: 2, claim_nos: ['WC-001', 'WC-002'] }), text('ast.warranty.error.openClaims', { count: 2, claims: 'WC-001, WC-002' })],
        [refusal('WARRANTY_NOT_EXPIRED', 422, { ends_on: '2027-09-01' }), text('ast.warranty.error.notExpired', { day: '2027-09-01' })],
        [refusal('WARRANTY_STATE_INVALID', 409), vi_['ast.warranty.error.stateInvalid']],
        [refusal('RESOURCE_NOT_FOUND', 404), vi_['ast.warranty.error.notFound']],
      ];
      for (const [error, expected] of cases) {
        open(closable(), { permissions: MANAGER, command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['ast.warranty.close.action'] }));
        submit(vi_['ast.warranty.close.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        cleanup();
      }
    });
  });
});
