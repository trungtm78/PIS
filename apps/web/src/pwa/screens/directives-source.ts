import { createContext, useContext } from 'react';
import { useDirectiveList, useSummary } from '../../screens/dir/hooks';
import { PAGE_SIZE } from '../../screens/dir/model';
import type { DirectiveLine, DirectiveStatus, Summary } from '../../screens/dir/model';

/**
 * The source of the directive tracking view (PWA-04, YCK.01). It reads the real operations of the directive module, through the same hooks as DIR-03:
 * `listDirectives` (the directives of the reader's scope, narrowed by status, overdue and unit, page after page), `getDirectiveSummary` (the counts with the
 * formula of each number) and, for the detail, `getDirective`. The screen is written against `DirectivesSource` so a test can provide a reading; the default
 * is `liveSource`, which asks the server. A directive carries its clock (`phase`, `days_to_due`, `overdue_days`, computed by the server) and its progress
 * lives in the timeline of its detail, not in the list.
 */
export interface DirectivesQuery {
  status: DirectiveStatus | '';
  /** Only the directives past their due day. */
  overdue: boolean;
  /** One unit, or '' for the whole scope of the reader. */
  unitId: string;
}

export const ALL_DIRECTIVES: DirectivesQuery = { status: '', overdue: false, unitId: '' };

/** What a reading of the directives is, in the words of the states of design.md. */
export type DirectivesReading =
  | { state: 'loading' }
  | { state: 'error'; error: unknown; retry(): void }
  | {
      state: 'ready';
      items: readonly DirectiveLine[];
      /** The counts of the scope, or null when they could not be read (the list stands, and the screen says the counts are missing). */
      summary: Summary | null;
      summaryFailed: boolean;
      /** ISO time the list was read (the server's `as_of`). */
      asOf: string;
      /** The list is the last good one and the latest reading failed. */
      stale: boolean;
      hasMore: boolean;
      loadingMore: boolean;
      loadMore(): void;
      retry(): void;
    };

/** A hook that reads the directives: the contract the screen is written against. */
export type DirectivesSource = (query: DirectivesQuery) => DirectivesReading;

/** The default source: the list and the summary of the directive module, read live. */
export const liveSource: DirectivesSource = (query) => {
  const filter = { status: query.status, unitId: query.unitId, projectId: '', meetingId: '', assignedToMe: false, overdue: query.overdue, q: '', dueFrom: '', dueTo: '' };
  const list = useDirectiveList(filter, PAGE_SIZE);
  const summary = useSummary({ unitId: query.unitId, projectId: '', meetingId: '' });
  const retry = (): void => {
    void list.refetch();
    void summary.refetch();
  };
  if (list.isLoading) return { state: 'loading' };
  if (list.data === undefined) return { state: 'error', error: list.error, retry };
  const pages = list.data.pages;
  return {
    state: 'ready',
    items: pages.flatMap((page) => page.items),
    summary: summary.data ?? null,
    summaryFailed: summary.isError || (summary.isSuccess && summary.data === null),
    asOf: pages[0]?.asOf ?? '',
    stale: list.isError || list.isRefetchError,
    hasMore: list.hasNextPage,
    loadingMore: list.isFetchingNextPage,
    loadMore: () => void list.fetchNextPage(),
    retry,
  };
};

export const DirectivesSourceContext = createContext<DirectivesSource>(liveSource);

/** The directives of the signed-in person's scope, from whatever source the application provides. */
export function useDirectives(query: DirectivesQuery): DirectivesReading {
  return useContext(DirectivesSourceContext)(query);
}
