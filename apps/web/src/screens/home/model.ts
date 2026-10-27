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

/** One figure of the command center, with what makes it citable: its numerator and denominator, its formula and its signed token. */
export interface Tile {
  metricCode: string;
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  nullReason: string | null;
  unit: TileUnit;
  formula: string;
  definitionStatus: string;
  contextToken: string;
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
  openWarnings: number;
  overdueExplanations: number;
  pendingReallocations: number;
  qualityBadge: QualityBadge;
}

function toTile(raw: unknown): Tile | undefined {
  if (!isRecord(raw)) return undefined;
  const unit = oneOf(raw.unit, TILE_UNITS);
  const metricCode = text(raw.metric_code);
  // A tile without its formula, unit or token is not a citable figure (BR-HOME-01): it is not shown.
  if (unit === undefined || metricCode === '' || text(raw.formula) === '' || text(raw.context_token) === '') return undefined;
  return {
    metricCode,
    value: nullableText(raw.value),
    numerator: nullableText(raw.numerator),
    denominator: nullableText(raw.denominator),
    nullReason: nullableText(raw.null_reason),
    unit,
    formula: text(raw.formula),
    definitionStatus: text(raw.definition_status),
    contextToken: text(raw.context_token),
  };
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
