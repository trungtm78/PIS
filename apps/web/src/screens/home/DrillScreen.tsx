import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApiClient } from '../../api/ApiClientContext';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { ApiError } from '@machvon/api-client';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { formatVnd } from '../dis/report/money';
import { ContextBar, DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import '../dis/dis.css';
import './home.css';
import { homeRoot } from './hooks';
import { FORMULA_REFERENCE, MY_WORK_PATH, SNAPSHOT_SCREEN_PATH, shortId, toCommandCenter } from './model';
import { describeDrill, dimensionOf, orderOf, refreshTargetOf, toDrill, tokenOfMetric } from './drill-model';
import type { Drill, DrillAlert, DrillChild, DrillDimension, DrillOrder, Step } from './drill-model';
import { dayText, percentOf } from './overview-model';
import { PROFILE_PATH, SEVERITIES } from './warning-model';
import type { Severity } from './warning-model';
import { explanationStatusLabel, severityLabel, warningStatusLabel } from './WarningsScreen';

type T = Translator['t'];
const COMMAND_CENTER_PATH = '/home/home-09';
const PAGE_SIZE = 50;
const NONE = '—';

function metricLabel(t: T, code: string): string {
  switch (code) {
    case 'DISBURSEMENT_RATE_PM':
      return t('dis.rates.col.ratePm');
    case 'DISBURSEMENT_RATE_TOTAL':
      return t('dis.rates.col.rateTotal');
    case 'DISBURSED_TREASURY':
      return t('home.tile.metric.disbursed');
    case 'PLAN_PM_ASSIGNED':
      return t('home.tile.metric.planPm');
    case 'PLAN_TOTAL':
      return t('home.tile.metric.planTotal');
    default:
      return code;
  }
}

function reasonLabel(t: T, reason: string | null): string {
  switch (reason) {
    case 'NO_DATA':
      return t('home.tile.nullReason.noData');
    case 'ZERO_DENOMINATOR':
      return t('home.tile.nullReason.zeroDenominator');
    case 'TREASURY_COVERAGE_NONE':
      return t('home.tile.nullReason.treasuryNone');
    default:
      return t('home.tile.nullReason.other');
  }
}

/** A figure of the drill as it is read: the percent with its decimals, whole dong, or why there is none (never 0). */
function figure(t: T, unit: 'PERCENT' | 'VND', value: string | null, reason: string | null): string {
  if (value === null) return reasonLabel(t, reason);
  return unit === 'PERCENT' ? t('home.tile.value.percent', { value }) : t('home.tile.value.vnd', { value: formatVnd(value) });
}

function dimensionLabel(t: T, dimension: DrillDimension): string {
  switch (dimension) {
    case 'unit':
      return t('home.drill.dimension.unit');
    case 'project':
      return t('home.drill.dimension.project');
    case 'cell':
      return t('home.drill.dimension.cell');
  }
}

/**
 * HOME-10: where a figure comes from (ST-HOME-002, HOME 3 F2, BR-HOME-03, BR-HOME-08): the formula, the numerator and the denominator, what is left out, the children of the figure (units, projects, the cells of a project)
 * with the way to go down into each, the proof that the children add up to the parent (or why a ratio does not), and the sources the figures were taken from (the report revision, the Treasury transactions). Every step
 * is of the snapshot the figure was read in, and the right to read is judged again at each: when it is gone the page says so and shows no name.
 */
export default function DrillScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  const [params] = useSearchParams();
  // What is open belongs to one member of one tenant, and to the figure the address names: a switch of either starts the screen over.
  return <DrillContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${params.get('token') ?? ''}`} route={route} />;
}

function DrillContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const client = useApiClient();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const start = params.get('token') ?? '';
  const [trail, setTrail] = useState<Step[]>(() => (start === '' ? [] : [{ token: start, label: '' }]));
  // The order and the division the reader chose live in the address: they are kept when the drill goes down a step and comes back, and a copied address opens the same reading.
  const order = orderOf(params.get('order'));
  const dimension = dimensionOf(params.get('dim'));
  const setQuery = (changes: Record<string, string | null>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };
  const setDimension = (next: DrillDimension | ''): void => setQuery({ dim: next });
  const [refreshed, setRefreshed] = useState(false);
  // The drill went on from the tile of the unit because a token below it could not be renewed one by one: the page says so.
  const [restarted, setRestarted] = useState(false);
  const current = trail[trail.length - 1];
  const token = current?.token ?? '';

  const query = useInfiniteQuery<Drill, Error, { pages: Drill[] }, readonly unknown[], string | undefined>({
    // The order is part of the key: the cursor of a page belongs to one order, so a change of order starts the reading again from its first page.
    queryKey: [...homeRoot(tenant?.id), 'drill', tenant?.membershipId, token, dimension, order],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      const drill = toDrill(await client.read('explainHomeMetric', { query: { context_token: token, limit: PAGE_SIZE, ...(dimension === '' ? {} : { child_dimension: dimension }), ...(order === 'drag' ? { order } : {}), ...(pageParam === undefined ? {} : { cursor: pageParam }) } }));
      if (drill === undefined) throw new Error('the drill could not be read');
      return drill;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: tenant !== undefined && token !== '',
    retry: false,
    // The figures of a snapshot do not change, but the right to read them can: a step that is visited again is asked for again (what was kept is shown while the answer comes, and gone if the answer is a refusal).
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const problem = query.error === null ? undefined : describeDrill(query.error);
  // A token that is old is renewed over the same snapshot: the center is asked for it again (once), and the page goes on.
  const target = refreshTargetOf(query.error);
  const renewal = useQuery({
    queryKey: [...homeRoot(tenant?.id), 'drill-renewal', tenant?.membershipId, target?.snapshotId ?? '', target?.metricCode ?? '', target?.unitId ?? ''],
    queryFn: async (): Promise<{ token: string | undefined; widened: boolean }> => {
      const ask = async (unitId: string | null | undefined) => toCommandCenter(await client.read('getCommandCenter', { query: { snapshot_id: target?.snapshotId ?? '', ...(unitId === null || unitId === undefined ? {} : { unit_id: unitId }) } }));
      try {
        const center = await ask(target?.unitId);
        return { token: center === undefined ? undefined : tokenOfMetric(center.tiles, target?.metricCode ?? ''), widened: false };
      } catch (error) {
        // A reader whose right to a unit is by a project of it (not by a grant of units) is not let to narrow the center to the unit: the same snapshot is asked for the whole of their scope, and the page says so.
        if (!(error instanceof ApiError) || error.code !== 'SCOPE_DENIED' || target?.unitId === null || target?.unitId === undefined) throw error;
        const center = await ask(null);
        return { token: center === undefined ? undefined : tokenOfMetric(center.tiles, target.metricCode), widened: true };
      }
    },
    enabled: target !== undefined && !refreshed,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const renewed = renewal.data?.token;
  const widened = renewal.data?.widened === true;
  useEffect(() => {
    if (renewed !== undefined && target !== undefined && !refreshed) {
      setRefreshed(true);
      setRestarted(target.deeper || widened);
      // Below the unit the old steps cannot be renewed one by one: the drill goes on from the tile of the unit, and says so.
      setTrail((steps) => (target.deeper || widened ? [{ token: renewed, label: steps[0]?.label ?? '' }] : [...steps.slice(0, -1), { token: renewed, label: steps[steps.length - 1]?.label ?? '' }]));
    }
  }, [renewed, widened, target, refreshed]);
  useEffect(() => {
    if (query.data !== undefined) setRefreshed(false);
  }, [query.data]);

  const first = query.data?.pages[0];
  const last = query.data?.pages[query.data.pages.length - 1];
  // A later page that is read under another scope than the first (the grants changed between the two, whether or not the token was already of an older scope) is not added to it: the reading starts again with the token that page brought, which is of the scope the reader has now.
  const laterScopeMoved = first !== undefined && last !== undefined && last.contextToken !== '' && last.scopeHash !== '' && query.data !== undefined && query.data.pages.some((page) => page.scopeHash !== last.scopeHash);
  useEffect(() => {
    if (laterScopeMoved && last !== undefined) setTrail((steps) => [...steps.slice(0, -1), { token: last.contextToken, label: steps[steps.length - 1]?.label ?? '' }]);
  }, [laterScopeMoved, last]);
  // A child is shown once, whatever page it came with.
  const children = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages.flatMap((page) => page.children) ?? []).filter((child) => (seen.has(`${child.dimension}:${child.id}`) ? false : (seen.add(`${child.dimension}:${child.id}`), true)));
  }, [query.data]);
  const sources = useMemo(() => query.data?.pages.flatMap((page) => page.sources) ?? [], [query.data]);
  // The renewal gave nothing (it failed, or the center has no such tile now): the token cannot be renewed, and the page says it is not good.
  const renewalFailed = problem === 'expired' && (renewal.isError || (renewal.isSuccess && renewal.data.token === undefined));
  const waiting = problem === 'expired' && !renewalFailed;
  // A right that is gone, a token that is not good or a snapshot that is not there are pages of their own, with no name on them.
  const ownProblem = problem === 'denied' || problem === 'invalid' || problem === 'notFound' || renewalFailed;
  const state = useScreenState({ isLoading: query.isLoading || waiting || laterScopeMoved, error: ownProblem ? undefined : query.error, data: ownProblem ? undefined : first });

  const open = (child: DrillChild): void => {
    // The step that is left remembers its division, and the next one starts with its own; the order goes down with the reader.
    setQuery({ dim: null });
    setTrail((steps) => [...steps.slice(0, -1), ...(steps.length === 0 ? [] : [{ ...steps[steps.length - 1], dimension } as Step]), { token: child.contextToken, label: child.code === '' ? child.name : `${child.code} ${child.name}`.trim() }]);
  };
  const goTo = (index: number): void => {
    setQuery({ dim: trail[index]?.dimension ?? null });
    setTrail((steps) => steps.slice(0, index + 1));
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.drill.page.title')}</h1>
          <p>{t('home.drill.page.subtitle')}</p>
        </div>
      </div>
      {token === '' ? (
        <div className="card statecard" role="alert" data-testid="drill-no-token">
          <p>{t('home.drill.noToken')}</p>
          <Link to={COMMAND_CENTER_PATH}>{t('home.drill.back')}</Link>
        </div>
      ) : null}
      {ownProblem ? <DrillProblemCard problem={renewalFailed ? 'invalid' : problem === 'expired' || problem === undefined ? 'general' : problem} /> : null}
      {token === '' ? null : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {first === undefined || last === undefined || ownProblem || laterScopeMoved ? null : (
            <DrillBody
              drill={first}
              trail={trail}
              metric={metricLabel(t, first.metricCode)}
              rows={children}
              sources={sources}
              dimension={dimension === '' ? (first.dimension ?? '') : dimension}
              onDimension={(next) => setDimension(next)}
              order={order}
              onOrder={(next) => setQuery({ order: next === 'code' ? null : next })}
              onOpen={open}
              onStep={goTo}
              more={query.hasNextPage === true}
              loadingMore={query.isFetchingNextPage}
              onMore={() => void query.fetchNextPage()}
              onRefresh={() => {
                // The token of the answer is the same step under the scope the reader has now: taking it is what clears the warning (the old one would be read as made under another scope again).
                if (first.scopeChanged && first.contextToken !== '') setTrail((steps) => [...steps.slice(0, -1), { token: first.contextToken, label: steps[steps.length - 1]?.label ?? '' }]);
                else void query.refetch();
              }}
              restarted={restarted}
            />
          )}
        </StateBoundary>
      )}
    </section>
  );
}

/** What a part of the whole ratio pulls it by, in percentage points ("-10.00 points %"); null when the figure is not a ratio. */
function dragText(t: T, locale: string, points: string | null): string {
  const value = points === null ? null : percentOf(points, locale);
  return value === null ? NONE : t('govc.home.drill.drag', { value });
}

/** "Indicator → Unit → Project/record": where the reader is in the three steps of the drill. The step is the server's, and it is said in words as well as by the mark. */
function StepTrail({ step, total }: { step: number; total: number }) {
  const { t } = useTranslation();
  const names = [t('govc.home.drill.step.metric'), t('govc.home.drill.step.unit'), t('govc.home.drill.step.record')];
  return (
    <nav aria-label={t('govc.home.drill.steps.aria', { step, total })} data-testid="drill-steps">
      <ol className="home-steps">
        {names.map((name, index) => (
          <li key={name} data-step={index + 1} {...(index + 1 === step ? { 'aria-current': 'step' as const } : {})} className={index + 1 === step ? 'home-steps__current' : index + 1 < step ? 'home-steps__done' : undefined}>
            <span className="home-steps__n" aria-hidden="true">
              {index + 1}
            </span>
            {name}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The alerts on the project or the cell (early warnings and explanations): ids and words only, each with the way to where it is handled. */
function AlertsOfRecord({ alerts }: { alerts: readonly DrillAlert[] }) {
  const { t } = useTranslation();
  return (
    <div data-testid="drill-alerts">
      <SectionCard title={t('govc.home.drill.alerts.title')}>
        {alerts.length === 0 ? (
          <p role="status" data-testid="drill-alerts-none">
            {t('govc.home.drill.alerts.none')}
          </p>
        ) : (
          <ul className="home-lines">
            {alerts.map((alert) => (
              <li key={`${alert.kind}:${alert.id}`} data-alert={alert.kind}>
                <strong>{alert.kind === 'EARLY_WARNING' ? t('govc.home.drill.alerts.warning') : t('govc.home.drill.alerts.explanation')}</strong>
                {alert.severity !== null && (SEVERITIES as readonly string[]).includes(alert.severity) ? ` · ${severityLabel(t, alert.severity as Severity)}` : ''} ·{' '}
                {alert.kind === 'EARLY_WARNING' ? warningStatusLabel(t, alert.status) : explanationStatusLabel(t, alert.status)} · {dayText(alert.at.slice(0, 10))}{' '}
                <Link to={alert.kind === 'EARLY_WARNING' ? `${PROFILE_PATH}?${new URLSearchParams({ warning: alert.id }).toString()}` : MY_WORK_PATH}>
                  {alert.kind === 'EARLY_WARNING' ? t('govc.home.drill.alerts.linkWarning') : t('govc.home.drill.alerts.linkExplanation')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function DrillProblemCard({ problem }: { problem: 'denied' | 'invalid' | 'notFound' | 'general' }) {
  const { t } = useTranslation();
  if (problem === 'denied') {
    // The right is gone: nothing of the place is said, and the reader is told the page needs to be read again.
    return (
      <div className="card statecard" role="alert" data-testid="drill-denied">
        <h2>{t('home.drill.denied.title')}</h2>
        <p>{t('home.drill.denied.body')}</p>
        <span data-testid="needs-refresh">
          <StatusPill tone="warning">{t('home.drill.needsRefresh')}</StatusPill>
        </span>
        <Link to={COMMAND_CENTER_PATH}>{t('home.drill.back')}</Link>
      </div>
    );
  }
  if (problem === 'notFound') {
    return (
      <div className="card statecard" role="alert" data-testid="drill-not-found">
        <p>{t('home.drill.notFound')}</p>
        <Link to={SNAPSHOT_SCREEN_PATH}>{t('home.empty.link')}</Link>
      </div>
    );
  }
  if (problem === 'invalid') {
    return (
      <div className="card statecard" role="alert" data-testid="drill-invalid">
        <p>{t('home.drill.invalid')}</p>
        <Link to={COMMAND_CENTER_PATH}>{t('home.drill.back')}</Link>
      </div>
    );
  }
  return null;
}

interface BodyProps {
  drill: Drill;
  trail: Step[];
  metric: string;
  rows: DrillChild[];
  sources: Drill['sources'];
  dimension: DrillDimension | '';
  onDimension: (dimension: DrillDimension) => void;
  order: DrillOrder;
  onOrder: (order: DrillOrder) => void;
  onOpen: (child: DrillChild) => void;
  onStep: (index: number) => void;
  more: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onRefresh: () => void;
  restarted: boolean;
}

const BUTTON = 'ui-button ui-button--outline';

function DrillBody({ drill, trail, metric, rows, sources, dimension, onDimension, order, onOrder, onOpen, onStep, more, loadingMore, onMore, onRefresh, restarted }: BodyProps) {
  const { t, locale } = useTranslation();
  const place = drill.scope.projectCode !== null ? `${drill.scope.projectCode} ${drill.scope.projectName ?? ''}`.trim() : drill.scope.unitName;
  const hasSums = drill.numerator !== null && drill.denominator !== null;
  // Where there can be many children (a scope, a unit) the next page is more children; below, where the way goes on to the sources, it is more transactions.
  const pagesChildren = drill.level === 'SCOPE' || drill.level === 'UNIT';
  const money = drill.unit === 'VND';
  const percentColumns = drill.unit === 'PERCENT';
  const columns: DataTableColumn<DrillChild>[] = [
    { key: 'code', header: t('home.drill.column.code'), pinned: true, render: (child) => <span data-child-id={child.id}>{child.code}</span> },
    { key: 'name', header: t('home.drill.column.name'), render: (child) => child.name },
    { key: 'value', header: t('home.drill.fact.value'), align: 'right', render: (child) => <span data-testid={`child-value-${child.id}`}>{figure(t, drill.unit, child.value, child.nullReason)}</span> },
    ...(percentColumns
      ? [
          { key: 'numerator', header: t('home.drill.fact.numerator'), align: 'right' as const, render: (child: DrillChild) => (child.numerator === null ? NONE : formatVnd(child.numerator)) },
          { key: 'denominator', header: t('home.drill.fact.denominator'), align: 'right' as const, render: (child: DrillChild) => (child.denominator === null ? NONE : formatVnd(child.denominator)) },
          { key: 'drag', header: t('govc.home.drill.column.drag'), align: 'right' as const, render: (child: DrillChild) => <span data-testid={`child-drag-${child.id}`}>{dragText(t, locale, child.dragPoints)}</span> },
        ]
      : []),
    {
      key: 'open',
      header: t('w2dis.home.drill.column.open'),
      render: (child) => (
        <button type="button" className={`${BUTTON} ui-button--small`} onClick={() => onOpen(child)} aria-label={t('home.drill.open', { name: child.code === '' ? child.name : child.code })}>
          {t('home.drill.open.action')}
        </button>
      ),
    },
  ];
  return (
    <div className="home-stack">
      <ContextBar
        items={[
          { label: t('home.drill.fact.place'), value: place ?? t('dis.wr.ctx.scope.all') },
          { label: t('home.drill.fact.asOf'), value: drill.asOfDate },
        ]}
        {...(money ? { unit: t('dis.wr.unit') } : {})}
      />
      <StepTrail step={drill.step} total={drill.stepsTotal} />
      <nav aria-label={t('home.drill.breadcrumb')} className="home-trail" data-testid="drill-breadcrumb">
        <ol>
          {trail.map((step, index) => (
            <li key={`${index}:${step.token}`}>
              {index === trail.length - 1 ? (
                <strong aria-current="step">{index === 0 ? metric : step.label}</strong>
              ) : (
                <button type="button" className={`${BUTTON} ui-button--small`} onClick={() => onStep(index)}>
                  {index === 0 ? metric : step.label}
                </button>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {restarted ? (
        <p role="status" data-testid="drill-renewed">
          <StatusPill tone="info">{t('home.drill.renewed')}</StatusPill>
        </p>
      ) : null}
      {drill.scopeChanged ? (
        <div role="status" className="home-notice" data-testid="scope-changed">
          <StatusPill tone="warning">{t('home.drill.scopeChanged')}</StatusPill>
          <button type="button" className={BUTTON} onClick={onRefresh}>
            {t('home.drill.refresh')}
          </button>
        </div>
      ) : null}
      <div data-testid="drill-figure">
        <SectionCard title={metric} status={drill.definitionStatus === 'SIGNED' ? undefined : <StatusPill tone="warning">{t('home.tile.definition.pending', { ref: FORMULA_REFERENCE })}</StatusPill>}>
          <KpiStrip label={t('w2dis.home.drill.figure.aria')}>
            <KpiTile
              label={t('home.drill.fact.value')}
              value={drill.value === null ? t('w2dis.home.na') : figure(t, drill.unit, drill.value, drill.nullReason)}
              tone={drill.value === null ? 'neutral' : 'info'}
              sub={drill.value === null ? reasonLabel(t, drill.nullReason) : hasSums ? `${t('home.tile.numerator', { value: formatVnd(drill.numerator ?? '0') })} · ${t('home.tile.denominator', { value: formatVnd(drill.denominator ?? '0') })}` : undefined}
            />
          </KpiStrip>
          <dl className="aud-facts">
            {hasSums ? (
              <>
                <dt>{t('home.drill.fact.numerator')}</dt>
                <dd data-testid="drill-numerator">{formatVnd(drill.numerator ?? '0')}</dd>
                <dt>{t('home.drill.fact.denominator')}</dt>
                <dd data-testid="drill-denominator">{formatVnd(drill.denominator ?? '0')}</dd>
              </>
            ) : null}
            <dt>{t('home.drill.fact.formula')}</dt>
            <dd data-testid="drill-formula" title={t('home.tile.formula.title', { formula: drill.formula, ref: FORMULA_REFERENCE })}>
              {drill.formula}
            </dd>
            <dt>{t('home.drill.fact.snapshot')}</dt>
            <dd data-testid="drill-snapshot" title={drill.snapshotId}>
              {shortId(drill.snapshotId)}
            </dd>
          </dl>
        </SectionCard>
      </div>
      {drill.exclusions.length === 0 ? null : (
        <div data-testid="drill-exclusions">
          <SectionCard title={t('home.drill.exclusions.title')}>
            <ul className="home-lines">
              {drill.exclusions.map((exclusion) => (
                <li key={`${exclusion.id ?? 'self'}:${exclusion.code}`}>
                  {exclusion.id === null ? t('home.drill.exclusions.self') : exclusion.code} {reasonLabel(t, exclusion.reason)}
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      )}
      {drill.dimensions.length === 0 ? null : (
        <div data-testid="drill-children">
          <SectionCard
            title={t('home.drill.children.title')}
            {...(money ? { unit: t('dis.wr.unit') } : {})}
            actions={
              <span className="home-badges">
                {percentColumns ? (
                  <span className="home-order" role="group" aria-label={t('govc.home.drill.order.label')} data-testid="drill-order">
                    <button type="button" className={`${BUTTON} ui-button--small`} aria-pressed={order === 'code'} onClick={() => onOrder('code')}>
                      {t('govc.home.drill.order.code')}
                    </button>
                    <button type="button" className={`${BUTTON} ui-button--small`} aria-pressed={order === 'drag'} onClick={() => onOrder('drag')}>
                      {t('govc.home.drill.order.drag')}
                    </button>
                  </span>
                ) : null}
                {drill.dimensions.length > 1 ? (
                  <label htmlFor="drill-dimension" className="home-inline-field">
                    {t('home.drill.dimension.label')}{' '}
                    <select id="drill-dimension" value={dimension} onChange={(event) => onDimension(event.target.value as DrillDimension)}>
                      {drill.dimensions.map((option) => (
                        <option key={option} value={option}>
                          {dimensionLabel(t, option)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </span>
            }
          >
            <DataTable caption={t('home.drill.children.title')} columns={columns} rows={rows} rowKey={(child) => `${child.dimension}:${child.id}`} />
            {more && pagesChildren ? (
              <button type="button" className={BUTTON} disabled={loadingMore} onClick={onMore}>
                {t('home.drill.more')}
              </button>
            ) : null}
            <p className="home-note" role="status" data-testid="drill-reconciliation">
              {drill.nonAdditiveReason === null && !drill.reconcilesToParent ? (
                <StatusPill tone="warning">{t('home.drill.reconcile.broken')}</StatusPill>
              ) : drill.nonAdditiveReason === 'RATIO' ? (
                t('home.drill.reconcile.ratio')
              ) : drill.reconcilesToParent ? (
                t('home.drill.reconcile.ok')
              ) : (
                t('home.drill.reconcile.broken')
              )}
            </p>
          </SectionCard>
        </div>
      )}
      {drill.level === 'PROJECT' || drill.level === 'CELL' ? <AlertsOfRecord alerts={drill.alerts} /> : null}
      {sources.length === 0 ? null : (
        <div data-testid="drill-sources">
          <SectionCard title={t('home.drill.sources.title')}>
            <ul className="home-lines">
              {sources.map((source) =>
                source.kind === 'REPORT_REVISION' ? (
                  <li key={`report:${source.id}`} data-source="report">
                    {t('home.drill.sources.report', { revision: source.revision, status: source.status })}
                  </li>
                ) : (
                  <li key={`tx:${source.id}`} data-source="treasury">
                    {source.reversalOfId === null
                      ? t('home.drill.sources.treasury', { ref: source.externalId, amount: formatVnd(source.contributionVnd), at: source.confirmedAt.slice(0, 10) })
                      : t('home.drill.sources.reversal', { ref: source.externalId, amount: formatVnd(source.contributionVnd), at: source.confirmedAt.slice(0, 10) })}
                  </li>
                ),
              )}
            </ul>
            {more && !pagesChildren ? (
              <button type="button" className={BUTTON} disabled={loadingMore} onClick={onMore}>
                {t('home.drill.more')}
              </button>
            ) : null}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
