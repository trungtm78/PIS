import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ExternalLinksScreen from './ExternalLinksScreen';
import { KEY, PLANNER, READER, SHA, client, link, linkId, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('BID-19', 'FR-BID-19');
const UPLOADED = { file_object_key: KEY, file_sha256: SHA, size_bytes: 120, format: 'csv', columns: ['package_code', 'external_code', 'milestone_kind', 'actual_at'], row_count: 3 };
const PREVIEW = {
  operation_id: 'o',
  status: 'DRY_RUN',
  resource_version: 0,
  mode: 'DRY_RUN',
  adapter: { connector_code: 'PROCUREMENT_FILE', format_version: 'WORKING-ASSUMPTION-2026.1', status: 'PROPOSED' },
  file_sha256: SHA,
  already_applied: false,
  counts: { total: 3, valid: 2, duplicate: 0, conflict: 0, errors: 1 },
  rows_total: 3,
  rows_ok: 2,
  rows_error: 1,
  rows: [
    { line: 2, business_key: '|GT-1|BID_OPENING', status: 'VALID', outcome: 'CREATE', preview: { package_code: 'GT-1', external_code: 'TBMT-1', milestone_kind: 'BID_OPENING', actual_at: '2026-09-01' } },
    { line: 3, business_key: '|GT-2|RESULT_PUBLISHED', status: 'VALID', outcome: 'MILESTONE_MISMATCH', preview: { package_code: 'GT-2', external_code: 'TBMT-2', milestone_kind: 'RESULT_PUBLISHED', actual_at: '2026-09-15' } },
    { line: 4, business_key: '|GT-X|BID_OPENING', status: 'ERROR', code: 'PACKAGE_NOT_FOUND', field: 'package_code', preview: { package_code: 'GT-X', external_code: 'TBMT-X', milestone_kind: 'BID_OPENING', actual_at: '2026-09-01' } },
  ],
  rows_truncated: false,
};
const APPLIED = {
  operation_id: 'o',
  status: 'APPLIED',
  resource_version: 2,
  resource_id: 'b',
  mode: 'APPLY',
  adapter: { status: 'PROPOSED' },
  counts: { total: 3, applied: 2, duplicate: 0, conflict: 0, quarantined: 1, differencesOpened: 1 },
  milestones_written: 1,
  errors: [{ line: 4, business_key: '|GT-X|BID_OPENING', code: 'PACKAGE_NOT_FOUND', field: 'package_code', preview: { package_code: 'GT-X', milestone_kind: 'BID_OPENING' } }],
  errors_truncated: false,
};
const problem = (code: string, status: number, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const byMode = (dry: unknown, applied: unknown) => (_operation: string, input: unknown) => ((input as { body: { mode: string } }).body.mode === 'DRY_RUN' ? dry : applied);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mountWith(options: { command?: (operation: string, input: unknown) => unknown; upload?: () => unknown; permissions?: string[]; wholeTenant?: boolean; mode?: 'FULL' | 'READ_ONLY'; links?: Array<Record<string, unknown>> } = {}) {
  const h = client(world({ wholeTenant: options.wholeTenant ?? true, ...(options.links === undefined ? {} : { links: options.links }) }), options.command ?? byMode(PREVIEW, APPLIED));
  const upload = vi.fn(async () => {
    const result = options.upload?.() ?? UPLOADED;
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = upload;
  mount(<ExternalLinksScreen route={ROUTE} />, h, { permissions: options.permissions ?? PLANNER, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, upload };
}

const choose = (): void => {
  const input = screen.getByLabelText(vi_['bid.import.file.label']) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['package_code,external_code,milestone_kind,actual_at\nGT-1,TBMT-1,BID_OPENING,2026-09-01'], 'export.csv', { type: 'text/csv' })] } });
};
const check = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['bid.import.check.action'] }));
};

describe('ExternalLinksScreen (BID-19): the links to the national bidding network and the reconciliation', () => {
  it('UI-BID-19: says the adapter is a proposal, lists the links with the code, the batch and the difference with its owner, and filters by status', async () => {
    mountWith({ permissions: READER });
    await screen.findByTestId('links');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.links.page.title']);
    expect(screen.getByTestId('adapter-note').textContent).toBe(vi_['bid.import.adapter.note']);
    const rowOf = (n: number): HTMLElement => document.querySelector(`[data-link-id="${linkId(n)}"]`) as HTMLElement;
    expect(within(rowOf(1)).getByTestId('diff-status').textContent).toBe(vi_['bid.link.status.inSync']);
    expect(within(rowOf(1)).getByTestId('adapter').textContent).toBe(vi_['bid.links.source.file'].replace('{status}', 'PROPOSED'));
    expect(within(rowOf(1)).getByTestId('synced').textContent).toBe('2026-10-24');
    expect(within(rowOf(1)).getByTestId('hash').textContent).toBe('aaaaaaaaaaaa');
    expect(rowOf(1).textContent).toContain('TBMT-1');
    const different = within(rowOf(2));
    expect(different.getByTestId('diff-status').textContent).toBe(vi_['bid.link.status.different']);
    expect(different.getByTestId('milestone-difference').textContent).toBe(
      vi_['bid.links.difference.milestone'].replace('{kind}', vi_['bid.milestone.opening.label']).replace('{register}', '2026-09-01').replace('{file}', '2026-09-05'),
    );
    expect(different.getByTestId('owner').textContent).toBe(vi_['bid.links.difference.owner'].replace('{name}', 'Nguyễn Văn An'));
    fireEvent.change(screen.getByLabelText(vi_['bid.links.status.label']), { target: { value: 'DIFFERENT' } });
    expect(document.querySelectorAll('[data-link-id]')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(vi_['bid.links.status.label']), { target: { value: 'MISSING_EXTERNAL' } });
    expect(screen.getByTestId('no-links').textContent).toBe(vi_['bid.links.noMatch.notice']);
    // A reader has no way to load a file.
    expect(screen.getByTestId('import-denied').textContent).toBe(vi_['bid.import.denied.notice']);
    expect(screen.queryByLabelText(vi_['bid.import.file.label'])).toBeNull();
  });

  it('shows the difference in the code of the package, and a link that has not been looked at by a file', async () => {
    mountWith({
      permissions: READER,
      links: [link(1, 1, { diff_status: 'DIFFERENT', diff: { external_code: { register: 'TBMT-1', file: 'TBMT-9' } }, batch: null, diff_owner: null })],
    });
    await screen.findByTestId('links');
    expect(screen.getByTestId('code-difference').textContent).toBe(vi_['bid.links.difference.code'].replace('{register}', 'TBMT-1').replace('{file}', 'TBMT-9'));
    expect(screen.getByTestId('adapter').textContent).toBe(vi_['bid.links.source.none']);
    expect(screen.getByTestId('synced').textContent).toBe(vi_['bid.links.synced.none']);
    expect(screen.queryByTestId('owner')).toBeNull();
  });

  it('keeps the panel when there is no link yet, and says so', async () => {
    mountWith({ links: [] });
    expect((await screen.findByTestId('no-links')).textContent).toBe(vi_['bid.links.empty.notice']);
    expect(screen.getByTestId('import-panel')).toBeTruthy();
  });

  it('AC-ST-BID-005-1, UAT-AC454: uploads the file, shows the dry run row by row with the row error, applies it once and says what was written', async () => {
    const { h, upload } = mountWith();
    await screen.findByTestId('links');
    expect(screen.getByRole('button', { name: vi_['bid.import.check.action'] })).toHaveProperty('disabled', true);
    choose();
    check();
    await screen.findByTestId('import-rows');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(h.command).toHaveBeenCalledWith('importProcurementFile', expect.objectContaining({ body: { file_object_key: KEY, file_sha256: SHA, mode: 'DRY_RUN' } }));
    expect(screen.getByTestId('import-file').textContent).toBe(vi_['bid.import.file.text'].replace('{rows}', '3').replace('{format}', 'CSV'));
    expect(screen.getByTestId('import-counts').textContent).toBe(vi_['bid.import.preview.counts'].replace('{total}', '3').replace('{valid}', '2').replace('{repeats}', '0').replace('{errors}', '1'));
    const rows = Array.from(document.querySelectorAll('[data-line]')).map((row) => [row.getAttribute('data-line'), row.getAttribute('data-status'), ...Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)]);
    expect(rows).toEqual([
      ['2', 'VALID', 'GT-1', vi_['bid.milestone.opening.label'], vi_['bid.import.row.create']],
      ['3', 'VALID', 'GT-2', vi_['bid.milestone.published.label'], vi_['bid.import.row.milestoneMismatch']],
      ['4', 'ERROR', 'GT-X', vi_['bid.milestone.opening.label'], vi_['bid.import.row.notFound']],
    ]);
    fireEvent.click(screen.getByRole('button', { name: vi_['bid.import.apply.action'] }));
    await screen.findByTestId('import-applied');
    expect(h.command).toHaveBeenLastCalledWith('importProcurementFile', expect.objectContaining({ body: { file_object_key: KEY, file_sha256: SHA, mode: 'APPLY' } }));
    expect(screen.getByTestId('import-counts').textContent).toBe(vi_['bid.import.applied.counts'].replace('{written}', '1').replace('{errors}', '1').replace('{differences}', '1'));
    expect(within(screen.getByTestId('import-rows')).getAllByRole('row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: vi_['bid.import.apply.action'] })).toBeNull();
  });

  it('AC-ST-BID-005-1: a file that was applied before is told so and cannot be applied again', async () => {
    mountWith({ command: () => ({ ...PREVIEW, already_applied: true, counts: { total: 3, valid: 0, duplicate: 2, conflict: 0, errors: 1 } }) });
    await screen.findByTestId('links');
    choose();
    check();
    expect((await screen.findByTestId('import-already')).textContent).toBe(vi_['bid.import.already.notice']);
    expect(screen.getByRole('button', { name: vi_['bid.import.apply.action'] })).toHaveProperty('disabled', true);
  });

  it('shows the refusal of the apply with its reason, and IMPORT_HAS_ERRORS lists the lines that failed', async () => {
    const hasErrors = problem('IMPORT_HAS_ERRORS', 422, {
      counts: { total: 2, applied: 0, duplicate: 0, conflict: 0, quarantined: 2, differencesOpened: 0 },
      errors: [
        { line: 2, code: 'PACKAGE_NOT_FOUND', field: 'package_code', preview: { package_code: 'NO-1', milestone_kind: 'BID_OPENING' } },
        { line: 3, code: 'ACTUAL_AT_IN_FUTURE', field: 'actual_at', preview: { package_code: 'NO-2', milestone_kind: 'BID_CLOSING' } },
      ],
    });
    const { h } = mountWith({ command: byMode(PREVIEW, hasErrors) });
    await screen.findByTestId('links');
    choose();
    check();
    await screen.findByTestId('import-rows');
    fireEvent.click(screen.getByRole('button', { name: vi_['bid.import.apply.action'] }));
    expect((await screen.findByTestId('import-problem')).textContent).toBe(vi_['bid.import.problem.hasErrors']);
    expect(document.querySelectorAll('[data-status="ERROR"]')).toHaveLength(2);
    expect(within(screen.getByTestId('import-rows')).getByText(vi_['bid.import.row.future'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(2);
  });

  it('tells why the file was refused: already applied, hash, layout, empty, not clean, not found, denied and anything else', async () => {
    const cases: Array<[Error, string]> = [
      [problem('IMPORT_FILE_ALREADY_APPLIED', 409), 'bid.import.problem.alreadyApplied'],
      [problem('HASH_MISMATCH', 422), 'bid.import.problem.hashMismatch'],
      [problem('IMPORT_SCHEMA_INVALID', 422), 'bid.import.problem.schemaInvalid'],
      [problem('IMPORT_EMPTY', 422), 'bid.import.problem.empty'],
      [problem('FILE_NOT_CLEAN', 422), 'bid.import.problem.fileRefused'],
      [problem('RESOURCE_NOT_FOUND', 404), 'bid.import.problem.notFound'],
      [problem('SCOPE_DENIED', 403), 'bid.import.problem.denied'],
      [problem('OTHER', 500), 'bid.import.problem.general'],
    ];
    for (const [error, key] of cases) {
      mountWith({ upload: () => error });
      await screen.findByTestId('links');
      choose();
      check();
      expect((await screen.findByTestId('import-problem')).textContent).toBe(vi_[key as keyof typeof vi_]);
      cleanup();
    }
  });

  it('describes the rows a file can bring in words, and tells when the rows are cut', async () => {
    const reasons: Array<[string, string]> = [
      ['PACKAGE_STATE_INVALID', 'bid.import.row.state'],
      ['PACKAGE_AMBIGUOUS', 'bid.import.row.ambiguous'],
      ['EXTERNAL_CODE_TAKEN', 'bid.import.row.codeTaken'],
      ['EXTERNAL_CODE_CONFLICT', 'bid.import.row.codeTaken'],
      ['MILESTONE_KIND_INVALID', 'bid.import.row.kind'],
      ['ACTUAL_AT_INVALID', 'bid.import.row.date'],
      ['MILESTONE_ORDER_INVALID', 'bid.import.row.order'],
      ['ROW_DUPLICATE', 'bid.import.row.duplicate'],
      ['PACKAGE_CODE_EMPTY', 'bid.import.row.empty'],
      ['EXTERNAL_CODE_EMPTY', 'bid.import.row.empty'],
      ['CODE_INVALID', 'bid.import.row.invalid'],
    ];
    const outcomes: Array<[string, string]> = [
      ['FILL', 'bid.import.row.fill'],
      ['UNCHANGED', 'bid.import.row.unchanged'],
      ['CODE_MISMATCH', 'bid.import.row.codeMismatch'],
    ];
    const rows = [
      ...reasons.map(([code], index) => ({ line: 2 + index, status: 'ERROR', code, field: 'package_code', preview: { package_code: `E-${index}`, milestone_kind: 'NOT_A_KIND' } })),
      ...outcomes.map(([outcome], index) => ({ line: 20 + index, status: 'VALID', outcome, preview: { package_code: `V-${index}`, milestone_kind: 'BID_OPENING' } })),
      { line: 30, status: 'ERROR', code: 'SOMETHING_NEW', field: 'x', preview: {} },
      { line: 31, status: 'DUPLICATE', preview: { package_code: 'D' } },
      { line: 32, status: 'CONFLICT', preview: { package_code: 'C' } },
      { line: 33, status: 'VALID', preview: { package_code: 'P' } },
    ];
    mountWith({ command: () => ({ ...PREVIEW, rows, rows_truncated: true, counts: { total: rows.length, valid: 4, duplicate: 1, conflict: 1, errors: 12 } }) });
    await screen.findByTestId('links');
    choose();
    check();
    await screen.findByTestId('import-rows');
    const text = (line: number): string => (document.querySelector(`[data-line="${line}"]`) as HTMLElement).textContent ?? '';
    reasons.forEach(([, key], index) => expect(text(2 + index)).toContain(vi_[key as keyof typeof vi_]));
    outcomes.forEach(([, key], index) => expect(text(20 + index)).toContain(vi_[key as keyof typeof vi_]));
    expect(text(2 + 10)).toContain('NOT_A_KIND');
    expect(text(30)).toContain(vi_['bid.import.row.other'].replace('{code}', 'SOMETHING_NEW'));
    expect(text(31)).toContain(vi_['bid.import.row.repeat']);
    expect(text(32)).toContain(vi_['bid.import.row.conflict']);
    expect(text(33)).toContain(vi_['bid.import.row.valid']);
    expect(screen.getByText(vi_['bid.import.rows.truncated'])).toBeTruthy();
  });

  it('lets a planner of a unit tree check the file and tells them the apply is for the whole organisation; a read-only session has no panel', async () => {
    mountWith({ wholeTenant: false });
    await screen.findByTestId('links');
    expect((await screen.findByTestId('import-scope-notice')).textContent).toBe(vi_['bid.import.wholeTenant.notice']);
    choose();
    check();
    await screen.findByTestId('import-rows');
    expect(screen.queryByRole('button', { name: vi_['bid.import.apply.action'] })).toBeNull();
    cleanup();
    mountWith({ mode: 'READ_ONLY' });
    await screen.findByTestId('links');
    expect(screen.getByTestId('import-denied')).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText(vi_['bid.import.file.label'])).toBeNull());
  });

  it('shows the error state when the links cannot be read', async () => {
    const h = client(world({ failing: new Set(['listProcurementExternalLinks']) }));
    mount(<ExternalLinksScreen route={ROUTE} />, h, { permissions: READER });
    expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
  });
});
