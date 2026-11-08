import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard } from '../../ui';
import { useFeedConnection, useFeedRuns } from './feed-hooks';
import { channelLabel, kindLabel } from './feed-labels';
import { CHANNELS, KINDS, appliedFilters, channelOf, kindOf, runFiltersOf, runSearchOf, vietnamStamp } from './feed-model';
import type { Run, RunFilters } from './feed-model';
import { AcceptanceBadge, FeedLinks, ListState, PagingFoot, StaleNote } from './feed-parts';
import { ImportFlow } from './ImportFlow';
import { RunDetailPanel, RunsTable } from './run-components';
import './feed.css';

/**
 * FEED-02, the runs and the imports of the feed of the Finance Department. A person hands over a file (the platform never calls the Finance application): it is uploaded, read by a dry run that writes nothing, and applied once per file
 * (the same file again says it was applied). Every run is listed alike, a file or a move of the data generator; the channel is only a small provenance column. A run opens to its counts and the rows it refused.
 * The layouts of the files are a working assumption until the Finance Department publishes its own (PENDING-EXTERNAL).
 */
export default function RunsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The flow, the filters and the opened run belong to one membership: a switch of tenant or of membership starts the screen over.
  return <RunsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RunsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const connection = useFeedConnection();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => runFiltersOf(search), [search]);
  const list = useFeedRuns(filters);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const pages = list.data?.pages;
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: () => rows.length === 0 });
  const applied = appliedFilters(filters);
  const firstAsOf = pages?.[0]?.asOf ?? null;
  const refreshFailed = list.isError && list.data !== undefined && !list.isFetchNextPageError;
  const change = (next: RunFilters): void => setSearch(runSearchOf(next));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="feed-page">
      <div className="feed-head">
        <div>
          <h1 id="screen-title">{t('feed.runs.page.title')}</h1>
          <p>{t('feed.runs.page.subtitle')}</p>
          <FeedLinks current="runs" />
        </div>
      </div>
      <div className="feed-badges" data-testid="import-badges">
        <AcceptanceBadge acceptance={connection.data?.acceptance ?? 'PENDING_EXTERNAL'} />
      </div>
      <ContextBar items={[{ label: t('feed.runs.context.scope.label'), value: tenant?.name ?? '' }]} {...(firstAsOf === null ? {} : { asOf: vietnamStamp(firstAsOf) })} stale={refreshFailed} />
      <ImportFlow />
      {refreshFailed && <StaleNote asOf={firstAsOf} onRetry={() => void list.refetch()} />}
      <SectionCard title={t('feed.runs.history.title')}>
        <form className="feed-filters" role="search" aria-label={t('feed.runs.filter.group.label')} onSubmit={(event) => event.preventDefault()}>
          <div className="field">
            <label htmlFor="feed-runs-channel">{t('feed.runs.filter.channel.label')}</label>
            <select
              id="feed-runs-channel"
              value={filters.channel ?? ''}
              onChange={(event) => {
                const next: RunFilters = { ...filters };
                const channel = channelOf(event.target.value);
                if (channel === undefined) delete next.channel;
                else next.channel = channel;
                change(next);
              }}
            >
              <option value="">{t('feed.runs.filter.all')}</option>
              {CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channelLabel(t, channel)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="feed-runs-kind">{t('feed.runs.filter.kind.label')}</label>
            <select
              id="feed-runs-kind"
              value={filters.kind ?? ''}
              onChange={(event) => {
                const next: RunFilters = { ...filters };
                const kind = kindOf(event.target.value);
                if (kind === undefined) delete next.kind;
                else next.kind = kind;
                change(next);
              }}
            >
              <option value="">{t('feed.runs.filter.all')}</option>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(t, kind)}
                </option>
              ))}
            </select>
          </div>
        </form>
        <ListState
          state={state}
          onRetry={() => void list.refetch()}
          empty={
            <div className="feed-state" role="status" data-testid="empty">
              <h2>{applied > 0 ? t('feed.runs.empty.filtered.title') : t('feed.runs.empty.title')}</h2>
              <p>{applied > 0 ? t('feed.runs.empty.filtered.body') : t('feed.runs.empty.body')}</p>
              {applied > 0 && (
                <button type="button" className="ui-button ui-button--outline" onClick={() => change({})}>
                  {t('feed.runs.filter.clear.action')}
                </button>
              )}
            </div>
          }
        />
        {state === 'default' && (
          <>
            <RunsTable runs={rows} caption={t('feed.runs.table.caption')} selectedId={openId} onOpen={(run: Run) => setOpenId(run.id)} />
            <PagingFoot shown={rows.length} hasMore={list.hasNextPage} loadingMore={list.isFetchingNextPage} failedMore={list.isFetchNextPageError} onMore={() => void list.fetchNextPage()} />
          </>
        )}
      </SectionCard>
      {openId !== undefined && <RunDetailPanel key={openId} id={openId} onClose={() => setOpenId(undefined)} />}
      <p className="prototype-note">{t('feed.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
