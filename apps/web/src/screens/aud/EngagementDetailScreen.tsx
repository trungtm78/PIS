import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import type { ScreenState } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { CancelDialog, EndFieldworkDialog, StartDialog } from './dialogs';
import { useEngagement } from './hooks';
import { authorityKindLabel, engagementStatusLabel, engagementTypeLabel, holdStatusLabel, scopeKindLabel } from './labels';
import { ENGAGEMENTS_PATH, actionsOf, canManage, todayInVietnam } from './model';
import type { EngagementAction, EngagementDetail } from './model';
import './aud.css';

const NONE = '—';

/**
 * AUD-03: the file of one engagement (ST-AUD-001, AUD 3.1): the decision it rests on, its period and milestones, what it is about (units, projects, contracts), the legal hold that covers that
 * scope and, for an engagement that was cancelled, the reason. The commands that fit its state are offered to whoever may manage engagements; the server judges every one again, and an
 * engagement outside the scope of the caller is not found.
 */
export default function EngagementDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The file and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <EngagementDetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EngagementDetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const id = params.get('engagement') ?? undefined;
  const engagement = useEngagement(id);
  const [dialog, setDialog] = useState<EngagementAction | undefined>(undefined);
  const today = todayInVietnam();
  const missing = engagement.error instanceof ApiError && engagement.error.status === 404;
  const loaded = useScreenState({ isLoading: engagement.isLoading, error: missing ? undefined : engagement.error, data: engagement.data, isEmpty: (data) => data === undefined });
  // An engagement that is not found is told as empty: whoever asked cannot tell an engagement of another scope from one that is not there.
  const state: ScreenState = id === undefined || missing ? 'empty' : loaded;
  const detail = engagement.data;
  const actions = detail !== undefined && canManage(permissions, mode) ? actionsOf(detail.status) : [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="aud-back-link">
        <Link to={ENGAGEMENTS_PATH}>{t('aud.engagement.back.link')}</Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{detail === undefined ? t('aud.engagement.page.title') : t('aud.engagement.file.title', { code: detail.code })}</h1>
          <p>{detail === undefined ? t('aud.engagement.page.subtitle') : detail.title}</p>
        </div>
        {actions.length > 0 ? (
          <div className="actions">
            {actions.map((action) => (
              <button key={action} type="button" className={action === 'cancel' ? 'danger' : 'primary'} onClick={() => setDialog(action)}>
                {action === 'start' ? t('aud.engagement.start.action') : action === 'endFieldwork' ? t('aud.engagement.endFieldwork.action') : t('aud.engagement.cancel.action')}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="confidential-note">
        {t('aud.engagement.confidential.note')}
      </p>
      <StateBoundary state={state} onRetry={() => void engagement.refetch()}>
        {detail === undefined ? null : <EngagementFile detail={detail} />}
      </StateBoundary>
      {detail !== undefined && dialog === 'start' ? <StartDialog engagement={detail} today={today} onClose={() => setDialog(undefined)} /> : null}
      {detail !== undefined && dialog === 'endFieldwork' ? <EndFieldworkDialog engagement={detail} today={today} onClose={() => setDialog(undefined)} /> : null}
      {detail !== undefined && dialog === 'cancel' ? <CancelDialog engagement={detail} today={today} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('aud.engagement.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function EngagementFile({ detail }: { detail: EngagementDetail }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="aud-cards">
        <div className="card" data-testid="decision-card">
          <h2>{t('aud.engagement.decision.title')}</h2>
          <dl className="aud-facts">
            <dt>{t('aud.engagement.type.label')}</dt>
            <dd>{engagementTypeLabel(t, detail.type)}</dd>
            <dt>{t('aud.engagement.authority.label')}</dt>
            <dd>{`${detail.authorityName} (${authorityKindLabel(t, detail.authorityKind)})`}</dd>
            <dt>{t('aud.engagement.decision.document')}</dt>
            <dd>{detail.decision.title === '' ? detail.decision.documentId : detail.decision.title}</dd>
            <dt>{t('aud.engagement.decision.symbol')}</dt>
            <dd>{detail.decision.symbol ?? NONE}</dd>
            <dt>{t('aud.engagement.decision.issuedOn')}</dt>
            <dd>{detail.decision.issuedOn ?? NONE}</dd>
            <dt>{t('aud.engagement.coordinator.label')}</dt>
            <dd>{detail.coordinatorName === '' ? detail.coordinatorId : detail.coordinatorName}</dd>
          </dl>
        </div>
        <div className="card" data-testid="period-card">
          <h2>{t('aud.engagement.period.title')}</h2>
          <dl className="aud-facts">
            <dt>{t('aud.engagement.status.label')}</dt>
            <dd>
              <span className="aud-badge">{engagementStatusLabel(t, detail.status)}</span>
            </dd>
            <dt>{t('aud.engagement.period.from')}</dt>
            <dd>{detail.periodFrom}</dd>
            <dt>{t('aud.engagement.period.to')}</dt>
            <dd>{detail.periodTo}</dd>
            <dt>{t('aud.engagement.startedOn.label')}</dt>
            <dd>{detail.startedOn ?? NONE}</dd>
            <dt>{t('aud.engagement.fieldworkEndedOn.label')}</dt>
            <dd>{detail.fieldworkEndedOn ?? NONE}</dd>
            <dt>{t('aud.engagement.closedOn.label')}</dt>
            <dd>{detail.closedOn ?? NONE}</dd>
            {detail.cancelReason === null ? null : (
              <>
                <dt>{t('aud.engagement.cancelReason.label')}</dt>
                <dd data-testid="cancel-reason">{detail.cancelReason}</dd>
              </>
            )}
          </dl>
        </div>
        <div className="card" data-testid="hold-card">
          <h2>{t('aud.engagement.hold.title')}</h2>
          <p>
            <span className={detail.holdStatus === 'Active' ? 'aud-badge warning' : 'aud-badge'}>{holdStatusLabel(t, detail.holdStatus)}</span>
          </p>
          <p className="sub">{detail.holdStatus === null ? t('aud.engagement.hold.none') : t('aud.engagement.hold.covers', { count: detail.scopeCount })}</p>
        </div>
      </div>
      <div className="card">
        <h2>{t('aud.engagement.scope.title')}</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t('aud.engagement.scope.kind')}</th>
                <th>{t('aud.engagement.scope.code')}</th>
                <th>{t('aud.engagement.scope.name')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.scope.map((item) => (
                <tr key={`${item.kind}:${item.id}`}>
                  <td>{scopeKindLabel(t, item.kind)}</td>
                  <td>{item.code}</td>
                  <td>{item.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
