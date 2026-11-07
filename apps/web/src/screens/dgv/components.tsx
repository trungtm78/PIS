import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { badgeLabel, badgeTone } from './labels';
import type { QualityBadge } from './model';
import './dgv.css';

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

const TONES: Readonly<Record<ReturnType<typeof badgeTone>, Tone>> = { green: 'success', gray: 'neutral', warn: 'warning', red: 'danger' };

/** The quality badge of a dataset: a pill with the word and a tone, so the state is never told by colour alone. */
export function QualityPill({ badge }: { badge: QualityBadge }) {
  const { t } = useTranslation();
  return (
    <span data-badge={badge}>
      <StatusPill tone={TONES[badgeTone(badge)]}>{badgeLabel(t, badge)}</StatusPill>
    </span>
  );
}
