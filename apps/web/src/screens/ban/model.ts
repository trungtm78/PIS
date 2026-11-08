import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import type { Locale } from '../../i18n';
import type { Tone } from '../../ui';
import { CHANGE_KINDS, CHANGE_LINKS, CHANGE_PARAMS, MAX_CHANGE_LINES } from '../home/gov-model';
import type { ChangeLine } from '../home/gov-model';
import { FIGURE_FLAGS, toKpiInfo } from '../home/model';
import type { FigureFlag, Tile } from '../home/model';

export type Schemas = components['schemas'];
export type Workspace = Schemas['CommitteeWorkspace'];
export type Row = Schemas['CommitteeAggregateRow'];
export type Outlook = Schemas['CommitteeOutlook'];
export type Attention = Schemas['CommitteeAttentionItem'];
export type AttentionList = Schemas['CommitteeAttentionList'];
export type Decision = Schemas['CommitteeDecision'];
export type DecisionKind = Decision['decision'];
export type Alert = Schemas['CommitteeAlert'];
export type AlertList = Schemas['CommitteeAlertList'];
export type Unit = Schemas['CommitteeUnitReporting'];
export type Tracker = Schemas['CommitteeDirectiveTracker'];
export type Pack = Schemas['CommitteeMeetingPack'];
export type Roster = Schemas['CommitteeRoster'];
export type Member = Schemas['CommitteeMember'];
export type MemberRole = Member['committee_role'];
export type AuditList = Schemas['CommitteeViewAuditList'];
export type AuditRow = AuditList['rows'][number];
export type Policy = Schemas['CommitteePolicyInfo'];
export type Feed = Schemas['CommitteeFeedInfo'];
export type Figure = Schemas['CommitteeFigure'];
export type Reason = Attention['signals'][number]['reason'];
export type Signal = Attention['signals'][number];
export type Rag = Row['rag'];

/** The rights the screens look at to decide what to offer; the server decides again on every request, and `undefined` means the rights are not known. */
export const PERMISSION = {
  read: 'committee.read',
  decide: 'committee.attention.decide',
  acknowledge: 'committee.alert.acknowledge',
  evaluate: 'committee.alert.evaluate',
  manage: 'committee.manage',
  audit: 'committee.audit.read',
  directive: 'directive.manage',
  meeting: 'directive.meeting.manage',
  generate: 'rpt.generate',
} as const;

export const may = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

export const PATH = {
  dashboard: '/ban/ban-01',
  attention: '/ban/ban-02',
  pack: '/ban/ban-03',
  tracker: '/ban/ban-04',
  alerts: '/ban/ban-05',
  roster: '/ban/ban-06',
  audit: '/ban/ban-07',
} as const;

export const draftPath = (id: string): string => `/rpt/rpt-02?draft=${encodeURIComponent(id)}`;
export const issuePath = (id: string): string => `/rpt/rpt-03?issue=${encodeURIComponent(id)}`;
export const directivePath = (id: string): string => `/dir/dir-04?directive=${encodeURIComponent(id)}`;

/** The form of the meeting pack in the report engine. */
export const PACK_LAYOUT = 'BAN-MEETING-PACK';
/** The most rows the attention list asks for, and how many the dashboard shows of it. */
export const ATTENTION_LIMIT = 50;
export const DASHBOARD_ATTENTION = 5;
export const AUDIT_PAGE = 50;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);

// ---- the words of numbers: from the text the API gives, never through a float --------------------------------------------------------------------------

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** A decimal text in the way the locale writes it: thousands grouped, the decimal mark of the locale; a text that is not a decimal is returned as it came. */
export function decimalText(value: string, locale: Locale): string {
  const found = DECIMAL.exec(value.trim());
  if (found === null) return value;
  const sign = found[1] ?? '';
  const whole = (found[2] ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'vi' ? '.' : ',');
  const fraction = found[3];
  return `${sign}${whole}${fraction === undefined ? '' : `${locale === 'vi' ? ',' : '.'}${fraction}`}`;
}

/** Whole dong; null stays null (the caller says "no data": an unknown amount is never 0). */
export const vndText = (value: string | null | undefined, locale: Locale): string | null => (value === null || value === undefined ? null : decimalText(value, locale));
export const pctText = (value: string | null | undefined, locale: Locale): string | null => (value === null || value === undefined ? null : `${decimalText(value, locale)}%`);

/** A difference in percentage points with its sign ("+3,20", "-4,10", "0,00"). */
export function pointsText(value: string | null | undefined, locale: Locale): string | null {
  if (value === null || value === undefined) return null;
  const text = decimalText(value, locale);
  if (/^-?0+(\.0+)?$/.test(value.trim()) || value.startsWith('-') || value.startsWith('+')) return text;
  return DECIMAL.test(value.trim()) ? `+${text}` : text;
}

/** "12/10/2027" from "2027-10-12" or a time that begins with the day; anything else as it came. */
export function dayText(day: string | null | undefined): string {
  if (day === null || day === undefined || day === '') return '–';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  return match === null ? day : `${match[3]}/${match[2]}/${match[1]}`;
}

/** Today in the calendar of Vietnam, `yyyy-mm-dd`. */
export const vietnamDay = (now: number = Date.now()): string => new Date(now + 7 * 3_600_000).toISOString().slice(0, 10);

const isRealDay = (day: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
export const isDay = isRealDay;

// ---- the colour and the reasons: always a word and a shape as well --------------------------------------------------------------------------------------

export const RAG_STYLE: Readonly<Record<Rag, { tone: Tone; icon: string; word: string }>> = {
  RED: { tone: 'danger', icon: '▲', word: 'red' },
  AMBER: { tone: 'warning', icon: '◆', word: 'amber' },
  GREEN: { tone: 'success', icon: '●', word: 'green' },
  NO_DATA: { tone: 'neutral', icon: '○', word: 'noData' },
};

export const REASON_STYLE: Readonly<Record<Reason, { icon: string; word: string }>> = {
  DELAYED: { icon: '◷', word: 'delayed' },
  STALLED_PROCEDURE: { icon: '⏸', word: 'stalled' },
  OVER_BUDGET_RISK: { icon: '▲', word: 'overBudget' },
  DISBURSEMENT_FAR_BELOW_PLAN: { icon: '▼', word: 'farBelow' },
  UNIT_NOT_REPORTING: { icon: '○', word: 'notReporting' },
};
export const REASONS = Object.keys(REASON_STYLE) as Reason[];

export const SEVERITY_STYLE: Readonly<Record<Alert['severity'], { tone: Tone; icon: string; word: string }>> = {
  URGENT: { tone: 'danger', icon: '⛔', word: 'urgent' },
  ACTION: { tone: 'warning', icon: '▲', word: 'action' },
  WATCH: { tone: 'info', icon: '◆', word: 'watch' },
};

export const ALERT_TYPE_WORD: Readonly<Record<Alert['alert_type'], string>> = {
  COMMITTEE_PROVINCE_BEHIND: 'provinceBehind',
  COMMITTEE_SECTOR_BEHIND: 'sectorBehind',
  COMMITTEE_UNIT_NOT_REPORTING: 'unitNotReporting',
  COMMITTEE_DIRECTIVE_OVERDUE: 'directiveOverdue',
};

export const DECISION_WORD: Readonly<Record<DecisionKind, string>> = { ACKNOWLEDGED: 'acknowledged', DEFERRED: 'deferred', DIRECTED: 'directed', REOPENED: 'reopened' };
export const ROLES: readonly MemberRole[] = ['HEAD', 'DEPUTY', 'MEMBER', 'SECRETARIAT'];
export const SCREENS = ['WORKSPACE', 'ATTENTION', 'MEETING_PACK', 'DIRECTIVE_TRACKER', 'ALERTS', 'ROSTER', 'VIEW_AUDIT'] as const;
export const screenWord = (screen: string): string => screen.toLowerCase().replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase());

// ---- the figures --------------------------------------------------------------------------------------------------------------------------------------

const UNITS = ['PERCENT', 'VND', 'COUNT'] as const;

/**
 * A figure of the workspace as the "i" and the tile of HOME read it: the text is the one the server wrote (never made from the value here), the flags are those it named, and the definition behind it is the register's own.
 * A figure with no metric or an unknown unit is not shown.
 */
export function toFigure(raw: Figure): Tile | undefined {
  const unit = oneOf(raw.unit, UNITS);
  if (unit === undefined || raw.metric_code === '') return undefined;
  const flags = (Array.isArray(raw.flags) ? raw.flags : []).flatMap((flag) => oneOf(flag, FIGURE_FLAGS) ?? []) as FigureFlag[];
  return {
    metricCode: raw.metric_code,
    value: raw.value ?? null,
    displayValue: raw.display_value ?? null,
    numerator: raw.numerator ?? null,
    denominator: raw.denominator ?? null,
    nullReason: raw.null_reason ?? null,
    unit,
    formula: raw.formula,
    definitionStatus: raw.definition_status ?? '',
    contextToken: '',
    flags,
    certification: null,
    kpi: toKpiInfo(raw.kpi),
  };
}

export const toFigures = (figures: readonly Figure[] | undefined): Tile[] => (figures ?? []).flatMap((figure) => toFigure(figure) ?? []);

/** The code of a metric without its prefix, in lower camel case (`COMMITTEE_GAP_VS_CURVE` gives `gapVsCurve`). */
export const figureWord = (code: string): string => code.replace(/^COMMITTEE_/, '').toLowerCase().replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase());

/** The figure of a metric, by code. */
export const figureOf = (figures: readonly Figure[] | undefined, code: string): Tile | undefined => toFigures(figures).find((tile) => tile.metricCode === code);

// ---- the filters of the dashboard ---------------------------------------------------------------------------------------------------------------------

export const FILTER_KEYS = ['sector_code', 'district_code', 'investor_unit_id', 'fund_source_code'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Record<FilterKey, string>;
export const NO_FILTERS: Filters = { sector_code: '', district_code: '', investor_unit_id: '', fund_source_code: '' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,59}$/;

/** The filters an address carries; a value that is not a code (or a unit id) is not a filter. */
export function filtersFrom(params: URLSearchParams): Filters {
  const pick = (key: FilterKey): string => {
    const value = params.get(key) ?? '';
    return key === 'investor_unit_id' ? (UUID.test(value) ? value.toLowerCase() : '') : CODE.test(value) ? value : '';
  };
  return { sector_code: pick('sector_code'), district_code: pick('district_code'), investor_unit_id: pick('investor_unit_id'), fund_source_code: pick('fund_source_code') };
}

/** The query of a read: only the filters that are set. */
export function filterQuery(filters: Filters): Record<string, string> {
  return Object.fromEntries(FILTER_KEYS.flatMap((key) => (filters[key] === '' ? [] : [[key, filters[key]] as [string, string]])));
}

export const appliedCount = (filters: Filters): number => FILTER_KEYS.filter((key) => filters[key] !== '').length;

export const DIMENSIONS = ['sector', 'district', 'investor', 'fundSource'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const dimensionOf = (value: string | null): Dimension => DIMENSIONS.find((one) => one === value) ?? 'sector';

export function rowsOf(workspace: Pick<Workspace, 'by_sector' | 'by_district' | 'by_investor' | 'by_fund_source'>, dimension: Dimension): Row[] {
  switch (dimension) {
    case 'sector':
      return workspace.by_sector;
    case 'district':
      return workspace.by_district;
    case 'investor':
      return workspace.by_investor;
    case 'fundSource':
      return workspace.by_fund_source;
  }
}

/** The options of a filter from the rows of its dimension; the value that is chosen stays in the list even when the rows no longer hold it. */
export function optionsOf(rows: readonly Row[], chosen: string): Array<{ key: string; label: string }> {
  const options = rows.map((row) => ({ key: row.key, label: row.label }));
  return chosen === '' || options.some((option) => option.key === chosen) ? options : [{ key: chosen, label: chosen }, ...options];
}

// ---- the year-end band --------------------------------------------------------------------------------------------------------------------------------

export type OutlookView = { kind: 'range'; low: string; high: string; lowPct: string | null; highPct: string | null; thin: boolean } | { kind: 'none'; reason: 'noData' | 'noPlan' };

/** The band as it is said: the lowest to the highest estimate, or why there is none (never a 0). */
export function outlookView(outlook: Outlook, locale: Locale): OutlookView {
  const low = vndText(outlook.low_vnd, locale);
  const high = vndText(outlook.high_vnd, locale);
  if (low === null || high === null) return { kind: 'none', reason: outlook.reason === 'NO_PLAN' ? 'noPlan' : 'noData' };
  return { kind: 'range', low, high, lowPct: pctText(outlook.low_pct, locale), highPct: pctText(outlook.high_pct, locale), thin: outlook.thin };
}

/** What the figure of last year says of a row: the amount, or that only some lines have one (the coverage), or that none has. */
export type LastYearView = { kind: 'amount'; amount: string } | { kind: 'partial'; known: number; total: number } | { kind: 'none' };

export function lastYearView(row: Pick<Row, 'last_year_vnd' | 'last_year_coverage'>, locale: Locale): LastYearView {
  const amount = vndText(row.last_year_vnd, locale);
  if (amount !== null) return { kind: 'amount', amount };
  const { known, total } = row.last_year_coverage;
  return known > 0 && known < total ? { kind: 'partial', known, total } : { kind: 'none' };
}

// ---- the attention list and its decisions -------------------------------------------------------------------------------------------------------------

export type DecisionState = DecisionKind | 'NONE';
export const stateOf = (item: Pick<Attention, 'decision'>): DecisionState => item.decision?.decision ?? 'NONE';

/** The decisions a row offers from the state it is in; the server accepts any order, the screen offers the ones that mean something. */
export function decisionsFrom(state: DecisionState): readonly DecisionKind[] {
  switch (state) {
    case 'NONE':
    case 'REOPENED':
      return ['ACKNOWLEDGED', 'DEFERRED', 'DIRECTED'];
    case 'ACKNOWLEDGED':
      return ['DEFERRED', 'DIRECTED', 'REOPENED'];
    case 'DEFERRED':
      return ['ACKNOWLEDGED', 'DIRECTED', 'REOPENED'];
    case 'DIRECTED':
      return ['REOPENED'];
  }
}

export const NOTE_MAX = 2000;
export const TEXT_MAX = 2000;

export interface DecisionInput {
  projectId: string;
  decision: Exclude<DecisionKind, 'DIRECTED'>;
  note: string;
  deferUntil: string;
}

export type DecisionProblem = 'note' | 'deferUntil';

/** What is wrong with a decision before it is sent: every decision but the directive needs a note, a deferral needs a day after today. */
export function decisionProblems(input: Pick<DecisionInput, 'decision' | 'note' | 'deferUntil'>, today: string): DecisionProblem[] {
  const problems: DecisionProblem[] = [];
  if (input.note.trim() === '' || input.note.trim().length > NOTE_MAX) problems.push('note');
  if (input.decision === 'DEFERRED' && (!isDay(input.deferUntil) || input.deferUntil <= today)) problems.push('deferUntil');
  return problems;
}

export function decisionBody(input: DecisionInput): Schemas['CommitteeAttentionDecide'] {
  return {
    project_id: input.projectId,
    decision: input.decision,
    note: input.note.trim(),
    ...(input.decision === 'DEFERRED' ? { defer_until: input.deferUntil } : {}),
  };
}

export type MeetingChoice = { kind: 'existing'; meetingId: string } | { kind: 'new'; title: string };

export interface DirectiveInput {
  project: Pick<Attention, 'project_id' | 'investor_unit_id'>;
  meeting: MeetingChoice;
  meetingDate: string;
  text: string;
  dueOn: string;
  today: string;
}

export type DirectiveProblem = 'meeting' | 'text' | 'dueOn';

/** What is wrong with a directive before it is sent: a meeting that is chosen or a title for a new one, the text, and a due day that is not before the meeting. */
export function directiveProblems(input: Pick<DirectiveInput, 'meeting' | 'meetingDate' | 'text' | 'dueOn' | 'today'>): DirectiveProblem[] {
  const problems: DirectiveProblem[] = [];
  if (input.meeting.kind === 'existing' ? input.meeting.meetingId === '' : input.meeting.title.trim() === '') problems.push('meeting');
  if (input.text.trim() === '' || input.text.trim().length > TEXT_MAX) problems.push('text');
  const floor = input.meeting.kind === 'new' ? input.today : input.meetingDate;
  if (!isDay(input.dueOn) || input.dueOn < floor) problems.push('dueOn');
  return problems;
}

export function meetingBody(input: Pick<DirectiveInput, 'project' | 'today'> & { title: string }): Schemas['DirMeetingCreate'] {
  return { meeting_date: input.today, meeting_type: 'EXTRAORDINARY', title: input.title.trim(), unit_id: input.project.investor_unit_id };
}

export function directiveBody(input: Pick<DirectiveInput, 'project' | 'text' | 'dueOn'>): Schemas['DirDirectiveCreate'] {
  return { scope_kind: 'PROJECT', project_id: input.project.project_id, text: input.text.trim(), assignee_unit_id: input.project.investor_unit_id, due_on: input.dueOn };
}

// ---- the roster ---------------------------------------------------------------------------------------------------------------------------------------

export interface AppointInput {
  committeeId: string;
  membershipId: string;
  role: MemberRole;
  agencyCode: string;
  agencyName: string;
  decisionRef: string;
  validFrom: string;
  validUntil: string;
  mfaRequired: boolean;
}

export type AppointProblem = 'membership' | 'validFrom' | 'validUntil' | 'agencyCode';
const AGENCY_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export function appointProblems(input: Pick<AppointInput, 'membershipId' | 'validFrom' | 'validUntil' | 'agencyCode'>): AppointProblem[] {
  const problems: AppointProblem[] = [];
  if (!UUID.test(input.membershipId)) problems.push('membership');
  if (!isDay(input.validFrom)) problems.push('validFrom');
  if (input.validUntil !== '' && (!isDay(input.validUntil) || input.validUntil < input.validFrom)) problems.push('validUntil');
  if (input.agencyCode.trim() !== '' && !AGENCY_CODE.test(input.agencyCode.trim())) problems.push('agencyCode');
  return problems;
}

export function appointBody(input: AppointInput): Schemas['CommitteeAppoint'] {
  const text = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());
  const agencyCode = text(input.agencyCode);
  const agencyName = text(input.agencyName);
  const decisionRef = text(input.decisionRef);
  return {
    committee_id: input.committeeId,
    membership_id: input.membershipId,
    committee_role: input.role,
    ...(agencyCode === undefined ? {} : { agency_code: agencyCode }),
    ...(agencyName === undefined ? {} : { agency_name: agencyName }),
    ...(decisionRef === undefined ? {} : { decision_ref: decisionRef }),
    valid_from: input.validFrom,
    ...(input.validUntil === '' ? {} : { valid_until: input.validUntil }),
    ...(input.mfaRequired ? { mfa_required: true } : {}),
  };
}

export const END_REASON_MIN = 5;
export const REGISTER_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/** The members of a committee with the places that are in force first, as the server sorts them; the head before the rest. */
export const activeMembers = (members: readonly Member[]): Member[] => members.filter((member) => member.status === 'ACTIVE');

/** The sentence of the way a member's role stands: the right is the grant of IAM, and the roster only says whether it was given. */
export const missingRole = (member: Pick<Member, 'status' | 'role_granted'>): boolean => member.status === 'ACTIVE' && !member.role_granted;

// ---- alerts -------------------------------------------------------------------------------------------------------------------------------------------

export const ALERT_STATUSES = ['LIVE', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type AlertStatusFilter = (typeof ALERT_STATUSES)[number];
export const alertStatusOf = (value: string | null): AlertStatusFilter => ALERT_STATUSES.find((one) => one === value) ?? 'LIVE';
export const canAcknowledge = (alert: Pick<Alert, 'status'>): boolean => alert.status === 'OPEN';

// ---- the refusals a command can get -------------------------------------------------------------------------------------------------------------------

export interface Refusal {
  code: string;
  status: number;
  detail: string | undefined;
  reason: string | undefined;
  currentVersion: number | undefined;
}

export function refusalOf(error: unknown): Refusal {
  if (error instanceof ApiError) {
    const reason = error.extensions.reason;
    const version = error.extensions.current_version;
    return { code: error.code, status: error.status, detail: error.detail, reason: typeof reason === 'string' ? reason : undefined, currentVersion: typeof version === 'number' ? version : undefined };
  }
  return { code: 'UNKNOWN', status: 0, detail: undefined, reason: undefined, currentVersion: undefined };
}

/** A step of the chain "meeting, directive, decision" that failed: the steps before it were done and stay done (the same request is answered again on a retry). */
export class DirectiveFlowError extends Error {
  constructor(
    readonly step: 'meeting' | 'directive' | 'decision',
    readonly failure: unknown,
  ) {
    super(`directive flow failed at ${step}`);
  }
}

// ---- "changes since last week" ------------------------------------------------------------------------------------------------------------------------

/**
 * The lines of the week as HOME writes its own: a line the screen has no sentence for, or one whose numbers are not all there, is not said (no placeholder, no number made up). The committee lines carry no token of a figure,
 * so a drill line has no link; the screens of HOME are not promised to a reader of the committee.
 */
export function toChangeLines(lines: Workspace['changes']['lines'] | undefined): ChangeLine[] {
  return (lines ?? []).flatMap((line) => {
    const kind = oneOf(line.kind, CHANGE_KINDS);
    const link = oneOf(line.link, CHANGE_LINKS);
    if (kind === undefined || link === undefined) return [];
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(line.params ?? {})) if (typeof value === 'string' || typeof value === 'number') params[name] = String(value);
    if (CHANGE_PARAMS[kind].some((name) => params[name] === undefined || params[name] === '')) return [];
    return [{ kind, direction: line.direction, params, link, metricCode: line.metric_code, contextToken: null }];
  }).slice(0, MAX_CHANGE_LINES);
}

// ---- the audit of views -------------------------------------------------------------------------------------------------------------------------------

/** The filters of a view as a line of `name=value` pairs (the audit holds the filters, never a figure); a filter that was not set is left out. */
export function filtersText(filters: Record<string, unknown> | null | undefined): string {
  const pairs = Object.entries(filters ?? {}).flatMap(([name, value]) => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? (String(value) === '' ? [] : [`${name}=${String(value)}`]) : []));
  return pairs.join(', ');
}
