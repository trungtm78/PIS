import type { CommandCenter, Tile } from './model';
import type { RankingRow, Rankings, WarningItem } from './warning-model';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

const BILLION = 1_000_000_000n;

/** A whole amount of dong as billions of dong with two decimals ("214,71"), or null when the amount is missing or is not whole dong. Rounded half up, never through a float of the whole amount. */
export function billionsOf(vnd: string | null, locale = 'vi'): string | null {
  if (vnd === null || !/^-?\d+$/.test(vnd)) return null;
  const negative = vnd.startsWith('-');
  const abs = BigInt(negative ? vnd.slice(1) : vnd);
  const hundredths = (abs * 100n + BILLION / 2n) / BILLION;
  const formatted = new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(hundredths) / 100);
  return negative && hundredths !== 0n ? `-${formatted}` : formatted;
}

/** A percent as the screen reads it ("60,00"): two decimals, the decimal sign of the language. Null when there is no figure. */
export function percentOf(value: string | null, locale = 'vi'): string | null {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
}

/** The tile of a metric, when the snapshot has it. */
export const tileOf = (center: Pick<CommandCenter, 'tiles'>, metricCode: string): Tile | undefined => center.tiles.find((tile) => tile.metricCode === metricCode);

/**
 * What the dark command block shows. `disbursed` is null when the Treasury has no figure (the block then says "no data", never 0); the ring follows the rate over the plan the Prime Minister gave and is null when
 * that rate cannot be given. The year is the one of the day the figures are as of.
 */
export interface HeroModel {
  disbursedVnd: string | null;
  disbursedMissing: boolean;
  ringPercent: number | null;
}

export function heroOf(center: CommandCenter): HeroModel {
  const disbursed = tileOf(center, 'DISBURSED_TREASURY');
  const pm = tileOf(center, 'DISBURSEMENT_RATE_PM');
  const ring = pm?.value === null || pm === undefined ? null : Number(pm.value);
  return {
    disbursedVnd: disbursed?.value ?? null,
    disbursedMissing: disbursed === undefined || disbursed.value === null,
    ringPercent: ring !== null && Number.isFinite(ring) ? Math.max(0, Math.min(100, ring)) : null,
  };
}

// ---- the bottlenecks: the open warnings read as causes ----

export interface Bottleneck {
  ruleCode: string;
  ruleName: string;
  /** How many open warnings of this cause. */
  count: number;
  /** How many distinct projects they are on. */
  projects: number;
  /** The names of the projects most behind, at most three. */
  sample: string[];
  /** The plan that is not yet disbursed in the projects of this cause, in dong; null when no warning of the cause carries its evidence (it is then said, not shown as 0). */
  impactVnd: string | null;
  worst: WarningItem['severity'];
}

const SEVERITY_ORDER: Record<WarningItem['severity'], number> = { CRITICAL: 3, WARNING: 2, INFO: 1 };

/** The plan not yet disbursed that one warning's evidence shows: the plan of its cells less what the Treasury paid, never below zero; null when it has no evidence or the Treasury has no figure for any cell. */
function gapOf(warning: WarningItem): bigint | null {
  if (warning.evidence === null || warning.evidence.cells.length === 0) return null;
  let plan = 0n;
  let paid = 0n;
  let known = false;
  for (const cell of warning.evidence.cells) {
    if (/^\d+$/.test(cell.planPmVnd)) plan += BigInt(cell.planPmVnd);
    if (/^\d+$/.test(cell.planLocalVnd)) plan += BigInt(cell.planLocalVnd);
    if (cell.disbursedVnd !== null && /^\d+$/.test(cell.disbursedVnd)) {
      paid += BigInt(cell.disbursedVnd);
      known = true;
    }
  }
  if (!known) return null;
  return plan > paid ? plan - paid : 0n;
}

/**
 * The causes behind the open warnings, by their impact: the same warnings are the work of the alert band, and here they are only counted, by the rule that raised them and not one by one. Heaviest first (the plan not
 * yet disbursed, then the number of projects), a cause with no figure of impact after the ones that have one.
 */
export function bottlenecksOf(warnings: readonly WarningItem[]): Bottleneck[] {
  const groups = new Map<string, { ruleName: string; items: WarningItem[] }>();
  for (const warning of warnings) {
    const group = groups.get(warning.ruleCode) ?? { ruleName: warning.ruleName, items: [] };
    group.items.push(warning);
    groups.set(warning.ruleCode, group);
  }
  const out: Array<Bottleneck & { gap: bigint }> = [];
  for (const [ruleCode, group] of groups) {
    const byProject = new Map<string, { name: string; gap: bigint | null }>();
    for (const warning of group.items) {
      const key = warning.project?.id ?? warning.id;
      const gap = gapOf(warning);
      const seen = byProject.get(key);
      const name = warning.project === null ? warning.ruleName : warning.project.name || warning.project.code;
      if (seen === undefined) byProject.set(key, { name, gap });
      else if (gap !== null && (seen.gap === null || gap > seen.gap)) byProject.set(key, { name, gap });
    }
    const projects = [...byProject.values()];
    const known = projects.filter((project): project is { name: string; gap: bigint } => project.gap !== null);
    const total = known.reduce((sum, project) => sum + project.gap, 0n);
    out.push({
      ruleCode,
      ruleName: group.ruleName,
      count: group.items.length,
      projects: projects.length,
      sample: [...known].sort((a, b) => (a.gap === b.gap ? 0 : a.gap > b.gap ? -1 : 1)).slice(0, 3).map((project) => project.name),
      impactVnd: known.length === 0 ? null : total.toString(),
      worst: group.items.reduce<WarningItem['severity']>((worst, item) => (SEVERITY_ORDER[item.severity] > SEVERITY_ORDER[worst] ? item.severity : worst), 'INFO'),
      gap: known.length === 0 ? -1n : total,
    });
  }
  out.sort((a, b) => (a.gap === b.gap ? b.projects - a.projects || b.count - a.count : a.gap > b.gap ? -1 : 1));
  return out.map((entry) => ({ ruleCode: entry.ruleCode, ruleName: entry.ruleName, count: entry.count, projects: entry.projects, sample: entry.sample, impactVnd: entry.impactVnd, worst: entry.worst }));
}

// ---- the cash flow ----

export interface CashFlowPoint {
  month: number;
  actualBillions: number | null;
  forecastBillions: number | null;
}

export interface CashFlow {
  planYear: number | null;
  cutoffMonth: number | null;
  points: CashFlowPoint[];
}

const billionsNumber = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return null;
  return Number((BigInt(raw) * 100n + BILLION / 2n) / BILLION) / 100;
};

/** The cumulative curve of the year by month, from the forecast of the disbursement (actual to the cutoff, the forecast after it); undefined when the answer has no curve. */
export function toCashFlow(raw: unknown): CashFlow | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.curve)) return undefined;
  const points = raw.curve.flatMap((entry): CashFlowPoint[] => {
    if (!isRecord(entry) || typeof entry.month !== 'number' || !Number.isInteger(entry.month) || entry.month < 1 || entry.month > 13) return [];
    return [{ month: entry.month, actualBillions: billionsNumber(entry.actual_cumulative_vnd), forecastBillions: billionsNumber(entry.forecast_cumulative_vnd) }];
  });
  return {
    planYear: typeof raw.plan_year === 'number' ? raw.plan_year : null,
    cutoffMonth: typeof raw.cutoff_month === 'number' ? raw.cutoff_month : null,
    points: points.sort((a, b) => a.month - b.month),
  };
}

/** Whether the curve has anything to draw: a month with a figure. */
export const hasCurve = (flow: CashFlow): boolean => flow.points.some((point) => point.actualBillions !== null || point.forecastBillions !== null);

// ---- the ranking ----

/** The first ranking table over the plan the Prime Minister gave (the other denominator is a table of its own and is never mixed in), with its best-placed rows. */
export function topRanked(rankings: Rankings, limit: number): { group: string; rows: RankingRow[]; total: number } | undefined {
  const table = rankings.tables.find((entry) => entry.denominator === 'PM_ASSIGNED' && entry.ranked.length > 0) ?? rankings.tables.find((entry) => entry.ranked.length > 0);
  return table === undefined ? undefined : { group: table.comparisonGroup, rows: table.ranked.slice(0, limit), total: table.ranked.length };
}

// ---- the words of a date and of a time ----

/** "12/10/2027" from "2027-10-12"; a day that is not of that shape is shown as it came. */
export function dayText(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  return match === null ? day : `${match[3]}/${match[2]}/${match[1]}`;
}

/** "07:05" of a moment in Vietnam; empty when the moment is not one. */
export function clockText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

/** The share of the projects of the scope that have a disbursement figure, as a whole percent; null for a scope with no project. */
export function coverageOf(projects: number, withoutData: number): { sent: number; total: number; percent: number | null } {
  const total = Math.max(0, projects);
  const sent = Math.max(0, total - Math.max(0, withoutData));
  return { sent, total, percent: total === 0 ? null : Math.round((sent / total) * 100) };
}
