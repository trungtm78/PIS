import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { contractId, mount } from '../../ctr/test-support';
import { harness } from '../../sas/test-support';
import { routeOf } from '../../ast/handover/test-support';
import MaterialScreen from './MaterialScreen';

const ROUTE = routeOf('QMS-06', 'FR-QMS-06');
const SUPERVISOR = ['material.manage', 'material.record'];
const REPORT = '00000000-0000-4000-8000-0000000000e1';
const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const OK = { operation_id: 'o', status: 'REGISTERED', resource_version: 1, resource_id: 'new' };
const TODAY = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

const sample = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000d0${String(n).padStart(2, '0')}`,
  contract: { id: contractId(2), code: 'HD-A-002' },
  project_id: '00000000-0000-4000-8000-000000000001',
  boq_item_id: null,
  sample_code: `BT-060${n}`,
  material_kind: 'Bê tông B02',
  lab_name: 'Phòng thí nghiệm trung tâm',
  standard_ref: 'STD-BT-30',
  sampled_on: '2026-01-05',
  tested_on: null,
  result: 'PENDING',
  result_values: {},
  report_document_version_id: null,
  status: 'REGISTERED',
  nonconformance: null,
  created_at: `2026-10-25T01:00:0${n}.000000Z`,
  allowed: { record: true },
  version: 1,
  ...overrides,
});

afterEach(cleanup);

interface World {
  tests?: unknown[];
  testsNow?: () => unknown[];
  contracts?: unknown[];
  failing?: Set<string>;
  command?: (operation: string, input: unknown) => unknown;
}

function open(world: World = {}, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; query?: string } = {}) {
  const h = harness(() => new Error('unexpected read'), world.command ?? (() => OK));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (world.failing?.has(operation)) return Promise.reject(new Error('down'));
    if (operation === 'listMaterialTests') return Promise.resolve(world.testsNow === undefined ? (world.tests ?? []) : world.testsNow());
    if (operation === 'listMaterialContracts') return Promise.resolve(world.contracts ?? [{ id: contractId(2), code: 'HD-A-002', title: 'Hợp đồng số 2', project_id: contractId(9) }]);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  mount(<MaterialScreen route={ROUTE} />, h, { permissions: options.permissions ?? SUPERVISOR, path: `/qms/qms-06${options.query ?? ''}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const commandsOf = (h: ReturnType<typeof open>, operation: string) => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id: string }; body: Record<string, unknown>; ifMatchVersion?: number });
const readsOf = (h: ReturnType<typeof open>, operation: string): number => (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === operation).length;
const dialog = async (): Promise<HTMLElement> => screen.findByRole('dialog');
const row = (id: string): HTMLElement => document.querySelector(`[data-test="${id}"]`) as HTMLElement;

describe('MaterialScreen (QMS-06): the testing of materials', () => {
  it('UI-QMS-06: lists the samples with the material, the laboratory, the standard, the result, the report and the non-conformance', async () => {
    const pass = sample(1, { result: 'PASS', status: 'RESULT_RECORDED', tested_on: '2026-01-10', report_document_version_id: REPORT, allowed: { record: false }, version: 2 });
    const fail = sample(2, { result: 'FAIL', status: 'RESULT_RECORDED', tested_on: '2026-01-10', report_document_version_id: REPORT, nonconformance: { id: 'n-1', ncr_no: 'NCR-001', severity: 'MAJOR', status: 'OPEN' }, allowed: { record: false }, version: 2 });
    open({ tests: [pass, fail, sample(3)] });
    await screen.findByTestId('tests');
    const failed = row(fail.id);
    expect(within(failed).getByText('BT-0602')).toBeTruthy();
    expect(within(failed).getByText('Bê tông B02')).toBeTruthy();
    expect(within(failed).getByText('STD-BT-30')).toBeTruthy();
    expect(within(failed).getByText(text('qms.material.result.fail')).className).toBe('pill red');
    expect(within(failed).getByTestId('report').textContent).toBe(REPORT);
    expect(within(failed).getByTestId('ncr').textContent).toBe(`NCR-001 ${text('qms.material.severity.major')}`);
    expect(within(row(pass.id)).getByText(text('qms.material.result.pass')).className).toBe('pill green');
    expect(within(row(pass.id)).getByTestId('ncr').textContent).toBe('—');
    const waiting = row(sample(3).id);
    expect(within(waiting).getByText(text('qms.material.result.pending')).className).toBe('pill gray');
    expect(within(waiting).getByTestId('report').textContent).toBe('—');
    expect(document.querySelectorAll('[data-act="record"]')).toHaveLength(1);
  });

  it('keeps the table filtered to a contract that is no longer being performed, though no sample is offered on it', async () => {
    const ended = contractId(5);
    const h = open({ tests: [sample(1)] }, { query: `?contract=${ended}` });
    await screen.findByTestId('tests');
    expect(h.client.readAll).toHaveBeenCalledWith('listMaterialTests', { query: { contract_id: ended } });
    await waitFor(() => expect((document.getElementById('material-filter') as HTMLSelectElement).value).toBe(ended));
    expect(screen.getByRole('option', { name: text('qms.material.filter.ended') })).toBeTruthy();
  });

  it('says when there is no sample yet', async () => {
    open({ tests: [] });
    expect((await screen.findByTestId('empty')).textContent).toBe(text('qms.material.empty.notice'));
  });

  it('UAT-AC362: registers a sample on a contract being performed, and reads the table again', async () => {
    const h = open();
    fireEvent.click(await screen.findByRole('button', { name: text('qms.material.register.action') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    await waitFor(() => expect(Array.from((document.getElementById('material-contract') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['', contractId(2)]));
    pick('material-contract', contractId(2));
    pick('material-sample', ' BT-0601 ');
    pick('material-kind', 'Bê tông B02');
    pick('material-lab', 'Phòng thí nghiệm trung tâm');
    pick('material-standard', 'STD-BT-30');
    pick('material-sampled', TODAY);
    fireEvent.submit(form);
    await waitFor(() => expect(commandsOf(h, 'registerMaterialTest')).toHaveLength(1));
    expect(commandsOf(h, 'registerMaterialTest')[0]?.body).toEqual({ contract_id: contractId(2), sample_code: 'BT-0601', material_kind: 'Bê tông B02', lab_name: 'Phòng thí nghiệm trung tâm', standard_ref: 'STD-BT-30', sampled_on: TODAY });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(readsOf(h, 'listMaterialTests')).toBeGreaterThan(1));
  });

  it('starts the form on the contract the table is filtered to, and filters the table by contract', async () => {
    const h = open({}, { query: `?contract=${contractId(2)}` });
    await waitFor(() => expect((document.getElementById('material-filter') as HTMLSelectElement).value).toBe(contractId(2)));
    expect(h.client.readAll).toHaveBeenCalledWith('listMaterialTests', { query: { contract_id: contractId(2) } });
    fireEvent.click(await screen.findByRole('button', { name: text('qms.material.register.action') }));
    await dialog();
    await waitFor(() => expect((document.getElementById('material-contract') as HTMLSelectElement).value).toBe(contractId(2)));
  });

  it('names what is wrong before registering: nothing typed, a day in the future', async () => {
    const h = open();
    fireEvent.click(await screen.findByRole('button', { name: text('qms.material.register.action') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect((await screen.findAllByText(text('qms.material.problem.required'))).length).toBe(5);
    pick('material-sampled', '2999-01-01');
    fireEvent.submit(form);
    expect(await screen.findByText(text('qms.material.problem.future'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says in words why the server refused a registration, and keeps the dialog open', async () => {
    for (const [error, key] of [
      [problem('SAMPLE_CODE_DUPLICATE', {}, 409), 'duplicate'],
      [problem('CONTRACT_STATE_INVALID', {}, 409), 'contractState'],
      [problem('VALIDATION_FAILED', { reason: 'IN_THE_FUTURE' }), 'future'],
      [problem('SCOPE_DENIED', {}, 403), 'denied'],
      [problem('RESOURCE_NOT_FOUND', {}, 404), 'notFound'],
      [problem('VALIDATION_FAILED'), 'validation'],
      [problem('INTERNAL_ERROR', {}, 500), 'general'],
    ] as const) {
      open({ command: () => error });
      fireEvent.click(await screen.findByRole('button', { name: text('qms.material.register.action') }));
      const form = (await dialog()).querySelector('form') as HTMLFormElement;
      await waitFor(() => expect((document.getElementById('material-contract') as HTMLSelectElement).options.length).toBe(2));
      pick('material-contract', contractId(2));
      pick('material-sample', 'BT-1');
      pick('material-kind', 'Concrete');
      pick('material-lab', 'Lab');
      pick('material-standard', 'STD');
      fireEvent.submit(form);
      expect((await screen.findByTestId('refusal')).textContent).toBe(text(`qms.material.error.${key}`));
      expect(screen.getByRole('dialog')).toBeTruthy();
      cleanup();
    }
  });

  it('UAT-AC362: records a result with the day, the values and the report, at the version it saw, and says a failed one raises a non-conformance', async () => {
    const h = open({ tests: [sample(1)] });
    fireEvent.click(await screen.findByRole('button', { name: text('qms.material.act.record') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    expect(screen.queryByTestId('fail-notice')).toBeNull();
    pick('material-result', 'FAIL');
    expect(screen.getByTestId('fail-notice').textContent).toBe(text('qms.material.result.failNotice'));
    pick('material-tested', TODAY);
    pick('material-values', '{"cuong_do_mpa": 18.5}');
    pick('material-report', ` ${REPORT} `);
    fireEvent.submit(form);
    await waitFor(() => expect(commandsOf(h, 'recordMaterialTestResult')).toHaveLength(1));
    expect(commandsOf(h, 'recordMaterialTestResult')[0]).toMatchObject({
      path: { id: sample(1).id },
      body: { result: 'FAIL', tested_on: TODAY, result_values: { cuong_do_mpa: 18.5 }, report_document_version_id: REPORT },
      ifMatchVersion: 1,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('names what is wrong before recording: no result, no report, values that are not an object, a day before the sample', async () => {
    const h = open({ tests: [sample(1, { sampled_on: TODAY })] });
    fireEvent.click(await screen.findByRole('button', { name: text('qms.material.act.record') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    pick('material-values', '');
    fireEvent.submit(form);
    expect(await screen.findAllByText(text('qms.material.problem.required'))).toHaveLength(2);
    expect(screen.getByText(text('qms.material.problem.object'))).toBeTruthy();
    pick('material-result', 'PASS');
    pick('material-values', '{}');
    pick('material-report', REPORT);
    pick('material-tested', '2020-01-01');
    fireEvent.submit(form);
    expect(await screen.findByText(text('qms.material.problem.early'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says in words why the server refused a result', async () => {
    for (const [error, key] of [
      [problem('MATERIAL_TEST_STATE_INVALID', {}, 409), 'state'],
      [problem('VERSION_CONFLICT', {}, 409), 'conflict'],
      [problem('DOCUMENT_NOT_CLEAN'), 'notClean'],
      [problem('VALIDATION_FAILED', { reason: 'BEFORE_SAMPLE' }), 'early'],
      [problem('CONTRACT_STATE_INVALID', {}, 409), 'contractState'],
    ] as const) {
      const h = open({ tests: [sample(1)], command: () => error });
      fireEvent.click(await screen.findByRole('button', { name: text('qms.material.act.record') }));
      const form = (await dialog()).querySelector('form') as HTMLFormElement;
      pick('material-result', 'PASS');
      pick('material-report', REPORT);
      const before = readsOf(h, 'listMaterialTests');
      fireEvent.submit(form);
      expect((await screen.findByTestId('refusal')).textContent).toBe(text(`qms.material.error.${key}`));
      await waitFor(() => expect(readsOf(h, 'listMaterialTests')).toBeGreaterThan(before));
      cleanup();
    }
  });

  it('sends the version the table shows now when the result is tried again after a conflict, and drops the dialog once the test has its result', async () => {
    let current = sample(1, { version: 1 });
    let refuse = true;
    const h = open({ testsNow: () => [current], command: () => (refuse ? problem('VERSION_CONFLICT', {}, 409) : OK) });
    fireEvent.click(await screen.findByRole('button', { name: text('qms.material.act.record') }));
    const form = (await dialog()).querySelector('form') as HTMLFormElement;
    pick('material-result', 'PASS');
    pick('material-report', REPORT);
    current = sample(1, { version: 2 });
    fireEvent.submit(form);
    expect((await screen.findByTestId('refusal')).textContent).toBe(text('qms.material.error.conflict'));
    refuse = false;
    await waitFor(() => expect(readsOf(h, 'listMaterialTests')).toBeGreaterThan(1));
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(commandsOf(h, 'recordMaterialTestResult')).toHaveLength(2));
    expect(commandsOf(h, 'recordMaterialTestResult').map((call) => call.ifMatchVersion)).toEqual([1, 2]);
    cleanup();

    let moving = sample(1, { version: 1 });
    open({ testsNow: () => [moving], command: () => problem('MATERIAL_TEST_STATE_INVALID', {}, 409) });
    fireEvent.click(await screen.findByRole('button', { name: text('qms.material.act.record') }));
    const second = (await dialog()).querySelector('form') as HTMLFormElement;
    pick('material-result', 'PASS');
    pick('material-report', REPORT);
    moving = sample(1, { result: 'PASS', status: 'RESULT_RECORDED', allowed: { record: false }, version: 2 });
    fireEvent.submit(second);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers the actions the server allows and no others: nothing to register or record while the tenant is read-only, and no list without the right', async () => {
    open({ tests: [sample(1)] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('tests');
    expect(screen.queryByRole('button', { name: text('qms.material.register.action') })).toBeNull();
    expect(document.querySelectorAll('[data-act="record"]')).toHaveLength(0);
    cleanup();
    const h = open({ tests: [sample(1)] }, { permissions: ['material.record'] });
    expect((await screen.findByTestId('no-right')).textContent).toBe(text('qms.material.noRight.notice'));
    expect(readsOf(h, 'listMaterialTests')).toBe(0);
  });

  it('says the contracts could not be loaded, keeps the table and loads them again', async () => {
    const h = open({ tests: [sample(1)], failing: new Set(['listMaterialContracts']) });
    expect(await screen.findByTestId('contracts-failed')).toBeTruthy();
    expect(screen.getByTestId('tests')).toBeTruthy();
    expect(screen.queryByRole('button', { name: text('qms.material.register.action') })).toBeNull();
    const before = readsOf(h, 'listMaterialContracts');
    fireEvent.click(screen.getByRole('button', { name: text('qms.material.contracts.retry.action') }));
    await waitFor(() => expect(readsOf(h, 'listMaterialContracts')).toBeGreaterThan(before));
  });

  it('offers a retry when the tests could not be read', async () => {
    const h = open({ failing: new Set(['listMaterialTests']) });
    fireEvent.click(await screen.findByRole('button', { name: text('states.retry.action') }));
    await waitFor(() => expect(readsOf(h, 'listMaterialTests')).toBeGreaterThanOrEqual(2));
  });

  it('closes a dialog with the close button and with cancel, sending nothing', async () => {
    const h = open({ tests: [sample(1)] });
    fireEvent.click(await screen.findByRole('button', { name: text('qms.material.act.record') }));
    await dialog();
    fireEvent.click(screen.getByRole('button', { name: text('qms.material.dialog.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: text('qms.material.act.record') }));
    await dialog();
    fireEvent.click(screen.getByRole('button', { name: text('qms.material.dialog.close') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).not.toHaveBeenCalled();
  });
});
