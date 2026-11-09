/** The read models of the screens of lane GOV-10: parsed from the answers of the API once, so a screen never reads a field that is not there. */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// -- red flags ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type RedFlagStatus = 'NEW' | 'IN_REVIEW' | 'CLEAR_PROPOSED' | 'CLEARED' | 'REFERRED';
export const RED_FLAG_STATUSES: readonly RedFlagStatus[] = ['NEW', 'IN_REVIEW', 'CLEAR_PROPOSED', 'CLEARED', 'REFERRED'];
export type RedFlagBand = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
export const RED_FLAG_BANDS: readonly RedFlagBand[] = ['LOW', 'MEDIUM', 'HIGH'];
export type ReadingStatus = 'FIRED' | 'CLEAR' | 'NOT_COMPUTABLE';

export interface Fired {
  code: string;
  ocpId: string | null;
  value: number | null;
  threshold: number | null;
  weight: number;
}

export interface Finding {
  id: string;
  subjectType: 'PACKAGE' | 'CONTRACT';
  subjectId: string;
  subjectCode: string;
  score: number;
  band: RedFlagBand;
  status: RedFlagStatus;
  fired: Fired[];
  notComputable: string[];
  rankingVersion: string;
  firstFlaggedAt: string;
  lastEvaluatedAt: string;
  reviewerId: string | null;
  clearProposedBy: string | null;
  version: number;
}

export interface Reading {
  code: string;
  ocpId: string;
  status: ReadingStatus;
  value: number | null;
  threshold: number | null;
  weight: number;
  missing: string[];
}

export interface ReviewEntry {
  id: string;
  move: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string | null;
  reason: string | null;
  score: number;
  at: string;
}

export interface FindingDetail extends Finding {
  readings: Reading[];
  clearReason: string | null;
  referralReason: string | null;
  history: ReviewEntry[];
  reopenedCount: number;
}

export interface FindingPage {
  asOf: string;
  items: Finding[];
  hasMore: boolean;
}

export interface RedFlagSummary {
  asOf: string;
  total: number;
  byBand: Record<string, number>;
  byStatus: Record<string, number>;
  lastScan: { startedAt: string; finishedAt: string | null; status: string; subjects: number; flagged: number } | null;
  denied: boolean;
}

export interface Indicator {
  code: string;
  ocpId: string;
  vendorSide: boolean;
  dataSources: string[];
  formula: string;
  source: string;
  indicatorAsOf: string;
  legalStatus: string;
  unverified: boolean;
  enabled: boolean;
  params: Record<string, unknown> | null;
  ruleVersion: number | null;
}

export function toFinding(raw: unknown): Finding | undefined {
  if (!isRecord(raw) || text(raw.id) === '') return undefined;
  const status = RED_FLAG_STATUSES.find((entry) => entry === raw.status);
  if (status === undefined) return undefined;
  const band = text(raw.band) as RedFlagBand;
  return {
    id: text(raw.id),
    subjectType: raw.subject_type === 'CONTRACT' ? 'CONTRACT' : 'PACKAGE',
    subjectId: text(raw.subject_id),
    subjectCode: text(raw.subject_code),
    score: count(raw.score),
    band: (['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const).includes(band) ? band : 'NONE',
    status,
    fired: list(raw.fired).filter(isRecord).map((entry) => ({ code: text(entry.code), ocpId: textOrNull(entry.ocp_id), value: numberOrNull(entry.value), threshold: numberOrNull(entry.threshold), weight: count(entry.weight) })),
    notComputable: list(raw.not_computable).map(text),
    rankingVersion: text(raw.ranking_version),
    firstFlaggedAt: text(raw.first_flagged_at),
    lastEvaluatedAt: text(raw.last_evaluated_at),
    reviewerId: textOrNull(raw.reviewer_id),
    clearProposedBy: textOrNull(raw.clear_proposed_by),
    version: count(raw.version),
  };
}

export function toFindingPage(raw: unknown): FindingPage {
  const items = isRecord(raw) ? list(raw.items).map(toFinding).filter((entry): entry is Finding => entry !== undefined) : [];
  return { asOf: isRecord(raw) ? text(raw.as_of) : '', items, hasMore: isRecord(raw) && raw.has_more === true };
}

export function toFindingDetail(raw: unknown): FindingDetail | undefined {
  const base = toFinding(raw);
  if (base === undefined || !isRecord(raw)) return undefined;
  return {
    ...base,
    readings: list(raw.readings).filter(isRecord).map((entry) => ({
      code: text(entry.code),
      ocpId: text(entry.ocp_id),
      status: entry.status === 'FIRED' || entry.status === 'CLEAR' ? entry.status : 'NOT_COMPUTABLE',
      value: numberOrNull(entry.value),
      threshold: numberOrNull(entry.threshold),
      weight: count(entry.weight),
      missing: list(entry.missing).map(text),
    })),
    clearReason: textOrNull(raw.clear_reason),
    referralReason: textOrNull(raw.referral_reason),
    reopenedCount: count(raw.reopened_count),
    history: list(raw.history).filter(isRecord).map((entry) => ({ id: text(entry.id), move: text(entry.move), fromStatus: textOrNull(entry.from_status), toStatus: text(entry.to_status), actorId: textOrNull(entry.actor_id), reason: textOrNull(entry.reason), score: count(entry.score), at: text(entry.at) })),
  };
}

export function toRedFlagSummary(raw: unknown): RedFlagSummary {
  const record = isRecord(raw) ? raw : {};
  const numbers = (value: unknown): Record<string, number> => (isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, count(entry)])) : {});
  const scan = isRecord(record.last_scan) ? record.last_scan : null;
  return {
    asOf: text(record.as_of),
    total: count(record.total),
    byBand: numbers(record.by_band),
    byStatus: numbers(record.by_status),
    lastScan: scan === null ? null : { startedAt: text(scan.started_at), finishedAt: textOrNull(scan.finished_at), status: text(scan.status), subjects: count(scan.subjects), flagged: count(scan.flagged) },
    denied: record.denied === true,
  };
}

export function toIndicators(raw: unknown): Indicator[] {
  if (!isRecord(raw)) return [];
  return list(raw.items).filter(isRecord).map((entry) => ({
    code: text(entry.code),
    ocpId: text(entry.ocp_id),
    vendorSide: entry.vendor_side === true,
    dataSources: list(entry.data_sources).map(text),
    formula: text(entry.formula),
    source: text(entry.source),
    indicatorAsOf: text(entry.indicator_as_of),
    legalStatus: text(entry.legal_status),
    unverified: entry.unverified !== false,
    enabled: entry.enabled !== false,
    params: isRecord(entry.params) ? entry.params : null,
    ruleVersion: numberOrNull(entry.rule_version),
  }));
}

/** What the screen says of a list before it is read: `never` means no scan has finished (so "none" would be a lie), `none` that the last scan found nothing, `denied` that the reader has no right to read. */
export function redFlagEmptyKind(summary: RedFlagSummary | undefined): 'denied' | 'never' | 'none' {
  if (summary?.denied === true) return 'denied';
  if (summary === undefined || summary.lastScan === null || summary.lastScan.finishedAt === null) return 'never';
  return 'none';
}

// -- the channel ladder -------------------------------------------------------------------------------------------------------------------------------------------------------

export type LadderChannel = 'IN_APP' | 'PUSH' | 'EMAIL' | 'TEAMS' | 'ZALO' | 'SMS';
export type RungState = 'QUEUED' | 'SENT' | 'DELIVERED' | 'SEEN' | 'FAILED' | 'SUPPRESSED';

export interface LadderPolicyView {
  severity: 'URGENT' | 'ACTION' | 'WATCH';
  version: string;
  unverified: boolean;
  formula: string | null;
  source: string | null;
  ruleAsOf: string | null;
  stopWhen: string;
  handOff: string;
  handOffAfterMinutes: number;
  expiresAfterMinutes: number;
  rungs: Array<{ index: number; channel: LadderChannel; waitMinutes: number }>;
}

export interface LadderRunView {
  id: string;
  source: string;
  sourceId: string;
  severity: string;
  alertType: string | null;
  policyVersion: string;
  state: string;
  doneBy: string | null;
  startedAt: string;
  nextAt: string | null;
  escalatedAt: string | null;
  planned: Array<{ index: number; channel: LadderChannel; waitMinutes: number }>;
  rungs: Array<{ index: number; channel: LadderChannel; state: RungState; reason: string | null; sentAt: string | null; receiptAt: string | null }>;
}

export interface LadderKpiView {
  from: string;
  to: string;
  asOf: string;
  runs: number;
  denied: boolean;
  unverified: boolean;
  formula: string;
  urgent: { runs: number; receipted: number; receiptedWithin: number; withinMinutes: number; sharePct: number | null; medianMinutes: number | null; escalated: number; exhausted: number };
  byChannel: Array<{ channel: LadderChannel; sent: number; delivered: number; seen: number; failed: number; suppressed: number; noWorkflow: number }>;
}

const CHANNELS: readonly LadderChannel[] = ['IN_APP', 'PUSH', 'EMAIL', 'TEAMS', 'ZALO', 'SMS'];
const channelOf = (value: unknown): LadderChannel => CHANNELS.find((entry) => entry === value) ?? 'IN_APP';
const RUNG_STATES: readonly RungState[] = ['QUEUED', 'SENT', 'DELIVERED', 'SEEN', 'FAILED', 'SUPPRESSED'];

export function toLadderPolicies(raw: unknown): { asOf: string; denied: boolean; ladders: LadderPolicyView[] } {
  const record = isRecord(raw) ? raw : {};
  return {
    asOf: text(record.as_of),
    denied: record.denied === true,
    ladders: list(record.ladders).filter(isRecord).map((entry) => ({
      severity: entry.severity === 'ACTION' || entry.severity === 'WATCH' ? entry.severity : 'URGENT',
      version: text(entry.version),
      unverified: entry.unverified !== false,
      formula: textOrNull(entry.formula),
      source: textOrNull(entry.source),
      ruleAsOf: textOrNull(entry.rule_as_of),
      stopWhen: text(entry.stop_when),
      handOff: text(entry.hand_off),
      handOffAfterMinutes: count(entry.hand_off_after_minutes),
      expiresAfterMinutes: count(entry.expires_after_minutes),
      rungs: list(entry.rungs).filter(isRecord).map((rung) => ({ index: count(rung.index), channel: channelOf(rung.channel), waitMinutes: count(rung.wait_minutes) })),
    })),
  };
}

export function toLadderRuns(raw: unknown): { asOf: string; items: LadderRunView[]; hasMore: boolean } {
  const record = isRecord(raw) ? raw : {};
  return {
    asOf: text(record.as_of),
    hasMore: record.has_more === true,
    items: list(record.items).filter(isRecord).map((entry) => ({
      id: text(entry.id),
      source: text(entry.source),
      sourceId: text(entry.source_id),
      severity: text(entry.severity),
      alertType: textOrNull(entry.alert_type),
      policyVersion: text(entry.policy_version),
      state: text(entry.state),
      doneBy: textOrNull(entry.done_by),
      startedAt: text(entry.started_at),
      nextAt: textOrNull(entry.next_at),
      escalatedAt: textOrNull(entry.escalated_at),
      planned: list(entry.planned).filter(isRecord).map((rung) => ({ index: count(rung.index), channel: channelOf(rung.channel), waitMinutes: count(rung.wait_minutes) })),
      rungs: list(entry.rungs).filter(isRecord).map((rung) => ({
        index: count(rung.index),
        channel: channelOf(rung.channel),
        state: RUNG_STATES.find((state) => state === rung.state) ?? 'QUEUED',
        reason: textOrNull(rung.reason),
        sentAt: textOrNull(rung.sent_at),
        receiptAt: textOrNull(rung.receipt_at),
      })),
    })),
  };
}

export function toLadderKpi(raw: unknown): LadderKpiView {
  const record = isRecord(raw) ? raw : {};
  const urgent = isRecord(record.urgent) ? record.urgent : {};
  return {
    from: text(record.from),
    to: text(record.to),
    asOf: text(record.as_of),
    runs: count(record.runs),
    denied: record.denied === true,
    unverified: record.unverified !== false,
    formula: text(record.formula),
    urgent: {
      runs: count(urgent.runs),
      receipted: count(urgent.receipted),
      receiptedWithin: count(urgent.receipted_within),
      withinMinutes: count(urgent.within_minutes),
      sharePct: numberOrNull(urgent.share_within_pct),
      medianMinutes: numberOrNull(urgent.median_minutes_to_receipt),
      escalated: count(urgent.escalated),
      exhausted: count(urgent.exhausted),
    },
    byChannel: list(record.by_channel).filter(isRecord).map((entry) => ({ channel: channelOf(entry.channel), sent: count(entry.sent), delivered: count(entry.delivered), seen: count(entry.seen), failed: count(entry.failed), suppressed: count(entry.suppressed), noWorkflow: count(entry.no_workflow) })),
  };
}

// -- feedback, closures, storms -----------------------------------------------------------------------------------------------------------------------------------------

export const FEEDBACK_REASONS = ['NOT_APPLICABLE', 'WRONG_DATA', 'DUPLICATE', 'ALREADY_HANDLED', 'NOT_MY_ROLE', 'TOO_EARLY', 'OTHER'] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export type FeedbackStatus = 'PENDING' | 'ACCEPTED_FOR_TUNING' | 'REJECTED' | 'DUPLICATE_OF' | 'WITHDRAWN';
export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = ['PENDING', 'ACCEPTED_FOR_TUNING', 'REJECTED', 'DUPLICATE_OF', 'WITHDRAWN'];

export interface Feedback {
  id: string;
  source: string;
  sourceId: string;
  alertType: string;
  severity: string;
  reason: FeedbackReason;
  note: string | null;
  status: FeedbackStatus;
  reviewNote: string | null;
  proposalNote: string | null;
  createdAt: string;
  version: number;
}

export interface TypeStat {
  alertType: string;
  reports: number;
  pending: number;
  shown: number;
  sharePct: number | null;
  needsReview: boolean;
}

export function toFeedbackPage(raw: unknown): { asOf: string; items: Feedback[]; nextCursor: string | null } {
  const record = isRecord(raw) ? raw : {};
  return {
    asOf: text(record.as_of),
    nextCursor: textOrNull(record.next_cursor),
    items: list(record.items).filter(isRecord).flatMap((entry) => {
      const reason = FEEDBACK_REASONS.find((candidate) => candidate === entry.reason);
      const status = FEEDBACK_STATUSES.find((candidate) => candidate === entry.status);
      if (reason === undefined || status === undefined || text(entry.id) === '') return [];
      return [{ id: text(entry.id), source: text(entry.source), sourceId: text(entry.source_id), alertType: text(entry.alert_type), severity: text(entry.severity), reason, note: textOrNull(entry.note), status, reviewNote: textOrNull(entry.review_note), proposalNote: textOrNull(entry.proposal_note), createdAt: text(entry.created_at), version: count(entry.version) }];
    }),
  };
}

export function toTypeStats(raw: unknown): { asOf: string; reviewLinePct: number; minShown: number; unverified: boolean; items: TypeStat[] } {
  const record = isRecord(raw) ? raw : {};
  return {
    asOf: text(record.as_of),
    reviewLinePct: count(record.review_line_pct),
    minShown: count(record.min_shown),
    unverified: record.unverified !== false,
    items: list(record.items).filter(isRecord).map((entry) => ({ alertType: text(entry.alert_type), reports: count(entry.reports), pending: count(entry.pending), shown: count(entry.shown), sharePct: numberOrNull(entry.share_pct), needsReview: entry.needs_review === true })),
  };
}

export interface Closure {
  id: string;
  source: string;
  sourceId: string;
  alertType: string | null;
  severity: string;
  state: 'OPEN' | 'RESOLVED_BY_SYSTEM';
  firstSeenAt: string;
  closedAt: string | null;
  reopenCount: number;
  decisionsBeforeClose: number | null;
  closedWithoutRecord: boolean;
}

export function toClosurePage(raw: unknown): { asOf: string; items: Closure[]; nextCursor: string | null } {
  const record = isRecord(raw) ? raw : {};
  return {
    asOf: text(record.as_of),
    nextCursor: textOrNull(record.next_cursor),
    items: list(record.items).filter(isRecord).map((entry) => ({
      id: text(entry.id),
      source: text(entry.source),
      sourceId: text(entry.source_id),
      alertType: textOrNull(entry.alert_type),
      severity: text(entry.severity),
      state: entry.state === 'OPEN' ? 'OPEN' : 'RESOLVED_BY_SYSTEM',
      firstSeenAt: text(entry.first_seen_at),
      closedAt: textOrNull(entry.closed_at),
      reopenCount: count(entry.reopen_count),
      decisionsBeforeClose: numberOrNull(entry.decisions_before_close),
      closedWithoutRecord: entry.closed_without_record === true,
    })),
  };
}

export interface ClosureSummary {
  asOf: string;
  from: string;
  to: string;
  denied: boolean;
  openNow: number;
  closedBySystem: number;
  reopened: number;
  closedWithoutRecord: number;
  medianHoursOpen: number | null;
  formula: string;
  byType: Array<{ alertType: string; closed: number; reopened: number; withoutRecord: number }>;
}

export function toClosureSummary(raw: unknown): ClosureSummary {
  const record = isRecord(raw) ? raw : {};
  return {
    asOf: text(record.as_of),
    from: text(record.from),
    to: text(record.to),
    denied: record.denied === true,
    openNow: count(record.open_now),
    closedBySystem: count(record.closed_by_system),
    reopened: count(record.reopened),
    closedWithoutRecord: count(record.closed_without_record),
    medianHoursOpen: numberOrNull(record.median_hours_open),
    formula: text(record.formula),
    byType: list(record.by_type).filter(isRecord).map((entry) => ({ alertType: text(entry.alert_type), closed: count(entry.closed), reopened: count(entry.reopened), withoutRecord: count(entry.without_record) })),
  };
}

export interface Storm {
  id: string;
  memberId: string;
  startedAt: string;
  endedAt: string | null;
  peakNew: number;
  groupedCount: number;
  windowMinutes: number;
  startAbove: number;
  endBelow: number;
}

export function toStorms(raw: unknown): Storm[] {
  const record = isRecord(raw) ? raw : {};
  return list(record.items).filter(isRecord).map((entry) => ({ id: text(entry.id), memberId: text(entry.member_id), startedAt: text(entry.started_at), endedAt: textOrNull(entry.ended_at), peakNew: count(entry.peak_new), groupedCount: count(entry.grouped_count), windowMinutes: count(entry.window_minutes), startAbove: count(entry.start_above), endBelow: count(entry.end_below) }));
}

export interface FloodState {
  asOf: string;
  stormActive: boolean;
  since: string | null;
  protecting: boolean;
  newInWindow: number;
  newToday: number;
  unavailable: string[];
  policy: { windowMinutes: number; startAbove: number; endBelow: number; maxNewPerDay: number; version: string; unverified: boolean; formula: string | null; source: string | null; ruleAsOf: string | null };
  groups: Array<{ key: string; dimension: string; source: string | null; count: number; mostSevere: string; members: Array<{ source: string; sourceId: string }> }>;
}

export function toFlood(raw: unknown): FloodState {
  const record = isRecord(raw) ? raw : {};
  const storm = isRecord(record.storm) ? record.storm : {};
  const policy = isRecord(record.policy) ? record.policy : {};
  return {
    asOf: text(record.as_of),
    stormActive: storm.active === true,
    since: textOrNull(storm.since),
    protecting: record.protecting === true,
    newInWindow: count(record.new_in_window),
    newToday: count(record.new_today),
    unavailable: list(record.unavailable_sources).map(text),
    policy: { windowMinutes: count(policy.window_minutes), startAbove: count(policy.start_above), endBelow: count(policy.end_below), maxNewPerDay: count(policy.max_new_per_day), version: text(policy.version), unverified: policy.unverified !== false, formula: textOrNull(policy.formula), source: textOrNull(policy.source), ruleAsOf: textOrNull(policy.rule_as_of) },
    groups: list(record.groups).filter(isRecord).map((group) => ({ key: text(group.key), dimension: text(group.dimension), source: textOrNull(group.source), count: count(group.count), mostSevere: text(group.most_severe), members: list(group.members).filter(isRecord).map((member) => ({ source: text(member.source), sourceId: text(member.source_id) })) })),
  };
}
