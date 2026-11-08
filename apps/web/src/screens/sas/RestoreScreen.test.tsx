import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import RestoreScreen from './RestoreScreen';
import { clock, canAskInPlace, canAskRestore, canDecide, describeProblem, isInsideWindow, isReasonValid, isRunning, toInstant, toLocalField, toMismatch, toReport, toRestore, toRestorePage } from './restore/model';
import { failureLabel, mismatchLabel, problemMessage, statusLabel, statusTone, targetLabel, tenantStatusLabel } from './restore/labels';
import { harness, mount, routeOf, PLATFORM_TENANT } from './test-support';

const ROUTE = routeOf('SAS-21', 'FR-SAS-21');
const ADMIN = ['system.tenant.read', 'system.tenant.manage'];
const READER = ['system.tenant.read'];
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const MINE = PLATFORM_TENANT.membershipId;
const OTHER_ADMIN = '00000000-0000-4000-8000-0000000000d2';
const WINDOW = { earliest: '2026-09-29T03:00:00Z', latest: '2026-11-03T03:00:00Z' };
const reason = 'A wrong import at noon must be undone for the province.';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

const report = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  matched: true,
  tables: [
    { table: 'contract', expected_rows: 3, restored_rows: 3, rows_match: true, expected_checksum: 'a', restored_checksum: 'a', checksum_match: true, money: [{ column: 'amount_vnd', expected: '1000000', restored: '1000000', match: true }] },
    { table: 'note', expected_rows: 10, restored_rows: 10, rows_match: true, expected_checksum: 'b', restored_checksum: 'b', checksum_match: true, money: [] },
  ],
  totals: { tables: 2, rows_expected: 13, rows_restored: 13, money_expected_vnd: '1000000', money_restored_vnd: '1000000' },
  foreign_rows: 0,
  mismatches: [],
  rpo_seconds: 0,
  rto_seconds: 372,
  rpo_target_seconds: 900,
  rto_target_seconds: 14_400,
  within_targets: true,
  ...overrides,
});

const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `restore-${n}`,
  recovery_point: '2026-11-01T02:00:00Z',
  target: 'SANDBOX',
  reason: `Reason ${n} for the restore of the tenant`,
  status: 'Requested',
  requested_by: OTHER_ADMIN,
  requested_at: '2026-11-03T01:00:00Z',
  decided_by: null,
  approved_by: null,
  decided_at: null,
  decision_reason: null,
  started_at: null,
  completed_at: null,
  restored_to: null,
  sandbox_ref: null,
  error_code: null,
  verification_report_ref: null,
  verification_report: null,
  version: 1,
  ...overrides,
});

const completed = (n: number) =>
  row(n, {
    status: 'Completed',
    approved_by: '9f3c1a2b-0000-4000-8000-000000000001',
    decided_by: '9f3c1a2b-0000-4000-8000-000000000001',
    decided_at: '2026-11-03T01:30:00Z',
    started_at: '2026-11-03T01:31:00Z',
    completed_at: '2026-11-03T01:37:12Z',
    restored_to: '2026-11-01T02:00:00Z',
    sandbox_ref: `mock-sandbox/restore-${n}`,
    verification_report_ref: `sha256:${'a'.repeat(64)}`,
    verification_report: report(),
    version: 5,
  });

afterEach(cleanup);

interface World {
  items?: Array<Record<string, unknown>> | Error;
  status?: string;
  window?: { earliest: string; latest: string } | null;
}

function open(permissions: readonly string[], world: World = {}, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation) => {
    switch (operation) {
      case 'listSystemTenants':
        return { items: [{ id: TENANT, code: 'minh-ha', name: 'Minh Hà' }], next_cursor: null };
      case 'listTenantRestoreRequests':
        return world.items instanceof Error
          ? world.items
          : { tenant_status: world.status ?? 'Active', tenant_version: 3, recovery_window: world.window === undefined ? WINDOW : world.window, rpo_target_seconds: 900, rto_target_seconds: 14_400, items: world.items ?? [], next_cursor: null };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  return { h, ...mount(<RestoreScreen route={ROUTE} />, h, permissions, '/sas/sas-21') };
}

const fill = async (point: string, text = reason): Promise<void> => {
  fireEvent.change(await screen.findByLabelText(vi_['sas.restore.ask.point.label']), { target: { value: point } });
  fireEvent.change(screen.getByLabelText(vi_['sas.restore.ask.reason.label']), { target: { value: text } });
};

describe('SAS-21 the restore of a tenant (UI-SAS-21)', () => {
  it('AC-ST-SAS-019-3 UI-SAS-21: renders the fields Điểm khôi phục, Phạm vi, Môi trường thử and Người duyệt, the recovery window and the targets, and the request form', async () => {
    open(ADMIN, { items: [completed(1), row(2)] });
    expect(await screen.findByRole('form', { name: vi_['sas.restore.ask.aria'] })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.restore.page.title']);
    expect(screen.getByLabelText(vi_['sas.restore.ask.point.label'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['sas.restore.target.sandbox'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['sas.restore.target.inPlace'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['sas.restore.ask.reason.label'])).toBeTruthy();
    const recovery = document.querySelector('[data-recovery]') as HTMLElement;
    expect(within(recovery).getByText(vi_['sas.restore.window.scope'])).toBeTruthy();
    expect(recovery.querySelector('[data-window]')?.textContent).toContain('(UTC)');
    expect(recovery.querySelector('[data-targets]')?.textContent).toBe('RPO tối đa 0:15:00, RTO tối đa 4:00:00');
    expect(recovery.querySelector('[data-tenant-status]')?.textContent).toBe(vi_['sas.restore.tenant.active']);
    const table = await screen.findByRole('table');
    for (const name of ['point', 'target', 'status', 'requested', 'approver', 'sandbox']) expect(within(table).getByRole('columnheader', { name: vi_[`sas.restore.column.${name}` as keyof typeof vi_] })).toBeTruthy();
    expect(vi_['sas.restore.column.point']).toBe('Điểm khôi phục');
    expect(vi_['sas.restore.window.scope']).toBe('Phạm vi');
    expect(vi_['sas.restore.column.sandbox']).toBe('Môi trường thử');
    expect(vi_['sas.restore.column.approver']).toBe('Người duyệt');
    const done = table.querySelector('[data-restore-id="restore-1"]') as HTMLElement;
    expect(within(done).getByText(vi_['sas.restore.status.completed'])).toBeTruthy();
    expect(within(done).getByText('mock-sandbox/restore-1')).toBeTruthy();
    expect(done.querySelector('[data-approver]')?.textContent).toContain('9f3c1a2b');
  });

  it('AC-ST-SAS-019-3 UI-SAS-21: shows the verification report of a Completed restore: rows, checksum and money per table, no row of another tenant, RPO and RTO against the targets and the sha256 reference', async () => {
    open(ADMIN, { items: [completed(1)] });
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.restore.report.show.action'] }));
    const panel = document.querySelector('[data-report]') as HTMLElement;
    expect(panel.getAttribute('data-matched')).toBe('true');
    expect(within(panel).getByText(vi_['sas.restore.report.matched'])).toBeTruthy();
    expect(panel.querySelector('[data-tables]')?.textContent).toBe('2');
    expect(panel.querySelector('[data-rows]')?.textContent).toBe('13 / 13');
    expect(panel.querySelector('[data-money]')?.textContent).toBe('1000000 / 1000000');
    expect(panel.querySelector('[data-foreign]')?.textContent).toBe(vi_['sas.restore.report.foreignNone']);
    expect(panel.querySelector('[data-rpo]')?.textContent).toBe('0:00:00 (mục tiêu 0:15:00)');
    expect(panel.querySelector('[data-rto]')?.textContent).toBe('0:06:12 (mục tiêu 4:00:00)');
    expect(panel.querySelector('[data-targets]')?.textContent).toBe(vi_['sas.restore.report.within']);
    expect(panel.querySelector('[data-reference]')?.textContent).toBe(`sha256:${'a'.repeat(64)}`);
    const contract = panel.querySelector('[data-table="contract"]') as HTMLElement;
    expect(contract.querySelector('[data-money-column="amount_vnd"]')?.getAttribute('data-match')).toBe('true');
    expect(panel.querySelector('[data-mismatches]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.report.hide.action'] }));
    expect(document.querySelector('[data-report]')).toBeNull();
  });

  it('AC-ST-SAS-019-3 UI-SAS-21: says in words what differs when a restore did not match, with the other tenant and the missed targets', async () => {
    const failed = row(3, {
      status: 'Failed',
      error_code: 'VERIFICATION_MISMATCH',
      approved_by: MINE,
      decided_by: MINE,
      decided_at: '2026-11-03T01:30:00Z',
      started_at: '2026-11-03T01:31:00Z',
      completed_at: '2026-11-03T01:37:12Z',
      restored_to: '2026-11-01T01:30:00Z',
      verification_report_ref: `sha256:${'b'.repeat(64)}`,
      verification_report: report({
        matched: false,
        foreign_rows: 2,
        mismatches: ['rows:note', 'checksum:contract', 'money:contract.amount_vnd', 'missing_table:payment', 'unexpected_table:extra', 'foreign_rows'],
        rpo_seconds: 1800,
        within_targets: false,
        tables: [{ table: 'note', expected_rows: 10, restored_rows: 9, rows_match: false, expected_checksum: 'b', restored_checksum: 'c', checksum_match: false, money: [{ column: 'amount_vnd', expected: '5', restored: '4', match: false }] }],
      }),
    });
    open(ADMIN, { items: [failed] });
    await screen.findByRole('table');
    expect(document.querySelector('[data-failure]')?.textContent).toContain(vi_['sas.restore.failure.mismatch']);
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.report.show.action'] }));
    const panel = document.querySelector('[data-report]') as HTMLElement;
    expect(panel.getAttribute('data-matched')).toBe('false');
    expect(within(panel).getByRole('alert').textContent).toBe('Bản khôi phục KHÔNG khớp bản sao lưu (6 điểm khác).');
    expect(panel.querySelector('[data-foreign]')?.textContent).toContain('2 dòng');
    expect(panel.querySelector('[data-targets]')?.textContent).toBe(vi_['sas.restore.report.outside']);
    const lines = [...panel.querySelectorAll('[data-mismatches] li')].map((item) => item.textContent);
    expect(lines).toEqual([
      'Bảng note: số dòng khác bản sao lưu.',
      'Bảng contract: checksum khác bản sao lưu.',
      'Cột tiền contract.amount_vnd: tổng khác bản sao lưu.',
      'Bảng payment có trong bản sao lưu nhưng không có trong bản khôi phục.',
      'Bảng extra có trong bản khôi phục nhưng không có trong bản sao lưu.',
      vi_['sas.restore.mismatch.foreignRows'],
    ]);
    const note = panel.querySelector('[data-table="note"]') as HTMLElement;
    expect(note.querySelector('[data-rows-match]')?.getAttribute('data-rows-match')).toBe('false');
    expect(note.querySelector('[data-checksum-match]')?.getAttribute('data-checksum-match')).toBe('false');
    expect(note.querySelector('[data-money-column="amount_vnd"]')?.getAttribute('data-match')).toBe('false');
  });

  it('asks for a restore to a recovery point inside the window, in a sandbox by default, with a reason; the point is read as UTC', async () => {
    const { h } = open(ADMIN, { items: [] }, () => ({ status: 'PENDING_APPROVAL' }));
    await fill('2026-11-01T02:00');
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.ask.submit.action'] }));
    expect(await screen.findByText(vi_['sas.restore.done.asked'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown }];
    expect(operation).toBe('requestTenantRestore');
    expect(input.path).toEqual({ tenantId: TENANT });
    expect(input.body).toEqual({ recovery_point: '2026-11-01T02:00:00.000Z', target: 'SANDBOX', reason });
    expect((screen.getByLabelText(vi_['sas.restore.ask.reason.label']) as HTMLTextAreaElement).value).toBe('');
    expect(await screen.findByText(vi_['sas.restore.list.none'])).toBeTruthy();
  });

  it('AC-ST-SAS-019-1 UI-SAS-21: an in-place restore can be chosen only while the tenant is Suspended', async () => {
    const { h } = open(ADMIN, { items: [], status: 'Active' }, () => ({ status: 'PENDING_APPROVAL' }));
    const inPlace = (await screen.findByLabelText(vi_['sas.restore.target.inPlace'])) as HTMLInputElement;
    expect(inPlace.disabled).toBe(true);
    expect(screen.getByText(vi_['sas.restore.ask.target.inPlaceRule'])).toBeTruthy();
    cleanup();
    const suspended = open(ADMIN, { items: [], status: 'Suspended' }, () => ({ status: 'PENDING_APPROVAL' }));
    const enabled = (await screen.findByLabelText(vi_['sas.restore.target.inPlace'])) as HTMLInputElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    await fill('2026-10-20T10:30');
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.ask.submit.action'] }));
    await screen.findByText(vi_['sas.restore.done.asked']);
    expect((suspended.h.command.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({ recovery_point: '2026-10-20T10:30:00.000Z', target: 'IN_PLACE', reason });
    expect(h.command).not.toHaveBeenCalled();
  });

  it('refuses a point outside the window or that is not a date, and a reason that is too short, and sends nothing', async () => {
    const { h } = open(ADMIN, { items: [] });
    await fill('2026-09-01T00:00', 'short');
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.ask.submit.action'] }));
    expect(await screen.findByText(vi_['sas.restore.ask.point.invalid'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.restore.ask.reason.tooShort'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['sas.restore.ask.point.label']), { target: { value: '2027-01-01T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.ask.submit.action'] }));
    expect(await screen.findByText(vi_['sas.restore.ask.point.invalid'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['sas.restore.ask.point.label']), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.ask.submit.action'] }));
    expect(await screen.findByText(vi_['sas.restore.ask.point.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says that no restore can be asked for where no engine is bound (no window), and in a state with no data', async () => {
    const { h } = open(ADMIN, { items: [], window: null });
    expect(await screen.findByText(vi_['sas.restore.window.noneRule'])).toBeTruthy();
    expect(document.querySelector('[data-window]')?.textContent).toBe(vi_['sas.restore.window.none']);
    expect((screen.getByRole('button', { name: vi_['sas.restore.ask.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: vi_['sas.restore.ask.aria'] }));
    expect(h.command).not.toHaveBeenCalled();
    cleanup();
    open(ADMIN, { items: [], status: 'Archived' });
    expect(await screen.findByText(vi_['sas.restore.ask.stateRule'])).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['sas.restore.ask.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('AC-ST-SAS-019-1 UI-SAS-21: the person who asked sees the request wait for another administrator and has no way to decide it', async () => {
    open(ADMIN, { items: [row(1, { requested_by: MINE }), row(2)] });
    const table = await screen.findByRole('table');
    const mine = table.querySelector('[data-restore-id="restore-1"]') as HTMLElement;
    expect(within(mine).queryByRole('button')).toBeNull();
    expect(within(mine).getByText(vi_['sas.restore.approver.other'])).toBeTruthy();
    const theirs = table.querySelector('[data-restore-id="restore-2"]') as HTMLElement;
    expect(within(theirs).getByRole('button', { name: vi_['sas.restore.approve.action'] })).toBeTruthy();
    expect(within(theirs).getByRole('button', { name: vi_['sas.restore.reject.action'] })).toBeTruthy();
    expect(within(theirs).getByText(vi_['sas.restore.approver.waiting'])).toBeTruthy();
  });

  it('approves a request of another administrator on the version it saw, with a reason, and says the restore will be made', async () => {
    const { h } = open(ADMIN, { items: [row(2, { version: 4 })] }, () => ({ status: 'APPROVED' }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.restore.approve.action'] }));
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.decide.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.restore.decide.reason.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['sas.restore.decide.reason.label']), { target: { value: 'The incident is confirmed by the owner.' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.decide.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.restore.done.approved'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('decideTenantRestore');
    expect(input.path).toEqual({ restoreId: 'restore-2' });
    expect(input.body).toEqual({ decision: 'approve', reason: 'The incident is confirmed by the owner.', evidence_ids: [] });
    expect(input.ifMatchVersion).toBe(4);
    expect(screen.queryByRole('form', { name: vi_['sas.restore.decide.aria'] })).toBeNull();
  });

  it('rejects a request, and aborting the decision sends nothing', async () => {
    const { h } = open(ADMIN, { items: [row(2)] }, () => ({ status: 'REJECTED' }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.restore.reject.action'] }));
    expect(screen.getByText(vi_['sas.restore.decide.rejectRule'])).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.decide.abort.action'] }));
    expect(screen.queryByRole('form', { name: vi_['sas.restore.decide.aria'] })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.reject.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['sas.restore.decide.reason.label']), { target: { value: 'The point was not the right one.' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.decide.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.restore.done.rejected'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(1);
    expect((h.command.mock.calls[0] as [string, { body: { decision: string } }])[1].body.decision).toBe('reject');
  });

  it('says why a request or a decision was refused, outside the form that may disappear, and reads the list again', async () => {
    for (const [error, message] of [
      [problem('SELF_APPROVAL_DENIED', 403), vi_['sas.restore.problem.selfApproval']],
      [problem('VERSION_CONFLICT'), vi_['sas.restore.problem.conflict']],
      [problem('STAGE_TRANSITION_DENIED'), vi_['sas.restore.problem.notWaiting']],
      [problem('TENANT_STATE_INVALID'), vi_['sas.restore.problem.state']],
      [problem('RECOVERY_POINT_UNAVAILABLE', 422), vi_['sas.restore.problem.unavailable']],
    ] as const) {
      const { h } = open(ADMIN, { items: [row(2)] }, () => error);
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.restore.approve.action'] }));
      fireEvent.change(screen.getByLabelText(vi_['sas.restore.decide.reason.label']), { target: { value: 'The incident is confirmed by the owner.' } });
      const reads = h.read.mock.calls.filter(([operation]) => operation === 'listTenantRestoreRequests').length;
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.decide.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(message);
      await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'listTenantRestoreRequests').length).toBeGreaterThan(reads));
      cleanup();
    }
    open(ADMIN, { items: [] }, () => problem('RESTORE_IN_PROGRESS'));
    await fill('2026-11-01T02:00');
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.ask.submit.action'] }));
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['sas.restore.problem.inProgress']);
  });

  it('shows the list to a reader of the registry, with no way to write', async () => {
    open(READER, { items: [row(2), completed(1)] });
    await screen.findByRole('table');
    expect(screen.queryByRole('form', { name: vi_['sas.restore.ask.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['sas.restore.approve.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['sas.restore.reject.action'] })).toBeNull();
    expect(screen.getByRole('button', { name: vi_['sas.restore.report.show.action'] })).toBeTruthy();
  });

  it('shows nothing of the tenants to someone who may not read the registry', () => {
    const { h } = open([], {});
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('keeps what was prepared for a tenant from reaching another: choosing another tenant drops the decision and the notice', async () => {
    const other = '00000000-0000-4000-8000-0000000000a2';
    const h = harness((operation) => {
      if (operation === 'listSystemTenants') return { items: [{ id: TENANT, code: 'minh-ha', name: 'Minh Hà' }, { id: other, code: 'cao-bang', name: 'Cao Bằng' }], next_cursor: null };
      return { tenant_status: 'Active', tenant_version: 1, recovery_window: WINDOW, rpo_target_seconds: 900, rto_target_seconds: 14_400, items: [row(2)], next_cursor: null };
    });
    mount(<RestoreScreen route={ROUTE} />, h, ADMIN, '/sas/sas-21');
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.restore.approve.action'] }));
    expect(screen.getByRole('form', { name: vi_['sas.restore.decide.aria'] })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['sas.restore.tenant.label']), { target: { value: other } });
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.restore.decide.aria'] })).toBeNull());
    expect(h.command).not.toHaveBeenCalled();
  });

  it('pages the list on request', async () => {
    let page = 0;
    const h = harness((operation, input) => {
      if (operation === 'listSystemTenants') return { items: [{ id: TENANT, code: 'minh-ha', name: 'Minh Hà' }], next_cursor: null };
      if (operation === 'getMyFeatureFlags') return { items: [{ flag_key: 'sas.tenant_restore_in_place', enabled: true }] };
      page += 1;
      const first = (input as { query?: { cursor?: string } }).query?.cursor === undefined;
      return { tenant_status: 'Active', tenant_version: 1, recovery_window: WINDOW, rpo_target_seconds: 900, rto_target_seconds: 14_400, items: [first ? row(1) : row(2)], next_cursor: first ? 'next' : null };
    });
    mount(<RestoreScreen route={ROUTE} />, h, ADMIN, '/sas/sas-21');
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.restore.list.more.action'] }));
    await waitFor(() => expect(document.querySelector('[data-restore-id="restore-2"]')).not.toBeNull());
    expect(document.querySelector('[data-restore-id="restore-1"]')).not.toBeNull();
    expect(page).toBe(2);
  });

  it('shows a failed restore with the class of its failure in words, and a restore that waits for the worker as it is', async () => {
    open(ADMIN, { items: [row(1, { status: 'Failed', error_code: 'Stalled', approved_by: OTHER_ADMIN, decided_by: OTHER_ADMIN, decided_at: '2026-11-03T01:30:00Z', completed_at: '2026-11-03T08:00:00Z' }), row(2, { status: 'Restoring', approved_by: OTHER_ADMIN, decided_by: OTHER_ADMIN, decided_at: '2026-11-03T01:30:00Z', started_at: '2026-11-03T01:31:00Z' })] });
    const table = await screen.findByRole('table');
    expect(table.querySelector('[data-restore-id="restore-1"] [data-failure]')?.textContent).toContain(vi_['sas.restore.failure.stalled']);
    expect(within(table.querySelector('[data-restore-id="restore-2"]') as HTMLElement).getByText(vi_['sas.restore.status.restoring'])).toBeTruthy();
  });
});

describe('the seven states of SAS-21 (AC-ST-SAS-019-3, UI-SAS-21)', () => {
  const failing = (error: Error) => open(ADMIN, { items: error });

  it('AC-ST-SAS-019-3 UI-SAS-21: shows a loading state first, then the denied, signed-out, offline and error states, and the empty list in words', async () => {
    failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(screen.getByRole('combobox', { name: vi_['sas.restore.tenant.label'] })).toBeTruthy();
  });

  it('AC-ST-SAS-019-3 UI-SAS-21: waits with a status while the list is read, and says in words that the tenant has no restore', async () => {
    open(ADMIN, { items: [] });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(await screen.findByText(vi_['sas.restore.list.none'])).toBeTruthy();
  });
});

describe('the model of SAS-21', () => {
  it('reads a restore, a report and a page, and takes what is not one for nothing', () => {
    expect(toRestore(null)).toBeUndefined();
    expect(toRestore({ nope: 1 })).toBeUndefined();
    expect(toRestore(completed(1))).toMatchObject({ id: 'restore-1', status: 'Completed', target: 'SANDBOX', sandboxRef: 'mock-sandbox/restore-1', version: 5, report: { matched: true, tablesCount: 2, rowsRestored: 13, rtoSeconds: 372 } });
    expect(toRestore({ id: 'x', status: 'Whatever', target: 'IN_PLACE' })).toMatchObject({ status: 'Requested', target: 'IN_PLACE', approvedBy: undefined, report: undefined, version: 1 });
    expect(toReport({ matched: 'yes' })).toBeUndefined();
    expect(toReport({ matched: false })).toMatchObject({ tables: [], mismatches: [], foreignRows: 0, withinTargets: false });
    expect(toReport({ matched: true, tables: [{ table: 't', money: [{ column: 'c' }, 7, { column: 'd', match: true }] }, 7], mismatches: ['a', 4] })).toMatchObject({ tables: [{ table: 't', rowsMatch: false, money: [{ column: 'c', match: false, expected: '' }, { column: 'd', match: true }] }], mismatches: ['a'] });
    expect(toRestorePage({ tenant_status: 'Odd' })).toBeUndefined();
    expect(toRestorePage('x')).toBeUndefined();
    expect(toRestorePage({ tenant_status: 'Suspended', recovery_window: { earliest: 'a', latest: 'b' }, items: [row(1), { nope: true }], next_cursor: 'c', rpo_target_seconds: 900, rto_target_seconds: 14_400 })).toMatchObject({ tenantStatus: 'Suspended', window: { earliest: 'a', latest: 'b' }, nextCursor: 'c', rpoTargetSeconds: 900 });
    expect(toRestorePage({ tenant_status: 'Active', recovery_window: null, items: 'no' })).toMatchObject({ window: undefined, items: [] });
    expect(toRestorePage({ tenant_status: 'Active', recovery_window: { earliest: 1, latest: 2 } })?.window).toBeUndefined();
  });

  it('knows what each state allows', () => {
    expect([canAskInPlace('Suspended'), canAskInPlace('Active'), canAskInPlace('Offboarding')]).toEqual([true, false, false]);
    expect(['Active', 'Suspended', 'Offboarding', 'Archived', 'Failed', 'Requested', 'Provisioning'].map((status) => canAskRestore(status as never))).toEqual([true, true, true, false, false, false, false]);
    expect(['Requested', 'Approved', 'Restoring', 'Verifying', 'Completed', 'Failed', 'Rejected'].map((status) => isRunning({ status: status as never }))).toEqual([false, true, true, true, false, false, false]);
    const waiting = { status: 'Requested' as const, requestedBy: OTHER_ADMIN };
    expect([canDecide(waiting, MINE, true), canDecide(waiting, OTHER_ADMIN.toUpperCase(), true), canDecide(waiting, MINE, false), canDecide(waiting, undefined, true), canDecide({ ...waiting, status: 'Approved' }, MINE, true)]).toEqual([true, false, false, false, false]);
  });

  it('judges the form the way the contract does', () => {
    expect([isReasonValid('short'), isReasonValid('   short   '), isReasonValid(reason), isReasonValid('x'.repeat(2001))]).toEqual([false, false, true, false]);
    expect([toInstant('2026-11-01T02:00'), toInstant('2026-11-01T02:00:30'), toInstant('2026-11-01'), toInstant('2026-13-01T02:00'), toInstant('')]).toEqual(['2026-11-01T02:00:00.000Z', '2026-11-01T02:00:30.000Z', undefined, undefined, undefined]);
    expect(toLocalField('2026-11-01T02:00:00.000Z')).toBe('2026-11-01T02:00');
    expect([isInsideWindow(WINDOW.earliest, WINDOW), isInsideWindow(WINDOW.latest, WINDOW), isInsideWindow('2026-09-29T02:59:59Z', WINDOW), isInsideWindow('2026-11-03T03:00:01Z', WINDOW), isInsideWindow(WINDOW.latest, undefined)]).toEqual([true, true, false, false, false]);
    expect([clock(0), clock(59), clock(3723), clock(14_400), clock(-5), clock(1.9)]).toEqual(['0:00:00', '0:00:59', '1:02:03', '4:00:00', '0:00:00', '0:00:01']);
  });

  it('reads the differences of a report and puts them in words, keeping what it does not know', () => {
    expect(['rows:note', 'checksum:note', 'money:note.amount_vnd', 'missing_table:note', 'unexpected_table:note', 'foreign_rows', 'something else'].map(toMismatch)).toEqual([
      { kind: 'rows', subject: 'note' },
      { kind: 'checksum', subject: 'note' },
      { kind: 'money', subject: 'note.amount_vnd' },
      { kind: 'missing_table', subject: 'note' },
      { kind: 'unexpected_table', subject: 'note' },
      { kind: 'foreign_rows', subject: '' },
      { kind: 'other', subject: 'something else' },
    ]);
    expect(toMismatch('weird:thing')).toEqual({ kind: 'other', subject: 'weird:thing' });
    const t = ((key: string, params?: Record<string, unknown>) => `${key}|${JSON.stringify(params ?? {})}`) as never;
    expect(mismatchLabel(t, 'weird:thing')).toBe('weird:thing');
    expect(failureLabel(t, 'TENANT_STATE_INVALID')).toContain('sas.restore.failure.state');
    expect(failureLabel(t, 'RestoreEngineUnbound')).toContain('sas.restore.failure.unbound');
    expect(failureLabel(t, 'Boom')).toBe('sas.restore.failure.other|{"code":"Boom"}');
  });

  it('has a word and a tone for every status, target, tenant state and problem, each from its own key', () => {
    const t = ((key: string) => key) as never;
    const statuses = ['Requested', 'Approved', 'Restoring', 'Verifying', 'Completed', 'Failed', 'Rejected'] as const;
    expect(statuses.map((status) => statusLabel(t, status))).toEqual(statuses.map((status) => `sas.restore.status.${status.toLowerCase()}`));
    expect(statuses.map(statusTone)).toEqual(['warn', 'warn', 'warn', 'warn', 'ok', 'red', 'gray']);
    expect([targetLabel(t, 'SANDBOX'), targetLabel(t, 'IN_PLACE')]).toEqual(['sas.restore.target.sandbox', 'sas.restore.target.inPlace']);
    const tenants = ['Requested', 'Provisioning', 'Active', 'Failed', 'Suspended', 'Offboarding', 'Archived'] as const;
    expect(tenants.map((status) => tenantStatusLabel(t, status))).toEqual(tenants.map((status) => `sas.restore.tenant.${status.toLowerCase()}`));
    const reasons = ['selfApproval', 'conflict', 'state', 'notWaiting', 'unavailable', 'inProgress', 'invalid', 'denied', 'notFound', 'session', 'general'] as const;
    expect(new Set(reasons.map((reason) => problemMessage(t, { reason, field: undefined }))).size).toBe(reasons.length);
    const translate = ((key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key}|${JSON.stringify(params)}`)) as never;
    expect(problemMessage(translate, { reason: 'invalid', field: 'reason' })).toBe('sas.restore.problem.invalidAt|{"field":"reason"}');
    expect(['rows:a', 'checksum:a', 'money:a.b', 'missing_table:a', 'unexpected_table:a', 'foreign_rows'].map((code) => mismatchLabel(t, code))).toEqual(['sas.restore.mismatch.rows', 'sas.restore.mismatch.checksum', 'sas.restore.mismatch.money', 'sas.restore.mismatch.missingTable', 'sas.restore.mismatch.unexpectedTable', 'sas.restore.mismatch.foreignRows']);
    expect(['VERIFICATION_MISMATCH', 'TENANT_STATE_INVALID', 'Stalled', 'RestoreEngineUnbound'].map((code) => failureLabel(t, code))).toEqual(['sas.restore.failure.mismatch', 'sas.restore.failure.state', 'sas.restore.failure.stalled', 'sas.restore.failure.unbound']);
  });

  it('names the problem by the code the server answered', () => {
    expect(describeProblem(problem('SELF_APPROVAL_DENIED', 403)).reason).toBe('selfApproval');
    expect(describeProblem(problem('VERSION_CONFLICT')).reason).toBe('conflict');
    expect(describeProblem(problem('TENANT_STATE_INVALID')).reason).toBe('state');
    expect(describeProblem(problem('STAGE_TRANSITION_DENIED')).reason).toBe('notWaiting');
    expect(describeProblem(problem('RECOVERY_POINT_UNAVAILABLE', 422)).reason).toBe('unavailable');
    expect(describeProblem(problem('RESTORE_IN_PROGRESS')).reason).toBe('inProgress');
    expect(describeProblem(problem('VALIDATION_FAILED', 422, 'reason'))).toEqual({ reason: 'invalid', field: 'reason' });
    expect(describeProblem(problem('SCOPE_DENIED', 403)).reason).toBe('denied');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', 404)).reason).toBe('notFound');
    expect(describeProblem(problem('SESSION_EXPIRED', 401)).reason).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE', 500)).reason).toBe('general');
    expect(describeProblem(new Error('x')).reason).toBe('general');
  });

  it('says a rejected field by its name when the server named it', async () => {
    open(ADMIN, { items: [] }, () => problem('VALIDATION_FAILED', 422, 'reason'));
    await fill('2026-11-01T02:00');
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.restore.ask.submit.action'] }));
    expect((await screen.findByRole('alert')).textContent).toContain('trường reason');
  });
});
