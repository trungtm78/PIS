import type { ReactNode } from 'react';
import { errorIdOf, hintIdOf, wireControl } from '../field-wiring';
import { StatusPill } from '../../ui';
import type { Tone } from '../../ui';

export interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

/** A labelled form field with its hint and its error, the error announced to assistive technology. */
export function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {wireControl(children, id, { hint: hint !== undefined, error: error !== undefined })}
      {hint === undefined ? null : (
        <small className="sub" id={hintIdOf(id)}>
          {hint}
        </small>
      )}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={errorIdOf(id)}>
          {error}
        </small>
      )}
    </div>
  );
}

const PILL_TONES: Readonly<Record<string, Tone>> = { warn: 'warning', warning: 'warning', gray: 'neutral', neutral: 'neutral', green: 'success', success: 'success', red: 'danger', danger: 'danger', blue: 'info', info: 'info' };

/** A state as a pill of the kit: the tone names are the ones the model of the module returns (green, warn, gray) or the tones of the kit; the text is always written. */
export function Pill({ tone, children, 'data-testid': testId }: { tone: string; children: ReactNode; 'data-testid'?: string }) {
  return (
    <span data-testid={testId}>
      <StatusPill tone={PILL_TONES[tone] ?? 'default'}>{children}</StatusPill>
    </span>
  );
}
