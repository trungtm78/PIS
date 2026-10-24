import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { useSubmitChange } from './hooks';
import { describeProblem } from './model';
import type { ChangeView, Impact } from './model';
import { problemMessage } from './labels';
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
        <table className="table">
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
        </table>
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
        <button type="submit" className="primary" disabled={!read || submit.isPending || change.impact === null}>
          {t('mdm.impact.submit.action')}
        </button>
      ) : null}
    </form>
  );
}
