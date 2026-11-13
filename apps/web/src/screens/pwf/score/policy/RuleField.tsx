import { useId } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../i18n';
import type { Translator } from '../../../../i18n';
import { problemAt } from './rule-model';
import type { RuleProblem, RuleProblems } from './rule-model';

type T = Translator['t'];

export function ruleProblemText(t: T, problem: RuleProblem): string {
  switch (problem.kind) {
    case 'required':
      return t('pwfs.rule.problem.required.error');
    case 'pattern':
      return t('pwfs.rule.problem.pattern.error');
    case 'integer':
      return t('pwfs.rule.problem.integer.error');
    case 'number':
      return t('pwfs.rule.problem.number.error');
    case 'range':
      return t('pwfs.rule.problem.range.error', { min: problem.min ?? 0, max: problem.max ?? 0 });
    case 'duplicate':
      return t('pwfs.rule.problem.duplicate.error');
    case 'order':
      return t('pwfs.rule.problem.order.error');
    case 'listSize':
      return t('pwfs.rule.problem.listSize.error', { min: problem.min ?? 0, max: problem.max ?? 0 });
    case 'unknownRef':
      return t('pwfs.rule.problem.unknownRef.error');
    case 'sameValue':
      return t('pwfs.rule.problem.sameValue.error');
    case 'lastBand':
      return t('pwfs.rule.problem.lastBand.error');
  }
}

export interface RuleFieldProps {
  label: string;
  path: string;
  value: string;
  onChange: (value: string) => void;
  problems: RuleProblems;
  /** The problems are shown (the person tried to save or started to edit). */
  show: boolean;
  disabled: boolean;
  hint?: string | undefined;
  info?: ReactNode;
  /** Codes offered while typing (the register of the tenant); the field stays free text. */
  suggestions?: readonly string[] | undefined;
  inputMode?: 'numeric' | 'decimal' | 'text';
}

/** A label, a text control, a hint and the problem of the path in words next to it (never colour alone). */
export function RuleField({ label, path, value, onChange, problems, show, disabled, hint, info, suggestions, inputMode }: RuleFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const problem = problemAt(problems, path);
  const invalid = show && problem !== undefined;
  const describedBy = [invalid ? `${id}-error` : '', hint === undefined ? '' : `${id}-hint`].filter((part) => part !== '').join(' ');
  const listId = suggestions === undefined || suggestions.length === 0 ? undefined : `${id}-list`;
  return (
    <div className="pwf-field">
      <label htmlFor={id}>
        {label} {info}
      </label>
      <input id={id} type="text" inputMode={inputMode ?? 'text'} autoComplete="off" list={listId} value={value} disabled={disabled} aria-invalid={invalid} aria-describedby={describedBy === '' ? undefined : describedBy} data-testid={`field-${path}`} onChange={(event) => onChange(event.target.value)} />
      {listId === undefined || suggestions === undefined ? null : (
        <datalist id={listId}>
          {suggestions.map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
      )}
      {hint === undefined ? null : (
        <span className="gova1-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {invalid && problem !== undefined ? (
        <span className="pwf-field__error" id={`${id}-error`} data-testid={`error-${path}`}>
          <span aria-hidden="true">⚠ </span>
          {ruleProblemText(t, problem)}
        </span>
      ) : null}
    </div>
  );
}

export interface RuleSelectProps<V extends string> {
  label: string;
  path: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  disabled: boolean;
  hint?: string | undefined;
}

export function RuleSelect<V extends string>({ label, path, value, options, onChange, disabled, hint }: RuleSelectProps<V>) {
  const id = useId();
  return (
    <div className="pwf-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled} aria-describedby={hint === undefined ? undefined : `${id}-hint`} data-testid={`field-${path}`} onChange={(event) => onChange(event.target.value as V)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint === undefined ? null : (
        <span className="gova1-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
