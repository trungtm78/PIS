import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { errorIdOf, hintIdOf, wireControl } from '../field-wiring';
import { StatusPill as KitPill } from '../../ui';
import { statusLabel, statusTone } from './labels';
import type { PeriodStatus } from './model';

const TONE = { green: 'success', warn: 'warning', gray: 'neutral' } as const;
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

/** The status of a period: a colour and a word, so the state is never told by colour alone. */
export function StatusPill({ status }: { status: PeriodStatus }) {
  const { t } = useTranslation();
  return <KitPill tone={TONE[statusTone(status)]}>{statusLabel(t, status)}</KitPill>;
}
