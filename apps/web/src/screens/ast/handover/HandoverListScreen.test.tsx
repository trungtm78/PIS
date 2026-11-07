import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import HandoverListScreen from './HandoverListScreen';
import { DOCUMENT, DRAFTER, MINUTES, PROJECT, READER, client, contractId, handover, handoverId, mount, routeOf, unitId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('AST-01', 'FR-AST-01');
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: handoverId(9) };
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; query?: string; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<HandoverListScreen route={ROUTE} />, h, {
    permissions: options.permissions ?? READER,
    path: `/ast/ast-01${options.query ?? ''}`,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const rows = (): string[] => Array.from(document.querySelectorAll('[data-handover]')).map((row) => row.getAttribute('data-handover') as string);
/** The number of the handover is marked in its cell; the row is the table row around it. */
const row = (id: string): HTMLElement => (document.querySelector(`[data-handover="${id}"]`) as HTMLElement).closest('tr') as HTMLElement;
const submit = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const commandsOf = (h: ReturnType<typeof client>, operation: string): Array<{ body: Record<string, unknown> }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { body: Record<string, unknown> });

describe('HandoverListScreen (AST-01): the handovers', () => {
  it('UI-AST-01: lists the handovers of the scope with the unit that receives the work, the critical defects still open and the status, each with a link to its minutes', async () => {
    open(
      world({
        handovers: [handover(2, { status: 'PUNCH_PENDING', open_critical_punch_count: 2, punch_item_count: 4 }), handover(1, { status: 'ACCEPTED', handover_kind: 'PARTIAL', punch_item_count: 1 })],
      }),
    );
    await screen.findByTestId('handovers');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ast.handover.list.title']);
    expect(screen.getByText(text('ast.handover.footer.reference', { id: 'AST-01', req: 'FR-AST-01' }))).toBeTruthy();
    expect(rows()).toEqual([handoverId(2), handoverId(1)]);
    const first = row(handoverId(2));
    expect(within(first).getByTestId('no').textContent).toBe('BG-002');
    expect(within(first).getByTestId('contract').textContent).toBe('HD-A-002');
    expect(within(first).getByTestId('kind').textContent).toBe(vi_['ast.handover.kind.completion']);
    expect(within(first).getByTestId('unit').textContent).toBe('Sở Giao thông');
    expect(within(first).getByTestId('critical').textContent).toContain(text('ast.handover.critical.notice', { count: 2 }));
    expect(within(first).getByTestId('critical').textContent).toContain(text('ast.handover.items.count', { count: 4 }));
    expect(within(first).getByTestId('status').textContent).toBe(vi_['ast.handover.status.punchPending']);
    expect(within(first).getByRole('link', { name: vi_['ast.handover.open.action'] }).getAttribute('href')).toBe(`/ast/ast-02?id=${handoverId(2)}`);
    const second = row(handoverId(1));
    expect(within(second).getByTestId('critical').textContent).toContain(vi_['ast.handover.critical.none']);
    expect(within(second).getByTestId('kind').textContent).toBe(vi_['ast.handover.kind.partial']);
    expect(within(second).getByTestId('status').textContent).toBe(vi_['ast.handover.status.accepted']);
    expect(screen.queryByRole('button', { name: vi_['ast.handover.create.action'] })).toBeNull();
  });

  it('says when there is no handover, and offers the contracts of the scope as a filter that narrows the list', async () => {
    open(world({ handovers: [handover(1), handover(2, { contract: { id: contractId(3), code: 'HD-A-003', status: 'COMPLETED' } })] }));
    await screen.findByTestId('handovers');
    const options = Array.from((document.getElementById('handovers-contract') as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual([vi_['ast.handover.filter.all'], 'HD-A-001 · Hợp đồng số 1', 'HD-A-002', 'HD-A-003 · Hợp đồng số 3']);
    pick('handovers-contract', contractId(3));
    await waitFor(() => expect(rows()).toEqual([handoverId(2)]));
    pick('handovers-contract', contractId(1));
    expect((await screen.findByTestId('no-handovers')).textContent).toBe(vi_['ast.handover.none.notice']);
    pick('handovers-contract', '');
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('reads the contract named in the address, and ignores one the scope does not hold', async () => {
    open(world({ handovers: [handover(1), handover(2, { contract: { id: contractId(3), code: 'HD-A-003', status: 'COMPLETED' } })] }), { query: `?contract=${contractId(3)}` });
    await waitFor(() => expect(rows()).toEqual([handoverId(2)]));
    cleanup();
    open(world({ handovers: [handover(1)] }), { query: '?contract=00000000-0000-4000-8000-0000000000ff' });
    await waitFor(() => expect(rows()).toEqual([handoverId(1)]));
  });

  it('still lists the handovers for whoever may not read the register, without the filter or the button to draft one', async () => {
    open(world({ handovers: [handover(1)], failing: new Set(['get_resources_contract']) }), { permissions: DRAFTER });
    await screen.findByTestId('handovers');
    expect(document.getElementById('handovers-contract')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['ast.handover.create.action'] })).toBeNull();
  });

  it('shows the state of a read that failed and reads again on retry', async () => {
    const state = world({ failing: new Set(['get_resources_handover']) });
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-handovers');
    expect(h.read.mock.calls.filter((call) => call[0] === 'get_resources_handover').length).toBeGreaterThan(1);
  });

  describe('drafting', () => {
    const fill = (values: Record<string, string>): void => {
      for (const [id, value] of Object.entries(values)) pick(id, value);
    };

    it('offers the button only to whoever may draft, and not in a read-only session', async () => {
      open(world(), { permissions: DRAFTER, mode: 'READ_ONLY' });
      await screen.findByTestId('no-handovers');
      expect(screen.queryByRole('button', { name: vi_['ast.handover.create.action'] })).toBeNull();
    });

    it('asks for what a handover needs before it sends anything, and offers the contracts being performed or completed and the units of the tenant', async () => {
      const h = open(world(), { permissions: DRAFTER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.create.action'] }));
      const contracts = Array.from((document.getElementById('handover-contract') as HTMLSelectElement).options).map((option) => option.textContent);
      expect(contracts).toEqual([vi_['ast.handover.field.contract.choose'], 'HD-A-002', 'HD-A-003 · Hợp đồng số 3']);
      await waitFor(() =>
        expect(Array.from((document.getElementById('handover-unit') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
          vi_['ast.handover.field.unit.choose'],
          'Sở Giao thông',
          'Ban Quản lý',
        ]),
      );
      submit(vi_['ast.handover.create.submit']);
      expect(within(dialog()).getAllByText(vi_['ast.handover.problem.required'])).toHaveLength(5);
      expect(commandsOf(h, 'createHandover')).toHaveLength(0);
      fill({ 'handover-contract': contractId(2), 'handover-kind': 'COMPLETION', 'handover-no': 'BG-1', 'handover-unit': unitId(1), 'handover-minutes': 'nope', 'handover-document': 'nope' });
      submit(vi_['ast.handover.create.submit']);
      expect(within(dialog()).getAllByText(vi_['ast.handover.problem.uuid'])).toHaveLength(2);
      expect(commandsOf(h, 'createHandover')).toHaveLength(0);
    });

    it('AC-ST-AST-001-2, UAT-AC65: sends the handover with the project of the contract, once, and closes', async () => {
      const h = open(world(), { permissions: DRAFTER, query: `?contract=${contractId(2)}` });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.create.action'] }));
      expect((document.getElementById('handover-contract') as HTMLSelectElement).value).toBe(contractId(2));
      await waitFor(() => expect(Array.from((document.getElementById('handover-unit') as HTMLSelectElement).options)).toHaveLength(3));
      fill({ 'handover-kind': 'COMPLETION', 'handover-no': ' BG-1 ', 'handover-unit': unitId(2), 'handover-minutes': MINUTES, 'handover-planned': '2026-11-10', 'handover-document': DOCUMENT });
      submit(vi_['ast.handover.create.submit']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'createHandover')).toEqual([
        expect.objectContaining({
          body: {
            project_id: PROJECT,
            contract_id: contractId(2),
            recipient_unit_id: unitId(2),
            handover_kind: 'COMPLETION',
            handover_no: 'BG-1',
            document_version_id: DOCUMENT,
            quality_acceptance_id: MINUTES,
            planned_on: '2026-11-10',
          },
        }),
      ]);
    });

    it('says, in words, what the server refused and keeps the dialog open', async () => {
      const cases: Array<[string, number, string]> = [
        ['CONTRACT_STATE_INVALID', 409, 'ast.handover.error.contractState'],
        ['QUALITY_ACCEPTANCE_REQUIRED', 422, 'ast.handover.error.minutesRequired'],
        ['PERMIT_GATE_BLOCKED', 409, 'ast.handover.error.permitGate'],
        ['DOCUMENT_NOT_CLEAN', 422, 'ast.handover.error.notClean'],
        ['SCOPE_DENIED', 403, 'ast.handover.error.denied'],
      ];
      for (const [code, status, key] of cases) {
        open(world(), { permissions: DRAFTER, command: () => Promise.reject(refusal(code, status)) });
        fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.create.action'] }));
        await waitFor(() => expect(Array.from((document.getElementById('handover-unit') as HTMLSelectElement).options)).toHaveLength(3));
        fill({ 'handover-contract': contractId(2), 'handover-kind': 'PARTIAL', 'handover-no': 'BG-1', 'handover-unit': unitId(1), 'handover-document': DOCUMENT });
        submit(vi_['ast.handover.create.submit']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
        cleanup();
      }
    });

    it('says so when the units cannot be read, and closes without sending from the cross and from the cancel button', async () => {
      const h = open(world({ failing: new Set(['get_resources_organization_unit']) }), { permissions: DRAFTER });
      fireEvent.click(await screen.findByRole('button', { name: vi_['ast.handover.create.action'] }));
      expect((await within(dialog()).findByTestId('units-failed')).textContent).toBe(vi_['ast.handover.field.unit.failed']);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ast.handover.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['ast.handover.create.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ast.handover.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(commandsOf(h, 'createHandover')).toHaveLength(0);
    });
  });
});
