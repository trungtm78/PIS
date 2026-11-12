import type { ReactNode } from 'react';

export interface FieldProps {
  id: string;
  label: string;
  /** The sentence of the problem, when there is one (the control carries `aria-invalid` and `aria-describedby` itself). */
  error: string | undefined;
  /** The suffix of the test id of the error (`error-<testKey>`). */
  testKey: string;
  wide?: boolean;
  hint?: string;
  children: ReactNode;
}

/** A labelled control of a form with its problem said in words next to it. */
export function Field({ id, label, error, testKey, wide = false, hint, children }: FieldProps) {
  return (
    <div className={wide ? 'pwf-field pwf-field--wide' : 'pwf-field'}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <span className="pwf-field__hint">{hint}</span>}
      {error === undefined ? null : (
        <span className="pwf-field__error" id={`${id}-error`} data-testid={`error-${testKey}`}>
          {error}
        </span>
      )}
    </div>
  );
}

/** The accessibility attributes a control takes from its problem. */
export const problemAttributes = (id: string, error: string | undefined): { 'aria-invalid': true | undefined; 'aria-describedby': string | undefined } => ({
  'aria-invalid': error === undefined ? undefined : true,
  'aria-describedby': error === undefined ? undefined : `${id}-error`,
});
