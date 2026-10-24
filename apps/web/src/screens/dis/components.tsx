import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { statusLabel, statusTone } from './labels';
import type { PeriodStatus } from './model';
import './dis.css';

/** The link above the title that the mockup of a screen carries: an arrow and the name of the screen it comes from. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="dis-back-link">
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

/** The status of a period: a colour and a word, so the state is never told by colour alone. */
export function StatusPill({ status }: { status: PeriodStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`pill ${statusTone(status)}`} data-status={status}>
      {statusLabel(t, status)}
    </span>
  );
}
