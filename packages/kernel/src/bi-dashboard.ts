import { DomainError } from './errors.ts';

/** The kinds of tile a dashboard draws, each with a table alternative on the screen (ST-BI-005, BI-04). */
export const WIDGET_KINDS = ['KPI', 'BAR', 'LINE', 'AREA', 'PIE', 'TABLE'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const MAX_WIDGETS = 100;
export const MAX_GRID_ROWS = 50;
export const BREAKPOINT_KEYS = ['sm', 'md', 'lg', 'xl'] as const;
export const MIN_BREAKPOINT_PX = 320;
export const MAX_BREAKPOINT_PX = 4000;
export const DEFAULT_COLUMNS = 12;
const MAX_COLUMNS = 24;
const MAX_FILTERS = 50;
const MAX_TITLE = 200;
const MAX_METRICS = 500;

const WIDGET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[a-z][a-z0-9_]{1,59}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WidgetGrid {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardWidget {
  id: string;
  kind: WidgetKind;
  title: string | null;
  metricVersionId: string;
  /** The dimension a chart breaks the metric down by; a KPI tile has none. */
  dimensionCode: string | null;
  grid: WidgetGrid;
}

export type DatasetVersionPolicy = 'LATEST_FROZEN' | 'PINNED';

/** What a draft of a dashboard version says, judged and in the shape the store writes. */
export interface DashboardDraft {
  layout: { columns: number; widgets: DashboardWidget[] };
  metricVersionIds: string[];
  filterMappings: Record<string, string>;
  breakpoints: Record<string, number>;
  policy: DatasetVersionPolicy;
  pinnedDatasetVersionIds: string[];
}

export interface DraftInput {
  layout_json: unknown;
  breakpoints: unknown;
  metric_versions: readonly string[];
  filter_mappings: unknown;
  dataset_version_policy: string;
  pinned_dataset_version_ids?: readonly string[] | undefined;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw invalid(`${field}.${key}`);
}

function uuids(values: readonly string[], field: string, max: number): string[] {
  if (!Array.isArray(values) || values.length > max) throw invalid(field);
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
    const id = value.toLowerCase();
    if (seen.has(id)) throw invalid(field);
    seen.add(id);
  }
  return [...seen];
}

function widgetOf(raw: unknown, index: number, columns: number, metrics: ReadonlySet<string>): DashboardWidget {
  const field = `layout_json.widgets[${index}]`;
  if (!isRecord(raw)) throw invalid(field);
  onlyKeys(raw, ['id', 'kind', 'title', 'metric_version_id', 'dimension_code', 'grid'], field);
  if (typeof raw.id !== 'string' || !WIDGET_ID.test(raw.id)) throw invalid(`${field}.id`);
  const kind = WIDGET_KINDS.find((candidate) => candidate === raw.kind);
  if (kind === undefined) throw invalid(`${field}.kind`);
  let title: string | null = null;
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || raw.title.trim() === '' || raw.title.trim().length > MAX_TITLE) throw invalid(`${field}.title`);
    title = raw.title.trim().normalize('NFC');
  }
  if (typeof raw.metric_version_id !== 'string' || !UUID.test(raw.metric_version_id) || !metrics.has(raw.metric_version_id.toLowerCase())) throw invalid(`${field}.metric_version_id`);
  let dimensionCode: string | null = null;
  if (raw.dimension_code !== undefined) {
    if (typeof raw.dimension_code !== 'string' || !CODE.test(raw.dimension_code) || kind === 'KPI') throw invalid(`${field}.dimension_code`);
    dimensionCode = raw.dimension_code;
  }
  const grid = raw.grid;
  if (!isRecord(grid)) throw invalid(`${field}.grid`);
  onlyKeys(grid, ['x', 'y', 'w', 'h'], `${field}.grid`);
  const { x, y, w, h } = grid;
  if (!isInt(x) || !isInt(y) || !isInt(w) || !isInt(h) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > columns || h > MAX_GRID_ROWS) throw invalid(`${field}.grid`);
  return { id: raw.id, kind, title, metricVersionId: raw.metric_version_id.toLowerCase(), dimensionCode, grid: { x, y, w, h } };
}

const overlaps = (a: WidgetGrid, b: WidgetGrid): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Judges the draft of a version (ST-BI-005): the layout is a grid of tiles that do not overlap, each over a metric the version names; the breakpoints grow; the filters map to dimensions; and the version of the datasets
 * is either the latest frozen one or a list of pinned ones. Whether the metrics are certified and the pinned versions frozen is the business of the store, which reads them.
 */
export function parseDashboardDraft(input: DraftInput): DashboardDraft {
  const metricVersionIds = uuids(input.metric_versions, 'metric_versions', MAX_METRICS);
  const metrics = new Set(metricVersionIds);
  const layout = input.layout_json;
  if (!isRecord(layout)) throw invalid('layout_json');
  onlyKeys(layout, ['columns', 'widgets'], 'layout_json');
  const columns = layout.columns === undefined ? DEFAULT_COLUMNS : layout.columns;
  if (!isInt(columns) || columns < 1 || columns > MAX_COLUMNS) throw invalid('layout_json.columns');
  const rawWidgets = layout.widgets === undefined ? [] : layout.widgets;
  if (!Array.isArray(rawWidgets) || rawWidgets.length > MAX_WIDGETS) throw invalid('layout_json.widgets');
  const widgets = rawWidgets.map((raw, index) => widgetOf(raw, index, columns, metrics));
  if (new Set(widgets.map((widget) => widget.id)).size !== widgets.length) throw invalid('layout_json.widgets');
  for (let i = 0; i < widgets.length; i += 1) {
    for (let j = i + 1; j < widgets.length; j += 1) if (overlaps((widgets[i] as DashboardWidget).grid, (widgets[j] as DashboardWidget).grid)) throw invalid('layout_json.widgets');
  }

  const rawBreakpoints = input.breakpoints;
  if (!isRecord(rawBreakpoints)) throw invalid('breakpoints');
  onlyKeys(rawBreakpoints, BREAKPOINT_KEYS, 'breakpoints');
  const breakpoints: Record<string, number> = {};
  let last = 0;
  for (const key of BREAKPOINT_KEYS) {
    const value = rawBreakpoints[key];
    if (value === undefined) continue;
    if (!isInt(value) || value < MIN_BREAKPOINT_PX || value > MAX_BREAKPOINT_PX || value <= last) throw invalid(`breakpoints.${key}`);
    breakpoints[key] = value;
    last = value;
  }

  const rawFilters = input.filter_mappings;
  if (!isRecord(rawFilters) || Object.keys(rawFilters).length > MAX_FILTERS) throw invalid('filter_mappings');
  const filterMappings: Record<string, string> = {};
  for (const [filter, dimension] of Object.entries(rawFilters)) {
    if (!CODE.test(filter) || typeof dimension !== 'string' || !CODE.test(dimension)) throw invalid(`filter_mappings.${filter}`);
    filterMappings[filter] = dimension;
  }

  const policy = input.dataset_version_policy === 'PINNED' ? 'PINNED' : input.dataset_version_policy === 'LATEST_FROZEN' ? 'LATEST_FROZEN' : undefined;
  if (policy === undefined) throw invalid('dataset_version_policy');
  const pinned = uuids(input.pinned_dataset_version_ids ?? [], 'pinned_dataset_version_ids', MAX_METRICS);
  if ((policy === 'PINNED') !== (pinned.length > 0)) throw invalid('pinned_dataset_version_ids');
  return { layout: { columns, widgets }, metricVersionIds, filterMappings, breakpoints, policy, pinnedDatasetVersionIds: pinned };
}

/** The code of a dashboard: letters, digits and the signs `_ - .`, starting with a letter or a digit (2 to 80 characters). */
export const DASHBOARD_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,79}$/;
