import { DomainError } from './errors.ts';
import type { FeedDisbursementRecord, FeedMilestoneRecord, FeedPlanRecord, FeedProjectRecord, FeedRecord, FeedChannel } from './finance-feed-model.ts';
import { FEED_DISTRICTS, FEED_FUND_NAMES, FEED_SECTORS, FEED_TEXT } from './messages/finance-feed-texts.ts';

/**
 * The reader of the facts of the feed (lane FEED-1): the province-wide project, plan and disbursement facts by sector, district, investor, fund and month, with the channel tag on every group. This is the
 * one thing a consumer (the dashboard of the head of the committee, a report) reads; it knows nothing of the adapters, so the real feed replaces the generator without touching a consumer. Pure: the store
 * hands it the records and it folds them (a later statement of the same thing replaces an earlier one, the earlier stays in the store) and sums them in exact hundredths of a dong.
 */

export type SourcedFeedRecord = FeedRecord & { channel: FeedChannel };

const cents = (amount: string): bigint => {
  const [integer = '0', fraction = ''] = amount.split('.');
  return BigInt(`${integer}${fraction.padEnd(2, '0').slice(0, 2)}`);
};

/** An exact amount back to text: whole dong without a decimal point, hundredths only when there are some. */
export function feedAmountText(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  const body = fraction === 0n ? `${whole}` : `${whole}.${String(fraction).padStart(2, '0').replace(/0+$/, '')}`;
  return negative ? `-${body}` : body;
}

/** `part / whole` as a percent with two decimals, half up; null when the whole is zero. */
export function feedPercentText(part: bigint, whole: bigint): string | null {
  if (whole <= 0n) return null;
  const scaled = (part * 100_00n * 2n + whole) / (whole * 2n);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export interface FeedProjectFact {
  channel: FeedChannel;
  feedProjectCode: string;
  /** False when disbursement or plan rows exist for a code the project list of the feed does not have. */
  known: boolean;
  projectName: string | null;
  sectorCode: string;
  districtCode: string;
  investorCode: string;
  investorName: string | null;
  projectStatus: string;
  ourProjectCode: string | null;
  fiscalYear: number;
  /** Plan of the year by fund, hundredths of a dong. */
  planByFund: Record<string, bigint>;
  /** The cumulative disbursement of the year at the latest month stated, by fund. */
  disbursedByFund: Record<string, bigint>;
  /** The disbursement of each month 1..12 (index 0 is January), all funds. */
  monthly: bigint[];
  latestMonth: number;
  /** The latest day any statement about the project was true. */
  asOf: string | null;
}

export interface FeedFoldFilter {
  fiscalYear: number;
  /** Only statements true on or before this day count (a view of the past); none means all. */
  asOf?: string | undefined;
  sector?: string | undefined;
  district?: string | undefined;
  investor?: string | undefined;
  fund?: string | undefined;
}

/**
 * Whether a later statement replaces the one held: the later day wins; on the same day the statement of a file or a push wins over the one of the generator, and otherwise the one that came last. The channel decides nothing else:
 * a project is one project however its statements came in.
 */
const replaces = (held: { asOf: string; channel: FeedChannel } | undefined, asOf: string, channel: FeedChannel): boolean => held === undefined || asOf > held.asOf || (asOf === held.asOf && !(channel === 'GENERATOR' && held.channel !== 'GENERATOR'));

/**
 * Folds the records into one fact per project for a fiscal year, whatever the channel the statements came in by (the channel is provenance: the fact carries the channel of the statement that names the project). The latest statement of a thing wins (by the day it was true, then by order); statements after `asOf` are ignored; a record of
 * another fiscal year is ignored. With a fund filter only that fund counts.
 */
export function foldFeedFacts(records: readonly SourcedFeedRecord[], filter: FeedFoldFilter): FeedProjectFact[] {
  const keyOf = (code: string): string => code;
  const projects = new Map<string, { asOf: string; record: FeedProjectRecord; channel: FeedChannel }>();
  const plans = new Map<string, { asOf: string; record: FeedPlanRecord; channel: FeedChannel }>();
  const rows = new Map<string, { asOf: string; record: FeedDisbursementRecord; channel: FeedChannel }>();
  for (const one of records) {
    if (filter.asOf !== undefined && one.asOf > filter.asOf) continue;
    if (one.kind === 'PROJECT') {
      const record = one.record as FeedProjectRecord;
      const key = keyOf(record.feedProjectCode);
      const held = projects.get(key);
      if (replaces(held, one.asOf, one.channel)) projects.set(key, { asOf: one.asOf, record, channel: one.channel });
    } else if (one.kind === 'PLAN') {
      const record = one.record as FeedPlanRecord;
      if (record.fiscalYear !== filter.fiscalYear) continue;
      const key = `${keyOf(record.feedProjectCode)}|${record.fundCode}`;
      const held = plans.get(key);
      if (replaces(held, one.asOf, one.channel)) plans.set(key, { asOf: one.asOf, record, channel: one.channel });
    } else if (one.kind === 'DISBURSEMENT') {
      const record = one.record as FeedDisbursementRecord;
      if (record.fiscalYear !== filter.fiscalYear) continue;
      const key = `${keyOf(record.feedProjectCode)}|${record.fundCode}|${record.month}`;
      const held = rows.get(key);
      if (replaces(held, one.asOf, one.channel)) rows.set(key, { asOf: one.asOf, record, channel: one.channel });
    }
  }

  const facts = new Map<string, FeedProjectFact>();
  const factOf = (channel: FeedChannel, code: string): FeedProjectFact => {
    const key = keyOf(code);
    const held = facts.get(key);
    if (held !== undefined) return held;
    const master = projects.get(key);
    const created: FeedProjectFact = {
      channel,
      feedProjectCode: code,
      known: master !== undefined,
      projectName: master?.record.projectName ?? null,
      sectorCode: master?.record.sectorCode ?? '?',
      districtCode: master?.record.districtCode ?? '?',
      investorCode: master?.record.investorCode ?? '?',
      investorName: master?.record.investorName ?? null,
      projectStatus: master?.record.projectStatus ?? 'ACTIVE',
      ourProjectCode: master?.record.ourProjectCode ?? null,
      fiscalYear: filter.fiscalYear,
      planByFund: {},
      disbursedByFund: {},
      monthly: Array.from({ length: 12 }, () => 0n),
      latestMonth: 0,
      asOf: master?.asOf ?? null,
    };
    facts.set(key, created);
    return created;
  };
  const touch = (fact: FeedProjectFact, asOf: string): void => {
    if (fact.asOf === null || asOf > fact.asOf) fact.asOf = asOf;
  };
  for (const [, master] of projects) factOf(master.channel, master.record.feedProjectCode);
  for (const [, plan] of plans) {
    if (filter.fund !== undefined && plan.record.fundCode !== filter.fund) continue;
    const fact = factOf(plan.channel, plan.record.feedProjectCode);
    fact.planByFund[plan.record.fundCode] = cents(plan.record.planAmount);
    touch(fact, plan.asOf);
  }
  const latestByFund = new Map<string, { month: number; cumulative: bigint; code: string; fund: string }>();
  for (const [, row] of rows) {
    if (filter.fund !== undefined && row.record.fundCode !== filter.fund) continue;
    const fact = factOf(row.channel, row.record.feedProjectCode);
    const month = row.record.month;
    fact.monthly[month - 1] = (fact.monthly[month - 1] as bigint) + cents(row.record.disbursedMonth);
    if (month > fact.latestMonth) fact.latestMonth = month;
    const key = `${row.record.feedProjectCode}|${row.record.fundCode}`;
    const held = latestByFund.get(key);
    if (held === undefined || month > held.month) latestByFund.set(key, { month, cumulative: cents(row.record.disbursedCumulative), code: row.record.feedProjectCode, fund: row.record.fundCode });
    touch(fact, row.asOf);
  }
  for (const [, latest] of latestByFund) factOf('FILE', latest.code).disbursedByFund[latest.fund] = latest.cumulative;
  return [...facts.values()]
    .filter((fact) => (filter.fund === undefined && fact.known) || Object.keys(fact.planByFund).length > 0 || Object.keys(fact.disbursedByFund).length > 0)
    .filter((fact) => (filter.sector === undefined || fact.sectorCode === filter.sector) && (filter.district === undefined || fact.districtCode === filter.district) && (filter.investor === undefined || fact.investorCode === filter.investor))
    .sort((a, b) => (a.feedProjectCode < b.feedProjectCode ? -1 : a.feedProjectCode > b.feedProjectCode ? 1 : a.channel < b.channel ? -1 : 1));
}

export const sumRecord = (record: Record<string, bigint>): bigint => Object.values(record).reduce((sum, value) => sum + value, 0n);

export const FEED_GROUP_BYS = ['sector', 'district', 'investor', 'fund', 'month', 'project'] as const;
export type FeedGroupBy = (typeof FEED_GROUP_BYS)[number];

export function feedGroupByOf(value: unknown): FeedGroupBy {
  if (typeof value !== 'string' || !(FEED_GROUP_BYS as readonly string[]).includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'group_by');
  return value as FeedGroupBy;
}

export interface FeedGroup {
  key: string;
  label: string | null;
  projects: number;
  /** Plan of the year, hundredths of a dong as text (see `feedAmountText`). */
  plan: string;
  /** The disbursement counted for the group (cumulative at the latest month; for a month the disbursement of that month). */
  disbursed: string;
  /** Cumulative disbursement up to the group (equals `disbursed` except for a month). */
  cumulative: string;
  ratePct: string | null;
  channels: FeedChannel[];
  asOf: string | null;
}

export interface FeedFacts {
  fiscalYear: number;
  groupBy: FeedGroupBy;
  channels: FeedChannel[];
  asOf: string | null;
  totals: FeedGroup;
  groups: FeedGroup[];
}

const labelOf = (groupBy: FeedGroupBy, key: string, fact: FeedProjectFact | undefined): string | null => {
  if (groupBy === 'sector') return FEED_SECTORS.find((sector) => sector.code === key)?.name ?? null;
  if (groupBy === 'district') return FEED_DISTRICTS.find((district) => district.code === key)?.name ?? null;
  if (groupBy === 'fund') return FEED_FUND_NAMES[key] ?? null;
  if (groupBy === 'investor') return fact?.investorName ?? null;
  if (groupBy === 'project') return fact?.projectName ?? null;
  return null;
};

interface Bucket {
  key: string;
  label: string | null;
  projects: Set<string>;
  plan: bigint;
  disbursed: bigint;
  channels: Set<FeedChannel>;
  asOf: string | null;
}

const groupOf = (bucket: Bucket, cumulative: bigint, plan: bigint): FeedGroup => {
  const channels = [...bucket.channels].sort();
  return {
    key: bucket.key,
    label: bucket.label,
    projects: bucket.projects.size,
    plan: feedAmountText(plan),
    disbursed: feedAmountText(bucket.disbursed),
    cumulative: feedAmountText(cumulative),
    ratePct: feedPercentText(cumulative, plan),
    channels,
    asOf: bucket.asOf,
  };
};

/** Groups the facts of a year. Every group names the channels its facts came in by (internal provenance). */
export function aggregateFeedFacts(facts: readonly FeedProjectFact[], groupBy: FeedGroupBy, fiscalYear: number): FeedFacts {
  const buckets = new Map<string, Bucket>();
  const bucketOf = (key: string, fact: FeedProjectFact | undefined): Bucket => {
    let held = buckets.get(key);
    if (held === undefined) {
      held = { key, label: labelOf(groupBy, key, fact), projects: new Set(), plan: 0n, disbursed: 0n, channels: new Set(), asOf: null };
      buckets.set(key, held);
    }
    return held;
  };
  const add = (bucket: Bucket, fact: FeedProjectFact, plan: bigint, disbursed: bigint): void => {
    bucket.projects.add(`${fact.channel}|${fact.feedProjectCode}`);
    bucket.plan += plan;
    bucket.disbursed += disbursed;
    bucket.channels.add(fact.channel);
    if (fact.asOf !== null && (bucket.asOf === null || fact.asOf > bucket.asOf)) bucket.asOf = fact.asOf;
  };
  const total: Bucket = { key: 'TOTAL', label: null, projects: new Set(), plan: 0n, disbursed: 0n, channels: new Set(), asOf: null };
  const monthTotals = Array.from({ length: 12 }, () => 0n);
  for (const fact of facts) {
    const plan = sumRecord(fact.planByFund);
    const disbursed = sumRecord(fact.disbursedByFund);
    add(total, fact, plan, disbursed);
    fact.monthly.forEach((value, index) => {
      monthTotals[index] = (monthTotals[index] as bigint) + value;
    });
    if (groupBy === 'sector') add(bucketOf(fact.sectorCode, fact), fact, plan, disbursed);
    else if (groupBy === 'district') add(bucketOf(fact.districtCode, fact), fact, plan, disbursed);
    else if (groupBy === 'investor') add(bucketOf(fact.investorCode, fact), fact, plan, disbursed);
    else if (groupBy === 'project') add(bucketOf(`${fact.channel}|${fact.feedProjectCode}`, fact), fact, plan, disbursed);
    else if (groupBy === 'fund') {
      for (const fund of new Set([...Object.keys(fact.planByFund), ...Object.keys(fact.disbursedByFund)])) add(bucketOf(fund, fact), fact, fact.planByFund[fund] ?? 0n, fact.disbursedByFund[fund] ?? 0n);
    }
  }
  let groups: FeedGroup[];
  if (groupBy === 'month') {
    let running = 0n;
    const channels = [...total.channels];
    groups = monthTotals.map((value, index) => {
      running += value;
      const bucket: Bucket = { key: String(index + 1).padStart(2, '0'), label: null, projects: total.projects, plan: total.plan, disbursed: value, channels: new Set(channels), asOf: total.asOf };
      return groupOf(bucket, running, total.plan);
    });
  } else {
    groups = [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((bucket) => groupOf(bucket, bucket.disbursed, bucket.plan));
  }
  const totals = groupOf(total, total.disbursed, total.plan);
  return { fiscalYear, groupBy, channels: totals.channels as FeedChannel[], asOf: total.asOf, totals, groups };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What the feed says about itself: findings inside the data and the quality of the reporting.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const FEED_FINDING_CODES = ['CUMULATIVE_MISMATCH', 'OVER_PLAN', 'RESTATED', 'UNKNOWN_PROJECT'] as const;
export type FeedFindingCode = (typeof FEED_FINDING_CODES)[number];

export interface FeedFinding {
  code: FeedFindingCode;
  channel: FeedChannel;
  feedProjectCode: string;
  fiscalYear: number;
  fundCode: string | null;
  month: number | null;
  /** What the figures were: both sides of the disagreement, exact amounts as text. */
  expected: string | null;
  actual: string | null;
  message: string;
}

/**
 * The disagreements inside the data of the feed itself, found without any figure of ours: a cumulative that is not the sum of the months, a cumulative above the plan of the year, a month stated again with
 * other figures, rows for a project the project list does not have. They are the first thing a person looks at before comparing the feed with our own figures.
 */
export function feedInternalFindings(records: readonly SourcedFeedRecord[], fiscalYear: number): FeedFinding[] {
  const found: FeedFinding[] = [];
  const known = new Set<string>();
  for (const one of records) if (one.kind === 'PROJECT') known.add(`${one.channel}|${(one.record as FeedProjectRecord).feedProjectCode}`);
  const statements = new Map<string, Array<{ asOf: string; record: FeedDisbursementRecord; channel: FeedChannel }>>();
  const planned = new Map<string, bigint>();
  const planStatement = new Map<string, string>();
  const orphan = new Set<string>();
  for (const one of records) {
    if (one.kind === 'PLAN') {
      const record = one.record as FeedPlanRecord;
      if (record.fiscalYear !== fiscalYear) continue;
      const key = `${one.channel}|${record.feedProjectCode}|${record.fundCode}`;
      if ((planStatement.get(key) ?? '') <= one.asOf) {
        planStatement.set(key, one.asOf);
        planned.set(key, cents(record.planAmount));
      }
      if (!known.has(`${one.channel}|${record.feedProjectCode}`)) orphan.add(`${one.channel}|${record.feedProjectCode}`);
    } else if (one.kind === 'DISBURSEMENT') {
      const record = one.record as FeedDisbursementRecord;
      if (record.fiscalYear !== fiscalYear) continue;
      const key = `${one.channel}|${record.feedProjectCode}|${record.fundCode}|${record.month}`;
      const held = statements.get(key) ?? [];
      held.push({ asOf: one.asOf, record, channel: one.channel });
      statements.set(key, held);
      if (!known.has(`${one.channel}|${record.feedProjectCode}`)) orphan.add(`${one.channel}|${record.feedProjectCode}`);
    }
  }
  for (const key of orphan) {
    const [channel, code] = key.split('|') as [FeedChannel, string];
    found.push({ code: 'UNKNOWN_PROJECT', channel, feedProjectCode: code, fiscalYear, fundCode: null, month: null, expected: null, actual: null, message: FEED_TEXT.finding_unknown_project });
  }
  const latestOf = (list: Array<{ asOf: string; record: FeedDisbursementRecord; channel: FeedChannel }>): { asOf: string; record: FeedDisbursementRecord; channel: FeedChannel } =>
    [...list].sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0))[list.length - 1] as { asOf: string; record: FeedDisbursementRecord; channel: FeedChannel };
  const funds = new Map<string, Map<number, { asOf: string; record: FeedDisbursementRecord; channel: FeedChannel }>>();
  for (const [key, list] of statements) {
    const [channel, code, fund, month] = key.split('|') as [FeedChannel, string, string, string];
    const distinct = new Set(list.map((entry) => entry.record.disbursedMonth));
    if (distinct.size > 1) {
      const ordered = [...list].sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
      found.push({ code: 'RESTATED', channel, feedProjectCode: code, fiscalYear, fundCode: fund, month: Number(month), expected: (ordered[0] as { record: FeedDisbursementRecord }).record.disbursedMonth, actual: (ordered[ordered.length - 1] as { record: FeedDisbursementRecord }).record.disbursedMonth, message: FEED_TEXT.finding_restated });
    }
    const fundKey = `${channel}|${code}|${fund}`;
    const byMonth = funds.get(fundKey) ?? new Map();
    byMonth.set(Number(month), latestOf(list));
    funds.set(fundKey, byMonth);
  }
  for (const [fundKey, byMonth] of funds) {
    const [source, code, fund] = fundKey.split('|') as [FeedChannel, string, string];
    const months = [...byMonth.keys()].sort((a, b) => a - b);
    const lastMonth = months[months.length - 1] as number;
    const plan = planned.get(`${source}|${code}|${fund}`);
    let running = 0n;
    let complete = true;
    let mismatched = false;
    let overPlan = false;
    for (let month = 1; month <= lastMonth; month += 1) {
      const entry = byMonth.get(month);
      if (entry === undefined) {
        complete = false;
        continue;
      }
      const record = entry.record;
      if (complete) {
        running += cents(record.disbursedMonth);
        // Only the first month whose cumulative is not the sum of the months before it is reported: every later one repeats the same fault.
        if (!mismatched && running !== cents(record.disbursedCumulative)) {
          mismatched = true;
          found.push({ code: 'CUMULATIVE_MISMATCH', channel: source, feedProjectCode: code, fiscalYear, fundCode: fund, month, expected: feedAmountText(running), actual: record.disbursedCumulative, message: FEED_TEXT.finding_cumulative_mismatch });
        }
      }
      if (!overPlan && plan !== undefined && cents(record.disbursedCumulative) > plan) {
        overPlan = true;
        found.push({ code: 'OVER_PLAN', channel: source, feedProjectCode: code, fiscalYear, fundCode: fund, month, expected: feedAmountText(plan), actual: record.disbursedCumulative, message: FEED_TEXT.finding_over_plan });
      }
    }
  }
  return found.sort((a, b) => (a.feedProjectCode < b.feedProjectCode ? -1 : a.feedProjectCode > b.feedProjectCode ? 1 : a.code < b.code ? -1 : 1));
}

const pad2 = (value: number): string => String(value).padStart(2, '0');
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** The last day of a month of the calendar. */
export const feedMonthEnd = (year: number, month: number): string => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

export type FeedUnitStatus = 'REPORTED_ON_TIME' | 'REPORTED_LATE' | 'LATE' | 'PENDING';

export interface FeedUnitReport {
  investorCode: string;
  investorName: string | null;
  status: FeedUnitStatus;
  reportedOn: string | null;
  /** The last day the report was on time. */
  dueOn: string;
  projects: number;
}

export interface FeedQuality {
  fiscalYear: number;
  month: number;
  asOf: string;
  dueOn: string;
  channels: FeedChannel[];
  completeness: { pct: string | null; numerator: number; denominator: number };
  timeliness: { pct: string | null; numerator: number; denominator: number };
  discrepancy: { pct: string | null; numerator: number; denominator: number };
  units: FeedUnitReport[];
  /** The units overdue: no report after the due day. */
  lateUnits: FeedUnitReport[];
  findings: number;
}

/**
 * The data-quality indicators of the feed for one reporting month. Completeness: units that reported / units that must report (units with an active project that has a plan of the year). Timeliness: units that
 * reported by the due day (the end of the month and `reportDueDays` days) / units that reported. A unit with no report is LATE after the due day and PENDING before it. Discrepancy rate: the differences that
 * were opened against our figures / the figures compared (given by the store, which holds the comparison). Each has numerator, denominator and the day it is as of.
 */
export function feedQuality(input: {
  facts: readonly FeedProjectFact[];
  disbursements: readonly SourcedFeedRecord[];
  fiscalYear: number;
  month: number;
  today: string;
  reportDueDays: number;
  compared: number;
  discrepancies: number;
  findings: number;
}): FeedQuality {
  const dueOn = addDays(feedMonthEnd(input.fiscalYear, input.month), input.reportDueDays);
  const units = new Map<string, { name: string | null; projects: number; channels: Set<FeedChannel> }>();
  for (const fact of input.facts) {
    if (!fact.known || fact.projectStatus !== 'ACTIVE' || Object.keys(fact.planByFund).length === 0) continue;
    const held = units.get(fact.investorCode) ?? { name: fact.investorName, projects: 0, channels: new Set() };
    held.projects += 1;
    held.channels.add(fact.channel);
    units.set(fact.investorCode, held);
  }
  const investorOf = new Map(input.facts.map((fact) => [fact.feedProjectCode, fact.investorCode]));
  const first = new Map<string, string>();
  for (const one of input.disbursements) {
    if (one.kind !== 'DISBURSEMENT') continue;
    const record = one.record as FeedDisbursementRecord;
    if (record.fiscalYear !== input.fiscalYear || record.month !== input.month || one.asOf > input.today) continue;
    const investor = investorOf.get(record.feedProjectCode);
    if (investor === undefined) continue;
    const held = first.get(investor);
    if (held === undefined || record.reportedOn < held) first.set(investor, record.reportedOn);
  }
  const rows: FeedUnitReport[] = [...units.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([code, unit]) => {
      const reportedOn = first.get(code) ?? null;
      const status: FeedUnitStatus = reportedOn !== null ? (reportedOn <= dueOn ? 'REPORTED_ON_TIME' : 'REPORTED_LATE') : input.today > dueOn ? 'LATE' : 'PENDING';
      return { investorCode: code, investorName: unit.name, status, reportedOn, dueOn, projects: unit.projects };
    });
  const reported = rows.filter((row) => row.reportedOn !== null);
  const onTime = rows.filter((row) => row.status === 'REPORTED_ON_TIME');
  const pct = (part: number, whole: number): string | null => feedPercentText(BigInt(part), BigInt(whole));
  const channels = [...new Set(input.facts.map((fact) => fact.channel))].sort();
  return {
    fiscalYear: input.fiscalYear,
    month: input.month,
    asOf: input.today,
    dueOn,
    channels,
    completeness: { pct: pct(reported.length, rows.length), numerator: reported.length, denominator: rows.length },
    timeliness: { pct: pct(onTime.length, reported.length), numerator: onTime.length, denominator: reported.length },
    discrepancy: { pct: pct(input.discrepancies, input.compared), numerator: input.discrepancies, denominator: input.compared },
    units: rows,
    lateUnits: rows.filter((row) => row.status === 'LATE'),
    findings: input.findings,
  };
}

export type { FeedMilestoneRecord };
export const feedMonthLabel = (year: number, month: number): string => `${pad2(month)}/${year}`;
