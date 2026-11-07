import { ApiError } from '@machvon/api-client';

/** The screens a leader goes on to from the command center. */
export const SNAPSHOT_SCREEN_PATH = '/dis/dis-21';
export const WARNINGS_PATH = '/home/home-03';
export const MY_WORK_PATH = '/home/home-02';
export const DRILL_PATH = '/home/home-10';
export const REALLOCATION_PATH = '/cap/cap-19';
export const READ_PERMISSION = 'home.read';
/** The terms the formulas are proposals under until the business owner signs them. */
export const FORMULA_REFERENCE = 'CXN-03';
/** How often the screen asks, in the background, whether a newer snapshot was frozen (it never changes the figures on its own). */
export const NEW_SNAPSHOT_POLL_MS = 60_000;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

export const FRESHNESS = ['FRESH', 'STALE'] as const;
export type Freshness = (typeof FRESHNESS)[number];
export const TILE_UNITS = ['PERCENT', 'VND'] as const;
export type TileUnit = (typeof TILE_UNITS)[number];
export const QUALITY_BADGES = ['NOT_ASSESSED', 'OK', 'WARN', 'FAIL'] as const;
export type QualityBadge = (typeof QUALITY_BADGES)[number];

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);

/** The flags that sit on a figure, most important first (G0-4): each is said in words, never by colour alone. */
export const FIGURE_FLAGS = ['NO_DATA', 'NOT_CERTIFIED', 'OBSOLETE', 'STALE', 'PARTIAL_COVERAGE', 'UNVERIFIED_DEFINITION'] as const;
export type FigureFlag = (typeof FIGURE_FLAGS)[number];
export const CERT_STATUSES = ['DRAFT', 'CONFIRMED', 'CERTIFIED', 'OBSOLETE'] as const;
export type CertStatus = (typeof CERT_STATUSES)[number];
/** A counted figure (the waiting counts) is a figure of the register too. */
export type FigureUnit = TileUnit | 'COUNT';

export interface FigureCertification {
  status: CertStatus;
  version: number;
  origin: 'PLATFORM' | 'TENANT';
  certifiedBy: string | null;
  at: string | null;
}

/** The definition behind a figure, as the register gives it (camelCase as the server serializes it): what the "i" of the figure opens. */
export interface KpiInfo {
  code: string;
  name: string;
  formula: string;
  numerator: string | null;
  denominator: string | null;
  exclusions: string[];
  unit: string;
  period: string;
  source: string;
  owner: string;
  allowedLagDays: number;
  version: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  origin: 'RULE' | 'DEFAULT';
  unverified: boolean;
  asOf: string;
  snapshotId: string | null;
}

/** One figure of the command center, with what makes it citable: its numerator and denominator, its formula and its signed token. `displayValue` is THE text of the figure (the server writes it once for every channel). */
export interface Tile {
  metricCode: string;
  value: string | null;
  /** The text every channel writes for the figure; null when there is no figure (never shown as 0). */
  displayValue: string | null;
  numerator: string | null;
  denominator: string | null;
  nullReason: string | null;
  unit: FigureUnit;
  formula: string;
  definitionStatus: string;
  /** Empty for a counted figure: it has no drill. */
  contextToken: string;
  flags: FigureFlag[];
  certification: FigureCertification | null;
  kpi: KpiInfo | null;
}

export interface CommandCenter {
  snapshotId: string;
  asOfDate: string;
  treasuryCutoffDate: string;
  freshness: Freshness;
  definitionStatus: string;
  legalRefs: string[];
  scope: { unitId: string | null; projects: number; hash: string };
  tiles: Tile[];
  projectsWithoutData: number;
  /** The three waiting counts as figures of the register (each with its own "i"): always the three, in this order. */
  countTiles: Tile[];
  openWarnings: number;
  overdueExplanations: number;
  pendingReallocations: number;
  qualityBadge: QualityBadge;
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

function toCertification(raw: unknown): FigureCertification | null {
  if (!isRecord(raw)) return null;
  const status = oneOf(raw.status, CERT_STATUSES);
  if (status === undefined) return null;
  return { status, version: count(raw.version), origin: raw.origin === 'TENANT' ? 'TENANT' : 'PLATFORM', certifiedBy: nullableText(raw.certified_by), at: nullableText(raw.at) };
}

/** The definition behind a figure (camelCase inside, as the server serializes it); without a code and a formula there is nothing to open. */
export function toKpiInfo(raw: unknown): KpiInfo | null {
  if (!isRecord(raw) || text(raw.code) === '' || text(raw.formula) === '') return null;
  return {
    code: text(raw.code),
    name: text(raw.name) === '' ? text(raw.code) : text(raw.name),
    formula: text(raw.formula),
    numerator: nullableText(raw.numerator),
    denominator: nullableText(raw.denominator),
    exclusions: stringList(raw.exclusions),
    unit: text(raw.unit),
    period: text(raw.period),
    source: text(raw.source),
    owner: text(raw.owner),
    allowedLagDays: count(raw.allowedLagDays),
    version: count(raw.version),
    effectiveFrom: nullableText(raw.effectiveFrom),
    effectiveTo: nullableText(raw.effectiveTo),
    origin: raw.origin === 'DEFAULT' ? 'DEFAULT' : 'RULE',
    unverified: raw.unverified === true,
    asOf: text(raw.asOf),
    snapshotId: nullableText(raw.snapshotId),
  };
}

/** What a figure says beyond its value: the flags the server set (the ones it names, in its order), the certification and the definition. A server that does not send them (an older one) gives none. */
function figureExtras(raw: Raw): Pick<Tile, 'flags' | 'certification' | 'kpi'> {
  return { flags: stringList(raw.flags).flatMap((flag) => oneOf(flag, FIGURE_FLAGS) ?? []), certification: toCertification(raw.certification), kpi: toKpiInfo(raw.kpi) };
}

/** The text of a figure as the server wrote it. An answer that has no `display_value` at all (an older server) falls back to `value`; an explicit null stays null (it is never turned into 0). */
const displayOf = (raw: Raw): string | null => ('display_value' in raw ? nullableText(raw.display_value) : nullableText(raw.value));

function toTile(raw: unknown): Tile | undefined {
  if (!isRecord(raw)) return undefined;
  const unit = oneOf(raw.unit, TILE_UNITS);
  const metricCode = text(raw.metric_code);
  // A tile without its formula, unit or token is not a citable figure (BR-HOME-01): it is not shown.
  if (unit === undefined || metricCode === '' || text(raw.formula) === '' || text(raw.context_token) === '') return undefined;
  return {
    metricCode,
    value: nullableText(raw.value),
    displayValue: displayOf(raw),
    numerator: nullableText(raw.numerator),
    denominator: nullableText(raw.denominator),
    nullReason: nullableText(raw.null_reason),
    unit,
    formula: text(raw.formula),
    definitionStatus: text(raw.definition_status),
    contextToken: text(raw.context_token),
    ...figureExtras(raw),
  };
}

/** The three counts that wait for someone, as figures. */
export const COUNT_CODES = ['OPEN_WARNINGS', 'OVERDUE_EXPLANATIONS', 'PENDING_REALLOCATIONS'] as const;
export type CountCode = (typeof COUNT_CODES)[number];

function toCountTile(raw: unknown, code: CountCode, fallback: number): Tile {
  if (isRecord(raw) && raw.metric_code === code) {
    return {
      metricCode: code,
      value: nullableText(raw.value),
      displayValue: displayOf(raw),
      numerator: nullableText(raw.numerator),
      denominator: nullableText(raw.denominator),
      nullReason: nullableText(raw.null_reason),
      unit: 'COUNT',
      formula: text(raw.formula),
      definitionStatus: text(raw.definition_status),
      contextToken: '',
      ...figureExtras(raw),
    };
  }
  // The server did not send this count as a figure (an older answer): it is the number it counted, with no definition behind it.
  return { metricCode: code, value: String(fallback), displayValue: String(fallback), numerator: String(fallback), denominator: null, nullReason: null, unit: 'COUNT', formula: '', definitionStatus: '', contextToken: '', flags: [], certification: null, kpi: null };
}

/** The text a figure is shown as: exactly the server's `display_value`. When there is none it is `none` (the words of the caller: why there is no figure), never "0" and never a text made from `value`. */
export function figureText(tile: Pick<Tile, 'displayValue'>, none = '—'): string {
  return tile.displayValue ?? none;
}

/** Why a figure has no text, as a code: the reason the server gave, else the strongest flag that says so, else no data. */
export function figureReason(tile: Pick<Tile, 'nullReason' | 'flags'>): string {
  if (tile.nullReason !== null) return tile.nullReason;
  return tile.flags.find((flag) => flag === 'NO_DATA' || flag === 'NOT_CERTIFIED' || flag === 'OBSOLETE') ?? 'NO_DATA';
}

function countTilesOf(raw: Raw): Tile[] {
  const given = Array.isArray(raw.count_tiles) ? raw.count_tiles : [];
  const numbers: Record<CountCode, number> = { OPEN_WARNINGS: count(raw.open_warnings), OVERDUE_EXPLANATIONS: count(raw.overdue_explanations), PENDING_REALLOCATIONS: count(raw.pending_reallocations) };
  return COUNT_CODES.map((code) => toCountTile(given.find((entry) => isRecord(entry) && entry.metric_code === code), code, numbers[code]));
}

/** The command center as the screen reads it, or undefined when the answer lacks what makes a figure citable: the snapshot, the day, the scope or the definition. */
export function toCommandCenter(raw: unknown): CommandCenter | undefined {
  if (!isRecord(raw) || !isRecord(raw.scope)) return undefined;
  const freshness = oneOf(raw.freshness, FRESHNESS);
  const snapshotId = text(raw.snapshot_id);
  const asOfDate = text(raw.as_of_date);
  if (freshness === undefined || snapshotId === '' || asOfDate === '' || text(raw.definition_status) === '') return undefined;
  return {
    snapshotId,
    asOfDate,
    treasuryCutoffDate: text(raw.treasury_cutoff_date),
    freshness,
    definitionStatus: text(raw.definition_status),
    legalRefs: Array.isArray(raw.legal_confirmation_refs) ? raw.legal_confirmation_refs.filter((ref): ref is string => typeof ref === 'string') : [],
    scope: { unitId: nullableText(raw.scope.unit_id), projects: count(raw.scope.projects), hash: text(raw.scope.scope_hash) },
    tiles: (Array.isArray(raw.tiles) ? raw.tiles : []).flatMap((tile) => toTile(tile) ?? []),
    projectsWithoutData: count(raw.projects_without_data),
    countTiles: countTilesOf(raw),
    openWarnings: count(raw.open_warnings),
    overdueExplanations: count(raw.overdue_explanations),
    pendingReallocations: count(raw.pending_reallocations),
    qualityBadge: oneOf(raw.quality_badge, QUALITY_BADGES) ?? 'NOT_ASSESSED',
  };
}

/** A snapshot older than this many days is stale (the same limit as the server's). */
export const STALE_AFTER_DAYS = 8;

/**
 * Whether the snapshot on the screen is stale: the server said so when it was read, or it has aged past the limit since (a page that stays open does not keep a snapshot fresh). Once stale it stays stale, whatever
 * the clock of this device says.
 */
export function isStale(center: Pick<CommandCenter, 'freshness' | 'asOfDate'>, today: string): boolean {
  if (center.freshness === 'STALE') return true;
  const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${center.asOfDate}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(days) && days > STALE_AFTER_DAYS;
}

/** What waits for someone: counted when it is asked, not by the snapshot, so it moves while the figures of the snapshot stand. */
export interface WaitingCounts {
  openWarnings: number;
  overdueExplanations: number;
  pendingReallocations: number;
}

export const waitingOf = (center: WaitingCounts): WaitingCounts => ({ openWarnings: center.openWarnings, overdueExplanations: center.overdueExplanations, pendingReallocations: center.pendingReallocations });

/** The count figure of a code among the three of a reading. */
export const countTileOf = (tiles: readonly Tile[], code: CountCode): Tile | undefined => tiles.find((tile) => tile.metricCode === code);

/** The two rates, always together: either both tiles are there or neither is shown as a pair. */
export function ratePair(center: Pick<CommandCenter, 'tiles'>): { pm: Tile; total: Tile } | undefined {
  const pm = center.tiles.find((tile) => tile.metricCode === 'DISBURSEMENT_RATE_PM');
  const total = center.tiles.find((tile) => tile.metricCode === 'DISBURSEMENT_RATE_TOTAL');
  return pm === undefined || total === undefined ? undefined : { pm, total };
}

/** The tiles that are amounts, in the order the server gave them. */
export const amountTiles = (center: Pick<CommandCenter, 'tiles'>): Tile[] => center.tiles.filter((tile) => tile.unit === 'VND');

/** The first and the last characters of a snapshot id: enough to cite it, the whole of it is in the title of the cell. */
export const shortId = (id: string): string => (id.length <= 13 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`);

/** Whether the latest snapshot that the server holds is a newer one than the screen shows: a banner offers the refresh, and the figures stay as they are. */
export const hasNewSnapshot = (shown: string | undefined, latest: string | undefined): boolean => shown !== undefined && latest !== undefined && shown !== latest;

/** A refusal of the right to read (403) or the end of the session (401): what a background reading must not hide, as a network failure it may. */
export const isAuthFailure = (error: unknown): boolean => error instanceof ApiError && (error.status === 403 || error.code === 'SESSION_EXPIRED');

export type HomeProblem = 'noSnapshot' | 'notFrozen' | 'unitDenied' | 'unavailable' | 'validation' | 'general';

/** What a failure of the command center is, for the words of the screen: nothing frozen yet is its own state (a link to the snapshots), not an error. */
export function describeCommandCenter(error: unknown): HomeProblem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'RESOURCE_NOT_FOUND':
      return 'noSnapshot';
    case 'SNAPSHOT_NOT_FROZEN':
      return 'notFrozen';
    case 'SCOPE_DENIED':
      return 'unitDenied';
    case 'METRIC_UNAVAILABLE':
      return 'unavailable';
    case 'VALIDATION_FAILED':
      return 'validation';
    default:
      return 'general';
  }
}

/** The path of the drill of a tile: the signed token says what is asked, and the page judges the scope again. */
export const drillPathOf = (tile: Pick<Tile, 'contextToken'>): string => `${DRILL_PATH}?${new URLSearchParams({ token: tile.contextToken }).toString()}`;
