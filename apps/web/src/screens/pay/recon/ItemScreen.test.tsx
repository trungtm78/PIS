import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ItemScreen from './ItemScreen';
import { HANDLER, READER, answer, client, commandsOf, documentId, item, itemId, member, memberId, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-06', 'FR-PAY-06');
const PATH = `/pay/pay-06?item=${itemId(1)}`;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const refusal = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open(state: World, options: { path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<ItemScreen route={ROUTE} />, h, { permissions: options.permissions ?? HANDLER, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const type = (id: string, value: string): void => {
  fireEvent.change(field(id), { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const action = (name: string): HTMLElement | null => document.querySelector(`button[data-action="${name}"]`);

describe('ItemScreen (PAY-06): the work on one difference', () => {
  it('asks for an item when the address names none', async () => {
    open(world(), { path: '/pay/pay-06' });
    expect((await screen.findByTestId('no-item')).textContent).toBe(vi_['pay.item.none']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.item.title']);
    expect(screen.getByText(text('pay.item.footer', { id: 'PAY-06', req: 'FR-PAY-06' }))).toBeTruthy();
    expect((screen.getByRole('link', { name: new RegExp(vi_['pay.item.back']) }) as HTMLAnchorElement).getAttribute('href')).toBe('/pay/pay-05');
  });

  it('UI-PAY-06: shows the two figures, the difference, the source, the owner and the day, and says the figures are never edited', async () => {
    open(world({ items: [item(1, { contract_code: 'HD-A-001', issue_id: itemId(7) })] }));
    await screen.findByTestId('kind');
    expect(screen.getByTestId('kind').textContent).toBe(vi_['pay.recon.kind.amountMismatch']);
    expect(screen.getByTestId('status').textContent).toBe(vi_['pay.recon.status.open']);
    expect(screen.getByTestId('internal').textContent).toBe('1.000.000.000');
    expect(screen.getByTestId('confirmed').textContent).toBe('990.000.000');
    expect(screen.getByTestId('difference').textContent).toBe('-10.000.000');
    expect(screen.getByTestId('project').textContent).toBe('DA-A-001');
    expect(screen.getByTestId('contract').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('voucher').textContent).toBe('CT-0201');
    expect(screen.getByTestId('file').textContent).toBe('KB-A-2026-07-20.csv');
    expect(screen.getByTestId('hash').textContent?.trim()).toBe('ab'.repeat(32));
    expect(screen.getByTestId('owner').textContent).toBe('Kế toán trưởng');
    expect(screen.getByTestId('issue').textContent).toBe(itemId(7));
    expect(screen.getByTestId('keeps').textContent).toBe(vi_['pay.item.keeps']);
    expect(screen.queryByTestId('overdue')).toBeNull();
    expect(screen.queryByTestId('note')).toBeNull();
    expect(screen.queryByTestId('approval')).toBeNull();
  });

  it('says an item is overdue, and shows the note, the day it was closed and the approving document of an item that ended', async () => {
    open(world({ items: [item(1, { overdue: true, status: 'WRITTEN_OFF_APPROVED', resolution_note: 'Không thu hồi được', resolved_at: '2026-07-11T03:00:00.000000Z', approval_document_version_id: documentId(1) }, { assign: false, explain: false, write_off: false })] }));
    await screen.findByTestId('kind');
    expect(screen.getByTestId('overdue').textContent).toBe(vi_['pay.recon.overdue']);
    expect(screen.getByTestId('note').textContent).toBe('Không thu hồi được');
    expect(screen.getByTestId('approval').textContent).toBe(documentId(1));
    expect(screen.getByTestId('resolved-at').textContent).not.toBe('');
    expect(screen.getByTestId('status').textContent).toBe(vi_['pay.recon.status.writtenOff']);
    expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
  });

  it('shows no contract, request or source for an item that has none', async () => {
    open(world({ items: [item(1, { payment_request_id: null, request_no: null, document_no: null, source_file_name: null, source_file_sha256: null, internal_amount_vnd: null, confirmed_amount_vnd: null, difference_vnd: null, owner_name: null })] }));
    await screen.findByTestId('kind');
    for (const cell of ['request', 'voucher', 'file', 'contract']) expect(screen.queryByTestId(cell)).toBeNull();
    expect(screen.getByTestId('internal').textContent).toBe('');
    expect(screen.getByTestId('difference').textContent).toBe('');
    expect(screen.getByTestId('owner').textContent).toBe(memberId(1));
  });

  it('says so when the item is not there, when the read fails, and when the caller may not read', async () => {
    open(world({ items: [] }));
    await waitFor(() => expect(screen.queryByTestId('kind')).toBeNull());
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    open(world({ failing: new Set(['getReconciliationItem']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open(world(), { permissions: ['payment_request.read'] });
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['pay.recon.read.denied']);
  });

  it('offers each command only where the state of the item and the permission of the caller allow it', async () => {
    open(world({ items: [item(1, {}, { explain: true, resolve: false })] }));
    await screen.findByTestId('kind');
    expect([...document.querySelectorAll('button[data-action]')].map((button) => button.getAttribute('data-action'))).toEqual(['assign', 'explain', 'write-off']);
    cleanup();
    open(world({ items: [item(1, { status: 'EXPLAINED' }, { explain: false, resolve: true })] }));
    await screen.findByTestId('kind');
    expect([...document.querySelectorAll('button[data-action]')].map((button) => button.getAttribute('data-action'))).toEqual(['assign', 'resolve', 'write-off']);
    cleanup();
    open(world(), { permissions: READER });
    await screen.findByTestId('kind');
    expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
    cleanup();
    open(world(), { mode: 'READ_ONLY' });
    await screen.findByTestId('kind');
    expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
    cleanup();
    open(world(), { permissions: ['reconciliation.read', 'reconciliation.assign'] });
    await screen.findByTestId('kind');
    expect([...document.querySelectorAll('button[data-action]')].map((button) => button.getAttribute('data-action'))).toEqual(['assign']);
  });

  describe('giving the item to an owner (AC-ST-PAY-007-3)', () => {
    it('asks for an owner and a day still to come, and sends the day in universal time', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-25T05:00:00Z') });
      const h = open(world({ members: [member(1, 'Kế toán trưởng'), member(2, 'Trưởng phòng')] }), { command: () => answer({ status: 'OPEN', resource_version: 2 }) });
      await screen.findByTestId('kind');
      fireEvent.click(action('assign') as HTMLElement);
      await waitFor(() => expect(within(dialog()).getAllByRole('option').length).toBeGreaterThan(2));
      expect(within(dialog()).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['pay.item.assign.owner.choose'], 'Kế toán trưởng', 'Trưởng phòng']);
      expect(field('assign-owner').value).toBe(memberId(1));
      type('assign-owner', '');
      press(vi_['pay.item.assign.submit']);
      expect(await within(dialog()).findAllByText(vi_['pay.recon.problem.required'])).toHaveLength(2);
      type('assign-owner', memberId(2));
      type('assign-due', '2026-07-25T12:00');
      press(vi_['pay.item.assign.submit']);
      expect(await within(dialog()).findByText(vi_['pay.recon.problem.past'])).toBeTruthy();
      expect(commandsOf(h, 'assignReconciliationItem')).toEqual([]);
      type('assign-due', '2026-07-26T10:00');
      press(vi_['pay.item.assign.submit']);
      await waitFor(() => expect(commandsOf(h, 'assignReconciliationItem')).toHaveLength(1));
      expect(commandsOf(h, 'assignReconciliationItem')[0]).toMatchObject({ path: { id: itemId(1) }, ifMatchVersion: 1, body: { owner_membership_id: memberId(2), due_at: '2026-07-26T03:00:00.000Z' } });
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.item.done.assigned']);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('asks for the identifier of the owner when the caller may not list the members, and words a stale version', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-25T05:00:00Z') });
      open(world(), { permissions: ['reconciliation.read', 'reconciliation.assign'], command: () => refusal('VERSION_CONFLICT', {}, 409) });
      await screen.findByTestId('kind');
      fireEvent.click(action('assign') as HTMLElement);
      expect(field('assign-owner').tagName).toBe('INPUT');
      type('assign-owner', 'x');
      type('assign-due', '2026-07-26T10:00');
      press(vi_['pay.item.assign.submit']);
      expect(await within(dialog()).findByText(vi_['pay.recon.problem.uuid'])).toBeTruthy();
      type('assign-owner', memberId(2));
      press(vi_['pay.item.assign.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.recon.error.versionConflict']);
    });
  });

  describe('explaining, resolving and writing off (UAT-AC12, UAT-AC336)', () => {
    it('explains an item with a note and does not send it without one', async () => {
      const h = open(world(), { command: () => answer() });
      await screen.findByTestId('kind');
      fireEvent.click(action('explain') as HTMLElement);
      expect(within(dialog()).getByText(vi_['pay.item.resolve.intro'])).toBeTruthy();
      expect(field('resolve-approval')).toBeNull();
      press(vi_['pay.item.action.explain']);
      expect(await within(dialog()).findByText(vi_['pay.recon.problem.required'])).toBeTruthy();
      expect(commandsOf(h, 'resolveReconciliationItem')).toEqual([]);
      type('resolve-note', 'Kho bạc trừ phí 10.000.000 theo thông báo TB-77');
      press(vi_['pay.item.action.explain']);
      await waitFor(() => expect(commandsOf(h, 'resolveReconciliationItem')).toHaveLength(1));
      expect(commandsOf(h, 'resolveReconciliationItem')[0]).toMatchObject({ path: { id: itemId(1) }, ifMatchVersion: 1, body: { resolution: 'EXPLAINED', note: 'Kho bạc trừ phí 10.000.000 theo thông báo TB-77' } });
      expect(commandsOf(h, 'resolveReconciliationItem')[0]?.body).not.toHaveProperty('approval_document_version_id');
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.item.done.explained']);
    });

    it('resolves an explained item', async () => {
      const h = open(world({ items: [item(1, { status: 'EXPLAINED' }, { explain: false, resolve: true })] }), { command: () => answer({ status: 'RESOLVED' }) });
      await screen.findByTestId('kind');
      fireEvent.click(action('resolve') as HTMLElement);
      type('resolve-note', 'Đã hạch toán khoản phí');
      press(vi_['pay.item.action.resolve']);
      await waitFor(() => expect(commandsOf(h, 'resolveReconciliationItem')[0]?.body.resolution).toBe('RESOLVED'));
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.item.done.resolved']);
    });

    it('asks for the approving document of a write-off, sends it, and words the refusal of the owner and of a missing document', async () => {
      let refuse: Error | undefined = refusal('SELF_APPROVAL_DENIED', {}, 403);
      const h = open(world(), { command: () => refuse ?? answer({ status: 'WRITTEN_OFF_APPROVED' }) });
      await screen.findByTestId('kind');
      fireEvent.click(action('write-off') as HTMLElement);
      expect(within(dialog()).getByText(vi_['pay.item.resolve.writeOff.intro'])).toBeTruthy();
      type('resolve-note', 'Không thu hồi được');
      press(vi_['pay.item.action.writeOff']);
      expect(await within(dialog()).findByText(vi_['pay.recon.problem.required'])).toBeTruthy();
      type('resolve-approval', 'x');
      press(vi_['pay.item.action.writeOff']);
      expect(await within(dialog()).findByText(vi_['pay.recon.problem.uuid'])).toBeTruthy();
      expect(commandsOf(h, 'resolveReconciliationItem')).toEqual([]);
      type('resolve-approval', documentId(1));
      press(vi_['pay.item.action.writeOff']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.recon.error.selfApproval']);
      expect(commandsOf(h, 'resolveReconciliationItem')[0]).toMatchObject({ body: { resolution: 'WRITTEN_OFF', note: 'Không thu hồi được', approval_document_version_id: documentId(1) } });
      refuse = refusal('APPROVAL_REQUIRED');
      press(vi_['pay.item.action.writeOff']);
      await waitFor(() => expect(within(dialog()).getByTestId('refusal').textContent).toBe(vi_['pay.recon.error.approvalRequired']));
      refuse = undefined;
      press(vi_['pay.item.action.writeOff']);
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.item.done.writtenOff']);
    });
  });
});
