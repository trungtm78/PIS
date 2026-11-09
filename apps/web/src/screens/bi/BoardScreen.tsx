import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
import { useDatasetVersions, useDatasets, useMetrics, useTile } from './hooks';
import type { Metric } from './bi-model';
import type { Dataset } from './dataset-model';
import { queryProblemMessage } from './labels';
import { WORKBENCH_PATH, describeQueryProblem, formatFigure } from './query-model';
import { ResultLabels } from './QueryResultView';
import './bi-kit.css';

/**
 * BI-02: the board of the certified metrics (ST-BI-004, BI F3): for the period chosen, a tile for each certified metric with its figure from the snapshot of that period, and under it what every number of BI carries:
 * the period, the snapshot, the quality of the data, whether it came from the cache and whose scope it is. A tile that cannot be given says why (no data, a dataset no policy opens), and is never 0. A tile opens the
 * workbench (BI-09) on the same metric and snapshot. Dashboards a person builds come with the dashboard builder; this board is the certified metrics themselves.
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
  const served = useMemo(() => (versions.data ?? []).filter((version) => version.status === 'FROZEN'), [versions.data]);
  const certified = useMemo(() => (metrics.data ?? []).filter((metric) => metric.status === 'CERTIFIED'), [metrics.data]);
  const [asked, setAsked] = useState('');
  const chosen = served.find((version) => version.id === asked) ?? served[0];
  const state = useScreenState({ isLoading: metrics.isLoading || datasets.isLoading || (disbursement !== undefined && versions.isLoading), error: metrics.error ?? datasets.error ?? versions.error, data: metrics.data === undefined ? undefined : certified });
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
        <KpiStrip label={t('bi.board.strip.label')}>
          {page.map((metric) => (
            <Tile key={`${metric.id}:${chosen?.id ?? ''}`} metric={metric} snapshotId={chosen?.id} dataset={disbursement} />
          ))}
        </KpiStrip>
      ),
    });
  }
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
        {presenting && boards.length > 0 ? <PresentationMode title={t('bi.present.title.text', { period: chosen?.asOfPeriod ?? '' })} boards={boards} onExit={() => setPresenting(false)} /> : null}
      </div>
      <ContextBar
        items={[
          { label: t('bi.board.ctx.scope'), value: tenant?.name ?? t('bi.board.ctx.scope.all') },
          { label: t('bi.board.ctx.period'), value: chosen?.asOfPeriod ?? t('bi.board.ctx.none') },
          { label: t('bi.board.ctx.snapshot'), value: chosen === undefined ? t('bi.board.ctx.none') : chosen.id.slice(0, 8) },
        ]}
        {...(versions.dataUpdatedAt > 0 ? { asOf: new Date(versions.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <StateBoundary state={state} onRetry={retry}>
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
