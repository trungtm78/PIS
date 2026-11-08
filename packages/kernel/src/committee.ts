import { DomainError } from './errors.ts';
import { feedStatusOf } from './committee-facts.ts';
import type { FeedStatus, ProvinceFacts, ProvinceFundLine, ProvinceProjectFact, ProvinceUnitReport } from './committee-facts.ts';
import type { CommitteePolicy } from './committee-policy.ts';
import { weeklyChanges } from './home-changes.ts';
import type { ChangeLine, UnitWeek, WeekFigures } from './home-changes.ts';
import { ragOfValue } from './kpi-register.ts';
import type { RagColor } from './kpi-register.ts';

/**
 * The committee workspace as pure rules (lane BAN-1, docs/committee-workspace.md): from the facts of the province (`ProvinceFacts`, whatever port gave them) and the policy (`COMMITTEE_POLICY`) to the figures by sector,
 * district, investor and funding source, the plan against the disbursed against the same period of last year with the band of the year end, the projects that need the head of the committee ordered by impact, and
 * the alerts. No clock, no database, no float for money: sums are whole dong (BigInt) and rates are written with two places by whole-number arithmetic, so the web, the phone and the files cannot differ by a digit.
 */

export const COMMITTEE_ROLES = ['HEAD', 'DEPUTY', 'MEMBER', 'SECRETARIAT'] as const;
export type CommitteeRole = (typeof COMMITTEE_ROLES)[number];
export const committeeRoleOf = (value: unknown): CommitteeRole | undefined => COMMITTEE_ROLES.find((role) => role === value);

/** The system role that goes with each place in the committee (IAM grants them over the whole tenant). */
export const COMMITTEE_SYSTEM_ROLE: Readonly<Record<CommitteeRole, string>> = { HEAD: 'COMMITTEE_HEAD', DEPUTY: 'COMMITTEE_MEMBER', MEMBER: 'COMMITTEE_MEMBER', SECRETARIAT: 'COMMITTEE_SECRETARIAT' };

/** The classification of what the workspace shows: province-wide figures of every investor are confidential, the roster of the committee is personal data. */
export const COMMITTEE_CLASSIFICATION = 'CONFIDENTIAL';
export const COMMITTEE_ROSTER_CLASSIFICATION = 'PERSONAL';

/** The screens whose every view is written to the audit trail with who, when, which filters and what the figures stood on (the head belongs to a security service: access is traceable, never anonymous). */
export const COMMITTEE_SENSITIVE_SCREENS = ['WORKSPACE', 'ATTENTION', 'MEETING_PACK', 'DIRECTIVE_TRACKER', 'ALERTS', 'ROSTER', 'VIEW_AUDIT'] as const;
export type CommitteeScreen = (typeof COMMITTEE_SENSITIVE_SCREENS)[number];
export const committeeScreenOf = (value: unknown): CommitteeScreen | undefined => COMMITTEE_SENSITIVE_SCREENS.find((screen) => screen === value);

/**
 * The level of assurance of a session, read from the claims once the infrastructure phase brings SSO and MFA. Until then every session reads `PASSWORD`; the hook is here so that the audit row already has the column
 * and a tenant can ask (`mfa_required` of a member) for the stronger levels without a change of schema.
 */
export const ASSURANCE_LEVELS = ['UNKNOWN', 'PASSWORD', 'MFA'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];
export const assuranceOf = (value: unknown): AssuranceLevel => ASSURANCE_LEVELS.find((level) => level === value) ?? 'UNKNOWN';

export const DIMENSIONS = ['SECTOR', 'DISTRICT', 'INVESTOR', 'FUND_SOURCE'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const dimensionOf = (value: unknown): Dimension | undefined => DIMENSIONS.find((dimension) => dimension === value);

// -- numbers --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function assertDay(value: string, field: string): void {
  const match = DAY.exec(value);
  if (match === null || new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) !== value) throw new DomainError('VALIDATION_FAILED', 422, field);
}

export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
export const dayOfYear = (day: string): number => daysBetween(`${day.slice(0, 4)}-01-01`, day) + 1;
export const daysInYear = (year: number): number => (isLeap(year) ? 366 : 365);

/** `a / b` in percent with two places, half up, from whole numbers; null when the denominator is not positive. */
export function percentText(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const hundredths = (n * 10_000n * 2n + denominator) / (denominator * 2n);
  const text = hundredths.toString().padStart(3, '0');
  return `${negative && hundredths !== 0n ? '-' : ''}${text.slice(0, -2)}.${text.slice(-2)}`;
}

const scaled = (text: string): bigint => {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const value = BigInt(`${whole}${fraction.padEnd(2, '0').slice(0, 2)}`);
  return negative ? -value : value;
};
const fromScaled = (value: bigint): string => {
  const negative = value < 0n;
  const text = (negative ? -value : value).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${text.slice(0, -2)}.${text.slice(-2)}`;
};
/** The difference of two percent texts with two places, in points. */
export const pointsBetween = (left: string, right: string): string => fromScaled(scaled(left) - scaled(right));

/** The share of the plan of the year that should have been disbursed on a day, in percent with two places: the curve of the policy interpolated linearly inside the month. */
export function expectedPctOn(policy: Pick<CommitteePolicy, 'curve'>, day: string): string {
  assertDay(day, 'as_of');
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const dayOfMonth = Number(day.slice(8, 10));
  const upper = policy.curve[month - 1]?.cumulativePct ?? 100;
  const lower = month === 1 ? 0 : (policy.curve[month - 2]?.cumulativePct ?? 0);
  const length = daysInMonth(year, month);
  // Hundredths of a point, rounded half up.
  const hundredths = Math.round(((lower + ((upper - lower) * dayOfMonth) / length) * 100));
  return fromScaled(BigInt(hundredths));
}

// -- the year end band --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type OutlookMethod = 'RUN_RATE' | 'CURVE' | 'LAST_YEAR';

export interface OutlookEstimate {
  method: OutlookMethod;
  vnd: string;
  /** The method went past the plan and was held at the plan (a disbursement cannot pass its plan). */
  capped: boolean;
}

export interface OutlookBand {
  /** Null when no method could be used: the reason says why. */
  lowVnd: string | null;
  highVnd: string | null;
  lowPct: string | null;
  highPct: string | null;
  methods: OutlookEstimate[];
  /** Only one method could be used: the band is a point. */
  thin: boolean;
  reason: 'NO_DATA' | 'NO_PLAN' | null;
}

export interface OutlookInput {
  asOf: string;
  curve: Pick<CommitteePolicy, 'curve'>;
  planVnd: bigint;
  disbursedVnd: bigint | null;
  lastYearSamePeriodVnd: bigint | null;
  lastYearFullYearVnd: bigint | null;
}

/**
 * The band the disbursement of the year may end in: every method that can be computed gives a figure (the pace of the year so far carried to the whole year; what has been done divided by the share the curve says
 * should have been done; what has been done times the ratio of the whole of last year to the same period of last year), each held at the plan, and the band is the lowest to the highest of them.
 */
export function outlookBandOf(input: OutlookInput): OutlookBand {
  if (input.planVnd <= 0n) return { lowVnd: null, highVnd: null, lowPct: null, highPct: null, methods: [], thin: false, reason: 'NO_PLAN' };
  if (input.disbursedVnd === null) return { lowVnd: null, highVnd: null, lowPct: null, highPct: null, methods: [], thin: false, reason: 'NO_DATA' };
  const year = Number(input.asOf.slice(0, 4));
  const done = input.disbursedVnd;
  const raw: Array<{ method: OutlookMethod; vnd: bigint }> = [{ method: 'RUN_RATE', vnd: (done * BigInt(daysInYear(year))) / BigInt(dayOfYear(input.asOf)) }];
  const curve = scaled(expectedPctOn(input.curve, input.asOf));
  if (curve > 0n) raw.push({ method: 'CURVE', vnd: (done * 10_000n) / curve });
  if (input.lastYearSamePeriodVnd !== null && input.lastYearFullYearVnd !== null && input.lastYearSamePeriodVnd > 0n) raw.push({ method: 'LAST_YEAR', vnd: (done * input.lastYearFullYearVnd) / input.lastYearSamePeriodVnd });
  const methods = raw.map((one): OutlookEstimate => ({ method: one.method, vnd: (one.vnd > input.planVnd ? input.planVnd : one.vnd).toString(), capped: one.vnd > input.planVnd }));
  const values = methods.map((one) => BigInt(one.vnd));
  const low = values.reduce((a, b) => (b < a ? b : a));
  const high = values.reduce((a, b) => (b > a ? b : a));
  return { lowVnd: low.toString(), highVnd: high.toString(), lowPct: percentText(low, input.planVnd), highPct: percentText(high, input.planVnd), methods, thin: methods.length === 1, reason: null };
}

// -- the rows -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type CommitteeRag = RagColor | 'NO_DATA';

export interface RowFigures {
  planVnd: string;
  disbursedVnd: string | null;
  /** disbursed over plan, percent with two places; null when there is no plan or no disbursed figure. */
  ratePct: string | null;
  lastYearVnd: string | null;
  /** How many lines of the group have a last-year figure: the figure is given only when all of them have. */
  lastYearCoverage: { known: number; total: number };
  /** This year minus the same period of last year, in dong, when both are known. */
  changeVsLastYearVnd: string | null;
  expectedPct: string;
  /** rate minus the curve, in points; null with the rate. */
  gapPoints: string | null;
  rag: CommitteeRag;
  outlook: OutlookBand;
  /** How many of the lines are without a disbursed figure (counted as unknown, not as zero). */
  unknownLines: number;
}

export interface AggregateRow extends RowFigures {
  dimension: Dimension | 'PROVINCE';
  key: string;
  label: string;
  projects: number;
  planSharePct: string | null;
  attentionProjects: number;
}

const big = (value: string): bigint => BigInt(value);

/** The figures of a set of lines on a day. */
export function figuresOf(lines: readonly ProvinceFundLine[], asOf: string, policy: CommitteePolicy): RowFigures {
  let plan = 0n;
  let disbursed = 0n;
  let anyDisbursed = false;
  let unknown = 0;
  let lastYear = 0n;
  let lastYearKnown = 0;
  let lastYearFull = 0n;
  let lastYearFullKnown = 0;
  for (const line of lines) {
    plan += big(line.planVnd);
    if (line.disbursedVnd === null) unknown += 1;
    else {
      disbursed += big(line.disbursedVnd);
      anyDisbursed = true;
    }
    if (line.lastYearSamePeriodVnd !== null) {
      lastYear += big(line.lastYearSamePeriodVnd);
      lastYearKnown += 1;
    }
    if (line.lastYearFullYearVnd !== null) {
      lastYearFull += big(line.lastYearFullYearVnd);
      lastYearFullKnown += 1;
    }
  }
  const total = lines.length;
  const lastYearAll = total > 0 && lastYearKnown === total;
  const lastYearFullAll = total > 0 && lastYearFullKnown === total;
  const disbursedValue = anyDisbursed ? disbursed : null;
  const ratePct = disbursedValue === null ? null : percentText(disbursedValue, plan);
  const expectedPct = expectedPctOn(policy, asOf);
  const gapPoints = ratePct === null ? null : pointsBetween(ratePct, expectedPct);
  const rag: CommitteeRag = gapPoints === null ? 'NO_DATA' : (ragOfValue({ direction: 'HIGHER_IS_BETTER', green: policy.ragGapGreen, amber: policy.ragGapAmber }, Number(gapPoints)) ?? 'NO_DATA');
  const lastYearValue = lastYearAll ? lastYear : null;
  return {
    planVnd: plan.toString(),
    disbursedVnd: disbursedValue === null ? null : disbursedValue.toString(),
    ratePct,
    lastYearVnd: lastYearValue === null ? null : lastYearValue.toString(),
    lastYearCoverage: { known: lastYearKnown, total },
    changeVsLastYearVnd: lastYearValue === null || disbursedValue === null || unknown > 0 ? null : (disbursedValue - lastYearValue).toString(),
    expectedPct,
    gapPoints,
    rag,
    outlook: outlookBandOf({ asOf, curve: policy, planVnd: plan, disbursedVnd: disbursedValue, lastYearSamePeriodVnd: lastYearAll ? lastYear : null, lastYearFullYearVnd: lastYearFullAll ? lastYearFull : null }),
    unknownLines: unknown,
  };
}

const keyOf = (dimension: Dimension, project: ProvinceProjectFact, line: ProvinceFundLine): { key: string; label: string } => {
  switch (dimension) {
    case 'SECTOR':
      return { key: project.sectorCode, label: project.sectorName };
    case 'DISTRICT':
      return { key: project.districtCode, label: project.districtName };
    case 'INVESTOR':
      return { key: project.investorUnitId, label: project.investorName };
    case 'FUND_SOURCE':
      return { key: line.fundSourceCode, label: line.fundSourceName };
  }
};

/** The rows of one dimension, the biggest plan first (ties by key). The province row is the same figures over every line. */
export function aggregateBy(facts: ProvinceFacts, dimension: Dimension, policy: CommitteePolicy, attention: ReadonlySet<string> = new Set<string>()): AggregateRow[] {
  const projects = new Map(facts.projects.map((project) => [project.projectId, project]));
  const groups = new Map<string, { label: string; lines: ProvinceFundLine[]; projectIds: Set<string> }>();
  for (const line of facts.lines) {
    const project = projects.get(line.projectId);
    if (project === undefined) continue;
    const { key, label } = keyOf(dimension, project, line);
    const group = groups.get(key) ?? { label, lines: [], projectIds: new Set<string>() };
    group.lines.push(line);
    if (!group.projectIds.has(project.projectId)) {
      group.projectIds.add(project.projectId);
    }
    groups.set(key, group);
  }
  const totalPlan = facts.lines.reduce((sum, line) => sum + big(line.planVnd), 0n);
  const rows = [...groups.entries()].map(([key, group]): AggregateRow => {
    const figures = figuresOf(group.lines, facts.asOf, policy);
    return { dimension, key, label: group.label, projects: group.projectIds.size, planSharePct: percentText(big(figures.planVnd), totalPlan), attentionProjects: [...group.projectIds].filter((id) => attention.has(id)).length, ...figures };
  });
  return rows.sort((a, b) => (big(b.planVnd) > big(a.planVnd) ? 1 : big(b.planVnd) < big(a.planVnd) ? -1 : a.key.localeCompare(b.key, 'en')));
}

export function provinceRowOf(facts: ProvinceFacts, policy: CommitteePolicy, attention: ReadonlySet<string> = new Set<string>()): AggregateRow {
  const figures = figuresOf(facts.lines, facts.asOf, policy);
  return { dimension: 'PROVINCE', key: 'PROVINCE', label: '', projects: facts.projects.length, planSharePct: figures.planVnd === '0' ? null : '100.00', attentionProjects: attention.size, ...figures };
}

// -- units that do not report ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface UnitReportingRow {
  unitId: string;
  unitName: string;
  expected: number;
  received: number;
  reportingRatePct: string | null;
  lastReportedOn: string | null;
  /** Days since the last report; null when the unit never reported. */
  daysSinceReport: number | null;
  notReporting: boolean;
  reason: 'NEVER_REPORTED' | 'STALE' | 'LOW_RATE' | null;
}

export function unitReportingOf(units: readonly ProvinceUnitReport[], asOf: string, policy: CommitteePolicy): UnitReportingRow[] {
  return units
    .map((unit): UnitReportingRow => {
      const days = unit.lastReportedOn === null ? null : Math.max(0, daysBetween(unit.lastReportedOn, asOf));
      const rate = unit.expected > 0 ? percentText(BigInt(unit.received), BigInt(unit.expected)) : null;
      const reason = days === null ? (unit.expected > 0 ? 'NEVER_REPORTED' : null) : days > policy.unitNotReportingDays ? 'STALE' : rate !== null && Number(rate) < policy.unitMinReportingRatePct ? 'LOW_RATE' : null;
      return { unitId: unit.unitId, unitName: unit.unitName, expected: unit.expected, received: unit.received, reportingRatePct: rate, lastReportedOn: unit.lastReportedOn, daysSinceReport: days, notReporting: reason !== null, reason };
    })
    .sort((a, b) => Number(b.notReporting) - Number(a.notReporting) || (b.daysSinceReport ?? Number.MAX_SAFE_INTEGER) - (a.daysSinceReport ?? Number.MAX_SAFE_INTEGER) || a.unitName.localeCompare(b.unitName, 'vi'));
}

// -- the projects that need the head --------------------------------------------------------------------------------------------------------------------------------------------------------

export const ATTENTION_REASONS = ['DELAYED', 'STALLED_PROCEDURE', 'OVER_BUDGET_RISK', 'DISBURSEMENT_FAR_BELOW_PLAN', 'UNIT_NOT_REPORTING'] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];
export const attentionReasonOf = (value: unknown): AttentionReason | undefined => ATTENTION_REASONS.find((reason) => reason === value);

export interface AttentionSignal {
  reason: AttentionReason;
  /** The measured value (days, percent or points) as text; null when the fact is that nothing was ever reported. */
  value: string | null;
  threshold: number;
  unit: 'DAYS' | 'PERCENT' | 'POINTS';
  /** 0.5 at the threshold, 1 at twice the threshold or more. */
  severity: number;
  /** The weight the policy gives this reason. */
  weight: number;
}

export interface AttentionItem {
  rank: number;
  projectId: string;
  code: string;
  name: string;
  sectorCode: string;
  sectorName: string;
  districtName: string;
  investorUnitId: string;
  investorName: string;
  planVnd: string;
  disbursedVnd: string | null;
  ratePct: string | null;
  expectedPct: string;
  /** The money at stake: the plan of the year still to disburse, or the estimated overrun if that is larger. */
  exposureVnd: string;
  /** 0 to 100: the weighted share of the reasons that apply, times 0.5 to 1 by how much money is at stake. */
  score: string;
  signals: AttentionSignal[];
}

const severityOf = (value: number, threshold: number): number => (threshold <= 0 ? 1 : Math.min(1, 0.5 + (0.5 * (value - threshold)) / threshold));
const two = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);

/** The reasons a project needs the attention of the head, from its facts (an unknown fact gives no reason: it is never read as "fine" or as "late"). */
export function attentionSignalsOf(project: ProvinceProjectFact, lines: readonly ProvinceFundLine[], unitsNotReporting: ReadonlyMap<string, UnitReportingRow>, asOf: string, policy: CommitteePolicy): AttentionSignal[] {
  const signals: AttentionSignal[] = [];
  const w = policy.weights;
  if (project.delayDays !== null && project.delayDays >= policy.delayDays) signals.push({ reason: 'DELAYED', value: String(project.delayDays), threshold: policy.delayDays, unit: 'DAYS', severity: severityOf(project.delayDays, policy.delayDays), weight: w.delayed });
  if (project.stalledDays !== null && project.stalledDays >= policy.stalledDays) signals.push({ reason: 'STALLED_PROCEDURE', value: String(project.stalledDays), threshold: policy.stalledDays, unit: 'DAYS', severity: severityOf(project.stalledDays, policy.stalledDays), weight: w.stalled });
  if (project.eacVnd !== null && big(project.totalInvestmentVnd) > 0n) {
    const over = percentText(big(project.eacVnd) - big(project.totalInvestmentVnd), big(project.totalInvestmentVnd));
    if (over !== null && Number(over) >= policy.overBudgetPct && Number(over) > 0) signals.push({ reason: 'OVER_BUDGET_RISK', value: over, threshold: policy.overBudgetPct, unit: 'PERCENT', severity: severityOf(Number(over), policy.overBudgetPct), weight: w.overBudget });
  }
  const own = lines.filter((line) => line.projectId === project.projectId);
  const plan = own.reduce((sum, line) => sum + big(line.planVnd), 0n);
  const known = own.filter((line) => line.disbursedVnd !== null);
  if (plan > 0n && known.length > 0) {
    const rate = percentText(known.reduce((sum, line) => sum + big(line.disbursedVnd ?? '0'), 0n), plan);
    const expected = expectedPctOn(policy, asOf);
    if (rate !== null && Number(expected) > 0) {
      const shortfall = Number(pointsBetween(expected, rate));
      if (shortfall >= policy.farBelowPoints && shortfall > 0) signals.push({ reason: 'DISBURSEMENT_FAR_BELOW_PLAN', value: two(shortfall), threshold: policy.farBelowPoints, unit: 'POINTS', severity: severityOf(shortfall, policy.farBelowPoints), weight: w.farBelow });
    }
  }
  const unit = unitsNotReporting.get(project.investorUnitId);
  if (unit !== undefined && unit.notReporting) signals.push({ reason: 'UNIT_NOT_REPORTING', value: unit.daysSinceReport === null ? null : String(unit.daysSinceReport), threshold: policy.unitNotReportingDays, unit: 'DAYS', severity: unit.daysSinceReport === null ? 1 : severityOf(unit.daysSinceReport, policy.unitNotReportingDays), weight: w.notReporting });
  return signals;
}

/** The projects that need the head, ranked by impact (the highest score first; ties by the money at stake, then by code), at most `attentionTopN` unless `all` is asked for. */
export function rankAttention(facts: ProvinceFacts, policy: CommitteePolicy, options: { all?: boolean } = {}): { items: AttentionItem[]; total: number } {
  const reporting = new Map(unitReportingOf(facts.units, facts.asOf, policy).map((row) => [row.unitId, row]));
  const weightTotal = Object.values(policy.weights).reduce((sum, weight) => sum + weight, 0);
  const expected = expectedPctOn(policy, facts.asOf);
  const byProject = new Map<string, ProvinceFundLine[]>();
  for (const line of facts.lines) byProject.set(line.projectId, [...(byProject.get(line.projectId) ?? []), line]);
  const scored: Array<Omit<AttentionItem, 'rank'> & { exposure: bigint; scoreNumber: number }> = [];
  for (const project of facts.projects) {
    const lines = byProject.get(project.projectId) ?? [];
    const signals = attentionSignalsOf(project, lines, reporting, facts.asOf, policy);
    if (signals.length === 0) continue;
    const plan = lines.reduce((sum, line) => sum + big(line.planVnd), 0n);
    const known = lines.filter((line) => line.disbursedVnd !== null);
    const disbursed = known.length === 0 ? null : known.reduce((sum, line) => sum + big(line.disbursedVnd ?? '0'), 0n);
    const remaining = disbursed === null ? plan : plan > disbursed ? plan - disbursed : 0n;
    const over = project.eacVnd !== null && big(project.eacVnd) > big(project.totalInvestmentVnd) ? big(project.eacVnd) - big(project.totalInvestmentVnd) : 0n;
    const exposure = remaining > over ? remaining : over;
    const share = Math.min(1, Number((exposure * 10_000n) / BigInt(policy.exposureReferenceVnd)) / 10_000);
    const weighted = signals.reduce((sum, signal) => sum + signal.weight * signal.severity, 0);
    const scoreNumber = Math.round((100 * (weighted / weightTotal) * (0.5 + 0.5 * share)) * 100) / 100;
    scored.push({
      projectId: project.projectId,
      code: project.code,
      name: project.name,
      sectorCode: project.sectorCode,
      sectorName: project.sectorName,
      districtName: project.districtName,
      investorUnitId: project.investorUnitId,
      investorName: project.investorName,
      planVnd: plan.toString(),
      disbursedVnd: disbursed === null ? null : disbursed.toString(),
      ratePct: disbursed === null ? null : percentText(disbursed, plan),
      expectedPct: expected,
      exposureVnd: exposure.toString(),
      score: two(scoreNumber),
      signals: signals.sort((a, b) => b.weight * b.severity - a.weight * a.severity || a.reason.localeCompare(b.reason, 'en')),
      exposure,
      scoreNumber,
    });
  }
  scored.sort((a, b) => b.scoreNumber - a.scoreNumber || (b.exposure > a.exposure ? 1 : b.exposure < a.exposure ? -1 : 0) || a.code.localeCompare(b.code, 'en'));
  const limit = options.all === true ? scored.length : policy.attentionTopN;
  const items = scored.slice(0, limit).map(({ exposure: _exposure, scoreNumber: _score, ...item }, index): AttentionItem => ({ rank: index + 1, ...item }));
  return { items, total: scored.length };
}

// -- the alerts ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const COMMITTEE_ALERT_TYPES = ['COMMITTEE_PROVINCE_BEHIND', 'COMMITTEE_SECTOR_BEHIND', 'COMMITTEE_UNIT_NOT_REPORTING', 'COMMITTEE_DIRECTIVE_OVERDUE'] as const;
export type CommitteeAlertType = (typeof COMMITTEE_ALERT_TYPES)[number];
export const committeeAlertTypeOf = (value: unknown): CommitteeAlertType | undefined => COMMITTEE_ALERT_TYPES.find((type) => type === value);

export type CommitteeAlertSeverity = 'URGENT' | 'ACTION' | 'WATCH';

export interface CommitteeAlert {
  alertType: CommitteeAlertType;
  severity: CommitteeAlertSeverity;
  subjectKind: 'PROVINCE' | 'SECTOR' | 'UNIT';
  subjectKey: string;
  subjectLabel: string;
  /** The measured value and the line it is held against, as text. */
  value: string | null;
  threshold: string;
  /** One open alert per key: the evaluation again keeps it open, a recovery resolves it. */
  dedupeKey: string;
  detail: Record<string, string | number | null>;
}

export interface DirectiveUnitFigure {
  unitId: string;
  unitName: string;
  overdue: number;
  escalated: number;
}

/** The alerts of the committee from the facts and the directives, by rule; nothing is stored here. */
export function evaluateCommitteeAlerts(facts: ProvinceFacts, policy: CommitteePolicy, directives: readonly DirectiveUnitFigure[]): CommitteeAlert[] {
  const alerts: CommitteeAlert[] = [];
  const province = provinceRowOf(facts, policy);
  const year = facts.fiscalYear;
  if (province.gapPoints !== null && Number(province.gapPoints) < -policy.provinceGapPoints) {
    const worse = Number(province.gapPoints) < -2 * policy.provinceGapPoints;
    alerts.push({ alertType: 'COMMITTEE_PROVINCE_BEHIND', severity: worse ? 'URGENT' : 'ACTION', subjectKind: 'PROVINCE', subjectKey: 'PROVINCE', subjectLabel: '', value: province.ratePct, threshold: province.expectedPct, dedupeKey: `COMMITTEE_PROVINCE_BEHIND:PROVINCE:${year}`, detail: { rate_pct: province.ratePct, expected_pct: province.expectedPct, gap_points: province.gapPoints, allowed_gap_points: policy.provinceGapPoints } });
  }
  if (province.ratePct !== null) {
    for (const sector of aggregateBy(facts, 'SECTOR', policy)) {
      if (sector.ratePct === null || sector.planSharePct === null || Number(sector.planSharePct) < policy.sectorMinPlanSharePct) continue;
      const behind = Number(pointsBetween(province.ratePct, sector.ratePct));
      if (behind > policy.sectorGapPoints) {
        alerts.push({ alertType: 'COMMITTEE_SECTOR_BEHIND', severity: behind > 2 * policy.sectorGapPoints ? 'URGENT' : 'ACTION', subjectKind: 'SECTOR', subjectKey: sector.key, subjectLabel: sector.label, value: sector.ratePct, threshold: province.ratePct, dedupeKey: `COMMITTEE_SECTOR_BEHIND:${sector.key}:${year}`, detail: { sector_rate_pct: sector.ratePct, province_rate_pct: province.ratePct, behind_points: two(behind), allowed_gap_points: policy.sectorGapPoints, plan_share_pct: sector.planSharePct } });
      }
    }
  }
  for (const unit of unitReportingOf(facts.units, facts.asOf, policy)) {
    if (!unit.notReporting) continue;
    alerts.push({ alertType: 'COMMITTEE_UNIT_NOT_REPORTING', severity: unit.reason === 'NEVER_REPORTED' ? 'URGENT' : 'WATCH', subjectKind: 'UNIT', subjectKey: unit.unitId, subjectLabel: unit.unitName, value: unit.daysSinceReport === null ? null : String(unit.daysSinceReport), threshold: String(policy.unitNotReportingDays), dedupeKey: `COMMITTEE_UNIT_NOT_REPORTING:${unit.unitId}:${year}`, detail: { reason: unit.reason, expected: unit.expected, received: unit.received, last_reported_on: unit.lastReportedOn } });
  }
  for (const unit of directives) {
    if (unit.overdue < policy.directiveOverdueAlertCount) continue;
    alerts.push({ alertType: 'COMMITTEE_DIRECTIVE_OVERDUE', severity: unit.escalated > 0 ? 'URGENT' : 'ACTION', subjectKind: 'UNIT', subjectKey: unit.unitId, subjectLabel: unit.unitName, value: String(unit.overdue), threshold: String(policy.directiveOverdueAlertCount), dedupeKey: `COMMITTEE_DIRECTIVE_OVERDUE:${unit.unitId}:${year}`, detail: { overdue: unit.overdue, escalated: unit.escalated } });
  }
  const order: Record<CommitteeAlertSeverity, number> = { URGENT: 0, ACTION: 1, WATCH: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.dedupeKey.localeCompare(b.dedupeKey, 'en'));
}

// -- the workspace -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface CommitteeWorkspace {
  asOf: string;
  fiscalYear: number;
  feed: FeedStatus;
  province: AggregateRow;
  bySector: AggregateRow[];
  byDistrict: AggregateRow[];
  byInvestor: AggregateRow[];
  byFundSource: AggregateRow[];
  attentionTotal: number;
  attention: AttentionItem[];
  units: UnitReportingRow[];
  alerts: CommitteeAlert[];
  changes: { lines: ChangeLine[]; previousAsOf: string | null; reason: 'NO_PREVIOUS_WEEK' | null };
}

const weekOf = (facts: ProvinceFacts, policy: CommitteePolicy): WeekFigures => {
  const province = provinceRowOf(facts, policy);
  const units = new Map<string, UnitWeek>();
  for (const sector of aggregateBy(facts, 'SECTOR', policy)) units.set(sector.key, { band: sector.rag, criticalWarnings: null, overdueExplanations: null });
  return { asOfDate: facts.asOf, ratePmPct: province.ratePct, disbursedVnd: province.disbursedVnd, projectsWithoutData: province.unknownLines, units };
};

/** The whole workspace from the facts of the day and (for "since last week") the facts of a week before; the directives feed the alert of directives overdue. */
export function buildWorkspace(facts: ProvinceFacts, previous: ProvinceFacts | null, policy: CommitteePolicy, directives: readonly DirectiveUnitFigure[] = []): CommitteeWorkspace {
  assertDay(facts.asOf, 'as_of');
  const ranked = rankAttention(facts, policy, { all: true });
  const attentionIds = new Set(ranked.items.map((item) => item.projectId));
  return {
    asOf: facts.asOf,
    fiscalYear: facts.fiscalYear,
    feed: feedStatusOf(facts),
    province: provinceRowOf(facts, policy, attentionIds),
    bySector: aggregateBy(facts, 'SECTOR', policy, attentionIds),
    byDistrict: aggregateBy(facts, 'DISTRICT', policy, attentionIds),
    byInvestor: aggregateBy(facts, 'INVESTOR', policy, attentionIds),
    byFundSource: aggregateBy(facts, 'FUND_SOURCE', policy, attentionIds),
    attentionTotal: ranked.total,
    attention: ranked.items.slice(0, policy.attentionTopN),
    units: unitReportingOf(facts.units, facts.asOf, policy),
    alerts: evaluateCommitteeAlerts(facts, policy, directives),
    changes: weeklyChanges(weekOf(facts, policy), previous === null ? null : weekOf(previous, policy)),
  };
}

/** What the audit row of a view of a sensitive screen holds: who looked at what, with which filters, on which figures; never the figures themselves. */
export interface ViewAuditFacts {
  screen: CommitteeScreen;
  filters: Record<string, string | number | boolean | null>;
  asOf: string | null;
  recordCount: number | null;
  assurance: AssuranceLevel;
}

export interface FactsFilter {
  sectorCode?: string | undefined;
  districtCode?: string | undefined;
  investorUnitId?: string | undefined;
  fundSourceCode?: string | undefined;
}

/** The facts the filters leave: the projects that match every filter given, their lines (only those of the funding source when one is given) and the units that implement them. No filter gives the facts as they are. */
export function filterFacts(facts: ProvinceFacts, filter: FactsFilter): ProvinceFacts {
  if (filter.sectorCode === undefined && filter.districtCode === undefined && filter.investorUnitId === undefined && filter.fundSourceCode === undefined) return facts;
  const lines = facts.lines.filter((line) => filter.fundSourceCode === undefined || line.fundSourceCode === filter.fundSourceCode);
  const withLines = new Set(lines.map((line) => line.projectId));
  const projects = facts.projects.filter(
    (project) =>
      (filter.sectorCode === undefined || project.sectorCode === filter.sectorCode) &&
      (filter.districtCode === undefined || project.districtCode === filter.districtCode) &&
      (filter.investorUnitId === undefined || project.investorUnitId === filter.investorUnitId) &&
      (filter.fundSourceCode === undefined || withLines.has(project.projectId)),
  );
  const kept = new Set(projects.map((project) => project.projectId));
  const units = new Set(projects.map((project) => project.investorUnitId));
  return { ...facts, projects, lines: lines.filter((line) => kept.has(line.projectId)), units: facts.units.filter((unit) => units.has(unit.unitId)) };
}
