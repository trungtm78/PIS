import { ApiError } from '@machvon/api-client';
import type { QueryClient } from '@tanstack/react-query';
import type { RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import catalogue from '../../../i18n/vi.json';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { mount as baseMount } from '../test-support';

export { routeOf } from '../test-support';
export type { Harness };

/** A text of the Vietnamese catalogue (the strings of the part files are in it once the translator has read them), with its {placeholders} filled. */
export const word = (key: string, params: Record<string, string | number> = {}): string => {
  const text = (catalogue as Record<string, string>)[key];
  if (text === undefined) throw new Error(`no text for ${key}`);
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => (name in params ? String(params[name]) : placeholder));
};

export const READER = ['bid.read'];
export const PLANNER = ['bid.read', 'bid.egp.preview'];
export const IMPORTER = ['bid.read', 'bid.egp.preview', 'bid.import'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const runId = (n: number): string => uuid('0070', n);
export const SHA = 'a'.repeat(64);
export const KEY = 'tenants/00000000-0000-4000-8000-00000000000a/import/00000000-0000-4000-8000-0000000000aa';
export const AS_OF = '2026-11-12T03:00:00.000Z';

export const problem = (code: string, status: number, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

const column = (name: string, kind: string, required: boolean, headerRequired = false, values?: string[]) => ({ name, kind, required, header_required: headerRequired, ...(values === undefined ? {} : { values }) });

export const LAYOUTS = [
  { kind: 'KHLCNT', connector_code: 'EGP_KHLCNT_FILE', columns: [column('plan_code', 'code', true), column('package_external_code', 'code', true), column('selection_method', 'word', false, false, ['OPEN_BIDDING', 'LIMITED_BIDDING'])] },
  { kind: 'TBMT', connector_code: 'EGP_TBMT_FILE', columns: [column('notice_code', 'code', true), column('published_at', 'moment', true), column('contractor_tax_code', 'tax code', false, true)] },
  { kind: 'RESULT', connector_code: 'EGP_RESULT_FILE', columns: [column('result_code', 'code', true)] },
  { kind: 'CONTRACTOR', connector_code: 'EGP_CONTRACTOR_FILE', columns: [column('contractor_tax_code', 'tax code', true)] },
  { kind: 'RESTRICTION', connector_code: 'EGP_RESTRICTION_FILE', columns: [column('restriction_code', 'code', true)] },
];

export const connection = (over: Record<string, unknown> = {}, actions: Record<string, boolean> = {}, health: Record<string, unknown> = {}) => ({
  connector_code: 'egp.muasamcong',
  mode: 'FILE_IMPORT',
  adapter_status: 'PROPOSED',
  enabled: true,
  layout_version: 'WORKING-ASSUMPTION-2026.2',
  acceptance: 'PENDING_EXTERNAL',
  layouts: LAYOUTS,
  health: { status: 'FRESH', apply_blocked: false, ...health },
  actions: { set_state: false, preview: true, apply: true, propose_mapping: false, decide_mapping: false, ...actions },
  as_of: AS_OF,
  ...over,
});

export const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: runId(n),
  kind: 'KHLCNT',
  connector_code: 'EGP_KHLCNT_FILE',
  layout_version: 'WORKING-ASSUMPTION-2026.2',
  acceptance: 'PENDING_EXTERNAL',
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

export const rowError = (line: number, over: Record<string, unknown> = {}) => ({
  line,
  business_key: `PL-${line}|GT-${line}`,
  code: 'MONEY_INVALID',
  field: 'estimated_price',
  preview: { plan_code: `PL-${line}`, estimated_price: '1.200.000' },
  ...over,
});

export const detail = (n: number, over: Record<string, unknown> = {}) => ({ run: run(n), errors: [rowError(4), rowError(7, { code: 'FIELD_REQUIRED', field: 'plan_code' })], errors_truncated: false, as_of: AS_OF, ...over });

export const UPLOADED = { file_object_key: KEY, file_sha256: SHA, size_bytes: 2048, format: 'CSV', columns: ['plan_code', 'package_external_code'], row_count: 5, matching_kinds: ['KHLCNT'] };

export const previewRow = (line: number, status: string, over: Record<string, unknown> = {}) => ({ line, business_key: `PL-${line}|GT-${line}`, status, code: null, field: null, outcome: null, preview: null, ...over });

export const PREVIEW = {
  operation_id: 'o',
  status: 'DRY_RUN',
  resource_version: 0,
  mode: 'DRY_RUN',
  kind: 'KHLCNT',
  layout_version: 'WORKING-ASSUMPTION-2026.2',
  acceptance: 'PENDING_EXTERNAL',
  file_sha256: SHA,
  already_applied: false,
  connection_enabled: true,
  counts: { total: 6, valid: 3, errors: 1, duplicate: 1, conflict: 1 },
  rows: [
    previewRow(2, 'VALID', { outcome: 'RECORD' }),
    previewRow(3, 'VALID', { outcome: 'RECORD_AND_PROPOSE' }),
    previewRow(4, 'VALID', { outcome: 'RECORD_AND_DIFFERENCE' }),
    previewRow(5, 'ERROR', { code: 'MONEY_INVALID', field: 'estimated_price' }),
    previewRow(6, 'DUPLICATE', { code: 'ROW_DUPLICATE' }),
    previewRow(7, 'CONFLICT', { code: 'ROW_CONFLICT' }),
  ],
  rows_truncated: false,
};

export const APPLIED = {
  operation_id: 'o',
  status: 'APPLIED',
  resource_version: 2,
  resource_id: runId(9),
  mode: 'APPLY',
  kind: 'KHLCNT',
  layout_version: 'WORKING-ASSUMPTION-2026.2',
  acceptance: 'PENDING_EXTERNAL',
  file_sha256: SHA,
  counts: { total: 6, applied: 3, duplicate: 1, conflict: 1, quarantined: 1, differences_opened: 1 },
  mappings_proposed: 2,
  restrictions_written: 0,
  errors: [rowError(5)],
  errors_truncated: false,
};

export interface World {
  connection: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  /** Runs per page of the history. */
  pageSize: number;
  details: Record<string, Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Map<string, Error>;
  /** Reads that never answer, by operation. */
  hanging: Set<string>;
}

export function world(over: Partial<World> = {}): World {
  return { connection: connection(), runs: [run(1), run(2, { kind: 'TBMT' })], pageSize: 20, details: { [runId(1)]: detail(1), [runId(2)]: detail(2, { errors: [] }) }, failing: new Map(), hanging: new Set(), ...over };
}

/** A client over `state`: the connection, the history (filtered by kind, paged by cursor) and the detail of a run are answered from it, `command` answers the dry run and the apply. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    switch (operation) {
      case 'getEgpConnection':
        return state.connection;
      case 'listEgpImports': {
        const query = (input as { query?: { kind?: string; cursor?: string } } | undefined)?.query ?? {};
        const all = state.runs.filter((one) => query.kind === undefined || one.kind === query.kind);
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const items = all.slice(start, start + state.pageSize);
        return { items, next_cursor: start + state.pageSize < all.length ? String(start + state.pageSize) : null, as_of: AS_OF };
      }
      case 'getEgpImport': {
        const id = (input as { path?: { id?: string } } | undefined)?.path?.id ?? '';
        return state.details[id] ?? problem('RESOURCE_NOT_FOUND', 404);
      }
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
  const mounted = baseMount(screen, h, { permissions: options.permissions ?? IMPORTER, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { ...mounted, upload };
}

export const byOperation = (answers: { preview?: unknown; apply?: unknown }) => (operation: string): unknown => (operation === 'previewEgpFile' ? (answers.preview ?? PREVIEW) : operation === 'importEgpFile' ? (answers.apply ?? APPLIED) : {});
