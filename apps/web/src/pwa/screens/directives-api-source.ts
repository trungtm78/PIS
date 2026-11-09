import { useDirectiveList } from '../../screens/dir/hooks';
import { NO_FILTER } from '../../screens/dir/model';
import type { DirectiveLine } from '../../screens/dir/model';
import type { DirectiveItem, DirectivesQuery, DirectivesReading } from './directives-source';

/** The most directives one read of the tracking view asks for; "more" asks the next page with the cursor of the server. */
export const PWA_DIRECTIVES_PAGE = 30;

/**
 * One directive of the API as the tracking view shows it. The list does not carry the progress that was reported (it lives in the timeline of the directive), so the item says it does not know it
 * (`progressKnown: false`) and the card sends the reader to the detail instead of claiming "not reported". Who issued it is the steering meeting that gave it.
 */
export function toDirectiveItem(line: DirectiveLine): DirectiveItem {
  return {
    id: line.id,
    title: line.text,
    issuedBy: `${line.meeting.code} · ${line.meeting.title}`,
    issuedOn: line.meeting.meetingDate,
    dueOn: line.dueOn,
    status: line.status,
    assigneeUnit: line.assigneeUnit.name,
    progressPercent: null,
    progressKnown: false,
    lastUpdateAt: null,
    overdueDays: line.overdueDays ?? 0,
  };
}

/**
 * The source of the directive tracking view (PWA-04, YCK.01) over the directive module: `listDirectives` in the scope of the signed-in person, page after page. Loading is its own reading, a failure with a
 * list already read keeps the list and says it is stale, and a failure without one is an error that retries in place. The scope and the tenant are part of the query key, so a list never outlives the person.
 */
export function useApiDirectives(query: DirectivesQuery): DirectivesReading {
  const list = useDirectiveList({ ...NO_FILTER, status: query.status === 'ALL' ? '' : query.status }, PWA_DIRECTIVES_PAGE);
  const retry = (): void => void list.refetch();
  if (list.data === undefined) return list.isError ? { state: 'error', error: list.error, retry } : { state: 'loading' };
  const pages = list.data.pages;
  return {
    state: 'ready',
    items: pages.flatMap((page) => page.items.map(toDirectiveItem)),
    asOf: pages[pages.length - 1]?.asOf ?? new Date(list.dataUpdatedAt).toISOString(),
    stale: list.isError,
    unavailableSources: [],
    retry,
    hasMore: list.hasNextPage,
    loadingMore: list.isFetchingNextPage,
    loadMore: () => void list.fetchNextPage(),
  };
}
