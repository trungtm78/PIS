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
import { useDatasets, useDatasetsVersions, useMetrics, useTile } from './hooks';
import type { Metric } from './bi-model';
import type { Dataset, DatasetVersion } from './dataset-model';
import { queryProblemMessage } from './labels';
import { WORKBENCH_PATH, describeQueryProblem, formatFigure } from './query-model';
import { ResultLabels } from './QueryResultView';
import { metricName } from './metric-names';
import { servingDataset, tileDimensionOf } from './serving';
import './bi-kit.css';

/**
 * BI-02: the board of the certified metrics (ST-BI-004, BI F3): for the period chosen, a tile for each certified metric with its figure from the snapshot of that period, and under it what every number of BI carries:
 * the period, the snapshot, the quality of the data, whether it came from the cache and whose scope it is. A tile that cannot be given says why (no data, a dataset no policy opens), and is never 0. A tile opens the
 * workbench (BI-09) on the same metric and snapshot. Dashboards a person builds come with the dashboard builder; this board is the certified metrics themselves.
 * Each metric is asked on a snapshot of the dataset that serves it (the one with every field it reads): the server plans a query by the fields of the dataset the snapshot belongs to. A metric that no dataset serves is
 * left off the board and counted in a note.
 */
export default function BoardScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <BoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

interface Served {
  metric: Metric;
  dataset: Dataset;
}

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const metrics = useMetrics();
  const datasets = useDatasets();
  const certified = useMemo(() => (metrics.data ?? []).filter((metric) => metric.status === 'CERTIFIED'), [metrics.data]);
  const plan = useMemo(
    () =>
      certified.map((metric) => ({
        metric,
        dataset: servingDataset(metric, datasets.data ?? []),
      })),
    [certified, datasets.data],
  );
  const tiles = useMemo<Served[]>(() => plan.flatMap((entry) => (entry.dataset === undefined ? [] : [{ metric: entry.metric, dataset: entry.dataset }])), [plan]);
  const unserved = useMemo(() => plan.flatMap((entry) => (entry.dataset === undefined ? [entry.metric] : [])), [plan]);
  const needed = useMemo(() => [...new Map(tiles.map((tile) => [tile.dataset.id, tile.dataset])).values()], [tiles]);
  const versionQueries = useDatasetsVersions(needed.map((dataset) => dataset.id));
  const versionsLoading = versionQueries.some((query) => query.isLoading);
  const versionsError = versionQueries.find((query) => query.error !== null)?.error;
  const frozen = new Map<string, DatasetVersion[]>();
  needed.forEach((dataset, index) =>
    frozen.set(
      dataset.id,
      (versionQueries[index]?.data ?? []).filter((version) => version.status === 'FROZEN'),
    ),
  );
  // The periods on offer are those of the datasets present; the empty choice is the newest version of each dataset.
  const periods = [...new Set(needed.flatMap((dataset) => (frozen.get(dataset.id) ?? []).map((version) => version.asOfPeriod)))];
  const [asked, setAsked] = useState('');
  const period = periods.includes(asked) ? asked : '';
  const versionOf = (dataset: Dataset): DatasetVersion | undefined => {
    const list = frozen.get(dataset.id) ?? [];
    return period === '' ? list[0] : list.find((version) => version.asOfPeriod === period);
  };
  const chosen = needed.flatMap((dataset) => versionOf(dataset) ?? []);
  const chosenPeriods = [...new Set(chosen.map((version) => version.asOfPeriod))];
  const state = useScreenState({
    isLoading: metrics.isLoading || datasets.isLoading || versionsLoading,
    error: metrics.error ?? datasets.error ?? versionsError ?? null,
    data: metrics.data === undefined ? undefined : certified,
  });
  const { tenant } = useSession();
  const [presenting, setPresenting] = useState(false);
  const tileOf = (entry: Served): ReactNode => {
    const version = versionOf(entry.dataset);
    return (
      <Tile
        key={`${entry.metric.id}:${version?.id ?? ''}`}
        metric={entry.metric}
        snapshotId={version?.id}
        dataset={entry.dataset}
        noSnapshot={version === undefined && (frozen.get(entry.dataset.id)?.length ?? 0) > 0}
      />
    );
  };
  // The presentation shows the same tiles a few at a time (a projector reads six figures, not thirty), the filter and the links left behind.
  const boards: PresentationBoard[] = [];
  for (let from = 0; from < tiles.length; from += PRESENT_PAGE) {
    const page = tiles.slice(from, from + PRESENT_PAGE);
    boards.push({
      id: `page-${from}`,
      title: t('bi.present.page.text', {
        from: from + 1,
        to: from + page.length,
      }),
      content: <KpiStrip label={t('bi.board.strip.label')}>{page.map(tileOf)}</KpiStrip>,
    });
  }
  const retry = (): void => {
    void metrics.refetch();
    void datasets.refetch();
    versionQueries.forEach((query) => void query.refetch());
  };
  const updatedAt = Math.max(0, ...versionQueries.map((query) => query.dataUpdatedAt));
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.board.page.title')}</h1>
          <p>{t('bi.board.page.subtitle')}</p>
        </div>
        <PresentButton onOpen={() => setPresenting(true)} disabled={boards.length === 0} />
        {presenting && boards.length > 0 ? (
          <PresentationMode
            title={t('bi.present.title.text', {
              period: chosenPeriods.join(', '),
            })}
            boards={boards}
            onExit={() => setPresenting(false)}
          />
        ) : null}
      </div>
      <ContextBar
        items={[
          {
            label: t('bi.board.ctx.scope'),
            value: tenant?.name ?? t('bi.board.ctx.scope.all'),
          },
          {
            label: t('bi.board.ctx.period'),
            value: chosenPeriods.length === 0 ? t('bi.board.ctx.none') : chosenPeriods.join(', '),
          },
          {
            label: t('bi.board.ctx.snapshot'),
            value: chosen.length === 0 ? t('bi.board.ctx.none') : chosen.map((version) => version.id.slice(0, 8)).join(', '),
          },
        ]}
        {...(updatedAt > 0 ? { asOf: new Date(updatedAt).toLocaleString('vi-VN') } : {})}
      />
      <StateBoundary state={state} onRetry={retry}>
        <FilterPanel applied={period === '' ? 0 : 1}>
          <div className="bi-board-filter">
            <Field id="board-period" label={t('bi.board.period')} error={undefined}>
              <select id="board-period" value={period} onChange={(event) => setAsked(event.target.value)}>
                <option value="">{t('bi.board.period.latest')}</option>
                {periods.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            {periods.length === 0 ? <p data-testid="board-no-period">{t('bi.board.noPeriod')}</p> : null}
          </div>
        </FilterPanel>
        <SectionCard title={t('bi.board.section.title')}>
          <div data-testid="board">
            <KpiStrip label={t('bi.board.strip.label')}>{tiles.map(tileOf)}</KpiStrip>
            {unserved.length > 0 ? (
              <p className="bi-board-unserved" data-testid="board-unserved">
                {t('bi.board.unserved.note', {
                  count: unserved.length,
                  codes: unserved.map((metric) => metric.code).join(', '),
                })}
              </p>
            ) : null}
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
function Tile({ metric, snapshotId, dataset, noSnapshot }: { metric: Metric; snapshotId: string | undefined; dataset: Dataset; noSnapshot: boolean }) {
  const { t, locale } = useTranslation();
  const tile = useTile(metric.id, snapshotId, tileDimensionOf(metric));
  const name = metricName(t, metric.code);
  const words = {
    noData: t('bi.query.noData'),
    notApplicable: t('bi.query.notApplicable'),
  };
  const problem = tile.error === null ? undefined : describeQueryProblem(tile.error);
  let body: ReactNode;
  if (snapshotId === undefined) {
    body = <KpiTile label={name} value={NO_FIGURE} sub={noSnapshot ? t('bi.board.noSnapshot.text') : t('bi.board.noPeriod')} />;
  } else if (tile.isLoading) {
    body = <KpiTile label={name} value={NO_FIGURE} state="loading" />;
  } else if (problem !== undefined) {
    body = (
      <KpiTile
        label={name}
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
        <KpiTile label={name} value={formatFigure(tile.data.total, tile.data.aggregationType === 'ratio' && tile.data.unit !== 'index' ? 'percent' : tile.data.unit, locale, words)} tone="info" />
        <div className="bi-tile__more">
          <FigureInfo metric={metric} datasetId={dataset.id} datasetCode={dataset.code} period={tile.data.asOfPeriod} />
          <ResultLabels result={tile.data} />
          <Link
            className="ui-button ui-button--outline ui-button--small"
            to={`${WORKBENCH_PATH}?metric=${metric.id}&snapshot=${tile.data.snapshotId}`}
            aria-label={t('bi.board.open.aria', { code: metric.code })}
          >
            {t('bi.board.open')}
          </Link>
        </div>
      </>
    );
  }
  return (
    <div className="bi-tile" data-metric-id={metric.id}>
      {body}
      {name === metric.code ? null : <p className="sub bi-tile__code">{metric.code}</p>}
    </div>
  );
}
