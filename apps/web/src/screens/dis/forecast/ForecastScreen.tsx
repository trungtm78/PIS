import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import '../dis.css';
import { DefinitionBadge, NONE, SnapshotPicker, money, signedVnd } from '../rates/components';
import { useFrozenSnapshots } from '../rates/hooks';
import '../rates/rates.css';
import './forecast.css';
import { useForecast } from './hooks';
import { CHART, chartGeometry, describeForecast } from './model';
import type { Coverage, CurvePoint, Estimate, Forecast, ProjectEstimate, Source } from './model';

type T = Translator['t'];

const sourceLabel = (t: T, source: Source): string =>
  source === 'FORECAST' ? t('dis.forecast.source.forecast') : source === 'REGISTERED' ? t('dis.forecast.source.registered') : source === 'MISSING' ? t('dis.forecast.source.missing') : t('dis.forecast.source.mixed');
const coverageLabel = (t: T, coverage: Coverage): string => (coverage === 'COMPLETE' ? t('dis.forecast.coverage.complete') : coverage === 'PARTIAL' ? t('dis.forecast.coverage.partial') : t('dis.forecast.coverage.none'));

/** What the estimate says about reallocation, in words: a candidate, not a candidate, or not enough to say. */
function verdict(t: T, estimate: Estimate, threshold: number): { tone: Tone; text: string } {
  if (estimate.reallocationCandidate === true) return { tone: 'warning', text: t('dis.forecast.candidate.yes', { pct: String(threshold) }) };
  if (estimate.reallocationCandidate === false) return { tone: 'success', text: t('dis.forecast.candidate.no', { pct: String(threshold) }) };
  return { tone: 'neutral', text: estimate.eacVnd === null ? t('dis.forecast.candidate.noData') : t('dis.forecast.candidate.unknown') };
}

/**
 * The cumulative curve of the year (ST-DIS-018, DIS-23): what the Treasury paid up to the cutoff is a solid line with round markers, the forecast after it is a dashed line with square markers, and the plan is a
 * dotted line labelled in words, so that nothing relies on colour. The picture is drawn from the same numbers as the table under it, which says them for a screen reader.
 */
function CashFlowChart({ curve, plan, t }: { curve: readonly CurvePoint[]; plan: string; t: T }) {
  const geometry = chartGeometry(curve, plan);
  return (
    <figure className="dis-forecast-figure">
      <svg role="img" aria-labelledby="forecast-chart-title forecast-chart-desc" viewBox={`0 0 ${geometry.width} ${geometry.height}`} className="dis-forecast-chart" data-testid="forecast-chart">
        <title id="forecast-chart-title">{t('dis.forecast.chart.title')}</title>
        <desc id="forecast-chart-desc">{t('dis.forecast.chart.desc')}</desc>
        {geometry.yTicks.map((tick) => (
          <g key={tick.vnd}>
            <line x1={CHART.left} x2={geometry.width - CHART.right} y1={tick.y} y2={tick.y} className="grid" />
            <text x={CHART.left - 6} y={tick.y + 4} textAnchor="end" className="tick">
              {money(tick.vnd)}
            </text>
          </g>
        ))}
        {geometry.xTicks.map((tick) => (
          <text key={tick.month} x={tick.x} y={geometry.height - 10} textAnchor="middle" className="tick">
            {tick.month === 13 ? t('dis.forecast.month.adjustment') : String(tick.month)}
          </text>
        ))}
        <line x1={CHART.left} x2={geometry.width - CHART.right} y1={geometry.plan.y} y2={geometry.plan.y} className="plan" data-line="plan" />
        <text x={geometry.width - CHART.right} y={geometry.plan.y - 5} textAnchor="end" className="label">
          {t('dis.forecast.legend.plan')}
        </text>
        {geometry.actual === '' ? null : <path d={geometry.actual} className="actual" data-line="actual" fill="none" />}
        {geometry.forecast === '' ? null : <path d={geometry.forecast} className="forecast" data-line="forecast" fill="none" />}
        {geometry.actualPoints.map((point) => (
          <circle key={`a${point.month}`} cx={point.x} cy={point.y} r={3.5} className="actual-marker" />
        ))}
        {geometry.forecastPoints.map((point) => (
          <rect key={`f${point.month}`} x={point.x - 3.5} y={point.y - 3.5} width={7} height={7} className="forecast-marker" />
        ))}
      </svg>
      <figcaption className="dis-forecast-legend">
        <span data-legend="actual">
          <svg width="34" height="10" aria-hidden="true">
            <line x1="0" x2="34" y1="5" y2="5" className="actual" />
          </svg>{' '}
          {t('dis.forecast.legend.actual')}
        </span>
        <span data-legend="forecast">
          <svg width="34" height="10" aria-hidden="true">
            <line x1="0" x2="34" y1="5" y2="5" className="forecast" />
          </svg>{' '}
          {t('dis.forecast.legend.forecast')}
        </span>
        <span data-legend="plan">
          <svg width="34" height="10" aria-hidden="true">
            <line x1="0" x2="34" y1="5" y2="5" className="plan" />
          </svg>{' '}
          {t('dis.forecast.legend.plan')}
        </span>
      </figcaption>
    </figure>
  );
}

export default function ForecastScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <ForecastContent key={tenantId ?? 'none'} route={route} />;
}

function ForecastContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const snapshotId = params.get('snapshot') ?? '';
  const frozen = useFrozenSnapshots();
  const forecast = useForecast(snapshotId);
  const state = useScreenState({ isLoading: forecast.isLoading, error: forecast.error, data: forecast.data, isEmpty: (data) => (data as { pages: Array<Forecast | undefined> }).pages[0] === undefined });
  const first = forecast.data?.pages[0];
  const projects = (forecast.data?.pages ?? []).flatMap((page) => page?.projects ?? []);
  const failure = forecast.isError ? describeForecast(forecast.error) : undefined;
  const refused = failure === 'notFound' || failure === 'notFrozen' || failure === 'validation';
  const choose = (next: string): void => {
    const value = new URLSearchParams(params);
    if (next === '') value.delete('snapshot');
    else value.set('snapshot', next);
    setParams(value, { replace: true });
  };
  const overall = first === undefined ? undefined : verdict(t, first, first.thresholdPct);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.forecast.page.title')}</h1>
          <p>{t('dis.forecast.page.subtitle')}</p>
        </div>
        {first === undefined ? null : <DefinitionBadge definition={first.definition} />}
      </div>
      <ContextBar
        items={[
          { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
          { label: t('w2dis.forecast.ctx.year'), value: first === undefined ? NONE : String(first.planYear) },
          { label: t('dis.rates.fact.cutoff'), value: first === undefined ? NONE : first.cutoffDate },
        ]}
        unit={t('dis.wr.unit')}
      />
      <FilterPanel unitLabel={t('dis.wr.unit')} applied={snapshotId === '' ? 0 : 1}>
        <div className="dis-filters">
          <SnapshotPicker id="forecast-snapshot" value={snapshotId} onChange={choose} snapshots={frozen.data ?? []} />
        </div>
      </FilterPanel>
      {refused ? (
        <p className="w2dis-banner" role="alert" data-testid="forecast-refusal">
          {failure === 'notFound' ? t('dis.forecast.problem.notFound') : failure === 'notFrozen' ? t('dis.forecast.problem.notFrozen') : t('dis.forecast.problem.validation')}
        </p>
      ) : null}
      <StateBoundary state={refused ? 'default' : state} onRetry={() => void forecast.refetch()}>
        {first === undefined ? null : (
          <div className="w2dis-stack">
            <SectionCard title={t('dis.forecast.total.title', { year: String(first.planYear) })} unit={t('dis.wr.unit')}>
              <div className="w2dis-stack">
                <p className="w2dis-note" data-testid="forecast-cutoff">
                  {t('dis.forecast.cutoff.text', { cutoff: first.cutoffDate })}
                </p>
                <div data-testid="forecast-tiles">
                  <KpiStrip label={t('dis.forecast.total.title', { year: String(first.planYear) })}>
                    <KpiTile label={t('dis.forecast.tile.disbursedTreasury')} value={money(first.disbursedVnd)} />
                    <KpiTile
                      label={t('dis.forecast.tile.yearEnd')}
                      value={money(first.eacVnd)}
                      tone="info"
                      sub={
                        <span data-testid="forecast-coverage">
                          <StatusPill tone={first.coverage === 'COMPLETE' ? 'success' : first.coverage === 'PARTIAL' ? 'warning' : 'neutral'}>{coverageLabel(t, first.coverage)}</StatusPill>
                        </span>
                      }
                    />
                    <KpiTile label={t('dis.forecast.tile.plan')} value={money(first.planTotalVnd)} />
                    <KpiTile label={t('dis.forecast.tile.gapPlan')} value={first.gapVnd === null ? NONE : signedVnd(first.gapVnd)} sub={first.ratioPct === null ? undefined : t('dis.forecast.ratio.text', { value: first.ratioPct })} />
                  </KpiStrip>
                </div>
                <dl className="w2dis-facts" data-testid="forecast-method">
                  <dt>{t('dis.forecast.method.title')}</dt>
                  <dd>{t('dis.forecast.method.text')}</dd>
                </dl>
                {overall === undefined ? null : (
                  <p className="w2dis-verdict" data-testid="forecast-verdict">
                    <StatusPill tone={overall.tone}>{overall.text}</StatusPill> <span className="w2dis-note">{t('dis.forecast.assumption.note')}</span>
                  </p>
                )}
                {first.coverage === 'COMPLETE' ? null : (
                  <p className="w2dis-banner w2dis-banner--info" role="note" data-testid="forecast-partial-note">
                    {first.eacVnd === null ? t('dis.forecast.partial.noData') : t('dis.forecast.partial.note')}
                  </p>
                )}
              </div>
            </SectionCard>
            <SectionCard title={t('dis.forecast.curve.title')} unit={t('dis.wr.unit')}>
              <CashFlowChart curve={first.curve} plan={first.planTotalVnd} t={t} />
              <div className="tablewrap">
                <table className="table" aria-label={t('dis.forecast.curve.aria')} data-testid="forecast-curve-table">
                  <caption className="sr-only">{t('dis.forecast.curve.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('dis.forecast.curve.col.month')}</th>
                      <th scope="col" className="num">
                        {t('dis.forecast.curve.col.actual')}
                      </th>
                      <th scope="col" className="num">
                        {t('dis.forecast.curve.col.forecast')}
                      </th>
                      <th scope="col" className="num">
                        {t('dis.forecast.curve.col.plan')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {first.curve.map((point) => (
                      <tr key={point.month} data-month={point.month}>
                        <th scope="row">{point.month === 13 ? t('dis.forecast.month.adjustment') : t('dis.forecast.month.number', { month: String(point.month) })}</th>
                        <td className="num" data-cell="actual">
                          {money(point.actualVnd)}
                        </td>
                        <td className="num" data-cell="forecast">
                          {money(point.forecastVnd)}
                        </td>
                        <td className="num" data-cell="plan">
                          {money(first.planTotalVnd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>{t('dis.forecast.months.title')}</h3>
              <div className="tablewrap">
                <table className="table" aria-label={t('dis.forecast.months.aria')} data-testid="forecast-months-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('dis.forecast.curve.col.month')}</th>
                      <th scope="col" className="num">
                        {t('dis.forecast.months.col.amount')}
                      </th>
                      <th scope="col">{t('dis.forecast.months.col.source')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {first.months.map((month) => (
                      <tr key={month.month} data-month={month.month}>
                        <th scope="row">{month.month === 13 ? t('dis.forecast.month.adjustment') : t('dis.forecast.month.number', { month: String(month.month) })}</th>
                        <td className="num">{money(month.amountVnd)}</td>
                        <td>{sourceLabel(t, month.source)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
            <SectionCard title={t('dis.forecast.projects.title')} unit={t('dis.wr.unit')}>
              <ProjectTable projects={projects} threshold={first.thresholdPct} />
              {forecast.hasNextPage ? (
                <p className="w2dis-more">
                  <button type="button" className="ui-button ui-button--outline" disabled={forecast.isFetchingNextPage} onClick={() => void forecast.fetchNextPage()}>
                    {t('dis.forecast.projects.more.action')}
                  </button>
                </p>
              ) : null}
            </SectionCard>
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.forecast.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** A row for each project: what was paid, the estimate, the plan, the gap and what the estimate says about reallocation (a word on a pill and the coverage, never colour alone). */
function ProjectTable({ projects, threshold }: { projects: readonly ProjectEstimate[]; threshold: number }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<ProjectEstimate>[] = [
    {
      key: 'project',
      header: t('dis.forecast.projects.col.projectUnit'),
      pinned: true,
      render: (project) => (
        <>
          <strong>{project.projectCode}</strong>
          <span className="dis-code">{project.projectName}</span>
        </>
      ),
    },
    { key: 'disbursed', header: t('dis.forecast.tile.disbursedTreasury'), align: 'right', render: (project) => money(project.disbursedVnd) },
    { key: 'eac', header: t('dis.forecast.tile.yearEnd'), align: 'right', render: (project) => money(project.eacVnd) },
    { key: 'plan', header: t('dis.forecast.tile.plan'), align: 'right', render: (project) => money(project.planTotalVnd) },
    { key: 'gap', header: t('dis.forecast.tile.gapPlan'), align: 'right', render: (project) => (project.gapVnd === null ? NONE : signedVnd(project.gapVnd)) },
    {
      key: 'verdict',
      header: t('dis.forecast.projects.col.verdict'),
      render: (project) => {
        const said = verdict(t, project, threshold);
        return (
          <>
            <StatusPill tone={said.tone}>{said.text}</StatusPill>
            <span className="w2dis-sub">{coverageLabel(t, project.coverage)}</span>
          </>
        );
      },
    },
  ];
  return <DataTable caption={t('dis.forecast.projects.aria')} columns={columns} rows={[...projects]} rowKey={(project) => project.projectId} />;
}
