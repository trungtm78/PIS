import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../../i18n';
import { harness } from '../../../../screens/sas/test-support';
import { mount } from '../shared/test-support';
import MailSchedulesScreen from './MailSchedulesScreen';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);
const route = { id: 'RML-01', path: '/rml/rml-01', title: 'RML-01', kind: 'table', area: 'data', module: 'RML', group: 'Mail', role: 'workspace', parent: null, req: 'FR-RML-01' };
const R1 = '11111111-1111-4111-8111-111111111111';
afterEach(() => cleanup());

const schedule = (over: Record<string, unknown> = {}) => ({ id: '22222222-2222-4222-8222-222222222222', layout_code: 'PVN-MONTHLY', cron: '0 8 6 * *', timezone: 'Asia/Ho_Chi_Minh', format: 'XLSX', recipient_ids: [R1], recipient_count: 1, note: null, status: 'ACTIVE', last_run_at: null, retired_at: null, retire_reason: null, created_by: R1, created_by_name: 'An', created_at: '2026-11-01T00:00:00.000Z', version: 3, ...over });
const mailing = (over: Record<string, unknown> = {}) => ({ id: '33333333-3333-4333-8333-333333333333', schedule_id: schedule().id, issue_id: '44444444-4444-4444-8444-444444444444', recipient_id: R1, channel: 'EMAIL', file_format: 'XLSX', file_name: 'a.xlsx', file_sha256: 'a'.repeat(64), status: 'SENT', attempts: 1, error_code: null, sent_at: '2026-11-06T01:00:00.000Z', last_attempt_at: '2026-11-06T01:00:00.000Z', created_at: '2026-11-06T01:00:00.000Z', ...over });

function open(options: { manage?: boolean; schedules?: unknown[]; mailings?: unknown[]; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = harness(
    (operation) => (operation === 'listReportMailSchedules' ? { items: options.schedules ?? [schedule()], truncated: false, may_manage: options.manage ?? true, as_of: '2026-11-09T01:00:00.000Z' } : { items: options.mailings ?? [mailing()], truncated: false, as_of: '2026-11-09T01:00:00.000Z' }),
    options.command ?? (() => ({ operation_id: 'o', status: 'CREATED', resource_version: 1, resource_id: R1 })),
  );
  mount(<MailSchedulesScreen route={route as never} />, h, { permissions: ['rpt.mail.read', 'rpt.mail.manage'] });
  return h;
}

describe('RML-01: the e-mail schedules of issued report forms (ENT-4d)', () => {
  it('lists the schedules and the log with the SHA-256 of what was attached, and says what a status means in words', async () => {
    open();
    const table = await screen.findByRole('table', { name: word('ent.mail.schedules.caption') });
    expect(within(table).getByText('PVN-MONTHLY')).toBeTruthy();
    expect(within(table).getByText(word('ent.mail.never.text'))).toBeTruthy();
    const log = await screen.findByRole('table', { name: word('ent.mail.log.caption') });
    expect(within(log).getByText(word('ent.mail.log.sent'))).toBeTruthy();
    expect(within(log).getByText('a'.repeat(16))).toBeTruthy();
  });

  it('makes a schedule with the form, the cron, the format and the member ids, and keeps the button off until the ids are ids', async () => {
    const h = open();
    await screen.findByTestId('mail-form');
    const submit = screen.getByRole('button', { name: word('ent.mail.form.submit') }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(word('ent.mail.form.layout')), { target: { value: 'PVN-MONTHLY' } });
    fireEvent.change(screen.getByLabelText(word('ent.mail.form.recipients')), { target: { value: 'not-an-id' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(word('ent.mail.form.recipients')), { target: { value: `${R1}, ` } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('createReportMailSchedule');
    expect(input.body).toEqual({ layout_code: 'PVN-MONTHLY', cron: '0 8 6 * *', format: 'XLSX', recipients: [R1] });
  });

  it('shows the code of a refusal in the form, and no form to a reader who may not manage', async () => {
    open({ command: () => new ApiError({ status: 409, code: 'CRON_INVALID', correlationId: 'c' }) });
    await screen.findByTestId('mail-form');
    fireEvent.change(screen.getByLabelText(word('ent.mail.form.layout')), { target: { value: 'PVN-MONTHLY' } });
    fireEvent.change(screen.getByLabelText(word('ent.mail.form.recipients')), { target: { value: R1 } });
    fireEvent.click(screen.getByRole('button', { name: word('ent.mail.form.submit') }));
    expect((await screen.findByTestId('mail-error')).textContent).toContain('CRON_INVALID');
    cleanup();
    open({ manage: false });
    await screen.findByRole('table', { name: word('ent.mail.schedules.caption') });
    expect(screen.queryByTestId('mail-form')).toBeNull();
    expect(screen.queryByRole('button', { name: word('ent.mail.retire.action') })).toBeNull();
  });

  it('retires a schedule only with a reason, at the version that was read', async () => {
    const h = open();
    fireEvent.click(await screen.findByRole('button', { name: word('ent.mail.retire.action') }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: word('ent.mail.retire.confirm') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Biểu mẫu đã đổi, lập lịch khác.' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    const [operation, input] = h.command.mock.calls[0] as [string, { ifMatchVersion: number; path: { id: string } }];
    expect(operation).toBe('retireReportMailSchedule');
    expect(input.ifMatchVersion).toBe(3);
  });

  it('says a message that was not sent and why, with the code', async () => {
    open({ mailings: [mailing({ status: 'SKIPPED', error_code: 'DEMO_FORM', file_sha256: null, file_name: null, attempts: 0 })] });
    const log = await screen.findByRole('table', { name: word('ent.mail.log.caption') });
    expect(within(log).getByText(word('ent.mail.log.skipped'))).toBeTruthy();
    expect(within(log).getByText('DEMO_FORM')).toBeTruthy();
  });
});
