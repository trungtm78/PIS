import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { errorIdOf, hintIdOf, wireControl } from '../field-wiring';
import { statusLabel } from './labels';
import type { ContractStatus } from './model';
import './ctr.css';

/** The link above the title that the mockup of a detail screen carries: an arrow and the name of the screen it comes from. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="ctr-back-link">
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

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** The tone of the status of a contract: what is being drawn up is neutral, what is waiting or in force is info, what is done is green, what is stopped is amber and what is ended early is red. */
export function contractTone(status: ContractStatus): Tone {
  switch (status) {
    case 'DRAFT':
    case 'CLOSED':
      return 'neutral';
    case 'IN_REVIEW':
    case 'SIGNED':
    case 'ACTIVE':
      return 'info';
    case 'COMPLETED':
      return 'success';
    case 'SUSPENDED':
      return 'warning';
    case 'TERMINATED':
    case 'CANCELLED':
      return 'danger';
  }
}

/** The status of a contract as a word on a pill, never as a colour alone. */
export function StatusBadge({ status }: { status: ContractStatus }) {
  const { t } = useTranslation();
  return (
    <span data-testid="status">
      <StatusPill tone={contractTone(status)}>{statusLabel(t, status)}</StatusPill>
    </span>
  );
}
