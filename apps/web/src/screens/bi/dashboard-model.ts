import { ApiError } from '@machvon/api-client';

export const MANAGE_DASHBOARD_PERMISSION = 'bi.dashboard.manage';
export const LIBRARY_PATH = '/bi/bi-01';
export const BUILDER_PATH = '/bi/bi-03';
export const CHART_PATH = '/bi/bi-04';

export const WIDGET_KINDS = ['KPI', 'BAR', 'LINE', 'AREA', 'PIE', 'TABLE'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];
export const DASHBOARD_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type DashboardStatus = (typeof DASHBOARD_STATUSES)[number];
export const AUDIENCES = ['PRIVATE', 'SHARED', 'TENANT_LIBRARY'] as const;
export type Audience = (typeof AUDIENCES)[number];
export const VERSION_STATES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED'] as const;
export type VersionState = (typeof VERSION_STATES)[number];
export const BREAKPOINTS = ['sm', 'md', 'lg', 'xl'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];
export const POLICIES = ['LATEST_FROZEN', 'PINNED'] as const;
export type DatasetPolicy = (typeof POLICIES)[number];

/** The limits the server judges the draft by (BI 3 F5); the screen tells a value outside them before it is sent. */
export const GRID_COLUMNS = 12;
export const MAX_ROWS = 50;
export const MAX_WIDGETS = 100;
export const BREAKPOINT_RANGE = { min: 320, max: 4000 } as const;
const CODE = /^[a-z][a-z0-9_]{1,59}$/;
const WIDGET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DASHBOARD_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,79}$/;
const WHOLE = /^\d{1,6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

export interface Widget {
  id: string;
  kind: WidgetKind;
  title: string | null;
  metricVersionId: string;
  dimensionCode: string | null;
  grid: { x: number; y: number; w: number; h: number };
}

export interface DashboardVersion {
  id: string;
  revision: number;
  status: VersionState;
  columns: number;
  widgets: Widget[];
  metricVersionIds: string[];
  filterMappings: Record<string, string>;
  breakpoints: Partial<Record<Breakpoint, number>>;
  policy: DatasetPolicy;
  pinnedDatasetVersionIds: string[];
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface Dashboard {
  id: string;
  code: string;
  title: string;
  ownerId: string;
  ownerName: string | null;
  audience: Audience;
  status: DashboardStatus;
  current: { id: string | null; revision: number; status: VersionState; metricCount: number; metricsCertified: boolean } | null;
  mine: boolean;
  mayEdit: boolean;
  version: number;
  versions: DashboardVersion[];
}

function widgetOf(raw: unknown): Widget[] {
  if (!isRecord(raw)) return [];
  const grid = isRecord(raw.grid) ? raw.grid : {};
  return [
    {
      id: text(raw.id),
      kind: oneOf(raw.kind, WIDGET_KINDS, 'TABLE'),
      title: nullableText(raw.title),
      metricVersionId: text(raw.metric_version_id),
      dimensionCode: nullableText(raw.dimension_code),
      grid: { x: count(grid.x), y: count(grid.y), w: count(grid.w), h: count(grid.h) },
    },
  ];
}

export function toVersion(raw: unknown): DashboardVersion | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const layout = isRecord(raw.layout_json) ? raw.layout_json : {};
  const breakpoints: Partial<Record<Breakpoint, number>> = {};
  if (isRecord(raw.breakpoints)) for (const key of BREAKPOINTS) if (typeof raw.breakpoints[key] === 'number') breakpoints[key] = raw.breakpoints[key] as number;
  const filters: Record<string, string> = {};
  if (isRecord(raw.filter_mappings)) for (const [key, value] of Object.entries(raw.filter_mappings)) if (typeof value === 'string') filters[key] = value;
  return {
    id: raw.id,
    revision: count(raw.revision),
    status: oneOf(raw.status, VERSION_STATES, 'DRAFT'),
    columns: typeof layout.columns === 'number' ? layout.columns : GRID_COLUMNS,
    widgets: Array.isArray(layout.widgets) ? layout.widgets.flatMap(widgetOf) : [],
    metricVersionIds: Array.isArray(raw.metric_versions) ? raw.metric_versions.filter((id): id is string => typeof id === 'string') : [],
    filterMappings: filters,
    breakpoints,
    policy: oneOf(raw.dataset_version_policy, POLICIES, 'LATEST_FROZEN'),
    pinnedDatasetVersionIds: Array.isArray(raw.pinned_dataset_version_ids) ? raw.pinned_dataset_version_ids.filter((id): id is string => typeof id === 'string') : [],
    createdBy: text(raw.created_by),
    createdAt: text(raw.created_at),
    publishedAt: nullableText(raw.published_at),
  };
}

export function toDashboard(raw: unknown): Dashboard | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.code !== 'string') return undefined;
  const owner = isRecord(raw.owner) ? raw.owner : {};
  const current = isRecord(raw.current_version) ? raw.current_version : undefined;
  return {
    id: raw.id,
    code: raw.code,
    title: text(raw.title),
    ownerId: text(owner.id),
    ownerName: nullableText(owner.name),
    audience: oneOf(raw.audience, AUDIENCES, 'PRIVATE'),
    status: oneOf(raw.status, DASHBOARD_STATUSES, 'DRAFT'),
    current:
      current === undefined
        ? null
        : { id: nullableText(current.id), revision: count(current.revision), status: oneOf(current.status, VERSION_STATES, 'DRAFT'), metricCount: count(current.metric_count), metricsCertified: current.metrics_certified !== false },
    mine: raw.mine === true,
    mayEdit: raw.may_edit === true,
    version: count(raw.version),
    versions: Array.isArray(raw.versions) ? raw.versions.flatMap((version) => toVersion(version) ?? []) : [],
  };
}

// ---- the form of a new dashboard --------------------------------------------------------------------------------------------------

export type CreateProblem = 'codeRequired' | 'codeInvalid' | 'titleRequired' | 'titleLong';
export interface CreateForm {
  code: string;
  title: string;
}
export const EMPTY_CREATE: CreateForm = { code: '', title: '' };

export function validateCreate(form: CreateForm): { code?: CreateProblem; title?: CreateProblem } {
  const code = form.code.trim();
  const title = form.title.trim();
  return {
    code: code === '' ? 'codeRequired' : DASHBOARD_CODE.test(code) ? undefined : 'codeInvalid',
    title: title.length < 2 ? 'titleRequired' : title.length > 300 ? 'titleLong' : undefined,
  };
}
export const createBody = (form: CreateForm): { code: string; title: string } => ({ code: form.code.trim(), title: form.title.trim() });

// ---- the form of a version ----------------------------------------------------------------------------------------------------------

export interface WidgetForm {
  key: string;
  id: string;
  kind: WidgetKind;
  title: string;
  metricVersionId: string;
  dimensionCode: string;
  x: string;
  y: string;
  w: string;
  h: string;
}

export interface FilterRow {
  key: string;
  filter: string;
  dimension: string;
}

export interface VersionForm {
  /** The columns of the grid the version was saved with (the server takes 1 to 24): kept as they were, never changed by an edit. */
  columns: number;
  widgets: WidgetForm[];
  breakpoints: Record<Breakpoint, string>;
  filters: FilterRow[];
  policy: DatasetPolicy;
  pinned: string[];
}

export const EMPTY_VERSION: VersionForm = { columns: GRID_COLUMNS, widgets: [], breakpoints: { sm: '', md: '', lg: '', xl: '' }, filters: [], policy: 'LATEST_FROZEN', pinned: [] };

let counter = 0;
export const nextKey = (): string => `k${(counter += 1)}`;

/** The form of the next version, filled from the one it starts from (the dashboard is never edited in place: a revision is saved whole). */
export function formFrom(version: DashboardVersion | undefined): VersionForm {
  if (version === undefined) return EMPTY_VERSION;
  return {
    columns: version.columns,
    widgets: version.widgets.map((widget) => ({
      key: nextKey(),
      id: widget.id,
      kind: widget.kind,
      title: widget.title ?? '',
      metricVersionId: widget.metricVersionId,
      dimensionCode: widget.dimensionCode ?? '',
      x: String(widget.grid.x),
      y: String(widget.grid.y),
      w: String(widget.grid.w),
      h: String(widget.grid.h),
    })),
    breakpoints: { sm: String(version.breakpoints.sm ?? ''), md: String(version.breakpoints.md ?? ''), lg: String(version.breakpoints.lg ?? ''), xl: String(version.breakpoints.xl ?? '') },
    filters: Object.entries(version.filterMappings).map(([filter, dimension]) => ({ key: nextKey(), filter, dimension })),
    policy: version.policy,
    pinned: version.pinnedDatasetVersionIds,
  };
}

/** A tile to start from: what the chart builder hands to the dashboard builder. */
export function widgetOfChart(input: { metricVersionId: string; kind: WidgetKind; dimensionCode: string }, taken: readonly WidgetForm[], columns: number = GRID_COLUMNS): WidgetForm {
  const bottom = taken.reduce((max, widget) => Math.max(max, (WHOLE.test(widget.y) ? Number(widget.y) : 0) + (WHOLE.test(widget.h) ? Number(widget.h) : 0)), 0);
  let n = taken.length + 1;
  while (taken.some((widget) => widget.id === `w${n}`)) n += 1;
  return { key: nextKey(), id: `w${n}`, kind: input.kind, title: '', metricVersionId: input.metricVersionId, dimensionCode: input.kind === 'KPI' ? '' : input.dimensionCode, x: '0', y: String(bottom), w: String(columns), h: '4' };
}

export type VersionProblem = 'widgetId' | 'widgetIdTaken' | 'metric' | 'dimension' | 'grid' | 'overlap' | 'tooMany' | 'breakpoint' | 'filter' | 'filterTaken' | 'pinned' | 'title';

export interface VersionProblems {
  widgets: Record<string, VersionProblem[]>;
  breakpoints: Partial<Record<Breakpoint, VersionProblem>>;
  filters: Record<string, VersionProblem>;
  pinned?: VersionProblem;
  tooMany?: VersionProblem;
}

const gridOf = (widget: WidgetForm): { x: number; y: number; w: number; h: number } | undefined =>
  [widget.x, widget.y, widget.w, widget.h].every((value) => WHOLE.test(value.trim())) ? { x: Number(widget.x), y: Number(widget.y), w: Number(widget.w), h: Number(widget.h) } : undefined;

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Judges a version before it is sent, as the server does (the server judges again, and decides whether the metrics are certified and the pinned versions frozen). */
export function validateVersion(form: VersionForm, metricIds: ReadonlySet<string>): VersionProblems {
  const columns = form.columns;
  const problems: VersionProblems = { widgets: {}, breakpoints: {}, filters: {} };
  const note = (key: string, problem: VersionProblem): void => {
    problems.widgets[key] = [...(problems.widgets[key] ?? []), problem];
  };
  if (form.widgets.length > MAX_WIDGETS) problems.tooMany = 'tooMany';
  const grids = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const widget of form.widgets) {
    const id = widget.id.trim();
    if (!WIDGET_ID.test(id)) note(widget.key, 'widgetId');
    else if (form.widgets.filter((other) => other.id.trim() === id).length > 1) note(widget.key, 'widgetIdTaken');
    if (!metricIds.has(widget.metricVersionId)) note(widget.key, 'metric');
    const dimension = widget.dimensionCode.trim();
    if (dimension !== '' && (!CODE.test(dimension) || widget.kind === 'KPI')) note(widget.key, 'dimension');
    if (widget.title.trim().length > 200) note(widget.key, 'title');
    const grid = gridOf(widget);
    if (grid === undefined || grid.w < 1 || grid.h < 1 || grid.x + grid.w > columns || grid.h > MAX_ROWS) note(widget.key, 'grid');
    else grids.set(widget.key, grid);
  }
  const keys = [...grids.keys()];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      if (overlaps(grids.get(keys[i] as string) as never, grids.get(keys[j] as string) as never)) {
        note(keys[i] as string, 'overlap');
        note(keys[j] as string, 'overlap');
      }
    }
  }
  let last = 0;
  for (const key of BREAKPOINTS) {
    const value = form.breakpoints[key].trim();
    if (value === '') continue;
    const number = WHOLE.test(value) ? Number(value) : Number.NaN;
    if (!(number >= BREAKPOINT_RANGE.min && number <= BREAKPOINT_RANGE.max) || number <= last) problems.breakpoints[key] = 'breakpoint';
    else last = number;
  }
  for (const row of form.filters) {
    if (!CODE.test(row.filter.trim()) || !CODE.test(row.dimension.trim())) problems.filters[row.key] = 'filter';
    else if (form.filters.filter((other) => other.filter.trim() === row.filter.trim()).length > 1) problems.filters[row.key] = 'filterTaken';
  }
  if ((form.policy === 'PINNED') !== (form.pinned.length > 0)) problems.pinned = 'pinned';
  return problems;
}

export const hasVersionProblems = (problems: VersionProblems): boolean =>
  Object.values(problems.widgets).some((list) => list.length > 0) || Object.keys(problems.breakpoints).length > 0 || Object.keys(problems.filters).length > 0 || problems.pinned !== undefined || problems.tooMany !== undefined;

/** The body of `saveDashboardVersion`: the tiles with the names of the contract, the metrics they use (each once), and the policy of the versions of the datasets. */
export function versionBody(form: VersionForm): Record<string, unknown> {
  const metrics: string[] = [];
  for (const widget of form.widgets) if (!metrics.includes(widget.metricVersionId)) metrics.push(widget.metricVersionId);
  const breakpoints: Record<string, number> = {};
  for (const key of BREAKPOINTS) if (form.breakpoints[key].trim() !== '') breakpoints[key] = Number(form.breakpoints[key].trim());
  return {
    layout_json: {
      columns: form.columns,
      widgets: form.widgets.map((widget) => ({
        id: widget.id.trim(),
        kind: widget.kind,
        ...(widget.title.trim() === '' ? {} : { title: widget.title.trim() }),
        metric_version_id: widget.metricVersionId,
        ...(widget.dimensionCode.trim() === '' ? {} : { dimension_code: widget.dimensionCode.trim() }),
        grid: { x: Number(widget.x), y: Number(widget.y), w: Number(widget.w), h: Number(widget.h) },
      })),
    },
    breakpoints,
    metric_versions: metrics,
    filter_mappings: Object.fromEntries(form.filters.map((row) => [row.filter.trim(), row.dimension.trim()])),
    dataset_version_policy: form.policy,
    ...(form.policy === 'PINNED' ? { pinned_dataset_version_ids: form.pinned } : {}),
  };
}

export const isUuid = (value: string): boolean => UUID.test(value);

// ---- what the server refused ------------------------------------------------------------------------------------------------------------

export type DashboardReason = 'notCertified' | 'notFrozen' | 'duplicate' | 'invalid' | 'conflict' | 'archived' | 'scope' | 'notFound' | 'general';

const REASON_BY_CODE: Readonly<Record<string, DashboardReason>> = {
  METRIC_NOT_CERTIFIED: 'notCertified',
  DATASET_VERSION_NOT_FROZEN: 'notFrozen',
  DASHBOARD_CODE_DUPLICATE: 'duplicate',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  VERSION_CONFLICT: 'conflict',
  STAGE_TRANSITION_DENIED: 'archived',
  SCOPE_DENIED: 'scope',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeDashboardProblem = (error: unknown): { reason: DashboardReason; field: string } =>
  error instanceof ApiError ? { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail ?? '' } : { reason: 'general', field: '' };
