import { Link } from 'react-router-dom';
import { useEdition } from '../../editions/EditionContext';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { CommandHero, DataTable, FlowChart, KpiStrip, KpiTile, PeriodProgress, SectionCard, StatusPill } from '../../ui';
import type { Severity, Tone } from '../../ui';
import { FigureInfo, FlagPills, figureShown, noneText } from './figure-components';
import { MY_WORK_PATH, REALLOCATION_PATH, WARNINGS_PATH, countTileOf, drillPathOf, figureText } from './model';
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

/** What one rate says in the chips of the command block: the text the server wrote for it and its unit, or why there is none (never a rate made here). */
function rateChip(t: T, tile: Tile | undefined): string {
  if (tile === undefined) return t('home.ov.kpi.missing');
  return figureShown(t, tile);
}

/** The "i" of a figure and the flags that sit on it, side by side. */
function FigureNotes({ tile }: { tile: Tile | undefined }) {
  if (tile === undefined) return null;
  return (
    <>
      <FigureInfo tile={tile} /> <FlagPills tile={tile} />
    </>
  );
}

/** A whole number of dong with its digits grouped by thousands in the format of the language, when the edition asks for it; any other text is left as it came. */
export function groupedText(text: string, locale: string, on: boolean): string {
  return on && /^\d{4,}$/.test(text) ? text.replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'en' ? ',' : '.') : text;
}

/** The dark command block: the amount disbursed, the ring over the plan the Prime Minister gave, the two rates side by side with their denominators, and the two actions. */
export function Hero({ center, year }: { center: CommandCenter; year: string }) {
  const { t, locale } = useTranslation();
  const style = useEdition().slots?.homeFigures;
  const hero = heroOf(center);
  const disbursedTile = tileOf(center, 'DISBURSED_TREASURY');
  const pm = tileOf(center, 'DISBURSEMENT_RATE_PM');
  const total = tileOf(center, 'DISBURSEMENT_RATE_TOTAL');
  const amount = disbursedTile === undefined ? null : disbursedTile.displayValue;
  const missing = disbursedTile === undefined || disbursedTile.nullReason === null || disbursedTile.nullReason === 'NO_DATA' ? t('home.ov.hero.noData') : noneText(t, disbursedTile);
  return (
    <CommandHero
      label={t('home.ov.hero.label', { year })}
      value={amount === null ? '—' : groupedText(figureText({ displayValue: amount }), locale, style?.groupDigits === true)}
      unit={amount === null ? '' : t('govc.home.unit.vnd')}
      caption={
        <>
          {amount === null ? missing : t('home.ov.hero.caption', { date: dayText(center.treasuryCutoffDate === '' ? center.asOfDate : center.treasuryCutoffDate) })} <FigureNotes tile={disbursedTile} />
        </>
      }
      {...(style?.publicPlanBlocks === false
        ? {}
        : {
            ratio: { percent: hero.ringPercent, label: t('home.ov.hero.ring') },
            chips: [
              { label: t('home.ov.hero.chip.pm'), value: rateChip(t, pm), info: <FigureNotes tile={pm} /> },
              { label: t('home.ov.hero.chip.total'), value: rateChip(t, total), info: <FigureNotes tile={total} /> },
            ],
          })}
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
export function Kpis({ center, waiting, counts }: { center: CommandCenter; waiting: WaitingCounts; counts?: readonly Tile[] }) {
  const { t } = useTranslation();
  const planTile = tileOf(center, 'PLAN_TOTAL');
  const pmTile = tileOf(center, 'PLAN_PM_ASSIGNED');
  const given = counts ?? center.countTiles;
  const warnings = countTileOf(given, 'OPEN_WARNINGS');
  const overdue = countTileOf(given, 'OVERDUE_EXPLANATIONS');
  const realloc = countTileOf(given, 'PENDING_REALLOCATIONS');
  const coverage = coverageOf(center.scope.projects, center.projectsWithoutData);
  const warningTone: Tone = warnings === undefined || warnings.displayValue === null ? 'neutral' : waiting.openWarnings > 0 ? 'warning' : 'success';
  const style = useEdition().slots?.homeFigures;
  const planText = planTile?.displayValue ?? null;
  const pmText = pmTile?.displayValue ?? null;
  return (
    <div data-testid="home-kpis">
      <KpiStrip label={t('home.ov.kpi.group')}>
        {style?.publicPlanBlocks === false ? null : (
        <KpiTile
          label={t('home.ov.kpi.plan.label')}
          value={planText ?? '—'}
          {...(planText === null ? {} : { unit: t('govc.home.unit.vnd') })}
          sub={
            <>
              {planText === null ? (planTile === undefined ? t('home.ov.kpi.missing') : noneText(t, planTile)) : pmText === null ? t('home.ov.kpi.plan.subMissing') : t('govc.home.kpi.plan.sub', { pm: pmText })} <FigureNotes tile={planTile} />
              {pmText === null ? null : <FigureNotes tile={pmTile} />}
            </>
          }
        />
        )}
        <KpiTile
          label={t('home.ov.kpi.warnings.label')}
          value={warnings === undefined ? '—' : figureText(warnings)}
          tone={warningTone}
          sub={
            <>
              {warnings !== undefined && warnings.displayValue === null ? <>{noneText(t, warnings)} · </> : null}
              <Link to={MY_WORK_PATH}>{overdue === undefined || overdue.displayValue === null ? t('govc.home.kpi.warnings.overdueNone') : t('home.ov.kpi.warnings.sub', { count: figureText(overdue) })}</Link> <FigureNotes tile={warnings} /> <FigureNotes tile={overdue} /> · <Link to={WARNINGS_PATH}>{t('home.ov.kpi.open')}</Link>
            </>
          }
        />
        <KpiTile
          label={t('home.ov.kpi.realloc.label')}
          value={realloc === undefined ? '—' : figureText(realloc)}
          tone="neutral"
          sub={
            <>
              {realloc !== undefined && realloc.displayValue === null ? <>{noneText(t, realloc)} · </> : null}
              {t('home.ov.kpi.realloc.sub')} <FigureNotes tile={realloc} /> · <Link to={REALLOCATION_PATH}>{t('home.ov.kpi.open')}</Link>
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
