import { createContext, useContext } from 'react';

/**
 * The contract of the directive tracking view (PWA-04, YCK.01). The directive module exists (DIR-1) and `directives-api-source.ts` is the source over its list operation, provided by `PwaRoutes`;
 * a screen mounted with no provider keeps the default `notBuilt` source, which it shows as its own empty state and never as "no directive": a source that cannot be read is named,
 * never shown as no work (design.md). The shape the screen needs is below and in docs/pwa.md ("Directives contract"):
 *
 *   GET /directives?status={OPEN|IN_PROGRESS|DONE|OVERDUE|CANCELLED}&unit_id={uuid}   (read permission of the directive module; scope: the units of the reader)
 *   200 { items: Directive[], next_cursor: string | null, as_of: ISO time, unavailable_sources: string[] }
 *   Directive { id: uuid, title: string, issued_by: { id, name }, issued_on: 'YYYY-MM-DD', due_on: 'YYYY-MM-DD' | null, status,
 *               assignee_unit: { id, name } | null, progress_percent: 0..100 | null, last_update_at: ISO time | null, overdue_days: number }
 *   `progress_percent` is null when no progress was reported: the screen says "not reported", never 0%.
 */

export const DIRECTIVE_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'OVERDUE', 'CANCELLED'] as const;
export type DirectiveStatus = (typeof DIRECTIVE_STATUSES)[number];

/** One directive as the tracking view shows it. */
export interface DirectiveItem {
  id: string;
  title: string;
  issuedBy: string;
  /** YYYY-MM-DD. */
  issuedOn: string;
  /** YYYY-MM-DD, or null when it has no deadline. */
  dueOn: string | null;
  status: DirectiveStatus;
  /** The unit that carries it out, or null when none is named. */
  assigneeUnit: string | null;
  /** 0 to 100, or null when no progress has been reported. */
  progressPercent: number | null;
  /** False when the source cannot tell whether progress was reported (the list of the API does not carry it): the card then sends the reader to the detail and does not say "not reported". Absent means known. */
  progressKnown?: boolean;
  /** ISO time of the last report, or null. */
  lastUpdateAt: string | null;
  /** Days past the deadline as the server counts them; 0 when not late. */
  overdueDays: number;
}

export interface DirectivesQuery {
  status: DirectiveStatus | 'ALL';
}

/** What a reading of the directives is, in the words of the states of design.md. */
export type DirectivesReading =
  | { state: 'loading' }
  /** The directive entity does not exist in this deployment yet (its lane has not landed). */
  | { state: 'notBuilt' }
  | { state: 'error'; error: unknown; retry(): void }
  | {
      state: 'ready';
      items: readonly DirectiveItem[];
      /** ISO time the list was read. */
      asOf: string;
      /** The list is the last good one and the latest reading failed. */
      stale: boolean;
      /** Sources the server could not read; named on the screen, never hidden as "no directive". */
      unavailableSources: readonly string[];
      retry(): void;
      /** More directives wait on the server; `loadMore` asks the next page. */
      hasMore?: boolean;
      loadingMore?: boolean;
      loadMore?(): void;
    };

/** A hook that reads the directives: the contract the screen is written against. */
export type DirectivesSource = (query: DirectivesQuery) => DirectivesReading;

/** The default source until DIR-1 lands: it reads nothing and says that it is not built. */
export const notBuiltSource: DirectivesSource = () => ({ state: 'notBuilt' });

export const DirectivesSourceContext = createContext<DirectivesSource>(notBuiltSource);

/** The directives of the signed-in person's scope, from whatever source the application provides. */
export function useDirectives(query: DirectivesQuery): DirectivesReading {
  return useContext(DirectivesSourceContext)(query);
}
