import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import vi18n from '../../../i18n/vi.json';
import { CommandDialog, fieldProblem, initialValues, reasonField, RowsEditor, rowsOf } from './vnd-form';
import type { FieldSpec, Row } from './vnd-form';
import { client, mount } from './test/vnd-test-support';

const word = (key: string): string => (vi18n as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

describe('fieldProblem', () => {
  const spec = (over: Partial<FieldSpec>): FieldSpec => ({ name: 'f', label: 'F', kind: 'text', ...over });
  const check = (field: FieldSpec, value: string | boolean | string[] | Row[]) => fieldProblem(field, { [field.name]: value });

  it('measures a text by its trimmed length', () => {
    expect(check(spec({ required: true }), '   ')).toBe('EMPTY');
    expect(check(spec({ min: 5 }), ' abc ')).toBe('SHORT');
    expect(check(spec({ max: 4 }), 'abcde')).toBe('LONG');
    expect(check(spec({ min: 2, max: 4 }), ' abc ')).toBeNull();
    expect(check(spec({}), '')).toBeNull();
  });

  it('checks a pattern, an identifier, a day and a number', () => {
    expect(check(spec({ pattern: /^\d+$/ }), 'x1')).toBe('FORMAT');
    expect(check(spec({ pattern: /^\d+$/ }), '12')).toBeNull();
    expect(check(spec({ kind: 'uuid', required: true }), 'nope')).toBe('UUID');
    expect(check(spec({ kind: 'uuid' }), '')).toBeNull();
    expect(check(spec({ kind: 'uuid', required: true }), '00000000-0000-4000-8000-000000000001')).toBeNull();
    expect(check(spec({ kind: 'date', required: true }), '2026-02-30')).toBe('DAY');
    expect(check(spec({ kind: 'date', required: true }), '')).toBe('EMPTY');
    expect(check(spec({ kind: 'number', required: true, min: 12, max: 36 }), '11')).toBe('NUMBER');
    expect(check(spec({ kind: 'number', required: true, min: 12, max: 36 }), '12.5')).toBe('NUMBER');
    expect(check(spec({ kind: 'number', required: true, min: 12, max: 36 }), '36')).toBeNull();
  });

  it('wants a choice from the options, and at least one box of a group', () => {
    const select = spec({ kind: 'select', required: true, options: [{ value: 'A', label: 'A' }] });
    expect(check(select, '')).toBe('EMPTY');
    expect(check(select, 'B')).toBe('CHOOSE');
    expect(check(select, 'A')).toBeNull();
    const checks = spec({ kind: 'checks', required: true, options: [{ value: 'A', label: 'A' }] });
    expect(check(checks, [])).toBe('CHOOSE');
    expect(check(checks, ['A'])).toBeNull();
  });

  it('leaves a hidden field alone and asks a custom field whether its value is acceptable', () => {
    expect(fieldProblem(spec({ required: true, visible: () => false }), { f: '' })).toBeNull();
    const custom = spec({ kind: 'custom', valid: (value) => Array.isArray(value) && value.length > 1 });
    expect(check(custom, [])).toBe('CHOOSE');
    expect(check(custom, [{ a: 'x' }, { a: 'y' }])).toBeNull();
  });

  it('starts every field empty unless it has an initial value', () => {
    expect(initialValues([spec({}), spec({ name: 'b', kind: 'checkbox' }), spec({ name: 'c', kind: 'checks' }), spec({ name: 'd', initial: 'x' })])).toEqual({ f: '', b: false, c: [], d: 'x' });
  });

  it('keeps the minimum of a reason the request schema gives', () => {
    translator.setLocale('vi');
    const reason = reasonField(translator.t, 10);
    expect(reason).toMatchObject({ name: 'reason', kind: 'textarea', required: true, min: 10, max: 2000 });
    expect(check(reason, 'short')).toBe('SHORT');
  });
});

function Harness({ run, onDone = () => undefined, onClose = () => undefined, fields }: { run: (values: Record<string, unknown>) => Promise<unknown>; onDone?: (result: unknown) => void; onClose?: () => void; fields?: FieldSpec[] }) {
  translator.setLocale('vi');
  return (
    <>
      <button type="button">before</button>
      <CommandDialog
        title="Dialog title"
        context={[{ label: 'Record', value: 'R-1' }]}
        confirmLabel="Send"
        fields={fields ?? [reasonField(translator.t, 10), { name: 'when', label: 'When', kind: 'date', required: true }]}
        run={run}
        onDone={onDone}
        onClose={onClose}
      />
    </>
  );
}

const open = (props: Parameters<typeof Harness>[0]) => mount(<Harness {...props} />, client({ answers: {} }), { permissions: ['vnd.read'] });
const fill = (): void => {
  fireEvent.change(screen.getByLabelText(new RegExp(word('vnd.field.reason.label'))), { target: { value: 'A reason that is long enough' } });
  fireEvent.change(screen.getByLabelText(/When/), { target: { value: '2026-11-08' } });
};

describe('CommandDialog', () => {
  it('names the record, labels every control and puts the focus on the first field', () => {
    open({ run: () => Promise.resolve({}) });
    const dialog = screen.getByRole('dialog', { name: 'Dialog title' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('R-1');
    expect(document.activeElement).toBe(screen.getByLabelText(new RegExp(word('vnd.field.reason.label'))));
  });

  it('keeps the button off until every field is acceptable, then sends once with the trimmed values', async () => {
    const run = vi.fn(() => Promise.resolve({ resource_id: 'x' }));
    const onDone = vi.fn();
    open({ run, onDone });
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(new RegExp(word('vnd.field.reason.label'))), { target: { value: ' short ' } });
    expect(send.disabled).toBe(true);
    fill();
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ resource_id: 'x' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ reason: 'A reason that is long enough', when: '2026-11-08' });
  });

  it('shows the minimum of a field as the person types and marks the field invalid after it is left', () => {
    open({ run: () => Promise.resolve({}) });
    const reason = screen.getByLabelText(new RegExp(word('vnd.field.reason.label')));
    fireEvent.change(reason, { target: { value: 'abc' } });
    fireEvent.blur(reason);
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain(text('vnd.field.short.text', { min: 10 }));
    expect(document.body.textContent).toContain(text('vnd.field.reason.hint', { count: 10 }));
  });

  it('says a refusal inside the dialog as an alert, with the field detail of a 422, and stays open for a retry', async () => {
    const run = vi.fn(() => Promise.reject(new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c', detail: 'reason: not accepted' })));
    const onDone = vi.fn();
    open({ run, onDone });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('reason: not accepted');
    expect(alert.getAttribute('data-code')).toBe('VALIDATION_FAILED');
    expect(onDone).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says the same-person refusal in words and offers to read the record again after a version conflict', async () => {
    const run = vi.fn().mockRejectedValueOnce(new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' })).mockRejectedValueOnce(new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }));
    const onClose = vi.fn();
    open({ run, onClose });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toBe(word('vnd.error.selfApproval.text'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(word('vnd.error.conflict.text')));
    fireEvent.click(screen.getByRole('button', { name: word('vnd.dialog.reload.action') }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape and gives the focus back to what had it', () => {
    const onClose = vi.fn();
    const { rerender } = open({ run: () => Promise.resolve({}), onClose });
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    rerender(<div />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Tab inside the dialog', () => {
    open({ run: () => Promise.resolve({}) });
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByRole('button', { name: word('vnd.dialog.cancel.action') });
    cancel.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    const first = dialog.querySelector<HTMLElement>('textarea');
    const send = screen.getByRole('button', { name: 'Send' });
    send.removeAttribute('disabled');
    send.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first?.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(send);
  });

  it('hides a field that the other values make unnecessary and does not ask for it', () => {
    const fields: FieldSpec[] = [
      { name: 'decision', label: 'Decision', kind: 'select', required: true, options: [{ value: 'BAN', label: 'Ban' }, { value: 'DISMISS', label: 'Dismiss' }] },
      { name: 'months', label: 'Months', kind: 'number', required: true, min: 1, max: 5, visible: (values) => values.decision === 'BAN' },
    ];
    open({ run: () => Promise.resolve({}), fields });
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(/Decision/), { target: { value: 'DISMISS' } });
    expect(screen.queryByLabelText(/Months/)).toBeNull();
    expect(send.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/Decision/), { target: { value: 'BAN' } });
    expect(screen.getByLabelText(/Months/)).toBeTruthy();
    expect(send.disabled).toBe(true);
  });

  it('keeps the account number out of the page once the dialog is gone', async () => {
    const run = vi.fn(() => Promise.resolve({}));
    const fields: FieldSpec[] = [{ name: 'number', label: 'Number', kind: 'text', required: true, min: 6, autoComplete: 'off' }];
    const onDone = vi.fn();
    const { rerender } = open({ run, fields, onDone });
    const input = screen.getByLabelText(/Number/) as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.autocomplete).toBe('off');
    fireEvent.change(input, { target: { value: '1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    rerender(<div />);
    expect(document.body.textContent).not.toContain('1234567890');
  });
});

describe('RowsEditor', () => {
  function Editor({ onChange }: { onChange: (rows: Row[]) => void }) {
    translator.setLocale('vi');
    return (
      <RowsEditor
        rows={[{ id: 'a', lead: true }, { id: 'b', lead: false }]}
        onChange={onChange}
        blank={() => ({ id: '', lead: false })}
        addLabel="Add"
        removeLabel={(index) => `Remove ${index + 1}`}
        columns={[
          { name: 'id', label: 'Id', kind: 'text' },
          { name: 'lead', label: 'Lead', kind: 'radio' },
        ]}
      />
    );
  }

  it('labels each control with its column and its row, adds and removes rows, and moves the lead', () => {
    const onChange = vi.fn();
    mount(<Editor onChange={onChange} />, client({ answers: {} }), { permissions: [] });
    expect(screen.getByLabelText(text('vnd.rows.cell.label', { column: 'Id', row: 2 }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'a', lead: true }, { id: 'b', lead: false }, { id: '', lead: false }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1' }));
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'b', lead: false }]);
    fireEvent.click(screen.getByLabelText(text('vnd.rows.cell.label', { column: 'Lead', row: 2 })));
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'a', lead: false }, { id: 'b', lead: true }]);
    expect(rowsOf('x')).toEqual([]);
  });
});
