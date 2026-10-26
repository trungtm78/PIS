/**
 * The weekly plan against what the Treasury paid (ST-DIS-014, DIS 3 F8, Directive 162): the commitment of a project for a week is a plan, never counted as disbursed; what was disbursed in the week is read
 * from the frozen close snapshots (the Treasury paid up to each cutoff, from the first day of the year), so that the figure is the one that was frozen and does not move.
 */
export interface FrozenWeek {
  periodId: string;
  /** The last day of the week, `YYYY-MM-DD`: weeks are taken in the order of their end. */
  endDate: string;
  /** What the Treasury paid to the project from the first day of the year to the cutoff of the snapshot, or null when it booked nothing for it. */
  cumulativeVnd: string | null;
}

export interface WeeklyActual {
  /** What was paid in the week; null when the week has no frozen close snapshot yet (nothing is known, which is not zero). */
  actualVnd: string | null;
  /** True when no earlier week of the year was frozen, so that the week is counted from the first day of the year. */
  fromYearStart: boolean;
}

/**
 * The Treasury payment of one week of a project: its cumulative at the end of the week less the cumulative at the end of the latest week that was frozen before it. A week that was frozen with no figure
 * for the project is a week of nothing paid (the cumulative is zero); a week that was not frozen has no actual. A refund can make the week negative: it is kept as it is.
 */
export function weeklyActual(weeks: readonly FrozenWeek[], periodId: string): WeeklyActual {
  const ordered = [...weeks].sort((a, b) => (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0));
  const index = ordered.findIndex((week) => week.periodId === periodId);
  if (index < 0) return { actualVnd: null, fromYearStart: false };
  const week = ordered[index] as FrozenWeek;
  const before = index === 0 ? undefined : (ordered[index - 1] as FrozenWeek);
  const now = BigInt(week.cumulativeVnd ?? '0');
  const earlier = BigInt(before?.cumulativeVnd ?? '0');
  return { actualVnd: (now - earlier).toString(), fromYearStart: before === undefined };
}

/** The gap between what was paid and what was committed: negative when the week fell short. Null when the week has no actual yet. */
export function weeklyDifference(actualVnd: string | null, commitmentVnd: string): string | null {
  return actualVnd === null ? null : (BigInt(actualVnd) - BigInt(commitmentVnd)).toString();
}
