import type { SnoozedAnswer, SnoozedItem } from '../../ui/alerts/types';

/** The key of a row: a source and the id of its record name one item. */
export const snoozedRowKey = (item: Pick<SnoozedItem, 'source' | 'source_id'>): string => `${item.source}:${item.source_id}`;

/** Which snooze of the run this is: `n` of `of` (null when the answer does not say how many are allowed). */
export function ordinalOf(item: Pick<SnoozedItem, 'snooze' | 'snooze_count'>): { n: number; of: number | null } {
  return { n: item.snooze.ordinal ?? Math.max(item.snooze_count, 1), of: item.snooze.of };
}

/** What an empty list means: nothing is snoozed, or the sources that could not be read might hold some (never said as "nothing"). */
export type EmptyKind = 'none' | 'unknownSources';

export function emptyKindOf(answer: Pick<SnoozedAnswer, 'items' | 'unavailable_sources'>): EmptyKind | null {
  if (answer.items.length > 0) return null;
  return answer.unavailable_sources.length > 0 ? 'unknownSources' : 'none';
}

/** The list is a part of what is snoozed: the server cut it, or it counts more than it gives. */
export const isPartialList = (answer: Pick<SnoozedAnswer, 'items' | 'count' | 'truncated'>): boolean => answer.truncated || answer.count > answer.items.length;
