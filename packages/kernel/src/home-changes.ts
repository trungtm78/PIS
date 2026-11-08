import type { RagBand } from './rag-explain.ts';

/**
 * "Changes since last week" (G3-4, HOME and BI): the few things that moved since the week before, each a fact with its numbers and a link to where it can be checked. The lines are made by rules from the figures of
 * two weeks and nothing else: no language model writes a word of them, and a line that cannot be computed is not written. At most five, the ones that matter most first. No name is in a line (a unit or a project
 * is reached by its link, where the reader's scope is judged again).
 */
export const CHANGE_LINES_MAX = 5;

export type ChangeLineKind = 'UNITS_TO_RED' | 'RATE_CHANGE' | 'WARNINGS_DELTA' | 'DISBURSED_WEEK' | 'OVERDUE_DELTA' | 'NO_DATA_DELTA' | 'UNITS_RECOVERED';
export type ChangeLink = 'DRILL' | 'RAG' | 'WARNINGS' | 'MY_WORK' | 'RANKING';
export type ChangeDirection = 'UP' | 'DOWN';

export interface ChangeLine {
  kind: ChangeLineKind;
  direction: ChangeDirection;
  /** The numbers the sentence is made of, as text (the screen puts them in its own words). */
  params: Record<string, string | number>;
  link: ChangeLink;
  /** For a link that is a drill: the metric whose tile it opens. */
  metricCode: string | null;
}

export interface UnitWeek {
  band: RagBand;
  criticalWarnings: number | null;
  overdueExplanations: number | null;
}

/** What a week of the reader's scope is made of: the day it is as of, the figures of its snapshot, and the reading of each unit that week. */
export interface WeekFigures {
  asOfDate: string;
  ratePmPct: string | null;
  disbursedVnd: string | null;
  projectsWithoutData: number;
  units: ReadonlyMap<string, UnitWeek>;
}

export interface WeeklyChanges {
  lines: ChangeLine[];
  /** The day the week before is as of; null when there is none, and then there are no lines and the screen says why. */
  previousAsOf: string | null;
  reason: 'NO_PREVIOUS_WEEK' | null;
}

const SCALE = 10_000n;

function scaled(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const n = BigInt(`${whole}${fraction.padEnd(4, '0').slice(0, 4)}`);
  return negative ? -n : n;
}

function pointsText(delta: bigint): string {
  const negative = delta < 0n;
  const n = negative ? -delta : delta;
  const hundredths = (n + 50n) / 100n;
  const text = hundredths.toString().padStart(3, '0');
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

const sum = (units: ReadonlyMap<string, UnitWeek>, pick: (unit: UnitWeek) => number | null): number | null => {
  let total = 0;
  let any = false;
  for (const unit of units.values()) {
    const value = pick(unit);
    if (value !== null) {
      total += value;
      any = true;
    }
  }
  return any ? total : null;
};

const delta = (kind: ChangeLineKind, now: number | null, before: number | null, link: ChangeLink): ChangeLine | undefined => {
  if (now === null || before === null || now === before) return undefined;
  return { kind, direction: now > before ? 'UP' : 'DOWN', params: { from: before, to: now, delta: Math.abs(now - before) }, link, metricCode: null };
};

/**
 * The lines of the week. Only units that have a reading in both weeks are compared (a unit that appeared this week is not "turned red"); a figure missing in either week gives no line. A rate line is written only when the
 * rate moved by a whole hundredth of a point, the places the register fixes for it, so a change that rounds away is not news.
 */
export function weeklyChanges(current: WeekFigures, previous: WeekFigures | null): WeeklyChanges {
  if (previous === null) return { lines: [], previousAsOf: null, reason: 'NO_PREVIOUS_WEEK' };
  const lines: ChangeLine[] = [];
  let toRed = 0;
  let recovered = 0;
  for (const [unitId, now] of current.units) {
    const before = previous.units.get(unitId);
    if (before === undefined || now.band === 'NO_DATA' || before.band === 'NO_DATA') continue;
    if (now.band === 'RED' && before.band !== 'RED') toRed += 1;
    if (before.band === 'RED' && now.band !== 'RED') recovered += 1;
  }
  if (toRed > 0) lines.push({ kind: 'UNITS_TO_RED', direction: 'UP', params: { count: toRed }, link: 'RAG', metricCode: null });
  if (current.ratePmPct !== null && previous.ratePmPct !== null) {
    const move = scaled(current.ratePmPct) - scaled(previous.ratePmPct);
    if ((move < 0n ? -move : move) >= SCALE / 100n) {
      lines.push({ kind: 'RATE_CHANGE', direction: move > 0n ? 'UP' : 'DOWN', params: { from: pointsText(scaled(previous.ratePmPct)), to: pointsText(scaled(current.ratePmPct)), delta: pointsText(move) }, link: 'DRILL', metricCode: 'DISBURSEMENT_RATE_PM' });
    }
  }
  const warnings = delta('WARNINGS_DELTA', sum(current.units, (unit) => unit.criticalWarnings), sum(previous.units, (unit) => unit.criticalWarnings), 'WARNINGS');
  if (warnings !== undefined) lines.push(warnings);
  if (current.disbursedVnd !== null && previous.disbursedVnd !== null) {
    const added = BigInt(current.disbursedVnd) - BigInt(previous.disbursedVnd);
    if (added > 0n) lines.push({ kind: 'DISBURSED_WEEK', direction: 'UP', params: { amount_vnd: added.toString() }, link: 'DRILL', metricCode: 'DISBURSED_TREASURY' });
  }
  const overdue = delta('OVERDUE_DELTA', sum(current.units, (unit) => unit.overdueExplanations), sum(previous.units, (unit) => unit.overdueExplanations), 'MY_WORK');
  if (overdue !== undefined) lines.push(overdue);
  if (current.projectsWithoutData !== previous.projectsWithoutData) {
    lines.push({
      kind: 'NO_DATA_DELTA',
      direction: current.projectsWithoutData > previous.projectsWithoutData ? 'UP' : 'DOWN',
      params: { from: previous.projectsWithoutData, to: current.projectsWithoutData, delta: Math.abs(current.projectsWithoutData - previous.projectsWithoutData) },
      link: 'RANKING',
      metricCode: null,
    });
  }
  if (recovered > 0) lines.push({ kind: 'UNITS_RECOVERED', direction: 'DOWN', params: { count: recovered }, link: 'RAG', metricCode: null });
  return { lines: lines.slice(0, CHANGE_LINES_MAX), previousAsOf: previous.asOfDate, reason: null };
}
