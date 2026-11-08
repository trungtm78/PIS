import { ApiError } from '@machvon/api-client';
import type { Severity, Tone } from '../../ui';

/**
 * The model shared by the five screens of the feed of the Finance Department (FEED-01 to FEED-05): the shapes the server answers (read leniently, a wrong shape is an error of the read, never an empty screen),
 * the words of time and amounts, the refusals of a command and the checks that a form passes before it sends. Pure functions only, so that every rule is tested without a screen.
 */

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const count = (value: unknown): number => whole(value) ?? 0;
const nullableNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string');

export const CONNECTOR_CODE = 'fin.sotaichinh';
export const LAYOUT_VERSION = 'WORKING-ASSUMPTION-FIN-2026.1';
export const CHANNELS = ['FILE', 'API_PUSH', 'GENERATOR'] as const;
export type Channel = (typeof CHANNELS)[number];
export const KINDS = ['PROJECT', 'PLAN', 'DISBURSEMENT', 'MILESTONE'] as const;
export type Kind = (typeof KINDS)[number];
export const channelOf = (value: unknown): Channel | undefined => CHANNELS.find((channel) => channel === value);
export const kindOf = (value: unknown): Kind | undefined => KINDS.find((kind) => kind === value);

export const PATHS = { connection: '/feed/feed-01', runs: '/feed/feed-02', mapping: '/feed/feed-03', differences: '/feed/feed-04', generator: '/feed/feed-05' } as const;
export const PAGE_SIZE = 20;
export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const MAX_CODE = 100;
export const MAX_EVIDENCE = 200;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PREVIEW_ROW_LIMIT = 500;
export const WAIVER_MAX_DAYS = 365;
export const FISCAL_YEAR_RANGE = [2000, 2100] as const;

// ---- the connection (FEED-01) -----------------------------------------------------------------------------------------------------------------------------------------

export type Acceptance = 'PENDING_EXTERNAL' | 'ACCEPTABLE';
export const acceptanceOf = (value: unknown): Acceptance => (value === 'ACCEPTABLE' ? 'ACCEPTABLE' : 'PENDING_EXTERNAL');

export type HealthStatus = 'NEVER_RECEIVED' | 'FRESH' | 'AGING' | 'STALE';
const HEALTH_STATUSES: readonly HealthStatus[] = ['NEVER_RECEIVED', 'FRESH', 'AGING', 'STALE'];

/** The definition behind a computed figure: where it came from, which version, the formula in words, the text of the source and the day it is as of. */
export interface Provenance {
  source: string;
  version: number;
  unverified: boolean;
  legalStatus: string | null;
  formula: string | null;
  sourceText: string | null;
  asOf: string | null;
}

export interface FreshnessRule extends Provenance {
  warnAfterHours: number;
  maxAgeHours: number;
  staleSeverity: string | null;
  figuresBlockedWhenStale: boolean;
}

export interface Policy extends Provenance {
  tolerancePct: number | null;
  largeDiscrepancyPct: number | null;
  reportDueDays: number | null;
  differenceDueDays: number | null;
}

export interface Health {
  status: HealthStatus;
  ageHours: number | null;
  lastRunAt: string | null;
  lastRunChannel: Channel | null;
  alert: { code: string; severity: string } | null;
  figuresBlocked: boolean;
  rule: FreshnessRule;
  policy: Policy;
}

export interface ChannelInfo {
  channel: Channel;
  adapterStatus: string;
  opensNetwork: boolean;
  reason: string | null;
}

export interface PendingItem {
  code: string;
  what: string;
  owner: string;
  workingAssumption: string;
  switchesWhenItArrives: string;
}

export interface Position {
  kind: string;
  connectorCode: string;
  cursorStatus: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastFileSha256: string | null;
}

export interface LayoutColumn {
  name: string;
  kind: string;
  required: boolean;
  values: string[];
}

export interface Layout {
  kind: Kind;
  connectorCode: string;
  columns: LayoutColumn[];
}

export interface Indicator {
  code: string;
  pct: string | null;
  numerator: number;
  denominator: number;
  asOf: string | null;
}

export interface UnitReport {
  investorCode: string;
  investorName: string | null;
  status: string;
  reportedOn: string | null;
  dueOn: string | null;
  projects: number;
}

export interface Finding {
  code: string;
  channel: Channel | null;
  feedProjectCode: string;
  fundCode: string | null;
  month: number | null;
  expected: string | null;
  actual: string | null;
  message: string;
}

export interface Quality {
  fiscalYear: number;
  month: number;
  dueOn: string | null;
  indicators: Indicator[];
  units: UnitReport[];
  lateUnits: UnitReport[];
  findings: Finding[];
  findingsTotal: number;
  asOf: string | null;
}

export interface Alert {
  code: string;
  severity: string;
  subject: string;
}

export interface HistoryEntry {
  id: string;
  action: string;
  reason: string | null;
  actorName: string | null;
  version: number;
  occurredAt: string;
}

export interface GeneratorParams {
  seed: number | null;
  fiscalYear: number | null;
  currentMonth: number | null;
  projectCount: number | null;
  lateUnits: number | null;
  delayedPct: number | null;
  aheadPct: number | null;
  discrepancies: number | null;
  anchorCount: number;
}

export interface GeneratorState {
  state: 'STOPPED' | 'RUNNING';
  epoch: number;
  parameters: GeneratorParams | null;
}

export interface Actions {
  setState: boolean;
  controlGenerator: boolean;
  preview: boolean;
  apply: boolean;
  proposeMapping: boolean;
  decideMapping: boolean;
  reconcile: boolean;
  resolve: boolean;
}

export interface Counts {
  total: number;
  written: number;
  skipped: number;
  rejected: number;
}

/** One run of the feed: a file that was applied, or one move of the data generator. The channel is the provenance of its records, nothing else. */
export interface Run {
  id: string;
  channel: Channel;
  kind: Kind | null;
  action: string;
  layoutVersion: string;
  acceptance: Acceptance;
  fileSha256: string | null;
  seed: number | null;
  epoch: number | null;
  counts: Counts;
  asOfLatest: string | null;
  digest: string | null;
  importedByName: string | null;
  createdAt: string;
}

export interface Connection {
  connectorCode: string;
  registered: boolean;
  enabled: boolean;
  stateReason: string | null;
  stateChangedAt: string | null;
  stateChangedByName: string | null;
  layoutVersion: string;
  supportedLayouts: string[];
  acceptance: Acceptance;
  version: number;
  channels: ChannelInfo[];
  health: Health;
  pendingExternal: PendingItem[];
  positions: Position[];
  layouts: Layout[];
  generator: GeneratorState;
  lastRuns: Run[];
  recordCounts: Record<string, number>;
  mappingCounts: Record<string, number>;
  differenceCounts: { open: number; openLarge: number; resolved: number };
  quality: Quality;
  alerts: Alert[];
  history: HistoryEntry[];
  actions: Actions;
  asOf: string;
}

function toProvenance(raw: Raw | undefined): Provenance {
  return {
    source: text(raw?.source) ?? '',
    version: count(raw?.version),
    unverified: raw?.unverified === true,
    legalStatus: nullableText(raw?.legal_status),
    formula: nullableText(raw?.formula),
    sourceText: nullableText(raw?.source_text),
    asOf: nullableText(raw?.as_of),
  };
}

function toHealth(raw: unknown): Health | undefined {
  const body = asRecord(raw);
  const rule = asRecord(body?.rule);
  const status = HEALTH_STATUSES.find((one) => one === body?.status);
  if (body === undefined || rule === undefined || status === undefined) return undefined;
  const policy = asRecord(body.policy);
  const alert = asRecord(body.alert);
  return {
    status,
    ageHours: nullableNumber(body.age_hours),
    lastRunAt: nullableText(body.last_run_at),
    lastRunChannel: channelOf(body.last_run_channel) ?? null,
    alert: alert === undefined ? null : { code: text(alert.code) ?? '', severity: text(alert.severity) ?? '' },
    figuresBlocked: body.figures_blocked === true,
    rule: { ...toProvenance(rule), warnAfterHours: nullableNumber(rule.warn_after_hours) ?? 0, maxAgeHours: nullableNumber(rule.max_age_hours) ?? 0, staleSeverity: nullableText(rule.stale_severity), figuresBlockedWhenStale: rule.figures_blocked_when_stale === true },
    policy: {
      ...toProvenance(policy),
      tolerancePct: nullableNumber(policy?.tolerance_pct),
      largeDiscrepancyPct: nullableNumber(policy?.large_discrepancy_pct),
      reportDueDays: nullableNumber(policy?.report_due_days),
      differenceDueDays: nullableNumber(policy?.difference_due_days),
    },
  };
}

const toCounts = (value: unknown): Counts => {
  const counts = asRecord(value);
  return { total: count(counts?.total), written: count(counts?.written), skipped: count(counts?.skipped), rejected: count(counts?.rejected) };
};

export function toRun(raw: unknown): Run | undefined {
  const run = asRecord(raw);
  const id = text(run?.id);
  const channel = channelOf(run?.channel);
  if (run === undefined || id === undefined || channel === undefined) return undefined;
  return {
    id,
    channel,
    kind: kindOf(run.kind) ?? null,
    action: text(run.action) ?? '',
    layoutVersion: text(run.layout_version) ?? '',
    acceptance: acceptanceOf(run.acceptance),
    fileSha256: nullableText(run.file_sha256),
    seed: nullableNumber(run.seed),
    epoch: nullableNumber(run.epoch),
    counts: toCounts(run.counts),
    asOfLatest: nullableText(run.as_of_latest),
    digest: nullableText(run.digest),
    importedByName: nullableText(run.imported_by_name),
    createdAt: text(run.created_at) ?? '',
  };
}

const toUnit = (raw: unknown): UnitReport[] => {
  const unit = asRecord(raw);
  const code = text(unit?.investor_code);
  if (unit === undefined || code === undefined) return [];
  return [{ investorCode: code, investorName: nullableText(unit.investor_name), status: text(unit.status) ?? '', reportedOn: nullableText(unit.reported_on), dueOn: nullableText(unit.due_on), projects: count(unit.projects) }];
};

const toFinding = (raw: unknown): Finding[] => {
  const one = asRecord(raw);
  const code = text(one?.code);
  if (one === undefined || code === undefined) return [];
  return [
    {
      code,
      channel: channelOf(one.channel) ?? null,
      feedProjectCode: text(one.feed_project_code) ?? '',
      fundCode: nullableText(one.fund_code),
      month: nullableNumber(one.month),
      expected: nullableText(one.expected),
      actual: nullableText(one.actual),
      message: text(one.message) ?? '',
    },
  ];
};

export function toQuality(raw: unknown): Quality | undefined {
  const body = asRecord(raw);
  const year = whole(body?.fiscal_year);
  const month = whole(body?.month);
  if (body === undefined || year === undefined || month === undefined || !Array.isArray(body.indicators)) return undefined;
  const indicators = list(body.indicators).flatMap((item): Indicator[] => {
    const one = asRecord(item);
    const code = text(one?.code);
    return one === undefined || code === undefined ? [] : [{ code, pct: nullableText(one.pct), numerator: count(one.numerator), denominator: count(one.denominator), asOf: nullableText(one.as_of) }];
  });
  const findings = list(body.findings).flatMap(toFinding);
  return {
    fiscalYear: year,
    month,
    dueOn: nullableText(body.due_on),
    indicators,
    units: list(body.units).flatMap(toUnit),
    lateUnits: list(body.late_units).flatMap(toUnit),
    findings,
    findingsTotal: whole(body.findings_total) ?? findings.length,
    asOf: nullableText(body.as_of),
  };
}

const toGeneratorParams = (raw: unknown): GeneratorParams | null => {
  const body = asRecord(raw);
  if (body === undefined) return null;
  return {
    seed: nullableNumber(body.seed),
    fiscalYear: nullableNumber(body.fiscal_year),
    currentMonth: nullableNumber(body.current_month),
    projectCount: nullableNumber(body.project_count),
    lateUnits: nullableNumber(body.late_units),
    delayedPct: nullableNumber(body.delayed_pct),
    aheadPct: nullableNumber(body.ahead_pct),
    discrepancies: nullableNumber(body.discrepancies),
    anchorCount: count(body.anchor_count),
  };
};

const toNumbers = (value: unknown): Record<string, number> => Object.fromEntries(Object.entries(asRecord(value) ?? {}).flatMap(([key, one]): Array<[string, number]> => (typeof one === 'number' ? [[key, one]] : [])));

const REQUIRED_ARRAYS = ['channels', 'supported_layouts', 'pending_external', 'positions', 'layouts', 'last_runs', 'alerts', 'history'] as const;
const REQUIRED_OBJECTS = ['health', 'actions', 'record_counts', 'mapping_counts', 'difference_counts', 'quality', 'generator'] as const;

/** The answer of the connection: the shape is checked, and a wrong shape throws (the screen shows an error, never an empty page). */
export function toConnection(raw: unknown): Connection {
  const body = asRecord(raw);
  if (body === undefined || REQUIRED_ARRAYS.some((key) => !Array.isArray(body[key])) || REQUIRED_OBJECTS.some((key) => asRecord(body[key]) === undefined)) throw new Error('unexpected connection');
  const health = toHealth(body.health);
  const quality = toQuality(body.quality);
  if (health === undefined || quality === undefined) throw new Error('unexpected connection');
  const actions = asRecord(body.actions) ?? {};
  const generator = asRecord(body.generator) ?? {};
  const differences = asRecord(body.difference_counts) ?? {};
  return {
    connectorCode: text(body.connector_code) ?? CONNECTOR_CODE,
    registered: body.registered === true,
    enabled: body.enabled === true,
    stateReason: nullableText(body.state_reason),
    stateChangedAt: nullableText(body.state_changed_at),
    stateChangedByName: nullableText(body.state_changed_by_name),
    layoutVersion: text(body.layout_version) ?? LAYOUT_VERSION,
    supportedLayouts: strings(body.supported_layouts),
    acceptance: acceptanceOf(body.acceptance),
    version: count(body.version),
    channels: list(body.channels).flatMap((item): ChannelInfo[] => {
      const one = asRecord(item);
      const channel = channelOf(one?.channel);
      return one === undefined || channel === undefined ? [] : [{ channel, adapterStatus: text(one.adapter_status) ?? '', opensNetwork: one.opens_network === true, reason: nullableText(one.reason) }];
    }),
    health,
    pendingExternal: list(body.pending_external).flatMap((item): PendingItem[] => {
      const one = asRecord(item);
      const code = text(one?.code);
      return one === undefined || code === undefined
        ? []
        : [{ code, what: text(one.what) ?? '', owner: text(one.owner) ?? '', workingAssumption: text(one.working_assumption) ?? '', switchesWhenItArrives: text(one.switches_when_it_arrives) ?? '' }];
    }),
    positions: list(body.positions).flatMap((item): Position[] => {
      const one = asRecord(item);
      const kind = text(one?.kind);
      return one === undefined || kind === undefined
        ? []
        : [{ kind, connectorCode: text(one.connector_code) ?? '', cursorStatus: nullableText(one.cursor_status), lastSuccessAt: nullableText(one.last_success_at), lastErrorCode: nullableText(one.last_error_code), lastFileSha256: nullableText(one.last_file_sha256) }];
    }),
    layouts: list(body.layouts).flatMap((item): Layout[] => {
      const one = asRecord(item);
      const kind = kindOf(one?.kind);
      if (one === undefined || kind === undefined) return [];
      const columns = list(one.columns).flatMap((column): LayoutColumn[] => {
        const entry = asRecord(column);
        const name = text(entry?.name);
        return entry === undefined || name === undefined ? [] : [{ name, kind: text(entry.kind) ?? '', required: entry.required === true, values: strings(entry.values) }];
      });
      return [{ kind, connectorCode: text(one.connector_code) ?? '', columns }];
    }),
    generator: { state: generator.state === 'RUNNING' ? 'RUNNING' : 'STOPPED', epoch: count(generator.epoch), parameters: toGeneratorParams(generator.parameters) },
    lastRuns: list(body.last_runs).flatMap((item) => toRun(item) ?? []),
    recordCounts: toNumbers(body.record_counts),
    mappingCounts: toNumbers(body.mapping_counts),
    differenceCounts: { open: count(differences.open), openLarge: count(differences.open_large), resolved: count(differences.resolved) },
    quality,
    alerts: list(body.alerts).flatMap((item): Alert[] => {
      const one = asRecord(item);
      const code = text(one?.code);
      return one === undefined || code === undefined ? [] : [{ code, severity: text(one.severity) ?? '', subject: text(one.subject) ?? '' }];
    }),
    history: list(body.history).flatMap((item): HistoryEntry[] => {
      const one = asRecord(item);
      const id = text(one?.id);
      return one === undefined || id === undefined ? [] : [{ id, action: text(one.action) ?? '', reason: nullableText(one.reason), actorName: nullableText(one.actor_name), version: count(one.version), occurredAt: text(one.occurred_at) ?? '' }];
    }),
    actions: {
      setState: actions.set_state === true,
      controlGenerator: actions.control_generator === true,
      preview: actions.preview === true,
      apply: actions.apply === true,
      proposeMapping: actions.propose_mapping === true,
      decideMapping: actions.decide_mapping === true,
      reconcile: actions.reconcile === true,
      resolve: actions.resolve === true,
    },
    asOf: text(body.as_of) ?? '',
  };
}

// ---- time, numbers and amounts ----------------------------------------------------------------------------------------------------------------------------------------

const VIETNAM_OFFSET_MS = 7 * 3_600_000;

/** An instant as the people of the screen read it: the Vietnam day and minute ("08/11/2026 14:05"). An unreadable value is shown as it came. */
export function vietnamStamp(instant: string | null | undefined): string {
  if (instant === null || instant === undefined) return '';
  const moment = Date.parse(instant);
  if (Number.isNaN(moment)) return instant;
  const stamp = new Date(moment + VIETNAM_OFFSET_MS).toISOString();
  return `${stamp.slice(8, 10)}/${stamp.slice(5, 7)}/${stamp.slice(0, 4)} ${stamp.slice(11, 16)}`;
}

/** A day (`YYYY-MM-DD`) or an instant as a day. */
export function dayText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
  return vietnamStamp(value).slice(0, 10);
}

/** A count or an age with the digits of the locale; one decimal at most. */
export const numberText = (value: number, locale: string): string => value.toLocaleString(locale, { maximumFractionDigits: 1 });

/** A decimal string of the server ("12345.6") with the grouping of the locale; an amount is never turned into a float. */
export function amountText(value: string | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '';
  const parts = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (parts === null) return value;
  const vietnamese = locale.startsWith('vi');
  const whole = (parts[2] ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, vietnamese ? '.' : ',');
  return `${parts[1] ?? ''}${whole}${parts[3] === undefined ? '' : `${vietnamese ? ',' : '.'}${parts[3]}`}`;
}

/** A percent the server wrote as text ("87.50") with the digits of the locale and the sign; null means "not computable", never zero. */
export function percentText(value: string | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return `${number.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
}

/** The first twelve characters of a file hash: enough to tell two files apart on a list. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

/** A size in the unit a person reads: kilobytes below a megabyte, else megabytes with one decimal. */
export function sizeText(bytes: number, locale: string): { value: string; unit: 'KB' | 'MB' } {
  if (bytes < 1024 * 1024) return { value: Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale), unit: 'KB' };
  return { value: (Math.round((bytes / (1024 * 1024)) * 10) / 10).toLocaleString(locale, { maximumFractionDigits: 1 }), unit: 'MB' };
}

export const tooLarge = (file: { size: number }): boolean => file.size > MAX_FILE_BYTES;

/** Today in Vietnam as `YYYY-MM-DD`. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

/** The day after `day` plus `days` (calendar days), as `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---- health and indicators --------------------------------------------------------------------------------------------------------------------------------------------

const HEALTH_TONE: Readonly<Record<HealthStatus, Tone>> = { FRESH: 'success', AGING: 'info', STALE: 'warning', NEVER_RECEIVED: 'neutral' };
const HEALTH_ICON: Readonly<Record<HealthStatus, string>> = { FRESH: '✓', AGING: '◔', STALE: '⚠', NEVER_RECEIVED: '○' };
export const healthTone = (status: HealthStatus): Tone => HEALTH_TONE[status];
export const healthIcon = (status: HealthStatus): string => HEALTH_ICON[status];

/** The severity of an alert as the kit knows it; a word the kit does not know is not drawn as a level. */
export function severityOf(value: string | null | undefined): Severity | null {
  return value === 'URGENT' || value === 'ACTION' || value === 'WATCH' ? value : null;
}

/** A definition nobody confirmed: the server flags it, and the legal status says so too. */
export const isUnverified = (provenance: Provenance): boolean => provenance.unverified || provenance.legalStatus === 'UNVERIFIED';

export const isFirstUse = (connection: Connection): boolean => !connection.registered;

/** The three indicators in the order of the screen; one the server did not send is not invented. */
export const INDICATOR_CODES = ['FEED_COMPLETENESS', 'FEED_TIMELINESS', 'FEED_DISCREPANCY_RATE'] as const;
export type IndicatorCode = (typeof INDICATOR_CODES)[number];
export const indicatorOf = (quality: Quality, code: IndicatorCode): Indicator | undefined => quality.indicators.find((one) => one.code === code);

/** The tone of an indicator: not computable is neutral, a rate the rule wants low (the discrepancy) is judged the other way round. */
export function indicatorTone(code: IndicatorCode, indicator: Indicator | undefined): Tone {
  if (indicator === undefined || indicator.pct === null) return 'neutral';
  const pct = Number(indicator.pct);
  if (!Number.isFinite(pct)) return 'neutral';
  if (code === 'FEED_DISCREPANCY_RATE') return pct === 0 ? 'success' : pct <= 5 ? 'info' : 'warning';
  return pct >= 100 ? 'success' : pct >= 80 ? 'info' : 'warning';
}

/** The records the register holds from the feed, the four kinds first and in their order, then any kind the server adds. */
export function recordRows(counts: Readonly<Record<string, number>>): Array<{ kind: string; count: number }> {
  const known = KINDS.map((kind) => ({ kind: kind as string, count: counts[kind] ?? 0 }));
  const extra = Object.keys(counts)
    .filter((kind) => !(KINDS as readonly string[]).includes(kind))
    .sort()
    .map((kind) => ({ kind, count: counts[kind] ?? 0 }));
  return [...known, ...extra];
}

export const total = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((sum, one) => sum + one, 0);

export type SwitchBlock = 'MODE' | 'RIGHT' | null;
/** Why a command is not offered: the workspace is read-only, or the server did not give the caller the command. */
export function commandBlock(allowed: boolean, mode: 'FULL' | 'READ_ONLY' | undefined): SwitchBlock {
  if (mode === 'READ_ONLY') return 'MODE';
  return allowed ? null : 'RIGHT';
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------------------------------------

export type ProblemKind =
  | 'alreadyApplied'
  | 'connectionDisabled'
  | 'hasErrors'
  | 'hashMismatch'
  | 'schemaInvalid'
  | 'empty'
  | 'layoutUnknown'
  | 'fileRefused'
  | 'tooLarge'
  | 'scanPending'
  | 'validation'
  | 'notFound'
  | 'scopeDenied'
  | 'selfApproval'
  | 'versionConflict'
  | 'mappingState'
  | 'differenceState'
  | 'generatorState'
  | 'duplicate'
  | 'apiUnavailable'
  | 'forbidden'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ProblemKind>> = {
  IMPORT_FILE_ALREADY_APPLIED: 'alreadyApplied',
  FEED_CONNECTION_DISABLED: 'connectionDisabled',
  IMPORT_HAS_ERRORS: 'hasErrors',
  HASH_MISMATCH: 'hashMismatch',
  IMPORT_SCHEMA_INVALID: 'schemaInvalid',
  IMPORT_EMPTY: 'empty',
  FEED_LAYOUT_VERSION_UNKNOWN: 'layoutUnknown',
  FILE_TYPE_NOT_ALLOWED: 'fileRefused',
  FILE_NOT_CLEAN: 'fileRefused',
  PAYLOAD_TOO_LARGE: 'tooLarge',
  SCAN_PENDING: 'scanPending',
  VALIDATION_FAILED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'scopeDenied',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  FEED_MAPPING_STATE_INVALID: 'mappingState',
  FEED_DIFFERENCE_STATE_INVALID: 'differenceState',
  FEED_GENERATOR_STATE_INVALID: 'generatorState',
  CROSSWALK_DUPLICATE: 'duplicate',
  FEED_API_UNAVAILABLE: 'apiUnavailable',
};

export interface Problem {
  kind: ProblemKind;
  /** The field a validation names (`reason`, `evidence_ref`, `review_on`, `seed` ...). */
  field: string | undefined;
  /** The machine code of the answer, for a word the screen has no sentence for. */
  code: string;
  /** What the server said more (the part of the state a generator refusal names, the detail of a conflict). */
  detail: string | undefined;
  /** IMPORT_SCHEMA_INVALID: the required columns the file does not have. */
  missingColumns: string[];
  /** FEED_LAYOUT_VERSION_UNKNOWN: the version asked for and the ones the module reads. */
  layoutVersion: string;
  supported: string[];
}

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return { kind: 'general', field: undefined, code: '', detail: undefined, missingColumns: [], layoutVersion: '', supported: [] };
  const known = PROBLEM_BY_CODE[error.code];
  const kind: ProblemKind = known ?? (error.status === 403 ? 'forbidden' : 'general');
  return {
    kind,
    field: kind === 'validation' ? error.detail : undefined,
    code: error.code,
    detail: error.detail,
    missingColumns: strings(error.extensions.missing_columns),
    layoutVersion: text(error.extensions.layout_version) ?? '',
    supported: strings(error.extensions.supported),
  };
}

/** Whether a failure is the refusal of the scope or the permission (a 403): the lists say "forbidden" instead of "error". */
export const isForbidden = (error: unknown): boolean => error instanceof ApiError && error.status === 403;

/** Whether the answer is information the person can act on (the file was loaded before), not a failure of the system. */
export const isInformation = (problem: Problem): boolean => problem.kind === 'alreadyApplied';

export const failureCode = (error: unknown): string | undefined => (error instanceof ApiError ? error.code : undefined);

// ---- the reason of a command ------------------------------------------------------------------------------------------------------------------------------------------

export type ReasonProblem = 'EMPTY' | 'SHORT' | 'LONG';

/** The reason of a command, trimmed: null when it is acceptable, else why not. */
export function reasonProblem(reason: string, min: number = MIN_REASON): ReasonProblem | null {
  const body = reason.trim();
  if (body === '') return 'EMPTY';
  if (body.length < min) return 'SHORT';
  return body.length > MAX_REASON ? 'LONG' : null;
}

// ---- a file import (FEED-02) ------------------------------------------------------------------------------------------------------------------------------------------

export interface UploadedFile {
  fileObjectKey: string;
  fileSha256: string;
  sizeBytes: number;
  format: string;
  columns: string[];
  rowCount: number;
  matchingKinds: Kind[];
}

export function toUploadedFile(raw: unknown): UploadedFile | undefined {
  const body = asRecord(raw);
  const key = text(body?.file_object_key);
  const sha = text(body?.file_sha256);
  const rows = whole(body?.row_count);
  if (body === undefined || key === undefined || sha === undefined || rows === undefined) return undefined;
  return { fileObjectKey: key, fileSha256: sha, sizeBytes: count(body.size_bytes), format: (text(body.format) ?? '').toUpperCase(), columns: strings(body.columns), rowCount: rows, matchingKinds: list(body.matching_kinds).flatMap((item) => kindOf(item) ?? []) };
}

export type KindFit = 'fits' | 'other' | 'none';
/** Whether the file has the required columns of the chosen kind; the kinds it does fit are told, the choice is never changed for the person. */
export const kindFit = (uploaded: UploadedFile, kind: Kind): KindFit => (uploaded.matchingKinds.includes(kind) ? 'fits' : uploaded.matchingKinds.length === 0 ? 'none' : 'other');

export type RowStatus = 'VALID' | 'ERROR' | 'DUPLICATE' | 'CONFLICT';
export const ROW_STATUSES: readonly RowStatus[] = ['VALID', 'ERROR', 'DUPLICATE', 'CONFLICT'];
export type Outcome = 'RECORD' | 'RECORD_AND_PROPOSE' | 'RECORD_AND_DIFFERENCE';
const OUTCOMES: readonly string[] = ['RECORD', 'RECORD_AND_PROPOSE', 'RECORD_AND_DIFFERENCE'];

/** The reasons a row of a file can be refused or ignored, as the server writes them. */
export const ROW_CODES = [
  'FIELD_REQUIRED',
  'FIELD_TOO_LONG',
  'CHARACTER_INVALID',
  'ENUM_INVALID',
  'DAY_INVALID',
  'MONEY_INVALID',
  'MONTH_INVALID',
  'YEAR_INVALID',
  'YEARS_ORDER_INVALID',
  'TAX_CODE_INVALID',
  'MILESTONE_DATE_REQUIRED',
  'ROW_INVALID',
  'ROW_DUPLICATE',
  'ROW_CONFLICT',
] as const;

/** `FIELD_TOO_LONG` is `fieldTooLong`: the segment of the translation key. */
export const camelOf = (code: string): string => code.toLowerCase().replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
const ROW_CODE_KEYS: ReadonlySet<string> = new Set(ROW_CODES.map(camelOf));
/** The last segment of the translation key of a row code: the camel form of a known code, `other` for any other. */
export const rowCodeKey = (code: string | null): string => {
  if (code === null) return 'other';
  const key = camelOf(code);
  return ROW_CODE_KEYS.has(key) ? key : 'other';
};

export interface PreviewRow {
  line: number;
  businessKey: string | null;
  status: RowStatus;
  code: string | null;
  field: string | null;
  outcome: Outcome | null;
  preview: Record<string, string> | null;
}

const previewCells = (value: unknown): Record<string, string> | null => {
  const cells = asRecord(value);
  if (cells === undefined) return null;
  return Object.fromEntries(Object.entries(cells).flatMap(([key, cell]): Array<[string, string]> => (typeof cell === 'string' ? [[key, cell]] : typeof cell === 'number' ? [[key, String(cell)]] : [])));
};

function toPreviewRow(raw: unknown): PreviewRow[] {
  const row = asRecord(raw);
  const line = whole(row?.line);
  const status = ROW_STATUSES.find((value) => value === row?.status);
  if (row === undefined || line === undefined || status === undefined) return [];
  const outcome = OUTCOMES.includes(row.outcome as string) ? (row.outcome as Outcome) : null;
  return [{ line, businessKey: nullableText(row.business_key), status, code: nullableText(row.code), field: nullableText(row.field), outcome, preview: previewCells(row.preview) }];
}

/** The code a row stands under: what the server said, or the word of the verdict for a repeat or a clash. */
export const effectiveCode = (row: PreviewRow): string | null => row.code ?? (row.status === 'DUPLICATE' ? 'ROW_DUPLICATE' : row.status === 'CONFLICT' ? 'ROW_CONFLICT' : null);

export type StatusFilter = '' | RowStatus;
export const filterRows = (rows: readonly PreviewRow[], status: StatusFilter): PreviewRow[] => (status === '' ? [...rows] : rows.filter((row) => row.status === status));

export interface RowError {
  line: number;
  businessKey: string | null;
  code: string;
  field: string | null;
  preview: Record<string, string> | null;
}

function toRowError(raw: unknown): RowError[] {
  const row = asRecord(raw);
  const line = whole(row?.line);
  if (row === undefined || line === undefined) return [];
  return [{ line, businessKey: nullableText(row.business_key), code: text(row.code) ?? '', field: nullableText(row.field), preview: previewCells(row.preview) }];
}

/** A masked preview as "column: value" pieces for a cell; the server already left out names and addresses. */
export const previewPairs = (preview: Record<string, string> | null): Array<{ key: string; value: string }> => Object.entries(preview ?? {}).map(([key, value]) => ({ key, value }));

export interface PreviewCounts {
  total: number;
  valid: number;
  errors: number;
  duplicate: number;
  conflict: number;
}

export interface Preview {
  kind: Kind;
  layoutVersion: string;
  acceptance: Acceptance;
  fileSha256: string;
  alreadyApplied: boolean;
  connectionEnabled: boolean;
  counts: PreviewCounts;
  rows: PreviewRow[];
  rowsTruncated: boolean;
  /** When the answer came: the "as of" of the figures of the dry run. */
  ranAt: string;
}

export function toPreview(raw: unknown, ranAt: string): Preview | undefined {
  const body = asRecord(raw);
  const counts = asRecord(body?.counts);
  const kind = kindOf(body?.kind);
  const totalRows = whole(counts?.total);
  if (body === undefined || counts === undefined || kind === undefined || totalRows === undefined) return undefined;
  return {
    kind,
    layoutVersion: text(body.layout_version) ?? '',
    acceptance: acceptanceOf(body.acceptance),
    fileSha256: text(body.file_sha256) ?? '',
    alreadyApplied: body.already_applied === true,
    connectionEnabled: body.connection_enabled !== false,
    counts: { total: totalRows, valid: count(counts.valid), errors: count(counts.errors), duplicate: count(counts.duplicate), conflict: count(counts.conflict) },
    rows: list(body.rows).flatMap(toPreviewRow),
    rowsTruncated: body.rows_truncated === true,
    ranAt,
  };
}

export interface ApplyCounts {
  total: number;
  applied: number;
  duplicate: number;
  conflict: number;
  quarantined: number;
  differencesOpened: number;
}

const toApplyCounts = (value: unknown): ApplyCounts | undefined => {
  const counts = asRecord(value);
  const totalRows = whole(counts?.total);
  if (counts === undefined || totalRows === undefined) return undefined;
  return { total: totalRows, applied: count(counts.applied), duplicate: count(counts.duplicate), conflict: count(counts.conflict), quarantined: count(counts.quarantined), differencesOpened: count(counts.differences_opened) };
};

export interface Applied {
  runId: string | null;
  kind: Kind | null;
  layoutVersion: string;
  acceptance: Acceptance;
  fileSha256: string;
  counts: ApplyCounts;
  mappingsProposed: number;
  errors: RowError[];
  errorsTruncated: boolean;
  /** The apply was refused with IMPORT_HAS_ERRORS: nothing was taken, the errors say why. */
  refused: boolean;
}

export function toApplied(raw: unknown): Applied | undefined {
  const body = asRecord(raw);
  const counts = toApplyCounts(body?.counts);
  if (body === undefined || counts === undefined) return undefined;
  return {
    runId: nullableText(body.resource_id),
    kind: kindOf(body.kind) ?? null,
    layoutVersion: text(body.layout_version) ?? '',
    acceptance: acceptanceOf(body.acceptance),
    fileSha256: text(body.file_sha256) ?? '',
    counts,
    mappingsProposed: count(body.mappings_proposed),
    errors: list(body.errors).flatMap(toRowError),
    errorsTruncated: body.errors_truncated === true,
    refused: false,
  };
}

/** The refusal IMPORT_HAS_ERRORS: nothing could be taken; the answer carries the counts and the errors of the rows. */
export function refusedApply(error: unknown): Applied | undefined {
  if (!(error instanceof ApiError) || error.code !== 'IMPORT_HAS_ERRORS') return undefined;
  const applied = toApplied({ counts: error.extensions.counts, errors: error.extensions.errors, errors_truncated: error.extensions.errors_truncated });
  return applied === undefined ? undefined : { ...applied, refused: true };
}

export type ApplyBlock = 'noPreview' | 'noValid' | 'alreadyApplied' | 'connectionDisabled' | 'noAuthority' | 'done' | 'working';

export interface ApplyGateInput {
  preview: Preview | undefined;
  /** The dry run was made on the file that is now stored (the person did not change file or kind since). */
  previewIsCurrent: boolean;
  canApply: boolean;
  /** The connection is switched off. */
  connectionBlocked: boolean;
  applied: boolean;
  working: boolean;
}

/** "Apply" is open only after a dry run of that same file with a valid row, a file not loaded before, an enabled connection and the right to apply; otherwise the reason. */
export function applyGate(input: ApplyGateInput): ApplyBlock | null {
  if (input.applied) return 'done';
  if (input.working) return 'working';
  if (input.preview === undefined || !input.previewIsCurrent) return 'noPreview';
  if (input.preview.alreadyApplied) return 'alreadyApplied';
  if (input.connectionBlocked || !input.preview.connectionEnabled) return 'connectionDisabled';
  if (!input.canApply) return 'noAuthority';
  if (input.preview.counts.valid < 1) return 'noValid';
  return null;
}

export interface RunPage {
  items: Run[];
  nextCursor: string | null;
  asOf: string | null;
}

export function toRunPage(raw: unknown): RunPage {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.items)) throw new Error('unexpected runs');
  return { items: list(body.items).flatMap((item) => toRun(item) ?? []), nextCursor: nullableText(body.next_cursor), asOf: nullableText(body.as_of) };
}

export interface RunDetail {
  run: Run;
  errors: RowError[];
  errorsTruncated: boolean;
  asOf: string | null;
}

export function toRunDetail(raw: unknown): RunDetail {
  const body = asRecord(raw);
  const run = toRun(body?.run);
  if (body === undefined || run === undefined) throw new Error('unexpected run');
  return { run, errors: list(body.errors).flatMap(toRowError), errorsTruncated: body.errors_truncated === true, asOf: nullableText(body.as_of) };
}

export interface RunFilters {
  channel?: Channel;
  kind?: Kind;
}

/** The filters of the run list from the address: a value the screen does not know is dropped, never sent. */
export function runFiltersOf(search: URLSearchParams): RunFilters {
  const channel = channelOf(search.get('channel'));
  const kind = kindOf(search.get('kind'));
  return { ...(channel === undefined ? {} : { channel }), ...(kind === undefined ? {} : { kind }) };
}

export function runSearchOf(filters: RunFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.channel !== undefined) search.set('channel', filters.channel);
  if (filters.kind !== undefined) search.set('kind', filters.kind);
  return search;
}

export const runQueryOf = (filters: RunFilters, cursor: string | undefined): Record<string, string | number> => ({
  ...(filters.channel === undefined ? {} : { channel: filters.channel }),
  ...(filters.kind === undefined ? {} : { kind: filters.kind }),
  ...(cursor === undefined ? {} : { cursor }),
  limit: PAGE_SIZE,
});

// ---- the code mapping (FEED-03) ---------------------------------------------------------------------------------------------------------------------------------------

export const MAPPING_STATUSES = ['PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED'] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];
export const mappingStatusOf = (value: unknown): MappingStatus | undefined => MAPPING_STATUSES.find((status) => status === value);

export interface Mapping {
  id: string;
  ourCode: string;
  ourName: string | null;
  externalCode: string;
  matchMethod: string;
  validFrom: string | null;
  validUntil: string | null;
  status: MappingStatus;
  proposedBy: string | null;
  proposedByName: string | null;
  proposalReason: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  retiredByName: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  version: number;
  createdAt: string | null;
  canDecide: boolean;
  canRetire: boolean;
}

function toMapping(raw: unknown): Mapping[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const status = mappingStatusOf(row?.status);
  const external = text(row?.external_code);
  if (row === undefined || id === undefined || status === undefined || external === undefined) return [];
  return [
    {
      id,
      ourCode: text(row.our_code) ?? '',
      ourName: nullableText(row.our_name),
      externalCode: external,
      matchMethod: text(row.match_method) ?? '',
      validFrom: nullableText(row.valid_from),
      validUntil: nullableText(row.valid_until),
      status,
      proposedBy: nullableText(row.proposed_by),
      proposedByName: nullableText(row.proposed_by_name),
      proposalReason: nullableText(row.proposal_reason),
      approvedByName: nullableText(row.approved_by_name),
      approvedAt: nullableText(row.approved_at),
      decisionReason: nullableText(row.decision_reason),
      retiredByName: nullableText(row.retired_by_name),
      retiredAt: nullableText(row.retired_at),
      retireReason: nullableText(row.retire_reason),
      version: count(row.version),
      createdAt: nullableText(row.created_at),
      canDecide: row.can_decide === true,
      canRetire: row.can_retire === true,
    },
  ];
}

export interface MappingPage {
  items: Mapping[];
  nextCursor: string | null;
  counts: Record<MappingStatus, number>;
  asOf: string | null;
}

export function toMappingPage(raw: unknown): MappingPage {
  const body = asRecord(raw);
  const counts = asRecord(body?.counts);
  if (body === undefined || !Array.isArray(body.items) || counts === undefined) throw new Error('unexpected mappings');
  return {
    items: list(body.items).flatMap(toMapping),
    nextCursor: nullableText(body.next_cursor),
    counts: { PROPOSED: count(counts.PROPOSED), ACTIVE: count(counts.ACTIVE), REJECTED: count(counts.REJECTED), RETIRED: count(counts.RETIRED) },
    asOf: nullableText(body.as_of),
  };
}

export interface Unmapped {
  feedProjectCode: string;
  projectName: string | null;
  investorCode: string | null;
  ourCodeHint: string | null;
  asOfStatement: string | null;
}

export interface UnmappedList {
  items: Unmapped[];
  total: number;
  asOf: string | null;
}

export function toUnmappedList(raw: unknown): UnmappedList {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.items)) throw new Error('unexpected unmapped');
  const items = list(body.items).flatMap((item): Unmapped[] => {
    const one = asRecord(item);
    const code = text(one?.feed_project_code);
    return one === undefined || code === undefined ? [] : [{ feedProjectCode: code, projectName: nullableText(one.project_name), investorCode: nullableText(one.investor_code), ourCodeHint: nullableText(one.our_code_hint), asOfStatement: nullableText(one.as_of_statement) }];
  });
  return { items, total: whole(body.total) ?? items.length, asOf: nullableText(body.as_of) };
}

export interface MappingFilters {
  status?: MappingStatus;
  q?: string;
}

export function mappingFiltersOf(search: URLSearchParams): MappingFilters {
  const status = mappingStatusOf(search.get('status'));
  const q = search.get('q')?.trim() ?? '';
  return { ...(status === undefined ? {} : { status }), ...(q === '' ? {} : { q }) };
}

export function mappingSearchOf(filters: MappingFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.status !== undefined) search.set('status', filters.status);
  if (filters.q !== undefined) search.set('q', filters.q);
  return search;
}

export const mappingQueryOf = (filters: MappingFilters, cursor: string | undefined): Record<string, string | number> => ({
  ...(filters.status === undefined ? {} : { status: filters.status }),
  ...(filters.q === undefined ? {} : { q: filters.q }),
  ...(cursor === undefined ? {} : { cursor }),
  limit: PAGE_SIZE,
});

export const appliedFilters = (filters: object): number => Object.keys(filters).length;

export const totalOfMappings = (counts: Readonly<Record<MappingStatus, number>>): number => MAPPING_STATUSES.reduce((sum, status) => sum + counts[status], 0);

export interface ProposeForm {
  ourCode: string;
  externalCode: string;
  validFrom: string;
  validUntil: string;
}

export const EMPTY_PROPOSE: ProposeForm = { ourCode: '', externalCode: '', validFrom: '', validUntil: '' };
export type ProposeField = 'ourCode' | 'externalCode' | 'validFrom' | 'validUntil';
export type FieldIssue = 'required' | 'tooLong' | 'invalid' | 'order';
export type ProposeErrors = Partial<Record<ProposeField, FieldIssue>>;

const isDay = (value: string): boolean => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (parts === null) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const moment = new Date(Date.UTC(year, month - 1, day));
  return moment.getUTCFullYear() === year && moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day;
};
/** A control character the server refuses too. */
const hasControl = (value: string): boolean => Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function codeIssue(value: string): FieldIssue | undefined {
  const body = value.trim();
  if (body === '') return 'required';
  if (body.length > MAX_CODE) return 'tooLong';
  return hasControl(body) ? 'invalid' : undefined;
}

/** The checks of a hand-made proposal, the same the server makes (so that a person is told in place before the command is sent). */
export function validatePropose(form: ProposeForm): ProposeErrors {
  const errors: ProposeErrors = {};
  const ours = codeIssue(form.ourCode);
  if (ours !== undefined) errors.ourCode = ours;
  const external = codeIssue(form.externalCode);
  if (external !== undefined) errors.externalCode = external;
  const from = form.validFrom.trim();
  const until = form.validUntil.trim();
  if (from !== '' && !isDay(from)) errors.validFrom = 'invalid';
  if (until !== '' && !isDay(until)) errors.validUntil = 'invalid';
  if (errors.validFrom === undefined && errors.validUntil === undefined && from !== '' && until !== '' && until <= from) errors.validUntil = 'order';
  return errors;
}

export interface ProposeBody {
  our_code: string;
  external_code: string;
  reason: string;
  valid_from?: string;
  valid_until?: string;
}

export const proposeBody = (form: ProposeForm, reason: string): ProposeBody => ({
  our_code: form.ourCode.trim(),
  external_code: form.externalCode.trim(),
  reason: reason.trim(),
  ...(form.validFrom.trim() === '' ? {} : { valid_from: form.validFrom.trim() }),
  ...(form.validUntil.trim() === '' ? {} : { valid_until: form.validUntil.trim() }),
});

/** The first form of a proposal made from a feed code that has no mapping yet: the feed code is fixed and the hint of the server is put in as ours when it has one. */
export const proposeFromUnmapped = (item: Unmapped): ProposeForm => ({ ...EMPTY_PROPOSE, externalCode: item.feedProjectCode, ourCode: item.ourCodeHint ?? '' });

// ---- the differences (FEED-04) ----------------------------------------------------------------------------------------------------------------------------------------

export const RESOLUTION_KINDS = ['ACCEPT_FEED', 'KEEP_OURS', 'DISPUTE', 'WAIVE'] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];
export const RESOLUTION_MIN_REASON: Readonly<Record<ResolutionKind, number>> = { ACCEPT_FEED: 10, KEEP_OURS: 10, DISPUTE: 20, WAIVE: 20 };
export const DIFFERENCE_FIELDS = ['PLAN_VS_DIS', 'DISBURSED_VS_DIS', 'DISBURSED_VS_TREASURY'] as const;
export const resolutionKindOf = (value: unknown): ResolutionKind | undefined => RESOLUTION_KINDS.find((kind) => kind === value);

export interface Resolution {
  kind: ResolutionKind;
  resolvedByName: string | null;
  resolvedAt: string | null;
  reason: string | null;
  evidenceRef: string | null;
  reviewOn: string | null;
}

export interface Difference {
  id: string;
  feedProjectCode: string;
  ourCode: string | null;
  fiscalYear: number;
  field: string;
  kind: 'VALUE_MISMATCH' | 'MISSING_OURS';
  feedValue: string;
  ourValue: string | null;
  delta: string | null;
  deltaPct: string | null;
  large: boolean;
  state: 'OPEN' | 'RESOLVED';
  ownerId: string | null;
  ownerName: string | null;
  openedAt: string;
  dueAt: string;
  resolution: Resolution | null;
  version: number;
  canResolve: boolean;
}

function toDifference(raw: unknown): Difference[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.feed_project_code);
  const year = whole(row?.fiscal_year);
  if (row === undefined || id === undefined || code === undefined || year === undefined) return [];
  const resolved = asRecord(row.resolution);
  const resolutionKind = resolutionKindOf(resolved?.kind);
  return [
    {
      id,
      feedProjectCode: code,
      ourCode: nullableText(row.our_code),
      fiscalYear: year,
      field: text(row.field) ?? '',
      kind: row.kind === 'MISSING_OURS' ? 'MISSING_OURS' : 'VALUE_MISMATCH',
      feedValue: text(row.feed_value) ?? '',
      ourValue: nullableText(row.our_value),
      delta: nullableText(row.delta),
      deltaPct: nullableText(row.delta_pct),
      large: row.large === true,
      state: row.state === 'RESOLVED' ? 'RESOLVED' : 'OPEN',
      ownerId: nullableText(row.owner_id),
      ownerName: nullableText(row.owner_name),
      openedAt: text(row.opened_at) ?? '',
      dueAt: text(row.due_at) ?? '',
      resolution:
        resolved === undefined || resolutionKind === undefined
          ? null
          : { kind: resolutionKind, resolvedByName: nullableText(resolved.resolved_by_name), resolvedAt: nullableText(resolved.resolved_at), reason: nullableText(resolved.reason), evidenceRef: nullableText(resolved.evidence_ref), reviewOn: nullableText(resolved.review_on) },
      version: count(row.version),
      canResolve: row.can_resolve === true,
    },
  ];
}

export interface DifferencePage {
  items: Difference[];
  nextCursor: string | null;
  counts: { open: number; openLarge: number; resolved: number; figuresCompared: number };
  asOf: string | null;
}

export function toDifferencePage(raw: unknown): DifferencePage {
  const body = asRecord(raw);
  const counts = asRecord(body?.counts);
  if (body === undefined || !Array.isArray(body.items) || counts === undefined) throw new Error('unexpected differences');
  return {
    items: list(body.items).flatMap(toDifference),
    nextCursor: nullableText(body.next_cursor),
    counts: { open: count(counts.open), openLarge: count(counts.open_large), resolved: count(counts.resolved), figuresCompared: count(counts.figures_compared) },
    asOf: nullableText(body.as_of),
  };
}

export type DifferenceState = 'OPEN' | 'RESOLVED';

export interface DifferenceFilters {
  state?: DifferenceState;
  large?: boolean;
  fiscalYear?: number;
  q?: string;
}

export function differenceFiltersOf(search: URLSearchParams): DifferenceFilters {
  const state = search.get('state');
  const large = search.get('large');
  const year = Number(search.get('fiscal_year'));
  const q = search.get('q')?.trim() ?? '';
  return {
    ...(state === 'OPEN' || state === 'RESOLVED' ? { state } : {}),
    ...(large === 'true' ? { large: true } : large === 'false' ? { large: false } : {}),
    ...(Number.isInteger(year) && year >= FISCAL_YEAR_RANGE[0] && year <= FISCAL_YEAR_RANGE[1] ? { fiscalYear: year } : {}),
    ...(q === '' ? {} : { q }),
  };
}

export function differenceSearchOf(filters: DifferenceFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.state !== undefined) search.set('state', filters.state);
  if (filters.large !== undefined) search.set('large', String(filters.large));
  if (filters.fiscalYear !== undefined) search.set('fiscal_year', String(filters.fiscalYear));
  if (filters.q !== undefined) search.set('q', filters.q);
  return search;
}

export const differenceQueryOf = (filters: DifferenceFilters, cursor: string | undefined): Record<string, string | number> => ({
  ...(filters.state === undefined ? {} : { state: filters.state }),
  ...(filters.large === undefined ? {} : { large: String(filters.large) }),
  ...(filters.fiscalYear === undefined ? {} : { fiscal_year: filters.fiscalYear }),
  ...(filters.q === undefined ? {} : { q: filters.q }),
  ...(cursor === undefined ? {} : { cursor }),
  limit: PAGE_SIZE,
});

/** Whether an open difference is past its due moment as of `now`. */
export const isOverdue = (difference: Difference, now: Date): boolean => difference.state === 'OPEN' && difference.dueAt !== '' && Date.parse(difference.dueAt) < now.getTime();

export interface ResolutionForm {
  kind: ResolutionKind | '';
  reason: string;
  evidenceRef: string;
  reviewOn: string;
}

export const EMPTY_RESOLUTION: ResolutionForm = { kind: '', reason: '', evidenceRef: '', reviewOn: '' };
export type ResolutionField = 'kind' | 'reason' | 'evidenceRef' | 'reviewOn';
export type ResolutionIssue = 'required' | 'short' | 'long' | 'invalid' | 'past' | 'far';
export type ResolutionErrors = Partial<Record<ResolutionField, ResolutionIssue>>;

/** The checks of a resolution, the same the server makes: a reason as long as the kind needs, a DISPUTE with its evidence, a WAIVE with a day to review inside one year from today. */
export function validateResolution(form: ResolutionForm, today: string): ResolutionErrors {
  const errors: ResolutionErrors = {};
  if (form.kind === '') {
    errors.kind = 'required';
    return errors;
  }
  const reason = form.reason.trim();
  if (reason === '') errors.reason = 'required';
  else if (reason.length < RESOLUTION_MIN_REASON[form.kind]) errors.reason = 'short';
  else if (reason.length > 1000) errors.reason = 'long';
  const evidence = form.evidenceRef.trim();
  if (form.kind === 'DISPUTE' && evidence === '') errors.evidenceRef = 'required';
  else if (evidence.length > MAX_EVIDENCE) errors.evidenceRef = 'long';
  if (form.kind === 'WAIVE') {
    const day = form.reviewOn.trim();
    if (day === '') errors.reviewOn = 'required';
    else if (!isDay(day)) errors.reviewOn = 'invalid';
    else if (day <= today) errors.reviewOn = 'past';
    else if (day > addDays(today, WAIVER_MAX_DAYS)) errors.reviewOn = 'far';
  }
  return errors;
}

export interface ResolutionBody {
  kind: ResolutionKind;
  reason: string;
  evidence_ref?: string;
  review_on?: string;
}

export function resolutionBody(form: ResolutionForm): ResolutionBody | undefined {
  if (form.kind === '') return undefined;
  const evidence = form.evidenceRef.trim();
  return {
    kind: form.kind,
    reason: form.reason.trim(),
    ...(evidence === '' || form.kind === 'WAIVE' ? {} : { evidence_ref: evidence }),
    ...(form.kind === 'WAIVE' && form.reviewOn.trim() !== '' ? { review_on: form.reviewOn.trim() } : {}),
  };
}

export interface ReconcileForm {
  fiscalYear: string;
  ownerId: string;
}

export type ReconcileField = 'fiscalYear' | 'ownerId';
export type ReconcileErrors = Partial<Record<ReconcileField, 'required' | 'range' | 'invalid'>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateReconcile(form: ReconcileForm): ReconcileErrors {
  const errors: ReconcileErrors = {};
  const year = form.fiscalYear.trim();
  if (year === '') errors.fiscalYear = 'required';
  else if (!/^\d{4}$/.test(year) || Number(year) < FISCAL_YEAR_RANGE[0] || Number(year) > FISCAL_YEAR_RANGE[1]) errors.fiscalYear = 'range';
  const owner = form.ownerId.trim();
  if (owner !== '' && !UUID.test(owner)) errors.ownerId = 'invalid';
  return errors;
}

export interface ReconcileBody {
  fiscal_year: number;
  owner_id?: string;
}

export const reconcileBody = (form: ReconcileForm): ReconcileBody => ({ fiscal_year: Number(form.fiscalYear.trim()), ...(form.ownerId.trim() === '' ? {} : { owner_id: form.ownerId.trim() }) });

export interface Reconciliation {
  fiscalYear: number;
  projectsCompared: number;
  figuresCompared: number;
  existing: number;
  opened: number;
  openedLarge: number;
  skippedOwnerIsMaker: number;
}

export function toReconciliation(raw: unknown): Reconciliation | undefined {
  const body = asRecord(raw);
  const year = whole(body?.fiscal_year);
  if (body === undefined || year === undefined) return undefined;
  const opened = list(body.opened).flatMap(toDifference);
  return {
    fiscalYear: year,
    projectsCompared: count(body.projects_compared),
    figuresCompared: count(body.figures_compared),
    existing: count(body.existing),
    opened: opened.length,
    openedLarge: opened.filter((one) => one.large).length,
    skippedOwnerIsMaker: list(body.skipped_owner_is_maker).length,
  };
}

/** The year a reconciliation proposes: the fiscal year of the feed in the first quality reading, else the year of today. */
export const defaultFiscalYear = (quality: Quality | undefined, today: string): string => String(quality?.fiscalYear ?? Number(today.slice(0, 4)));

// ---- the data generator (FEED-05) -------------------------------------------------------------------------------------------------------------------------------------

export const GENERATOR_ACTIONS = ['START', 'STOP', 'RESEED', 'TICK'] as const;
export type GeneratorAction = (typeof GENERATOR_ACTIONS)[number];
export const GENERATOR_LIMITS = { seed: [0, 2_147_483_647], projectCount: [10, 1000], lateUnits: [0, 20], delayedPct: [0, 80], aheadPct: [0, 50], discrepancies: [0, 100], anchorCount: [0, 50], currentMonth: [1, 12] } as const;
export const GENERATOR_DEFAULTS = { seed: '57', projectCount: '120', lateUnits: '3', delayedPct: '22', aheadPct: '12', discrepancies: '6', anchorCount: '0' } as const;

export type GeneratorBlock = 'connection' | 'running' | 'stopped' | 'yearComplete' | 'neverStarted' | null;

/** Whether a move is open now, the way the server will judge it; otherwise why not (the server judges again). */
export function generatorBlock(action: GeneratorAction, connection: Pick<Connection, 'enabled' | 'generator'>): GeneratorBlock {
  const { enabled, generator } = connection;
  switch (action) {
    case 'START':
      if (!enabled) return 'connection';
      return generator.state === 'RUNNING' ? 'running' : null;
    case 'STOP':
      return generator.state === 'RUNNING' ? null : 'stopped';
    case 'RESEED':
      return enabled ? null : 'connection';
    case 'TICK':
      if (!enabled) return 'connection';
      if (generator.state !== 'RUNNING') return generator.parameters === null ? 'neverStarted' : 'stopped';
      return (generator.parameters?.currentMonth ?? 0) >= 12 ? 'yearComplete' : null;
  }
}

export interface GeneratorForm {
  seed: string;
  fiscalYear: string;
  currentMonth: string;
  projectCount: string;
  lateUnits: string;
  delayedPct: string;
  aheadPct: string;
  discrepancies: string;
  anchorCount: string;
  reason: string;
}

export type GeneratorField = 'seed' | 'fiscalYear' | 'currentMonth' | 'projectCount' | 'lateUnits' | 'delayedPct' | 'aheadPct' | 'discrepancies' | 'anchorCount';
export type GeneratorIssue = 'required' | 'integer' | 'range' | 'share';
export type GeneratorErrors = Partial<Record<GeneratorField, GeneratorIssue>>;

/** The form of the generator as it opens: the stored parameters when there are some, else the defaults of the generator (the year and the month are left to the server). */
export function generatorFormOf(stored: GeneratorParams | null): GeneratorForm {
  const given = (value: number | null, fallback: string): string => (value === null ? fallback : String(value));
  return {
    seed: given(stored?.seed ?? null, GENERATOR_DEFAULTS.seed),
    fiscalYear: given(stored?.fiscalYear ?? null, ''),
    currentMonth: given(stored?.currentMonth ?? null, ''),
    projectCount: given(stored?.projectCount ?? null, GENERATOR_DEFAULTS.projectCount),
    lateUnits: given(stored?.lateUnits ?? null, GENERATOR_DEFAULTS.lateUnits),
    delayedPct: given(stored?.delayedPct ?? null, GENERATOR_DEFAULTS.delayedPct),
    aheadPct: given(stored?.aheadPct ?? null, GENERATOR_DEFAULTS.aheadPct),
    discrepancies: given(stored?.discrepancies ?? null, GENERATOR_DEFAULTS.discrepancies),
    anchorCount: stored === null ? GENERATOR_DEFAULTS.anchorCount : String(stored.anchorCount),
    reason: '',
  };
}

/** The fields each move takes: a stop and a tick take none (a tick moves the stored data on by one month), a start takes all, a reseed takes a new seed and the rest it may change. */
export const GENERATOR_FIELDS: Readonly<Record<GeneratorAction, readonly GeneratorField[]>> = {
  START: ['seed', 'fiscalYear', 'currentMonth', 'projectCount', 'lateUnits', 'delayedPct', 'aheadPct', 'discrepancies', 'anchorCount'],
  STOP: [],
  RESEED: ['seed', 'projectCount', 'lateUnits', 'delayedPct', 'aheadPct', 'discrepancies', 'anchorCount'],
  TICK: [],
};

const limitsOf = (field: GeneratorField): readonly [number, number] => (field === 'fiscalYear' ? FISCAL_YEAR_RANGE : GENERATOR_LIMITS[field]);

/** The checks of the numbers of a move, in the limits of the generator; the year and the month may stay empty on a start (the server proposes them). */
export function validateGenerator(action: GeneratorAction, form: GeneratorForm): GeneratorErrors {
  const errors: GeneratorErrors = {};
  for (const field of GENERATOR_FIELDS[action]) {
    const value = form[field].trim();
    if (value === '') {
      if (field === 'seed' && action === 'RESEED') errors.seed = 'required';
      continue;
    }
    if (!/^\d+$/.test(value)) {
      errors[field] = 'integer';
      continue;
    }
    const [min, max] = limitsOf(field);
    if (Number(value) < min || Number(value) > max) errors[field] = 'range';
  }
  const delayed = Number(form.delayedPct.trim() === '' ? GENERATOR_DEFAULTS.delayedPct : form.delayedPct);
  const ahead = Number(form.aheadPct.trim() === '' ? GENERATOR_DEFAULTS.aheadPct : form.aheadPct);
  if ((GENERATOR_FIELDS[action] as readonly string[]).includes('aheadPct') && errors.delayedPct === undefined && errors.aheadPct === undefined && delayed + ahead > 90) errors.aheadPct = 'share';
  return errors;
}

export interface GeneratorBody {
  action: GeneratorAction;
  reason: string;
  seed?: number;
  fiscal_year?: number;
  current_month?: number;
  project_count?: number;
  late_units?: number;
  delayed_pct?: number;
  ahead_pct?: number;
  discrepancies?: number;
  anchor_count?: number;
}

const BODY_KEYS: Readonly<Record<GeneratorField, keyof GeneratorBody>> = {
  seed: 'seed',
  fiscalYear: 'fiscal_year',
  currentMonth: 'current_month',
  projectCount: 'project_count',
  lateUnits: 'late_units',
  delayedPct: 'delayed_pct',
  aheadPct: 'ahead_pct',
  discrepancies: 'discrepancies',
  anchorCount: 'anchor_count',
};

/** The body of a move: only the fields the move takes and the person filled in; an empty field is left to the server's default. */
export function generatorBody(action: GeneratorAction, form: GeneratorForm): GeneratorBody {
  const body: Record<string, string | number> = { action, reason: form.reason.trim() };
  for (const field of GENERATOR_FIELDS[action]) {
    const value = form[field].trim();
    if (value !== '') body[BODY_KEYS[field]] = Number(value);
  }
  return body as unknown as GeneratorBody;
}

export interface GeneratorReceipt {
  state: string;
  epoch: number;
  month: number | null;
  seed: number | null;
  recordsWritten: number | null;
  recordsSkipped: number | null;
  mappingsProposed: number;
}

export function toGeneratorReceipt(raw: unknown): GeneratorReceipt | undefined {
  const body = asRecord(raw);
  const generator = asRecord(body?.generator);
  if (body === undefined || generator === undefined) return undefined;
  const run = asRecord(body.run);
  return {
    state: text(generator.state) ?? '',
    epoch: count(generator.epoch),
    month: nullableNumber(generator.current_month),
    seed: nullableNumber(generator.seed),
    recordsWritten: run === undefined ? null : nullableNumber(run.records_written),
    recordsSkipped: run === undefined ? null : nullableNumber(run.records_skipped),
    mappingsProposed: count(body.mappings_proposed),
  };
}

/** The moves of the generator in the history of the connection (the events that are not a switch of the connection). */
export const isGeneratorEvent = (action: string): boolean => action.startsWith('GENERATOR_');
