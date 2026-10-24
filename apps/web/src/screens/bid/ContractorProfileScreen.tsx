import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { BackLink, LookupNote, RestrictionBadge, VerificationBadge } from './components';
import { useContractor } from './hooks';
import { kindLabel } from './labels';
import { LIST_PATH, VERIFY_PERMISSION } from './model';
import type { ContractorView } from './model';
import RestrictionPanel from './RestrictionPanel';
import VerificationPanel from './VerificationPanel';
import './bid.css';

const NEVER_EMPTY = (): boolean => false;

/**
 * BID-02: the profile of one contractor: the legal identity, how the tax id was verified (and whether an official lookup was asked, through
 * which adapter), the restrictions, and the decisions that those who hold the right to verify may take. The history of performance arrives
 * with the contract module (R2).
 */
export default function ContractorProfileScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ContractorProfileContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ContractorProfileContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const contractorId = params.get('id') ?? undefined;
  const contractor = useContractor(contractorId);
  const state = useScreenState({ isLoading: contractor.isLoading, error: contractor.error, data: contractorId === undefined ? undefined : (contractor.data ?? undefined), isEmpty: NEVER_EMPTY });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={LIST_PATH}>{t('bid.back.list.link')}</BackLink>
      {contractorId === undefined || (contractor.isSuccess && contractor.data === null) ? (
        <>
          <div className="heading">
            <h1 id="screen-title">{t('bid.profile.page.title')}</h1>
          </div>
          <p className="callout warning" role="status" data-testid="no-contractor">
            {t('bid.profile.noContractor.notice')}
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void contractor.refetch()}>
          {contractor.data === undefined || contractor.data === null ? null : <Profile contractor={contractor.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('bid.profile.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Profile({ contractor }: { contractor: ContractorView }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayDecide = (permissions === undefined || permissions.includes(VERIFY_PERMISSION)) && mode !== 'READ_ONLY';
  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">{contractor.legalName}</h1>
          <p>{t('bid.profile.page.subtitle')}</p>
        </div>
      </div>
      <div className="bid-grid">
        <div>
          <div className="card">
            <h2>{t('bid.profile.legal.title')}</h2>
            <dl className="bid-facts">
              <Fact label={t('bid.profile.taxId.label')}>
                <code data-testid="tax-id">{contractor.taxIdentifier}</code>
                {contractor.taxIdentifierMasked ? (
                  <small className="sub" data-testid="tax-id-masked">
                    {' '}
                    {t('bid.profile.taxId.masked')}
                  </small>
                ) : null}
              </Fact>
              <Fact label={t('bid.profile.form.label')}>{contractor.legalForm ?? t('bid.profile.form.none')}</Fact>
              <Fact label={t('bid.profile.master.label')}>{contractor.masterRecordId === null ? <span data-testid="master-none">{t('bid.profile.master.none')}</span> : <code>{contractor.masterRecordId}</code>}</Fact>
              <Fact label={t('bid.profile.contracts.label')}>{contractor.contractCount}</Fact>
              {contractor.profileDocumentId === null ? null : (
                <Fact label={t('bid.profile.document.label')}>
                  <code>{contractor.profileDocumentId}</code>
                </Fact>
              )}
            </dl>
          </div>
          <div className="card">
            <h2>{t('bid.profile.verification.title')}</h2>
            <VerificationBadge contractor={contractor} />
            <dl className="bid-facts">
              <Fact label={t('bid.profile.verifiedAt.label')}>{contractor.verifiedAt ?? t('bid.profile.verifiedAt.none')}</Fact>
              {contractor.verifiedBy === null ? null : (
                <Fact label={t('bid.profile.verifiedBy.label')}>
                  <code>{contractor.verifiedBy}</code>
                </Fact>
              )}
              {contractor.verificationEvidenceDocumentId === null ? null : (
                <Fact label={t('bid.profile.evidence.label')}>
                  <code>{contractor.verificationEvidenceDocumentId}</code>
                </Fact>
              )}
            </dl>
            <LookupNote contractor={contractor} />
          </div>
          <div className="card">
            <h2>{t('bid.profile.restrictions.title')}</h2>
            <RestrictionBadge restriction={contractor.restrictionInForce} />
            {contractor.restrictions.length === 0 ? (
              <p className="muted" data-testid="restrictions-empty">
                {t('bid.profile.restrictions.empty')}
              </p>
            ) : (
              <table className="table" data-testid="restrictions" aria-label={t('bid.profile.restrictions.title')}>
                <thead>
                  <tr>
                    <th scope="col">{t('bid.profile.restrictions.kind')}</th>
                    <th scope="col">{t('bid.profile.restrictions.from')}</th>
                    <th scope="col">{t('bid.profile.restrictions.until')}</th>
                    <th scope="col">{t('bid.profile.restrictions.decision')}</th>
                  </tr>
                </thead>
                <tbody>
                  {contractor.restrictions.map((restriction) => (
                    <tr key={restriction.id} data-restriction-id={restriction.id}>
                      <th scope="row">{kindLabel(t, restriction.kind)}</th>
                      <td>{restriction.effectiveFrom}</td>
                      <td>{restriction.effectiveUntil ?? t('bid.profile.restrictions.open')}</td>
                      <td>{restriction.decisionDocumentId === null ? t('bid.profile.restrictions.hidden') : <code>{restriction.decisionDocumentId}</code>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card">
            <h2>{t('bid.profile.history.title')}</h2>
            <p className="muted" data-testid="history-notice">
              {t('bid.profile.history.notice')}
            </p>
          </div>
        </div>
        <div>
          {mayDecide && contractor.verificationStatus === 'UNVERIFIED' ? <VerificationPanel contractor={contractor} /> : null}
          {mayDecide ? <RestrictionPanel contractorId={contractor.id} /> : null}
        </div>
      </div>
    </>
  );
}
