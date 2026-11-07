import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { StatusPill } from '../../ui';
import { cxnTags } from './model';

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

export interface ConfirmationLabelProps {
  /** Whether the legal parameter still waits for its confirmation. */
  awaiting: boolean;
  cxnRefs: readonly string[];
  /** The reference of the confirmation, once it was recorded. */
  reference?: string | null;
}

/** The label of a legal parameter: a working assumption says which confirmation it waits for, and is never shown as law. */
export function ConfirmationLabel({ awaiting, cxnRefs, reference }: ConfirmationLabelProps) {
  const { t } = useTranslation();
  if (awaiting) {
    return (
      <span data-confirmation="pending">
        <StatusPill tone="warning">{t('mne.forms.confirmation.pending', { tags: cxnTags(cxnRefs) })}</StatusPill>
      </span>
    );
  }
  return (
    <span data-confirmation="confirmed">
      <StatusPill tone="success">{reference === undefined || reference === null ? t('mne.forms.confirmation.confirmed') : t('mne.forms.confirmation.reference', { reference })}</StatusPill>
    </span>
  );
}
