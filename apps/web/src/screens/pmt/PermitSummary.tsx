import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { permitStatusLabel } from './dossier-labels';
import { statusTone } from './dossier-model';
import type { PermitDetailView } from './dossier-model';
import './pmt.css';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * PMT-02: what a permit is. The permit type version it was written under stays with it for good, so the revision is shown with the code;
 * a version that still waits for its legal confirmation is flagged.
 */
export function PermitSummary({ permit }: { permit: PermitDetailView }) {
  const { t } = useTranslation();
  const none = t('pmt.permit.fact.none.text');
  return (
    <div className="card" data-testid="permit-summary" data-permit-id={permit.id}>
      <h2>{t('pmt.permit.summary.title', { code: permit.permitTypeCode })}</h2>
      <p>
        <span className={`pill ${statusTone(permit.status)}`} data-testid="permit-status">
          {permitStatusLabel(t, permit.status)}
        </span>
        {permit.cxnRef === null ? null : (
          <>
            {' '}
            <span className="pill warn" data-testid="unconfirmed">
              {t('pmt.type.unconfirmed.text', { cxn: permit.cxnRef })}
            </span>
          </>
        )}
      </p>
      <dl className="pmt-facts">
        <Fact label={t('pmt.permit.fact.project.label')}>
          {permit.projectCode} · {permit.projectName}
        </Fact>
        <Fact label={t('pmt.permit.fact.type.label')}>{t('pmt.permit.fact.type.text', { name: permit.permitTypeName, revision: permit.permitTypeRevision })}</Fact>
        <Fact label={t('pmt.permit.fact.required.label')}>{permit.isRequired ? t('pmt.dossier.required.yes.text') : t('pmt.dossier.optional.text')}</Fact>
        <Fact label={t('pmt.permit.fact.number.label')}>{permit.permitNo ?? none}</Fact>
        <Fact label={t('pmt.permit.fact.authority.label')}>{permit.authorityName ?? none}</Fact>
        <Fact label={t('pmt.permit.fact.responsible.label')}>{permit.responsible?.displayName ?? none}</Fact>
        <Fact label={t('pmt.permit.fact.submitted.label')}>{permit.submittedOn ?? none}</Fact>
        <Fact label={t('pmt.permit.fact.expected.label')}>{permit.expectedDecisionOn ?? none}</Fact>
        <Fact label={t('pmt.permit.fact.issued.label')}>{permit.issuedOn ?? none}</Fact>
        <Fact label={t('pmt.permit.fact.validity.label')}>
          {permit.validFrom === null ? none : `${permit.validFrom} → ${permit.noExpiry ? t('pmt.permit.fact.noExpiry.text') : (permit.validUntil ?? none)}`}
        </Fact>
        <Fact label={t('pmt.permit.fact.scan.label')}>{permit.documentVersionId ?? none}</Fact>
        {permit.revokeReason === null ? null : <Fact label={t('pmt.permit.fact.revoked.label')}>{permit.revokeReason}</Fact>}
        {permit.exemptionBasis === null ? null : <Fact label={t('pmt.permit.fact.exempted.label')}>{permit.exemptionBasis}</Fact>}
      </dl>
    </div>
  );
}
