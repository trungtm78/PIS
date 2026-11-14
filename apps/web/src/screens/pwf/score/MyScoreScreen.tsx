import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, Tabs, useTabParam } from '../../../ui';
import { AdjustmentList, ContributionsTable, ExcludedList, PeriodStatusPill, PolicyBasis, ResponseList, ScoreFigure, ScoreInfo, SupportNotice } from './components';
import { ResponseForm } from './forms';
import { useMyScores, useReloadScores, useScoreCacheGuard, useScoreIdentity, useSubmitResponse } from './hooks';
import { Comparison } from './Comparison';
import { SCORE_PERMISSIONS, mayDo, rangeText } from './model';
import type { MyScore } from './model';
import { dayText } from '../model';
import '../pwf.css';
import './score.css';

/** PWF-11: my score. Only the score of the signed-in person: every point traced to tasks and facts, the adjustments that moved it, the periods side by side and the response to the score. */
export default function MyScoreScreen({ route }: ScreenProps) {
  const identity = useScoreIdentity();
  return <MyScoreContent key={identity} route={route} />;
}

function MyScoreContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  useScoreCacheGuard();
  const mayRead = mayDo(permissions, SCORE_PERMISSIONS.readOwn);
  const mine = useMyScores(mayRead);
  const reload = useReloadScores();
  const items = (mine.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: mine.isLoading, error: mine.error, data: mine.data, isEmpty: () => items.length === 0 });
  const screenState = !mayRead ? 'denied' : state;
  const [view, setView] = useTabParam('view', MY_VIEWS);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwfs.my.title.text')}</h1>
          <p>{t('pwfs.my.subtitle.text')}</p>
        </div>
      </div>
      <SupportNotice />
      <StateBoundary state={screenState} onRetry={() => void mine.refetch()}>
        <Tabs
          label={t('fix8.score.tabs.label')}
          testId="my"
          value={view}
          onChange={setView}
          tabs={[
            {
              id: 'periods',
              label: t('fix8.score.tab.periods'),
              count: items.length,
              panel: (
                <>
                  {items.map((item) => (
                    <PeriodCard key={item.line.id} item={item} onReload={() => void reload()} />
                  ))}
                  {mine.hasNextPage ? (
                    <button type="button" className="ui-button ui-button--outline" data-action="more-scores" disabled={mine.isFetchingNextPage} onClick={() => void mine.fetchNextPage()}>
                      {t('pwfs.my.more.action')}
                    </button>
                  ) : null}
                </>
              ),
            },
            { id: 'compare', label: t('fix8.score.tab.compare'), panel: <Comparison membershipId={tenant?.membershipId} enabled={mayRead && items.length > 0} /> },
          ]}
        />
      </StateBoundary>
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

const MY_VIEWS = ['periods', 'compare'] as const;
type PeriodPart = 'score' | 'tasks' | 'review';

function PeriodCard({ item, onReload }: { item: MyScore; onReload: () => void }) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const respond = useSubmitResponse();
  const { period, line } = item;
  const closed = !line.can_respond;
  // One purpose a tab inside the card of a period (the card was one long column): the tab stays where the person left it while the page is open.
  const [part, setPart] = useState<PeriodPart>('score');
  const figure = (
        <div className="pwf-grid">
          <div>
            <ScoreFigure line={line} />
            <div className="pwf-figure">
              <PolicyBasis code={line.basis.policy_code} version={line.basis.policy_version} />
              <ScoreInfo basis={line.basis} asOf={line.as_of} />
            </div>
          </div>
          <dl className="pwf-facts">
            <dt>{t('pwfs.my.window.label')}</dt>
            <dd data-testid="window">{period.response_until === null ? t('pwfs.my.windowNone.text') : dayText(period.response_until)}</dd>
            <dt>{t('pwfs.my.hash.label')}</dt>
            <dd data-testid="hash">{period.snapshot_hash === null ? '–' : period.snapshot_hash.slice(0, 16)}</dd>
          </dl>
        </div>
  );
  return (
    <SectionCard title={t('pwfs.my.period.title', { range: rangeText(period.period_from, period.period_to) })} status={<PeriodStatusPill status={period.status} />}>
      <div data-testid="my-period" data-period={period.id}>
        <Tabs
          label={t('fix8.score.tabs.label')}
          testId="period"
          value={part}
          onChange={setPart}
          tabs={[
            { id: 'score', label: t('fix8.score.tab.score'), panel: figure },
            {
              id: 'tasks',
              label: t('fix8.score.tab.tasks'),
              count: line.contributions.length === 0 ? undefined : line.contributions.length,
              panel: (
                <>
                  <h3>{t('pwfs.my.trace.title')}</h3>
                  <ContributionsTable contributions={line.contributions} />
                  <h3>{t('pwfs.my.excluded.title')}</h3>
                  <ExcludedList excluded={line.excluded} />
                </>
              ),
            },
            {
              id: 'review',
              label: t('fix8.score.tab.review'),
              count: line.adjustments.length + line.responses.length === 0 ? undefined : line.adjustments.length + line.responses.length,
              panel: (
                <>
                  <h3>{t('pwfs.my.adjustments.title')}</h3>
                  <AdjustmentList adjustments={line.adjustments} />
                  <h3>{t('pwfs.my.responses.title')}</h3>
                  <ResponseList responses={line.responses} />
                  {closed || mode === 'READ_ONLY' ? (
                    <p className="callout" role="status" data-testid="response-closed">
                      {t('pwfs.my.responseClosed.note')}
                    </p>
                  ) : (
                    <ResponseForm onSend={(body) => respond.mutateAsync({ id: line.id, body })} onReload={onReload} />
                  )}
                </>
              ),
            },
          ]}
        />
      </div>
    </SectionCard>
  );
}
