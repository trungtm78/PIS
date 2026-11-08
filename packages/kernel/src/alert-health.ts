import { DomainError } from './errors.ts';
import { workingMinutesBetween } from './working-time.ts';
import type { WorkCalendarSource, WorkingInterval } from './working-time.ts';
import type { CoverageSummary } from './alert-coverage.ts';
import { ALERT_GOV_TEXT } from './messages/alert-gov-texts.ts';
import type { NotifyDecision, NotifySeverity } from './alert-notify.ts';

/**
 * The health of the alert system itself (roadmap G2-10, research A2 and the table of KPIs of the alert system, docs/alert-governance.md). Whoever does not measure the alert system cannot manage it: this module computes the fourteen indicators
 * (time to take up, time to resolve, on time, escalated, escalated to the last level, alerts per person per day, interrupting notices per person per day, notices out of hours, stale alerts, weight of the ten largest types, put-off rate, orphaned
 * alerts, urgent delivery, coverage of deputies) from what the alert centre recorded (`alert_item_trace`, the log of notices, the routing gaps, the coverage of positions). Each one has one formula, its source, its target from the governance rule
 * `ALERT_HEALTH_TARGETS` and a status; a figure that cannot be computed is NO_DATA or NO_SOURCE with the reason, never a zero. The targets are starting values of the research and of industrial alarm management (ISA-18.2, EEMUA 191 through
 * vendor summaries, which are not for continuous plants only): they are a method to be calibrated on the data of the tenant, not legal numbers.
 *
 * Everything here is pure: the records, the calendars, the targets and the clock come in as arguments.
 */

export const HEALTH_RULE_TYPE = 'ALERT_HEALTH_TARGETS';
export const HEALTH_DEFAULT_CODE = 'DEFAULT';

export const KPI_CODES = ['MTTA', 'MTTR', 'ON_TIME', 'ESCALATED', 'LAST_LEVEL', 'ALERTS_PER_PERSON', 'PUSH_PER_PERSON', 'OFF_HOURS', 'STALE', 'TOP10_SHARE', 'SNOOZE_RATE', 'ORPHAN', 'URGENT_DELIVERY', 'DELEGATION_COVERAGE'] as const;
export type KpiCode = (typeof KPI_CODES)[number];

type PerSeverity<T> = Readonly<Record<NotifySeverity, T>>;

export interface HealthTargets {
  /** The longest the mean time to take an item up may be, in working hours, by severity. */
  mtta_working_hours: PerSeverity<number>;
  /** The share of closed items that were closed before their time ran out, at least. */
  on_time_min_pct: number;
  /** The share of items that went up at least one level, at most; above it the rules or the work have a problem. */
  escalated_max_pct: number;
  /** The share of items that went to the last level, at most (the research: close to zero). */
  last_level_max_pct: number;
  /** The 90th percentile of new alerts of a person in one day, by severity (URGENT) and in all. */
  alerts_per_person_day_max: { URGENT: number; TOTAL: number };
  /** The 90th percentile of interrupting notices of a person in one day, at most. */
  pushes_per_person_day_max: number;
  /** Notices that broke the quiet hours without the allowance of the policy, at most. */
  off_hours_unjustified_max: number;
  /** An open item is stale when it has not changed state for this many days (the first line, the second line). */
  stale_after_days: { first: number; second: number };
  /** The share of open items that are stale past the first line, at most. */
  stale_max_pct: number;
  /** The share of the volume that the ten largest types make, at most; above it the types need to be rationalised. */
  top10_share_max_pct: number;
  /** The share of items of a type that were put off, at most. */
  snooze_rate_max_pct: number;
  /** Orphaned alerts, at most, and the longest mean time to reroute them, in hours. */
  orphan_max: number;
  reroute_max_hours: number;
  /** The share of urgent notices delivered within so many minutes, at least. */
  urgent_delivery_min_pct: number;
  urgent_delivery_minutes: number;
  /** The share of positions with a backup in force, at least. */
  delegation_coverage_min_pct: number;
  /** Fewer items than this and the figure is not judged (LOW_SAMPLE is said, the figure is still shown). */
  min_sample: number;
}

/** Starting values of the research (ISA-18.2 and EEMUA 191 through vendor summaries, PagerDuty responder insights): methods to calibrate after 4 to 6 weeks of real data, not legal numbers. */
export function healthTargetDefaults(): HealthTargets {
  return {
    mtta_working_hours: { URGENT: 4, ACTION: 8, WATCH: 40 },
    on_time_min_pct: 90,
    escalated_max_pct: 20,
    last_level_max_pct: 2,
    alerts_per_person_day_max: { URGENT: 1, TOTAL: 10 },
    pushes_per_person_day_max: 5,
    off_hours_unjustified_max: 0,
    stale_after_days: { first: 7, second: 30 },
    stale_max_pct: 10,
    top10_share_max_pct: 50,
    snooze_rate_max_pct: 30,
    orphan_max: 0,
    reroute_max_hours: 1,
    urgent_delivery_min_pct: 99,
    urgent_delivery_minutes: 10,
    delegation_coverage_min_pct: 100,
    min_sample: 5,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function number(value: unknown, field: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw invalid(field);
  return value;
}

function bySeverity(value: unknown, field: string, min: number, max: number): PerSeverity<number> {
  if (!isRecord(value)) throw invalid(field);
  return { URGENT: number(value.URGENT, `${field}.URGENT`, min, max), ACTION: number(value.ACTION, `${field}.ACTION`, min, max), WATCH: number(value.WATCH, `${field}.WATCH`, min, max) };
}

/** The params of an `ALERT_HEALTH_TARGETS` rule, checked: a rule that does not say all of it is refused rather than half applied. */
export function healthTargetsOf(params: unknown): HealthTargets {
  if (!isRecord(params)) throw invalid('params');
  const perDay = params.alerts_per_person_day_max;
  const stale = params.stale_after_days;
  if (!isRecord(perDay)) throw invalid('alerts_per_person_day_max');
  if (!isRecord(stale)) throw invalid('stale_after_days');
  const first = number(stale.first, 'stale_after_days.first', 1, 365, true);
  const second = number(stale.second, 'stale_after_days.second', first, 730, true);
  return {
    mtta_working_hours: bySeverity(params.mtta_working_hours, 'mtta_working_hours', 0.5, 720),
    on_time_min_pct: number(params.on_time_min_pct, 'on_time_min_pct', 0, 100),
    escalated_max_pct: number(params.escalated_max_pct, 'escalated_max_pct', 0, 100),
    last_level_max_pct: number(params.last_level_max_pct, 'last_level_max_pct', 0, 100),
    alerts_per_person_day_max: { URGENT: number(perDay.URGENT, 'alerts_per_person_day_max.URGENT', 0, 500), TOTAL: number(perDay.TOTAL, 'alerts_per_person_day_max.TOTAL', 0, 500) },
    pushes_per_person_day_max: number(params.pushes_per_person_day_max, 'pushes_per_person_day_max', 0, 100),
    off_hours_unjustified_max: number(params.off_hours_unjustified_max, 'off_hours_unjustified_max', 0, 100_000, true),
    stale_after_days: { first, second },
    stale_max_pct: number(params.stale_max_pct, 'stale_max_pct', 0, 100),
    top10_share_max_pct: number(params.top10_share_max_pct, 'top10_share_max_pct', 0, 100),
    snooze_rate_max_pct: number(params.snooze_rate_max_pct, 'snooze_rate_max_pct', 0, 100),
    orphan_max: number(params.orphan_max, 'orphan_max', 0, 100_000, true),
    reroute_max_hours: number(params.reroute_max_hours, 'reroute_max_hours', 0.1, 720),
    urgent_delivery_min_pct: number(params.urgent_delivery_min_pct, 'urgent_delivery_min_pct', 0, 100),
    urgent_delivery_minutes: number(params.urgent_delivery_minutes, 'urgent_delivery_minutes', 1, 1440, true),
    delegation_coverage_min_pct: number(params.delegation_coverage_min_pct, 'delegation_coverage_min_pct', 0, 100),
    min_sample: number(params.min_sample, 'min_sample', 1, 1000, true),
  };
}

// -- What the indicators are computed from ---------------------------------------------------------------------------------------------------------------------------------------------

export type TraceState = 'OPEN' | 'RESOLVED' | 'CLEARED';

/** One item of the alert centre as the alert centre recorded it over its life (`alert_item_trace`). */
export interface HealthItem {
  source: string;
  /** The alert type the item belongs to (the code of the registry, else the kind). */
  typeCode: string;
  severity: NotifySeverity;
  ownerId: string | null;
  unitId: string | null;
  /** When the item became something to act on (the module's start, else the first time it was seen). */
  startedAt: Date;
  firstSeenAt: Date;
  firstClaimAt: Date | null;
  state: TraceState;
  closedAt: Date | null;
  /** When its time runs out; null when the module gives none. */
  dueAt: Date | null;
  lastChangeAt: Date;
  maxEscalationLevel: number;
  /** How many levels the policy gives its severity, and whether the last was reached. */
  levelsConfigured: number;
  snoozeCount: number;
  pauses: ReadonlyArray<{ from: Date; until: Date }>;
}

export interface HealthNotice {
  memberId: string;
  /** The day of the person (their zone) the notice went out. */
  day: string;
  channel: string;
  decision: NotifyDecision;
  severity: NotifySeverity;
  inQuiet: boolean;
  bypass: string | null;
}

export interface HealthGap {
  kind: string;
  /** How many alerts are affected (at least 1). */
  itemCount: number;
  openedAt: Date;
  closedAt: Date | null;
}

export interface HealthDelivery {
  /** The urgent notices that were sent in the window, and how many of them were delivered within the minutes of the target. */
  sent: number;
  deliveredWithin: number;
}

export interface HealthInput {
  from: Date;
  to: Date;
  now: Date;
  items: readonly HealthItem[];
  notices: readonly HealthNotice[];
  gaps: readonly HealthGap[];
  coverage: CoverageSummary | null;
  /** `null`: the platform has no delivery receipts for alert notices yet (the figure is then NO_SOURCE and says why). */
  delivery: HealthDelivery | null;
  calendars: WorkCalendarSource | undefined;
  intervals?: readonly WorkingInterval[] | undefined;
  /** The last pass of the job that records the items; null when it never ran. */
  lastPassAt: Date | null;
  targets: HealthTargets;
}

export type KpiStatus = 'OK' | 'WATCH' | 'BREACH' | 'NO_DATA' | 'NO_SOURCE';

export interface KpiPart {
  key: string;
  value: number | null;
  sample: number;
  status: KpiStatus;
  target: number | null;
}

export interface Kpi {
  code: KpiCode;
  /** The headline figure; null when there is none (the status says why). */
  value: number | null;
  unit: 'HOURS' | 'PERCENT' | 'COUNT';
  /** How the figure is judged: `MAX` (at most the target), `MIN` (at least the target). */
  direction: 'MAX' | 'MIN';
  target: number | null;
  status: KpiStatus;
  /** How many records the figure stands on. */
  sample: number;
  /** The figure stands on fewer records than the minimum sample: it is shown, and it is not trusted. */
  lowSample: boolean;
  parts: KpiPart[];
  formula: string;
  source: string;
  /** Why there is no figure (NO_DATA, NO_SOURCE), or what is left out of it. */
  note: string | null;
}

export interface TopType {
  typeCode: string;
  count: number;
  sharePct: number;
  snoozed: number;
  snoozeRatePct: number | null;
}

export interface StaleUnit {
  unitId: string | null;
  count: number;
}

export interface AlertHealth {
  from: string;
  to: string;
  asOf: string;
  /** The recording job ran lately; a figure computed from records older than twice its interval is shown as old. */
  stale: boolean;
  lastPassAt: string | null;
  kpis: Kpi[];
  topTypes: TopType[];
  staleByUnit: StaleUnit[];
  /** How many items the window holds, and how many are open now. */
  items: { inWindow: number; open: number };
}

// -- Judging a figure ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const SLACK = 0.2;
const RANK: Readonly<Record<KpiStatus, number>> = { OK: 0, WATCH: 1, BREACH: 2, NO_DATA: -1, NO_SOURCE: -1 };

/** Within the target is OK; within a fifth beyond it is WATCH; further is BREACH. A target of zero has no slack. */
export function judgeFigure(value: number, target: number, direction: 'MAX' | 'MIN'): KpiStatus {
  if (direction === 'MAX') return value <= target ? 'OK' : value <= target * (1 + SLACK) && target > 0 ? 'WATCH' : 'BREACH';
  return value >= target ? 'OK' : value >= target * (1 - SLACK) ? 'WATCH' : 'BREACH';
}

const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

/** The nearest-rank percentile (0 to 1) of a list; null for an empty list. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] as number;
}

function worst(parts: readonly KpiPart[]): KpiStatus | null {
  let found: KpiStatus | null = null;
  for (const part of parts) if (RANK[part.status] >= 0 && (found === null || RANK[part.status] > RANK[found])) found = part.status;
  return found;
}

interface Build {
  code: KpiCode;
  unit: Kpi['unit'];
  direction: Kpi['direction'];
  target: number | null;
  minSample: number;
}

/** Builds an indicator from its parts and its headline figure: the status is the worst of the parts that have data. */
function kpi(build: Build, value: number | null, sample: number, parts: KpiPart[], note: string | null = null, status?: KpiStatus): Kpi {
  const judged = status ?? (value === null ? null : (worst(parts) ?? (build.target === null ? null : judgeFigure(value, build.target, build.direction))));
  return {
    code: build.code,
    value: value === null ? null : round(value, 2),
    unit: build.unit,
    direction: build.direction,
    target: build.target,
    status: judged ?? 'NO_DATA',
    sample,
    lowSample: sample > 0 && sample < build.minSample,
    parts,
    formula: ALERT_GOV_TEXT.kpi_formula(build.code),
    source: ALERT_GOV_TEXT.kpi_source(build.code),
    note,
  };
}

const SEVERITIES: readonly NotifySeverity[] = ['URGENT', 'ACTION', 'WATCH'];
const HOUR_MINUTES = 60;

interface Clockwork {
  hours(from: Date, to: Date, pauses?: HealthItem['pauses']): number | null;
  unavailable: boolean;
}

/** The working hours between two moments on the published calendar, less the pauses; null when a year is not published (never a guess). */
function clockwork(input: HealthInput): Clockwork {
  const state = { unavailable: false };
  const minutes = (from: Date, to: Date): number | null => {
    if (input.calendars === undefined) {
      state.unavailable = true;
      return null;
    }
    try {
      return workingMinutesBetween(input.calendars, from, to, input.intervals);
    } catch (failure) {
      if (failure instanceof DomainError && failure.code === 'CALENDAR_NOT_EFFECTIVE') {
        state.unavailable = true;
        return null;
      }
      throw failure;
    }
  };
  return {
    get unavailable() {
      return state.unavailable;
    },
    hours(from, to, pauses = []) {
      const total = minutes(from, to);
      if (total === null) return null;
      let paused = 0;
      for (const span of pauses) {
        const begin = new Date(Math.max(span.from.getTime(), from.getTime()));
        const end = new Date(Math.min(span.until.getTime(), to.getTime()));
        if (end.getTime() > begin.getTime()) paused += minutes(begin, end) ?? 0;
      }
      return Math.max(0, total - paused) / HOUR_MINUTES;
    },
  };
}

const within = (instant: Date | null, from: Date, to: Date): boolean => instant !== null && instant.getTime() >= from.getTime() && instant.getTime() < to.getTime();

/** The fourteen indicators of the health of the alert system over a window, with the tables the page shows beside them. */
export function computeAlertHealth(input: HealthInput): AlertHealth {
  const { targets } = input;
  const minSample = targets.min_sample;
  const opened = input.items.filter((item) => within(item.firstSeenAt, input.from, input.to));
  const closed = input.items.filter((item) => item.state !== 'OPEN' && within(item.closedAt, input.from, input.to));
  const open = input.items.filter((item) => item.state === 'OPEN');
  const work = clockwork(input);
  const kpis: Kpi[] = [];
  const part = (key: string, value: number | null, sample: number, target: number | null, direction: 'MAX' | 'MIN'): KpiPart => ({
    key,
    value: value === null ? null : round(value, 2),
    sample,
    target,
    status: value === null || target === null || sample === 0 ? 'NO_DATA' : judgeFigure(value, target, direction),
  });

  // 1. Time to take an item up, by severity, in working hours.
  const claimed = input.items.filter((item) => within(item.firstClaimAt, input.from, input.to));
  const ttaBy = (severity: NotifySeverity | null): number[] =>
    claimed
      .filter((item) => severity === null || item.severity === severity)
      .map((item) => work.hours(item.startedAt, item.firstClaimAt as Date))
      .filter((value): value is number => value !== null);
  const ttaParts = SEVERITIES.map((severity) => part(severity, mean(ttaBy(severity)), ttaBy(severity).length, targets.mtta_working_hours[severity], 'MAX'));
  const ttaAll = ttaBy(null);
  kpis.push(kpi({ code: 'MTTA', unit: 'HOURS', direction: 'MAX', target: targets.mtta_working_hours.URGENT, minSample }, mean(ttaAll), ttaAll.length, ttaParts, work.unavailable ? 'CALENDAR_UNAVAILABLE' : ttaAll.length === 0 ? 'NO_RECORDS' : null));

  // 2. Time to resolve (creation to closing, less the pauses), in working hours.
  const ttr = (severity: NotifySeverity | null): number[] =>
    closed
      .filter((item) => severity === null || item.severity === severity)
      .map((item) => work.hours(item.startedAt, item.closedAt as Date, item.pauses))
      .filter((value): value is number => value !== null);
  const ttrParts = SEVERITIES.map((severity) => part(severity, mean(ttr(severity)), ttr(severity).length, null, 'MAX'));
  const ttrAll = ttr(null);
  kpis.push(kpi({ code: 'MTTR', unit: 'HOURS', direction: 'MAX', target: null, minSample }, mean(ttrAll), ttrAll.length, ttrParts, work.unavailable ? 'CALENDAR_UNAVAILABLE' : ttrAll.length === 0 ? 'NO_RECORDS' : null));

  // 3. Closed before the time ran out, of the closed items that have a time.
  const timed = closed.filter((item) => item.dueAt !== null);
  const onTime = timed.filter((item) => (item.closedAt as Date).getTime() <= (item.dueAt as Date).getTime()).length;
  const onTimePct = timed.length === 0 ? null : (onTime / timed.length) * 100;
  kpis.push(kpi({ code: 'ON_TIME', unit: 'PERCENT', direction: 'MIN', target: targets.on_time_min_pct, minSample }, onTimePct, timed.length, [], timed.length === 0 ? 'NO_RECORDS' : closed.length > timed.length ? 'WITHOUT_TIME_LEFT_OUT' : null));

  // 4 and 5. Escalated at least one level, and to the last level, of the items that began in the window.
  const escalated = opened.filter((item) => item.maxEscalationLevel >= 1).length;
  kpis.push(kpi({ code: 'ESCALATED', unit: 'PERCENT', direction: 'MAX', target: targets.escalated_max_pct, minSample }, opened.length === 0 ? null : (escalated / opened.length) * 100, opened.length, [], opened.length === 0 ? 'NO_RECORDS' : null));
  const last = opened.filter((item) => item.levelsConfigured > 0 && item.maxEscalationLevel >= item.levelsConfigured).length;
  kpis.push(kpi({ code: 'LAST_LEVEL', unit: 'PERCENT', direction: 'MAX', target: targets.last_level_max_pct, minSample }, opened.length === 0 ? null : (last / opened.length) * 100, opened.length, [], opened.length === 0 ? 'NO_RECORDS' : null));

  // 6. New alerts per person per day (days on which the person got at least one), the 90th percentile.
  const perPersonDay = new Map<string, { urgent: number; total: number }>();
  for (const item of opened) {
    if (item.ownerId === null) continue;
    const key = `${item.ownerId}|${new Date(item.firstSeenAt.getTime() + 7 * 3_600_000).toISOString().slice(0, 10)}`;
    const entry = perPersonDay.get(key) ?? { urgent: 0, total: 0 };
    entry.total += 1;
    if (item.severity === 'URGENT') entry.urgent += 1;
    perPersonDay.set(key, entry);
  }
  const totals = [...perPersonDay.values()].map((entry) => entry.total);
  const urgents = [...perPersonDay.values()].map((entry) => entry.urgent);
  const alertParts = [part('URGENT', percentile(urgents, 0.9), urgents.length, targets.alerts_per_person_day_max.URGENT, 'MAX'), part('TOTAL', percentile(totals, 0.9), totals.length, targets.alerts_per_person_day_max.TOTAL, 'MAX')];
  kpis.push(kpi({ code: 'ALERTS_PER_PERSON', unit: 'COUNT', direction: 'MAX', target: targets.alerts_per_person_day_max.TOTAL, minSample }, percentile(totals, 0.9), totals.length, alertParts, totals.length === 0 ? 'NO_RECORDS' : null));

  // 7. Interrupting notices per person per day, the 90th percentile, of the notices that went out.
  const sentNotices = input.notices.filter((notice) => notice.decision === 'SEND_NOW' || notice.decision === 'SEND_GROUPED');
  const perDay = new Map<string, number>();
  for (const notice of sentNotices) perDay.set(`${notice.memberId}|${notice.day}`, (perDay.get(`${notice.memberId}|${notice.day}`) ?? 0) + 1);
  const pushes = [...perDay.values()];
  kpis.push(kpi({ code: 'PUSH_PER_PERSON', unit: 'COUNT', direction: 'MAX', target: targets.pushes_per_person_day_max, minSample }, percentile(pushes, 0.9), pushes.length, [part('MAX', pushes.length === 0 ? null : Math.max(...pushes), pushes.length, targets.pushes_per_person_day_max, 'MAX')], pushes.length === 0 ? 'NO_RECORDS' : null));

  // 8. Notices that broke the quiet hours without the allowance of the policy.
  const inQuiet = sentNotices.filter((notice) => notice.inQuiet);
  const unjustified = inQuiet.filter((notice) => notice.bypass === null).length;
  kpis.push(
    kpi({ code: 'OFF_HOURS', unit: 'COUNT', direction: 'MAX', target: targets.off_hours_unjustified_max, minSample }, sentNotices.length === 0 ? null : unjustified, sentNotices.length, [
      { key: 'ALLOWED', value: inQuiet.length - unjustified, sample: sentNotices.length, status: 'NO_DATA', target: null },
      part('UNJUSTIFIED', unjustified, sentNotices.length, targets.off_hours_unjustified_max, 'MAX'),
    ], sentNotices.length === 0 ? 'NO_RECORDS' : null),
  );

  // 9. Stale: open and not changed for more than the days of the two lines, as of now.
  const ageDays = (item: HealthItem): number => (input.now.getTime() - item.lastChangeAt.getTime()) / 86_400_000;
  const staleFirst = open.filter((item) => ageDays(item) > targets.stale_after_days.first);
  const staleSecond = open.filter((item) => ageDays(item) > targets.stale_after_days.second);
  const stalePct = open.length === 0 ? null : (staleFirst.length / open.length) * 100;
  kpis.push(
    kpi({ code: 'STALE', unit: 'PERCENT', direction: 'MAX', target: targets.stale_max_pct, minSample }, stalePct, open.length, [
      { key: `OVER_${targets.stale_after_days.first}_DAYS`, value: staleFirst.length, sample: open.length, status: 'NO_DATA', target: null },
      { key: `OVER_${targets.stale_after_days.second}_DAYS`, value: staleSecond.length, sample: open.length, status: 'NO_DATA', target: null },
    ], open.length === 0 ? 'NO_RECORDS' : null),
  );
  const unitCounts = new Map<string | null, number>();
  for (const item of staleFirst) unitCounts.set(item.unitId, (unitCounts.get(item.unitId) ?? 0) + 1);
  const staleByUnit = [...unitCounts.entries()].map(([unitId, count]) => ({ unitId, count })).sort((left, right) => right.count - left.count || String(left.unitId).localeCompare(String(right.unitId), 'en')).slice(0, 10);

  // 10 and 11. The weight of the ten largest types, and the rate of items put off, by type.
  const byType = new Map<string, { count: number; snoozed: number }>();
  for (const item of opened) {
    const entry = byType.get(item.typeCode) ?? { count: 0, snoozed: 0 };
    entry.count += 1;
    if (item.snoozeCount > 0) entry.snoozed += 1;
    byType.set(item.typeCode, entry);
  }
  const ranked = [...byType.entries()].sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0], 'en'));
  const topTypes: TopType[] = ranked.slice(0, 10).map(([typeCode, entry]) => ({ typeCode, count: entry.count, sharePct: round((entry.count / opened.length) * 100), snoozed: entry.snoozed, snoozeRatePct: entry.count >= minSample ? round((entry.snoozed / entry.count) * 100) : null }));
  const topCount = ranked.slice(0, 10).reduce((sum, [, entry]) => sum + entry.count, 0);
  kpis.push(kpi({ code: 'TOP10_SHARE', unit: 'PERCENT', direction: 'MAX', target: targets.top10_share_max_pct, minSample }, opened.length === 0 ? null : (topCount / opened.length) * 100, opened.length, [], opened.length === 0 ? 'NO_RECORDS' : null));
  const snoozed = opened.filter((item) => item.snoozeCount > 0).length;
  const typeRates = ranked.filter(([, entry]) => entry.count >= minSample).map(([typeCode, entry]) => part(typeCode, (entry.snoozed / entry.count) * 100, entry.count, targets.snooze_rate_max_pct, 'MAX'));
  kpis.push(kpi({ code: 'SNOOZE_RATE', unit: 'PERCENT', direction: 'MAX', target: targets.snooze_rate_max_pct, minSample }, opened.length === 0 ? null : (snoozed / opened.length) * 100, opened.length, typeRates.slice(0, 10), opened.length === 0 ? 'NO_RECORDS' : 'UNHELPFUL_FEEDBACK_NOT_BUILT'));

  // 12. Orphaned alerts open now and the mean time to reroute the ones closed in the window.
  const openGaps = input.gaps.filter((gap) => gap.closedAt === null);
  const orphaned = openGaps.reduce((sum, gap) => sum + gap.itemCount, 0);
  const rerouted = input.gaps.filter((gap) => within(gap.closedAt, input.from, input.to)).map((gap) => ((gap.closedAt as Date).getTime() - gap.openedAt.getTime()) / 3_600_000);
  const reroute = mean(rerouted);
  kpis.push(kpi({ code: 'ORPHAN', unit: 'COUNT', direction: 'MAX', target: targets.orphan_max, minSample }, orphaned, openGaps.length + rerouted.length, [part('OPEN', orphaned, 1, targets.orphan_max, 'MAX'), part('REROUTE_HOURS', reroute, rerouted.length, targets.reroute_max_hours, 'MAX')], null));

  // 13. Urgent notices delivered within the minutes of the target; there are no receipts for alert notices yet, and the figure says so.
  if (input.delivery === null) {
    kpis.push(kpi({ code: 'URGENT_DELIVERY', unit: 'PERCENT', direction: 'MIN', target: targets.urgent_delivery_min_pct, minSample }, null, 0, [], 'NO_DELIVERY_RECEIPTS', 'NO_SOURCE'));
  } else {
    kpis.push(kpi({ code: 'URGENT_DELIVERY', unit: 'PERCENT', direction: 'MIN', target: targets.urgent_delivery_min_pct, minSample }, input.delivery.sent === 0 ? null : (input.delivery.deliveredWithin / input.delivery.sent) * 100, input.delivery.sent, [], input.delivery.sent === 0 ? 'NO_RECORDS' : null));
  }

  // 14. Positions with a backup in force.
  kpis.push(kpi({ code: 'DELEGATION_COVERAGE', unit: 'PERCENT', direction: 'MIN', target: targets.delegation_coverage_min_pct, minSample }, input.coverage === null ? null : input.coverage.percent, input.coverage === null ? 0 : input.coverage.total, [], input.coverage === null || input.coverage.total === 0 ? 'NO_POSITIONS' : null));

  // The recording job: its records older than twice a pass make the page say it is old.
  const stale = input.lastPassAt === null || input.now.getTime() - input.lastPassAt.getTime() > 2 * 15 * 60_000;
  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    asOf: input.now.toISOString(),
    stale,
    lastPassAt: input.lastPassAt === null ? null : input.lastPassAt.toISOString(),
    kpis,
    topTypes,
    staleByUnit,
    items: { inWindow: opened.length, open: open.length },
  };
}
