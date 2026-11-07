/**
 * The analytics of the contract portfolio (CA-1, part 2; CTR-28 to CTR-31 and the register CTR-01): the shapes the server answers with, read defensively (a body that is not what the contract says is an error of the
 * read, never an empty table), and the words and figures a screen shows. Money is whole dong kept as text: nothing here turns it into a float, and no total is made in the browser (the server's totals row is shown).
 */

export const REPORT_CODES = ['portfolio-status', 'bid-variance', 'schedule-delay', 'payment-three-way', 'advance-ageing', 'retention-guarantee', 'change-growth', 'contractor-concentration'] as const;
export type ReportCode = (typeof REPORT_CODES)[number];
export const isReportCode = (value: unknown): value is ReportCode => typeof value === 'string' && (REPORT_CODES as readonly string[]).includes(value);

/** The permissions of the reads: the portfolio is read with the right to read contracts, the reports with the analytics right (the money columns also need `ledger.read`, which the server judges per contract). */
export const PORTFOLIO_PERMISSION = 'contract.read';
export const REPORT_PERMISSION = 'contract.analytics.read';

/** Where each report of the catalogue is opened: the screen of its own, or the hub with the report named. */
export const REPORT_PATHS: Readonly<Record<ReportCode, string>> = {
  'portfolio-status': '/ctr/ctr-29',
  'bid-variance': '/ctr/ctr-30',
  'contractor-concentration': '/ctr/ctr-31',
  'schedule-delay': '/ctr/ctr-28?report=schedule-delay',
  'payment-three-way': '/ctr/ctr-28?report=payment-three-way',
  'advance-ageing': '/ctr/ctr-28?report=advance-ageing',
  'retention-guarantee': '/ctr/ctr-28?report=retention-guarantee',
  'change-growth': '/ctr/ctr-28?report=change-growth',
};

/** A catalogue word as the lower-camel segment of an i18n key (`TWO_THREE` is `twoThree`, `bid-variance` is `bidVariance`, `D91_180` is `d91180`). */
export function camel(word: string): string {
  const parts = word.toLowerCase().split(/[_-]+/).filter((part) => part !== '');
  return parts.map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)).join('');
}

// ---- reading the answer ---------------------------------------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export type Cell = string | number | null;

export interface SnapshotRef {
  id: string;
  periodCode: string;
  revision: number;
  latestRevision: number;
  stale: boolean;
  cutoffDate: string;
  asOfDate: string;
  builtAt: string;
}

export interface Freshness {
  kind: 'LIVE' | 'SNAPSHOT';
  stale: boolean;
  snapshot: SnapshotRef | null;
  latest: SnapshotRef | null;
}

export interface AnalyticsContext {
  scope: 'PROVINCE' | 'GRANTED';
  asOf: string;
  cutoffDate: string | null;
  freshness: Freshness;
  rows: number | null;
  ledgerRows: number | null;
}

export function toSnapshotRef(raw: unknown): SnapshotRef | null {
  const row = asRecord(raw);
  const id = str(row?.id);
  const periodCode = str(row?.period_code);
  const revision = num(row?.revision);
  if (row === undefined || id === undefined || periodCode === undefined || revision === undefined) return null;
  return {
    id,
    periodCode,
    revision,
    latestRevision: num(row.latest_revision) ?? revision,
    stale: row.stale === true,
    cutoffDate: str(row.cutoff_date) ?? '',
    asOfDate: str(row.as_of_date) ?? '',
    builtAt: str(row.built_at) ?? '',
  };
}

export function toContext(raw: unknown): AnalyticsContext | undefined {
  const row = asRecord(raw);
  const fresh = asRecord(row?.freshness);
  const asOf = str(row?.as_of);
  if (row === undefined || fresh === undefined || asOf === undefined) return undefined;
  const kind = fresh.kind === 'SNAPSHOT' ? 'SNAPSHOT' : 'LIVE';
  return {
    scope: row.scope === 'GRANTED' ? 'GRANTED' : 'PROVINCE',
    asOf,
    cutoffDate: strOrNull(row.cutoff_date),
    freshness: { kind, stale: fresh.stale === true, snapshot: toSnapshotRef(fresh.snapshot), latest: toSnapshotRef(fresh.latest_snapshot) },
    rows: num(row.rows) ?? null,
    ledgerRows: num(row.ledger_rows) ?? null,
  };
}

export interface ColumnView {
  key: string;
  kind: string;
  ledger: boolean;
  indicator: string | null;
  total: string | null;
}

export interface IndicatorValue {
  code: string;
  value: string | null;
  status: string;
  reason: string | null;
  numerator: string | null;
  denominator: string | null;
}

export interface Definition {
  code: string;
  name: string;
  formula: string;
  numerator: string | null;
  denominator: string | null;
  unit: string;
  sourceTables: string[];
  nullPolicy: string;
}

export interface Health {
  level: string | null;
  drivers: string[];
}

export interface RowView {
  contractId: string;
  cells: Record<string, Cell>;
  na: Record<string, string>;
  health: Health | null;
}

export interface TotalsView {
  rows: number;
  ledgerRows: number;
  cells: Record<string, Cell>;
  na: Record<string, string>;
  indicators: IndicatorValue[];
}

export interface BreakdownGroup {
  key: string;
  totals: TotalsView;
}

export interface ReportView {
  code: string;
  ref: string;
  context: AnalyticsContext;
  columns: ColumnView[];
  items: RowView[];
  totals: TotalsView;
  breakdown: { dimension: string; groups: BreakdownGroup[] } | null;
  definitions: Definition[];
  nextCursor: string | null;
  evmStatus: string | null;
  paymentClock: { acceptanceToRequestDays: number; requestToTreasuryDays: number } | null;
}

const cells = (raw: unknown): Record<string, Cell> => {
  const out: Record<string, Cell> = {};
  for (const [key, value] of Object.entries(asRecord(raw) ?? {})) out[key] = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
  return out;
};

const reasons = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(raw) ?? {})) if (typeof value === 'string') out[key] = value;
  return out;
};

function toIndicator(raw: unknown): IndicatorValue[] {
  const row = asRecord(raw);
  const code = str(row?.code);
  return row === undefined || code === undefined ? [] : [{ code, value: strOrNull(row.value), status: str(row.status) ?? 'OK', reason: strOrNull(row.reason), numerator: strOrNull(row.numerator), denominator: strOrNull(row.denominator) }];
}

export function toTotals(raw: unknown): TotalsView | undefined {
  const row = asRecord(raw);
  const rows = num(row?.rows);
  if (row === undefined || rows === undefined) return undefined;
  return { rows, ledgerRows: num(row.ledger_rows) ?? rows, cells: cells(row.cells), na: reasons(row.na), indicators: list(row.indicators).flatMap(toIndicator) };
}

export function toDefinition(raw: unknown): Definition[] {
  const row = asRecord(raw);
  const code = str(row?.code);
  const formula = str(row?.formula);
  if (row === undefined || code === undefined || formula === undefined) return [];
  return [
    {
      code,
      name: str(row.name) ?? code,
      formula,
      numerator: strOrNull(row.numerator),
      denominator: strOrNull(row.denominator),
      unit: str(row.unit) ?? '',
      sourceTables: list(row.source_tables).filter((item): item is string => typeof item === 'string'),
      nullPolicy: str(row.null_policy) ?? '',
    },
  ];
}

function toRow(raw: unknown): RowView[] {
  const row = asRecord(raw);
  const contractId = str(row?.contract_id);
  if (row === undefined || contractId === undefined) return [];
  const health = asRecord(row.health);
  return [
    {
      contractId,
      cells: cells(row.cells),
      na: reasons(row.na),
      health: health === undefined ? null : { level: strOrNull(health.level), drivers: list(health.drivers).filter((item): item is string => typeof item === 'string') },
    },
  ];
}

/** The portfolio or a report R1 to R7; undefined when the body is not what the contract says (the screen shows the error state). */
export function toReportView(raw: unknown): ReportView | undefined {
  const body = asRecord(raw);
  const context = toContext(body?.context);
  const totals = toTotals(body?.totals);
  const code = str(body?.code);
  if (body === undefined || context === undefined || totals === undefined || code === undefined || !Array.isArray(body.items) || !Array.isArray(body.columns)) return undefined;
  const breakdown = asRecord(body.breakdown);
  const evm = asRecord(body.evm);
  const clock = asRecord(body.payment_clock);
  return {
    code,
    ref: str(body.ref) ?? '',
    context,
    columns: list(body.columns).flatMap((column): ColumnView[] => {
      const row = asRecord(column);
      const key = str(row?.key);
      return row === undefined || key === undefined ? [] : [{ key, kind: str(row.kind) ?? 'TEXT', ledger: row.ledger === true, indicator: strOrNull(row.indicator), total: strOrNull(row.total) }];
    }),
    items: list(body.items).flatMap(toRow),
    totals,
    breakdown:
      breakdown === undefined || str(breakdown.dimension) === undefined
        ? null
        : {
            dimension: str(breakdown.dimension) as string,
            groups: list(breakdown.groups).flatMap((group): BreakdownGroup[] => {
              const row = asRecord(group);
              const key = str(row?.key);
              const groupTotals = toTotals(row?.totals);
              return key === undefined || groupTotals === undefined ? [] : [{ key, totals: groupTotals }];
            }),
          },
    definitions: list(body.definitions).flatMap(toDefinition),
    nextCursor: strOrNull(body.next_cursor),
    evmStatus: evm === undefined ? null : (str(evm.status) ?? null),
    paymentClock:
      clock === undefined || num(clock.acceptance_to_request_days) === undefined || num(clock.request_to_treasury_days) === undefined
        ? null
        : { acceptanceToRequestDays: num(clock.acceptance_to_request_days) as number, requestToTreasuryDays: num(clock.request_to_treasury_days) as number },
  };
}

export interface FigureValue {
  value: string | null;
  status: string;
  reason: string | null;
  numerator: string | null;
  denominator: string | null;
}

export interface GroupView {
  key: string;
  name: string | null;
  valueVnd: string;
  sharePct: string;
}

export interface DimensionView {
  dimension: string;
  topN: number;
  totalVnd: string;
  level: string;
  topShare: FigureValue;
  hhi: FigureValue;
  shareAnomalies: string[];
  groups: GroupView[];
}

export interface ContractorLoadView {
  contractorId: string;
  name: string | null;
  activeContracts: number;
  activeValueVnd: string;
  sharePct: string;
  pendingAwardVnd: string;
}

export interface ConcentrationView {
  context: AnalyticsContext;
  rule: { version: number; source: string; params: Record<string, number | string> };
  activeContracts: number;
  activeValueVnd: string;
  dimensions: DimensionView[];
  singleBidder: FigureValue & { level: string };
  contractors: ContractorLoadView[];
  definitions: Definition[];
}

function toFigure(raw: unknown): FigureValue | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  return { value: strOrNull(row.value), status: str(row.status) ?? 'OK', reason: strOrNull(row.reason), numerator: strOrNull(row.numerator), denominator: strOrNull(row.denominator) };
}

/** The report R14; undefined when the body is not what the contract says. */
export function toConcentrationView(raw: unknown): ConcentrationView | undefined {
  const body = asRecord(raw);
  const context = toContext(body?.context);
  const rule = asRecord(body?.rule);
  const single = toFigure(body?.single_bidder);
  if (body === undefined || context === undefined || rule === undefined || single === undefined || !Array.isArray(body.dimensions) || !Array.isArray(body.contractors)) return undefined;
  const params: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(asRecord(rule.params) ?? {})) if (typeof value === 'number' || typeof value === 'string') params[key] = value;
  const dimensions = list(body.dimensions).flatMap((item): DimensionView[] => {
    const row = asRecord(item);
    const dimension = str(row?.dimension);
    const top = toFigure(row?.top_share);
    const hhi = toFigure(row?.hhi);
    if (row === undefined || dimension === undefined || top === undefined || hhi === undefined) return [];
    return [
      {
        dimension,
        topN: num(row.top_n) ?? 5,
        totalVnd: str(row.total_vnd) ?? '0',
        level: str(row.level) ?? 'NOT_ENOUGH_DATA',
        topShare: top,
        hhi,
        shareAnomalies: list(row.share_anomalies).filter((entry): entry is string => typeof entry === 'string'),
        groups: list(row.groups).flatMap((group): GroupView[] => {
          const entry = asRecord(group);
          const key = str(entry?.key);
          return entry === undefined || key === undefined ? [] : [{ key, name: strOrNull(entry.name), valueVnd: str(entry.value_vnd) ?? '0', sharePct: str(entry.share_pct) ?? '0.00' }];
        }),
      },
    ];
  });
  return {
    context,
    rule: { version: num(rule.version) ?? 0, source: str(rule.source) ?? 'DEFAULT', params },
    activeContracts: num(body.active_contracts) ?? 0,
    activeValueVnd: str(body.active_value_vnd) ?? '0',
    dimensions,
    singleBidder: { ...single, level: str(asRecord(body.single_bidder)?.level) ?? 'NOT_ENOUGH_DATA' },
    contractors: list(body.contractors).flatMap((item): ContractorLoadView[] => {
      const row = asRecord(item);
      const contractorId = str(row?.contractor_id);
      return row === undefined || contractorId === undefined
        ? []
        : [{ contractorId, name: strOrNull(row.name), activeContracts: num(row.active_contracts) ?? 0, activeValueVnd: str(row.active_value_vnd) ?? '0', sharePct: str(row.share_pct) ?? '0.00', pendingAwardVnd: str(row.pending_award_vnd) ?? '0' }];
    }),
    definitions: list(body.definitions).flatMap(toDefinition),
  };
}

export interface ReportFile {
  report: string;
  format: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  fileSha256: string;
  rowCount: number;
  stale: boolean;
  contentBase64: string;
}

export function toReportFile(raw: unknown): ReportFile | undefined {
  const row = asRecord(raw);
  const contentBase64 = str(row?.content_base64);
  const fileName = str(row?.file_name);
  const mediaType = str(row?.media_type);
  if (row === undefined || contentBase64 === undefined || fileName === undefined || mediaType === undefined) return undefined;
  return { report: str(row.report) ?? '', format: str(row.format) ?? '', fileName, mediaType, sizeBytes: num(row.size_bytes) ?? 0, fileSha256: str(row.file_sha256) ?? '', rowCount: num(row.row_count) ?? 0, stale: row.stale === true, contentBase64 };
}

/** The bytes of a file the server sent as base64. */
export function bytesOfBase64(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ---- the query of a read ----------------------------------------------------------------------------------------------------------------------------------

export interface AnalyticsFilter {
  unit: string;
  project: string;
  contractor: string;
  status: string;
  type: string;
  fund: string;
  q: string;
  asOf: string;
  period: string;
}

export const EMPTY_ANALYTICS_FILTER: AnalyticsFilter = { unit: '', project: '', contractor: '', status: '', type: '', fund: '', q: '', asOf: '', period: '' };

export interface AnalyticsQuery {
  filter: AnalyticsFilter;
  sort: string;
  direction: 'asc' | 'desc';
  limit: number;
  cursor: string | null;
}

export const DEFAULT_QUERY: AnalyticsQuery = { filter: EMPTY_ANALYTICS_FILTER, sort: 'code', direction: 'asc', limit: 50, cursor: null };

/** The query string parameters of a read: only what is chosen is sent, the day and the period are exclusive (a frozen period has its own day). */
export function queryParams(query: AnalyticsQuery, withPage = true): Record<string, string> {
  const { filter } = query;
  const out: Record<string, string> = {};
  for (const key of ['unit', 'project', 'contractor', 'status', 'type', 'fund'] as const) if (filter[key] !== '') out[key] = filter[key];
  if (filter.q.trim() !== '') out.q = filter.q.trim();
  if (filter.period !== '') out.period = filter.period;
  else if (filter.asOf !== '') out.as_of = filter.asOf;
  out.sort = query.sort;
  out.dir = query.direction;
  if (withPage) {
    out.limit = String(query.limit);
    if (query.cursor !== null) out.cursor = query.cursor;
  }
  return out;
}

export const filterCount = (filter: AnalyticsFilter): number => Object.values(filter).filter((value) => value.trim() !== '').length;

// ---- figures ---------------------------------------------------------------------------------------------------------------------------------------------

/** Whole dong grouped by the language of the screen, from the text (a sign is allowed: a variance can be below zero); anything that is not whole dong is shown as it came. */
export function moneyText(value: string, locale: string): string {
  return /^-?\d+$/.test(value) ? new Intl.NumberFormat(locale).format(BigInt(value)) : value;
}

/** A percent with two decimals from its text, with the decimal mark of the language. */
export function percentText(value: string, locale: string): string {
  return `${locale === 'vi' ? value.replace('.', ',') : value}%`;
}

/** `YYYY-MM-DD` as `dd/MM/yyyy`; other text as it came. */
export function dateText(value: string): string {
  const found = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return found === null ? value : `${found[3]}/${found[2]}/${found[1]}`;
}

/** The colour of a health level, as the tone of a pill. */
export const healthTone = (level: string | null): 'success' | 'warning' | 'danger' | 'neutral' => (level === 'GREEN' ? 'success' : level === 'AMBER' ? 'warning' : level === 'RED' ? 'danger' : 'neutral');

export const levelTone = (level: string): 'success' | 'warning' | 'danger' | 'neutral' => (level === 'GREEN' ? 'success' : level === 'AMBER' ? 'warning' : level === 'RED' ? 'danger' : 'neutral');

/** The number a bar of a chart stands for: the figure of a group as a plain number for the length of the bar only (never shown as the figure). */
export const barLength = (value: string | null): number => {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The breakdown of a report as points of a chart: a group with no figure for the column is left out (the table says it has none), never drawn as zero. */
export function breakdownPoints(view: ReportView, column: string): Array<{ key: string; value: number; text: Cell }> {
  if (view.breakdown === null) return [];
  return view.breakdown.groups.flatMap((group) => {
    const cell = group.totals.cells[column] ?? null;
    const value = cell === null ? Number.NaN : Number(cell);
    return Number.isFinite(value) ? [{ key: group.key, value, text: cell }] : [];
  });
}

/** The column the breakdown chart draws for a report: the first money column that sums, else the first count. */
export function chartColumn(view: ReportView): ColumnView | undefined {
  return view.columns.find((column) => column.kind === 'MONEY' && column.total === 'SUM' && !column.ledger) ?? view.columns.find((column) => column.kind === 'MONEY' && column.total === 'SUM') ?? view.columns.find((column) => column.kind === 'COUNT' && column.total === 'SUM');
}
