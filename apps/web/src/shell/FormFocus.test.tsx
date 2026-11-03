import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Field } from '../screens/aud/components';
import { mockMatchMedia, renderApp } from '../test/render';

beforeEach(() => mockMatchMedia(() => false));
afterEach(cleanup);

/** A screen of the application with a form of the Field family: the first field is fine, the second and the third are not. */
function FormScreen() {
  const [submitted, setSubmitted] = useState(false);
  const [values, setValues] = useState({ name: 'Ban quản lý dự án', amount: '', unit: '' });
  const problem = (value: string, text: string): string | undefined => (submitted && value === '' ? text : undefined);
  return (
    <form
      noValidate
      aria-label="Capital request"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <Field id="f-name" label="Name" error={undefined}>
        <input id="f-name" value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} />
      </Field>
      <Field id="f-amount" label="Amount" error={problem(values.amount, 'Enter the amount')} hint="In dong">
        <input id="f-amount" value={values.amount} onChange={(event) => setValues({ ...values, amount: event.target.value })} />
      </Field>
      <Field id="f-unit" label="Unit" error={problem(values.unit, 'Choose the unit')}>
        <input id="f-unit" value={values.unit} onChange={(event) => setValues({ ...values, unit: event.target.value })} />
      </Field>
      <button type="submit">Send</button>
    </form>
  );
}

const open = () => renderApp('/home/home-01', { screens: { 'HOME-01': () => Promise.resolve({ default: FormScreen }) } });

describe('the form family tells a screen reader what is wrong and where (ST-KERNEL-032)', () => {
  it('AC-ST-KERNEL-032-2, UX01: a form sent with problems announces the name, the error and the role of the control, and moves the focus to the first invalid one', async () => {
    open();
    const send = await screen.findByRole('button', { name: 'Send' });
    send.focus();
    expect(send).toHaveFocus();
    fireEvent.submit(screen.getByRole('form', { name: 'Capital request' }));
    const amount = await screen.findByRole('textbox', { name: 'Amount' });
    // The focus is on the first control that is invalid, not on the second one, nor on the one that is fine, nor still on the button.
    await waitFor(() => expect(amount).toHaveFocus());
    expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveFocus();
    // The control is announced by its name, as invalid, with the hint and the error that are tied to it; the error is an alert.
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(amount).toHaveAccessibleDescription('In dong Enter the amount');
    const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent);
    expect(alerts).toEqual(['Enter the amount', 'Choose the unit']);
    // The field that is fine is not marked.
    expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('aria-invalid');
  });

  it('AC-ST-KERNEL-032-2: a form without a problem keeps the focus where the person is', async () => {
    open();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), { target: { value: '5' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Unit' }), { target: { value: 'PMU' } });
    const send = screen.getByRole('button', { name: 'Send' });
    send.focus();
    fireEvent.submit(screen.getByRole('form', { name: 'Capital request' }));
    await new Promise((wait) => setTimeout(wait, 20));
    expect(send).toHaveFocus();
  });
});
