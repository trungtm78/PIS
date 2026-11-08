import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { useScopeKey } from './vnd-hooks';
import { errorText } from './vnd-labels';
import { failureCode, isDay, isUuid } from './vnd-model';

type T = Translator['t'];

/** One row of a list that a field of kind `custom` edits (a member of a joint venture, a requirement of a package). */
export type Row = Record<string, string | boolean>;
export type FieldValue = string | boolean | string[] | Row[];
export type Values = Record<string, FieldValue>;

export interface FieldOption {
  value: string;
  label: string;
}

/**
 * One field of a command: what it is called, how long or how big its value may be (the numbers of the request schema), and how it looks. A field can hide itself by the other values, and a field of kind `custom` draws
 * its own control (a list of members, a list of requirements) and says whether its value is acceptable.
 */
export interface FieldSpec {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'date' | 'number' | 'select' | 'checkbox' | 'uuid' | 'tel' | 'email' | 'checks' | 'custom';
  required?: boolean;
  /** Text: the shortest trimmed length. Number: the smallest value. Checks: the fewest choices. */
  min?: number;
  /** Text: the longest length. Number: the largest value. */
  max?: number;
  hint?: string;
  options?: readonly FieldOption[];
  autoComplete?: string;
  initial?: FieldValue;
  visible?: (values: Values) => boolean;
  render?: (value: FieldValue, set: (value: FieldValue) => void, id: string) => ReactNode;
  valid?: (value: FieldValue, values: Values) => boolean;
  /** Text: the whole trimmed value must match (a share of the capital as a decimal). */
  pattern?: RegExp;
}

export type FieldProblem = 'EMPTY' | 'SHORT' | 'LONG' | 'UUID' | 'DAY' | 'NUMBER' | 'CHOOSE' | 'FORMAT';

const text = (value: FieldValue | undefined): string => (typeof value === 'string' ? value : '');
export const stringsOf = (value: FieldValue | undefined): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
export const rowsOf = (value: FieldValue | undefined): Row[] => (Array.isArray(value) ? value.filter((item): item is Row => typeof item === 'object' && item !== null) : []);

/** Why a value is not accepted (null when it is): the same lengths the contract gives, checked before anything is sent. A field that hides itself is never a problem. */
export function fieldProblem(spec: FieldSpec, values: Values): FieldProblem | null {
  if (spec.visible !== undefined && !spec.visible(values)) return null;
  const value = values[spec.name];
  switch (spec.kind) {
    case 'checkbox':
      return null;
    case 'checks': {
      const count = stringsOf(value).length;
      return spec.required === true && count < (spec.min ?? 1) ? 'CHOOSE' : null;
    }
    case 'custom':
      return spec.valid === undefined || value === undefined || spec.valid(value, values) ? null : 'CHOOSE';
    case 'select': {
      const chosen = text(value);
      if (chosen === '') return spec.required === true ? 'EMPTY' : null;
      return spec.options?.some((option) => option.value === chosen) === false ? 'CHOOSE' : null;
    }
    case 'number': {
      const raw = text(value).trim();
      if (raw === '') return spec.required === true ? 'EMPTY' : null;
      const number = Number(raw);
      if (!Number.isInteger(number) || (spec.min !== undefined && number < spec.min) || (spec.max !== undefined && number > spec.max)) return 'NUMBER';
      return null;
    }
    case 'date': {
      const raw = text(value).trim();
      if (raw === '') return spec.required === true ? 'EMPTY' : null;
      return isDay(raw) ? null : 'DAY';
    }
    case 'uuid': {
      const raw = text(value).trim();
      if (raw === '') return spec.required === true ? 'EMPTY' : null;
      return isUuid(raw) ? null : 'UUID';
    }
    default: {
      const trimmed = text(value).trim();
      if (trimmed === '') return spec.required === true ? 'EMPTY' : null;
      if (spec.min !== undefined && trimmed.length < spec.min) return 'SHORT';
      if (spec.max !== undefined && trimmed.length > spec.max) return 'LONG';
      return spec.pattern !== undefined && !spec.pattern.test(trimmed) ? 'FORMAT' : null;
    }
  }
}

export function problemText(t: T, spec: FieldSpec, problem: FieldProblem): string {
  switch (problem) {
    case 'EMPTY':
      return t('vnd.field.empty.text');
    case 'SHORT':
      return t('vnd.field.short.text', { min: spec.min ?? 0 });
    case 'LONG':
      return t('vnd.field.long.text', { max: spec.max ?? 0 });
    case 'UUID':
      return t('vnd.field.uuid.text');
    case 'DAY':
      return t('vnd.field.day.text');
    case 'NUMBER':
      return t('vnd.field.number.text', { min: spec.min ?? 0, max: spec.max ?? 0 });
    case 'CHOOSE':
      return t('vnd.field.choose.text');
    case 'FORMAT':
      return t('vnd.field.format.text');
  }
}

export function initialValues(fields: readonly FieldSpec[]): Values {
  const values: Values = {};
  for (const spec of fields) values[spec.name] = spec.initial ?? (spec.kind === 'checkbox' ? false : spec.kind === 'checks' ? [] : '');
  return values;
}

/** A field of a reason: a textarea with the minimum the request schema gives. */
export function reasonField(t: T, min: number, max = 2000, name = 'reason', label?: string): FieldSpec {
  return { name, label: label ?? t('vnd.field.reason.label'), kind: 'textarea', required: true, min, max, hint: t('vnd.field.reason.hint', { count: min }) };
}

// ---- the control of one field ---------------------------------------------------------------------------------------------------------------------------------------

interface ControlProps {
  spec: FieldSpec;
  value: FieldValue;
  invalid: boolean;
  disabled: boolean;
  describedBy: string | undefined;
  id: string;
  onChange: (value: FieldValue) => void;
  onBlur: () => void;
}

function Control({ spec, value, invalid, disabled, describedBy, id, onChange, onBlur }: ControlProps) {
  const common = { id, disabled, 'aria-invalid': invalid ? true : undefined, 'aria-describedby': describedBy, onBlur };
  switch (spec.kind) {
    case 'textarea':
      return <textarea {...common} rows={3} value={text(value)} onChange={(event) => onChange(event.target.value)} />;
    case 'select':
      return (
        <select {...common} value={text(value)} onChange={(event) => onChange(event.target.value)}>
          <option value="" />
          {spec.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'checkbox':
      return <input {...common} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />;
    case 'checks': {
      const chosen = stringsOf(value);
      return (
        <div className="vnd-checks" role="group" aria-labelledby={`${id}-label`}>
          {spec.options?.map((option) => (
            <label key={option.value} className="vnd-check">
              <input
                type="checkbox"
                disabled={disabled}
                checked={chosen.includes(option.value)}
                onChange={(event) => onChange(event.target.checked ? [...chosen, option.value] : chosen.filter((item) => item !== option.value))}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      );
    }
    case 'custom':
      return <>{spec.render?.(value, onChange, id)}</>;
    case 'number':
      return <input {...common} type="text" inputMode="numeric" autoComplete="off" value={text(value)} onChange={(event) => onChange(event.target.value)} />;
    case 'date':
      return <input {...common} type="date" value={text(value)} onChange={(event) => onChange(event.target.value)} />;
    case 'tel':
      return <input {...common} type="tel" autoComplete={spec.autoComplete ?? 'off'} value={text(value)} onChange={(event) => onChange(event.target.value)} />;
    case 'email':
      return <input {...common} type="email" autoComplete={spec.autoComplete ?? 'off'} value={text(value)} onChange={(event) => onChange(event.target.value)} />;
    default:
      return <input {...common} type="text" autoComplete={spec.autoComplete ?? 'off'} value={text(value)} onChange={(event) => onChange(event.target.value)} />;
  }
}

function FieldRow({ spec, values, shown, onChange, onBlur, disabled }: { spec: FieldSpec; values: Values; shown: boolean; onChange: (value: FieldValue) => void; onBlur: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const problem = shown ? fieldProblem(spec, values) : null;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [spec.hint === undefined ? '' : hintId, problem === null ? '' : errorId].filter((part) => part !== '').join(' ');
  const checkbox = spec.kind === 'checkbox';
  const group = spec.kind === 'checks' || spec.kind === 'custom';
  const value = values[spec.name] ?? '';
  const control = <Control spec={spec} value={value} invalid={problem !== null} disabled={disabled} describedBy={describedBy === '' ? undefined : describedBy} id={id} onChange={onChange} onBlur={onBlur} />;
  return (
    <div className={`vnd-field${checkbox ? ' vnd-field--check' : ''}`} data-field={spec.name}>
      {checkbox ? (
        <>
          {control}
          <label htmlFor={id}>{spec.label}</label>
        </>
      ) : group ? (
        <>
          <span className="vnd-field__label" id={`${id}-label`}>
            {spec.label}
            {spec.required === true && <span className="ui-dialog__required"> ({t('ui.confirmDialog.required')})</span>}
          </span>
          {control}
        </>
      ) : (
        <>
          <label htmlFor={id}>
            {spec.label}
            {spec.required === true && <span className="ui-dialog__required"> ({t('ui.confirmDialog.required')})</span>}
          </label>
          {control}
        </>
      )}
      {spec.hint !== undefined && (
        <span className="ui-dialog__hint" id={hintId}>
          {spec.hint}
        </span>
      )}
      {problem !== null && (
        <span className="vnd-field__error" id={errorId}>
          {problemText(t, spec, problem)}
        </span>
      )}
    </div>
  );
}

// ---- the dialog ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface CommandDialogProps {
  title: string;
  context: { label: string; value: string }[];
  confirmLabel: string;
  fields: readonly FieldSpec[];
  /** Sends the command with the values; a refusal rejects with the error, which the dialog says in place. */
  run: (values: Values) => Promise<unknown>;
  onClose: () => void;
  /** The command went through; `result` is what the server answered. */
  onDone: (result: unknown) => void;
  note?: ReactNode;
  /** Controls below the fields (a plan, a total) that are not fields of the body. */
  extra?: (values: Values) => ReactNode;
  /** Draws the confirm button as a warning (a block, an end, a revocation). */
  danger?: boolean;
  /** Another condition that keeps the button off (a plan that does not add up). */
  blocked?: (values: Values) => boolean;
  /** A dialog with a table or a list of rows in it takes more room. */
  wide?: boolean;
}

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * The dialog of a command: names the record and the effect, asks the fields the request schema asks, keeps the button off until every field is acceptable, sends once, and says a refusal inside the dialog (an alert that is not
 * behind the backdrop). Escape cancels, Tab stays inside, and focus returns to where it was. A changed version offers to read the record again.
 */
export function CommandDialog({ title, context, confirmLabel, fields, run, onClose, onDone, note, extra, danger = false, blocked, wide = false }: CommandDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const [values, setValues] = useState<Values>(() => initialValues(fields));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const queryClient = useQueryClient();
  const scope = useScopeKey();
  const unmounted = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = dialog.current?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ?? dialog.current?.querySelector<HTMLElement>('button:not([disabled])');
    first?.focus();
    return () => {
      unmounted.current = true;
      before?.focus();
    };
  }, []);

  const problems = useMemo(() => fields.filter((spec) => fieldProblem(spec, values) !== null), [fields, values]);
  const invalid = problems.length > 0 || blocked?.(values) === true;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!pending) onClose();
      return;
    }
    if (event.key !== 'Tab' || dialog.current === null) return;
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (sending.current) return;
    if (invalid) {
      setAttempted(true);
      return;
    }
    sending.current = true;
    setFailure(undefined);
    setPending(true);
    run(values).then(
      (result: unknown) => {
        sending.current = false;
        if (!unmounted.current) setPending(false);
        onDone(result);
      },
      (error: unknown) => {
        sending.current = false;
        if (unmounted.current) return;
        setPending(false);
        setFailure(error);
      },
    );
  };

  const reload = (): void => {
    void queryClient.invalidateQueries({ queryKey: scope });
    onClose();
  };

  return createPortal(
    <div className="ui-dialog-backdrop">
      <div className={`ui-dialog vnd-dialog${wide ? ' vnd-dialog--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={pending ? true : undefined} ref={dialog} onKeyDown={onKeyDown}>
        <h2 className="ui-dialog__title" id={titleId}>
          {title}
        </h2>
        <dl className="ui-dialog__context">
          {context.map((item) => (
            <div className="ui-dialog__row" key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
        {note !== undefined && <div className="ui-dialog__extra">{note}</div>}
        <form className="vnd-form" onSubmit={submit} noValidate>
          {fields.map((spec) => {
            const shown = spec.visible === undefined || spec.visible(values);
            if (!shown) return null;
            return (
              <FieldRow
                key={spec.name}
                spec={spec}
                values={values}
                shown={attempted || touched[spec.name] === true}
                disabled={pending}
                onChange={(value) => setValues((current) => ({ ...current, [spec.name]: value }))}
                onBlur={() => setTouched((current) => ({ ...current, [spec.name]: true }))}
              />
            );
          })}
          {extra?.(values)}
          {failure !== undefined && (
            <p className="ui-dialog__error" role="alert" data-testid="dialog-error" data-code={failureCode(failure) ?? ''}>
              {errorText(t, failure)}
            </p>
          )}
          {failureCode(failure) === 'VERSION_CONFLICT' && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={reload}>
              {t('vnd.dialog.reload.action')}
            </button>
          )}
          <div className="ui-dialog__actions">
            <button type="button" className="ui-button ui-button--outline" disabled={pending} onClick={onClose}>
              {t('vnd.dialog.cancel.action')}
            </button>
            <button type="submit" className={danger ? 'ui-button ui-button--primary vnd-danger' : 'ui-button ui-button--primary'} disabled={pending || invalid}>
              {pending ? t('ui.confirmDialog.pending') : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// ---- a list of rows in a field of kind custom ---------------------------------------------------------------------------------------------------------------------------

export interface RowColumn {
  name: string;
  label: string;
  kind: 'text' | 'select' | 'radio';
  options?: readonly FieldOption[];
  /** The control is narrow (a share). */
  narrow?: boolean;
}

export interface RowsEditorProps {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  columns: readonly RowColumn[];
  blank: () => Row;
  addLabel: string;
  removeLabel: (index: number) => string;
  disabled?: boolean;
}

/** A list of rows, each with its own labelled controls (the label says which row), a button to add a row and one to remove it. A radio column is a choice of one row: the one lead of a venture. */
export function RowsEditor({ rows, onChange, columns, blank, addLabel, removeLabel, disabled = false }: RowsEditorProps) {
  const { t } = useTranslation();
  const set = (index: number, name: string, value: string | boolean): void => {
    const exclusive = columns.find((column) => column.name === name)?.kind === 'radio';
    onChange(rows.map((row, position) => (position === index ? { ...row, [name]: value } : exclusive && value === true ? { ...row, [name]: false } : row)));
  };
  return (
    <div>
      <ul className="vnd-rows">
        {rows.map((row, index) => (
          <li key={index} data-row={index}>
            {columns.map((column) => {
              const label = t('vnd.rows.cell.label', { column: column.label, row: index + 1 });
              if (column.kind === 'select') {
                return (
                  <select key={column.name} aria-label={label} disabled={disabled} value={typeof row[column.name] === 'string' ? String(row[column.name]) : ''} onChange={(event) => set(index, column.name, event.target.value)}>
                    <option value="" />
                    {column.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                );
              }
              if (column.kind === 'radio') {
                return (
                  <label key={column.name} className="vnd-check">
                    <input type="radio" name={column.name} aria-label={label} disabled={disabled} checked={row[column.name] === true} onChange={() => set(index, column.name, true)} />
                    <span>{column.label}</span>
                  </label>
                );
              }
              return <input key={column.name} type="text" autoComplete="off" aria-label={label} disabled={disabled} value={typeof row[column.name] === 'string' ? String(row[column.name]) : ''} onChange={(event) => set(index, column.name, event.target.value)} />;
            })}
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={removeLabel(index)} disabled={disabled} onClick={() => onChange(rows.filter((_, position) => position !== index))}>
              {t('vnd.rows.remove.action')}
            </button>
          </li>
        ))}
      </ul>
      <p>
        <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} onClick={() => onChange([...rows, blank()])}>
          {addLabel}
        </button>
      </p>
    </div>
  );
}
