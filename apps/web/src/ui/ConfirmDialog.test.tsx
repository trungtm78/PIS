import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { ConfirmDialog } from './ConfirmDialog';
import type { ConfirmDialogProps } from './ConfirmDialog';

const props = (over: Partial<ConfirmDialogProps> = {}): ConfirmDialogProps => ({
  open: true,
  title: 'Duyệt báo cáo tuần 39?',
  context: [
    { label: 'Đơn vị', value: 'Sở Xây dựng' },
    { label: 'Số tiền', value: '1.200 triệu đồng' },
  ],
  confirmLabel: 'Duyệt',
  cancelLabel: 'Hủy',
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  ...over,
});

describe('ConfirmDialog', () => {
  it('renders nothing while closed', () => {
    render(<ConfirmDialog {...props({ open: false })} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a modal dialog named by its title, listing the context', () => {
    render(<ConfirmDialog {...props()} />);
    const dialog = screen.getByRole('dialog', { name: 'Duyệt báo cáo tuần 39?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Sở Xây dựng')).toBeInTheDocument();
    expect(within(dialog).getByText('1.200 triệu đồng')).toBeInTheDocument();
  });

  it('puts focus on the cancel button and gives it back on close', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = render(<ConfirmDialog {...props()} />);
    expect(screen.getByRole('button', { name: 'Hủy' })).toHaveFocus();
    rerender(<ConfirmDialog {...props({ open: false })} />);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('confirm and cancel call their handlers', async () => {
    const p = props();
    render(<ConfirmDialog {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Duyệt' }));
    expect(p.onConfirm).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    expect(p.onCancel).toHaveBeenCalledOnce();
  });

  it('Escape cancels', async () => {
    const p = props();
    render(<ConfirmDialog {...p} />);
    await userEvent.keyboard('{Escape}');
    expect(p.onCancel).toHaveBeenCalledOnce();
  });

  it('keeps Tab inside the dialog', async () => {
    render(<ConfirmDialog {...props()} />);
    const cancel = screen.getByRole('button', { name: 'Hủy' });
    const confirm = screen.getByRole('button', { name: 'Duyệt' });
    expect(cancel).toHaveFocus();
    await userEvent.tab();
    expect(confirm).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it('while pending locks both buttons, says it is working and ignores Escape', async () => {
    const p = props({ pending: true });
    render(<ConfirmDialog {...p} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Hủy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Đang xử lý…' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  it('a required reason keeps confirm disabled until it is written and is passed to onConfirm', async () => {
    const p = props({ reason: { label: 'Lý do từ chối', required: true } });
    render(<ConfirmDialog {...p} />);
    const field = screen.getByRole('textbox', { name: /Lý do từ chối/ });
    expect(field).toHaveFocus();
    expect(screen.getByText('(bắt buộc)')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Duyệt' });
    expect(confirm).toBeDisabled();
    await userEvent.type(field, '   ');
    expect(confirm).toBeDisabled();
    await userEvent.type(field, ' Thiếu hồ sơ ');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(p.onConfirm).toHaveBeenCalledWith('Thiếu hồ sơ');
  });

  it('an optional reason does not block confirm', async () => {
    const p = props({ reason: { label: 'Ghi chú' } });
    render(<ConfirmDialog {...p} />);
    expect(screen.queryByText('(bắt buộc)')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Duyệt' }));
    expect(p.onConfirm).toHaveBeenCalledWith('');
  });

  it('keeps confirm off until the reason has its minimum length, and says how long it must be', async () => {
    const p = props({ reason: { label: 'Lý do', required: true, minLength: 5, hint: 'Từ 5 đến 500 ký tự' } });
    render(<ConfirmDialog {...p} />);
    const field = screen.getByLabelText(/Lý do/);
    expect(field).toHaveAccessibleDescription('Từ 5 đến 500 ký tự');
    const confirm = screen.getByRole('button', { name: 'Duyệt' });
    await userEvent.type(field, 'abc');
    expect(confirm).toBeDisabled();
    await userEvent.type(field, 'de');
    expect(confirm).toBeEnabled();
  });

  it('says a refusal inside the dialog as an alert and shows extra controls between the context and the reason', () => {
    render(<ConfirmDialog {...props({ error: 'Người duyệt phải khác người lập', children: <p>Chọn ngày</p> })} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Người duyệt phải khác người lập');
    expect(within(dialog).getByText('Chọn ngày')).toBeInTheDocument();
  });

  it('has no serious accessibility violation', async () => {
    render(<ConfirmDialog {...props({ reason: { label: 'Lý do', required: true } })} />);
    expect(describeViolations(await seriousViolations(screen.getByRole('dialog')))).toEqual([]);
  });
});
