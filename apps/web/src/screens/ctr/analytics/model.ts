/**
 * The analytics of the contract portfolio (CA-1, part 2; CTR-28 to CTR-31 and the register CTR-01): the shapes the server answers with, read defensively (a body that is not what the contract says is an error of the
 * read, never an empty table), and the words and figures a screen shows. Money is whole dong kept as text: nothing here turns it into a float, and no total is made in the browser (the server's totals row is shown).
 */

/** The reports of the registers (CA-3): a row is a claim, a defect, an issue, a finding, or a contract rated or coloured. */
export const REGISTER_REPORT_CODES = ['claims-limitation', 'quality-defects', 'obstacles', 'audit-findings', 'performance-rating', 'contract-health'] as const;
export type RegisterReportCode = (typeof REGISTER_REPORT_CODES)[number];
export const isRegisterReport = (value: unknown): value is RegisterReportCode => typeof value === 'string' && (REGISTER_REPORT_CODES as readonly string[]).includes(value);

export const REPORT_CODES = ['portfolio-status', 'bid-variance', 'schedule-delay', 'payment-three-way', 'advance-ageing', 'retention-guarantee', 'change-growth', 'contractor-concentration', ...REGISTER_REPORT_CODES] as const;
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
  'claims-limitation': '/ctr/ctr-28?report=claims-limitation',
  'quality-defects': '/ctr/ctr-28?report=quality-defects',
  obstacles: '/ctr/ctr-28?report=obstacles',
  'audit-findings': '/ctr/ctr-28?report=audit-findings',
  'performance-rating': '/ctr/ctr-28?report=performance-rating',
  'contract-health': '/ctr/ctr-28?report=contract-health',
};

/** What each register report links to, besides itself: the screens that hold the detail (CTR-23 the scorecard, AUD-12 the payment integrity findings of G4-2, PAY-15 and PAY-16 the settlement). */
export const REPORT_LINKS: Readonly<Record<RegisterReportCode, ReadonlyArray<{ id: string; to: string }>>> = {
  'claims-limitation': [{ id: 'pay15', to: '/pay/pay-15' }],
  'quality-defects': [],
  obstacles: [],
  'audit-findings': [{ id: 'aud12', to: '/aud/aud-12' }],
  'performance-rating': [
    { id: 'ctr23', to: '/ctr/ctr-23' },
    { id: 'ctr32', to: '/ctr/ctr-32' },
  ],
  'contract-health': [
    { id: 'ctr23', to: '/ctr/ctr-23' },
    { id: 'aud12', to: '/aud/aud-12' },
    { id: 'pay15', to: '/pay/pay-15' },
    { id: 'pay16', to: '/pay/pay-16' },
  ],
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
  /** The id of the record of a register report (a claim, a defect, an issue, a finding); the contract for a report by contract. */
  recordId: string;
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

export interface Breakdown {
  dimension: string;
  groups: BreakdownGroup[];
}

/** A governance rule the report was judged by: which one, which version, where it came from, whether anybody confirmed it. */
export interface RuleUsed {
  type: string;
  version: number;
  source: string;
  unverified: boolean;
  params: Record<string, number | string>;
}

export interface EvmCoverage {
  contracts: number;
  covered: number;
  missing: Record<string, number>;
  v0Contracts: number;
}

export interface EvmFigures {
  bacVnd: string | null;
  pvVnd: string | null;
  evVnd: string | null;
  acVnd: string | null;
  svVnd: string | null;
  spi: IndicatorValue | null;
  cpi: IndicatorValue | null;
  ragSpi: string | null;
  ragCpi: string | null;
}

/** The earned value of the selection: figures and how many contracts have them, or why the block has none (NOT_IN_SNAPSHOT for a frozen period). */
export interface EvmView {
  status: 'OK' | 'UNAVAILABLE';
  reason: string | null;
  coverage: EvmCoverage | null;
  figures: EvmFigures | null;
}

export interface TierGroupView {
  key: string;
  count: number;
  deltaVnd: string | null;
  growth: IndicatorValue | null;
  shareOfGrowthPct: string | null;
  maxCumulativePct: string | null;
}

export interface TierSplitView {
  status: 'OK' | 'UNAVAILABLE';
  reason: string | null;
  originalValueVnd: string;
  totalDeltaVnd: string;
  totalCount: number;
  groups: TierGroupView[];
}

export interface LadderStep {
  key: string;
  count: number;
  amountVnd: string;
}

export interface LadderView {
  status: 'OK' | 'UNAVAILABLE';
  reason: string | null;
  retention: LadderStep[];
  guarantee: LadderStep[];
}

export interface ReportView {
  code: string;
  ref: string;
  context: AnalyticsContext;
  columns: ColumnView[];
  items: RowView[];
  totals: TotalsView;
  breakdown: { dimension: string; groups: BreakdownGroup[] } | null;
  breakdowns: Breakdown[];
  rules: RuleUsed[];
  definitions: Definition[];
  nextCursor: string | null;
  evm: EvmView | null;
  tierSplit: TierSplitView | null;
  ladders: LadderView | null;
  paymentClock: { acceptanceToRequestDays: number; requestToTreasuryDays: number } | null;
  /** The coverage notes of a register report (for example the open issues of the projects that name no contract). */
  notes: Record<string, number | string>;
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
      recordId: str(row.record_id) ?? contractId,
      cells: cells(row.cells),
      na: reasons(row.na),
      health: health === undefined ? null : { level: strOrNull(health.level), drivers: list(health.drivers).filter((item): item is string => typeof item === 'string') },
    },
  ];
}

const toBreakdown = (raw: unknown): Breakdown[] => {
  const breakdown = asRecord(raw);
  const dimension = str(breakdown?.dimension);
  if (breakdown === undefined || dimension === undefined) return [];
  return [
    {
      dimension,
      groups: list(breakdown.groups).flatMap((group): BreakdownGroup[] => {
        const row = asRecord(group);
        const key = str(row?.key);
        const groupTotals = toTotals(row?.totals);
        return key === undefined || groupTotals === undefined ? [] : [{ key, totals: groupTotals }];
      }),
    },
  ];
};

function toRule(raw: unknown): RuleUsed[] {
  const row = asRecord(raw);
  const type = str(row?.type);
  if (row === undefined || type === undefined) return [];
  const params: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(asRecord(row.params) ?? {})) if (typeof value === 'number' || typeof value === 'string') params[key] = value;
  return [{ type, version: num(row.version) ?? 0, source: str(row.source) ?? 'DEFAULT', unverified: row.unverified !== false, params }];
}

const toOne = (raw: unknown): IndicatorValue | null => toIndicator(raw)[0] ?? null;

/** The earned value block of the schedule report and of the S-curve answer. */
export function toEvmView(raw: unknown): EvmView | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const status = row.status === 'OK' ? 'OK' : 'UNAVAILABLE';
  const coverage = asRecord(row.coverage);
  const figures = asRecord(row.figures);
  const missing: Record<string, number> = {};
  for (const [key, value] of Object.entries(asRecord(coverage?.missing) ?? {})) if (typeof value === 'number') missing[key] = value;
  return {
    status,
    reason: strOrNull(row.reason),
    coverage: coverage === undefined ? null : { contracts: num(coverage.contracts) ?? 0, covered: num(coverage.covered) ?? 0, missing, v0Contracts: num(coverage.v0_contracts) ?? 0 },
    figures:
      figures === undefined
        ? null
        : {
            bacVnd: strOrNull(figures.bac_vnd),
            pvVnd: strOrNull(figures.pv_vnd),
            evVnd: strOrNull(figures.ev_vnd),
            acVnd: strOrNull(figures.ac_vnd),
            svVnd: strOrNull(figures.sv_vnd),
            spi: toOne(figures.spi),
            cpi: toOne(figures.cpi),
            ragSpi: strOrNull(figures.rag_spi),
            ragCpi: strOrNull(figures.rag_cpi),
          },
  };
}

function toTierSplit(raw: unknown): TierSplitView | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  if (row.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: strOrNull(row.reason), originalValueVnd: '0', totalDeltaVnd: '0', totalCount: 0, groups: [] };
  const original = str(row.original_value_vnd);
  const total = str(row.total_delta_vnd);
  if (original === undefined || total === undefined || !Array.isArray(row.groups)) return null;
  return {
    status: 'OK',
    reason: null,
    originalValueVnd: original,
    totalDeltaVnd: total,
    totalCount: num(row.total_count) ?? 0,
    groups: list(row.groups).flatMap((group): TierGroupView[] => {
      const one = asRecord(group);
      const key = str(one?.key);
      return one === undefined || key === undefined
        ? []
        : [{ key, count: num(one.count) ?? 0, deltaVnd: strOrNull(one.delta_vnd), growth: toOne(one.growth), shareOfGrowthPct: strOrNull(one.share_of_growth_pct), maxCumulativePct: strOrNull(one.max_cumulative_variation_pct) }];
    }),
  };
}

const toSteps = (raw: unknown): LadderStep[] =>
  list(raw).flatMap((step): LadderStep[] => {
    const one = asRecord(step);
    const key = str(one?.key);
    return one === undefined || key === undefined ? [] : [{ key, count: num(one.count) ?? 0, amountVnd: str(one.amount_vnd) ?? '0' }];
  });

function toLadders(raw: unknown): LadderView | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  if (row.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: strOrNull(row.reason), retention: [], guarantee: [] };
  if (!Array.isArray(row.retention) || !Array.isArray(row.guarantee)) return null;
  return { status: 'OK', reason: null, retention: toSteps(row.retention), guarantee: toSteps(row.guarantee) };
}

export interface CurvePointView {
  day: string;
  pvV0Vnd: string | null;
  pvCurrentVnd: string;
  evVnd: string | null;
  acVnd: string | null;
}

export interface CurveView {
  evm: EvmView;
  asOf: string;
  contracts: number;
  v0Complete: boolean;
  points: CurvePointView[];
}

/** The S-curve answer of the schedule report; undefined when the body is not what the contract says. */
export function toCurveView(raw: unknown): CurveView | undefined {
  const body = asRecord(raw);
  const evm = toEvmView(body?.evm);
  const curve = asRecord(body?.curve);
  if (body === undefined || evm === null || curve === undefined || !Array.isArray(curve.points)) return undefined;
  return {
    evm,
    asOf: str(curve.as_of) ?? '',
    contracts: num(curve.contracts) ?? 0,
    v0Complete: curve.v0_complete === true,
    points: list(curve.points).flatMap((point): CurvePointView[] => {
      const one = asRecord(point);
      const day = str(one?.day);
      const current = str(one?.pv_current_vnd);
      return one === undefined || day === undefined || current === undefined ? [] : [{ day, pvV0Vnd: strOrNull(one.pv_v0_vnd), pvCurrentVnd: current, evVnd: strOrNull(one.ev_vnd), acVnd: strOrNull(one.ac_vnd) }];
    }),
  };
}

/** The portfolio or a report R1 to R7; undefined when the body is not what the contract says (the screen shows the error state). */
const toNotes = (raw: unknown): Record<string, number | string> => {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(asRecord(raw) ?? {})) if (typeof value === 'number' || typeof value === 'string') out[key] = value;
  return out;
};

export function toReportView(raw: unknown): ReportView | undefined {
  const body = asRecord(raw);
  const context = toContext(body?.context);
  const totals = toTotals(body?.totals);
  const code = str(body?.code);
  if (body === undefined || context === undefined || totals === undefined || code === undefined || !Array.isArray(body.items) || !Array.isArray(body.columns)) return undefined;
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
    breakdown: toBreakdown(body.breakdown)[0] ?? null,
    breakdowns: Array.isArray(body.breakdowns) ? list(body.breakdowns).flatMap(toBreakdown) : toBreakdown(body.breakdown),
    rules: list(body.rules).flatMap(toRule),
    definitions: list(body.definitions).flatMap(toDefinition),
    nextCursor: strOrNull(body.next_cursor),
    evm: toEvmView(body.evm),
    tierSplit: toTierSplit(body.tier_split),
    ladders: toLadders(body.ladders),
    notes: toNotes(body.notes),
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
  /** The severity and the state of the record: filters of the register reports. */
  severity: string;
  state: string;
}

export const EMPTY_ANALYTICS_FILTER: AnalyticsFilter = { unit: '', project: '', contractor: '', status: '', type: '', fund: '', q: '', asOf: '', period: '', severity: '', state: '' };

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
  if (filter.severity !== '') out.severity = filter.severity;
  if (filter.state !== '') out.state = filter.state;
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

/** Whole dong as billions for the picture only (never shown as a figure); null for what is not whole dong. */
export function billionsOf(value: string | null): number | null {
  if (value === null || !/^-?\d{1,24}$/.test(value)) return null;
  return Number(BigInt(value)) / 1e9;
}

/** A decimal figure (an index of four places) with the decimal mark of the language. */
export const decimalText = (value: string, locale: string): string => (locale === 'vi' ? value.replace('.', ',') : value);

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
export function breakdownPoints(view: ReportView, column: string, dimension?: string): Array<{ key: string; value: number; text: Cell }> {
  const breakdown = dimension === undefined ? view.breakdown : (view.breakdowns.find((one) => one.dimension === dimension) ?? null);
  if (breakdown === null) return [];
  return breakdown.groups.flatMap((group) => {
    if (column === ROWS) return [{ key: group.key, value: group.totals.rows, text: String(group.totals.rows) }];
    const cell = group.totals.cells[column] ?? null;
    const value = cell === null ? Number.NaN : Number(cell);
    return Number.isFinite(value) ? [{ key: group.key, value, text: cell }] : [];
  });
}

/** The column a breakdown of a report draws when the report says which one tells the story of its groups (the age of an advance is told by what is outstanding, not by what was lent). */
/** The "column" of a chart of how many rows a group has (a count of the records, which no column of the table holds). */
export const ROWS = '$rows';
const CHART_COLUMN: Readonly<Record<string, string>> = {
  'schedule-delay:delay_band': 'earned_value_vnd',
  'payment-three-way:match_status': 'paid_vnd',
  'advance-ageing:age_bucket': 'advance_outstanding_vnd',
  'advance-ageing:recovery_status': 'advance_recovery_shortfall_vnd',
  'retention-guarantee:contract_status': 'retention_held_vnd',
  'change-growth:change_tier': 'approved_change_delta_vnd',
  'claims-limitation:claim_status': 'claimed_amount_vnd',
  'claims-limitation:limitation_status': ROWS,
  'quality-defects:severity': ROWS,
  'quality-defects:ncr_status': ROWS,
  'obstacles:severity': ROWS,
  'obstacles:issue_status': ROWS,
  'audit-findings:severity': 'recommended_vnd',
  'audit-findings:finding_category': 'recommended_vnd',
  'performance-rating:proposed_rating': ROWS,
  'performance-rating:rating_status': ROWS,
  'contract-health:health': ROWS,
  'contract-health:contract_status': ROWS,
};

/** The column the breakdown chart draws for a report: the one the report names, else the first money column that sums, else the first count. */
export function chartColumn(view: ReportView, dimension?: string): ColumnView | undefined {
  const wanted = dimension === undefined ? undefined : CHART_COLUMN[`${view.code}:${dimension}`];
  if (wanted === ROWS) return { key: ROWS, kind: 'COUNT', ledger: false, indicator: null, total: 'SUM' };
  const named = view.columns.find((column) => column.key === wanted);
  return named ?? view.columns.find((column) => column.kind === 'MONEY' && column.total === 'SUM' && !column.ledger) ?? view.columns.find((column) => column.kind === 'MONEY' && column.total === 'SUM') ?? view.columns.find((column) => column.kind === 'COUNT' && column.total === 'SUM');
}
