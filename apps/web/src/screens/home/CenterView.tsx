import { ApiError } from '@machvon/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useOrgUnits } from '../adm/org-tree/hooks';
import { Field } from '../mne/components';
import { AlertBand, ContextBar, FilterPanel } from '../../ui';
import '../dis/dis.css';
import './home.css';
import { MetricTile, NewDataBanner, ProblemCard, QualityBadgeLabel } from './components';
import { DegradedChannelsBanner } from './DegradedBanner';
import { centerKey, homeRoot, useCommandCenter, useLatestSnapshot } from './hooks';
import { useAlertSource } from './alert-source';
import { amountTiles, describeCommandCenter, hasNewSnapshot, isAuthFailure, isStale, ratePair, shortId, waitingOf } from './model';
import type { CommandCenter, WaitingCounts } from './model';
import { clockText, dayText } from './overview-model';
import { CashFlowCard, Causes, Hero, Kpis, RankingCard } from './overview-sections';
import { vietnamToday } from '../mne/model';

/** The failures that this screen answers with a page of its own; every other failure is one of the standard states. */
const OWN_PROBLEMS = new Set(['RESOURCE_NOT_FOUND', 'SNAPSHOT_NOT_FROZEN', 'SCOPE_DENIED', 'METRIC_UNAVAILABLE', 'VALIDATION_FAILED']);
const hasOwnPage = (error: unknown): boolean => error instanceof ApiError && OWN_PROBLEMS.has(error.code);

type Variant = 'command' | 'overview';

/**
 * The command center and the executive overview (ST-HOME-001, HOME-09 and HOME-01): the same figures of the latest frozen snapshot, the first as the leader's working page (the context of every figure above
 * them, what waits beside them) and the second as the summary with its filters. The figures belong to the snapshot on the screen: a newer snapshot is offered by a banner and taken by a click, and nothing refreshes
 * them on its own. A figure that cannot be given is said so, never shown as 0.
 */
export function CenterView({ route, variant }: ScreenProps & { variant: Variant }) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <CenterContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} variant={variant} />;
}

function CenterContent({ route, variant }: ScreenProps & { variant: Variant }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const unitId = params.get('unit') ?? '';
  const queryClient = useQueryClient();
  const tenant = useSession().tenant;
  // The snapshot on the screen: empty until the first answer, then the one that answer was of. A change of unit reads that snapshot and not a newer one; the leader moves to a newer one by taking the banner.
  const [pinned, setPinned] = useState('');
  const [seed, setSeed] = useState<CommandCenter | undefined>(undefined);
  const [revokedNow, setRevokedNow] = useState(false);
  const query = useCommandCenter({ snapshotId: pinned, unitId }, revokedNow ? undefined : seed);
  const refetch = query.refetch;
  const units = useOrgUnits();
  const own = hasOwnPage(query.error);
  // Nothing frozen yet is not the end of the screen: it goes on asking, and offers the first snapshot when there is one.
  const noSnapshot = own && describeCommandCenter(query.error) === 'noSnapshot';
  const latest = useLatestSnapshot(query.data !== undefined || noSnapshot, unitId);
  // A right that was taken away while the page is open ends what is shown: the background reading says so, and the cached figures are not kept (a network failure of it is tolerated, the figures stand).
  const problem = own ? describeCommandCenter(query.error) : undefined;
  // A refusal of the unit is the answer of the foreground reading and has its own card; any other refusal of the background reading ends the screen, and a retry that is refused too does not bring the old figures back.
  const revoked = isAuthFailure(latest.error) && problem !== 'unitDenied';
  if (revoked !== revokedNow) setRevokedNow(revoked);
  // The access of the reader changed while the page was open (the server names the scope it read in): the figures kept for the old scope are not shown as if they were still the reader's, and are read again over the same snapshot.
  const scopeMoved = query.data !== undefined && latest.data !== undefined && latest.data.scopeHash !== '' && query.data.scope.hash !== '' && latest.data.scopeHash !== query.data.scope.hash;
  const state = useScreenState({ isLoading: query.isLoading || scopeMoved, error: revoked ? latest.error : own ? undefined : query.error, data: own ? undefined : query.data });
  const center = revoked || own || scopeMoved ? undefined : query.data;
  useEffect(() => {
    if (revoked) {
      // What was read under a right that was taken away is dropped, not only hidden: a later failure of the poll must not bring it back, and what is shown again is what a reading says once the right is back.
      queryClient.removeQueries({ queryKey: [...homeRoot(tenant?.id), 'center'] });
      setPinned('');
      setSeed(undefined);
    }
  }, [revoked, queryClient, tenant?.id]);
  useEffect(() => {
    if (pinned === '' && center !== undefined) {
      // The answer is kept under the key of its snapshot, so that pinning it asks nothing again.
      queryClient.setQueryData(centerKey(tenant?.id, tenant?.membershipId, center.snapshotId, unitId), center);
      setSeed(center);
      setPinned(center.snapshotId);
    }
  }, [pinned, center, queryClient, tenant?.id, tenant?.membershipId, unitId]);
  useEffect(() => {
    if (scopeMoved) void refetch();
  }, [scopeMoved, latest.data?.scopeHash, refetch]);
  const unitName = units.data?.find((unit) => unit.id === unitId)?.name;
  const refresh = (): void => {
    // What was read of the old snapshot is dropped, so that the next reading is of the latest one.
    queryClient.removeQueries({ queryKey: [...homeRoot(tenant?.id), 'center'] });
    setPinned('');
    setSeed(undefined);
    void latest.refetch();
  };
  const title = variant === 'command' ? t('home.cc.page.title') : t('home.overview.page.title');
  const subtitle = variant === 'command' ? t('home.cc.page.subtitle') : t('home.overview.page.subtitle');
  const context = center === undefined ? undefined : latest.data?.snapshotId === center.snapshotId && latest.data.freshness === 'STALE' ? { ...center, freshness: 'STALE' as const } : center;
  const contextItems = [
    { label: t('home.ov.context.scope'), value: context === undefined ? '—' : context.scope.unitId === null ? t('home.ov.context.unitAll', { projects: context.scope.projects }) : t('home.ov.context.unit', { unit: unitName ?? shortId(context.scope.unitId), projects: context.scope.projects }) },
    { label: t('home.ov.context.year'), value: context === undefined ? '—' : context.asOfDate.slice(0, 4) },
    { label: t('home.ov.context.closing'), value: context === undefined ? '—' : dayText(context.asOfDate) },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <div data-testid="home-context" className="home-context">
        <ContextBar items={contextItems} unit={t('home.ov.hero.unit')} asOf={context === undefined ? undefined : clockText(query.dataUpdatedAt)} stale={context !== undefined && isStale(context, vietnamToday())} />
        {context === undefined ? null : <QualityBadgeLabel badge={context.qualityBadge} />}
      </div>
      {variant === 'overview' && units.data !== undefined && units.data.length > 0 ? (
        <FilterPanel applied={unitId === '' ? 0 : 1}>
          <Field id="home-unit" label={t('home.filter.unit.label')} error={undefined}>
            <select
              id="home-unit"
              value={unitId}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                if (event.target.value === '') next.delete('unit');
                else next.set('unit', event.target.value);
                setParams(next, { replace: true });
              }}
            >
              <option value="">{t('home.filter.unit.all')}</option>
              {units.data.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.code} {unit.name}
                </option>
              ))}
            </select>
          </Field>
        </FilterPanel>
      ) : null}
      <NeedsActionBand />
      <DegradedChannelsBanner />
      {problem !== undefined && !revoked ? <ProblemCard problem={problem} /> : null}
      {noSnapshot && latest.data !== undefined ? <NewDataBanner onRefresh={refresh} /> : null}
      <StateBoundary
        state={state}
        onRetry={() => {
          void query.refetch();
          void latest.refetch();
        }}
      >
        {center === undefined ? null : (
          <>
            {hasNewSnapshot(center.snapshotId, latest.data?.snapshotId) ? <NewDataBanner onRefresh={refresh} /> : null}
            <CenterBody center={context ?? center} waiting={latest.data?.waiting ?? waitingOf(center)} unitId={unitId} />
          </>
        )}
      </StateBoundary>
    </section>
  );
}

/** "Cần xử lý ngay": the same source as the bell, the whole scope for a leader (the person's own work when the server refuses the scope). It is read on its own, so a failure of the figures never hides the work. */
function NeedsActionBand() {
  const source = useAlertSource('scope');
  return (
    <div data-testid="home-band" data-view={source.view}>
      <AlertBand items={source.items} counts={source.counts} max={5} state={source.state} unavailable={source.unavailable} asOf={source.asOf} stale={source.stale} onRetry={source.retry} />
    </div>
  );
}

function CenterBody({ center, waiting, unitId }: { center: CommandCenter; waiting: WaitingCounts; unitId: string }) {
  const { t } = useTranslation();
  const pair = ratePair(center);
  const amounts = amountTiles(center);
  const year = center.asOfDate.slice(0, 4);
  return (
    <>
      <Hero center={center} year={year} />
      <Kpis center={center} waiting={waiting} />
      <Causes />
      <div className="home-pair">
        <CashFlowCard snapshotId={center.snapshotId} unitId={unitId} year={year} />
        <RankingCard />
      </div>
      <details className="home-details" data-testid="home-details">
        <summary>{t('home.ov.details.title')}</summary>
        <p className="sub">{t('home.ov.details.hint')}</p>
        <dl className="aud-facts">
          <dt>{t('home.context.snapshot.label')}</dt>
          <dd data-testid="context-snapshot" title={center.snapshotId}>
            {shortId(center.snapshotId)}
          </dd>
          <dt>{t('home.context.cutoff.label')}</dt>
          <dd data-testid="context-cutoff">{center.treasuryCutoffDate}</dd>
        </dl>
        <section className="card" aria-labelledby="home-rates-title" data-testid="home-rates">
          <h2 id="home-rates-title">{t('home.rates.title')}</h2>
          {pair === undefined ? (
            <p role="alert">{t('home.problem.unavailable')}</p>
          ) : (
            <div className="dis-rate-pair" role="group" aria-label={t('home.rates.aria')}>
              <MetricTile tile={pair.pm} rate="pm" />
              <MetricTile tile={pair.total} rate="total" />
            </div>
          )}
          <div className="dis-rate-pair" data-testid="home-amounts">
            {amounts.map((tile) => (
              <MetricTile key={tile.metricCode} tile={tile} />
            ))}
          </div>
          {center.projectsWithoutData > 0 ? (
            <p className="sub" data-testid="without-data">
              {t('home.footer.withoutData', { count: center.projectsWithoutData })}
            </p>
          ) : null}
        </section>
      </details>
    </>
  );
}
