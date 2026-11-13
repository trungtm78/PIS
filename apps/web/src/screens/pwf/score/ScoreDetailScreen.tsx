import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard } from '../../../ui';
import { AdjustmentList, ContributionsTable, ExcludedList, FlagList, FlagsNote, LineStatePill, PeriodStatusPill, ResponseList, ScoreFigure, ScoreInfo, SupportNotice } from './components';
import { AdjustmentRequestForm, DecisionForm, HandleResponseForm, ResponseForm } from './forms';
import { useDecideAdjustment, useHandleResponse, usePolicyLimits, useReloadScores, useRequestAdjustment, useScoreCacheGuard, useScoreIdentity, useScoreLine, useSubmitResponse } from './hooks';
import { SCORE_PATHS, SCORE_PERMISSIONS, actionsOf, isNotFound, mayDo, periodLink, unitLink } from './model';
import type { ScoreLine } from './model';
import '../pwf.css';
import './score.css';

/** PWF-13: the detail of one score with the drill-through to tasks and facts, the adjustments, the responses and the flags. A line that is not there and a line the caller may not see are answered alike. */
export default function ScoreDetailScreen({ route }: ScreenProps) {
  const identity = useScoreIdentity();
  return <DetailContent key={identity} route={route} />;
}

function DetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const lineId = params.get('id');
  useScoreCacheGuard();
  const { permissions } = useSession();
  const line = useScoreLine(lineId, mayDo(permissions, SCORE_PERMISSIONS.readOwn) || mayDo(permissions, SCORE_PERMISSIONS.readUnit) || mayDo(permissions, SCORE_PERMISSIONS.readHr));
  const state = useScreenState({ isLoading: line.isLoading, error: isNotFound(line.error) ? undefined : line.error, data: line.data, isEmpty: () => false });
  const missing = isNotFound(line.error);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <h1 id="screen-title">{line.data === undefined ? t('pwfs.detail.title.text') : t('pwfs.detail.heading.text', { name: line.data.display_name })}</h1>
      </div>
      <SupportNotice />
      {lineId === null ? (
        <p className="callout warning" role="status" data-testid="no-line">
          {t('pwfs.detail.noLine.notice')}
        </p>
      ) : missing ? (
        <p className="callout danger" role="alert" data-testid="not-found">
          {t('pwfs.detail.notFound.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void line.refetch()}>
          {line.data === undefined ? null : <Detail line={line.data} />}
        </StateBoundary>
      )}
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

function Detail({ line }: { line: ScoreLine }) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const reload = useReloadScores();
  const actions = actionsOf(line, tenant?.membershipId, permissions, mode === 'READ_ONLY');
  const limits = usePolicyLimits(line.basis.policy_code, actions.requestAdjustment || line.responses.some(actions.handleResponse));
  const request = useRequestAdjustment();
  const decide = useDecideAdjustment();
  const handle = useHandleResponse();
  const respond = useSubmitResponse();
  const onReload = (): void => void reload();
  const flags = line.flags ?? [];
  return (
    <>
      <SectionCard title={t('pwfs.detail.score.title')} status={<PeriodStatusPill status={line.period_status} />}>
        <div className="pwf-grid" data-testid="detail">
          <div>
            <ScoreFigure line={line} />
            <div className="pwf-figure">
              <span>{t('pwfs.my.basis.text', { policy: line.basis.policy_code, version: line.basis.policy_version })}</span>
              <ScoreInfo basis={line.basis} asOf={line.as_of} />
            </div>
          </div>
          <dl className="pwf-facts">
            <dt>{t('pwfs.detail.state.label')}</dt>
            <dd>
              <LineStatePill state={line.state} />
            </dd>
            <dt>{t('pwfs.detail.period.label')}</dt>
            <dd>
              <Link to={periodLink(line.period_id)}>{t('pwfs.detail.period.link')}</Link> · <Link to={unitLink(line.period_id)}>{t('pwfs.detail.unit.link')}</Link>
            </dd>
            <dt>{t('pwfs.detail.unitAt.label')}</dt>
            <dd data-testid="unit-at">{line.unit_id_at_period}</dd>
          </dl>
        </div>
      </SectionCard>
      {actions.seeFlags && flags.length > 0 ? (
        <SectionCard title={t('pwfs.detail.flags.title')}>
          <FlagsNote />
          <FlagList flags={flags.map((code) => ({ code }))} />
        </SectionCard>
      ) : null}
      <SectionCard title={t('pwfs.detail.trace.title')}>
        <ContributionsTable contributions={line.contributions} />
        <h3>{t('pwfs.my.excluded.title')}</h3>
        <ExcludedList excluded={line.excluded} />
      </SectionCard>
      <SectionCard title={t('pwfs.detail.adjustments.title')}>
        <AdjustmentList
          adjustments={line.adjustments}
          renderDecision={(adjustment) =>
            actions.decideAdjustment(adjustment) ? <DecisionForm adjustment={adjustment} onReload={onReload} onDecide={(one, body) => decide.mutateAsync({ id: one.id, version: one.version, body })} /> : null
          }
        />
        {actions.requestAdjustment ? <AdjustmentRequestForm limits={limits} onReload={onReload} onSend={(body) => request.mutateAsync({ id: line.id, body })} /> : null}
      </SectionCard>
      <SectionCard title={t('pwfs.detail.responses.title')}>
        <ResponseList
          responses={line.responses}
          renderHandle={(response) =>
            actions.handleResponse(response) ? <HandleResponseForm response={response} limits={limits} onReload={onReload} onHandle={(one, body) => handle.mutateAsync({ id: one.id, version: line.version, body })} /> : null
          }
        />
        {actions.respond ? <ResponseForm onReload={onReload} onSend={(body) => respond.mutateAsync({ id: line.id, body })} /> : null}
      </SectionCard>
      <p className="adm-kit-sub">
        <Link to={SCORE_PATHS.mine}>{t('pwfs.detail.mine.link')}</Link>
      </p>
    </>
  );
}
