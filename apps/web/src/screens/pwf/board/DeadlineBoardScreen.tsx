import { useMemo } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BandStrip, FigureInfo } from '../components';
import { PERMISSIONS, holds, monthOf, stampText, todayInVietnam } from '../model';
import type { Band, DeadlineCalendar, MilestoneList, Workload } from '../model';
import { BoardList } from './BoardList';
import { CalendarView, MonthNav } from './CalendarView';
import { FilterBar } from './FilterBar';
import { MilestonesView } from './MilestonesView';
import { WorkloadView } from './WorkloadView';
import { useBoard, useCalendar, useMilestones, usePersonOptions, useUnitOptions, useWorkload } from './hooks';
import { viewWord } from './labels';
import { BAND_FILTERS, NO_FILTERS, STALE_MINUTES, VIEWS, assigneesOf, filtersOf, isMonth, isStale, paramsOf, phasesOf, shiftMonth, viewOf } from './model';
import type { Filters, View } from './model';
import '../pwf.css';
import './board.css';

const NEVER_EMPTY = (): boolean => false;

/** PWF-07: the deadline board of the whole portfolio: official colours only, exact totals, month calendar, milestones of the next 30 days and the workload by person (display only). */
export default function DeadlineBoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <BoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const allowed = holds(permissions, PERMISSIONS.read);
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersOf(params), [params]);
  const view = viewOf(params);
  const requestedMonth = params.get('month') ?? '';
  const month = isMonth(requestedMonth) ? requestedMonth : monthOf(todayInVietnam());
  const write = (nextFilters: Filters, nextView: View, nextMonth: string | undefined): void => setParams(paramsOf(nextFilters, nextView, nextMonth), { replace: true });

  const board = useBoard(filters, allowed);
  const calendar = useCalendar(month, filters, allowed && view === 'calendar');
  const milestones = useMilestones(filters, allowed && view === 'milestones');
  const workload = useWorkload(filters, allowed && view === 'workload');
  const units = useUnitOptions(allowed);
  const people = usePersonOptions(allowed);

  const read = useScreenState({ isLoading: board.isLoading, error: board.error ?? undefined, data: board.data, isEmpty: NEVER_EMPTY });
  const state: ScreenState = allowed ? read : 'denied';
  const pages = board.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.items);
  const last = pages.at(-1);
  const secondary = { list: undefined, calendar, milestones, workload }[view];
  const partial = view !== 'list' && secondary?.isError === true;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <h1 id="screen-title">{t('pwf.board.page.title')}</h1>
        <p>{t('pwf.board.page.intro')}</p>
      </div>
      <StateBoundary state={state} onRetry={() => void board.refetch()}>
        {last === undefined ? null : (
          <>
            <p className="callout" data-testid="official-notice">
              {t('pwf.board.official.notice')}
            </p>
            <Counts counts={last.counts_by_band} asOf={last.as_of} selected={BAND_FILTERS.find((one) => one === filters.band) ?? ''} onSelect={(band) => write({ ...filters, band: BAND_FILTERS.find((one) => one === band) ?? '' }, view, view === 'calendar' ? month : undefined)} />
            {last.counts_by_band.UNKNOWN > 0 ? (
              <p className="callout warning pwf-notice" data-testid="unknown-notice" role="status">
                <span aria-hidden="true">⚠ </span>
                {t('pwf.board.unknown.notice', { count: last.counts_by_band.UNKNOWN })}
              </p>
            ) : null}
            {isStale(last.as_of, Date.now()) ? (
              <p className="callout warning pwf-notice" data-testid="stale" role="status">
                <span aria-hidden="true">⚠ </span>
                {t('pwf.board.stale.notice', { at: stampText(last.as_of), minutes: STALE_MINUTES })}{' '}
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void board.refetch()}>
                  {t('pwf.board.reload.action')}
                </button>
              </p>
            ) : null}
            <FilterBar
              filters={filters}
              onChange={(change) => write({ ...filters, ...change }, view, view === 'calendar' ? month : undefined)}
              onClear={() => write(NO_FILTERS, view, view === 'calendar' ? month : undefined)}
              phases={phasesOf(rows)}
              people={people.data !== undefined && people.data.length > 0 ? people.data : assigneesOf(rows)}
              units={units.data ?? []}
              updatedAt={stampText(last.as_of)}
            />
            {partial ? (
              <p className="callout warning pwf-notice" data-testid="partial" role="status">
                <span aria-hidden="true">⚠ </span>
                {t('pwf.board.partial.notice', { view: viewWord(t, view) })}
              </p>
            ) : null}
            <Tabs view={view} onView={(next) => write(filters, next, next === 'calendar' ? month : undefined)}>
              {view === 'list' ? (
                <BoardList
                  rows={rows}
                  total={last.total}
                  truncated={last.truncated}
                  hasMore={board.hasNextPage}
                  loadingMore={board.isFetchingNextPage}
                  onMore={() => void board.fetchNextPage()}
                  filtered={Object.values(filters).some((value) => value !== '')}
                  onClearFilters={() => write(NO_FILTERS, view, undefined)}
                />
              ) : (
                <SecondaryView view={view} month={month} onMonth={(delta) => write(filters, view, shiftMonth(month, delta))} calendar={calendar} milestones={milestones} workload={workload} />
              )}
            </Tabs>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('pwf.board.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The exact counts of the board by colour as one strip, with one "i" for all five: they come from the server, never from the rows on the screen. A press on a colour filters the board to it. */
function Counts({ counts, asOf, selected, onSelect }: { counts: Readonly<Record<Band, number>>; asOf: string; selected: Band | ''; onSelect: (band: Band | '') => void }) {
  const { t } = useTranslation();
  return (
    <BandStrip
      counts={counts}
      label={t('fix9.pwf07.counts.title')}
      unit={t('pwf.board.count.unit')}
      selected={selected}
      onSelect={onSelect}
      selectable={BAND_FILTERS}
      info={<FigureInfo name={t('fix9.pwf07.counts.title')} formula={t('pwf.board.count.formula')} source={t('pwf.board.count.source')} asOf={asOf} version={t('pwf.board.count.version')} />}
    />
  );
}

/** The four ways to look at the board as tabs: the arrow keys, Home and End move between them (the selected tab is the one in the Tab order). */
function Tabs({ view, onView, children }: { view: View; onView: (view: View) => void; children: ReactNode }) {
  const { t } = useTranslation();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = VIEWS.indexOf(view);
    const target = event.key === 'ArrowRight' ? (at + 1) % VIEWS.length : event.key === 'ArrowLeft' ? (at + VIEWS.length - 1) % VIEWS.length : event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : undefined;
    const next = target === undefined ? undefined : VIEWS[target];
    if (next === undefined) return;
    event.preventDefault();
    onView(next);
    document.getElementById(`pwf-tab-${next}`)?.focus();
  };
  return (
    <>
      <div className="pwf-tabs" role="tablist" aria-label={t('pwf.board.tabs.title')}>
        {VIEWS.map((item) => (
          <button key={item} type="button" role="tab" id={`pwf-tab-${item}`} aria-selected={view === item} aria-controls="pwf-panel" tabIndex={view === item ? 0 : -1} onClick={() => onView(item)} onKeyDown={onKeyDown}>
            {viewWord(t, item)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="pwf-panel" aria-labelledby={`pwf-tab-${view}`}>
        {children}
      </div>
    </>
  );
}

interface QueryLike<T> {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  refetch: () => unknown;
}

function Secondary<T>({ query, children }: { query: QueryLike<T>; children: (data: T) => ReactNode }) {
  const state = useScreenState({ isLoading: query.isLoading, error: query.error ?? undefined, data: query.data, isEmpty: NEVER_EMPTY });
  return (
    <StateBoundary state={state} onRetry={() => void query.refetch()}>
      {query.data === undefined ? null : children(query.data)}
    </StateBoundary>
  );
}

function SecondaryView({ view, month, onMonth, calendar, milestones, workload }: { view: Exclude<View, 'list'>; month: string; onMonth: (delta: number) => void; calendar: QueryLike<DeadlineCalendar>; milestones: QueryLike<MilestoneList>; workload: QueryLike<Workload> }) {
  switch (view) {
    case 'calendar':
      return (
        <>
          <MonthNav month={month} onMonth={onMonth} />
          <Secondary query={calendar}>{(data) => <CalendarView month={month} calendar={data} />}</Secondary>
        </>
      );
    case 'milestones':
      return <Secondary query={milestones}>{(data) => <MilestonesView milestones={data} />}</Secondary>;
    case 'workload':
      return <Secondary query={workload}>{(data) => <WorkloadView workload={data} />}</Secondary>;
  }
}
