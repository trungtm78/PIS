import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { joinCodes, splitCodes } from './template-model';
import type { TemplateProblem, TemplateProblemKind } from './template-model';

/** The problems of the editor by path, for the field that has one. */
export type ProblemMap = ReadonlyMap<string, TemplateProblemKind>;

export const problemMapOf = (problems: readonly TemplateProblem[]): ProblemMap => new Map(problems.map((problem) => [problem.path, problem.problem]));

export function problemWord(t: Translator['t'], kind: TemplateProblemKind): string {
  switch (kind) {
    case 'required':
      return t('pwf.templates.problem.required.error');
    case 'pattern':
      return t('pwf.templates.problem.pattern.error');
    case 'duplicate':
      return t('pwf.templates.problem.duplicate.error');
    case 'range':
      return t('pwf.templates.problem.range.error');
    case 'length':
      return t('pwf.templates.problem.length.error');
    case 'limit':
      return t('pwf.templates.problem.limit.error');
    case 'unknownRef':
      return t('pwf.templates.problem.unknownRef.error');
    case 'selfLink':
      return t('pwf.templates.problem.selfLink.error');
  }
}

export interface FieldFrameProps {
  label: string;
  path: string;
  problems: ProblemMap;
  /** The problems are shown (the person tried to save or validate). */
  show: boolean;
  hint?: string | undefined;
  wide?: boolean | undefined;
  children: (props: { id: string; invalid: boolean; describedBy: string | undefined }) => ReactNode;
}

/** A label, the control, an optional hint and the problem of the path in words next to it (never colour alone). */
export function FieldFrame({ label, path, problems, show, hint, wide, children }: FieldFrameProps) {
  const { t } = useTranslation();
  const id = useId();
  const kind = problems.get(path);
  const invalid = show && kind !== undefined;
  const describedBy = [invalid ? `${id}-error` : '', hint === undefined ? '' : `${id}-hint`].filter((part) => part !== '').join(' ');
  return (
    <div className={wide === true ? 'pwf-field pwf-field--wide' : 'pwf-field'}>
      <label htmlFor={id}>{label}</label>
      {children({ id, invalid, describedBy: describedBy === '' ? undefined : describedBy })}
      {hint === undefined ? null : (
        <span className="gova1-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {invalid && kind !== undefined ? (
        <span className="pwf-field__error" id={`${id}-error`} data-testid={`error-${path}`}>
          <span aria-hidden="true">⚠ </span>
          {problemWord(t, kind)}
        </span>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<FieldFrameProps, 'children'> {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  multiline?: boolean;
}

export function TextField({ value, onChange, disabled, multiline, ...frame }: TextFieldProps) {
  return (
    <FieldFrame {...frame}>
      {({ id, invalid, describedBy }) =>
        multiline === true ? (
          <textarea id={id} rows={2} value={value} disabled={disabled} aria-invalid={invalid} aria-describedby={describedBy} data-testid={`field-${frame.path}`} onChange={(event) => onChange(event.target.value)} />
        ) : (
          <input id={id} type="text" autoComplete="off" value={value} disabled={disabled} aria-invalid={invalid} aria-describedby={describedBy} data-testid={`field-${frame.path}`} onChange={(event) => onChange(event.target.value)} />
        )
      }
    </FieldFrame>
  );
}

export interface NumberFieldProps extends Omit<FieldFrameProps, 'children'> {
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}

/** A whole number; an empty box is "no number yet" (NaN), which the checks name, never a silent zero. */
export function NumberField({ value, onChange, disabled, ...frame }: NumberFieldProps) {
  return (
    <FieldFrame {...frame}>
      {({ id, invalid, describedBy }) => (
        <input
          id={id}
          type="number"
          inputMode="numeric"
          value={Number.isNaN(value) ? '' : value}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          data-testid={`field-${frame.path}`}
          onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
        />
      )}
    </FieldFrame>
  );
}

export interface SelectFieldProps<T extends string> extends Omit<FieldFrameProps, 'children'> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled: boolean;
}

export function SelectField<T extends string>({ value, options, onChange, disabled, ...frame }: SelectFieldProps<T>) {
  return (
    <FieldFrame {...frame}>
      {({ id, invalid, describedBy }) => (
        <select id={id} value={value} disabled={disabled} aria-invalid={invalid} aria-describedby={describedBy} data-testid={`field-${frame.path}`} onChange={(event) => onChange(event.target.value as T)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldFrame>
  );
}

export function CheckField({ label, checked, onChange, disabled, path }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled: boolean; path: string }) {
  const id = useId();
  return (
    <div className="pwf-field">
      <label htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} disabled={disabled} data-testid={`field-${path}`} onChange={(event) => onChange(event.target.checked)} /> {label}
      </label>
    </div>
  );
}

export interface CodeListFieldProps extends Omit<FieldFrameProps, 'children'> {
  value: readonly string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
}

/** A list of codes typed with commas, spaces or lines: the box keeps what is typed, the list is what was understood. */
export function CodeListField({ value, onChange, disabled, ...frame }: CodeListFieldProps) {
  const [typed, setTyped] = useState<string | undefined>(undefined);
  // What is typed is shown while it still says the list the editor holds; when the list changes from outside (another version loaded, a code renamed) the list is shown.
  const shown = typed !== undefined && joinCodes(splitCodes(typed)) === joinCodes(value) ? typed : joinCodes(value);
  return (
    <FieldFrame {...frame}>
      {({ id, invalid, describedBy }) => (
        <textarea
          id={id}
          rows={2}
          value={shown}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          data-testid={`field-${frame.path}`}
          onChange={(event) => {
            setTyped(event.target.value);
            onChange(splitCodes(event.target.value));
          }}
        />
      )}
    </FieldFrame>
  );
}
