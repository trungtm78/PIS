import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { MilestoneTimeline } from './MilestoneTimeline';
import { PermitActions } from './PermitActions';
import { PermitSummary } from './PermitSummary';
import { DOSSIER_PATH, MANAGE_PERMISSION, RECORD_PERMISSION, dossierLink } from './dossier-model';
import { usePermit } from './hooks';
import { vietnamToday } from './model';
import './pmt.css';

const NEVER_EMPTY = (): boolean => false;

/** PMT-02: one permit with its facts, the timeline of its milestones, and the actions its status and the grants of the caller allow. */
export default function PermitDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The permit belongs to one membership (the units and projects it reaches): a switch starts the screen over.
  return <PermitDetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PermitDetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const permitId = params.get('permit') ?? undefined;
  const permit = usePermit(permitId);
  const state = useScreenState({ isLoading: permit.isLoading, error: permit.error, data: permitId === undefined ? undefined : (permit.data ?? undefined), isEmpty: NEVER_EMPTY });
  const frozen = mode === 'READ_ONLY';
  const allowed = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && !frozen;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="pmt-back-link">
        <Link to={permit.data === undefined || permit.data === null ? DOSSIER_PATH : dossierLink(permit.data.dossierId)}>
          <span aria-hidden="true">← </span>
          {t('pmt.permit.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pmt.permit.page.title')}</h1>
          <p>{t('pmt.permit.page.subtitle')}</p>
        </div>
      </div>
      {permitId === undefined ? (
        <p className="callout" role="status" data-testid="pick-permit">
          {t('pmt.permit.pick.notice')}
        </p>
      ) : permit.data === null ? (
        <p className="callout warning" role="status" data-testid="no-permit">
          {t('pmt.permit.missing.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void permit.refetch()}>
          {permit.data === undefined ? null : (
            <div className="stack">
              <div className="pmt-split">
                <PermitSummary permit={permit.data} />
                <MilestoneTimeline milestones={permit.data.milestones} />
              </div>
              <PermitActions permit={permit.data} today={vietnamToday()} mayManage={allowed(MANAGE_PERMISSION)} mayRecord={allowed(RECORD_PERMISSION)} />
            </div>
          )}
        </StateBoundary>
      )}
    </section>
  );
}
