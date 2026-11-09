import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import viJson from '../../../i18n/vi.json';
import { harness, mountInSession } from '../security/test-support';
import LogCapacityScreen from './LogCapacityScreen';
import { byteText, classRows, toOverview, toSaveBody, validateCap } from './model';

const vi_ = viJson as Record<string, string>;
const ROUTE = { id: 'ADM-30', req: 'FR-ADM-LOG-CAPACITY', title: 'x', path: '/adm/adm-30', kind: 'table', area: 'admin', module: 'ADM', group: 'g', role: 'workspace', parent: null } as never;

afterEach(cleanup);

const reading = (recordClass: string, overrides: Record<string, unknown> = {}) => ({
  record_class: recordClass,
  kind: 'TECHNICAL',
  rows: 900,
  bytes: 2_097_152,
  bytes_estimated: false,
  eligible_rows: 400,
  protected_rows: 500,
  state: 'NEAR',
  measured_at: '2026-11-09T01:00:00.000Z',
  ...overrides,
});
const cap = (recordClass: string, overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  record_class: recordClass,
  max_rows: 1000,
  max_bytes: null,
  warn_pct: 80,
  active: true,
  reason: 'capacity plan',
  version: 2,
  updated_at: '2026-11-08T01:00:00.000Z',
  updated_by: '00000000-0000-4000-8000-000000000001',
  ...overrides,
});
const overview = (extra: Record<string, unknown> = {}) => ({
  policies: [cap('outbox_event')],
  readings: [reading('outbox_event'), reading('audit_event', { kind: 'MONITOR_ONLY', state: 'UNCAPPED', rows: 5, eligible_rows: 0, protected_rows: 5 })],
  batches: [],
  as_of: '2026-11-09T02:00:00.000Z',
  ...extra,
});
const MANAGER = ['adm.log_capacity.read', 'adm.log_capacity.manage'];

describe('the log capacity model', () => {
  it('lists every class of the platform, with the share of the cap in use', () => {
    const rows = classRows(toOverview(overview()));
    expect(rows.map((row) => row.recordClass)).toEqual(['idempotency_record', 'outbox_event', 'integration_event_inbox', 'user_session', 'delivery_attempt', 'audit_event', 'audit_event_detail']);
    const outbox = rows.find((row) => row.recordClass === 'outbox_event');
    expect(outbox?.rowsPct).toBe(90);
    expect(outbox?.state).toBe('NEAR');
    expect(rows.find((row) => row.recordClass === 'audit_event')?.kind).toBe('MONITOR_ONLY');
  });

  it('judges the form: one limit at least, whole numbers, the warning share and the reason', () => {
    const base = { recordClass: 'outbox_event', maxRows: '', maxBytes: '', warnPct: '80', active: true, reason: 'capacity plan' };
    expect(validateCap(base)).toEqual({ limit: 'required' });
    expect(validateCap({ ...base, maxRows: '1000' })).toEqual({});
    expect(validateCap({ ...base, maxRows: '12a' }).maxRows).toBe('format');
    expect(validateCap({ ...base, maxBytes: '1000' }).maxBytes).toBe('range');
    expect(validateCap({ ...base, maxRows: '10', warnPct: '20' }).warnPct).toBe('range');
    expect(validateCap({ ...base, maxRows: '10', reason: 'no' }).reason).toBe('required');
    expect(toSaveBody({ ...base, maxRows: '1000' }, undefined)).toMatchObject({ max_rows: 1000, max_bytes: null, expected_version: 0 });
  });

  it('writes bytes for people', () => {
    expect(byteText(512)).toBe('512 B');
    expect(byteText(2_097_152)).toBe('2.0 MiB');
  });
});

describe('LogCapacityScreen (ADM-30)', () => {
  it('shows each class with its state, and never offers to purge the audit trail', async () => {
    mountInSession(<LogCapacityScreen route={ROUTE} />, harness(() => overview()), { permissions: MANAGER });
    const table = await screen.findByTestId('classes');
    const outbox = table.querySelector('tr[data-record-class="outbox_event"]') as HTMLElement;
    expect(outbox.getAttribute('data-state')).toBe('NEAR');
    const audit = table.querySelector('tr[data-record-class="audit_event"]') as HTMLElement;
    expect(within(audit).getByText(vi_['adm.logCapacity.neverPurged'])).toBeTruthy();
    expect(screen.getByTestId('no-batches')).toBeTruthy();
  });

  it('is denied without the read permission and read-only without the manage permission', async () => {
    mountInSession(<LogCapacityScreen route={ROUTE} />, harness(() => overview()), { permissions: [] });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mountInSession(<LogCapacityScreen route={ROUTE} />, harness(() => overview()), { permissions: ['adm.log_capacity.read'] });
    await screen.findByTestId('classes');
    expect(screen.queryByRole('button', { name: vi_['adm.logCapacity.change.action'] })).toBeNull();
  });

  it('saves a cap with the version the person saw and refuses a missing reason before asking the server', async () => {
    const h = harness(() => overview(), () => ({ resource_id: 'x' }));
    mountInSession(<LogCapacityScreen route={ROUTE} />, h, { permissions: MANAGER });
    const user = userEvent.setup();
    const table = await screen.findByTestId('classes');
    await user.click(within(table.querySelector('tr[data-record-class="outbox_event"]') as HTMLElement).getByRole('button'));
    const form = await screen.findByRole('form', { name: vi_['adm.logCapacity.form.aria'] });
    await user.click(within(form).getByRole('button', { name: vi_['adm.logCapacity.form.save'] }));
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['adm.logCapacity.field.reason']), 'raise after the audit');
    await user.click(within(form).getByRole('button', { name: vi_['adm.logCapacity.form.save'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('saveLogCapacityPolicy');
    expect((h.command.mock.calls[0]?.[1] as { body: { expected_version: number; max_rows: number } }).body).toMatchObject({ expected_version: 2, max_rows: 1000 });
  });
});
