import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import { compareRevisions, differenceDong, kilobytes, planShareTenths, stepHistory, toReportFigures } from './approval-detail-model';
import ApprovalDetailScreen from './ApprovalDetailScreen';
import ApprovalQueueScreen from './ApprovalQueueScreen';
import { approvalTask, mountPwa, pwaClient, taskId, word } from './test-support';

const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const DECIDER = ['approval_task.read', 'approval.decide'];
const REPORT = taskId(901);
const BEFORE = taskId(950);

const line = (bucket: string, level: string, allocated: string, cumulative: string, previous: string | null) => ({ bucket, budget_level: level, allocated_vnd: allocated, cumulative_vnd: cumulative, previous_cumulative_vnd: previous });
function report(id: string, revision: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    revision,
    status: 'SUBMITTED',
    is_late: false,
    supersedes_id: null,
    amendment_reason: null,
    project: { id: taskId(7), code: 'DA-01', name: 'Cầu Bằng Giang', status: 'ACTIVE' },
    period: { code: '2026-10' },
    plan_version: { fiscal_year: 2026, revision: 1, status: 'ACTIVE' },
    funding_lines: [line('CURRENT_YEAR', 'CENTRAL', '1000000000', '600000000', '400000000'), line('CARRYOVER', 'LOCAL', '500000000', '100000000', null)],
    totals: { allocated_vnd: '1500000000', cumulative_vnd: '700000000', ctmtqg_vnd: '50000000' },
    attachments: [{ id: taskId(31), file_name: 'bien-ban.pdf', content_type: 'application/pdf', size_bytes: 2048, file_sha256: 'abcdef0123456789abcdef0123456789' }],
    ...extra,
  };
}
const stepRow = (n: number, extra: Record<string, unknown> = {}) => ({ id: taskId(60 + n), step_index: n, step_id: `s${n}`, step_name: `Bước ${n}`, status: 'Decided', decision: 'approve', reason: null, decided_at: '2026-10-01T03:00:00.000Z', assignee: { id: taskId(5), name: 'Chuyên viên A' }, ...extra });

interface World {
  task?: Record<string, unknown> | Error;
  reports?: Record<string, unknown | Error>;
  steps?: unknown[] | Error;
}

function open(world: World, options: { permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; requestStepUp?: () => Promise<void> } = {}) {
  const h = pwaClient({
    read: (operation, input) => {
      if (operation === 'get_resources_approval_task_id') return world.task ?? approvalTask(1);
      if (operation === 'getReportRevision') {
        const id = (input as { path: { id: string } }).path.id;
        return world.reports?.[id] ?? new Error(`no report ${id}`);
      }
      return new Error(`unexpected read ${operation}`);
    },
    readAll: (operation) => {
      if (operation === 'get_resources_approval_task') return world.steps ?? [stepRow(1)];
      if (operation === 'get_resources_organization_unit') return [{ id: taskId(1), code: 'SO-A', name: 'Sở Kế hoạch', parent_id: null, valid_from: '2020-01-01', unit_type: 'DEPARTMENT', status: 'ACTIVE' }];
      return new Error(`unexpected ${operation}`);
    },
    command: options.command,
  });
  const mounted = mountPwa(
    <Routes>
      <Route path="/m/approvals/:taskId" element={<ApprovalDetailScreen />} />
    </Routes>,
    h,
    { permissions: 'permissions' in options ? options.permissions : DECIDER, ...(options.mode === undefined ? {} : { mode: options.mode }), path: `/m/approvals/${taskId(1)}`, ...(options.requestStepUp === undefined ? {} : { session: { requestStepUp: options.requestStepUp } }) },
  );
  return { ...h, ...mounted };
}

afterEach(cleanup);

describe('ApprovalDetailScreen (PWA-05)', () => {
  it('UAT-PWA-01 / AC-ST-PWA-001-1: names the project, period and unit, and compares the figures with the plan and the period before', async () => {
    const h = open({ reports: { [REPORT]: report(REPORT, 1) } });
    await screen.findByTestId('summary');
    await waitFor(() => expect(screen.getByTestId('project-name').textContent).toContain('Cầu Bằng Giang'));
    expect(screen.getByTestId('summary').textContent).toContain('2026-10');
    await waitFor(() => expect(screen.getByTestId('unit-name').textContent).toBe('Sở Kế hoạch'));
    // No id prefix of the record is shown.
    expect(document.body.textContent).not.toContain(REPORT.slice(0, 8));
    const plan = await screen.findByTestId('plan-comparison');
    expect(plan.textContent).toContain('Kế hoạch năm 2026');
    const cell = plan.querySelector('[data-cell="CURRENT_YEAR:CENTRAL"]') as HTMLElement;
    expect(cell.textContent).toContain('1.000.000.000');
    expect(cell.textContent).toContain('+200.000.000');
    expect(plan.querySelector('[data-cell="CARRYOVER:LOCAL"]')?.textContent).toContain(word('pwa2.approvalDetail.plan.noPrevious'));
    expect(screen.getByTestId('plan-share').textContent).toBe('46,7% kế hoạch');
    expect(h.read).toHaveBeenCalledWith('get_resources_approval_task_id', { path: { id: taskId(1) } });
    expect(h.read).toHaveBeenCalledWith('getReportRevision', { path: { id: REPORT } });
    await waitFor(() => expect(h.readAll).toHaveBeenCalledWith('get_resources_approval_task', { query: { workflow_instance_id: taskId(101) } }));
  });

  it('UAT-PWA-01: lists the evidence and the steps, and says the first report has no earlier one', async () => {
    open({ reports: { [REPORT]: report(REPORT, 1) }, steps: [stepRow(2, { decision: 'return', reason: 'Thiếu biên bản' }), stepRow(1)] });
    const evidence = await screen.findByLabelText(word('pwa2.approvalDetail.evidence.aria'));
    expect(evidence.textContent).toContain('bien-ban.pdf');
    expect(evidence.textContent).toContain('application/pdf, 2 KB');
    expect(evidence.textContent).toContain('abcdef0123456789…');
    const steps = await screen.findByLabelText(word('pwa2.approvalDetail.steps.aria'));
    expect(within(steps).getAllByRole('listitem').map((item) => item.getAttribute('data-step'))).toEqual([taskId(61), taskId(62)]);
    expect(steps.textContent).toContain('Thiếu biên bản');
    expect(await screen.findByTestId('summary')).toBeInTheDocument();
    expect(screen.getByText(word('pwa2.approvalDetail.revision.first'))).toBeInTheDocument();
  });

  it('UAT-PWA-01: compares a corrected revision with the one before it', async () => {
    open({ reports: { [REPORT]: report(REPORT, 2, { supersedes_id: BEFORE, amendment_reason: 'Sửa số kho bạc', funding_lines: [line('CURRENT_YEAR', 'CENTRAL', '1000', '600', '400')] }), [BEFORE]: report(BEFORE, 1, { funding_lines: [line('CURRENT_YEAR', 'CENTRAL', '1000', '500', null)] }) } });
    const comparison = await screen.findByTestId('revision-comparison');
    expect(comparison.textContent).toContain('Lần 2 so với lần 1');
    expect(comparison.textContent).toContain('Sửa số kho bạc');
    expect(comparison.textContent).toContain('500 → 600 (+100)');
  });

  it('UAT-PWA-01: leaves out a part the reader may not see, and says so; a lost connection is a failure to retry', async () => {
    open({ reports: { [REPORT]: failure(403, 'PERMISSION_DENIED') } });
    expect((await screen.findAllByText(word('pwa2.approvalDetail.unavailable.denied'))).length).toBeGreaterThan(0);
    expect(screen.getByTestId('summary')).toBeInTheDocument();
    expect(screen.getByTestId('actions')).toBeInTheDocument();
    cleanup();
    open({ reports: { [REPORT]: failure(0, NETWORK_ERROR_CODE) } });
    expect((await screen.findAllByRole('alert')).some((node) => node.textContent?.includes(word('pwa2.approvalDetail.readFailed.note')))).toBe(true);
  });

  it('says the item is not there for a 404 and shows no controls', async () => {
    open({ task: failure(404, 'RESOURCE_NOT_FOUND') });
    expect((await screen.findByTestId('not-found')).textContent).toContain(word('pwa2.approvalDetail.notFound.title'));
    expect(screen.queryByTestId('actions')).toBeNull();
  });

  it('shows no decision on a task that was decided meanwhile or in a read-only session', async () => {
    open({ task: approvalTask(1, { status: 'Decided', actions: { decide: false } }) });
    expect((await screen.findByTestId('not-pending')).textContent).toContain('Đã quyết định');
    expect(screen.queryByTestId('actions')).toBeNull();
    cleanup();
    open({ reports: { [REPORT]: report(REPORT, 1) } }, { mode: 'READ_ONLY' });
    await screen.findByTestId('read-only');
    expect(screen.queryByTestId('actions')).toBeNull();
  });

  it('is denied without the right to read, and asks the server nothing', async () => {
    const h = open({}, { permissions: ['home.read'] });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(h.read).not.toHaveBeenCalledWith('get_resources_approval_task_id', expect.anything());
  });

  it('UAT-PWA-01 / AC-ST-PWA-001-2: approves under the version on the screen with the idempotency key, and gives a receipt with the project name', async () => {
    const h = open({ reports: { [REPORT]: report(REPORT, 1) } });
    await waitFor(() => expect(screen.getByTestId('project-name').textContent).toContain('Cầu Bằng Giang'));
    fireEvent.click(within(screen.getByTestId('actions')).getByRole('button', { name: word('pwa.approvals.action.approve') }));
    const sheet = screen.getByRole('dialog', { name: word('pwa.approvals.sheet.approve.title') });
    expect(sheet.textContent).toContain('Cầu Bằng Giang');
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa.approvals.sheet.approve.submit') }));
    const receipt = await screen.findByTestId('receipt');
    expect(receipt.textContent).toContain(word('pwa.approvals.receipt.approved'));
    const calls = h.command.mock.calls.filter((call) => call[0] === 'decideApprovalTask').map((call) => call[1] as { path: { taskId: string }; body: Record<string, unknown>; ifMatchVersion: number; attempt: { key: string } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: { taskId: taskId(1) }, body: { decision: 'approve' }, ifMatchVersion: 3 });
    expect(calls[0]?.attempt.key).toBeTruthy();
  });

  it('UAT-PWA-01: requires a reason to return, asks for the second factor in place, and offers to reload after a conflict', async () => {
    let failWith: ApiError | undefined = failure(401, 'MFA_REQUIRED');
    let asked = 0;
    const h = open({ reports: { [REPORT]: report(REPORT, 1) } }, { command: () => failWith ?? { operation_id: 'o', status: 'OK', resource_version: 4 }, requestStepUp: () => { asked += 1; return Promise.resolve(); } });
    await screen.findByTestId('actions');
    fireEvent.click(screen.getByRole('button', { name: word('pwa.approvals.action.return') }));
    const sheet = screen.getByRole('dialog', { name: word('pwa.approvals.sheet.return.title') });
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa.approvals.sheet.return.submit') }));
    expect((await within(sheet).findByTestId('decision-problem')).textContent).toBe(word('pwa.approvals.problem.commentRequired'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Thiếu biên bản' } });
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa.approvals.sheet.return.submit') }));
    await within(sheet).findByText(word('pwa.approvals.problem.stepUp'));
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa.approvals.remedy.stepUp') }));
    expect(asked).toBe(1);
    failWith = failure(409, 'VERSION_CONFLICT');
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa.approvals.sheet.return.submit') }));
    fireEvent.click(await within(sheet).findByRole('button', { name: word('pwa2.approvalDetail.remedy.reload') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('has no serious accessibility violation and every control is a touch target (AC-ST-PWA-001-3)', async () => {
    open({ reports: { [REPORT]: report(REPORT, 1) } });
    await screen.findByTestId('plan-total');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    for (const control of document.querySelectorAll('[data-testid="actions"] button, [data-testid="pwa-back"]')) expect(control.className).toContain('pwa-touch');
  });
});

describe('approval detail model', () => {
  it('reads a report and refuses an answer that is not one', () => {
    const figures = toReportFigures(report(REPORT, 3))!;
    expect(figures).toMatchObject({ revision: 3, projectName: 'Cầu Bằng Giang', periodCode: '2026-10', cumulativeVnd: '700000000', allocatedVnd: '1500000000', planYear: 2026 });
    expect(figures.cells).toHaveLength(2);
    expect(figures.evidence[0]).toMatchObject({ fileName: 'bien-ban.pdf', hashHead: 'abcdef0123456789' });
    expect(toReportFigures(null)).toBeUndefined();
    expect(toReportFigures({ ...report(REPORT, 1), totals: { cumulative_vnd: '-5', ctmtqg_vnd: '0' } })).toBeUndefined();
    expect(toReportFigures({ ...report(REPORT, 1), project: undefined })).toBeUndefined();
  });

  it('UAT-PWA-01: computes exact differences and the share of the plan, with no rate over a plan of zero', () => {
    expect(differenceDong('9007199254740993', '1')).toBe('9007199254740992');
    expect(differenceDong('5', '9')).toBe('-4');
    expect(planShareTenths('467', '1000')).toBe(467);
    expect(planShareTenths('5', '0')).toBeNull();
    expect(planShareTenths('5', null)).toBeNull();
    expect(kilobytes(0)).toBe(0);
    expect(kilobytes(1)).toBe(1);
  });

  it('UAT-PWA-01: compares six cells and orders the steps by their index', () => {
    const now = toReportFigures(report(REPORT, 2))!;
    const before = toReportFigures(report(BEFORE, 1, { funding_lines: [line('CURRENT_YEAR', 'CENTRAL', '1', '700000000', null)] }))!;
    const changes = compareRevisions(before, now);
    expect(changes).toHaveLength(6);
    expect(changes.find((change) => change.bucket === 'CURRENT_YEAR' && change.level === 'CENTRAL')).toMatchObject({ changeVnd: '-100000000', changed: true });
    expect(changes.filter((change) => change.changed)).toHaveLength(2);
    expect(stepHistory([stepRow(3), stepRow(1), { nope: true }, stepRow(2)]).map((step) => step.stepIndex)).toEqual([1, 2, 3]);
  });
});

describe('ApprovalQueueScreen names and links (PWA-02)', () => {
  it('names the project of a report instead of the id prefix and links to the detail', async () => {
    const h = pwaClient({
      read: (operation) => (operation === 'getReportRevision' ? report(REPORT, 1) : new Error(`unexpected read ${operation}`)),
      readAll: (operation) => (operation === 'get_resources_approval_task' ? [approvalTask(1)] : operation === 'get_resources_organization_unit' ? [] : new Error(`unexpected ${operation}`)),
    });
    mountPwa(
      <Routes>
        <Route path="/m/approvals" element={<ApprovalQueueScreen />} />
      </Routes>,
      h,
      { permissions: DECIDER, path: '/m/approvals' },
    );
    await waitFor(() => expect(screen.getByTestId('record-name').textContent).toBe('Cầu Bằng Giang · 2026-10'));
    expect(document.body.textContent).not.toContain(REPORT.slice(0, 8));
    expect(document.querySelector('[data-action="detail"]')?.getAttribute('href')).toBe(`/m/approvals/${taskId(1)}`);
  });
});
