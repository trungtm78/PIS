import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import part from '../../../i18n/vi.json';
import type { WebRoute } from '../../../routes/types';
import { harness, mount } from '../../sas/test-support';
import AppraisalListScreen from './AppraisalListScreen';
import AppraisalWorkbenchScreen from './AppraisalWorkbenchScreen';
import { OWNER, raw } from './test/fixtures';

const catalogue = { ...(vi_ as Record<string, string>), ...(part as Record<string, string>) };
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), catalogue[key] ?? key);
const routeOf = (id: string, title: string): WebRoute => ({ id, path: `/prj/${id.toLowerCase()}`, title, kind: 'list', area: 'investment', module: 'PRJ', group: 'Danh mục & theo dõi', role: 'workspace', parent: null, req: `FR-PRJ-${id.slice(4)}` });
const APPRAISAL = '00000000-0000-4000-8000-0000000000a1';
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const PERMISSIONS = ['project.fin.read', 'project.fin.manage', 'project.fin.submit', 'project.fin.approve', 'project.fin.export'];

afterEach(() => cleanup());
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:fin'), configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
  // jsdom does not navigate: the click that saves a file is only recorded.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

const listPage = (items: Array<Record<string, unknown>>, create = true) => ({ items, total: items.length, actions: { create }, as_of: '2026-11-08T03:05:00.000Z' });
const listItem = (over: Record<string, unknown> = {}) => ({
  id: APPRAISAL,
  code: 'FIN-2026-0001',
  revision: 1,
  title: 'Cải tạo chiếu sáng',
  kind: 'FINANCIAL',
  status: 'DRAFT',
  version: 3,
  owner_unit: { id: 'u', code: 'BQL1', name: 'Ban QLDA 1' },
  project: { id: 'p', code: 'DA-001' },
  package: null,
  contract: null,
  result_state: 'COMPUTED',
  npv: '1388.77',
  irr_pct: '24.888336',
  payback_periods: '2.6000',
  index_pct: null,
  created_by_name: 'Nguyễn Văn A',
  approved_by_name: null,
  updated_at: '2026-11-08T02:30:00.000Z',
  ...over,
});

describe('PRJ-23: the list of appraisals', () => {
  const route = routeOf('PRJ-23', 'Thẩm định hiệu quả đầu tư');

  it('shows the figures the server computed, the state of each (tentative, frozen), the unit chip and the time it was read', async () => {
    const h = harness(() => listPage([listItem(), listItem({ id: 'b', code: 'FIN-2026-0002', status: 'APPROVED', result_state: 'FROZEN', approved_by_name: 'Trần B', kind: 'NON_FINANCIAL', npv: null, irr_pct: null, payback_periods: null, index_pct: '70.00' })]));
    mount(<AppraisalListScreen route={route} />, h, PERMISSIONS, '/prj/prj-23');
    expect(await screen.findByText(/FIN-2026-0001/)).toBeTruthy();
    expect(screen.getByText('1.388,77')).toBeTruthy();
    expect(screen.getByText('24,888336%')).toBeTruthy();
    expect(screen.getByText(text('fin1.results.state.computed'))).toBeTruthy();
    expect(screen.getByText(text('fin1.results.state.frozen'))).toBeTruthy();
    expect(screen.getByText('70,00%')).toBeTruthy();
    expect(screen.getByText('Nguyễn Văn A → Trần B')).toBeTruthy();
    expect(screen.getAllByText('Nguyễn Văn A')).toHaveLength(1);
    expect(screen.getByText(text('fin1.list.note'))).toBeTruthy();
    expect(screen.getByRole('link', { name: /FIN-2026-0001/ }).getAttribute('href')).toBe(`/prj/prj-24?appraisal=${APPRAISAL}`);
    expect(h.read).toHaveBeenCalledWith('listInvestmentAppraisals', expect.objectContaining({ query: { limit: 50, offset: 0 } }));
  });

  it('asks for the filter and says "nothing found" differently from "nothing yet"', async () => {
    const h = harness((_operation, input) => listPage((input as { query: { status?: string } }).query.status === 'APPROVED' ? [] : [listItem()]));
    mount(<AppraisalListScreen route={route} />, h, PERMISSIONS, '/prj/prj-23');
    await screen.findByText(/FIN-2026-0001/);
    fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'APPROVED' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listInvestmentAppraisals', expect.objectContaining({ query: { limit: 50, offset: 0, status: 'APPROVED' } })));
    await waitFor(() => expect(screen.queryByText(/FIN-2026-0001/)).toBeNull());
  });

  it('is a skeleton while it loads, names a refusal as denied, and retries an error in place', async () => {
    let calls = 0;
    const h = harness(() => {
      calls += 1;
      return calls === 1 ? new Error('boom') : listPage([listItem()]);
    });
    mount(<AppraisalListScreen route={route} />, h, PERMISSIONS, '/prj/prj-23');
    expect(screen.getByRole('status', { busy: true })).toBeTruthy();
    fireEvent.click(await screen.findByText(text('states.retry.action')));
    expect(await screen.findByText(/FIN-2026-0001/)).toBeTruthy();
    cleanup();
    const denied = harness(() => refusal('FORBIDDEN', 403));
    mount(<AppraisalListScreen route={route} />, denied, PERMISSIONS, '/prj/prj-23');
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('opens a draft from a project and goes to its workbench; offers nothing to who may not open one', async () => {
    const h = harness(() => listPage([], true), (operation) => (operation === 'createInvestmentAppraisal' ? { resource_id: APPRAISAL, code: 'FIN-2026-0009' } : {}));
    mount(<AppraisalListScreen route={route} />, h, PERMISSIONS, `/prj/prj-23?project=${APPRAISAL}`);
    fireEvent.change(await screen.findByTestId('create-title'), { target: { value: 'Hồ sơ mới' } });
    expect((screen.getByTestId('create-project') as HTMLInputElement).value).toBe(APPRAISAL);
    expect((screen.getByTestId('create-unit') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('createInvestmentAppraisal', expect.objectContaining({ body: { title: 'Hồ sơ mới', kind: 'FINANCIAL', project_id: APPRAISAL } })));
    cleanup();
    const closed = harness(() => listPage([], false));
    mount(<AppraisalListScreen route={route} />, closed, ['project.fin.read'], '/prj/prj-23');
    await waitFor(() => expect(closed.read).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('status', { busy: true })).toBeNull());
    expect(screen.queryByTestId('create-submit')).toBeNull();
  });

  it('refuses a form that has neither a project nor a unit, and says what the server refused', async () => {
    const h = harness(() => listPage([]), () => refusal('RESOURCE_NOT_FOUND', 404));
    mount(<AppraisalListScreen route={route} />, h, PERMISSIONS, '/prj/prj-23');
    fireEvent.change(await screen.findByTestId('create-title'), { target: { value: 'Hồ sơ' } });
    expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('create-unit'), { target: { value: OWNER } });
    fireEvent.click(screen.getByTestId('create-submit'));
    expect((await screen.findByTestId('create-error')).textContent).toBe(text('fin1.error.refused', { code: 'RESOURCE_NOT_FOUND' }));
  });
});

const workbench = (over: Record<string, unknown> = {}) => ({ ...raw(), ...over });
const route24 = routeOf('PRJ-24', 'Bàn thẩm định hiệu quả đầu tư');
const open = (h: ReturnType<typeof harness>, permissions: readonly string[] = PERMISSIONS) => mount(<AppraisalWorkbenchScreen route={route24} />, h, permissions, `/prj/prj-24?appraisal=${APPRAISAL}`);

describe('PRJ-24: the workbench', () => {
  it('says what to open it from when the address names nothing, and reads nothing', () => {
    const h = harness(() => ({}));
    mount(<AppraisalWorkbenchScreen route={route24} />, h, PERMISSIONS, '/prj/prj-24');
    expect(screen.getByTestId('no-target').textContent).toBe(text('fin1.work.noTarget'));
    expect(h.read).not.toHaveBeenCalled();
  });

  it('says the empty state in Vietnamese, with no raw English word of the address', () => {
    const h = harness(() => ({}));
    mount(<AppraisalWorkbenchScreen route={route24} />, h, PERMISSIONS, '/prj/prj-24');
    expect(screen.getByTestId('no-target').textContent).not.toMatch(/appraisal/i);
    expect((vi_ as Record<string, string>)['fin1.work.noTarget']).not.toMatch(/appraisal/i);
  });

  it('treats an appraisal that is not there for the caller as missing, never as empty', async () => {
    open(harness(() => refusal('RESOURCE_NOT_FOUND', 404)));
    expect((await screen.findByTestId('missing')).textContent).toBe(text('fin1.work.missing'));
  });

  it('shows the results the server computed, each with its "i", and the AI note that it only explains', async () => {
    open(harness(() => workbench()));
    expect(await screen.findByTestId('npv')).toBeTruthy();
    expect(within(screen.getByTestId('npv')).getByText('388,77')).toBeTruthy();
    expect(within(screen.getByTestId('irr')).getByText('24,888336')).toBeTruthy();
    expect(within(screen.getByTestId('payback')).getByText('2,6000')).toBeTruthy();
    expect(within(screen.getByTestId('bcr')).getByText('1,3888')).toBeTruthy();
    expect(within(screen.getByTestId('tco')).getByText('1.000,00')).toBeTruthy();
    expect(screen.getByTestId('ai-note').textContent).toBe(text('fin1.results.aiNote'));
    const info = within(screen.getByTestId('npv')).getByRole('button', { name: text('fin1.info.open', { name: text('fin1.measure.npv') }) });
    fireEvent.click(info);
    const panel = await screen.findByRole('dialog', { name: text('fin1.measure.npv') });
    expect(within(panel).getByText(/NPV = Σ CF\(t\)/)).toBeTruthy();
    expect(within(panel).getAllByText(/fin-analysis\/1\.0\.0/)).toBeDefined();
    expect(within(panel).getByText(/Mỗi dòng tiền phát sinh vào cuối kỳ/)).toBeTruthy();
  });

  it('shows a measure that does not apply with its reason, never as zero', async () => {
    const none = { ...raw().results as { report: { analysis: { irr: Record<string, unknown> } } } };
    none.report.analysis.irr = { ...none.report.analysis.irr, status: 'NOT_APPLICABLE', value: null, reason: 'MULTIPLE_ROOTS' };
    open(harness(() => workbench({ results: none })));
    const irr = await screen.findByTestId('irr');
    expect(within(irr).getByText(text('fin1.measure.na'))).toBeTruthy();
    expect(screen.getByTestId('irr-reason').textContent).toBe(text('fin1.reason.multipleRoots'));
  });

  it('puts the scenarios in tabs, the base first, and shows the figures and the deltas of the one chosen', async () => {
    open(harness(() => workbench()));
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([text('fin1.scenario.base')]);
    cleanup();
    open(harness(() => workbench({ scenarios: [{ code: 'FAVOURABLE', label: 'Thuận lợi', deltas: { benefitPct: '10' } }, { code: 'ADVERSE', label: 'Bất lợi', deltas: { benefitPct: '-15' } }] })));
    expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual([text('fin1.scenario.base'), 'Thuận lợi', 'Bất lợi']);
    expect(screen.getByTestId('tab-BASE').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByTestId('tab-ADVERSE'));
    expect(screen.getByTestId('tab-ADVERSE').getAttribute('aria-selected')).toBe('true');
    const panel = screen.getByTestId('tabpanel');
    expect(within(panel).getByTestId('deltas').textContent).toContain(text('fin1.param.benefitPct'));
    expect(within(panel).getByTestId('deltas').textContent).toContain('-15%');
    expect(within(panel).getByTestId('headline').textContent).toContain(text('fin1.measure.npv'));
  });

  it('shows the tornado, the one-way table of the parameter chosen, the two-way table and the switching values', async () => {
    open(harness(() => workbench()));
    expect(await screen.findByTestId('tornado')).toBeTruthy();
    expect(screen.getByTestId('tornado').querySelector('[data-parameter="benefitDelayPeriods"]')).not.toBeNull();
    fireEvent.change(screen.getByTestId('oneway-parameter'), { target: { value: 'capexPct' } });
    expect(screen.getAllByText(text('fin1.delta.percent', { value: '+20' })).length).toBeGreaterThan(0);
    const two = screen.getByTestId('twoway');
    expect(within(two).getAllByText('388,77').length).toBeGreaterThan(0);
    expect(screen.getByText('-27,99%')).toBeTruthy();
  });

  it('says plainly that the results are out of date, and lets nobody submit them', async () => {
    open(harness(() => workbench({ results_fresh: false })));
    expect((await screen.findByTestId('stale')).textContent).toBe(text('fin1.results.stale'));
    expect((screen.getByTestId('submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no results to show before the first computation', async () => {
    open(harness(() => workbench({ results: null, results_fresh: false })));
    expect((await screen.findByTestId('no-results')).textContent).toBe(text('fin1.results.none'));
    expect(screen.queryByTestId('npv')).toBeNull();
  });

  it('lets a draft be edited: the grid has no cell for a result, saving sends the version and only inputs', async () => {
    const h = harness(() => workbench(), () => ({ resource_version: 4 }));
    open(h);
    const rate = (await screen.findByTestId('rate')) as HTMLInputElement;
    expect(screen.getByTestId('lines').querySelectorAll('input').length).toBe(2 * 6);
    expect((screen.getByTestId('save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(rate, { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('benefit-1'), { target: { value: '350.5' } });
    expect((screen.getByTestId('save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number }];
    expect(operation).toBe('updateInvestmentAppraisalInputs');
    expect(input).toMatchObject({ path: { id: APPRAISAL }, ifMatchVersion: 3 });
    expect(input.body).toMatchObject({ discount_rate_pct: '12', lines: [{ period: 0, capex: '1000' }, { period: 1, benefit: '350.5' }] });
    expect(JSON.stringify(input.body)).not.toMatch(/npv|irr|payback|results/i);
    expect((await screen.findByTestId('message')).textContent).toBe(text('fin1.done.saved', { code: 'FIN-2026-0001', time: new Date().toISOString().slice(11, 16) }));
  });

  it('blocks a bad figure before it is sent and says nothing is saved', async () => {
    const h = harness(() => workbench());
    open(h);
    fireEvent.change(await screen.findByTestId('capex-0'), { target: { value: '1e3' } });
    expect((screen.getByTestId('capex-0') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByTestId('save') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('compute') as HTMLButtonElement).disabled).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('saves then computes in one step when the inputs changed, with the version that the save returned', async () => {
    const h = harness(() => workbench(), (operation) => (operation === 'updateInvestmentAppraisalInputs' ? { resource_version: 4 } : { resource_version: 5, result_hash: 'b'.repeat(64) }));
    open(h);
    fireEvent.change(await screen.findByTestId('rate'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('compute'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command.mock.calls[1]).toEqual(['runInvestmentAppraisal', expect.objectContaining({ path: { id: APPRAISAL }, ifMatchVersion: 4 })]);
    expect((await screen.findByTestId('message')).textContent).toBe(text('fin1.done.computed', { code: 'FIN-2026-0001', time: new Date().toISOString().slice(11, 16) }));
  });

  it('adds the default scenarios once and a period after the last one', async () => {
    const h = harness(() => workbench());
    open(h);
    fireEvent.click(await screen.findByTestId('add-defaults'));
    expect(screen.getByTestId('scenario-code-0')).toBeTruthy();
    expect((screen.getByTestId('scenario-0-benefitPct') as HTMLInputElement).value).toBe('10');
    expect((screen.getByTestId('scenario-1-benefitDelayPeriods') as HTMLInputElement).value).toBe('1');
    fireEvent.click(screen.getByTestId('add-defaults'));
    expect(screen.queryByTestId('scenario-code-2')).toBeNull();
    fireEvent.click(screen.getByTestId('add-line'));
    expect((screen.getByTestId('period-2') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByTestId('remove-2'));
    expect(screen.queryByTestId('period-2')).toBeNull();
  });

  it('lists the inputs nobody answers for yet, and keeps the source and owner on every row', async () => {
    open(harness(() => workbench()));
    const table = await screen.findByTestId('assumptions');
    expect(table.querySelectorAll('tbody tr').length).toBe(4);
    expect(table.querySelector('tr[data-input="CAPEX"]')?.getAttribute('data-answered')).toBe('yes');
    expect(table.querySelector('tr[data-input="HORIZON"]')?.getAttribute('data-answered')).toBe('no');
    expect(screen.getByText(text('fin1.assume.missing', { count: 3 }))).toBeTruthy();
    expect(screen.getByTestId('missing-inputs').textContent).toBe(text('fin1.work.missingInputs', { count: 3 }));
    expect((screen.getByTestId('submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says what is refused by the server in its own words, and offers to compare and choose on a version conflict', async () => {
    const h = harness(() => workbench(), () => refusal('VERSION_CONFLICT', 409));
    open(h);
    fireEvent.change(await screen.findByTestId('rate'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('conflict')).textContent).toContain(text('fin1.conflict.reload'));
    expect((screen.getByTestId('rate') as HTMLInputElement).value).toBe('8');
    fireEvent.click(screen.getByTestId('conflict-reload'));
    await waitFor(() => expect((screen.getByTestId('rate') as HTMLInputElement).value).toBe('10'));
    expect(screen.queryByTestId('conflict')).toBeNull();
  });

  it('submits a draft with fresh results and complete inputs, and says what comes next', async () => {
    const complete = workbench({ missing_assumptions: [] });
    const h = harness(() => complete, () => ({ resource_version: 4 }));
    open(h);
    const button = (await screen.findByTestId('submit')) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitInvestmentAppraisal', expect.objectContaining({ path: { id: APPRAISAL }, ifMatchVersion: 3 })));
    expect((await screen.findByTestId('message')).textContent).toBe(text('fin1.done.submitted', { code: 'FIN-2026-0001', time: new Date().toISOString().slice(11, 16) }));
  });

  it('names a missing input when the server refuses the submission', async () => {
    const h = harness(() => workbench({ missing_assumptions: [] }), () => refusal('APPRAISAL_ASSUMPTION_MISSING', 422, { missing: ['DISCOUNT_RATE', 'BENEFIT'] }));
    open(h);
    fireEvent.click(await screen.findByTestId('submit'));
    expect((await screen.findByTestId('message')).textContent).toBe(text('fin1.error.missing', { count: 2 }));
  });

  it('shows the approve and return buttons to the checker of a submitted appraisal and sends the version', async () => {
    const submitted = workbench({ status: 'SUBMITTED', submitted_by: { id: OWNER, name: 'Nguyễn Văn A' }, submitted_at: '2026-11-08T02:40:00.000Z', actions: { update_inputs: false, run: false, submit: false, approve: true, return: true, export: true, revise: false } });
    const h = harness(() => submitted, () => ({ resource_version: 4 }));
    open(h);
    expect((await screen.findByTestId('submitted-note')).textContent).toBe(text('fin1.work.submittedNote', { name: 'Nguyễn Văn A' }));
    expect((screen.getByTestId('rate') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('save')).toBeNull();
    fireEvent.click(screen.getByTestId('approve'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: text('fin1.actions.approve') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('approveInvestmentAppraisal', expect.objectContaining({ path: { id: APPRAISAL }, ifMatchVersion: 3, body: {} })));
    expect((await screen.findByTestId('message')).textContent).toBe(text('fin1.done.approved', { code: 'FIN-2026-0001', time: new Date().toISOString().slice(11, 16) }));
  });

  it('returns with a reason that is required, and shows a self-approval as refused', async () => {
    const submitted = workbench({ status: 'SUBMITTED', actions: { update_inputs: false, run: false, submit: false, approve: true, return: true, export: false, revise: false } });
    const h = harness(() => submitted, (operation) => (operation === 'approveInvestmentAppraisal' ? refusal('SELF_APPROVAL_DENIED', 403) : { resource_version: 4 }));
    open(h);
    fireEvent.click(await screen.findByTestId('return'));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: text('fin1.actions.return') }));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Chưa có căn cứ.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('fin1.actions.return') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('returnInvestmentAppraisal', expect.objectContaining({ body: { reason: 'Chưa có căn cứ.' }, ifMatchVersion: 3 })));
    cleanup();
    const again = harness(() => submitted, () => refusal('SELF_APPROVAL_DENIED', 403));
    open(again);
    fireEvent.click(await screen.findByTestId('approve'));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: text('fin1.actions.approve') }));
    expect((await screen.findByTestId('message')).textContent).toBe(text('fin1.error.selfApproval'));
  });

  it('shows an approved appraisal as frozen and read-only with the reason, and offers a new version', async () => {
    const approved = workbench({ status: 'APPROVED', frozen: true, approved_by: { id: '00000000-0000-4000-8000-000000000002', name: 'Trần B' }, approved_at: '2026-11-08T04:00:00.000Z', actions: { update_inputs: false, run: false, submit: false, approve: false, return: false, export: true, revise: true } });
    const h = harness(() => approved, () => ({ resource_id: '00000000-0000-4000-8000-0000000000a2' }));
    open(h);
    expect((await screen.findByTestId('readonly-reason')).textContent).toBe(text('fin1.work.approvedReadonly', { name: 'Trần B', time: '2026-11-08 04:00' }));
    expect(screen.getByTestId('frozen').textContent).toBe(text('fin1.results.frozen', { hash: 'a'.repeat(16), version: 'fin-analysis/1.0.0' }));
    expect(screen.queryByTestId('stale')).toBeNull();
    expect((screen.getByTestId('rate') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('compute')).toBeNull();
    fireEvent.click(screen.getByTestId('revise'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('createInvestmentAppraisal', expect.objectContaining({ body: { title: 'Cải tạo chiếu sáng', kind: 'FINANCIAL', revise_of: APPRAISAL } })));
  });

  it('exports the formulas and data and saves the file the server made, telling its hash', async () => {
    const h = harness(() => workbench(), () => ({ file_name: 'FIN-2026-0001-v1.csv', media_type: 'text/csv', content_base64: btoa('a,b'), sha256: 'c'.repeat(64) }));
    open(h);
    fireEvent.click(await screen.findByTestId('export-csv'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('exportInvestmentAppraisal', expect.objectContaining({ path: { id: APPRAISAL }, body: { format: 'CSV' } })));
    expect((await screen.findByTestId('message')).textContent).toBe(text('fin1.done.exported', { file: 'FIN-2026-0001-v1.csv', hash: 'c'.repeat(12) }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('shows no export and no edit to someone who may only read', async () => {
    const read = workbench({ actions: { update_inputs: false, run: false, submit: false, approve: false, return: false, export: false, revise: false } });
    open(harness(() => read), ['project.fin.read']);
    await screen.findByTestId('npv');
    expect(screen.queryByTestId('export-csv')).toBeNull();
    expect(screen.queryByTestId('save')).toBeNull();
    expect((screen.getByTestId('title') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('no-edit-right').textContent).toBe(text('fin1.work.noEditRight'));
  });

  it('scores the non-financial criteria of a group with the weights in force and the evidence of each score', async () => {
    const criteria = [{ key: 'urgency', label: 'Mức khẩn cấp', weight_pct: '60' }, { key: 'incident_history', label: 'Lịch sử sự cố', weight_pct: '40' }];
    const view = workbench({ kind: 'NON_FINANCIAL', criteria_category: 'SAFETY', criteria_in_force: { category: 'SAFETY', source: 'DEFAULT', version: 0, unverified: true, criteria }, lines: [], results: null, results_fresh: false });
    const h = harness(() => view, () => ({ resource_version: 4 }));
    open(h);
    const table = await screen.findByTestId('criteria');
    expect(within(table).getByText('Mức khẩn cấp')).toBeTruthy();
    expect(screen.getByText(text('fin1.criteria.unverified'))).toBeTruthy();
    fireEvent.change(screen.getByTestId('score-urgency'), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('evidence-urgency'), { target: { value: 'Biên bản kiểm tra' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect((h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body).toMatchObject({ criteria_category: 'SAFETY', scores: [{ key: 'urgency', score: 4, evidence: 'Biên bản kiểm tra' }] });
  });

  it('shows the criteria result with the weights it was computed with', async () => {
    const results = { report: null, criteria: { category: 'SAFETY', weightedScore: '4.40', indexPct: '88.00', formula: 'công thức', lines: [{ key: 'urgency', label: 'Mức khẩn cấp', weightPct: '60', score: 4, contribution: '2.400', evidence: 'Biên bản' }] } };
    open(harness(() => workbench({ kind: 'NON_FINANCIAL', results, criteria_category: 'SAFETY', criteria_used: { source: 'RULE', version: 2, criteria: [] } })));
    expect((await screen.findByTestId('criteria-score')).textContent).toBe(text('fin1.criteria.result.score', { value: '4,40' }));
    expect(screen.getByText(text('fin1.criteria.result.index', { value: '88,00' }))).toBeTruthy();
    expect(screen.getByText(text('fin1.criteria.used.rule', { version: 2 }))).toBeTruthy();
  });

  it('has a key for every reason, parameter, source and category that the server can name', async () => {
    for (const reason of ['noSignChange', 'multipleRoots', 'noRootInRange', 'rateAtOrBelowMinus100', 'notRecovered', 'noOutlay', 'noCosts', 'horizonZero', 'componentZero']) expect(catalogue[`fin1.reason.${reason}`]).toBeTruthy();
    for (const parameter of ['discountRatePp', 'benefitPct', 'capexPct', 'opexPct', 'maintenancePct', 'residualPct', 'benefitDelayPeriods']) expect(catalogue[`fin1.param.${parameter}`]).toBeTruthy();
    for (const source of ['document', 'estimate', 'market', 'standard', 'law', 'other']) expect(catalogue[`fin1.source.${source}`]).toBeTruthy();
    for (const key of ['horizon', 'discountRate', 'benefit', 'capex', 'opex', 'maintenance', 'residual']) expect(catalogue[`fin1.assume.${key}`]).toBeTruthy();
    expect(Object.keys(part).filter((key) => key.startsWith('fin1.')).length).toBeGreaterThan(0);
  });
});
