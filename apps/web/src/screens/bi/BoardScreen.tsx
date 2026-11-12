import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, FilterPanel, KpiStrip, KpiTile, PresentButton, PresentationMode, SectionCard } from '../../ui';
import type { PresentationBoard } from '../../ui';
import { Field } from '../mne/components';
import '../dis/dis.css';
import './bi.css';
import { FigureInfo } from './FigureInfo';
import { useDashboard, useDashboards, useDatasetVersions, useDatasets, useMetrics, useTile } from './hooks';
import type { Metric } from './bi-model';
import type { Dataset } from './dataset-model';
import type { SignOff } from './dashboard-model';
import { BOARD_DASHBOARD_PARAM, boardDashboards, boardMetricsOf, publishedVersionOf, snapshotsOf } from './board-model';
import { queryProblemMessage } from './labels';
import { WORKBENCH_PATH, describeQueryProblem, formatFigure } from './query-model';
import { ResultLabels } from './QueryResultView';
import { SignOffBlock } from './SignOffBlock';
import './bi-kit.css';

/**
 * BI-02: the board of the certified metrics (ST-BI-004, BI F3): for the period chosen, a tile for each certified metric with its figure from the snapshot of that period, and under it what every number of BI carries:
 * the period, the snapshot, the quality of the data, whether it came from the cache and whose scope it is. A tile that cannot be given says why (no data, a dataset no policy opens), and is never 0. A tile opens the
 * workbench (BI-09) on the same metric and snapshot. Dashboards a person builds come with the dashboard builder.
 *
 * The board can be read as a published dashboard (BC.02): the person chooses a dashboard with a published version (or the address names it), the tiles are the certified metrics of that version, and the three signatures of that
 * version (prepared, checked, approved) stand on the page and on every board of the presentation. The version is the published one, never the current one, which a later save makes a draft. Without a dashboard the board is
 * every certified metric and says in words that it is not a signed report.
 */
export default function BoardScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <BoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const metrics = useMetrics();
  const datasets = useDatasets();
  const disbursement = (datasets.data ?? []).find((dataset) => dataset.sourceKind === 'PERIOD_SNAPSHOT');
  const versions = useDatasetVersions(disbursement?.id);
  const [params] = useSearchParams();
  const [dashboardId, setDashboardId] = useState(params.get(BOARD_DASHBOARD_PARAM) ?? '');
  const tied = dashboardId !== '';
  // The list only offers the choice: a person who cannot read dashboards still has the board of the certified metrics.
  const library = useDashboards();
  const offered = useMemo(() => boardDashboards(library.data ?? []), [library.data]);
  const dashboard = useDashboard(tied ? dashboardId : undefined);
  const published = dashboard.data === undefined ? undefined : publishedVersionOf(dashboard.data);
  const certified = useMemo(
    () => (tied ? (published === undefined ? [] : boardMetricsOf(published, metrics.data ?? [])) : (metrics.data ?? []).filter((metric) => metric.status === 'CERTIFIED')),
    [tied, published, metrics.data],
  );
  const signOff = tied ? (published?.signOff ?? null) : null;
  // A published version that pins its dataset versions was signed on those figures: the board is read at them only.
  const served = useMemo(() => snapshotsOf(versions.data ?? [], tied ? published : undefined), [versions.data, tied, published]);
  const pinned = tied && published?.policy === 'PINNED';
  const [asked, setAsked] = useState('');
  const chosen = served.find((version) => version.id === asked) ?? served[0];
  // A board tied to a dashboard is never "empty" as a whole: the choice of the dashboard stays reachable and the reason is said in the page.
  const state = useScreenState({
    isLoading: metrics.isLoading || datasets.isLoading || (disbursement !== undefined && versions.isLoading) || (tied && dashboard.isLoading),
    error: metrics.error ?? datasets.error ?? versions.error ?? (tied ? dashboard.error : undefined),
    data: metrics.data === undefined || (tied && dashboard.data === undefined) ? undefined : certified,
    isEmpty: (data) => !tied && Array.isArray(data) && data.length === 0,
  });
  const { tenant } = useSession();
  const [presenting, setPresenting] = useState(false);
  // The presentation shows the same tiles a few at a time (a projector reads six figures, not thirty), the filter and the links left behind.
  const boards: PresentationBoard[] = [];
  for (let from = 0; from < certified.length; from += PRESENT_PAGE) {
    const page = certified.slice(from, from + PRESENT_PAGE);
    boards.push({
      id: `page-${from}`,
      title: t('bi.present.page.text', { from: from + 1, to: from + page.length }),
      content: (
        <>
          <KpiStrip label={t('bi.board.strip.label')}>
            {page.map((metric) => (
              <Tile key={`${metric.id}:${chosen?.id ?? ''}`} metric={metric} snapshotId={chosen?.id} dataset={disbursement} />
            ))}
          </KpiStrip>
          {/* A projected board is never unsigned: every page carries the three signatures, or says it has none. */}
          <BoardSignOff tied={tied} signOff={signOff} compact />
        </>
      ),
    });
  }
  const presentationTitle = tied && dashboard.data !== undefined ? t('bi.present.title.dashboard', { dashboard: dashboard.data.title, period: chosen?.asOfPeriod ?? '' }) : t('bi.present.title.text', { period: chosen?.asOfPeriod ?? '' });
  const retry = (): void => {
    void metrics.refetch();
    void datasets.refetch();
    void versions.refetch();
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.board.page.title')}</h1>
          <p>{t('bi.board.page.subtitle')}</p>
        </div>
        <PresentButton onOpen={() => setPresenting(true)} disabled={boards.length === 0} />
        {presenting && boards.length > 0 ? <PresentationMode title={presentationTitle} boards={boards} onExit={() => setPresenting(false)} /> : null}
      </div>
      <ContextBar
        items={[
          { label: t('bi.board.ctx.scope'), value: tenant?.name ?? t('bi.board.ctx.scope.all') },
          { label: t('bi.board.ctx.period'), value: chosen?.asOfPeriod ?? t('bi.board.ctx.none') },
          { label: t('bi.board.ctx.snapshot'), value: chosen === undefined ? t('bi.board.ctx.none') : chosen.id.slice(0, 8) },
        ]}
        {...(versions.dataUpdatedAt > 0 ? { asOf: new Date(versions.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      {offered.length > 0 || tied ? (
        <div className="bi-board-filter" data-testid="board-dashboard">
          <Field id="board-dashboard" label={t('bi.board.dashboard')} error={undefined}>
            <select id="board-dashboard" value={dashboardId} onChange={(event) => setDashboardId(event.target.value)}>
              <option value="">{t('bi.board.dashboard.none')}</option>
              {tied && !offered.some((one) => one.id === dashboardId) ? <option value={dashboardId}>{dashboard.data?.title ?? dashboardId}</option> : null}
              {offered.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      <StateBoundary
        state={state}
        onRetry={() => {
          retry();
          if (tied) void dashboard.refetch();
        }}
      >
        <BoardSignOff tied={tied} signOff={signOff} />
        {tied && certified.length === 0 ? (
          <p className="callout warning" role="status" data-testid="board-dashboard-empty">
            {published === undefined ? t('bi.board.dashboard.unpublished') : t('bi.board.dashboard.noMetrics')}
          </p>
        ) : null}
        <FilterPanel applied={asked === '' ? 0 : 1}>
          <div className="bi-board-filter">
            <Field id="board-period" label={t('bi.board.period')} error={undefined}>
              <select id="board-period" value={chosen?.id ?? ''} onChange={(event) => setAsked(event.target.value)}>
                {served.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.asOfPeriod}
                  </option>
                ))}
              </select>
            </Field>
            {pinned ? (
              <p className="sub" data-testid="board-pinned">
                {t('bi.board.dashboard.pinned')}
              </p>
            ) : null}
            {chosen === undefined ? <p data-testid="board-no-period">{t('bi.board.noPeriod')}</p> : null}
          </div>
        </FilterPanel>
        <SectionCard title={t('bi.board.section.title')}>
          <div data-testid="board">
            <KpiStrip label={t('bi.board.strip.label')}>
              {certified.map((metric) => (
                <Tile key={`${metric.id}:${chosen?.id ?? ''}`} metric={metric} snapshotId={chosen?.id} dataset={disbursement} />
              ))}
            </KpiStrip>
          </div>
        </SectionCard>
      </StateBoundary>
    </section>
  );
}

/**
 * The signatures a board stands on: the three lines of the published version of the dashboard it is read as, or, when it is the board of all the certified metrics, the words that it is not tied to a published dashboard version
 * and so carries no signature (a name is never made up). `compact` is the strip on a page of the presentation.
 */
function BoardSignOff({ tied, signOff, compact = false }: { tied: boolean; signOff: SignOff | null; compact?: boolean }) {
  const { t } = useTranslation();
  if (!tied) {
    return (
      <p className={compact ? 'sub' : 'callout'} data-testid="sign-unbound">
        {t('bi.board.sign.unbound')}
      </p>
    );
  }
  return <SignOffBlock signOff={signOff} compact={compact} />;
}

const NO_FIGURE = '—';
/** How many tiles one board of the presentation holds. */
const PRESENT_PAGE = 6;

/** One certified metric: the figure of the snapshot in a KPI tile, and under it the labels every number of BI carries and the way to the workbench. A tile that cannot be given says why and shows a dash, never 0. */
function Tile({ metric, snapshotId, dataset }: { metric: Metric; snapshotId: string | undefined; dataset: Dataset | undefined }) {
  const { t, locale } = useTranslation();
  const tile = useTile(metric.id, snapshotId);
  const words = { noData: t('bi.query.noData'), notApplicable: t('bi.query.notApplicable') };
  const problem = tile.error === null ? undefined : describeQueryProblem(tile.error);
  let body: ReactNode;
  if (snapshotId === undefined) {
    body = <KpiTile label={metric.code} value={NO_FIGURE} sub={t('bi.board.noPeriod')} />;
  } else if (tile.isLoading) {
    body = <KpiTile label={metric.code} value={NO_FIGURE} state="loading" />;
  } else if (problem !== undefined) {
    body = (
      <KpiTile
        label={metric.code}
        value={NO_FIGURE}
        tone="warning"
        sub={
          <span role="alert" data-reason={problem.reason}>
            {queryProblemMessage(t, problem.reason, problem.field)}
          </span>
        }
      />
    );
  } else if (tile.data === undefined) {
    body = null;
  } else {
    body = (
      <>
        <KpiTile label={metric.code} value={formatFigure(tile.data.total, tile.data.aggregationType === 'ratio' ? 'percent' : tile.data.unit, locale, words)} tone="info" />
        <div className="bi-tile__more">
          <FigureInfo metric={metric} datasetId={metric.datasetId ?? dataset?.id} datasetCode={metric.datasetId === null ? dataset?.code : undefined} period={tile.data.asOfPeriod} />
          <ResultLabels result={tile.data} />
          <Link className="ui-button ui-button--outline ui-button--small" to={`${WORKBENCH_PATH}?metric=${metric.id}&snapshot=${tile.data.snapshotId}`} aria-label={t('bi.board.open.aria', { code: metric.code })}>
            {t('bi.board.open')}
          </Link>
        </div>
      </>
    );
  }
  return (
    <div className="bi-tile" data-metric-id={metric.id}>
      {body}
    </div>
  );
}
