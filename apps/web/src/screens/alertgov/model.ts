/**
 * The shapes the governance of the alert system reads (lane GOV-9a): the health of the alert system (HOME-13), the escalations (NOT-19), the profile of a person (NOT-18), the absences and covers (ADM-25).
 * The server sends snake_case; a row that has not the shape of its kind is dropped rather than shown half filled, and an answer that has not the shape of its page is refused (the screen shows an error, never an empty page).
 */

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const whole = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((entry): entry is string => typeof entry === 'string' && entry !== '');
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' ? allowed.find((entry) => entry === value) : undefined);

export const HEALTH_PERMISSION = 'home.alert.health.read';
export const COVER_PERMISSION = 'home.alert.cover.manage';
export const HOME_PERMISSION = 'home.read';

export const SEVERITIES = ['URGENT', 'ACTION', 'WATCH'] as const;
export type AlertSeverity = (typeof SEVERITIES)[number];

export const WINDOWS = [7, 14, 28, 60, 90] as const;
export const DEFAULT_WINDOW = 28;

export const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** `SNOOZE_RATE` becomes `snoozeRate`, the suffix of the keys of the words of a code. */
export const camel = (code: string): string => code.toLowerCase().replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

export interface Person {
  id: string;
  name: string | null;
}

const person = (raw: unknown): Person | null => (isRecord(raw) && text(raw.id) !== '' ? { id: text(raw.id), name: nullableText(raw.name) } : null);

/** The rule that governs a page: its version, whether its numbers are a starting value nobody confirmed, where they come from and the numbers. */
export interface RuleInfo {
  code: string;
  version: string;
  unverified: boolean;
  formula: string;
  source: string;
  asOf: string;
  params: Raw;
}

export function toRule(raw: unknown): RuleInfo | undefined {
  if (!isRecord(raw) || !isRecord(raw.params)) return undefined;
  return { code: text(raw.code), version: text(raw.version), unverified: raw.unverified === true, formula: text(raw.formula), source: text(raw.source), asOf: text(raw.as_of), params: raw.params };
}

// -- HOME-13: the health of the alert system ------------------------------------------------------------------------------------------------------------------------------------------

export const KPI_STATUSES = ['OK', 'WATCH', 'BREACH', 'NO_DATA', 'NO_SOURCE'] as const;
export type KpiStatus = (typeof KPI_STATUSES)[number];
export const KPI_UNITS = ['HOURS', 'PERCENT', 'COUNT'] as const;
export type KpiUnit = (typeof KPI_UNITS)[number];

export interface KpiPart {
  key: string;
  value: number | null;
  sample: number;
  status: KpiStatus;
  target: number | null;
}

export interface Kpi {
  code: string;
  value: number | null;
  unit: KpiUnit;
  direction: 'MAX' | 'MIN';
  target: number | null;
  status: KpiStatus;
  sample: number;
  lowSample: boolean;
  parts: KpiPart[];
  formula: string;
  source: string;
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
  unitName: string | null;
  count: number;
}

export interface PositionRow {
  key: string;
  roleCode: string;
  unitId: string;
  unitName: string | null;
  holders: number;
  present: number;
  state: 'PEER_BACKED' | 'COVERED' | 'SINGLE_POINT' | 'UNCOVERED';
}

export interface Health {
  from: string;
  to: string;
  asOf: string;
  stale: boolean;
  lastPassAt: string | null;
  kpis: Kpi[];
  topTypes: TopType[];
  staleByUnit: StaleUnit[];
  items: { inWindow: number; open: number };
  positions: PositionRow[];
  rule: RuleInfo;
}

const POSITION_STATES = ['PEER_BACKED', 'COVERED', 'SINGLE_POINT', 'UNCOVERED'] as const;

function toPart(raw: unknown): KpiPart[] {
  if (!isRecord(raw) || text(raw.key) === '') return [];
  return [{ key: text(raw.key), value: num(raw.value), sample: whole(raw.sample), status: oneOf(raw.status, KPI_STATUSES) ?? 'NO_DATA', target: num(raw.target) }];
}

function toKpi(raw: unknown): Kpi[] {
  if (!isRecord(raw) || text(raw.code) === '') return [];
  return [
    {
      code: text(raw.code),
      value: num(raw.value),
      unit: oneOf(raw.unit, KPI_UNITS) ?? 'COUNT',
      direction: raw.direction === 'MIN' ? 'MIN' : 'MAX',
      target: num(raw.target),
      status: oneOf(raw.status, KPI_STATUSES) ?? 'NO_DATA',
      sample: whole(raw.sample),
      lowSample: raw.low_sample === true,
      parts: list(raw.parts).flatMap(toPart),
      formula: text(raw.formula),
      source: text(raw.source),
      note: nullableText(raw.note),
    },
  ];
}

export function toPosition(raw: unknown): PositionRow[] {
  const state = isRecord(raw) ? oneOf(raw.state, POSITION_STATES) : undefined;
  if (!isRecord(raw) || state === undefined || text(raw.key) === '') return [];
  return [{ key: text(raw.key), roleCode: text(raw.role_code), unitId: text(raw.unit_id), unitName: nullableText(raw.unit_name), holders: whole(raw.holders), present: whole(raw.present), state }];
}

/** The answer of `getAlertHealth`; undefined when it has not the shape of the page (no indicators, no rule). */
export function toHealth(raw: unknown): Health | undefined {
  if (!isRecord(raw)) return undefined;
  const rule = toRule(raw.rule);
  const kpis = list(raw.kpis).flatMap(toKpi);
  if (rule === undefined || kpis.length === 0) return undefined;
  const items = isRecord(raw.items) ? raw.items : {};
  return {
    from: text(raw.from),
    to: text(raw.to),
    asOf: text(raw.as_of),
    stale: raw.stale === true,
    lastPassAt: nullableText(raw.last_pass_at),
    kpis,
    topTypes: list(raw.top_types).flatMap((row): TopType[] =>
      isRecord(row) && text(row.type_code) !== '' ? [{ typeCode: text(row.type_code), count: whole(row.count), sharePct: num(row.share_pct) ?? 0, snoozed: whole(row.snoozed), snoozeRatePct: num(row.snooze_rate_pct) }] : [],
    ),
    staleByUnit: list(raw.stale_by_unit).flatMap((row): StaleUnit[] => (isRecord(row) ? [{ unitId: nullableText(row.unit_id), unitName: nullableText(row.unit_name), count: whole(row.count) }] : [])),
    items: { inWindow: whole(items.in_window), open: whole(items.open) },
    positions: list(raw.positions).flatMap(toPosition),
    rule,
  };
}

/** The figure as it is written: a number with its unit, or a dash when the indicator has none (never a zero for "no data"). */
export function figureOf(value: number | null, unit: KpiUnit): { number: string; unit: KpiUnit } | null {
  if (value === null) return null;
  const formatted = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(value);
  return { number: formatted, unit };
}

export const STATUS_TONE: Readonly<Record<KpiStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'info'>> = { OK: 'success', WATCH: 'warning', BREACH: 'danger', NO_DATA: 'neutral', NO_SOURCE: 'info' };

// -- NOT-19: the escalations ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const ESCALATION_KINDS = ['FUNCTIONAL', 'HIERARCHICAL', 'PROMOTION'] as const;
export const ESCALATION_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'CLOSED'] as const;
export const ROUTED_VIA = ['PRIMARY', 'FALLBACK_HIERARCHY', 'FALLBACK_ADMIN', 'DEPUTY', 'NONE'] as const;
export const ESCALATION_TRIGGERS = ['NOT_CLAIMED', 'NO_PROGRESS', 'OVERDUE', 'ORPHANED', 'WATCH_AGED'] as const;

export interface EscalationRow {
  id: string;
  source: string;
  sourceId: string;
  level: number;
  kind: (typeof ESCALATION_KINDS)[number];
  trigger: (typeof ESCALATION_TRIGGERS)[number];
  recipient: Person | null;
  owner: Person | null;
  routedVia: (typeof ROUTED_VIA)[number];
  severity: AlertSeverity;
  fromSeverity: string | null;
  itemTitle: string;
  itemSubtitle: string | null;
  itemDueOn: string | null;
  target: { screen: string; id: string };
  reachedAt: string;
  status: (typeof ESCALATION_STATUSES)[number];
  acknowledgedAt: string | null;
  closeReason: string | null;
  policyVersion: string;
}

export interface EscalationStep {
  kind: 'FUNCTIONAL' | 'HIERARCHICAL';
  afterWorkingHours: number;
  levelsUp: number | null;
  functionRole: string | null;
}

export interface EscalationPolicyView {
  steps: Record<AlertSeverity, EscalationStep[]>;
  triggers: string[];
  holdHours: Record<AlertSeverity, number>;
  watchPromotion: { enabled: boolean; afterWorkingDays: number } | null;
}

export interface EscalationPage {
  items: EscalationRow[];
  rule: RuleInfo;
  policy: EscalationPolicyView | null;
  asOf: string;
}

function toStep(raw: unknown): EscalationStep[] {
  if (!isRecord(raw)) return [];
  const kind = oneOf(raw.kind, ['FUNCTIONAL', 'HIERARCHICAL'] as const);
  return kind === undefined ? [] : [{ kind, afterWorkingHours: whole(raw.after_working_hours), levelsUp: num(raw.levels_up), functionRole: nullableText(raw.function_role) }];
}

export function toPolicy(params: Raw): EscalationPolicyView | null {
  const steps = isRecord(params.steps) ? params.steps : undefined;
  if (steps === undefined) return null;
  const hold = isRecord(params.hold_after_acknowledge_working_hours) ? params.hold_after_acknowledge_working_hours : {};
  const promotion = isRecord(params.watch_promotion) ? params.watch_promotion : undefined;
  return {
    steps: { URGENT: list(steps.URGENT).flatMap(toStep), ACTION: list(steps.ACTION).flatMap(toStep), WATCH: list(steps.WATCH).flatMap(toStep) },
    triggers: strings(params.triggers),
    holdHours: { URGENT: whole(hold.URGENT), ACTION: whole(hold.ACTION), WATCH: whole(hold.WATCH) },
    watchPromotion: promotion === undefined ? null : { enabled: promotion.enabled === true, afterWorkingDays: whole(promotion.after_working_days) },
  };
}

function toEscalationRow(raw: unknown): EscalationRow[] {
  if (!isRecord(raw)) return [];
  const kind = oneOf(raw.kind, ESCALATION_KINDS);
  const status = oneOf(raw.status, ESCALATION_STATUSES);
  const target = isRecord(raw.target) ? { screen: text(raw.target.screen), id: text(raw.target.id) } : { screen: '', id: '' };
  if (kind === undefined || status === undefined || text(raw.id) === '') return [];
  return [
    {
      id: text(raw.id),
      source: text(raw.source),
      sourceId: text(raw.source_id),
      level: whole(raw.level),
      kind,
      trigger: oneOf(raw.trigger, ESCALATION_TRIGGERS) ?? 'OVERDUE',
      recipient: person(raw.recipient),
      owner: person(raw.owner),
      routedVia: oneOf(raw.routed_via, ROUTED_VIA) ?? 'NONE',
      severity: oneOf(raw.severity, SEVERITIES) ?? 'ACTION',
      fromSeverity: nullableText(raw.from_severity),
      itemTitle: text(raw.item_title),
      itemSubtitle: nullableText(raw.item_subtitle),
      itemDueOn: nullableText(raw.item_due_on),
      target,
      reachedAt: text(raw.reached_at),
      status,
      acknowledgedAt: nullableText(raw.acknowledged_at),
      closeReason: nullableText(raw.close_reason),
      policyVersion: text(raw.policy_version),
    },
  ];
}

export function toEscalations(raw: unknown): EscalationPage | undefined {
  if (!isRecord(raw)) return undefined;
  const rule = toRule(raw.rule);
  if (rule === undefined || !Array.isArray(raw.items)) return undefined;
  return { items: raw.items.flatMap(toEscalationRow), rule, policy: toPolicy(rule.params), asOf: text(raw.as_of) };
}

// -- NOT-18: the profile of a person --------------------------------------------------------------------------------------------------------------------------------------------------

export const CHANNELS = ['IN_APP', 'PUSH', 'EMAIL', 'SMS', 'ZALO'] as const;
export type Channel = (typeof CHANNELS)[number];
/** The channels that interrupt a person: an item to be watched is never sent on them. */
export const INTERRUPTING: readonly Channel[] = ['PUSH', 'SMS', 'ZALO'];

export interface QuietHours {
  from: string;
  to: string;
  weekends: boolean;
  timeZone: string;
}

export interface ProfileInput {
  channels: Partial<Record<AlertSeverity, string[]>> | null;
  quiet: QuietHours | null;
  digestEnabled: boolean;
  digestAt: string | null;
  pushMinSeverity: 'URGENT' | 'ACTION' | null;
  pushCapPerDay: number | null;
  groupSameRoot: boolean | null;
}

export interface EffectiveProfile {
  channels: Record<AlertSeverity, string[]>;
  quiet: QuietHours;
  digestEnabled: boolean;
  digestAt: string;
  pushMinSeverity: string;
  pushCapPerDay: number;
  groupSameRoot: boolean;
  own: { channels: boolean; quiet: boolean; digestAt: boolean; pushMinSeverity: boolean; pushCapPerDay: boolean; groupSameRoot: boolean };
}

export interface ProfileView {
  profile: ProfileInput;
  effective: EffectiveProfile;
  ownQuiet: { from: string; to: string; timeZone: string } | null;
  rule: RuleInfo;
  version: number;
  asOf: string;
}

const toQuiet = (raw: unknown): QuietHours | null =>
  isRecord(raw) && text(raw.from) !== '' && text(raw.to) !== '' ? { from: text(raw.from), to: text(raw.to), weekends: raw.weekends === true, timeZone: text(raw.time_zone) } : null;

function toChannels(raw: unknown): Partial<Record<AlertSeverity, string[]>> | null {
  if (!isRecord(raw)) return null;
  const found: Partial<Record<AlertSeverity, string[]>> = {};
  for (const severity of SEVERITIES) if (Array.isArray(raw[severity])) found[severity] = strings(raw[severity]);
  return found;
}

export function toProfile(raw: unknown): ProfileView | undefined {
  if (!isRecord(raw) || !isRecord(raw.profile) || !isRecord(raw.effective)) return undefined;
  const rule = toRule(raw.rule);
  const quiet = toQuiet(raw.effective.quiet);
  if (rule === undefined || quiet === null) return undefined;
  const own = isRecord(raw.effective.own) ? raw.effective.own : {};
  const channels = isRecord(raw.effective.channels) ? raw.effective.channels : {};
  const profile = raw.profile;
  return {
    profile: {
      channels: toChannels(profile.channels),
      quiet: toQuiet(profile.quiet),
      digestEnabled: profile.digest_enabled !== false,
      digestAt: nullableText(profile.digest_at),
      pushMinSeverity: oneOf(profile.push_min_severity, ['URGENT', 'ACTION'] as const) ?? null,
      pushCapPerDay: num(profile.push_cap_per_day),
      groupSameRoot: typeof profile.group_same_root === 'boolean' ? profile.group_same_root : null,
    },
    effective: {
      channels: { URGENT: strings(channels.URGENT), ACTION: strings(channels.ACTION), WATCH: strings(channels.WATCH) },
      quiet,
      digestEnabled: raw.effective.digest_enabled !== false,
      digestAt: text(raw.effective.digest_at),
      pushMinSeverity: text(raw.effective.push_min_severity),
      pushCapPerDay: whole(raw.effective.push_cap_per_day),
      groupSameRoot: raw.effective.group_same_root === true,
      own: { channels: own.channels === true, quiet: own.quiet === true, digestAt: own.digest_at === true, pushMinSeverity: own.push_min_severity === true, pushCapPerDay: own.push_cap_per_day === true, groupSameRoot: own.group_same_root === true },
    },
    ownQuiet: isRecord(raw.own_quiet) && text(raw.own_quiet.from) !== '' ? { from: text(raw.own_quiet.from), to: text(raw.own_quiet.to), timeZone: text(raw.own_quiet.time_zone) } : null,
    rule,
    version: whole(raw.version),
    asOf: text(raw.as_of),
  };
}

/** The body of the command: whatever the person left on the policy goes as null. */
export function profileBody(input: ProfileInput): Record<string, unknown> {
  return {
    channels: input.channels,
    quiet: input.quiet === null ? null : { from: input.quiet.from, to: input.quiet.to, weekends: input.quiet.weekends, time_zone: input.quiet.timeZone },
    digest_enabled: input.digestEnabled,
    digest_at: input.digestAt,
    push_min_severity: input.pushMinSeverity,
    push_cap_per_day: input.pushCapPerDay,
    group_same_root: input.groupSameRoot,
  };
}

export interface DigestLine {
  source: string;
  id: string;
  title: string;
  subtitle: string | null;
  severity: AlertSeverity;
  dueOn: string | null;
  consequence: string | null;
  action: { screen: string; id: string };
  onBehalfOf: string | null;
}

export const DIGEST_SECTIONS = ['OVERDUE', 'DUE_SOON', 'NEW', 'ON_BEHALF'] as const;

export interface Digest {
  sections: Array<{ code: (typeof DIGEST_SECTIONS)[number]; count: number; lines: DigestLine[] }>;
  total: number;
  omitted: number;
  digestAt: string;
  lastDigestAt: string | null;
  unavailableSources: string[];
  asOf: string;
}

function toLine(raw: unknown): DigestLine[] {
  if (!isRecord(raw) || text(raw.id) === '' || text(raw.title) === '') return [];
  const action = isRecord(raw.action) ? { screen: text(raw.action.screen), id: text(raw.action.id) } : { screen: '', id: '' };
  return [{ source: text(raw.source), id: text(raw.id), title: text(raw.title), subtitle: nullableText(raw.subtitle), severity: oneOf(raw.severity, SEVERITIES) ?? 'ACTION', dueOn: nullableText(raw.due_on), consequence: nullableText(raw.consequence), action, onBehalfOf: nullableText(raw.on_behalf_of) }];
}

export function toDigest(raw: unknown): Digest | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.sections)) return undefined;
  return {
    sections: raw.sections.flatMap((section): Digest['sections'] => {
      const code = isRecord(section) ? oneOf(section.code, DIGEST_SECTIONS) : undefined;
      return code === undefined || !isRecord(section) ? [] : [{ code, count: whole(section.count), lines: list(section.lines).flatMap(toLine) }];
    }),
    total: whole(raw.total),
    omitted: whole(raw.omitted),
    digestAt: text(raw.digest_at),
    lastDigestAt: nullableText(raw.last_digest_at),
    unavailableSources: strings(raw.unavailable_sources),
    asOf: text(raw.as_of),
  };
}

/** The defects a refusal of the profile (422 ALERT_PROFILE_INVALID) names: the field and the code of each. */
export function defectsOf(extensions: Record<string, unknown>): Array<{ field: string; code: string }> {
  return list(extensions.defects).flatMap((entry) => (isRecord(entry) && text(entry.field) !== '' ? [{ field: text(entry.field), code: text(entry.code) }] : []));
}

// -- ADM-25: absences, covers, coverage ---------------------------------------------------------------------------------------------------------------------------------------------

export const ABSENCE_KINDS = ['LEAVE', 'SICK', 'MISSION', 'TRAINING', 'OTHER'] as const;
export const COVER_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
export const COVERAGE_STATES = ['COVERED', 'PARTIAL', 'UNCOVERED', 'NOT_APPLICABLE'] as const;

export interface CoverRow {
  id: string;
  absenceId: string;
  absent: Person | null;
  deputy: Person | null;
  validFrom: string;
  validUntil: string;
  scopeKind: 'ALL' | 'SOURCES';
  sources: string[];
  status: (typeof COVER_STATUSES)[number];
  inForce: boolean;
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
  revokeReason: string | null;
  version: number;
}

export interface AbsenceRow {
  id: string;
  membershipId: string;
  name: string | null;
  kind: string;
  validFrom: string;
  validUntil: string;
  effectiveUntil: string;
  reason: string | null;
  status: 'DECLARED' | 'ENDED' | 'CANCELLED';
  phase: 'SCHEDULED' | 'ACTIVE' | 'OVER';
  coverage: (typeof COVERAGE_STATES)[number];
  covers: CoverRow[];
  version: number;
}

export interface AbsencePage {
  items: AbsenceRow[];
  pendingCovers: CoverRow[];
  rule: RuleInfo;
  asOf: string;
}

export function toCover(raw: unknown): CoverRow[] {
  if (!isRecord(raw) || text(raw.id) === '') return [];
  const status = oneOf(raw.status, COVER_STATUSES);
  if (status === undefined) return [];
  return [
    {
      id: text(raw.id),
      absenceId: text(raw.absence_id),
      absent: person(raw.absent),
      deputy: person(raw.deputy),
      validFrom: text(raw.valid_from),
      validUntil: text(raw.valid_until),
      scopeKind: raw.scope_kind === 'SOURCES' ? 'SOURCES' : 'ALL',
      sources: strings(raw.sources),
      status,
      inForce: raw.in_force === true,
      requestedBy: text(raw.requested_by),
      decidedBy: nullableText(raw.decided_by),
      decisionNote: nullableText(raw.decision_note),
      revokeReason: nullableText(raw.revoke_reason),
      version: whole(raw.version),
    },
  ];
}

function toAbsence(raw: unknown): AbsenceRow[] {
  if (!isRecord(raw) || text(raw.id) === '') return [];
  const status = oneOf(raw.status, ['DECLARED', 'ENDED', 'CANCELLED'] as const);
  const phase = oneOf(raw.phase, ['SCHEDULED', 'ACTIVE', 'OVER'] as const);
  if (status === undefined || phase === undefined) return [];
  return [
    {
      id: text(raw.id),
      membershipId: text(raw.membership_id),
      name: nullableText(raw.name),
      kind: text(raw.kind),
      validFrom: text(raw.valid_from),
      validUntil: text(raw.valid_until),
      effectiveUntil: text(raw.effective_until) || text(raw.valid_until),
      reason: nullableText(raw.reason),
      status,
      phase,
      coverage: oneOf(raw.coverage, COVERAGE_STATES) ?? 'NOT_APPLICABLE',
      covers: list(raw.covers).flatMap(toCover),
      version: whole(raw.version),
    },
  ];
}

export function toAbsences(raw: unknown): AbsencePage | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  const rule = toRule(raw.rule);
  if (rule === undefined) return undefined;
  return { items: raw.items.flatMap(toAbsence), pendingCovers: list(raw.pending_covers).flatMap(toCover), rule, asOf: text(raw.as_of) };
}

export interface GapRow {
  id: string;
  kind: string;
  membershipId: string | null;
  name: string | null;
  unitId: string | null;
  absenceId: string | null;
  itemCount: number;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
}

export interface CoverageReport {
  positions: PositionRow[];
  summary: { backedUp: number; total: number; percent: number | null };
  gaps: GapRow[];
  rule: RuleInfo;
  asOf: string;
}

export function toCoverage(raw: unknown): CoverageReport | undefined {
  if (!isRecord(raw) || !isRecord(raw.summary) || !Array.isArray(raw.gaps)) return undefined;
  const rule = toRule(raw.rule);
  if (rule === undefined) return undefined;
  return {
    positions: list(raw.positions).flatMap(toPosition),
    summary: { backedUp: whole(raw.summary.backed_up), total: whole(raw.summary.total), percent: num(raw.summary.percent) },
    gaps: raw.gaps.flatMap((gap): GapRow[] =>
      isRecord(gap) && text(gap.id) !== ''
        ? [{ id: text(gap.id), kind: text(gap.kind), membershipId: nullableText(gap.membership_id), name: nullableText(gap.name), unitId: nullableText(gap.unit_id), absenceId: nullableText(gap.absence_id), itemCount: whole(gap.item_count), openedAt: text(gap.opened_at), closedAt: nullableText(gap.closed_at), closeReason: nullableText(gap.close_reason) }]
        : [],
    ),
    rule,
    asOf: text(raw.as_of),
  };
}

/** The sources a cover can name (the sources of the alert centre that a person can own work in). */
export const COVER_SOURCES = ['APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE', 'MONEY_CONTROL', 'DIRECTIVE', 'CLOCK', 'PROCUREMENT_WORKFLOW'] as const;

/** A moment typed in a `datetime-local` field (Vietnam time) as an ISO instant; empty or not valid gives undefined. */
export function momentOf(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}:00+07:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A moment as a `datetime-local` value in Vietnam time. */
export function momentField(iso: string): string {
  const date = new Date(new Date(iso).getTime() + 7 * 3_600_000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16);
}
