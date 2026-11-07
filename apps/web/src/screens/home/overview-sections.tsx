import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { CommandHero, DataTable, FlowChart, KpiStrip, KpiTile, PeriodProgress, SectionCard, StatusPill } from '../../ui';
import type { Severity, Tone } from '../../ui';
import { tileValue } from './components';
import { MY_WORK_PATH, REALLOCATION_PATH, WARNINGS_PATH, drillPathOf } from './model';
import type { CommandCenter, Tile, WaitingCounts } from './model';
import { billionsOf, bottlenecksOf, coverageOf, dayText, hasCurve, heroOf, percentOf, tileOf, topRanked } from './overview-model';
import type { Bottleneck, CashFlow } from './overview-model';
import { useCashFlow, useCauseWarnings } from './overview-hooks';
import { useRankings } from './warning-hooks';
import type { RankingRow } from './warning-model';

type T = Translator['t'];
export const RANKING_PATH = '/home/home-04';
const RANK_ROWS = 5;

const RULE_SEVERITY: Record<Bottleneck['worst'], Severity> = {
  CRITICAL: 'URGENT',
  WARNING: 'ACTION',
  INFO: 'WATCH',
};

/** A part of the page that could not be read: it names the source and retries in place; it is never an empty part and never a figure. */
export function SourceError({ source, onRetry }: { source: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="home-source-error" data-testid="source-error">
      <p>{t('home.ov.source.error', { source })}</p>
      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
        {t('ui.common.retry')}
      </button>
    </div>
  );
}

/** What one rate says in the chips of the command block: the rate with its numerator and denominator in billions, or why there is none. */
function rateChip(t: T, locale: string, tile: Tile | undefined): string {
  if (tile === undefined) return t('home.ov.kpi.missing');
  if (tile.value === null) return tileValue(t, tile);
  const percent = percentOf(tile.value, locale);
  const numerator = billionsOf(tile.numerator, locale);
  const denominator = billionsOf(tile.denominator, locale);
  if (percent === null) return t('home.ov.kpi.missing');
  return numerator === null || denominator === null ? t('home.tile.value.percent', { value: percent }) : t('home.ov.hero.chip.value', { percent, numerator, denominator });
}

/** The dark command block: the amount disbursed, the ring over the plan the Prime Minister gave, the two rates side by side with their denominators, and the two actions. */
export function Hero({ center, year }: { center: CommandCenter; year: string }) {
  const { t, locale } = useTranslation();
  const hero = heroOf(center);
  const amount = billionsOf(hero.disbursedVnd, locale);
  const disbursedTile = tileOf(center, 'DISBURSED_TREASURY');
  const pm = tileOf(center, 'DISBURSEMENT_RATE_PM');
  const total = tileOf(center, 'DISBURSEMENT_RATE_TOTAL');
  return (
    <CommandHero
      label={t('home.ov.hero.label', { year })}
      value={amount ?? '—'}
      unit={t('home.ov.hero.unit')}
      caption={
        amount === null
          ? t('home.ov.hero.noData')
          : t('home.ov.hero.caption', {
              date: dayText(center.treasuryCutoffDate === '' ? center.asOfDate : center.treasuryCutoffDate),
            })
      }
      ratio={{ percent: hero.ringPercent, label: t('home.ov.hero.ring') }}
      chips={[
        { label: t('home.ov.hero.chip.pm'), value: rateChip(t, locale, pm) },
        {
          label: t('home.ov.hero.chip.total'),
          value: rateChip(t, locale, total),
        },
      ]}
      actions={
        <>
          {disbursedTile === undefined ? null : (
            <Link className="ui-button ui-button--onDark" to={drillPathOf(disbursedTile)}>
              {t('home.ov.hero.action.sources')}
            </Link>
          )}
          <Link className="ui-button ui-button--onDark" to={RANKING_PATH}>
            {t('home.ov.hero.action.ranking')}
          </Link>
        </>
      }
    />
  );
}

/** The four tiles under the command block: the plan, the early warnings, the reallocations awaiting a decision, and how many projects have a figure. */
export function Kpis({ center, waiting }: { center: CommandCenter; waiting: WaitingCounts }) {
  const { t, locale } = useTranslation();
  const plan = billionsOf(tileOf(center, 'PLAN_TOTAL')?.value ?? null, locale);
  const pmPlan = billionsOf(tileOf(center, 'PLAN_PM_ASSIGNED')?.value ?? null, locale);
  const coverage = coverageOf(center.scope.projects, center.projectsWithoutData);
  const unit = t('home.ov.hero.unit');
  const warningTone: Tone = waiting.openWarnings > 0 ? 'warning' : 'success';
  return (
    <div data-testid="home-kpis">
      <KpiStrip label={t('home.ov.kpi.group')}>
        <KpiTile
          label={t('home.ov.kpi.plan.label')}
          value={plan ?? '—'}
          unit={plan === null ? undefined : unit}
          sub={plan === null ? t('home.ov.kpi.missing') : pmPlan === null ? t('home.ov.kpi.plan.subMissing') : t('home.ov.kpi.plan.sub', { pm: pmPlan })}
        />
        <KpiTile
          label={t('home.ov.kpi.warnings.label')}
          value={String(waiting.openWarnings)}
          tone={warningTone}
          sub={
            <>
              <Link to={MY_WORK_PATH}>
                {t('home.ov.kpi.warnings.sub', {
                  count: waiting.overdueExplanations,
                })}
              </Link>{' '}
              · <Link to={WARNINGS_PATH}>{t('home.ov.kpi.open')}</Link>
            </>
          }
        />
        <KpiTile
          label={t('home.ov.kpi.realloc.label')}
          value={String(waiting.pendingReallocations)}
          tone="neutral"
          sub={
            <>
              {t('home.ov.kpi.realloc.sub')} · <Link to={REALLOCATION_PATH}>{t('home.ov.kpi.open')}</Link>
            </>
          }
        />
        <PeriodProgress
          title={t('home.ov.kpi.coverage.title')}
          percent={coverage.percent}
          sent={coverage.sent}
          total={coverage.total}
          dueLabel={t('home.ov.kpi.coverage.due', {
            date: dayText(center.asOfDate),
          })}
          tone={center.projectsWithoutData > 0 ? 'warning' : 'success'}
        />
      </KpiStrip>
    </div>
  );
}

/**
 * The bottlenecks by their impact: the open warnings read as causes. They are counted by the rule that raised them and not listed one by one, so this section never repeats the items of the band above it.
 * A source that cannot be read is named; "no open warning" is said only when the source answered.
 */
export function Causes() {
  const { t, locale } = useTranslation();
  const query = useCauseWarnings();
  const source = t('home.ov.source.warnings');
  const rows = query.data === undefined ? [] : bottlenecksOf(query.data);
  return (
    <SectionCard title={t('home.ov.cause.title')} unit={t('home.ov.hero.unit')} actions={<Link to={WARNINGS_PATH}>{t('home.ov.cause.link')}</Link>}>
      <p className="home-note">{t('home.ov.cause.note')}</p>
      {query.isError ? (
        <SourceError source={source} onRetry={() => void query.refetch()} />
      ) : (
        <DataTable<Bottleneck>
          caption={t('home.ov.cause.caption')}
          state={query.isLoading ? 'loading' : rows.length === 0 ? 'empty' : 'ready'}
          emptyKind="none"
          rows={rows}
          rowKey={(row) => row.ruleCode}
          severity={(row) => RULE_SEVERITY[row.worst]}
          columns={[
            {
              key: 'cause',
              header: t('home.ov.cause.col.cause'),
              pinned: true,
              render: (row) => <strong>{row.ruleName}</strong>,
            },
            {
              key: 'warnings',
              header: t('home.ov.cause.col.warnings'),
              align: 'right',
              render: (row) => row.count,
            },
            {
              key: 'projects',
              header: t('home.ov.cause.col.projects'),
              align: 'right',
              render: (row) => row.projects,
            },
            {
              key: 'impact',
              header: t('home.ov.cause.col.impact'),
              align: 'right',
              render: (row) => billionsOf(row.impactVnd, locale) ?? t('home.ov.cause.noImpact'),
            },
            {
              key: 'sample',
              header: t('home.ov.cause.col.sample'),
              render: (row) => (row.sample.length === 0 ? '—' : row.sample.join(', ')),
            },
          ]}
        />
      )}
      {!query.isError && !query.isLoading && rows.length === 0 ? <p className="home-note">{t('home.ov.cause.empty')}</p> : null}
    </SectionCard>
  );
}

function flowSeries(t: T, flow: CashFlow) {
  const label = (month: number): string => t('home.ov.flow.month', { month });
  return [
    {
      label: t('home.ov.flow.actual'),
      style: 'actual' as const,
      points: flow.points.flatMap((point) => (point.actualBillions === null ? [] : [{ x: label(point.month), y: point.actualBillions }])),
    },
    {
      label: t('home.ov.flow.plan'),
      style: 'plan' as const,
      points: flow.points.flatMap((point) => (point.forecastBillions === null ? [] : [{ x: label(point.month), y: point.forecastBillions }])),
    },
  ];
}

/** The cumulative cash flow of the year: what was disbursed in a solid line and the forecast in a dashed one. A month with no figure has no point (it is not drawn at 0). */
export function CashFlowCard({ snapshotId, unitId, year }: { snapshotId: string; unitId: string; year: string }) {
  const { t } = useTranslation();
  const query = useCashFlow(snapshotId, unitId);
  const flow = query.data;
  const caption = t('home.ov.flow.caption', { year: flow?.planYear ?? year });
  return (
    <SectionCard title={t('home.ov.flow.title')} unit={t('home.ov.flow.unit')}>
      {query.isError ? (
        <SourceError source={t('home.ov.source.cashflow')} onRetry={() => void query.refetch()} />
      ) : (
        <FlowChart unit={t('home.ov.flow.unit')} caption={caption} state={flow === undefined ? 'loading' : hasCurve(flow) ? 'ready' : 'empty'} series={flow === undefined ? [] : flowSeries(t, flow)} />
      )}
    </SectionCard>
  );
}

const rate = (t: T, locale: string, row: RankingRow): string => {
  const percent = percentOf(row.ratePct, locale);
  return percent === null ? t('home.tile.nullReason.noData') : t('home.tile.value.percent', { value: percent });
};

/** The first rows of the ranking of the units over the plan the Prime Minister gave; the full table is HOME-04. */
export function RankingCard() {
  const { t, locale } = useTranslation();
  const query = useRankings();
  const top = query.data === undefined ? undefined : topRanked(query.data, RANK_ROWS);
  return (
    <SectionCard
      title={t('home.ov.rank.title')}
      unit={t('home.ov.flow.unit')}
      status={query.data?.definitionStatus === 'SIGNED' || query.data === undefined ? undefined : <StatusPill tone="warning">{t('home.tile.definition.pending', { ref: 'CXN-03' })}</StatusPill>}
    >
      {query.isError ? (
        <SourceError source={t('home.ov.source.rankings')} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <DataTable<RankingRow>
            caption={top === undefined ? t('home.ov.rank.title') : t('home.ov.rank.caption', { group: top.group })}
            state={query.isLoading ? 'loading' : top === undefined ? 'empty' : 'ready'}
            emptyKind="none"
            rows={top?.rows ?? []}
            rowKey={(row) => row.unitId}
            columns={[
              {
                key: 'rank',
                header: t('home.ranking.column.rank'),
                render: (row) => row.rank ?? '—',
              },
              {
                key: 'unit',
                header: t('home.ranking.column.unit'),
                pinned: true,
                render: (row) => (row.unitName === '' ? row.unitCode : row.unitName),
              },
              {
                key: 'plan',
                header: t('home.ranking.column.plan'),
                align: 'right',
                render: (row) => billionsOf(row.planVnd, locale) ?? '—',
              },
              {
                key: 'disbursed',
                header: t('home.ranking.column.disbursed'),
                align: 'right',
                render: (row) => billionsOf(row.disbursedVnd, locale) ?? t('home.tile.nullReason.noData'),
              },
              {
                key: 'rate',
                header: t('home.ranking.column.rate'),
                align: 'right',
                render: (row) => rate(t, locale, row),
              },
            ]}
          />
          {top === undefined ? null : (
            <p>
              <Link to={RANKING_PATH}>{t('home.ov.rank.more', { total: top.total })}</Link>
            </p>
          )}
        </>
      )}
    </SectionCard>
  );
}
