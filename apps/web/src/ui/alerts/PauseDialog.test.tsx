import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import { PauseDialog } from './PauseDialog';
import type { PauseDialogProps } from './PauseDialog';
import { ME, OTHER, STAFF, alertsBackend, failure, harness, mount, policiesAnswer, rawItem } from './test-support';
import { toAlertItem } from './types';

// Saturday 7 November 2026, 10:00 in Vietnam.
const NOW = new Date('2026-11-07T03:00:00Z');
const LE_CHI = '00000000-0000-4000-8000-0000000000ab';

const theItem = () => {
  const parsed = toAlertItem(rawItem('c1', { source: 'CLOCK', title: 'Nghĩa vụ có đồng hồ' }));
  if (parsed === undefined) throw new Error('fixture');
  return parsed;
};
// The signed-in member is also in the staff list: the dialog must not offer them.
const WITH_ME = [...STAFF, { id: ME, display_name: 'Nguyễn An', status: 'Active', membership_type: 'STAFF' }];

function open(overrides: Partial<PauseDialogProps> = {}, policies: unknown = policiesAnswer()) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const h = harness(alertsBackend({}, policies), () => ({}), () => WITH_ME);
  mount(<PauseDialog item={theItem()} pending={false} error={null} now={NOW} onSubmit={onSubmit} onCancel={onCancel} {...overrides} />, h);
  return { onSubmit, onCancel, h };
}

const ready = async () => {
  const dialog = within(await screen.findByRole('dialog', { name: 'Tạm dừng đồng hồ' }));
  await waitFor(() => expect(dialog.getByLabelText('Lý do tạm dừng')).toBeEnabled());
  await waitFor(() => expect(within(dialog.getByLabelText('Người cho phép')).getAllByRole('option').length).toBeGreaterThan(1));
  return dialog;
};

describe('PauseDialog', () => {
  it('lists the reasons of the clock policy, not a list of its own', async () => {
    open({}, policiesAnswer({ clock: { pause_reasons: ['FORCE_MAJEURE', 'NEW_ONE'] } }));
    const dialog = await ready();
    const options = within(dialog.getByLabelText('Lý do tạm dừng')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Chọn lý do', 'Bất khả kháng', 'NEW_ONE']);
  });

  it('does not offer the signed-in member as the person who allowed the pause', async () => {
    open();
    const dialog = await ready();
    const names = within(dialog.getByLabelText('Người cho phép')).getAllByRole('option').map((option) => option.textContent);
    expect(names).toEqual(['Chọn người cho phép', 'Trần Bình', 'Lê Chi']);
    expect(names).not.toContain('Nguyễn An');
  });

  it('limits the day to the longest pause of the policy', async () => {
    open({}, policiesAnswer({ clock: { max_pause_days: 5 } }));
    const dialog = await ready();
    const day = dialog.getByLabelText('Chạy lại đồng hồ vào sáng ngày');
    expect(day).toHaveAttribute('min', '2026-11-08');
    expect(day).toHaveAttribute('max', '2026-11-12');
    expect(dialog.getByTestId('pause-limit-line')).toHaveTextContent('Tạm dừng tối đa 5 ngày.');
  });

  it('asks for every field and says which is missing, and sends nothing until they are all there', async () => {
    const user = userEvent.setup();
    const { onSubmit } = open();
    const dialog = await ready();
    await user.click(dialog.getByRole('button', { name: 'Tạm dừng' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dialog.getByText('Hãy chọn lý do tạm dừng.')).toBeInTheDocument();
    expect(dialog.getByText('Hãy giải thích rõ, ít nhất 5 ký tự.')).toBeInTheDocument();
    expect(dialog.getByText('Hãy chọn người cho phép (không phải chính bạn).')).toBeInTheDocument();
    expect(dialog.getByText('Hãy chọn ngày chạy lại trong giới hạn cho phép.')).toBeInTheDocument();
    expect(dialog.getByLabelText('Lý do tạm dừng')).toHaveAttribute('aria-invalid', 'true');
    expect(dialog.getByLabelText('Người cho phép')).toHaveAttribute('aria-invalid', 'true');
  });

  it('sends the reason, the explanation, the person and the morning of the day', async () => {
    const user = userEvent.setup();
    const { onSubmit } = open();
    const dialog = await ready();
    await user.selectOptions(dialog.getByLabelText('Lý do tạm dừng'), 'Chờ bên ngoài');
    await user.type(dialog.getByLabelText('Giải thích (bắt buộc)'), '  Chờ chủ đầu tư trả lời  ');
    await user.selectOptions(dialog.getByLabelText('Người cho phép'), 'Lê Chi');
    await user.type(dialog.getByLabelText('Chạy lại đồng hồ vào sáng ngày'), '2026-11-10');
    await user.click(dialog.getByRole('button', { name: 'Tạm dừng' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ allowedBy: { id: LE_CHI, name: 'Lê Chi' }, reasonCode: 'WAITING_EXTERNAL_PARTY', reason: 'Chờ chủ đầu tư trả lời', until: '2026-11-10T01:00:00.000Z' });
    expect(OTHER).not.toBe(LE_CHI);
  });

  it('says the clock cannot be paused when the policy publishes no pause reasons', async () => {
    open({}, policiesAnswer({ clock: null }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Tạm dừng đồng hồ' }));
    expect(await dialog.findByTestId('pause-no-policy')).toHaveTextContent('Chưa có chính sách tạm dừng đồng hồ');
    expect(dialog.getByRole('button', { name: 'Tạm dừng' })).toBeDisabled();
  });

  it.each([
    ['WORK_CLOCK_PAUSE_TOO_LONG', 'Thời gian tạm dừng vượt mức tối đa của chính sách.'],
    ['WORK_CLOCK_ALLOWER_INVALID', 'Người cho phép không hợp lệ'],
    ['WORK_CLOCK_ALREADY_PAUSED', 'Đồng hồ của việc này đang tạm dừng.'],
    ['VALIDATION_FAILED', 'Thông tin tạm dừng chưa hợp lệ'],
    ['SOMETHING_ELSE', 'Không tạm dừng được đồng hồ. Hãy thử lại.'],
  ])('says in its own words what the server refused with %s', async (code, sentence) => {
    open({ error: failure(code === 'WORK_CLOCK_ALREADY_PAUSED' ? 409 : 422, code) });
    const dialog = await ready();
    expect(dialog.getByTestId('pause-refused')).toHaveTextContent(sentence);
  });

  it('closes on Escape and has no serious accessibility violation', async () => {
    const user = userEvent.setup();
    const { onCancel } = open();
    await ready();
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
