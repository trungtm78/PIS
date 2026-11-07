import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { useSubmitChange } from './hooks';
import { CalendarPreview } from './CalendarPreview';
import { camel } from './catalogues';
import { describeProblem } from './model';
import type { ChangeView, Impact, RecordView } from './model';
import { problemMessage } from './labels';
import { TYPE_FORMS, attributesOf, keyPart, wordsOf, withAttribute } from './typeForms';
import type { AttributeSpec } from './typeForms';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './mdm.css';

/** The link above the title that the mockup of a detail screen carries: an arrow and the name of the screen it comes from. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="mdm-back-link">
      <Link to={to}>
        <span aria-hidden="true">← </span>
        {children}
      </Link>
    </p>
  );
}

export interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

export function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

/** What the change touches: the rows that refer to the entry, per referencing column, and their total. */
export function ImpactTable({ impact }: { impact: Impact }) {
  const { t } = useTranslation();
  const entries = Object.entries(impact.counts).sort(([left], [right]) => left.localeCompare(right));
  return (
    <div data-testid="impact" data-impact-total={impact.total}>
      {entries.length === 0 ? (
        <p className="muted">{t('mdm.impact.none.text')}</p>
      ) : (
        <KitTable caption={t('w2mdm.impact.table.caption')}>
          <thead>
            <tr>
              <th>{t('mdm.impact.col.reference')}</th>
              <th>{t('mdm.impact.col.count')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([reference, count]) => (
              <tr key={reference} data-reference={reference}>
                <td>
                  <code>{reference}</code>
                </td>
                <td>{count}</td>
              </tr>
            ))}
          </tbody>
        </KitTable>
      )}
      <p className="sub">{t('mdm.impact.total.text', { total: impact.total })}</p>
    </div>
  );
}

/**
 * The mandatory step between a draft change request and its review: the impact that the server stored is shown, and the request
 * can only be submitted once the person says they have read it (MDM 3.1 F1: no impact, no submission).
 */
export function SubmitWithImpact({ change, canSubmit, onSubmitted }: { change: ChangeView; canSubmit: boolean; onSubmitted: () => void }) {
  const { t } = useTranslation();
  const submit = useSubmitChange();
  const [read, setRead] = useState(false);
  const problem = submit.isError ? describeProblem(submit.error) : undefined;

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (!read || submit.isPending || !canSubmit || change.impact === null) return;
    submit.mutate({ id: change.id, version: change.version }, { onSuccess: onSubmitted });
  };

  return (
    <form onSubmit={send} noValidate aria-label={t('mdm.impact.step.title')} className="card" data-change-id={change.id}>
      <h2>{t('mdm.impact.step.title')}</h2>
      {change.impact === null ? (
        <p className="callout warning" role="alert">
          {t('mdm.impact.missing.error')}
        </p>
      ) : (
        <ImpactTable impact={change.impact} />
      )}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, problem)}
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={read} onChange={(event) => setRead(event.target.checked)} />
        {t('mdm.impact.read.label')}
      </label>
      {canSubmit ? (
        <button type="submit" className="ui-button ui-button--primary" disabled={!read || submit.isPending || change.impact === null}>
          {t('mdm.impact.submit.action')}
        </button>
      ) : null}
    </form>
  );
}

/** A list of words typed with commas: the text is kept as typed, the list is what the form stores. */
function WordsInput({ id, value, disabled, onChange }: { id: string; value: readonly string[]; disabled: boolean; onChange: (words: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  // The JSON text is the source: when it changes the list some other way, the input shows that list; what is being typed stays as typed.
  useEffect(() => {
    setText((typed) => (JSON.stringify(wordsOf(typed)) === JSON.stringify(value) ? typed : value.join(', ')));
  }, [value]);
  return (
    <input
      id={id}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        setText(event.target.value);
        onChange(wordsOf(event.target.value));
      }}
    />
  );
}

interface AttributeControlProps {
  type: string;
  spec: AttributeSpec;
  id: string;
  attributes: Record<string, unknown>;
  records: readonly RecordView[];
  disabled: boolean;
  set: (value: unknown) => void;
}

function AttributeControl({ type, spec, id, attributes, records, disabled, set }: AttributeControlProps) {
  const { t } = useTranslation();
  const current = attributes[spec.name];
  switch (spec.kind) {
    case 'text':
      return <input id={id} value={typeof current === 'string' ? current : ''} disabled={disabled} onChange={(event) => set(event.target.value)} />;
    case 'integer':
      return (
        <input
          id={id}
          type="number"
          value={typeof current === 'number' || typeof current === 'string' ? String(current) : ''}
          disabled={disabled}
          onChange={(event) => set(event.target.value === '' ? undefined : Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : event.target.value)}
        />
      );
    case 'boolean':
      return (
        <select id={id} value={current === true ? 'yes' : current === false ? 'no' : ''} disabled={disabled} onChange={(event) => set(event.target.value === '' ? undefined : event.target.value === 'yes')}>
          <option value="">{t('mdm.attr.boolean.unset')}</option>
          <option value="yes">{t('mdm.attr.boolean.yes')}</option>
          <option value="no">{t('mdm.attr.boolean.no')}</option>
        </select>
      );
    case 'choice':
      return (
        <select id={id} value={typeof current === 'string' ? current : ''} disabled={disabled} onChange={(event) => set(event.target.value === '' ? undefined : event.target.value)}>
          <option value="">{t('mdm.attr.ref.none')}</option>
          {spec.choices.map((choice) => (
            <option key={choice} value={choice}>
              {t(`mdm.value.${spec.family}.${camel(choice)}`)}
            </option>
          ))}
        </select>
      );
    case 'identifiers':
    case 'words':
      return <WordsInput key={type} id={id} value={Array.isArray(current) ? current.filter((item): item is string => typeof item === 'string') : []} disabled={disabled} onChange={set} />;
    case 'ref': {
      const options = records.filter((record) => record.masterType === spec.refType && (record.status === 'EFFECTIVE' || record.businessKey === current));
      return (
        <select id={id} value={typeof current === 'string' ? current : ''} disabled={disabled} onChange={(event) => set(event.target.value === '' ? undefined : event.target.value)}>
          <option value="">{t('mdm.attr.ref.none')}</option>
          {options.map((record) => (
            <option key={record.id} value={record.businessKey}>
              {record.businessKey} · {record.label ?? ''}
            </option>
          ))}
        </select>
      );
    }
    case 'refs': {
      const chosen = Array.isArray(current) ? current.filter((item): item is string => typeof item === 'string') : [];
      const options = records.filter((record) => record.masterType === spec.refType && (record.status === 'EFFECTIVE' || chosen.includes(record.businessKey)));
      return (
        <div id={id} role="group" className="check-list">
          {options.map((record) => (
            <label key={record.id} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(record.businessKey)}
                disabled={disabled}
                onChange={(event) => set(event.target.checked ? [...chosen, record.businessKey] : chosen.filter((key) => key !== record.businessKey))}
              />
              {record.businessKey}
            </label>
          ))}
        </div>
      );
    }
  }
}

export interface AttributeFieldsProps {
  idPrefix: string;
  masterType: string;
  /** The attributes as JSON text: the one source, which the typed fields read and write. */
  value: string;
  onChange: (json: string) => void;
  /** Entries that the typed fields offer for a reference (the keys of other entries). */
  records: readonly RecordView[];
  disabled: boolean;
  label: string;
  hint?: string;
  error: string | undefined;
  /** The date the entry starts from: a calendar shows its first periods from it. */
  effectiveFrom?: string;
}

/**
 * The attributes of an entry. A type with a form (the capital chain catalogues) gets one field per attribute, in the language of the
 * screen; the JSON text below stays the single source of the value and is always there, for the attributes that no form names and for
 * the rule data. Typing in either one changes the other.
 */
export function AttributeFields({ idPrefix, masterType, value, onChange, records, disabled, label, hint, error, effectiveFrom }: AttributeFieldsProps) {
  const { t } = useTranslation();
  const specs = TYPE_FORMS[masterType.trim()];
  const attributes = attributesOf(value);
  return (
    <>
      {specs === undefined || attributes === undefined ? null : (
        <fieldset className="formgrid" disabled={disabled} data-testid="typed-attributes">
          <legend>{t('mdm.attr.section.title')}</legend>
          {specs.map((spec) => {
            const id = `${idPrefix}-attr-${spec.name}`;
            const name = t(`mdm.attr.${keyPart(masterType.trim())}.${keyPart(spec.name)}.label`);
            return (
              <Field key={spec.name} id={id} label={name} error={undefined} hint={spec.kind === 'identifiers' ? t('mdm.attr.identifiers.hint') : undefined}>
                <AttributeControl type={masterType} spec={spec} id={id} attributes={attributes} records={records} disabled={disabled} set={(next) => onChange(withAttribute(value, spec.name, next))} />
              </Field>
            );
          })}
        </fieldset>
      )}
      {masterType.trim() === 'CALENDAR' && attributes !== undefined ? <CalendarPreview attributes={attributes} from={effectiveFrom ?? ''} /> : null}
      <Field id={`${idPrefix}-attributes`} label={label} error={error} hint={hint}>
        <textarea id={`${idPrefix}-attributes`} rows={4} spellCheck={false} value={value} aria-invalid={error !== undefined} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      </Field>
    </>
  );
}
