import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import RetentionScreen from './RetentionScreen';
import { ACCOUNTANT, DECISION, READER, client, contractId, hold, holdId, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-21', 'FR-CTR-21');
const OK = { operation_id: 'o', status: 'RELEASED', resource_version: 2, resource_id: holdId(9) };
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const amount = (value: bigint): string => new Intl.NumberFormat('vi').format(value);
const money = (value: bigint): string => text('ctr.value.amount', { amount: amount(value) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; query?: string; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<RetentionScreen route={ROUTE} />, h, {
    permissions: options.permissions ?? READER,
    path: `/ctr/ctr-21${options.query ?? `?contract=${contractId(1)}`}`,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const row = (id: string): HTMLElement => document.querySelector(`[data-hold="${id}"]`) as HTMLElement;
const commandsOf = (h: ReturnType<typeof client>, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
const releasable = () =>
  world({
    holds: [
      hold(1, { allowed: { release: true }, condition: { met: true, reason: null } }),
      hold(2, { held_vnd: '50000000', left_vnd: '50000000', release_condition: 'MANUAL_DECISION', condition: { met: false, reason: 'DECISION_REQUIRED' }, allowed: { release: true }, version: 3 }),
    ],
  });

describe('RetentionScreen (CTR-21): the retention by BOQ line', () => {
  it('UI-CTR-21: says which contract it is about and how much it holds back and has released, and lists the holds with their condition, the earliest day, what is released and what is left', async () => {
    open(
      world({
        contract: { id: contractId(1), code: 'HD-A-001', status: 'COMPLETED', retention_held_vnd: '150000000', retention_released_vnd: '40000000' },
        holds: [
          hold(2, {
            status: 'PARTIALLY_RELEASED',
            released_vnd: '40000000',
            left_vnd: '60000000',
            held_vnd: '100000000',
            released_at: '2027-09-02T03:00:00.000000Z',
            condition: { met: true, reason: null },
            release_condition: 'COMPLETION',
          }),
          hold(1, { release_not_before: '2028-03-01', condition: { met: false, reason: 'NOT_BEFORE' } }),
          hold(3, { status: 'RELEASED', released_vnd: '100000000', left_vnd: '0', condition: { met: true, reason: null } }),
        ],
      }),
    );
    await screen.findByTestId('holds');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.retention.page.title']);
    expect(screen.getByText(text('ctr.retention.footer.reference', { id: 'CTR-21', req: 'FR-CTR-21' }))).toBeTruthy();
    expect(screen.getByTestId('contract').textContent).toBe(text('ctr.retention.contract.label', { code: 'HD-A-001' }));
    expect(screen.getByTestId('held-total').textContent).toBe(text('ctr.retention.totals.held', { amount: money(150000000n) }));
    expect(screen.getByTestId('released-total').textContent).toBe(text('ctr.retention.totals.released', { amount: money(40000000n) }));

    const waiting = row(holdId(1));
    expect(within(waiting).getByTestId('item').textContent).toBe('B01');
    expect(within(waiting).getByTestId('description').textContent).toBe('Hạng mục 1');
    expect(within(waiting).getByTestId('held').textContent).toBe(money(100000000n));
    expect(within(waiting).getByTestId('condition').textContent).toBe(vi_['ctr.retention.condition.warrantyEnd']);
    expect(within(waiting).getByTestId('condition-state').textContent).toBe(text('ctr.retention.blocker.notBefore', { day: '2028-03-01' }));
    expect(within(waiting).getByTestId('not-before').textContent).toBe('2028-03-01');
    expect(within(waiting).getByTestId('released').textContent).toBe(money(0n));
    expect(within(waiting).getByTestId('left').textContent).toBe(money(100000000n));
    expect(within(waiting).getByTestId('status').textContent).toBe(vi_['ctr.retention.status.held']);
    expect(within(waiting).queryByRole('button')).toBeNull();

    const part = row(holdId(2));
    expect(within(part).getByTestId('condition').textContent).toBe(vi_['ctr.retention.condition.completion']);
    expect(within(part).getByTestId('condition-state').textContent).toBe(vi_['ctr.retention.condition.met']);
    expect(within(part).getByTestId('not-before').textContent).toBe(vi_['ctr.retention.notBefore.none']);
    expect(within(part).getByTestId('released').textContent).toContain(money(40000000n));
    expect(within(part).getByTestId('released').textContent).toContain(text('ctr.retention.released.on', { day: '2027-09-02' }));
    expect(within(part).getByTestId('left').textContent).toBe(money(60000000n));
    expect(within(part).getByTestId('status').textContent).toBe(vi_['ctr.retention.status.partiallyReleased']);

    const done = row(holdId(3));
    expect(within(done).getByTestId('status').textContent).toBe(vi_['ctr.retention.status.released']);
    expect(within(done).queryByTestId('condition-state')).toBeNull();
  });

  it('asks to choose a contract when none is named, and says so when the contract is not there for the caller', async () => {
    const h = open(world(), { query: '' });
    expect((await screen.findByTestId('no-contract')).textContent).toBe(vi_['ctr.retention.none.notice']);
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open(world({ missing: true }));
    await waitFor(() => expect(document.querySelector('[data-testid="holds"]')).toBeNull());
    expect(screen.queryByTestId('no-contract')).toBeNull();
  });

  it('says when the contract holds nothing back', async () => {
    open(world({ holds: [] }));
    expect((await screen.findByTestId('no-holds')).textContent).toBe(vi_['ctr.retention.empty.notice']);
  });

  it('shows the state of a read that failed and reads again on retry', async () => {
    const state = world({ failing: new Set(['listRetentionHolds']) });
    const h = open(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-holds');
    expect(h.read.mock.calls.filter((call) => call[0] === 'listRetentionHolds').length).toBeGreaterThan(1);
  });

  describe('releasing', () => {
    it('offers the button only for a hold the server lets the caller release, and none in a read-only session', async () => {
      open(releasable(), { permissions: ACCOUNTANT });
      await screen.findByTestId('holds');
      expect(
        within(row(holdId(1)))
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual([vi_['ctr.retention.release.action']]);
      cleanup();
      open(world({ holds: [hold(1)] }), { permissions: ACCOUNTANT });
      await screen.findByTestId('holds');
      expect(within(row(holdId(1))).queryByRole('button')).toBeNull();
      cleanup();
      open(releasable(), { permissions: ACCOUNTANT, mode: 'READ_ONLY' });
      await screen.findByTestId('holds');
      expect(within(row(holdId(1))).queryByRole('button')).toBeNull();
    });

    it('AC-ST-CTR-010-1, UAT-AC309: opens with what is held, asks for a reason and an amount that fits, and sends the release under the version shown, once', async () => {
      const h = open(releasable(), { permissions: ACCOUNTANT });
      fireEvent.click(
        await within(await screen.findByTestId('holds'))
          .findAllByRole('button', { name: vi_['ctr.retention.release.action'] })
          .then((buttons) => buttons[0] as HTMLElement),
      );
      expect(within(dialog()).getByTestId('left').textContent).toBe(text('ctr.retention.release.left', { left: amount(100000000n) }));
      expect((document.getElementById('release-amount') as HTMLInputElement).value).toBe('100000000');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.retention.release.submit'] }));
      expect(within(dialog()).getByText(vi_['ctr.retention.problem.required'])).toBeTruthy();
      pick('release-amount', '100000001');
      pick('release-reason', 'Hết bảo hành');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.retention.release.submit'] }));
      expect(within(dialog()).getByText(vi_['ctr.retention.problem.exceeds'])).toBeTruthy();
      expect(commandsOf(h, 'releaseRetention')).toHaveLength(0);
      pick('release-amount', ' 100000000 ');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.retention.release.submit'] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'releaseRetention')).toEqual([expect.objectContaining({ path: { id: holdId(1) }, body: { amount_vnd: '100000000', reason: 'Hết bảo hành' }, ifMatchVersion: 1 })]);
    });

    it('asks for the decision of the authority when that is the condition, and sends it', async () => {
      const h = open(releasable(), { permissions: ACCOUNTANT });
      await screen.findByTestId('holds');
      fireEvent.click(within(row(holdId(2))).getByRole('button', { name: vi_['ctr.retention.release.action'] }));
      pick('release-reason', 'Có quyết định.');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.retention.release.submit'] }));
      expect(within(dialog()).getByText(vi_['ctr.retention.problem.required'])).toBeTruthy();
      pick('release-decision', DECISION);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.retention.release.submit'] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'releaseRetention')).toEqual([
        expect.objectContaining({ path: { id: holdId(2) }, body: { amount_vnd: '50000000', reason: 'Có quyết định.', decision_document_version_id: DECISION }, ifMatchVersion: 3 }),
      ]);
    });

    it('AC-ST-CTR-010-1, UAT-AC309: says, in words, why the server refused', async () => {
      const cases: Array<[unknown, string]> = [
        [refusal('RELEASE_CONDITION_NOT_MET', 422, { reason: 'WARRANTY_OPEN' }), text('ctr.retention.error.conditionNotMet', { reason: vi_['ctr.retention.blocker.warrantyOpen'] })],
        [
          refusal('RELEASE_CONDITION_NOT_MET', 422, { reason: 'NOT_BEFORE', release_not_before: '2028-03-01' }),
          text('ctr.retention.error.conditionNotMet', { reason: text('ctr.retention.blocker.notBefore', { day: '2028-03-01' }) }),
        ],
        [refusal('RELEASE_EXCEEDS_HELD', 422, { left_vnd: '60000000' }), text('ctr.retention.error.exceedsHeld', { left: amount(60000000n) })],
        [refusal('SELF_APPROVAL_DENIED', 403), vi_['ctr.retention.error.selfApproval']],
        [refusal('VERSION_CONFLICT', 409), vi_['ctr.retention.error.versionConflict']],
        [refusal('SCOPE_DENIED', 403), vi_['ctr.retention.error.denied']],
      ];
      for (const [error, expected] of cases) {
        open(releasable(), { permissions: ACCOUNTANT, command: () => Promise.reject(error) });
        fireEvent.click((await screen.findAllByRole('button', { name: vi_['ctr.retention.release.action'] }))[0] as HTMLElement);
        pick('release-reason', 'Hết bảo hành');
        fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.retention.release.submit'] }));
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        cleanup();
      }
    });

    it('closes without sending from the cross and from the cancel button', async () => {
      const h = open(releasable(), { permissions: ACCOUNTANT });
      fireEvent.click((await screen.findAllByRole('button', { name: vi_['ctr.retention.release.action'] }))[0] as HTMLElement);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.retention.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getAllByRole('button', { name: vi_['ctr.retention.release.action'] })[0] as HTMLElement);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['ctr.retention.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(commandsOf(h, 'releaseRetention')).toHaveLength(0);
    });
  });
});
