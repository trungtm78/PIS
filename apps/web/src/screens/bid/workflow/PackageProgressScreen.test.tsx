import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as translate } from '../../../i18n';
import PackageProgressScreen from './PackageProgressScreen';
import { ME, READER, SOMEONE, client, detailDto, itemId, mount, pkgId, route, wfId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = route('BID-29', 'FR-BID-29');
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);
const OK = { operation_id: 'o', status: 'IN_PROGRESS', resource_version: 6 };
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; path?: string } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<PackageProgressScreen route={ROUTE} />, h, { permissions: READER, path: options.path ?? `/bid/bid-29?package=${pkgId(1)}&node=S%3AOPEN_BIDDING%3ADOC_PREPARE`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const failing = (operation: string, error: Error): Map<string, { error: Error; times: number }> => new Map([[operation, { error, times: Infinity }]]);
const dialog = (): HTMLElement => screen.getByRole('dialog');

describe('PackageProgressScreen (BID-29): one package', () => {
  it('says where the package is: the stepper, the line under it, the countdown and what blocks it', async () => {
    open(world());
    expect(await screen.findByRole('heading', { level: 1, name: text('prc1.package.heading.title', { code: 'GT-1' }) })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: text('prc1.package.stepper.label') });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('DOC_PREPARE');
    expect(within(list).getByText('Trễ 4 ngày')).toBeInTheDocument();
    expect(screen.getByTestId('where').textContent).toBe('Đang ở Lập hồ sơ mời thầu · 6 ngày ở bước · trễ 4 ngày so với chuẩn · người giữ: Nguyễn Văn An · Quá hạn 3 ngày · 09/11');
    const blockers = screen.getByTestId('blockers');
    expect(within(blockers).getByText('Còn 1 mục bắt buộc chưa xong')).toBeInTheDocument();
    expect(within(blockers).getByText('Bước đã quá hạn 3 ngày')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: text('prc1.package.back.link') })).toHaveAttribute('href', '/bid/bid-27?node=S%3AOPEN_BIDDING%3ADOC_PREPARE');
  });

  it('shows the timeline day by day with the summary, the day strip and the filters, and asks the server to filter', async () => {
    const h = open(world());
    expect(await screen.findByTestId('summary')).toHaveTextContent('8 ngày ở bước Lập hồ sơ mời thầu · trễ 4 ngày · 2 thay đổi trong 30 ngày');
    const days = await screen.findAllByRole('heading', { level: 3 });
    expect(days.map((day) => day.textContent)).toEqual([expect.stringContaining('04/11/2026'), expect.stringContaining('02/11/2026')]);
    expect(screen.getByText('Hoàn thành mục: DOC_DRAFTED')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: text('ui.dayStrip.bars.label') })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: text('prc1.timeline.only.label') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getPackageWorkflowTimeline', { path: { package_id: pkgId(1) }, query: { only_state_changes: true } }));
    await userEvent.click(document.querySelector('[data-day="2026-11-04"]') as HTMLElement);
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getPackageWorkflowTimeline', { path: { package_id: pkgId(1) }, query: { from: '2026-11-04', to: '2026-11-04', only_state_changes: true } }));
  });

  it('exports the timeline as a file a spreadsheet opens, writing a cell that looks like a formula as text', async () => {
    const created: Blob[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const original = URL.createObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => { created.push(blob); return 'blob:x'; });
    URL.revokeObjectURL = vi.fn();
    const state = world();
    (state.detail.workflow as { timeline: { days: Array<{ entries: Array<Record<string, unknown>> }> } }).timeline.days[0]!.entries[0]!.reason = '=HYPERLINK("http://x")';
    open(state);
    await screen.findByTestId('summary');
    const button = await screen.findByRole('button', { name: text('prc1.timeline.export.action') });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(created).toHaveLength(1);
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(created[0]!);
    });
    // The byte order mark that makes a spreadsheet read the file as UTF-8.
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = Buffer.from(bytes).toString('utf8');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv.split('\r\n')[0]).toContain(text('prc1.export.day.label'));
    URL.createObjectURL = original;
  });

  it('lists the checklist with required and optional items, and completes an item with a document as evidence', async () => {
    const h = open(world());
    await userEvent.click(await screen.findByRole('tab', { name: text('prc1.package.tab.checklist') }));
    const items = screen.getByRole('list', { name: text('prc1.checklist.label') });
    expect(items.querySelectorAll(':scope > li')).toHaveLength(2);
    const open2 = items.querySelector('[data-item="ITEM_2"]') as HTMLElement;
    expect(within(open2).getByText(text('prc1.item.required.name'))).toBeInTheDocument();
    await userEvent.click(within(open2).getByRole('button', { name: text('prc1.item.complete.action') }));
    const d = dialog();
    await userEvent.type(within(d).getByLabelText(text('prc1.dialog.document.label')), '00000000-0000-4000-8000-00e000000001');
    await userEvent.click(within(d).getByRole('button', { name: text('prc1.dialog.complete.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('completePackageChecklistItem', expect.objectContaining({ path: { item_id: itemId(2) }, body: { evidence: [{ kind: 'DOCUMENT', document_id: '00000000-0000-4000-8000-00e000000001' }] } })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/Đã ghi lúc/)).toBeInTheDocument();
  });

  it('advances under the version it read, says it was done, and refreshes', async () => {
    const h = open(world());
    await userEvent.click(await screen.findByRole('button', { name: text('prc1.action.advance.action') }));
    const d = dialog();
    expect(within(d).getByText('Thẩm định hồ sơ mời thầu')).toBeInTheDocument();
    await userEvent.click(within(d).getByRole('button', { name: text('prc1.dialog.advance.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('advancePackageStep', expect.objectContaining({ path: { workflow_id: wfId(1) }, ifMatchVersion: 5, body: {} })));
    expect(await screen.findByText(/Đã chuyển sang Thẩm định hồ sơ mời thầu lúc/)).toBeInTheDocument();
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getPackageWorkflow').length).toBeGreaterThan(1);
  });

  it('says why an advance was refused, naming each blocker, and keeps the dialog open', async () => {
    open(world(), { command: () => problem('PACKAGE_WORKFLOW_BLOCKED', 409, { blockers: [{ code: 'REQUIRED_ITEM_OPEN', subject: 'ITEM_2' }, { code: 'STEP_EVIDENCE_MISSING', subject: 'DOCUMENT' }] }) });
    await userEvent.click(await screen.findByRole('button', { name: text('prc1.action.advance.action') }));
    await userEvent.click(within(dialog()).getByRole('button', { name: text('prc1.dialog.advance.confirm') }));
    const d = await screen.findByRole('dialog');
    expect(await within(d).findByRole('alert')).toHaveTextContent(text('prc1.error.blocked.text'));
    expect(within(d).getByText('Mục bắt buộc chưa xong: ITEM_2')).toBeInTheDocument();
    expect(within(d).getByText('Thiếu bằng chứng của bước: Tài liệu')).toBeInTheDocument();
  });

  it('handles a version conflict by offering to reload', async () => {
    const h = open(world(), { command: () => problem('VERSION_CONFLICT', 409) });
    await userEvent.click(await screen.findByRole('button', { name: text('prc1.action.advance.action') }));
    await userEvent.click(within(dialog()).getByRole('button', { name: text('prc1.dialog.advance.confirm') }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(text('prc1.error.version.text'));
    const before = h.read.mock.calls.filter(([operation]) => operation === 'getPackageWorkflow').length;
    await userEvent.click(within(dialog()).getByRole('button', { name: text('prc1.dialog.reload.action') }));
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getPackageWorkflow').length).toBeGreaterThan(before));
  });

  it('puts on hold only with a reason of five characters, and locks the button while it sends', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const h = open(world(), { command: () => new Promise((resolve) => { finish = resolve; }) });
    await userEvent.click(await screen.findByRole('button', { name: text('prc1.action.hold.action') }));
    const d = dialog();
    const confirm = within(d).getByRole('button', { name: text('prc1.dialog.hold.confirm') });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(new RegExp(text('prc1.dialog.reason.label'))), 'Chờ ý kiến của sở');
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('holdPackageWorkflow', expect.objectContaining({ ifMatchVersion: 5, body: { reason: 'Chờ ý kiến của sở' } }));
    expect(within(dialog()).getByRole('button', { name: text('ui.confirmDialog.pending') })).toBeDisabled();
    finish(OK);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('asks for an exception and lets another person decide it, but never the one who asked', async () => {
    const state = world({ detail: detailDto({}, { exceptions: [{ id: pkgId(7), kind: 'SKIP_ITEMS', status: 'REQUESTED', reason: 'Thiếu biên bản nhưng có xác nhận', requested_by: { id: SOMEONE, name: 'Nguyễn Văn An' }, requested_at: '2026-11-10T03:00:00.000Z', decided_by: null, decided_at: null, decision_note: null, step_code: 'DOC_PREPARE' }] }, { decide_exception: true }) });
    const h = open(state);
    await userEvent.click(await screen.findByRole('tab', { name: text('prc1.package.tab.checklist') }));
    const row = document.querySelector(`[data-exception="${pkgId(7)}"]`) as HTMLElement;
    expect(within(row).getByRole('group', { name: text('ui.makerChecker.label') })).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: text('prc1.exceptions.approve.action') }));
    await userEvent.click(within(dialog()).getByRole('button', { name: text('prc1.dialog.approve.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decidePackageStepException', expect.objectContaining({ path: { exception_id: pkgId(7) }, body: { decision: 'APPROVE' } })));
    cleanup();
    const mine = world({ detail: detailDto({}, { exceptions: [{ id: pkgId(7), kind: 'SKIP_ITEMS', status: 'REQUESTED', reason: 'Thiếu biên bản nhưng có xác nhận', requested_by: { id: ME, name: 'Tôi' }, requested_at: '2026-11-10T03:00:00.000Z', decided_by: null, decided_at: null, decision_note: null, step_code: 'DOC_PREPARE' }] }, { decide_exception: true }) });
    open(mine);
    await userEvent.click(await screen.findByRole('tab', { name: text('prc1.package.tab.checklist') }));
    expect(screen.queryByRole('button', { name: text('prc1.exceptions.approve.action') })).not.toBeInTheDocument();
  });

  it('offers only the commands the server says the caller may press, and none in read-only mode', async () => {
    open(world({ detail: detailDto({}, {}, { advance: false, hold: false, assign_owner: false, return: false, request_exception: false, cancel: false, work: false }) }));
    await screen.findByTestId('where');
    for (const key of ['prc1.action.advance.action', 'prc1.action.hold.action', 'prc1.action.assign.action', 'prc1.action.return.action', 'prc1.action.exception.action', 'prc1.action.cancel.action']) {
      expect(screen.queryByRole('button', { name: text(key) })).not.toBeInTheDocument();
    }
    cleanup();
    open(world(), { mode: 'READ_ONLY' });
    await screen.findByTestId('where');
    expect(screen.queryByRole('button', { name: text('prc1.action.advance.action') })).not.toBeInTheDocument();
  });

  it('a package on hold says why in the stepper and offers to resume', async () => {
    open(world({ detail: detailDto({}, { status: 'ON_HOLD', hold_reason: 'Chờ ý kiến của sở', blockers: [{ reason: 'ON_HOLD', count: null, detail: 'Chờ ý kiến của sở' }], late: false }, { resume: true, advance: false, hold: false }) }));
    expect(await screen.findByText('Quy trình đang tạm dừng: Chờ ý kiến của sở')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: text('prc1.action.resume.action') }).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-step="DOC_PREPARE"]')?.textContent).toContain('Tạm dừng');
  });

  it('a package that has no workflow says so, lists the steps it would follow and offers to start it', async () => {
    const h = open(world({ detail: detailDto({ workflow: null, startable: true, definition_steps: [{ code: 'PLAN_SELECTION', name: 'Lập kế hoạch lựa chọn nhà thầu', order: 1, standard_working_days: 10 }] }, {}, { start: true, advance: false }) as never }));
    expect(await screen.findByText(text('prc1.package.notStarted.title'))).toBeInTheDocument();
    expect(screen.getByText('Lập kế hoạch lựa chọn nhà thầu · chuẩn 10 ngày làm việc')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: text('prc1.action.start.action') }));
    await userEvent.click(within(dialog()).getByRole('button', { name: text('prc1.dialog.start.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('startPackageWorkflow', expect.objectContaining({ path: { package_id: pkgId(1) }, body: {} })));
  });

  it('shows the related records and the documents', async () => {
    open(world());
    await userEvent.click(await screen.findByRole('tab', { name: text('prc1.package.tab.related') }));
    expect(screen.getByRole('link', { name: text('prc1.related.milestones.link') })).toHaveAttribute('href', `/bid/bid-17?package=${pkgId(1)}`);
    expect(screen.getByText(/Đăng thông báo mời thầu \(nhập từ tệp muasamcong\)/)).toBeInTheDocument();
    expect(screen.getByText('2 kiến nghị, 1 đang chờ trả lời')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: text('prc1.package.tab.documents') }));
    expect(screen.getAllByRole('link', { name: 'Tài liệu' })[0]).toHaveAttribute('href', '/d/00000000-0000-4000-8000-00e000000001');
  });

  it('asks for a package when the address names none', async () => {
    open(world(), { path: '/bid/bid-29' });
    expect(await screen.findByTestId('choose-package')).toBeInTheDocument();
  });

  it('error retries, and a package outside the scope is shown as not available without a name', async () => {
    const state = world({ failing: failing('getPackageWorkflow', problem('RESOURCE_NOT_FOUND', 404)) });
    open(state);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('GT-1')).not.toBeInTheDocument();
    cleanup();
    open(world({ failing: failing('getPackageWorkflow', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text('states.denied.title'));
  });
});
