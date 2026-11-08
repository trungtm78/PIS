import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../../i18n';
import { HPM_ADMIN, HPM_READER, hpmClient, hpmConnection, hpmFailed, hpmHealth, hpmNever, hpmPush, hpmRoute, mount, uuid } from '../shared/test-support';
import type { HpmWorld } from '../shared/test-support';
import PushLogScreen from './PushLogScreen';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);
const route = hpmRoute('HPM-01');
const problem = (code: string, status: number) => new ApiError({ status, code, correlationId: 'c' });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

function mountWith(options: { world?: Partial<HpmWorld>; permissions?: string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const world: HpmWorld = { connection: hpmConnection(), pushes: [hpmPush(1), hpmFailed(2)], corrections: [], ...options.world };
  const h = hpmClient(world, options.command);
  mount(<PushLogScreen route={route} />, h, { permissions: options.permissions ?? HPM_ADMIN, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const loaded = async (): Promise<void> => {
  await screen.findByTestId('status-card');
};
const content = (id: string): string => screen.getByTestId(id).textContent ?? '';

describe('PushLogScreen (HPM-01): the push of the issued reports to HPM', () => {
  it('UI-HPM-01: shows the connection as a file writer that stands for HPM, PENDING-EXTERNAL, registered as a proposal, with the refusing API adapter and who switched it and why', async () => {
    mountWith();
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('hpm.push.page.title'));
    expect(content('status-code')).toContain('hpm.reports');
    expect(content('status-adapter')).toContain('PROPOSED');
    expect(content('status-mode')).toContain(word('hpm.status.mode.fileExport'));
    expect(content('status-format')).toContain('HPM-FILE-WORKING-ASSUMPTION-2026.1');
    expect(content('status-format')).toContain(word('hpm.status.format.pending'));
    expect(content('status-registry')).toContain(word('hpm.status.registry.draft'));
    expect(content('status-api')).toContain('HPM_INTERFACE_PENDING');
    expect(content('status-reason')).toContain('The first pushes of the pilot');
    expect(screen.getAllByText(word('ent.acceptance.pending.badge')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('pending-HPM_INTERFACE').textContent).toContain('The interface of the other side');
  });

  it('shows the freshness by the rule with its numbers flagged unverified, and the counts of the pushes', async () => {
    mountWith();
    await loaded();
    expect(content('health-age')).toContain('12');
    expect(content('health-rule')).toContain('720');
    expect(content('health-rule')).toContain(word('hpm.health.rule.unverified'));
    expect(content('counts')).toContain('4');
  });

  it('lists the log by key with the state of each push, and offers retry and receipt only where the server says so', async () => {
    mountWith();
    await loaded();
    const failed = await screen.findByTestId(`retry-${uuid(2)}`);
    expect(failed).toBeTruthy();
    expect(screen.queryByTestId(`receipt-${uuid(2)}`)).toBeNull();
    expect(screen.getByTestId(`receipt-${uuid(1)}`)).toBeTruthy();
    expect(screen.queryByTestId(`retry-${uuid(1)}`)).toBeNull();
    const table = screen.getByRole('table', { name: word('hpm.log.section.title') });
    expect(within(table).getAllByText(/HPM-MONTHLY/).length).toBeGreaterThan(0);
    expect(within(table).getByText(word('hpm.push.error.delivery'))).toBeTruthy();
  });

  it('retries a failed push under the same key: the key and the next attempt are named, and the command carries the version the caller saw', async () => {
    const command = vi.fn(() => ({ operation_id: 'o', status: 'SENT', resource_version: 5, resource_id: uuid(2), push: hpmPush(2, { attempts: 2 }) }));
    const { h } = mountWith({ command });
    await loaded();
    fireEvent.click(await screen.findByTestId(`retry-${uuid(2)}`));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(hpmFailed(2).key);
    fireEvent.click(within(dialog).getByRole('button', { name: word('hpm.retry.dialog.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('retryHpmPush');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: uuid(2) }, ifMatchVersion: 2 });
    expect((await screen.findByTestId('push-result')).getAttribute('data-outcome')).toBe('SENT');
  });

  it('refuses a push whose form is not valid before it sends anything, then sends the body the contract asks for', async () => {
    const command = vi.fn((operation: string) => ({ operation_id: 'o', status: 'SENT', resource_version: 3, resource_id: uuid(9), push: hpmPush(9), operation }));
    const { h } = mountWith({ command });
    await loaded();
    fireEvent.click(screen.getByTestId('push-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: word('hpm.push.dialog.confirm') }));
    expect(h.command).not.toHaveBeenCalled();
    expect(dialog.querySelector('.ui-dialog__error')?.textContent).toBe(word('ent.error.validation.text'));
    fireEvent.change(screen.getByTestId('push-layout'), { target: { value: 'HPM-MONTHLY' } });
    fireEvent.change(screen.getByTestId('push-period'), { target: { value: '2026-M10' } });
    fireEvent.change(screen.getByTestId('push-sha'), { target: { value: 'a'.repeat(64) } });
    fireEvent.change(screen.getByTestId('push-issue'), { target: { value: uuid(77) } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('hpm.push.dialog.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('submitHpmPush');
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toEqual({ layout_code: 'HPM-MONTHLY', period: '2026-M10', revision: 1, sha256: 'a'.repeat(64), issue_id: uuid(77) });
  });

  it('says in the dialog why the server refused (an overwrite without a reopened period) and keeps the dialog open', async () => {
    const command = vi.fn((): unknown => problem('HPM_OVERWRITE_NOT_AUTHORISED', 409));
    mountWith({ command });
    await loaded();
    fireEvent.click(screen.getByTestId('push-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(screen.getByTestId('push-layout'), { target: { value: 'HPM-MONTHLY' } });
    fireEvent.change(screen.getByTestId('push-period'), { target: { value: '2026-M09' } });
    fireEvent.change(screen.getByTestId('push-sha'), { target: { value: 'a'.repeat(64) } });
    fireEvent.change(screen.getByTestId('push-file'), { target: { value: 'tenants/t/report_export/x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('hpm.push.dialog.confirm') }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(word('hpm.error.overwrite.text', { missing: 'MISSING' }).split('MISSING')[0]?.trim());
  });

  it('records the receipt of a push, and a copy made on a DEMO form can only be rejected', async () => {
    const demo = hpmPush(3, { form_status: 'DEMO', demo_mark: 'DEMO' });
    const { h } = mountWith({ world: { pushes: [hpmPush(1), demo] } });
    await loaded();
    fireEvent.click(await screen.findByTestId(`receipt-${uuid(3)}`));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByTestId('receipt-accepted') as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByTestId('receipt-rejected') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(dialog).getByTestId('receipt-reference'), { target: { value: 'HPM-D-1' } });
    fireEvent.change(within(dialog).getByTestId('receipt-note'), { target: { value: 'This is only a demo form' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('hpm.receipt.dialog.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('recordHpmReceipt');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: uuid(3) }, body: { outcome: 'REJECTED', reference: 'HPM-D-1' } });
  });

  it('switches the connection off with a reason under the version it saw', async () => {
    const { h } = mountWith();
    await loaded();
    fireEvent.click(screen.getByTestId('switch-button'));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: word('ent.switch.disable.confirm') });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'HPM is being migrated by the customer' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('setHpmConnectionState');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { enabled: false, reason: 'HPM is being migrated by the customer' }, ifMatchVersion: 3 });
  });

  it('is a hint, not an alarm, for a tenant that never pushed; and the empty log says why', async () => {
    mountWith({ world: { connection: hpmNever(), pushes: [] } });
    await loaded();
    expect(screen.getByTestId('action-first-use')).toBeTruthy();
    expect(content('health-explain')).toContain(word('hpm.health.explain.never'));
    expect((await screen.findByTestId('log-empty')).textContent).toBe(word('hpm.log.empty.none'));
    expect(screen.getByTestId('accepted-empty')).toBeTruthy();
  });

  it('puts what needs a person first: a failed push, a delivery gone stale, a connection that is off', async () => {
    mountWith({ world: { connection: hpmConnection({ enabled: false, health: hpmHealth({ status: 'STALE', age_hours: 1200, failed_pushes: 1, alert: { code: 'HPM_PUSH_FAILED', severity: 'ACTION' } }) }) } });
    await loaded();
    expect(screen.getByTestId('action-alert')).toBeTruthy();
    expect(screen.getByTestId('action-disabled')).toBeTruthy();
    expect(screen.getByTestId('action-waiting')).toBeTruthy();
  });

  it('hides every action from a reader and says the rights are not there; the workspace in a read-only mode says so too', async () => {
    mountWith({ permissions: HPM_READER, world: { connection: hpmConnection({}, { may_switch: false, may_push: false, may_record_receipt: false }), pushes: [hpmPush(1, {}, { may_record_receipt: false })] } });
    await loaded();
    expect(screen.queryByTestId('push-button')).toBeNull();
    expect(screen.queryByTestId('switch-button')).toBeNull();
    expect(screen.queryByTestId(`receipt-${uuid(1)}`)).toBeNull();
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    cleanup();
    mountWith({ mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByTestId('push-button')).toBeNull();
    expect(screen.getByTestId('readonly-note').textContent).toBe(word('ent.readonly.mode.text'));
  });

  it('shows the loading skeleton, then a service error with a retry that reads again', async () => {
    const failing = { getHpmConnection: { error: problem('SERVICE_UNAVAILABLE', 503), times: 1 } };
    const { h } = mountWith({ world: { failing } });
    expect(screen.getByRole('status', { hidden: true })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await loaded();
    expect(h.read.mock.calls.filter((call) => call[0] === 'getHpmConnection').length).toBeGreaterThanOrEqual(2);
  });

  it('marks the page stale when the delivery is stale, and in English says the same with the English words', async () => {
    mountWith({ world: { connection: hpmConnection({ health: hpmHealth({ status: 'STALE', age_hours: 1200, alert: { code: 'HPM_PUSH_STALE', severity: 'ACTION' } }) }) } });
    await loaded();
    expect(content('health-explain')).toContain(word('hpm.health.explain.stale'));
    cleanup();
    translator.setLocale('en');
    mountWith();
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translator.t('hpm.push.page.title'));
    expect(translator.t('hpm.push.page.title')).not.toBe('');
  });
});
