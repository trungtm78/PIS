import { harness as baseHarness, mount as baseMount, routeOf as baseRoute } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export type { Harness };
export const harness = baseHarness;
export const mount = baseMount;

export const IMPORTER = ['treasury.import', 'treasury.import.read'];
export const READER = ['treasury.import.read'];
export const WRITER_ONLY = ['treasury.import'];

export const ME = '00000000-0000-4000-8000-0000000000e9';
export const OTHER = '00000000-0000-4000-8000-0000000000f1';
export const IMPORT_ID = '00000000-0000-4000-8000-00000000a001';
export const FILE_ID = '00000000-0000-4000-8000-00000000b001';
export const SHA = 'a'.repeat(64);
export const SCREEN_PATH = '/pay/pay-13';

export const routeOf = (id: string, req: string) => ({ ...baseRoute(id, req), module: 'PAY', path: `/pay/${id.toLowerCase()}` });

export const row = (n: number, outcome: string, overrides: Record<string, unknown> = {}) => ({
  row_no: n,
  business_key: `KBNN_FILE|CT-${n}|2026-10-15|PRJ-A`,
  outcome,
  error_code: outcome === 'ERROR' ? 'AMOUNT_INVALID' : null,
  treasury_transaction_id: outcome === 'ERROR' ? null : `00000000-0000-4000-8000-00000000c0${String(n).padStart(2, '0')}`,
  raw_masked: { document_no: `CT-${n}`, amount_vnd: outcome === 'ERROR' ? '12x' : '1000', payee_account: '***012' },
  ...overrides,
});

export const difference = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000d0${String(n).padStart(2, '0')}`,
  code: 'DUPLICATE_CONFLICT',
  business_key: `KBNN_FILE|CT-${n}|2026-10-15|PRJ-A`,
  row_no: n,
  expected: '2000',
  actual: '2500',
  difference: '500',
  owner_membership_id: ME,
  owner_name: 'Nguyễn Văn An',
  due_at: '2026-10-27T03:00:00.000000Z',
  status: 'OPEN',
  ...overrides,
});

/** An import as getTreasuryImport answers it: six rows, one of each outcome and two new. */
export const importView = (overrides: Record<string, unknown> = {}) => ({
  id: IMPORT_ID,
  provider: 'KBNN_FILE',
  source_kind: 'STATEMENT_FILE',
  file_name: 'statement-aaaaaaaaaaaa',
  file_sha256: SHA,
  statement_date: '2026-10-16',
  status: 'PARTIALLY_APPLIED',
  row_total: 6,
  row_new: 3,
  row_duplicate: 1,
  row_conflict: 1,
  row_error: 1,
  imported_by: ME,
  imported_by_name: 'Nguyễn Văn An',
  imported_at: '2026-10-24T03:00:00.000000Z',
  adapter: {
    connector_code: 'TREASURY_STATEMENT_FILE',
    format_version: 'ASSUMED-2026.1',
    file_status: 'PROPOSED',
    api_status: 'MISSING',
    connector_status: 'ACTIVE',
    last_error_code: null,
    last_success_at: '2026-10-24T03:00:00.000000Z',
  },
  certified_total: { rows: 3, amount_vnd: '12000', open_differences: 1 },
  rows: [row(2, 'NEW'), row(3, 'NEW'), row(4, 'NEW'), row(5, 'DUPLICATE'), row(6, 'CONFLICT'), row(7, 'ERROR')],
  rows_truncated: false,
  differences: [difference(6)],
  ...overrides,
});

export const answer = (overrides: Record<string, unknown> = {}) => ({
  operation_id: '00000000-0000-4000-8000-00000000e001',
  status: 'PARTIALLY_APPLIED',
  resource_version: 1,
  resource_id: IMPORT_ID,
  result: 'PARTIALLY_APPLIED',
  duplicate: false,
  row_total: 6,
  row_new: 3,
  row_duplicate: 1,
  row_conflict: 1,
  row_error: 1,
  differences_opened: 1,
  ...overrides,
});

/** What `uploadTreasuryStatementFile` answers for a file with the columns of the layout. */
export const stagedFile = (overrides: Record<string, unknown> = {}) => ({
  file_object_id: FILE_ID,
  file_sha256: SHA,
  size_bytes: 2048,
  file_name: 'sao-ke.csv',
  format: 'CSV',
  columns: ['document_no', 'document_date', 'project_code', 'treasury_office_code', 'amount_vnd', 'confirmed_at'],
  row_count: 2,
  layout_ok: true,
  missing_columns: [],
  ...overrides,
});

/** One line of `listTreasuryImports`; the first has the id of `importView`. */
export const listItem = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000a00${n}`,
  file_name: 'sao-ke.csv',
  file_sha256: SHA,
  source_kind: 'STATEMENT_FILE',
  statement_date: '2026-10-16',
  status: 'PARTIALLY_APPLIED',
  row_total: 6,
  row_new: 3,
  row_duplicate: 1,
  row_conflict: 1,
  row_error: 1,
  imported_by: ME,
  imported_by_name: 'Nguyễn Văn An',
  imported_at: '2026-10-24T03:00:00.000000Z',
  ...overrides,
});
