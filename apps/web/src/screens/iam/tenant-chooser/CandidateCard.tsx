import { useId } from 'react';
import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import '../../adm/adm-kit.css';
import type { TenantCandidate } from '../../../session/SessionContext';
import type { Selectability } from './candidate-model';
import { membershipTypeLabel, noteOf, tenantStatusLabel } from './labels';

export interface CandidateCardProps {
  candidate: TenantCandidate;
  selectability: Selectability;
  /** Another card is being chosen; every button waits. */
  busy: boolean;
  /** This very card is being chosen. */
  choosing: boolean;
  onChoose(candidate: TenantCandidate): void;
}

const CHOOSABLE: ReadonlySet<Selectability> = new Set<Selectability>(['selectable', 'readOnly']);

/** One membership as a card of the prototype's `cards` layout: icon tile, tenant name, kind, state pills and the choose button. */
export function CandidateCard({ candidate, selectability, busy, choosing, onChoose }: CandidateCardProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const noteId = useId();
  const note = noteOf(t, selectability);
  const choosable = CHOOSABLE.has(selectability);
  return (
    <article className="card" aria-labelledby={titleId} data-tenant-id={candidate.tenant_id} data-selectability={selectability}>
      <span className="miniIcon" aria-hidden="true">
        ◈
      </span>
      <h2 id={titleId} style={{ marginTop: 20 }}>
        {candidate.tenant_name}
      </h2>
      <p className="muted">
        {membershipTypeLabel(t, candidate.membership_type)} · {t('iam.tenantChooser.card.description')}
      </p>
      <span className="adm-kit-chips">
        <StatusPill tone={candidate.tenant_status === 'Active' ? 'success' : candidate.tenant_status === 'Suspended' ? 'warning' : 'neutral'}>{tenantStatusLabel(t, candidate.tenant_status)}</StatusPill>
        {selectability === 'inactive' ? <StatusPill tone="danger">{t('iam.tenantChooser.membership.inactive.label')}</StatusPill> : null}
      </span>
      {note === undefined ? null : (
        <p className="muted" id={noteId}>
          {note}
        </p>
      )}
      <div className="gap">
        <button
          type="button"
          className="ui-button ui-button--primary"
          disabled={!choosable || busy}
          aria-label={t('iam.tenantChooser.select.label', { name: candidate.tenant_name })}
          aria-describedby={note === undefined ? undefined : noteId}
          aria-busy={choosing}
          onClick={() => onChoose(candidate)}
        >
          {choosing ? t('iam.tenantChooser.select.pending') : t('iam.tenantChooser.select.action')}
        </button>
      </div>
    </article>
  );
}
