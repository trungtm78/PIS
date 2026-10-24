import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import { routeOf } from '../doc/test-support';
import { toCursor } from '../mdm/model';
import type { CursorView } from '../mdm/model';
import { SyncMonitorWorkspace } from './SyncMonitorWorkspace';
import { toInboxEvent } from './inbox/model';
import type { InboxEventView } from './inbox/model';
import { SECOND_TENANT, harness, mountInSession } from './security/test-support';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-10', 'FR-ADM-10');
const OPERATOR = ['adm.integration.operate'];

const cursor = (id: string, code: string, adapter: string, extra: Record<string, unknown> = {}): CursorView =>
  toCursor({ id, connector_code: code, source_scope: 'DEFAULT', adapter_status: adapter, status: 'ACTIVE', last_success_at: null, last_file_sha256: null, last_error_code: null, reset_reason: null, version: 1, ...extra }) as CursorView;
const CURSORS: CursorView[] = [
  cursor('k-proposed', 'TREASURY_STATEMENT_FILE', 'PROPOSED'),
  cursor('k-mock', 'PROCUREMENT_FILE', 'MOCK', { status: 'FAILED', last_error_code: 'FILE_REJECTED', last_success_at: '2026-10-20T10:00:00.000Z' }),
  cursor('k-verified', 'BUDGET_CODE_FILE', 'VERIFIED'),
];

const event = (id: string, status: string, extra: Record<string, unknown> = {}): InboxEventView =>
  toInboxEvent({
    id,
    provider: 'TREASURY',
    event_key: `key-${id}`,
    provider_event_type: 'payment.confirmed',
    status,
    attempts: 3,
    next_attempt_at: null,
    error_code: status === 'FAILED' || status === 'DEAD' ? 'PROVIDER_DOWN' : null,
    received_at: '2026-10-24T09:00:00.000Z',
    processed_at: null,
    payload_kept: true,
    replay_count: 0,
    version: 7,
    ...extra,
  }) as InboxEventView;
const EVENTS: InboxEventView[] = [event('e-failed', 'FAILED'), event('e-dead', 'DEAD', { replay_count: 2 }), event('e-done', 'PROCESSED'), event('e-gone', 'DEAD', { payload_kept: false }), event('e-new', 'RECEIVED')];

const mount = (options: { cursors?: CursorView[]; events?: InboxEventView[]; permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; h?: ReturnType<typeof harness> } = {}) => {
  const h = options.h ?? harness(() => new Error('no read'));
  const view = mountInSession(<SyncMonitorWorkspace route={ROUTE} cursors={options.cursors ?? CURSORS} events={options.events ?? EVENTS} />, h, {
    permissions: 'permissions' in options ? options.permissions : OPERATOR,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  return { h, view };
};
const rowOf = (id: string): HTMLElement => document.querySelector(`[data-event-id="${id}"]`) as HTMLElement;
const open = async (id: string): Promise<void> => {
  await userEvent.setup().click(within(rowOf(id)).getByRole('button', { name: vi_['adm.sync.replay.action'] }));
};
const confirm = async (reason = 'The provider has fixed its endpoint'): Promise<void> => {
  await userEvent.setup().type(screen.getByLabelText(vi_['adm.sync.replay.reason.label']), reason);
  await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.sync.replay.confirm.action'] }));
};

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

describe('SyncMonitorWorkspace (ADM-10)', () => {
  it('shows where each connector has read to, with the same adapter words as the connectors: MOCK red, PROPOSED yellow (AC-ST-ADM-018-3, AC-ST-ADM-018-4, UI-ADM-10)', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.sync.page.title']);
    const cursors = screen.getByTestId('cursors');
    const proposed = cursors.querySelector('[data-cursor-id="k-proposed"]') as HTMLElement;
    expect(within(proposed).getByText(vi_['mdm.cursor.adapter.proposed.pill']).className).toBe('pill warn');
    expect(within(proposed).getByText(vi_['adm.sync.cursor.never.text'])).toBeTruthy();
    const mock = cursors.querySelector('[data-cursor-id="k-mock"]') as HTMLElement;
    expect(within(mock).getByText(vi_['mdm.cursor.adapter.mock.pill']).className).toBe('pill red');
    expect(within(mock).getByText('FILE_REJECTED')).toBeTruthy();
    expect(within(mock).getByText(vi_['mdm.cursor.status.failed.text'])).toBeTruthy();
    expect(within(cursors.querySelector('[data-cursor-id="k-verified"]') as HTMLElement).getByText(vi_['mdm.cursor.adapter.verified.pill']).className).toBe('pill');
  });

  it('lists the events with their status, attempts and error, the dead ones in red, and says how many are dead', () => {
    mount();
    expect(document.querySelectorAll('[data-event-id]')).toHaveLength(5);
    expect(within(rowOf('e-dead')).getByText(vi_['adm.sync.status.dead']).className).toBe('pill red');
    expect(within(rowOf('e-failed')).getByText(vi_['adm.sync.status.failed']).className).toBe('pill warn');
    expect(within(rowOf('e-done')).getByText(vi_['adm.sync.status.processed']).className).toBe('pill');
    expect(within(rowOf('e-new')).getByText(vi_['adm.sync.status.received']).className).toBe('pill gray');
    expect(within(rowOf('e-failed')).getByText('PROVIDER_DOWN')).toBeTruthy();
    expect(within(rowOf('e-dead')).getByText(vi_['adm.sync.events.replayed.text'].replace('{count}', '2'))).toBeTruthy();
    expect(screen.getByTestId('dead-note').textContent).toBe(vi_['adm.sync.events.dead.note'].replace('{count}', '2'));
  });

  it('never shows the raw payload of an event, nor a reference to it (AC-ST-ADM-018-4, UAT-PLAN-12)', () => {
    const leaky = toInboxEvent({
      id: 'e-leak',
      provider: 'TREASURY',
      event_key: 'key-leak',
      status: 'DEAD',
      attempts: 10,
      received_at: '2026-10-24T09:00:00.000Z',
      payload_kept: true,
      version: 1,
      payload: { iban: 'SECRET-PAYLOAD-IBAN' },
      payload_reference: 'tenants/x/webhook/SECRET-PAYLOAD-REFERENCE',
    }) as InboxEventView;
    mount({ events: [leaky] });
    expect(document.body.textContent).not.toContain('SECRET-PAYLOAD');
    expect(screen.getByText(vi_['adm.sync.events.hint'])).toBeTruthy();
  });

  it('filters the events by status', async () => {
    mount();
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['adm.sync.filter.status.label']), 'DEAD');
    expect([...document.querySelectorAll('[data-event-id]')].map((row) => row.getAttribute('data-event-id'))).toEqual(['e-dead', 'e-gone']);
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['adm.sync.filter.status.label']), 'RECEIVED');
    expect(document.querySelectorAll('[data-event-id]')).toHaveLength(1);
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['adm.sync.filter.status.label']), '');
    expect(document.querySelectorAll('[data-event-id]')).toHaveLength(5);
  });

  it('says so when nothing is listed', () => {
    mount({ cursors: [], events: [] });
    expect(screen.getByText(vi_['adm.sync.cursor.empty'])).toBeTruthy();
    expect(screen.getByText(vi_['adm.sync.events.empty'])).toBeTruthy();
    expect(screen.queryByTestId('dead-note')).toBeNull();
    expect(document.querySelector('table')).toBeNull();
  });

  describe('replaying', () => {
    it('is offered for a failed or a dead event that still has its payload, and not for the others', () => {
      mount();
      expect(within(rowOf('e-failed')).getByRole('button', { name: vi_['adm.sync.replay.action'] })).toBeTruthy();
      expect(within(rowOf('e-dead')).getByRole('button', { name: vi_['adm.sync.replay.action'] })).toBeTruthy();
      expect(within(rowOf('e-done')).queryByRole('button')).toBeNull();
      expect(within(rowOf('e-new')).queryByRole('button')).toBeNull();
      expect(within(rowOf('e-gone')).queryByRole('button')).toBeNull();
      expect(within(rowOf('e-gone')).getByTestId('payload-gone').textContent).toBe(vi_['adm.sync.replay.gone.hint']);
    });

    it('asks for a reason of 10 to 2000 characters and sends the version the person saw (AC-ST-ADM-018-2, UAT-AC138)', async () => {
      const { h } = mount({ h: harness(() => new Error('no read'), () => ({ resource_id: 'e-failed', status: 'RECEIVED', resource_version: 8 })) });
      await open('e-failed');
      const panel = screen.getByTestId('replay-panel');
      expect(within(panel).getByText(vi_['adm.sync.replay.hint'])).toBeTruthy();
      await userEvent.setup().click(within(panel).getByRole('button', { name: vi_['adm.sync.replay.confirm.action'] }));
      expect(await within(panel).findByText(vi_['adm.sync.replay.reason.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await confirm();
      await waitFor(() => expect(screen.queryByTestId('replay-panel')).toBeNull());
      expect(h.command).toHaveBeenCalledWith('replayInboxEvent', expect.objectContaining({ path: { inboxEventId: 'e-failed' }, body: { reason: 'The provider has fixed its endpoint' }, ifMatchVersion: 7 }));
    });

    it.each([
      ['INBOX_STATE_INVALID', 409, 'adm.sync.problem.stateInvalid'],
      ['VERSION_CONFLICT', 409, 'adm.sync.problem.conflict'],
      ['RESOURCE_NOT_FOUND', 404, 'adm.sync.problem.notFound'],
      ['SCOPE_DENIED', 403, 'adm.sync.problem.denied'],
    ] as const)('says what happened when the replay is answered %s, and keeps the panel open', async (code, status, key) => {
      mount({ h: harness(() => new Error('no read'), () => new ApiError({ status, code, correlationId: 'c' })) });
      await open('e-dead');
      await confirm();
      expect((await screen.findByTestId('replay-problem')).textContent).toBe(vi_[key]);
      expect(screen.getByTestId('replay-panel')).toBeTruthy();
    });

    it('can be cancelled and starts over with an empty reason when opened again', async () => {
      mount();
      await open('e-failed');
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.sync.replay.reason.label']), 'A reason long enough');
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.sync.replay.cancel.action'] }));
      expect(screen.queryByTestId('replay-panel')).toBeNull();
      await open('e-failed');
      expect((screen.getByLabelText(vi_['adm.sync.replay.reason.label']) as HTMLTextAreaElement).value).toBe('');
    });

    it('is for an operator: no button for a reader, nor while the tenant is suspended, and one while the permissions are not known', () => {
      mount({ permissions: [] });
      expect(screen.queryByRole('button', { name: vi_['adm.sync.replay.action'] })).toBeNull();
      cleanup();
      mount({ permissions: OPERATOR, mode: 'READ_ONLY' });
      expect(screen.queryByRole('button', { name: vi_['adm.sync.replay.action'] })).toBeNull();
      cleanup();
      mount({ permissions: undefined });
      expect(screen.getAllByRole('button', { name: vi_['adm.sync.replay.action'] }).length).toBeGreaterThan(0);
    });
  });

  it('starts over when the tenant is switched', async () => {
    const { view } = mount();
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['adm.sync.filter.status.label']), 'DEAD');
    view.rerenderWith({ permissions: OPERATOR, tenant: SECOND_TENANT });
    expect((screen.getByLabelText(vi_['adm.sync.filter.status.label']) as HTMLSelectElement).value).toBe('');
  });

  it('shows the screen in English', () => {
    translator.setLocale('en');
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en_['adm.sync.page.title']);
    expect(within(rowOf('e-dead')).getByText(en_['adm.sync.status.dead'])).toBeTruthy();
  });
});
