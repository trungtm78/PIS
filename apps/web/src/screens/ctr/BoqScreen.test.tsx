import { createHash, webcrypto } from 'node:crypto';
import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import BoqScreen from './BoqScreen';
import { BOQ_MANAGER, BOQ_READER, boqLine, client, contractId, detail, mount, revision, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-04', 'FR-CTR-04');
const problem = (code: string, status = 422, detailText?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', detail: detailText, extensions });
const REVISION_ID = revision(1).id;
const HEADER = 'business_key,description,unit_code,quantity,unit_price';
const CSV = `${HEADER}\nB01,Đào đất,M3,3,1234.5\nB02,Bê tông,M3,2,500\n`;
const IMPORTED = { operation_id: 'o', status: 'DRAFT', resource_version: 2, resource_id: REVISION_ID, import_id: 'import-1', duplicate: false, lines_imported: 2, items_created: 2, retention_defaulted: 2, lines_total_vnd: '4704', revision_amount_vnd: '4704', difference_vnd: '0', balanced: true };

afterEach(cleanup);
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const lines = [boqLine(1), boqLine(2, { quantity: '2', unit_price: '500', amount_vnd: '1000', milestone_code: 'M-1', milestone_due_on: '2026-12-31', party_name: 'Liên danh Hà Giang', rounding_rule: 'DOWN', retention_pct: '7.5000' })];
const contract = (overrides: Record<string, unknown> = {}, revisionOverrides: Record<string, unknown> = {}) =>
  detail(1, { contract_value_vnd: '4704', revisions: [revision(1, { amount_vnd: '4704', boq_total_vnd: '4704', boq_line_count: 2, ...revisionOverrides })], ...overrides });
const opened = (c: Record<string, unknown> = contract(), command?: (operation: string, input: unknown) => unknown, overrides: Partial<World> = {}) =>
  client(world({ details: [c], boqLines: lines, ...overrides }), command ?? (() => IMPORTED));
const open = (h: ReturnType<typeof opened>, permissions: readonly string[] | undefined = BOQ_MANAGER, mode?: 'FULL' | 'READ_ONLY', path = `/?id=${contractId(1)}`) =>
  mount(<BoqScreen route={ROUTE} />, h, { permissions, path, ...(mode === undefined ? {} : { mode }) });
const ready = () => screen.findByTestId('reconciliation');
const choose = async (content: string | Uint8Array<ArrayBuffer>, name = 'boq.csv'): Promise<void> => {
  fireEvent.change(await screen.findByLabelText(vi_['ctr.boq.file.label']), { target: { files: [new File([content], name, { type: 'text/csv' })] } });
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['ctr.boq.import.action'] }));
};
const sent = (h: ReturnType<typeof opened>) => h.command.mock.calls as Array<[string, { path: { id: string }; body: { mode: string; file_sha256: string; lines: Array<Record<string, string>> }; ifMatchVersion: number }]>;

describe('BoqScreen (CTR-04): the BOQ of a contract revision', () => {
  it('shows the lines with the item, unit, quantity, price, amount, milestone, retention, rounding rule and member, and their total (UI-CTR-04)', async () => {
    open(opened());
    await ready();
    const rows = within(screen.getByTestId('boq-grid')).getAllByTestId('boq-row');
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent);
    expect(first).toEqual(['B01Hạng mục 1', 'M3', '3', '1.234,5', '3.704', '', '5,0000', vi_['ctr.boq.rounding.halfUp.label'], '']);
    const second = within(rows[1] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent);
    expect(second).toEqual(['B02Hạng mục 2', 'M3', '2', '500', '1.000', 'M-1 · 2026-12-31', '7,5000', vi_['ctr.boq.rounding.down.label'], 'Liên danh Hà Giang']);
    expect(screen.getByTestId('grid-total').textContent).toBe('4.704');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`HD-A-001 · ${vi_['ctr.boq.page.title']}`);
    for (const column of ['item', 'unit', 'quantity', 'price', 'amount', 'milestone', 'retention', 'rounding', 'member'] as const) {
      expect(screen.getByRole('columnheader', { name: vi_[`ctr.boq.column.${column}`] })).toBeTruthy();
    }
  });

  it('reconciles the lines with the value of the revision: equal gives a difference of 0 (BR-CTR-02)', async () => {
    open(opened());
    await ready();
    expect(screen.getByTestId('revision-amount').textContent).toBe('4.704');
    expect(screen.getByTestId('lines-total').textContent).toBe('4.704');
    expect(screen.getByTestId('difference').textContent).toBe('0');
    expect(screen.getByTestId('reconcile-status').textContent).toBe(vi_['ctr.boq.reconcile.ok']);
    expect(screen.getByTestId('reconcile-status').className).toContain('ok');
  });

  it('says how far the lines are from the value, and that a revision without lines has none', async () => {
    open(opened(contract({}, { boq_total_vnd: '4703' }), undefined, { boqLines: [boqLine(1, { amount_vnd: '3703' }), boqLine(2, { amount_vnd: '1000' })] }));
    await ready();
    expect(screen.getByTestId('difference').textContent).toBe('-1');
    expect(screen.getByTestId('reconcile-status').textContent).toBe(vi_['ctr.boq.reconcile.bad'].replace('{difference}', '-1'));
    expect(screen.getByTestId('reconcile-status').className).toContain('bad');
    cleanup();
    open(opened(contract({}, { boq_total_vnd: '0', boq_line_count: 0 }), undefined, { boqLines: [] }));
    await ready();
    expect(screen.getByTestId('reconcile-status').textContent).toBe(vi_['ctr.boq.reconcile.empty']);
    expect(screen.getByTestId('no-lines').textContent).toBe(vi_['ctr.boq.grid.empty']);
    expect(screen.queryByTestId('boq-grid')).toBeNull();
  });

  it('adds the lines up itself when the answer has no total', async () => {
    open(opened(detail(1, { contract_value_vnd: '4704', revisions: [revision(1, { amount_vnd: '4704' })] })));
    await ready();
    expect(screen.getByTestId('lines-total').textContent).toBe('4.704');
    expect(screen.getByTestId('reconcile-status').textContent).toBe(vi_['ctr.boq.reconcile.ok']);
  });

  it('shows the lines of the revision that is chosen when the contract has several', async () => {
    const second = revision(1, { id: 'r-2', revision: 2, kind: 'AMENDMENT', status: 'EFFECTIVE', amount_vnd: '9999', boq_total_vnd: '9999', boq_line_count: 1 });
    const c = detail(1, { status: 'ACTIVE', revisions: [revision(1, { status: 'EFFECTIVE', amount_vnd: '4704', boq_total_vnd: '4704', boq_line_count: 2 }), second] });
    open(opened(c, undefined, { boqLines: [...lines, boqLine(3, { contract_revision_id: 'r-2', revision: 2, amount_vnd: '9999', business_key: 'C01', line_no: 1 })] }));
    await ready();
    // The latest revision is shown first when none is a draft.
    expect(within(screen.getByTestId('boq-grid')).getAllByTestId('boq-row')).toHaveLength(1);
    expect(screen.getByTestId('revision-amount').textContent).toBe('9.999');
    const options = within(screen.getByLabelText(vi_['ctr.boq.revision.label'])).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Phiên bản 1 · Đang hiệu lực · 4.704 VND', 'Phiên bản 2 · Đang hiệu lực · 9.999 VND']);
    fireEvent.change(screen.getByLabelText(vi_['ctr.boq.revision.label']), { target: { value: REVISION_ID } });
    expect(within(screen.getByTestId('boq-grid')).getAllByTestId('boq-row')).toHaveLength(2);
    expect(screen.getByTestId('revision-amount').textContent).toBe('4.704');
  });

  it('opens on the revision named in the address', async () => {
    const draft = revision(1, { id: 'r-draft', revision: 2, kind: 'AMENDMENT', status: 'DRAFT', amount_vnd: '500', boq_total_vnd: '0', boq_line_count: 0 });
    const c = detail(1, { status: 'ACTIVE', revisions: [revision(1, { status: 'EFFECTIVE', amount_vnd: '4704' }), draft] });
    const h = opened(c);
    open(h, BOQ_MANAGER, undefined, `/?id=${contractId(1)}&revision=${REVISION_ID}`);
    await ready();
    expect(screen.getByTestId('revision-amount').textContent).toBe('4.704');
    cleanup();
    open(h);
    await ready();
    // With no revision named, the draft being worked on is the one shown.
    expect(screen.getByTestId('revision-amount').textContent).toBe('500');
    expect(screen.getByLabelText(vi_['ctr.boq.file.label'])).toBeTruthy();
  });

  it.each([
    ['a reader of the lines', BOQ_READER, undefined, contract(), vi_['ctr.readOnly.denied.notice']],
    ['a session that is read only', BOQ_MANAGER, 'READ_ONLY' as const, contract(), vi_['ctr.readOnly.frozen.notice']],
    ['a revision that was decided', BOQ_MANAGER, undefined, contract({}, { status: 'EFFECTIVE' }), vi_['ctr.boq.notDraft.notice']],
    ['a contract that is in review', BOQ_MANAGER, undefined, contract({ status: 'IN_REVIEW' }), vi_['ctr.boq.locked.notice']],
    ['a later revision of a contract that is not in force', BOQ_MANAGER, undefined, contract({ status: 'DRAFT' }, { kind: 'AMENDMENT' }), vi_['ctr.boq.locked.notice']],
  ])('lets %s see the lines but not import them', async (_name, permissions, mode, c, notice) => {
    open(opened(c), permissions, mode);
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(notice);
    expect(screen.queryByLabelText(vi_['ctr.boq.file.label'])).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['ctr.boq.import.action'] })).toBeNull();
    expect(within(screen.getByTestId('boq-grid')).getAllByTestId('boq-row')).toHaveLength(2);
  });

  it('lets the BOQ of a change order that waits for its day be put right, and not that of an amendment that waits', async () => {
    open(opened(contract({ status: 'ACTIVE' }, { kind: 'CHANGE_ORDER', status: 'PENDING_EFFECTIVE' })));
    await ready();
    expect(screen.getByLabelText(vi_['ctr.boq.file.label'])).toBeTruthy();
    expect(screen.queryByTestId('read-only')).toBeNull();
    cleanup();
    open(opened(contract({ status: 'ACTIVE' }, { kind: 'AMENDMENT', status: 'PENDING_EFFECTIVE' })));
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['ctr.boq.notDraft.notice']);
  });

  it('lets a later revision of a contract in force be imported', async () => {
    open(opened(contract({ status: 'ACTIVE' }, { kind: 'CHANGE_ORDER' })));
    await ready();
    expect(screen.getByLabelText(vi_['ctr.boq.file.label'])).toBeTruthy();
  });

  it('tells the default retention of the rule that waits for its confirmation (CXN-EXE-04)', async () => {
    open(opened());
    await ready();
    expect(screen.getByTestId('retention-rule').textContent).toBe(vi_['ctr.boq.retention.rule'].replace('{pct}', '5'));
  });

  it('imports the lines of a CSV file under the version it saw, with the hash of the file, and shows what the import gave (AC-ST-CTR-002-1)', async () => {
    const h = opened();
    open(h);
    await ready();
    await choose(CSV);
    expect((await screen.findByTestId('file-ready')).textContent).toBe(vi_['ctr.boq.file.ready'].replace('{name}', 'boq.csv').replace('{count}', '2'));
    submit();
    expect((await screen.findByTestId('result')).textContent).toContain(vi_['ctr.boq.result.done'].replace('{lines}', '2').replace('{items}', '2'));
    expect(screen.getByTestId('retention-defaulted').textContent).toBe(vi_['ctr.boq.result.retention'].replace('{count}', '2').replace('{pct}', '5'));
    expect(screen.getByTestId('result').textContent).toContain(vi_['ctr.boq.result.balanced']);
    const [operation, input] = sent(h)[0] ?? ['', undefined];
    expect(operation).toBe('importBoqLines');
    expect(input?.path.id).toBe(REVISION_ID);
    expect(input?.ifMatchVersion).toBe(1);
    expect(input?.body).toEqual({
      mode: 'REPLACE',
      file_sha256: createHash('sha256').update(CSV).digest('hex'),
      lines: [
        { business_key: 'B01', description: 'Đào đất', unit_code: 'M3', quantity: '3', unit_price: '1234.5' },
        { business_key: 'B02', description: 'Bê tông', unit_code: 'M3', quantity: '2', unit_price: '500' },
      ],
    });
    // The file is spent: a second click has nothing to send.
    expect((screen.getByRole('button', { name: vi_['ctr.boq.import.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('appends when asked to, explaining the two modes', async () => {
    const h = opened();
    open(h);
    await ready();
    expect(screen.getByText(vi_['ctr.boq.mode.replace.hint'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['ctr.boq.mode.label']), { target: { value: 'APPEND' } });
    expect(screen.getByText(vi_['ctr.boq.mode.append.hint'])).toBeTruthy();
    await choose(CSV);
    await screen.findByTestId('file-ready');
    submit();
    await screen.findByTestId('result');
    expect(sent(h)[0]?.[1].body.mode).toBe('APPEND');
  });

  it('says that a file already imported changed nothing (AC-ST-CTR-002-2)', async () => {
    open(opened(contract(), () => ({ ...IMPORTED, duplicate: true, retention_defaulted: 0 })));
    await ready();
    await choose(CSV);
    await screen.findByTestId('file-ready');
    submit();
    expect((await screen.findByTestId('result')).textContent).toContain(vi_['ctr.boq.result.duplicate'].replace('{count}', '2'));
    expect(screen.queryByTestId('retention-defaulted')).toBeNull();
  });

  it('says how far the lines are from the value when the import leaves a difference', async () => {
    open(opened(contract(), () => ({ ...IMPORTED, balanced: false, difference_vnd: '-1' })));
    await ready();
    await choose(CSV);
    await screen.findByTestId('file-ready');
    submit();
    expect((await screen.findByTestId('result')).textContent).toContain(vi_['ctr.boq.result.unbalanced'].replace('{difference}', '-1'));
  });

  it('shows no result when the answer has no figures, and a button that waits while the import runs', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const h = opened(contract(), () => new Promise((resolve) => (finish = resolve)) as unknown as Error);
    open(h);
    await ready();
    await choose(CSV);
    await screen.findByTestId('file-ready');
    submit();
    expect(await screen.findByRole('button', { name: vi_['ctr.boq.import.pending'] })).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['ctr.boq.import.pending'] }) as HTMLButtonElement).disabled).toBe(true);
    finish({ resource_id: REVISION_ID });
    await waitFor(() => expect(screen.queryByRole('button', { name: vi_['ctr.boq.import.pending'] })).toBeNull());
    expect(screen.queryByTestId('result')).toBeNull();
  });

  it.each([
    ['boq.xlsx', CSV, 'ctr.boq.file.notCsv.error', {}],
    ['boq.csv', `${HEADER}\n`, 'ctr.boq.file.empty.error', {}],
    ['boq.csv', `${HEADER},tax\nB01,x,M3,1,1,9`, 'ctr.boq.file.unknownColumn.error', { column: 'tax' }],
    ['boq.csv', 'business_key,description,unit_code,quantity\nB01,x,M3,1', 'ctr.boq.file.missingColumn.error', { column: 'unit_price' }],
    ['boq.csv', `${HEADER}\nB01,"open,M3,1,1`, 'ctr.boq.file.unreadable.error', {}],
  ] as const)('refuses the file %s before sending anything', async (name, content, key, params) => {
    const h = opened();
    open(h);
    await ready();
    await choose(content, name);
    let message: string = vi_[key];
    for (const [placeholder, value] of Object.entries(params)) message = message.replace(`{${placeholder}}`, value);
    expect((await screen.findByTestId('file-problem')).textContent).toBe(message);
    expect((screen.getByRole('button', { name: vi_['ctr.boq.import.action'] }) as HTMLButtonElement).disabled).toBe(true);
    submit();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('forgets the file when the choice is cleared', async () => {
    open(opened());
    await ready();
    await choose(CSV);
    await screen.findByTestId('file-ready');
    fireEvent.change(screen.getByLabelText(vi_['ctr.boq.file.label']), { target: { files: [] } });
    await waitFor(() => expect(screen.queryByTestId('file-ready')).toBeNull());
    expect((screen.getByRole('button', { name: vi_['ctr.boq.import.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists the faults of the rows the server refused, with the field and the reason of each, and says how many rows have faults', async () => {
    const faults = [
      { row: 1, field: 'quantity', reason: 'invalidNumber' },
      { row: 2, field: 'unit_code', reason: 'unitUnknown' },
      { row: 3, field: 'business_key', reason: 'duplicateKey' },
      { row: 0, field: 'tax_identifier', reason: 'notAllowed' },
      { row: 4, field: 'mystery', reason: 'mystery' },
    ];
    const h = opened(contract(), () => problem('VALIDATION_FAILED', 422, 'lines', { errors: faults, error_rows: 9 }));
    open(h);
    await ready();
    await choose(CSV);
    await screen.findByTestId('file-ready');
    submit();
    expect((await screen.findByTestId('problem')).textContent).toContain(vi_['ctr.boq.problem.rows.error'].replace('{count}', '9'));
    const rows = within(screen.getByTestId('faults')).getAllByTestId('fault-row');
    expect(rows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['1', vi_['ctr.boq.field.quantity.label'], vi_['ctr.boq.fault.invalidNumber.error']],
      ['2', vi_['ctr.boq.field.unitCode.label'], vi_['ctr.boq.fault.unitUnknown.error']],
      ['3', vi_['ctr.boq.field.businessKey.label'], vi_['ctr.boq.fault.duplicateKey.error']],
      [vi_['ctr.boq.faults.header'], 'tax_identifier', vi_['ctr.boq.fault.notAllowed.error']],
      ['4', 'mystery', vi_['ctr.boq.fault.general.error']],
    ]);
    expect(screen.getByText(vi_['ctr.boq.faults.more'].replace('{shown}', '5').replace('{total}', '9'))).toBeTruthy();
    // The file stays chosen: the person puts the file right and chooses it again.
    expect((screen.getByRole('button', { name: vi_['ctr.boq.import.action'] }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    [problem('BOQ_TOTAL_MISMATCH', 422, 'lines', { lines_total_vnd: '1001', revision_amount_vnd: '1000', difference_vnd: '1' }), vi_['ctr.boq.problem.totalMismatch.error'].replace('{lines}', '1.001').replace('{value}', '1.000')],
    [problem('BOQ_TOTAL_MISMATCH', 422), vi_['ctr.boq.problem.totalMismatchUnknown.error']],
    [problem('BOQ_LINE_DUPLICATE', 409, 'lines', { rows: [2, 5] }), vi_['ctr.boq.problem.duplicate.error'].replace('{rows}', '2, 5')],
    [problem('REVISION_NOT_DRAFT'), vi_['ctr.boq.problem.notDraft.error']],
    [problem('CONTRACT_STATE_INVALID', 409), vi_['ctr.boq.problem.stateInvalid.error']],
    [problem('VERSION_CONFLICT', 409), vi_['ctr.boq.problem.versionConflict.error']],
    [problem('FILE_NOT_CLEAN'), vi_['ctr.boq.problem.fileNotClean.error']],
    [problem('FILE_TYPE_NOT_ALLOWED'), vi_['ctr.boq.problem.fileType.error']],
    [problem('PAYLOAD_TOO_LARGE', 413), vi_['ctr.boq.problem.tooLarge.error']],
    [problem('VALIDATION_FAILED'), vi_['ctr.boq.problem.validation.error']],
    [problem('VALIDATION_FAILED', 422, 'mode'), vi_['ctr.boq.problem.validationField.error'].replace('{field}', 'mode')],
    [problem('RESOURCE_NOT_FOUND', 404), vi_['ctr.boq.problem.notFound.error']],
    [problem('SCOPE_DENIED', 403), vi_['ctr.boq.problem.denied.error']],
    [problem('SOMETHING_ELSE', 500), vi_['ctr.boq.problem.general.error']],
    [new Error('network'), vi_['ctr.boq.problem.general.error']],
  ])('answers a refusal of the import in a sentence (%#)', async (error, sentence) => {
    open(opened(contract(), () => error));
    await ready();
    await choose(CSV);
    await screen.findByTestId('file-ready');
    submit();
    expect((await screen.findByTestId('problem')).textContent).toBe(sentence);
    expect(screen.queryByTestId('faults')).toBeNull();
  });

  it('opens on the largest contract in force when none is named, with the note and a selector to switch to another (menu entry)', async () => {
    open(opened(detail(2), undefined, { details: [detail(1), detail(2)] }), BOQ_MANAGER, undefined, '/');
    expect((await screen.findByTestId('default-contract')).textContent).toContain(vi_['ctr.default.notice']);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`HD-A-002 · ${vi_['ctr.boq.page.title']}`));
    const select = screen.getByTestId('default-contract-select') as HTMLSelectElement;
    expect(select.value).toBe(contractId(2));
    expect(within(select).getAllByRole('option')).toHaveLength(2);
    fireEvent.change(select, { target: { value: contractId(1) } });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`HD-A-001 · ${vi_['ctr.boq.page.title']}`));
  });

  it('names no default and shows no selector when the address names the contract', async () => {
    open(opened());
    await ready();
    expect(screen.queryByTestId('default-contract')).toBeNull();
  });

  it('asks for a contract when none is named and the register is empty, and says when the contract is not found', async () => {
    open(opened(contract(), undefined, { contracts: [] }), BOQ_MANAGER, undefined, '/');
    expect((await screen.findByTestId('no-contract')).textContent).toBe(vi_['ctr.boq.noContract.notice']);
    cleanup();
    open(opened(contract(), undefined, { details: [], missing: problem('RESOURCE_NOT_FOUND', 404) }), BOQ_MANAGER, undefined, `/?id=${contractId(9)}`);
    await waitFor(() => expect(screen.queryByTestId('boq-grid')).toBeNull());
  });

  it('says so when the contract has no revision, and reaches the draft of the contract from the back link', async () => {
    open(opened(detail(1, { revisions: [] })));
    expect((await screen.findByTestId('no-revision')).textContent).toBe(vi_['ctr.boq.noRevision.notice']);
    expect(screen.getByRole('link', { name: new RegExp(vi_['ctr.back.draft.link']) }).getAttribute('href')).toBe(`/ctr/ctr-02?id=${contractId(1)}`);
    expect(screen.getByText(vi_['ctr.boq.footer.reference'].replace('{id}', 'CTR-04').replace('{req}', 'FR-CTR-04'))).toBeTruthy();
  });

  it('shows the state of the screen when a read fails or is refused', async () => {
    open(opened(contract(), undefined, { failing: new Set(['get_resources_boq_line']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open(opened(contract(), undefined, { failing: new Set(['get_resources_contract_id']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});
