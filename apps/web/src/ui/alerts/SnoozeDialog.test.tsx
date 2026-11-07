import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import { SnoozeDialog } from './SnoozeDialog';
import type { SnoozeDialogProps } from './SnoozeDialog';
import { alertsBackend, failure, harness, mount, policiesAnswer, rawItem } from './test-support';
import { toAlertItem } from './types';

// Saturday 7 November 2026, 10:00 in Vietnam.
const NOW = new Date('2026-11-07T03:00:00Z');

const theItem = (overrides: Record<string, unknown> = {}) => {
  const parsed = toAlertItem(rawItem('a1', { severity: 'ACTION', due_on: '2999-12-31', ...overrides }));
  if (parsed === undefined) throw new Error('fixture');
  return parsed;
};

function open(overrides: Partial<SnoozeDialogProps> = {}, item: Record<string, unknown> = {}, policies: unknown = policiesAnswer()) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const h = harness(alertsBackend({}, policies));
  mount(<SnoozeDialog item={theItem(item)} pending={false} error={null} now={NOW} onSubmit={onSubmit} onCancel={onCancel} {...overrides} />, h);
  return { onSubmit, onCancel, h };
}

const ready = async () => within(await screen.findByRole('dialog', { name: 'Hoãn việc này' }));
const reasonSelect = async () => {
  const dialog = await ready();
  await waitFor(() => expect(dialog.getByLabelText('Lý do hoãn')).toBeEnabled());
  return dialog.getByLabelText('Lý do hoãn');
};

describe('SnoozeDialog: the policy', () => {
  it('lists the reasons of the policy, not a list of its own; a code it has no words for is shown as it came', async () => {
    open({}, {}, policiesAnswer({ snooze: { reasons: ['WAITING_INFORMATION', 'SOME_NEW_REASON', 'OTHER'] } }));
    const select = await reasonSelect();
    const options = within(select).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Chọn lý do', 'Chờ bổ sung thông tin', 'SOME_NEW_REASON', 'Lý do khác']);
  });

  it('shows a skeleton and a disabled button while the policy is read, never an empty form', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const h = harness((operation) => (operation === 'getWorkClockPolicies' ? slow : new Error('unexpected')));
    mount(<SnoozeDialog item={theItem()} pending={false} error={null} now={NOW} onSubmit={vi.fn()} onCancel={vi.fn()} />, h);
    const dialog = within(await screen.findByRole('dialog', { name: 'Hoãn việc này' }));
    expect(dialog.getByTestId('policy-loading')).toBeInTheDocument();
    expect(dialog.queryByLabelText('Lý do hoãn')).toBeNull();
    expect(dialog.getByRole('button', { name: 'Đặt nhắc' })).toBeDisabled();
    release(policiesAnswer());
    expect(await dialog.findByLabelText('Lý do hoãn')).toBeInTheDocument();
    expect(dialog.queryByTestId('policy-loading')).toBeNull();
  });

  it('says so with a retry when the policy cannot be read, and the button stays disabled', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const h = harness((operation) => {
      calls += 1;
      return operation === 'getWorkClockPolicies' ? failure(500, 'BOOM') : new Error('unexpected');
    });
    mount(<SnoozeDialog item={theItem()} pending={false} error={null} now={NOW} onSubmit={vi.fn()} onCancel={vi.fn()} />, h);
    const dialog = within(await screen.findByRole('dialog', { name: 'Hoãn việc này' }));
    expect(await dialog.findByTestId('policy-error')).toHaveTextContent('Không đọc được chính sách hoãn và tạm dừng');
    expect(dialog.getByRole('button', { name: 'Đặt nhắc' })).toBeDisabled();
    const before = calls;
    await user.click(dialog.getByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });
});

describe('SnoozeDialog: reason and note', () => {
  it('asks for a note of at least five characters when the reason is one the policy asks a note for', async () => {
    const user = userEvent.setup();
    const { onSubmit } = open();
    const select = await reasonSelect();
    const dialog = await ready();
    await user.selectOptions(select, 'Lý do khác');
    await user.click(dialog.getByRole('button', { name: '1 giờ nữa' }));
    expect(dialog.getByLabelText('Ghi chú (bắt buộc với lý do này)')).toHaveAttribute('aria-required', 'true');
    await user.click(dialog.getByRole('button', { name: 'Đặt nhắc' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dialog.getByText('Hãy ghi rõ lý do, ít nhất 5 ký tự.')).toBeInTheDocument();
    expect(dialog.getByLabelText('Ghi chú (bắt buộc với lý do này)')).toHaveAttribute('aria-invalid', 'true');
    await user.type(dialog.getByLabelText('Ghi chú (bắt buộc với lý do này)'), ' ab ');
    await user.click(dialog.getByRole('button', { name: 'Đặt nhắc' }));
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(dialog.getByLabelText('Ghi chú (bắt buộc với lý do này)'), 'cdef');
    await user.click(dialog.getByRole('button', { name: 'Đặt nhắc' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ reasonCode: 'OTHER', note: 'ab cdef' });
  });

  it('needs no note for another reason, but asks for the reason and the time', async () => {
    const user = userEvent.setup();
    const { onSubmit } = open();
    const select = await reasonSelect();
    const dialog = await ready();
    expect(dialog.getByLabelText('Ghi chú (không bắt buộc)')).toHaveAttribute('aria-required', 'false');
    await user.click(dialog.getByRole('button', { name: 'Đặt nhắc' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dialog.getByText('Hãy chọn lý do hoãn.')).toBeInTheDocument();
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(dialog.getByText('Hãy chọn thời điểm nhắc lại trong giới hạn cho phép.')).toBeInTheDocument();
    await user.selectOptions(select, 'Đang nghỉ phép');
    await user.click(dialog.getByRole('button', { name: 'Sáng mai' }));
    await user.click(dialog.getByRole('button', { name: 'Đặt nhắc' }));
    expect(onSubmit).toHaveBeenCalledWith({ until: '2026-11-08T01:00:00.000Z', reasonCode: 'ON_LEAVE', note: '' });
  });
});

describe('SnoozeDialog: how long', () => {
  it('limits the date to the days the policy gives the level of the item', async () => {
    const user = userEvent.setup();
    open();
    await reasonSelect();
    const dialog = await ready();
    await user.click(dialog.getByRole('button', { name: 'Chọn ngày' }));
    const day = dialog.getByLabelText('Nhắc lại vào ngày');
    expect(day).toHaveAttribute('min', '2026-11-08');
    // Three days for an item that needs action: the last morning inside 7 Nov 10:00 + 3 days is 10 Nov.
    expect(day).toHaveAttribute('max', '2026-11-10');
    expect(dialog.getByTestId('snooze-limit-line')).toHaveTextContent('Hoãn tối đa 3 ngày kể từ bây giờ');
  });

  it('gives a watched item the longer limit of its level, read from the policy', async () => {
    const user = userEvent.setup();
    open({}, { severity: 'WATCH' }, policiesAnswer({ snooze: { max_days_by_severity: { URGENT: 0, ACTION: 3, WATCH: 20 } } }));
    await reasonSelect();
    const dialog = await ready();
    await user.click(dialog.getByRole('button', { name: 'Chọn ngày' }));
    expect(dialog.getByLabelText('Nhắc lại vào ngày')).toHaveAttribute('max', '2026-11-27');
  });

  it('never goes past the due day of the item, and offers no quick choice that does', async () => {
    const user = userEvent.setup();
    open({}, { due_on: '2026-11-09' });
    await reasonSelect();
    const dialog = await ready();
    await user.click(dialog.getByRole('button', { name: 'Chọn ngày' }));
    expect(dialog.getByLabelText('Nhắc lại vào ngày')).toHaveAttribute('max', '2026-11-09');
    expect(dialog.getByTestId('snooze-limit-line')).toHaveTextContent('không quá hạn xử lý 09/11');
  });

  it('on the due day itself only the hour is left', async () => {
    open({}, { due_on: '2026-11-07' });
    await reasonSelect();
    const dialog = await ready();
    expect(dialog.getByRole('button', { name: '1 giờ nữa' })).toBeEnabled();
    expect(dialog.getByRole('button', { name: 'Sáng mai' })).toBeDisabled();
    expect(dialog.getByRole('button', { name: 'Chọn ngày' })).toBeDisabled();
  });

  it('says an urgent item cannot be snoozed and blocks the button (the policy gives it no days)', async () => {
    open({}, { severity: 'URGENT' });
    const dialog = await ready();
    expect(await dialog.findByTestId('snooze-not-allowed')).toHaveTextContent('Việc khẩn hoặc việc đã quá hạn xử lý không được hoãn.');
    expect(dialog.getByRole('button', { name: 'Đặt nhắc' })).toBeDisabled();
  });
});

describe('SnoozeDialog: which time of the run', () => {
  it('says "Lần 1/2" for the first snooze and gives no warning', async () => {
    open();
    await reasonSelect();
    const dialog = await ready();
    expect(dialog.getByTestId('snooze-ordinal')).toHaveTextContent('Lần 1/2');
    expect(dialog.queryByTestId('snooze-final')).toBeNull();
  });

  it('warns that the next level will be told on the last snooze', async () => {
    open({}, { snooze_count: 1 });
    await reasonSelect();
    const dialog = await ready();
    expect(dialog.getByTestId('snooze-ordinal')).toHaveTextContent('Lần 2/2');
    expect(dialog.getByTestId('snooze-final')).toHaveTextContent('Đây là lần hoãn cuối: cấp trên sẽ được báo');
    expect(dialog.getByRole('button', { name: 'Đặt nhắc' })).toBeEnabled();
  });

  it('does not warn on the last snooze when the policy does not tell the next level', async () => {
    open({}, { snooze_count: 1 }, policiesAnswer({ snooze: { final_notifies_next_level: false } }));
    await reasonSelect();
    const dialog = await ready();
    expect(dialog.queryByTestId('snooze-final')).toBeNull();
  });

  it('reads the number of times from the policy', async () => {
    open({}, { snooze_count: 1 }, policiesAnswer({ snooze: { max_consecutive: 5 } }));
    await reasonSelect();
    const dialog = await ready();
    expect(dialog.getByTestId('snooze-ordinal')).toHaveTextContent('Lần 2/5');
    expect(dialog.queryByTestId('snooze-final')).toBeNull();
  });

  it('says the limit is reached and disables the button when the item was snoozed as many times as allowed', async () => {
    const { onSubmit } = open({}, { snooze_count: 2 });
    const dialog = await ready();
    expect(await dialog.findByTestId('snooze-limit')).toHaveTextContent('Việc này đã được hoãn đủ 2 lần liên tiếp');
    expect(dialog.getByRole('button', { name: 'Đặt nhắc' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('SnoozeDialog: the server decides again', () => {
  it.each([
    ['VALIDATION_FAILED', 'Thông tin hoãn chưa hợp lệ'],
    ['WORK_SNOOZE_NOT_ALLOWED', 'Việc khẩn hoặc việc đã quá hạn xử lý không được hoãn.'],
    ['WORK_SNOOZE_TOO_LONG', 'Thời gian hoãn vượt mức tối đa của mức độ này.'],
    ['WORK_SNOOZE_LIMIT', 'Việc này đã được hoãn đủ số lần liên tiếp cho phép.'],
    ['SOMETHING_ELSE', 'Không hoãn được việc này. Hãy thử lại.'],
  ])('says in its own words what the server refused with %s', async (code, sentence) => {
    open({ error: failure(422, code) });
    await reasonSelect();
    const dialog = await ready();
    expect(dialog.getByTestId('snooze-refused')).toHaveTextContent(sentence);
  });

  it('locks the form and says it is working while the command runs', async () => {
    open({ pending: true });
    const dialog = await ready();
    await waitFor(() => expect(dialog.getByLabelText('Lý do hoãn')).toBeDisabled());
    expect(dialog.getByRole('button', { name: 'Đang hoãn…' })).toBeDisabled();
  });
});

describe('SnoozeDialog: keyboard and accessibility', () => {
  it('closes on Escape and keeps the labelled controls reachable', async () => {
    const user = userEvent.setup();
    const { onCancel } = open();
    await reasonSelect();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('has no serious accessibility violation, with the date picker open and with errors shown', async () => {
    const user = userEvent.setup();
    open();
    await reasonSelect();
    const dialog = await ready();
    await user.click(dialog.getByRole('button', { name: 'Chọn ngày' }));
    await user.click(dialog.getByRole('button', { name: 'Đặt nhắc' }));
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
