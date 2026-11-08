import { ApiError } from '@machvon/api-client';

/*
 * PRJ-28 (MR-1, MR.02): the board of the risks scored from signals, and the score history of one project. Every parser keeps only the fields it lists (an allowlist), keeps a figure the system
 * could not know as null (never zero) and takes the level, the trend and the score exactly as the server sent them: the browser never scores anything.
 */

export const KINDS = ['SCHEDULE_DELAY', 'PAYMENT_INTEGRITY', 'CLAIM_EARLY_WARNING', 'FUNDING_GAP', 'PROCUREMENT_DELAY', 'REGISTER'] as const;
export type Kind = (typeof KINDS)[number];
export const LEVELS = ['LOW', 'MEDIUM', 'CRITICAL'] as const;
export type Level = (typeof LEVELS)[number];
export const TRENDS = ['UP', 'DOWN', 'FLAT', 'NEW'] as const;
export type Trend = (typeof TRENDS)[number];
export const INDICATORS = ['SPI_SHORTFALL_PCT', 'MILESTONE_SLIP_DAYS', 'PAYMENT_BLOCKED_DRAFTS', 'PAYMENT_SIGNAL_REQUESTS', 'OPEN_CLAIMS', 'EARLY_WARNINGS_HIGH', 'FUNDING_GAP_PCT', 'PROCUREMENT_SLIP_DAYS'] as const;
export type Indicator = (typeof INDICATORS)[number];
export type Unit = 'PERCENT' | 'DAYS' | 'COUNT';

/** The unit each indicator is measured in. */
export const INDICATOR_UNIT: Readonly<Record<Indicator, Unit>> = {
  SPI_SHORTFALL_PCT: 'PERCENT',
  MILESTONE_SLIP_DAYS: 'DAYS',
  PAYMENT_BLOCKED_DRAFTS: 'COUNT',
  PAYMENT_SIGNAL_REQUESTS: 'COUNT',
  OPEN_CLAIMS: 'COUNT',
  EARLY_WARNINGS_HIGH: 'COUNT',
  FUNDING_GAP_PCT: 'PERCENT',
  PROCUREMENT_SLIP_DAYS: 'DAYS',
};

/** The kind of signal an indicator belongs to (the thresholds panel groups by it). */
export const INDICATOR_KIND: Readonly<Record<Indicator, Kind>> = {
  SPI_SHORTFALL_PCT: 'SCHEDULE_DELAY',
  MILESTONE_SLIP_DAYS: 'SCHEDULE_DELAY',
  PAYMENT_BLOCKED_DRAFTS: 'PAYMENT_INTEGRITY',
  PAYMENT_SIGNAL_REQUESTS: 'PAYMENT_INTEGRITY',
  OPEN_CLAIMS: 'CLAIM_EARLY_WARNING',
  EARLY_WARNINGS_HIGH: 'CLAIM_EARLY_WARNING',
  FUNDING_GAP_PCT: 'FUNDING_GAP',
  PROCUREMENT_SLIP_DAYS: 'PROCUREMENT_DELAY',
};

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const num = (value: unknown): number => numOrNull(value) ?? 0;
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const rec = (value: unknown): Raw => (isRecord(value) ? value : {});
const pick = <T extends string>(options: readonly T[], value: unknown): T | undefined => options.find((option) => option === value);

export const kindOf = (value: unknown): Kind | undefined => pick(KINDS, value);
export const levelOf = (value: unknown): Level => pick(LEVELS, value) ?? 'LOW';
export const trendOf = (value: unknown): Trend => pick(TRENDS, value) ?? 'NEW';
export const indicatorOf = (value: unknown): Indicator | undefined => pick(INDICATORS, value);

// ---- the rule ("i") -------------------------------------------------------------------------------------------------------------

export interface RuleParams {
  /** Four rising thresholds by indicator. */
  thresholds: Partial<Record<Indicator, number[]>>;
  impact: Partial<Record<Kind, number>>;
  criticalScore: number | null;
  jumpPoints: number | null;
  openFromLikelihood: number | null;
}

export interface Policy {
  name: string;
  code: string;
  formula: string | null;
  source: string | null;
  asOf: string | null;
  legalStatus: string;
  /** A starting value nobody confirmed: the screen says "default, not confirmed". */
  unverified: boolean;
  version: string;
  owner: string;
  params: RuleParams;
}

export function toPolicy(raw: unknown): Policy {
  const policy = rec(raw);
  const params = rec(policy.params);
  const thresholdsRaw = rec(params.thresholds);
  const impactRaw = rec(params.impact);
  const thresholds: Partial<Record<Indicator, number[]>> = {};
  for (const indicator of INDICATORS) {
    const line = thresholdsRaw[indicator];
    if (Array.isArray(line) && line.length > 0 && line.every((item) => numOrNull(item) !== null)) thresholds[indicator] = line.map(num);
  }
  const impact: Partial<Record<Kind, number>> = {};
  for (const kind of KINDS) {
    const value = numOrNull(impactRaw[kind]);
    if (value !== null) impact[kind] = value;
  }
  return {
    name: str(policy.name),
    code: str(policy.code),
    formula: strOrNull(policy.formula),
    source: strOrNull(policy.source),
    asOf: strOrNull(policy.as_of),
    legalStatus: str(policy.legal_status),
    // A policy that does not say it is verified is treated as not verified.
    unverified: policy.unverified !== false,
    version: str(policy.version),
    owner: str(policy.owner),
    params: { thresholds, impact, criticalScore: numOrNull(params.critical_score), jumpPoints: numOrNull(params.jump_points), openFromLikelihood: numOrNull(params.open_from_likelihood) },
  };
}

// ---- the evidence ---------------------------------------------------------------------------------------------------------------

export interface Reading {
  indicator: string;
  /** Null when the system could not know the figure. */
  value: number | null;
}

export interface Driver {
  indicator: string;
  value: number;
  likelihood: number;
}

export type FactValue = string | number | boolean | null;

export interface Evidence {
  readings: Reading[];
  drivers: Driver[];
  unknown: string[];
  facts: Array<{ key: string; value: FactValue }>;
}

export const EMPTY_EVIDENCE: Evidence = { readings: [], drivers: [], unknown: [], facts: [] };

const order = (name: string): number => {
  const at = INDICATORS.findIndex((indicator) => indicator === name);
  return at < 0 ? INDICATORS.length : at;
};

export function toEvidence(raw: unknown): Evidence {
  const evidence = rec(raw);
  const indicators = rec(evidence.indicators);
  const unknown = (Array.isArray(evidence.unknown) ? evidence.unknown : []).filter((item): item is string => typeof item === 'string');
  const readings = Object.entries(indicators)
    .map(([indicator, value]) => ({ indicator, value: numOrNull(value) }))
    .sort((a, b) => order(a.indicator) - order(b.indicator));
  // An indicator named as unknown is shown as not known even when a stale number sits beside it.
  const known = readings.map((reading) => (unknown.includes(reading.indicator) ? { indicator: reading.indicator, value: null } : reading));
  for (const name of unknown) if (!known.some((reading) => reading.indicator === name)) known.push({ indicator: name, value: null });
  const facts = Object.entries(rec(evidence.facts)).flatMap(([key, value]): Array<{ key: string; value: FactValue }> =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? [{ key, value }] : [],
  );
  return {
    readings: known,
    drivers: list(evidence.drivers).map((item) => ({ indicator: str(item.indicator), value: num(item.value), likelihood: num(item.likelihood) })),
    unknown,
    facts,
  };
}

/** Whether the evidence says anything at all (a risk entered by hand carries none). */
export const hasEvidence = (evidence: Evidence): boolean => evidence.readings.length > 0 || evidence.facts.length > 0;

/** A figure of an indicator as the reader of the locale writes it (the unit is added by the screen). */
export function figureText(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'vi-VN', { maximumFractionDigits: 2 }).format(value);
}

// ---- the board ------------------------------------------------------------------------------------------------------------------

export interface BoardItem {
  origin: 'SIGNAL' | 'REGISTER';
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  kind: Kind;
  title: string | null;
  likelihood: number;
  impact: number;
  score: number;
  level: Level;
  previousScore: number | null;
  trend: Trend;
  scoredOn: string;
  evidence: Evidence;
  owner: { membershipId: string; displayName: string | null } | null;
  alertOpen: boolean;
  ruleUnverified: boolean;
}

export interface BoardCounts {
  total: number;
  critical: number;
  medium: number;
  low: number;
  openAlerts: number;
}

export interface BoardPage {
  items: BoardItem[];
  nextCursor: string | undefined;
  counts: BoardCounts;
  policy: Policy;
  asOf: string;
}

function toItem(raw: Raw): BoardItem[] {
  const kind = kindOf(raw.kind);
  const score = numOrNull(raw.score);
  if (kind === undefined || str(raw.id) === '' || score === null) return [];
  const owner = isRecord(raw.owner) && str(raw.owner.membership_id) !== '' ? { membershipId: str(raw.owner.membership_id), displayName: strOrNull(raw.owner.display_name) } : null;
  return [
    {
      origin: raw.origin === 'REGISTER' ? 'REGISTER' : 'SIGNAL',
      id: str(raw.id),
      projectId: str(raw.project_id),
      projectCode: str(raw.project_code),
      projectName: str(raw.project_name),
      kind,
      title: strOrNull(raw.title),
      likelihood: num(raw.likelihood),
      impact: num(raw.impact),
      score,
      level: levelOf(raw.level),
      previousScore: numOrNull(raw.previous_score),
      trend: trendOf(raw.trend),
      scoredOn: str(raw.scored_on),
      evidence: toEvidence(raw.evidence),
      owner,
      alertOpen: raw.alert_open === true,
      ruleUnverified: raw.rule_unverified !== false,
    },
  ];
}

export function toBoardPage(raw: unknown): BoardPage | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items) || !isRecord(raw.counts)) return undefined;
  const counts = raw.counts;
  return {
    items: list(raw.items).flatMap(toItem),
    nextCursor: strOrNull(raw.next_cursor) ?? undefined,
    counts: { total: num(counts.total), critical: num(counts.critical), medium: num(counts.medium), low: num(counts.low), openAlerts: num(counts.open_alerts) },
    policy: toPolicy(raw.policy),
    asOf: str(raw.as_of),
  };
}

// ---- one project ----------------------------------------------------------------------------------------------------------------

export interface SignalLine {
  id: string;
  kind: Kind;
  status: 'ACTIVE' | 'CLEARED';
  likelihood: number;
  impact: number;
  score: number;
  evidence: Evidence;
  ruleVersion: string;
  ruleUnverified: boolean;
  firstScoredOn: string;
  lastScoredOn: string;
  clearedOn: string | null;
  version: number;
}

export interface HistoryRow {
  id: string;
  subjectKind: 'SIGNAL' | 'RISK';
  signalId: string | null;
  riskId: string | null;
  kind: Kind;
  source: 'JOB' | 'MANUAL';
  scoredOn: string;
  likelihood: number;
  impact: number;
  score: number;
  level: Level;
  priorScore: number | null;
  status: string;
  evidence: Evidence;
  ruleVersion: string;
  scoredAt: string;
}

export type AlertType = 'RISK_SCORE_CRITICAL' | 'RISK_SCORE_JUMP';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface RiskAlert {
  id: string;
  type: AlertType;
  subjectKind: 'SIGNAL' | 'RISK';
  kind: Kind | null;
  score: number;
  priorScore: number | null;
  threshold: number;
  ruleVersion: string;
  ruleUnverified: boolean;
  status: AlertStatus;
  raisedOn: string;
  acknowledgedAt: string | null;
  acknowledgeNote: string | null;
  resolvedOn: string | null;
  version: number;
}

export interface ProjectSignals {
  project: { id: string; code: string; name: string; status: string };
  lines: SignalLine[];
  history: HistoryRow[];
  alerts: RiskAlert[];
  policy: Policy;
  canAcknowledge: boolean;
  asOf: string;
}

const statusOf = (value: unknown): AlertStatus => (value === 'ACKNOWLEDGED' || value === 'RESOLVED' ? value : 'OPEN');

export function toProjectSignals(raw: unknown): ProjectSignals | undefined {
  if (!isRecord(raw) || !isRecord(raw.project) || str(raw.project.id) === '') return undefined;
  const can = rec(raw.can);
  return {
    project: { id: str(raw.project.id), code: str(raw.project.code), name: str(raw.project.name), status: str(raw.project.status) },
    lines: list(raw.lines).flatMap((item): SignalLine[] => {
      const kind = kindOf(item.signal_kind);
      const score = numOrNull(item.score);
      if (kind === undefined || str(item.id) === '' || score === null) return [];
      return [
        {
          id: str(item.id),
          kind,
          status: item.status === 'CLEARED' ? 'CLEARED' : 'ACTIVE',
          likelihood: num(item.likelihood),
          impact: num(item.impact),
          score,
          evidence: toEvidence(item.evidence),
          ruleVersion: str(item.rule_version),
          ruleUnverified: item.rule_unverified !== false,
          firstScoredOn: str(item.first_scored_on),
          lastScoredOn: str(item.last_scored_on),
          clearedOn: strOrNull(item.cleared_on),
          version: num(item.version),
        },
      ];
    }),
    history: list(raw.history).flatMap((item): HistoryRow[] => {
      const score = numOrNull(item.score);
      if (str(item.id) === '' || score === null) return [];
      return [
        {
          id: str(item.id),
          subjectKind: item.subject_kind === 'RISK' ? 'RISK' : 'SIGNAL',
          signalId: strOrNull(item.signal_id),
          riskId: strOrNull(item.risk_id),
          kind: kindOf(item.signal_kind) ?? 'REGISTER',
          source: item.source === 'MANUAL' ? 'MANUAL' : 'JOB',
          scoredOn: str(item.scored_on),
          likelihood: num(item.likelihood),
          impact: num(item.impact),
          score,
          level: levelOf(item.level),
          priorScore: numOrNull(item.prior_score),
          status: str(item.status),
          evidence: toEvidence(item.evidence),
          ruleVersion: str(item.rule_version),
          scoredAt: str(item.scored_at),
        },
      ];
    }),
    alerts: list(raw.alerts).flatMap((item): RiskAlert[] => {
      if (str(item.id) === '') return [];
      return [
        {
          id: str(item.id),
          type: item.alert_type === 'RISK_SCORE_JUMP' ? 'RISK_SCORE_JUMP' : 'RISK_SCORE_CRITICAL',
          subjectKind: item.subject_kind === 'RISK' ? 'RISK' : 'SIGNAL',
          kind: kindOf(item.signal_kind) ?? null,
          score: num(item.score),
          priorScore: numOrNull(item.prior_score),
          threshold: num(item.threshold),
          ruleVersion: str(item.rule_version),
          ruleUnverified: item.rule_unverified !== false,
          status: statusOf(item.status),
          raisedOn: str(item.raised_on),
          acknowledgedAt: strOrNull(item.acknowledged_at),
          acknowledgeNote: strOrNull(item.acknowledge_note),
          resolvedOn: strOrNull(item.resolved_on),
          version: num(item.version),
        },
      ];
    }),
    policy: toPolicy(raw.policy),
    canAcknowledge: can.acknowledge_alert === true,
    asOf: str(raw.as_of),
  };
}

// ---- the history and the chart --------------------------------------------------------------------------------------------------

/** Newest first: by the day of the score, then by the moment it was written. */
export const newestFirst = (rows: readonly HistoryRow[]): HistoryRow[] => [...rows].sort((a, b) => (a.scoredOn === b.scoredOn ? b.scoredAt.localeCompare(a.scoredAt) : b.scoredOn.localeCompare(a.scoredOn)));

export interface Track {
  key: string;
  kind: Kind;
  subjectKind: 'SIGNAL' | 'RISK';
  /** One point a day, oldest first: the score written last that day. */
  points: Array<{ day: string; score: number }>;
}

/** The history of each line (a signal of a kind, or a risk of the register) as a track of scores, one point a day. */
export function tracksOf(history: readonly HistoryRow[]): Track[] {
  const groups = new Map<string, HistoryRow[]>();
  for (const row of history) {
    const key = row.subjectKind === 'RISK' ? `risk:${row.riskId ?? row.id}` : `signal:${row.signalId ?? row.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, rows]) => {
    const oldest = [...rows].sort((a, b) => (a.scoredOn === b.scoredOn ? a.scoredAt.localeCompare(b.scoredAt) : a.scoredOn.localeCompare(b.scoredOn)));
    const byDay = new Map<string, number>();
    for (const row of oldest) byDay.set(row.scoredOn, row.score);
    const first = oldest[0];
    return { key, kind: first?.kind ?? 'REGISTER', subjectKind: first?.subjectKind ?? 'SIGNAL', points: [...byDay].map(([day, score]) => ({ day, score })) };
  });
}

// ---- refusals -------------------------------------------------------------------------------------------------------------------

export type Refusal = 'alertState' | 'versionConflict' | 'denied' | 'notFound' | 'validation' | 'session' | 'general';

/** The refusal of an acknowledgement as the screen words it (the words are in `labels.ts`). */
export function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'RISK_ALERT_STATE_INVALID':
      return 'alertState';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}

/** Whether a read says "not there for you": a 404 (another tenant, or out of the scope). */
export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;
