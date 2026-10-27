import { ApiError } from '@machvon/api-client';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export const PROFILE_PATH = '/home/home-06';
export const WARNINGS_PATH = '/home/home-03';
export const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const HISTORY_EVENTS = ['OPENED', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'EXPLANATION_RESPONDED', 'RESOLVED', 'DISMISSED'] as const;
export type HistoryEvent = (typeof HISTORY_EVENTS)[number];
/** The rights the actions of the profile need: each is the command of another module, under its own permission. */
export const REQUEST_EXPLANATION_PERMISSION = 'explanation.request';
export const HANDLE_WARNING_PERMISSION = 'warning.handle';

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);

export interface WarningItem {
  id: string;
  ruleCode: string;
  ruleName: string;
  metricCode: string | null;
  comparator: string | null;
  threshold: Record<string, unknown> | null;
  severity: Severity;
  status: string;
  project: { id: string; code: string; name: string } | null;
  observed: Record<string, unknown>;
  snapshotId: string;
  periodId: string | null;
  openedAt: string;
  closedAt: string | null;
  resolutionReason: string | null;
  version: number;
  leader: { membershipId: string; displayName: string } | null;
  explanation: { id: string; status: string; dueAt: string; isLate: boolean } | null;
  evidence: { snapshotId: string; asOfDate: string; cells: EvidenceCell[] } | null;
  history: Array<{ event: HistoryEvent; at: string; by: string | null; note: string | null }>;
}

export interface EvidenceCell {
  bucket: string;
  budgetLevel: string;
  planPmVnd: string;
  planLocalVnd: string;
  disbursedVnd: string | null;
  ratePmPct: string | null;
  rateTotalPct: string | null;
  nullReason: string | null;
  coverage: string;
}

function toCell(raw: unknown): EvidenceCell | undefined {
  if (!isRecord(raw) || text(raw.bucket) === '') return undefined;
  return {
    bucket: text(raw.bucket),
    budgetLevel: text(raw.budget_level),
    planPmVnd: text(raw.plan_pm_assigned_vnd),
    planLocalVnd: text(raw.plan_local_added_vnd),
    disbursedVnd: nullableText(raw.disbursed_treasury_vnd),
    ratePmPct: nullableText(raw.rate_pm_pct),
    rateTotalPct: nullableText(raw.rate_total_pct),
    nullReason: nullableText(raw.rate_null_reason),
    coverage: text(raw.treasury_coverage),
  };
}

/** A warning as the screens read it, or undefined when it lacks what makes it a warning: its id, its rule, its severity and its snapshot. */
export function toWarning(raw: unknown): WarningItem | undefined {
  if (!isRecord(raw) || !isRecord(raw.rule)) return undefined;
  const severity = oneOf(raw.severity, SEVERITIES);
  if (severity === undefined || text(raw.id) === '' || text(raw.rule.code) === '' || text(raw.snapshot_id) === '') return undefined;
  const project = isRecord(raw.project) && text(raw.project.id) !== '' ? { id: text(raw.project.id), code: text(raw.project.code), name: text(raw.project.name) } : null;
  const leader = isRecord(raw.leader) && text(raw.leader.membership_id) !== '' ? { membershipId: text(raw.leader.membership_id), displayName: text(raw.leader.display_name) } : null;
  const explanation = isRecord(raw.explanation) && text(raw.explanation.id) !== '' ? { id: text(raw.explanation.id), status: text(raw.explanation.status), dueAt: text(raw.explanation.due_at), isLate: raw.explanation.is_late === true } : null;
  const evidence = isRecord(raw.evidence) && text(raw.evidence.snapshot_id) !== '' ? { snapshotId: text(raw.evidence.snapshot_id), asOfDate: text(raw.evidence.as_of_date), cells: (Array.isArray(raw.evidence.cells) ? raw.evidence.cells : []).flatMap((cell) => toCell(cell) ?? []) } : null;
  return {
    id: text(raw.id),
    ruleCode: text(raw.rule.code),
    ruleName: text(raw.rule.name),
    metricCode: nullableText(raw.rule.metric_code),
    comparator: nullableText(raw.rule.comparator),
    threshold: isRecord(raw.rule.threshold) ? raw.rule.threshold : null,
    severity,
    status: text(raw.status),
    project,
    observed: isRecord(raw.observed) ? raw.observed : {},
    snapshotId: text(raw.snapshot_id),
    periodId: nullableText(raw.period_id),
    openedAt: text(raw.opened_at),
    closedAt: nullableText(raw.closed_at),
    resolutionReason: nullableText(raw.resolution_reason),
    version: typeof raw.version === 'number' ? raw.version : Number(raw.version) || 0,
    leader,
    explanation,
    evidence,
    history: (Array.isArray(raw.history) ? raw.history : []).flatMap((entry) => {
      const event = isRecord(entry) ? oneOf(entry.event, HISTORY_EVENTS) : undefined;
      return isRecord(entry) && event !== undefined && text(entry.at) !== '' ? [{ event, at: text(entry.at), by: nullableText(entry.by), note: nullableText(entry.note) }] : [];
    }),
  };
}

export interface WarningPage {
  items: WarningItem[];
  nextCursor: string | undefined;
}

export function toWarningPage(raw: unknown): WarningPage {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items.flatMap((item) => toWarning(item) ?? []) : [];
  return { items, nextCursor: isRecord(raw) && typeof raw.next_cursor === 'string' ? raw.next_cursor : undefined };
}

/** The observed value against the expected one, as the rule of the cumulative rate measured them (EW-01); null for a rule that measured something else. */
export function observedAgainstExpected(observed: Record<string, unknown>): { observed: string; expected: string } | null {
  const seen = observed.observed_pct;
  const expected = observed.expected_pct;
  return typeof seen === 'string' && typeof expected === 'string' ? { observed: trimmed(seen), expected: trimmed(expected) } : null;
}

/** A percent without the zeros of its decimals: 22.0000 is 22, 22.5000 is 22.5. */
export const trimmed = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

/** The glyph of a severity: text and an icon, never a colour alone. */
export const SEVERITY_GLYPH: Readonly<Record<Severity, string>> = { INFO: 'ℹ', WARNING: '⚠', CRITICAL: '⛔' };

export type WarningProblem = 'notFound' | 'general';
export const describeWarning = (error: unknown): WarningProblem => (error instanceof ApiError && error.code === 'RESOURCE_NOT_FOUND' ? 'notFound' : 'general');

// ---- the ranking ----

export const DENOMINATORS = ['PM_ASSIGNED', 'TOTAL_INCL_LOCAL'] as const;
export type Denominator = (typeof DENOMINATORS)[number];

export interface RankingRow {
  rank: number | null;
  unitId: string;
  unitCode: string;
  unitName: string;
  planVnd: string;
  disbursedVnd: string | null;
  ratePct: string | null;
  excludedReason: string | null;
}

export interface RankingTable {
  comparisonGroup: string;
  denominator: Denominator;
  ranked: RankingRow[];
  excluded: RankingRow[];
}

export interface Rankings {
  snapshotId: string;
  asOfDate: string;
  definitionStatus: string;
  legalRefs: string[];
  visibility: string;
  tables: RankingTable[];
}

function toRow(raw: unknown): RankingRow | undefined {
  if (!isRecord(raw) || !isRecord(raw.unit) || text(raw.unit.id) === '') return undefined;
  return {
    rank: typeof raw.rank === 'number' ? raw.rank : null,
    unitId: text(raw.unit.id),
    unitCode: text(raw.unit.code),
    unitName: text(raw.unit.name),
    planVnd: text(raw.plan_vnd),
    disbursedVnd: nullableText(raw.disbursed_vnd),
    ratePct: nullableText(raw.rate_pct),
    excludedReason: nullableText(raw.excluded_reason),
  };
}

/** The ranking as the screen reads it, or undefined when it lacks the snapshot or the day. */
export function toRankings(raw: unknown): Rankings | undefined {
  if (!isRecord(raw) || text(raw.snapshot_id) === '' || text(raw.as_of_date) === '') return undefined;
  const tables = (Array.isArray(raw.tables) ? raw.tables : []).flatMap((table): RankingTable[] => {
    const denominator = isRecord(table) ? oneOf(table.denominator_kind, DENOMINATORS) : undefined;
    if (!isRecord(table) || denominator === undefined || text(table.comparison_group) === '') return [];
    return [{ comparisonGroup: text(table.comparison_group), denominator, ranked: (Array.isArray(table.ranked) ? table.ranked : []).flatMap((row) => toRow(row) ?? []), excluded: (Array.isArray(table.excluded) ? table.excluded : []).flatMap((row) => toRow(row) ?? []) }];
  });
  return {
    snapshotId: text(raw.snapshot_id),
    asOfDate: text(raw.as_of_date),
    definitionStatus: text(raw.definition_status),
    legalRefs: (Array.isArray(raw.legal_confirmation_refs) ? raw.legal_confirmation_refs : []).filter((ref): ref is string => typeof ref === 'string'),
    visibility: text(raw.visibility),
    tables,
  };
}

/** The comparison groups of a ranking, in the order of its tables. */
export const groupsOf = (rankings: Pick<Rankings, 'tables'>): string[] => [...new Set(rankings.tables.map((table) => table.comparisonGroup))];

/** The tables of one denominator (the other is a table of its own and is never shown beside it as one), of a group when one is chosen. */
export const tablesFor = (rankings: Pick<Rankings, 'tables'>, denominator: Denominator, group: string): RankingTable[] => rankings.tables.filter((table) => table.denominator === denominator && (group === '' || table.comparisonGroup === group));
