import { ApiError } from '@machvon/api-client';
import { useEffect, useMemo, useState } from 'react';
import { useAlertCounts, useAlertItems } from '../../ui/alerts/hooks';
import type { AlertCounts, AlertItem, AlertView, Severity } from '../../ui/alerts/types';

/** The band is asked again once a minute, like the counts of the bell. */
const ITEMS_REFRESH_MS = 60_000;

/** The refusal of a view: the role does not read the whole scope (403), or the server does not take the view (400 / 422). Any other failure is a failure, not a refusal. */
export const refusesScope = (failure: unknown): boolean => failure instanceof ApiError && (failure.status === 403 || failure.status === 400 || failure.status === 422);

/** The counts of a list that carries none of its own: counted from the items it has (a lower bound, said by the caller when the list is a page). */
export function countsOfItems(items: readonly AlertItem[]): AlertCounts {
  const urgent = items.filter((item) => item.severity === 'URGENT').length;
  const action = items.filter((item) => item.severity === 'ACTION').length;
  const watch = items.filter((item) => item.severity === 'WATCH').length;
  return { urgent, action, watch, total: urgent + action + watch };
}

export type SourceState = 'loading' | 'error' | 'ready';

export interface AlertSource {
  /** The view that is read now: the scope for a leader, "mine" when the server refuses the scope. */
  view: AlertView;
  /** Whether the scope was refused (the queue says so instead of hiding the tab). */
  scopeRefused: boolean;
  state: SourceState;
  items: AlertItem[];
  counts: AlertCounts;
  /** The sources the server could not read: named, never shown as "no work". */
  unavailable: string[];
  asOf: string | null;
  /** The last answer is shown after a failure to refresh it: the caller says it is old. */
  stale: boolean;
  hasMore: boolean;
  retry: () => void;
}

/**
 * The alert source of a screen: the same hooks as the bell (`getMyWork`, `getMyWorkCounts`), in the view the screen asks for. `preferred` is read first; when the server refuses the scope the screen falls back to "mine"
 * (and says so through `scopeRefused`), so a leader never sees an error where an ordinary role simply has no scope view.
 */
export function useAlertSource(preferred: AlertView): AlertSource {
  const [fallback, setFallback] = useState(false);
  const view: AlertView = preferred === 'scope' && fallback ? 'mine' : preferred;
  const items = useAlertItems(view, { refreshMs: ITEMS_REFRESH_MS });
  const counts = useAlertCounts(view);
  const refused = preferred === 'scope' && (refusesScope(items.error) || refusesScope(counts.error));
  useEffect(() => {
    if (refused) setFallback(true);
  }, [refused]);
  // A change of the asked view starts again from the view that was asked.
  useEffect(() => {
    setFallback(false);
  }, [preferred]);

  const answer = items.data;
  const list = useMemo(() => answer?.items ?? [], [answer]);
  const countsAnswer = counts.data?.counts ?? answer?.counts ?? (answer === undefined ? null : countsOfItems(list));
  const waiting = answer === undefined && items.error === null ? true : refused && !fallback;
  const failed = answer === undefined && items.error !== null && !refused;
  const unavailable = [...new Set([...(answer?.unavailable_sources ?? []), ...(counts.data?.unavailable_sources ?? [])])];
  return {
    view,
    scopeRefused: refused || (preferred === 'scope' && fallback),
    state: failed ? 'error' : waiting || countsAnswer === null ? 'loading' : 'ready',
    items: list,
    counts: countsAnswer ?? { urgent: 0, action: 0, watch: 0, total: 0 },
    unavailable,
    asOf: counts.data?.as_of ?? answer?.as_of ?? null,
    stale: answer !== undefined && items.isError,
    hasMore: answer?.next_cursor !== null && answer?.next_cursor !== undefined,
    retry: () => {
      void items.refetch();
      void counts.refetch();
    },
  };
}

/** The items of one severity, in the order the server gave them. */
export const ofSeverity = (items: readonly AlertItem[], severity: Severity | 'ALL'): AlertItem[] => (severity === 'ALL' ? [...items] : items.filter((item) => item.severity === severity));
