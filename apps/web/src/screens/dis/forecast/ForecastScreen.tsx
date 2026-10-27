import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../dis.css';
import { DefinitionBadge, NONE, SnapshotPicker, money, signedVnd } from '../rates/components';
import { useFrozenSnapshots } from '../rates/hooks';
import './forecast.css';
import { useForecast } from './hooks';
import { CHART, chartGeometry, describeForecast } from './model';
import type { Coverage, CurvePoint, Estimate, Forecast, Source } from './model';

type T = Translator['t'];

const sourceLabel = (t: T, source: Source): string =>
  source === 'FORECAST' ? t('dis.forecast.source.forecast') : source === 'REGISTERED' ? t('dis.forecast.source.registered') : source === 'MISSING' ? t('dis.forecast.source.missing') : t('dis.forecast.source.mixed');
const coverageLabel = (t: T, coverage: Coverage): string => (coverage === 'COMPLETE' ? t('dis.forecast.coverage.complete') : coverage === 'PARTIAL' ? t('dis.forecast.coverage.partial') : t('dis.forecast.coverage.none'));

/** What the estimate says about reallocation, in words: a candidate, not a candidate, or not enough to say. */
function verdict(t: T, estimate: Estimate, threshold: number): { tone: string; text: string } {
  if (estimate.reallocationCandidate === true) return { tone: 'warn', text: t('dis.forecast.candidate.yes', { pct: String(threshold) }) };
  if (estimate.reallocationCandidate === false) return { tone: 'green', text: t('dis.forecast.candidate.no', { pct: String(threshold) }) };
  return { tone: 'gray', text: estimate.eacVnd === null ? t('dis.forecast.candidate.noData') : t('dis.forecast.candidate.unknown') };
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
  const [params, setParams] = useSearchParams();
  const snapshotId = params.get('snapshot') ?? '';
  const frozen = useFrozenSnapshots();
  const forecast = useForecast(snapshotId);
  const state = useScreenState({ isLoading: forecast.isLoading, error: forecast.error, data: forecast.data, isEmpty: (data) => (data as { pages: Array<Forecast | undefined> }).pages[0] === undefined });
  const first = forecast.data?.pages[0];
  const projects = (forecast.data?.pages ?? []).flatMap((page) => page?.projects ?? []);
  const failure = forecast.isError ? describeForecast(forecast.error) : undefined;
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
      <div className="card">
        <div className="dis-filters">
          <SnapshotPicker id="forecast-snapshot" value={snapshotId} onChange={choose} snapshots={frozen.data ?? []} />
        </div>
      </div>
      {failure === 'notFound' || failure === 'notFrozen' || failure === 'validation' ? (
        <p className="callout warning" role="alert" data-testid="forecast-refusal">
          {failure === 'notFound' ? t('dis.forecast.problem.notFound') : failure === 'notFrozen' ? t('dis.forecast.problem.notFrozen') : t('dis.forecast.problem.validation')}
        </p>
      ) : null}
      <StateBoundary state={failure === 'notFound' || failure === 'notFrozen' || failure === 'validation' ? 'default' : state} onRetry={() => void forecast.refetch()}>
        {first === undefined ? null : (
          <>
            <section className="card" aria-labelledby="forecast-total-title">
              <h2 id="forecast-total-title">{t('dis.forecast.total.title', { year: String(first.planYear) })}</h2>
              <p className="sub" data-testid="forecast-cutoff">
                {t('dis.forecast.cutoff.text', { cutoff: first.cutoffDate })}
              </p>
              <dl className="dis-forecast-tiles" data-testid="forecast-tiles">
                <div>
                  <dt>{t('dis.forecast.tile.disbursed')}</dt>
                  <dd data-tile="disbursed">{money(first.disbursedVnd)}</dd>
                </div>
                <div>
                  <dt>{t('dis.forecast.tile.eac')}</dt>
                  <dd data-tile="eac">{money(first.eacVnd)}</dd>
                  <dd>
                    <span className={`pill ${first.coverage === 'COMPLETE' ? 'green' : 'gray'}`} data-testid="forecast-coverage">
                      {coverageLabel(t, first.coverage)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>{t('dis.forecast.tile.plan')}</dt>
                  <dd data-tile="plan">{money(first.planTotalVnd)}</dd>
                </div>
                <div>
                  <dt>{t('dis.forecast.tile.gap')}</dt>
                  <dd data-tile="gap">{first.gapVnd === null ? NONE : signedVnd(first.gapVnd)}</dd>
                  <dd className="sub">{first.ratioPct === null ? null : t('dis.forecast.ratio.text', { value: first.ratioPct })}</dd>
                </div>
              </dl>
              {overall === undefined ? null : (
                <p data-testid="forecast-verdict">
                  <span className={`pill ${overall.tone}`}>{overall.text}</span> <span className="sub">{t('dis.forecast.assumption.note')}</span>
                </p>
              )}
              {first.coverage === 'COMPLETE' ? null : (
                <p className="callout" role="note" data-testid="forecast-partial-note">
                  {first.eacVnd === null ? t('dis.forecast.partial.noData') : t('dis.forecast.partial.note')}
                </p>
              )}
            </section>
            <section className="card" aria-labelledby="forecast-curve-title">
              <h2 id="forecast-curve-title">{t('dis.forecast.curve.title')}</h2>
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
            </section>
            <section className="card" aria-labelledby="forecast-projects-title">
              <h2 id="forecast-projects-title">{t('dis.forecast.projects.title')}</h2>
              <div className="tablewrap">
                <table className="table" aria-label={t('dis.forecast.projects.aria')} data-testid="forecast-projects">
                  <thead>
                    <tr>
                      <th scope="col">{t('dis.forecast.projects.col.project')}</th>
                      <th scope="col" className="num">
                        {t('dis.forecast.tile.disbursed')}
                      </th>
                      <th scope="col" className="num">
                        {t('dis.forecast.tile.eac')}
                      </th>
                      <th scope="col" className="num">
                        {t('dis.forecast.tile.plan')}
                      </th>
                      <th scope="col" className="num">
                        {t('dis.forecast.tile.gap')}
                      </th>
                      <th scope="col">{t('dis.forecast.projects.col.verdict')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((project) => {
                      const said = verdict(t, project, first.thresholdPct);
                      return (
                        <tr key={project.projectId} data-project={project.projectId} data-candidate={String(project.reallocationCandidate)}>
                          <td>
                            {project.projectCode}
                            <span className="dis-code">{project.projectName}</span>
                          </td>
                          <td className="num">{money(project.disbursedVnd)}</td>
                          <td className="num">{money(project.eacVnd)}</td>
                          <td className="num">{money(project.planTotalVnd)}</td>
                          <td className="num">{project.gapVnd === null ? NONE : signedVnd(project.gapVnd)}</td>
                          <td>
                            <span className={`pill ${said.tone}`}>{said.text}</span> <span className="sub">{coverageLabel(t, project.coverage)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {forecast.hasNextPage ? (
                <p>
                  <button type="button" disabled={forecast.isFetchingNextPage} onClick={() => void forecast.fetchNextPage()}>
                    {t('dis.forecast.projects.more.action')}
                  </button>
                </p>
              ) : null}
            </section>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.forecast.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
