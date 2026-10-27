import type { ObligationView } from './types';

/**
 * Where an obligation stands (MNE-09): filed on time, filed late, not filed and already late, or not filed and not yet late. Lateness is a number and a text, never a colour alone (BR-MNE-04): a filed report is
 * judged by the day it was filed, an open one by today.
 */
export type ProgressKind = 'ON_TIME' | 'LATE' | 'OPEN_LATE' | 'OPEN';

export interface Progress {
  kind: ProgressKind;
  /** The days late: counted from the day of the filing for a filed report, to today for an open one; null when a late filing has no day on record (filed before the day was kept). */
  days: number | null;
}

/** An obligation is filed when the report was filed with the recipient (SUBMITTED_EXTERNAL) or its first revision was superseded by a correction that was (the day of the filing is then on it). */
export const isFiled = (item: Pick<ObligationView, 'status' | 'filedOn'>): boolean => item.status === 'SUBMITTED_EXTERNAL' || item.filedOn !== null;

export function progressOf(item: Pick<ObligationView, 'status' | 'filedOn' | 'isLate' | 'daysLate'>): Progress {
  if (isFiled(item)) return item.isLate ? { kind: 'LATE', days: item.daysLate } : { kind: 'ON_TIME', days: 0 };
  return item.isLate ? { kind: 'OPEN_LATE', days: item.daysLate } : { kind: 'OPEN', days: 0 };
}

export interface ProgressSummary {
  total: number;
  onTime: number;
  late: number;
  openLate: number;
  open: number;
}

export function summarize(items: readonly Pick<ObligationView, 'status' | 'filedOn' | 'isLate' | 'daysLate'>[]): ProgressSummary {
  const summary: ProgressSummary = { total: items.length, onTime: 0, late: 0, openLate: 0, open: 0 };
  for (const item of items) {
    const kind = progressOf(item).kind;
    if (kind === 'ON_TIME') summary.onTime += 1;
    else if (kind === 'LATE') summary.late += 1;
    else if (kind === 'OPEN_LATE') summary.openLate += 1;
    else summary.open += 1;
  }
  return summary;
}

/** The obligations that are late (filed late or not filed and past their day) first, the most days first, then the rest by due date: what a reader of the progress looks for. */
export function worstFirst<T extends Pick<ObligationView, 'status' | 'filedOn' | 'isLate' | 'daysLate' | 'dueDate'>>(items: readonly T[]): T[] {
  const weight = (item: T): number => {
    const progress = progressOf(item);
    return progress.kind === 'OPEN_LATE' || progress.kind === 'LATE' ? 1 : 0;
  };
  return [...items].sort((left, right) => weight(right) - weight(left) || (progressOf(right).days ?? 0) - (progressOf(left).days ?? 0) || left.dueDate.localeCompare(right.dueDate));
}
