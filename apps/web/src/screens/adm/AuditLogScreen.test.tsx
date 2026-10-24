import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import { routeOf } from '../doc/test-support';
import AuditLogScreen from './AuditLogScreen';
import { SECOND_TENANT, harness, mountInSession } from './security/test-support';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-11', 'FR-ADM-11');
const AUDITOR = ['audit_event.read'];
const EXPORTER = ['audit_event.read', 'audit.export'];
const HASH = 'ab12cd34ef56'.padEnd(64, '0');

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `e${n}`,
  seq: 100 - n,
  actor_id: `a000000${n}-0000-4000-8000-000000000001`,
  action: `widget.change.${n}`,
  resource_type: 'widget',
  resource_id: `b000000${n}-0000-4000-8000-000000000001`,
  safe_diff: { n },
  reason: null,
  outcome: 'SUCCESS',
  classification: 'INTERNAL',
  impersonator_id: null,
  on_behalf_of_id: null,
  occurred_at: '2026-03-01T10:00:00.123Z',
  seal_hash: HASH,
  ...extra,
});
const OK_SEAL = { status: 'OK', checked_at: '2026-03-01T11:00:00.000Z', seals: 3, broken: null };
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, next_cursor: null, seal: OK_SEAL, ...extra });

type Query = Record<string, string | number>;
const queryOf = (h: ReturnType<typeof harness>, call: number): Query => (h.read.mock.calls[call]?.[1] as { query: Query }).query;

/** The element a selector finds once the screen has drawn it. */
const found = (selector: string): Promise<HTMLElement> =>
  waitFor(() => {
    const element = document.querySelector(selector);
    if (element === null) throw new Error(`nothing matches ${selector}`);
    return element as HTMLElement;
  });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

describe('AuditLogScreen (ADM-11)', () => {
  it('lists the trail with the outcome, the seal hash and the identities, and reads the first page of the viewer (AC-ST-ADM-016-1)', async () => {
    const h = harness(() => page([row(1), row(2, { outcome: 'DENIED', seal_hash: null, impersonator_id: 'c0000001-0000-4000-8000-000000000001' })]));
    mountInSession(<AuditLogScreen route={ROUTE} />, h, { permissions: AUDITOR });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.audit.page.title']);
    const first = await found('[data-event-id="e1"]');
    expect(within(first).getByText('widget.change.1')).toBeTruthy();
    expect(first.querySelector('[data-seal-hash]')?.textContent).toBe(HASH.slice(0, 12));
    expect(first.querySelector('[data-seal-hash]')?.getAttribute('title')).toBe(HASH);
    const denied = document.querySelector('[data-event-id="e2"]') as HTMLElement;
    expect(denied.getAttribute('data-outcome')).toBe('DENIED');
    expect(within(denied).getByText(vi_['adm.audit.outcome.denied']).className).toContain('red');
    expect(within(denied).getByText(vi_['adm.audit.seal.pending.text'])).toBeTruthy();
    expect(within(denied).getByText(vi_['adm.audit.behalf.impersonator'].replace('{id}', 'c0000001'))).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('get_resources_audit_event', { query: { limit: 50 } });
    expect(screen.queryByRole('button', { name: vi_['adm.audit.export.open.action'] })).toBeNull();
  });

  it('shows the diff as the server redacted it, on request, with the reason', async () => {
    const h = harness(() => page([row(1, { safe_diff: { api_key: '[REDACTED]', note: 'kept' }, reason: 'A stated reason for the change' }), row(2, { safe_diff: null, reason: null })]));
    mountInSession(<AuditLogScreen route={ROUTE} />, h, { permissions: AUDITOR });
    const first = await found('[data-event-id="e1"]');
    const details = first.querySelector('details') as HTMLElement;
    fireEvent.click(within(details).getByText(vi_['adm.audit.diff.show.action']));
    expect(details.querySelector('pre')?.textContent).toContain('"api_key": "[REDACTED]"');
    expect(within(details).getByText(vi_['adm.audit.diff.reason.text'].replace('{reason}', 'A stated reason for the change'))).toBeTruthy();
    expect((document.querySelector('[data-event-id="e2"]') as HTMLElement).querySelector('details')).toBeNull();
  });

  it('shows the banner of a broken chain as an alert with the failing window (AC-ST-ADM-016-3, UI-ADM-11)', async () => {
    const seal = { status: 'BROKEN', checked_at: '2026-03-01T11:00:00.000Z', seals: 3, broken: { seal_id: 's2', from_seq: 41, to_seq: 80, reason: 'ROOT_MISMATCH' } };
    mountInSession(<AuditLogScreen route={ROUTE} />, harness(() => page([row(1)], { seal })), { permissions: AUDITOR });
    const banner = await screen.findByRole('alert');
    expect(banner.getAttribute('data-seal')).toBe('BROKEN');
    expect(within(banner).getByText(vi_['adm.audit.seal.broken.title'])).toBeTruthy();
    expect(within(banner).getByTestId('seal-window').textContent).toBe(
      vi_['adm.audit.seal.broken.window'].replace('{from}', '41').replace('{to}', '80').replace('{reason}', vi_['adm.audit.seal.reason.root']),
    );
  });

  it.each([
    ['ROOT_MISMATCH', 'adm.audit.seal.reason.root'],
    ['SEAL_HASH_MISMATCH', 'adm.audit.seal.reason.hash'],
    ['CHAIN_LINK_MISMATCH', 'adm.audit.seal.reason.link'],
    ['UNSEALED_ROW_IN_GAP', 'adm.audit.seal.reason.gap'],
  ] as const)('words the reason %s of a broken seal', async (reason, key) => {
    const seal = { status: 'BROKEN', checked_at: 'x', seals: 3, broken: { seal_id: 's2', from_seq: 1, to_seq: 2, reason } };
    mountInSession(<AuditLogScreen route={ROUTE} />, harness(() => page([row(1)], { seal })), { permissions: AUDITOR });
    expect((await screen.findByTestId('seal-window')).textContent).toContain(vi_[key]);
  });

  it('keeps the banner of a broken chain when the viewer cannot name the window', async () => {
    const seal = { status: 'BROKEN', checked_at: 'x', seals: 3, broken: null };
    mountInSession(<AuditLogScreen route={ROUTE} />, harness(() => page([row(1)], { seal })), { permissions: AUDITOR });
    expect((await screen.findByRole('alert')).getAttribute('data-seal')).toBe('BROKEN');
    expect(screen.queryByTestId('seal-window')).toBeNull();
  });

  it.each([
    ['OK', { ...OK_SEAL }, 'status'],
    ['STALE', { status: 'STALE', checked_at: '2026-03-01T11:00:00.000Z', seals: 3, broken: null }, 'status'],
    ['UNKNOWN', { status: 'UNKNOWN', checked_at: null, seals: null, broken: null }, 'status'],
  ])('shows a quiet banner for a %s verdict, not an alert', async (status, seal, role) => {
    mountInSession(<AuditLogScreen route={ROUTE} />, harness(() => page([row(1)], { seal })), { permissions: AUDITOR });
    const banner = await found(`[data-seal="${status}"]`);
    expect(banner.getAttribute('role')).toBe(role);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('filters by outcome DENIED and reads again with the filter, showing the refusal with its redacted diff (AC-ST-ADM-016-2, UAT-AC140)', async () => {
    const h = harness((_operation, input) => {
      const query = (input as { query: Query }).query;
      return query.outcome === 'DENIED'
        ? page([row(9, { outcome: 'DENIED', action: 'authz.denied:placeLegalHold', safe_diff: { reason: 'MISSING_PERMISSION', api_key: '[REDACTED]' } })])
        : page([row(1), row(2)]);
    });
    mountInSession(<AuditLogScreen route={ROUTE} />, h, { permissions: AUDITOR });
    await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(2));
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['adm.audit.filter.outcome.label']), 'DENIED');
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.audit.filter.apply.action'] }));
    await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(1));
    const denied = document.querySelector('[data-event-id="e9"]') as HTMLElement;
    expect(denied.getAttribute('data-outcome')).toBe('DENIED');
    fireEvent.click(within(denied).getByText(vi_['adm.audit.diff.show.action']));
    expect(denied.querySelector('pre')?.textContent).toContain('"api_key": "[REDACTED]"');
    expect(queryOf(h, h.read.mock.calls.length - 1)).toEqual({ limit: 50, outcome: 'DENIED' });
  });

  it('sends the other filters as the server reads them and clears them again', async () => {
    const h = harness(() => page([row(1)]));
    mountInSession(<AuditLogScreen route={ROUTE} />, h, { permissions: AUDITOR });
    await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(1));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['adm.audit.filter.actor.label']), '0000000a-0000-4000-8000-000000000001');
    await user.type(screen.getByLabelText(vi_['adm.audit.filter.action.label']), 'widget.change.1');
    await user.type(screen.getByLabelText(vi_['adm.audit.filter.resource.label']), 'widget');
    fireEvent.change(screen.getByLabelText(vi_['adm.audit.filter.from.label']), { target: { value: '2026-03-01T10:00' } });
    fireEvent.change(screen.getByLabelText(vi_['adm.audit.filter.to.label']), { target: { value: '2026-03-02T10:00' } });
    await user.click(screen.getByRole('button', { name: vi_['adm.audit.filter.apply.action'] }));
    await waitFor(() => expect(queryOf(h, h.read.mock.calls.length - 1)).toMatchObject({ actor_id: '0000000a-0000-4000-8000-000000000001', action: 'widget.change.1', resource_type: 'widget' }));
    expect(queryOf(h, h.read.mock.calls.length - 1).from).toBe(new Date('2026-03-01T10:00').toISOString());
    await user.click(screen.getByRole('button', { name: vi_['adm.audit.filter.clear.action'] }));
    await waitFor(() => expect(queryOf(h, h.read.mock.calls.length - 1)).toEqual({ limit: 50 }));
    expect((screen.getByLabelText(vi_['adm.audit.filter.actor.label']) as HTMLInputElement).value).toBe('');
  });

  it('refuses a filter the server would refuse without asking it', async () => {
    const h = harness(() => page([row(1)]));
    mountInSession(<AuditLogScreen route={ROUTE} />, h, { permissions: AUDITOR });
    await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(1));
    const calls = h.read.mock.calls.length;
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['adm.audit.filter.actor.label']), 'not-a-uuid');
    fireEvent.change(screen.getByLabelText(vi_['adm.audit.filter.from.label']), { target: { value: '2026-03-02T10:00' } });
    fireEvent.change(screen.getByLabelText(vi_['adm.audit.filter.to.label']), { target: { value: '2026-03-01T10:00' } });
    await user.click(screen.getByRole('button', { name: vi_['adm.audit.filter.apply.action'] }));
    expect(await screen.findByText(vi_['adm.audit.filter.invalid.error'])).toBeTruthy();
    expect(screen.getByText(vi_['adm.audit.filter.order.error'])).toBeTruthy();
    expect(h.read.mock.calls.length).toBe(calls);
  });

  it('says so in the table when a filter matches nothing, and keeps the filters in reach', async () => {
    const h = harness((_operation, input) => ((input as { query: Query }).query.outcome === 'FAILED' ? page([]) : page([row(1)])));
    mountInSession(<AuditLogScreen route={ROUTE} />, h, { permissions: AUDITOR });
    await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(1));
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['adm.audit.filter.outcome.label']), 'FAILED');
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.audit.filter.apply.action'] }));
    expect(await screen.findByText(vi_['adm.audit.filtered.empty'])).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['adm.audit.filter.apply.action'] })).toBeTruthy();
  });

  it('loads the next page with the cursor and appends it', async () => {
    const h = harness((_operation, input) => ((input as { query: Query }).query.cursor === 'c1' ? page([row(3)]) : page([row(1), row(2)], { next_cursor: 'c1' })));
    mountInSession(<AuditLogScreen route={ROUTE} />, h, { permissions: AUDITOR });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['adm.audit.more.action'] }));
    await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(3));
    expect(queryOf(h, 1)).toEqual({ limit: 50, cursor: 'c1' });
    expect(screen.getByText(vi_['adm.audit.count.text'].replace('{count}', '3'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['adm.audit.more.action'] })).toBeNull();
  });

  it('shows the seven states: loading, empty, denied, signed out, offline and error (UI-ADM-11)', async () => {
    mountInSession(<AuditLogScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: AUDITOR });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    cleanup();

    mountInSession(<AuditLogScreen route={ROUTE} />, harness(() => page([])), { permissions: AUDITOR });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();

    const read = vi.fn();
    mountInSession(<AuditLogScreen route={ROUTE} />, harness(read), { permissions: ['membership.read'] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByRole('form', { name: vi_['adm.audit.filter.title'] })).toBeNull();
    cleanup();

    const failures = [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), 'states.denied.title'],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), 'states.signedOut.title'],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), 'states.offline.title'],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), 'states.error.title'],
    ] as const;
    for (const [failure, key] of failures) {
      mountInSession(<AuditLogScreen route={ROUTE} />, harness(() => failure), { permissions: AUDITOR });
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      cleanup();
    }
  });

  it('reads again when the person retries after a failure', async () => {
    let calls = 0;
    const h = harness(() => (++calls === 1 ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : page([row(1)])));
    mountInSession(<AuditLogScreen route={ROUTE} />, h, { permissions: AUDITOR });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(1));
  });

  it('reads the trail of the other tenant after a switch, never keeping the first tenant rows', async () => {
    const h = harness(() => page([row(1)]));
    const view = mountInSession(<AuditLogScreen route={ROUTE} />, h, { permissions: AUDITOR });
    await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(1));
    const before = h.read.mock.calls.length;
    view.rerenderWith({ permissions: AUDITOR, tenant: SECOND_TENANT });
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows the screen in English', async () => {
    translator.setLocale('en');
    mountInSession(<AuditLogScreen route={ROUTE} />, harness(() => page([row(1)])), { permissions: AUDITOR });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en_['adm.audit.page.title']);
    await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(1));
    expect(screen.getByText(en_['adm.audit.col.seal'])).toBeTruthy();
  });

  describe('the sealed export', () => {
    const open = async (h = harness(() => page([row(1)])), options: Parameters<typeof mountInSession>[2] = { permissions: EXPORTER }) => {
      mountInSession(<AuditLogScreen route={ROUTE} />, h, options);
      await userEvent.setup().click(await screen.findByRole('button', { name: vi_['adm.audit.export.open.action'] }));
      return h;
    };
    const fill = (from: string, to: string): void => {
      fireEvent.change(screen.getByLabelText(vi_['adm.audit.export.from.label']), { target: { value: from } });
      fireEvent.change(screen.getByLabelText(vi_['adm.audit.export.to.label']), { target: { value: to } });
    };
    const submit = async (): Promise<void> => userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.audit.export.submit.action'] }));

    it('is offered to a holder of audit.export and not to a mere reader, nor in read only mode', async () => {
      await open();
      expect(screen.getByTestId('export-panel')).toBeTruthy();
      cleanup();
      mountInSession(<AuditLogScreen route={ROUTE} />, harness(() => page([row(1)])), { permissions: EXPORTER, mode: 'READ_ONLY' });
      await waitFor(() => expect(document.querySelectorAll('[data-event-id]')).toHaveLength(1));
      expect(screen.queryByRole('button', { name: vi_['adm.audit.export.open.action'] })).toBeNull();
    });

    it('asks for the export with the period, the format and the types, and tells the id of the export (AC-ST-ADM-016-1)', async () => {
      const h = await open(harness(() => page([row(1)]), () => ({ operation_id: 'o1', status: 'READY', resource_version: 1, resource_id: 'x-123' })));
      fill('2026-01-01T00:00', '2026-06-01T00:00');
      await userEvent.setup().selectOptions(screen.getByLabelText(vi_['adm.audit.export.format.label']), 'CSV');
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.audit.export.types.label']), 'widget, gadget');
      await submit();
      expect((await screen.findByTestId('export-done')).textContent).toBe(vi_['adm.audit.export.done.text'].replace('{id}', 'x-123'));
      expect(h.command).toHaveBeenCalledWith(
        'exportAuditLog',
        expect.objectContaining({ body: { from: new Date('2026-01-01T00:00').toISOString(), to: new Date('2026-06-01T00:00').toISOString(), format: 'CSV', resource_types: ['widget', 'gadget'] } }),
      );
    });

    it('refuses 367 days before it asks the server', async () => {
      const h = await open();
      fill('2026-01-01T00:00', '2027-01-08T00:00');
      await submit();
      expect(await screen.findByText(vi_['adm.audit.export.range.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('refuses an empty form, a reversed period and a bad type name', async () => {
      const h = await open();
      await submit();
      expect(screen.getAllByText(vi_['adm.audit.export.required.error'])).toHaveLength(2);
      fill('2026-06-01T00:00', '2026-01-01T00:00');
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.audit.export.types.label']), 'Not A Type');
      await submit();
      expect(await screen.findByText(vi_['adm.audit.export.order.error'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.audit.export.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it.each([
      ['EXPORT_RANGE_TOO_LARGE', 422, 'adm.audit.problem.rangeTooLarge'],
      ['SCOPE_DENIED', 403, 'adm.audit.problem.denied'],
      ['FILE_NOT_CLEAN', 422, 'adm.audit.problem.notClean'],
      ['INTERNAL_ERROR', 500, 'adm.audit.problem.general'],
    ] as const)('says what happened when the server answers %s', async (code, status, key) => {
      await open(harness(() => page([row(1)]), () => new ApiError({ status, code, correlationId: 'c' })));
      fill('2026-01-01T00:00', '2026-06-01T00:00');
      await submit();
      expect((await screen.findByRole('alert')).textContent).toBe(vi_[key]);
    });

    it('closes the panel and forgets the confirmation when the form changes', async () => {
      await open(harness(() => page([row(1)]), () => ({ resource_id: 'x-9' })));
      fill('2026-01-01T00:00', '2026-06-01T00:00');
      await submit();
      await screen.findByTestId('export-done');
      fill('2026-01-01T00:00', '2026-06-02T00:00');
      expect(screen.queryByTestId('export-done')).toBeNull();
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.audit.export.close.action'] }));
      expect(screen.queryByTestId('export-panel')).toBeNull();
    });

    it('tells an export it could not name (an answer without an id) without breaking', async () => {
      await open(harness(() => page([row(1)]), () => ({})));
      fill('2026-01-01T00:00', '2026-06-01T00:00');
      await submit();
      expect((await screen.findByTestId('export-done')).textContent).toBe(vi_['adm.audit.export.done.text'].replace('{id}', ''));
    });
  });
});
