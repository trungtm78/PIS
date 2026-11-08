import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { verificationLabel } from '../shared/vnd-labels';
import { dayText, vietnamStamp } from '../shared/vnd-model';
import { CountInfo, Fact, ReceiptNote, StaleNotice, useReceipt, useWriter } from '../shared/vnd-ui';
import { ReconfirmDialog } from './portal-dialogs';
import { usePortalHome } from './portal-hooks';
import { ownershipLabel, profileFactLabel } from './portal-labels';
import { PORTAL_DESTINATIONS, profileFacts, reconfirmAsked } from './portal-model';
import type { PortalHome } from './portal-model';
import { PortalBoundary, PortalLayout, ReconfirmPill } from './portal-ui';

const NONE = '–';

/**
 * VND-16, the portal of a contractor: its own profile (named fields only), the yearly confirmation of the profile with the declaration of integrity, and what is waiting for it (requests, certificates, plans, evaluations).
 * Nothing of another contractor and nothing of the investigation is ever here: the server answers the contractor of the caller and the database refuses the portal path every other table.
 */
export default function PortalHomeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return <Home key={scope} route={route} />;
}

function Home({ route }: ScreenProps) {
  const { t } = useTranslation();
  const writer = useWriter();
  const query = usePortalHome();
  const [confirming, setConfirming] = useState(false);
  const receipt = useReceipt();
  const home = query.data;
  const state: ScreenState = useScreenState({ isLoading: query.isLoading, error: home === undefined ? query.error : undefined, data: home, isEmpty: () => false });
  const refreshFailed = query.isError && home !== undefined;
  return (
    <PortalLayout route={route} active="VND-16" title={t('vnp.home.page.title')} subtitle={t('vnp.home.page.subtitle')} asOf={home?.as_of} stale={refreshFailed}>
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <PortalBoundary state={state} onRetry={() => void query.refetch()}>
        {home !== undefined && (
          <div className="vnd-page">
            <ProfileCard home={home} />
            <ReconfirmCard home={home} canConfirm={!writer.readOnly && home.actions.reconfirm && reconfirmAsked(home.reconfirmation.state)} onConfirm={() => setConfirming(true)} />
            <CountsCard home={home} />
          </div>
        )}
      </PortalBoundary>
      {home !== undefined && confirming && (
        <ReconfirmDialog
          home={home}
          onClose={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false);
            receipt.show(t('vnp.reconfirm.receipt.text', { time: vietnamStamp(new Date().toISOString()) }));
          }}
        />
      )}
    </PortalLayout>
  );
}

function ProfileCard({ home }: { home: PortalHome }) {
  const { t } = useTranslation();
  const profile = home.profile;
  return (
    <SectionCard
      title={t('vnp.home.profile.title')}
      status={
        <StatusPill tone={profile.verification_status === 'VERIFIED' ? 'success' : 'warning'} icon={profile.verification_status === 'VERIFIED' ? '✓' : '○'}>
          {verificationLabel(t, profile.verification_status)}
        </StatusPill>
      }
    >
      <dl className="vnd-facts" data-testid="profile-facts">
        {profileFacts(profile).map(({ fact, value }) => (
          <Fact key={fact} label={profileFactLabel(t, fact)} testId={`fact-${fact}`}>
            {value === null ? <span className="vnd-none">{t('vnp.home.profile.empty.text')}</span> : fact === 'ownership_declaration' ? ownershipLabel(t, value) : fact === 'next_review_due' ? dayText(value) : value}
          </Fact>
        ))}
      </dl>
      <p className="vnd-note">{t('vnp.home.profile.note')}</p>
    </SectionCard>
  );
}

function ReconfirmCard({ home, canConfirm, onConfirm }: { home: PortalHome; canConfirm: boolean; onConfirm: () => void }) {
  const { t } = useTranslation();
  const reconfirmation = home.reconfirmation;
  return (
    <SectionCard title={t('vnp.home.reconfirm.title')} status={<ReconfirmPill state={reconfirmation.state} />} actions={
      canConfirm ? (
        <button type="button" className="ui-button ui-button--primary" data-testid="reconfirm" onClick={onConfirm}>
          {t('vnp.home.reconfirm.action')}
        </button>
      ) : undefined
    }>
      <dl className="vnd-facts" data-testid="reconfirm-facts">
        <Fact label={t('vnp.home.reconfirm.due.label')} testId="reconfirm-due">
          {reconfirmation.due_on === null ? NONE : dayText(reconfirmation.due_on)}
        </Fact>
        <Fact label={t('vnp.home.reconfirm.last.label')} testId="reconfirm-last">
          {reconfirmation.last_confirmed_at === null ? t('vnp.home.reconfirm.never.text') : vietnamStamp(reconfirmation.last_confirmed_at)}
        </Fact>
        <Fact label={t('vnp.home.reconfirm.interval.label')} testId="reconfirm-interval">
          <span className="vnd-with-info">
            {t('vnp.home.reconfirm.interval.text', { months: reconfirmation.interval_months })}
            <CountInfo name={t('vnp.home.reconfirm.interval.label')} formula={t('vnp.home.reconfirm.formula')} source={t('vnp.home.reconfirm.source')} asOf={home.as_of} unverified />
          </span>
        </Fact>
        <Fact label={t('vnp.home.reconfirm.declaration.label')} testId="reconfirm-version">
          {reconfirmation.declaration_version}
        </Fact>
      </dl>
    </SectionCard>
  );
}

function CountsCard({ home }: { home: PortalHome }) {
  const { t } = useTranslation();
  const [, requests, certificates, evaluations] = PORTAL_DESTINATIONS;
  const counts = home.counts;
  return (
    <SectionCard title={t('vnp.home.counts.title')}>
      <div className="portal-links" data-testid="portal-counts">
        <Link to={requests.path} data-testid="count-requests">
          <span>{t('vnp.home.counts.requests.label')}</span>
          <span className="portal-links__count vnd-with-info">
            {counts.open_requests}
            <CountInfo name={t('vnp.home.counts.requests.label')} formula={t('vnp.home.counts.requests.formula')} source={t('vnp.home.counts.source')} asOf={home.as_of} />
          </span>
          {counts.overdue_requests > 0 && <span className="portal-late">{t('vnp.home.counts.overdue.text', { count: counts.overdue_requests })}</span>}
        </Link>
        <Link to={certificates.path} data-testid="count-certificates">
          <span>{t('vnp.home.counts.certificates.label')}</span>
          <span className="portal-links__count vnd-with-info">
            {counts.certificates_expiring}
            <CountInfo name={t('vnp.home.counts.certificates.label')} formula={t('vnp.home.counts.certificates.formula')} source={t('vnp.home.counts.source')} asOf={home.as_of} />
          </span>
        </Link>
        <Link to={evaluations.path} data-testid="count-plans">
          <span>{t('vnp.home.counts.plans.label')}</span>
          <span className="portal-links__count vnd-with-info">
            {counts.open_plans}
            <CountInfo name={t('vnp.home.counts.plans.label')} formula={t('vnp.home.counts.plans.formula')} source={t('vnp.home.counts.source')} asOf={home.as_of} />
          </span>
        </Link>
        <Link to={evaluations.path} data-testid="count-evaluations">
          <span>{t('vnp.home.counts.evaluations.label')}</span>
          <span className="portal-links__count vnd-with-info">
            {counts.evaluations}
            <CountInfo name={t('vnp.home.counts.evaluations.label')} formula={t('vnp.home.counts.evaluations.formula')} source={t('vnp.home.counts.source')} asOf={home.as_of} />
          </span>
        </Link>
      </div>
    </SectionCard>
  );
}
