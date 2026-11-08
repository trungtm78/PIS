import { ApiError } from '@machvon/api-client';
import type { QueryClient } from '@tanstack/react-query';
import type { RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import '../../../i18n';
import catalogue from '../../../i18n/vi.json';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { mount as baseMount } from '../../bid/test-support';

export type { Harness };

/** A text of the Vietnamese catalogue (the part files are merged into it when the i18n module loads), with its {placeholders} filled. */
export const word = (key: string, params: Record<string, string | number> = {}): string => {
  const text = (catalogue as Record<string, string>)[key];
  if (text === undefined) throw new Error(`no text for ${key}`);
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => (name in params ? String(params[name]) : placeholder));
};

export const routeOf = (id: string, req: string) => ({ id, path: `/ind/${id.toLowerCase()}`, title: id, kind: 'list', area: 'insights', module: 'IND', group: 'Chỉ tiêu', role: 'workspace', parent: null, req });

export const ADMIN = ['ind.read', 'ind.entry', 'ind.import.preview', 'ind.import'];
export const READER = ['ind.read'];
export const PREVIEWER = ['ind.read', 'ind.import.preview'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0001', 1);
export const PERIOD = uuid('0002', 1);
export const runId = (n: number): string => uuid('0070', n);
export const SHA = 'a'.repeat(64);
export const KEY = 'tenants/00000000-0000-4000-8000-00000000000a/import/00000000-0000-4000-8000-0000000000aa';
export const AS_OF = '2026-11-12T03:00:00.000Z';

export const problem = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

export const indicator = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  name: `Name of ${code}`,
  formula: `Formula of ${code}`,
  numerator: null,
  denominator: null,
  exclusions: [],
  unit: 'VND',
  period: 'AS_OF_NOW',
  source: 'Customer dictionary',
  owner: 'PROJECT_OWNER',
  decimals: 0,
  refresh_hours: 24,
  allowed_lag_days: 31,
  category: 'FUNDING',
  value_kind: 'ENTERED',
  enterable: true,
  entry_field: code,
  vat_basis: null,
  aliases: ['Alias of ' + code],
  required_on: [],
  version: 0,
  origin: 'DEFAULT',
  unverified: true,
  effective_from: null,
  effective_to: null,
  ...over,
});

export const INDICATORS = [
  indicator('TOTAL_INVESTMENT', { entry_field: 'TOTAL_INVESTMENT' }),
  indicator('CUMULATIVE_YTD', { category: 'EXECUTION', entry_field: 'CUMULATIVE', version: 2, origin: 'RULE', unverified: false, effective_from: '2026-01-01' }),
  indicator('RATE_YEAR_IN_FORCE', { category: 'RATE', value_kind: 'DERIVED', enterable: false, entry_field: null, unit: 'PERCENT', decimals: 2, numerator: 'Cumulative', denominator: 'Plan in force', aliases: [] }),
];

export const version = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0030', n),
  version: n,
  status: 'APPROVED',
  effective_from: '2026-01-01',
  effective_to: null,
  reason: 'Approved after review',
  created_by: uuid('0080', 1),
  created_by_name: 'Nguyễn Văn An',
  created_at: '2026-01-01T01:00:00.000Z',
  submitted_by_name: 'Trần Thị Bình',
  approved_by: uuid('0080', 2),
  approved_by_name: 'Lê Văn Cường',
  approved_at: '2026-01-02T01:00:00.000Z',
  retired_at: null,
  ...over,
});

export const detailOf = (code: string, over: Record<string, unknown> = {}) => ({
  indicator: INDICATORS.find((one) => one.code === code) ?? indicator(code),
  versions: [version(2), version(1, { status: 'RETIRED', effective_to: '2026-06-30' })],
  usage: { rules: [{ code: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', check: 'PARTS_EQUAL_TOTAL', active: false }], mappings: [{ code: 'MONTHLY_FORM', source: 'Total investment', active: true }] },
  as_of: AS_OF,
  ...over,
});

export const figure = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0040', n),
  project_id: PROJECT,
  project_code: 'DA-01',
  period_id: PERIOD,
  period_code: '2026-10',
  indicator_code: 'TOTAL_INVESTMENT',
  revision: 1,
  value: '1000',
  unit: 'VND',
  definition_version: 0,
  source: 'ENTRY',
  import_id: null,
  import_line: null,
  mapping_code: null,
  mapping_version: null,
  reason: null,
  entered_by: uuid('0080', 1),
  entered_by_name: 'Nguyễn Văn An',
  entered_at: '2026-11-10T01:00:00.000Z',
  ...over,
});

export const violation = (over: Record<string, unknown> = {}) => ({
  rule_code: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL',
  rule_version: 1,
  check: 'PARTS_EQUAL_TOTAL',
  severity: 'BLOCK',
  fields: ['EQUITY', 'DEBT', 'TOTAL'],
  message: 'Vốn chủ sở hữu cộng vốn vay phải bằng tổng nguồn vốn.',
  detail: 'PARTS_DIFFER sum=900 TOTAL=1000 gap=-100',
  ...over,
});

export const rule = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  check: 'CUMULATIVE_NOT_ABOVE_TOTAL',
  severity: 'BLOCK',
  fields: ['CUMULATIVE'],
  total_field: 'TOTAL_INVESTMENT',
  tolerance: null,
  message: 'Số lũy kế không được lớn hơn tổng mức.',
  surfaces: null,
  min: null,
  max: null,
  closed_states: [],
  version: 0,
  origin: 'DEFAULT',
  active: false,
  unverified: true,
  effective_from: null,
  effective_to: null,
  ...over,
});

export const RULES = {
  items: [
    rule('CUMULATIVE_NOT_ABOVE_TOTAL', { version: 3, origin: 'RULE', active: true, unverified: false, effective_from: '2026-01-01', surfaces: ['DIS_REPORT'] }),
    rule('PROGRESS_PERCENT_IN_RANGE', { check: 'VALUE_IN_RANGE', fields: ['PHYSICAL_PROGRESS'], total_field: null, min: '0', max: '100', severity: 'WARN' }),
    rule('EQUITY_PLUS_DEBT_EQUALS_TOTAL', { check: 'PARTS_EQUAL_TOTAL', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL', tolerance: '0' }),
  ],
  surfaces: ['DIS_REPORT', 'PRJ_PROJECT', 'INDICATOR_ENTRY', 'INDICATOR_IMPORT'],
  checks: [],
  as_of: AS_OF,
};

export const mapping = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  name: `Form ${code}`,
  layout: 'COLUMNS',
  number_format: 'VN',
  project_column: 'Mã dự án',
  period_column: 'Kỳ báo cáo',
  label_column: null,
  value_column: null,
  lines: [
    { indicator: 'TOTAL_INVESTMENT', source: 'Tổng mức đầu tư', scale: 'MILLION', required: true },
    { indicator: 'CUMULATIVE_YTD', source: 'Lũy kế', scale: 'MILLION', required: false },
  ],
  version: 0,
  origin: 'DEFAULT',
  active: false,
  unverified: true,
  effective_from: null,
  effective_to: null,
  problems: [],
  ...over,
});

export const MAPPINGS = [
  mapping('MONTHLY_FORM', { version: 1, origin: 'RULE', active: true, unverified: false, effective_from: '2026-01-01' }),
  mapping('SAMPLE_ROWS_FORM', { layout: 'ROWS', project_column: null, period_column: null, label_column: 'Chỉ tiêu', value_column: 'Giá trị', problems: [{ code: 'INDICATOR_NOT_ENTERABLE', indicator: 'RATE_YEAR_IN_FORCE', line: 1 }] }),
];

export const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: runId(n),
  format_version: 'MONTHLY_FORM.v1',
  file_sha256: String(n).repeat(64).slice(0, 64),
  status: 'APPLIED',
  error_code: null,
  counts: { total: 10, applied: 6, duplicate: 1, conflict: 1, quarantined: 2, differences_opened: 2 },
  open_differences: 2,
  imported_by: uuid('0080', n),
  imported_by_name: 'Nguyễn Văn An',
  created_at: '2026-11-10T01:00:00.000Z',
  completed_at: '2026-11-10T01:05:00.000Z',
  ...over,
});

export const rowError = (line: number, over: Record<string, unknown> = {}) => ({ line, business_key: `DA-${line}|2026-10`, code: 'NUMBER_INVALID', field: 'TOTAL_INVESTMENT', preview: { 'Mã dự án': `DA-${line}`, 'Tổng mức đầu tư': '1x' }, ...over });

export const difference = (n: number, over: Record<string, unknown> = {}) => ({ id: uuid('0050', n), line: 3, business_key: 'DA-3|2026-10', code: 'IND_FIGURE_DIFFERS', expected: '300', actual: '400', detail: null, status: 'OPEN', owner_name: 'Nguyễn Văn An', due_at: '2026-11-13T01:00:00.000Z', ...over });

export const UPLOADED = { file_object_key: KEY, file_sha256: SHA, size_bytes: 2048, format: 'CSV', columns: ['Mã dự án', 'Kỳ báo cáo', 'Tổng mức đầu tư'], row_count: 5, fitting_mappings: ['MONTHLY_FORM'] };

export const previewRow = (line: number, status: string, over: Record<string, unknown> = {}) => ({ line, business_key: `DA-${line}|2026-10`, status, code: null, field: null, outcome: null, preview: null, ...over });

export const PREVIEW = {
  operation_id: 'o',
  status: 'DRY_RUN',
  resource_version: 0,
  mode: 'DRY_RUN',
  mapping_code: 'MONTHLY_FORM',
  mapping_version: 1,
  format_version: 'MONTHLY_FORM.v1',
  file_sha256: SHA,
  already_applied: false,
  counts: { total: 5, valid: 3, errors: 1, duplicate: 1, conflict: 0 },
  rows: [
    previewRow(2, 'VALID', { outcome: 'CREATE' }),
    previewRow(3, 'VALID', { outcome: 'CREATE_AND_DIFFERENCE' }),
    previewRow(4, 'VALID', { outcome: 'UNCHANGED' }),
    previewRow(5, 'ERROR', { code: 'ENTRY_RULE_BLOCKED', field: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL' }),
    previewRow(6, 'DUPLICATE', { code: 'DUPLICATE_CONFLICT' }),
  ],
  rows_truncated: false,
};

export const APPLIED = {
  operation_id: 'o',
  status: 'APPLIED',
  resource_version: 1,
  resource_id: runId(9),
  mode: 'APPLY',
  mapping_code: 'MONTHLY_FORM',
  mapping_version: 1,
  format_version: 'MONTHLY_FORM.v1',
  file_sha256: SHA,
  counts: { total: 5, applied: 3, duplicate: 1, conflict: 0, quarantined: 1, differences_opened: 1 },
  figures_written: 7,
  figures_unchanged: 2,
  figures_differing: 1,
  errors: [rowError(5)],
  errors_truncated: false,
};

export interface World {
  indicators: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
  details: Record<string, Record<string, unknown>>;
  rules: Record<string, unknown>;
  mappings: Array<Record<string, unknown>>;
  mappingVersions: Array<Record<string, unknown>>;
  figures: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  pageSize: number;
  runRows: Record<string, Record<string, unknown>>;
  failing: Map<string, Error>;
  hanging: Set<string>;
}

export function world(over: Partial<World> = {}): World {
  return {
    indicators: INDICATORS,
    findings: [],
    details: { TOTAL_INVESTMENT: detailOf('TOTAL_INVESTMENT'), CUMULATIVE_YTD: detailOf('CUMULATIVE_YTD'), RATE_YEAR_IN_FORCE: detailOf('RATE_YEAR_IN_FORCE', { usage: { rules: [], mappings: [] }, versions: [] }) },
    rules: RULES,
    mappings: MAPPINGS,
    mappingVersions: [version(1)],
    figures: [],
    history: [],
    runs: [run(1), run(2, { format_version: 'SAMPLE.v2', status: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID' })],
    pageSize: 20,
    runRows: { [runId(1)]: { import_id: runId(1), errors: [rowError(4)], errors_truncated: false, differences: [difference(1)], as_of: AS_OF }, [runId(2)]: { import_id: runId(2), errors: [], errors_truncated: false, differences: [], as_of: AS_OF } },
    failing: new Map(),
    hanging: new Set(),
    ...over,
  };
}

type Query = Record<string, string | undefined>;
const queryOf = (input: unknown): Query => (input as { query?: Query } | undefined)?.query ?? {};

/** A client over `state`: the reads are answered from it (the dictionary is filtered as the server filters it, the history is paged by cursor); `command` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    const query = queryOf(input);
    switch (operation) {
      case 'listIndicators': {
        const needle = (query.q ?? '').toLowerCase();
        const items = state.indicators.filter(
          (one) => (query.category === undefined || one.category === query.category) && (query.value_kind === undefined || one.value_kind === query.value_kind) && (query.enterable !== 'true' || one.enterable === true) && (needle === '' || `${String(one.code)} ${String(one.name)}`.toLowerCase().includes(needle)),
        );
        return { items, findings: state.findings, categories: [], as_of: AS_OF };
      }
      case 'getIndicator':
        return state.details[query.code ?? ''] ?? problem('RESOURCE_NOT_FOUND', 404);
      case 'listIndicatorEntryRules':
        return state.rules;
      case 'listIndicatorImportMappings':
        return { items: state.mappings, as_of: AS_OF };
      case 'getIndicatorImportMapping': {
        const found = state.mappings.find((one) => one.code === query.code);
        return found === undefined ? problem('RESOURCE_NOT_FOUND', 404) : { mapping: found, versions: state.mappingVersions, as_of: AS_OF };
      }
      case 'listIndicatorFigures':
        return { items: query.project_id === PROJECT && query.period_id === PERIOD ? state.figures : [], as_of: AS_OF };
      case 'listIndicatorFigureHistory':
        return { items: state.history.filter((one) => one.indicator_code === query.indicator_code), as_of: AS_OF };
      case 'listIndicatorImports': {
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const items = state.runs.slice(start, start + state.pageSize);
        return { items, next_cursor: start + state.pageSize < state.runs.length ? String(start + state.pageSize) : null, as_of: AS_OF };
      }
      case 'listIndicatorImportRows':
        return state.runRows[query.import_id ?? ''] ?? problem('RESOURCE_NOT_FOUND', 404);
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  const read = h.client.read as unknown as (operation: string, input?: unknown) => Promise<unknown>;
  const answered = vi.fn((operation: string, input?: unknown) => (state.hanging.has(operation) ? new Promise<unknown>(() => undefined) : read(operation, input)));
  (h.client as unknown as { read: unknown }).read = answered;
  return { ...h, client: h.client, read: answered };
}

export interface MountOptions {
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  upload?: () => unknown;
}

/** Mounts a screen in a session; the upload of the client answers `options.upload` (a value, or an Error to throw). */
export function mountScreen(screen: Parameters<typeof baseMount>[0], h: Harness, options: MountOptions = {}): RenderResult & { queries: QueryClient; upload: ReturnType<typeof vi.fn> } {
  const upload = vi.fn(async () => {
    const result = options.upload?.() ?? UPLOADED;
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = upload;
  const mounted = baseMount(screen, h, { permissions: options.permissions ?? ADMIN, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { ...mounted, upload };
}

export const byOperation = (answers: { preview?: unknown; apply?: unknown; evaluate?: unknown; enter?: unknown }) => (operation: string): unknown => {
  switch (operation) {
    case 'previewIndicatorImport':
      return answers.preview ?? PREVIEW;
    case 'importIndicatorFile':
      return answers.apply ?? APPLIED;
    case 'evaluateIndicatorEntry':
      return answers.evaluate ?? { operation_id: 'o', status: 'EVALUATED', resource_version: 0, allowed: true, violations: [], evaluated: [], skipped: [] };
    case 'enterIndicatorFigures':
      return answers.enter ?? { operation_id: 'o', status: 'ENTERED', resource_version: 1, created: 1, revised: 0, unchanged: 0, warnings: [], figures: [figure(1)] };
    default:
      return {};
  }
};
