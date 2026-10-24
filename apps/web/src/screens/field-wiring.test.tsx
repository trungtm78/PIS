import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Field as CtrField } from './ctr/components';
import { Field as DisField } from './dis/components';
import { Field as IssField } from './iss/components';
import { Field as PmtField } from './pmt/components';
import { Field as PrjField } from './prj/components';

afterEach(cleanup);

const FIELDS = { CTR: CtrField, DIS: DisField, ISS: IssField, PMT: PmtField, PRJ: PrjField };

describe.each(Object.entries(FIELDS))('the Field of %s ties the control to its words (WCAG 1.3.1, 3.3.1)', (_name, Field) => {
  it('names the error and the hint in aria-describedby and marks the control invalid, so the words are heard when the person returns to the field', () => {
    render(
      <Field id="f-amount" label="Amount" error="Enter a number" hint="In dong">
        <input id="f-amount" />
      </Field>,
    );
    const control = screen.getByLabelText('Amount');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    const described = (control.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described).toEqual(['f-amount-hint', 'f-amount-error']);
    expect(document.getElementById('f-amount-error')?.textContent).toBe('Enter a number');
    expect(document.getElementById('f-amount-hint')?.textContent).toBe('In dong');
  });

  it('describes a field that has a hint and no error by the hint alone, and leaves a field with neither as it was written', () => {
    render(
      <>
        <Field id="f-hint" label="With a hint" error={undefined} hint="Help">
          <select id="f-hint" />
        </Field>
        <Field id="f-plain" label="Plain" error={undefined}>
          <textarea id="f-plain" aria-describedby="elsewhere" />
        </Field>
      </>,
    );
    const hinted = screen.getByLabelText('With a hint');
    expect(hinted.getAttribute('aria-describedby')).toBe('f-hint-hint');
    expect(hinted.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.getByLabelText('Plain').getAttribute('aria-describedby')).toBe('elsewhere');
  });

  it('keeps a description the screen gave the control, and leaves alone a child that is not the control of the field', () => {
    render(
      <>
        <Field id="f-own" label="Own" error="Wrong">
          <input id="f-own" aria-describedby="note" />
        </Field>
        <Field id="f-group" label="Group" error="Wrong">
          <div id="other" role="group" aria-label="inner" />
        </Field>
      </>,
    );
    expect(screen.getByLabelText('Own').getAttribute('aria-describedby')).toBe('note f-own-error');
    expect(screen.getByRole('group', { name: 'inner' }).hasAttribute('aria-describedby')).toBe(false);
  });
});
