import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { basisLabel, kindLabel, lookupSummary, statusLabel } from './labels';
import type { ContractorLine, RestrictionView } from './model';
import './bid.css';

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="bid-back-link">
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

/** The verification state in words, with how it was verified: a state is never told by colour alone, and "verified" says on what it rests. */
export function VerificationBadge({ contractor }: { contractor: ContractorLine }) {
  const { t } = useTranslation();
  return (
    <span data-testid="verification">
      <span className={`bid-badge ${contractor.verificationStatus === 'VERIFIED' ? 'ok' : contractor.verificationStatus === 'REJECTED' ? 'danger' : 'warning'}`}>{statusLabel(t, contractor.verificationStatus)}</span>
      {contractor.verificationBasis === null ? null : (
        <small className="sub bid-basis" data-testid="basis">
          {basisLabel(t, contractor.verificationBasis)}
        </small>
      )}
    </span>
  );
}

/** The restriction in force as a textual badge with its kind and its last day, or the word that there is none. */
export function RestrictionBadge({ restriction }: { restriction: RestrictionView | null }) {
  const { t } = useTranslation();
  if (restriction === null) {
    return <span data-testid="restriction-none">{t('bid.restriction.none.text')}</span>;
  }
  return (
    <span className="bid-badge danger" data-testid="restriction-in-force">
      {restriction.effectiveUntil === null
        ? t('bid.restriction.open.badge', { kind: kindLabel(t, restriction.kind), from: restriction.effectiveFrom })
        : t('bid.restriction.until.badge', { kind: kindLabel(t, restriction.kind), until: restriction.effectiveUntil })}
    </span>
  );
}

/** The honest note on the official lookup: which adapter answered and what it answered; when none is bound it says the lookup was not made. */
export function LookupNote({ contractor }: { contractor: ContractorLine }) {
  const { t } = useTranslation();
  return (
    <p className="sub" data-testid="lookup-note">
      {lookupSummary(t, contractor.lookup)}
    </p>
  );
}
