import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PromotionScreen from './PromotionScreen';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-23', 'FR-SAS-23');
const ADMIN = ['system.tenant.read', 'system.tenant.manage'];
const READER = ['system.tenant.read'];
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const SILO = '00000000-0000-4000-8000-0000000000b2';
const POOL = '00000000-0000-4000-8000-0000000000b1';
/** The membership of the person signed in (see test-support). */
const ME = '00000000-0000-4000-8000-0000000000e9';
const OTHER = '00000000-0000-4000-8000-0000000000e1';
const reason = 'The comparison agrees and the window is agreed with the customer.';
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'corr-7', extensions, ...(detail === undefined ? {} : { detail }) });

const migrationRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'migration-1',
  tenant_id: TENANT,
  from_placement_id: POOL,
  to_placement_id: SILO,
  status: 'AwaitingCutover',
  write_freeze_max_minutes: 30,
  planned_window_start: '2026-11-03T03:00:00Z',
  reason: 'The tenant asked for a database of its own.',
  requested_by: OTHER,
  cutover_approved_by: null,
  cutover_approved_at: null,
  approval_reason: null,
  write_freeze_started_at: null,
  write_frozen_until: null,
  checksum_match: true,
  verified_at: '2026-11-03T03:05:00Z',
  verification_report_ref: 'sha256:abc',
  switched_at: null,
  observation_ends_at: null,
  completed_at: null,
  ended_at: null,
  ended_by: null,
  end_reason: null,
  last_error_code: null,
  target_discarded_at: null,
  source_purge_due_at: null,
  source_purged_at: null,
  created_at: '2026-11-03T02:55:00Z',
  version: 4,
  ...overrides,
});

const table = (name: string, rows: number, amount: string | null, overrides: Record<string, unknown> = {}) => ({
  table: name,
  source_rows: rows,
  target_rows: rows,
  rows_match: true,
  source_checksum: '77',
  target_checksum: '77',
  checksum_match: true,
  money: amount === null ? [] : [{ column: 'amount_vnd', source: amount, target: amount, match: true }],
  money_match: true,
  match: true,
  ...overrides,
});

const reconciliation = (tables: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) => ({
  match: tables.every((entry) => entry.match === true),
  measured_at: '2026-11-03T03:05:00Z',
  source_rows: 12,
  target_rows: 12,
  mismatched_tables: tables.filter((entry) => entry.match !== true).map((entry) => entry.table),
  unreadable_tables: ['tenant_theme_draft'],
  tables,
  ...overrides,
});

const GOOD = [table('allocation_line', 2, '300000000000000000000'), table('contract_revision', 10, '12'), table('organization_unit', 0, null)];
const SILOS = [{ id: SILO, kind: 'SILO', region: 'vn-north', status: 'Active', max_tenants: 1, tenant_count: 0, incoming_migrations: 0, available: true }, { id: POOL, kind: 'POOL', region: 'vn-north', status: 'Active', max_tenants: null, tenant_count: 40, incoming_migrations: 0, available: false }];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface World {
  migrations?: Array<Record<string, unknown>> | Error;
  detail?: { migration: Record<string, unknown>; reconciliation: Record<string, unknown> | null } | Error;
  placements?: Array<Record<string, unknown>> | Error;
}

function open(permissions: readonly string[], world: World = {}, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const migrations = world.migrations ?? [migrationRow()];
  const detail = world.detail ?? { migration: Array.isArray(migrations) ? (migrations[0] ?? migrationRow()) : migrationRow(), reconciliation: reconciliation(GOOD) };
  const h = harness((operation) => {
    switch (operation) {
      case 'listSystemTenants':
        return { items: [{ id: TENANT, code: 'minh-ha', name: 'Minh Hà' }], next_cursor: null };
      case 'listPlacementMigrations':
        return migrations instanceof Error ? migrations : { items: migrations, next_cursor: null };
      case 'getPlacementMigration':
        return detail;
      case 'listPlacements':
        return world.placements instanceof Error ? world.placements : { items: world.placements ?? SILOS };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  return { h, ...mount(<PromotionScreen route={ROUTE} />, h, permissions, '/sas/sas-23') };
}

const field = (name: string): HTMLElement => document.querySelector(`[data-field="${name}"]`) as HTMLElement;

describe('SAS-23 the promotion of a tenant to a silo (UI-SAS-23)', () => {
  it('AC-ST-SAS-018-3 UI-SAS-23: renders the fields Target placement, Freeze of writes, Result of the comparison, Cutover approved by and Status', async () => {
    open(ADMIN);
    await screen.findByText(vi_['sas.promotion.detail.title']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.promotion.page.title']);
    for (const label of ['target', 'freeze', 'result', 'approver', 'status'] as const) expect(document.querySelector('dl.kv')?.textContent).toContain(vi_[`sas.promotion.field.${label}` as keyof typeof vi_]);
    // The labels come in the order of the mockup.
    const order = [...document.querySelectorAll('[data-migration-detail] dt')].map((node) => node.textContent);
    expect(order.slice(0, 5)).toEqual([vi_['sas.promotion.field.status'], vi_['sas.promotion.field.target'], vi_['sas.promotion.field.freeze'], vi_['sas.promotion.field.result'], vi_['sas.promotion.field.approver']]);
    expect(field('status').textContent).toContain(vi_['sas.promotion.status.awaiting']);
    expect(field('target').textContent).toContain('vn-north');
    expect(field('freeze').textContent).toContain('30');
    expect(field('result').textContent).toContain(vi_['sas.promotion.result.match']);
    expect(field('result').textContent).toContain('sha256:abc');
    expect(field('approver').textContent).toBe('—');
    expect(field('initiator').textContent).toBe(OTHER);
  });

  it('AC-ST-SAS-018-3 UI-SAS-23: renders the counts and the money totals of every table with data, and the totals of all', async () => {
    open(ADMIN);
    await screen.findByText(vi_['sas.promotion.recon.title']);
    const view = within(document.querySelector('[data-tables]') as HTMLElement);
    for (const name of ['table', 'rows', 'checksum', 'money', 'result']) expect(view.getByRole('columnheader', { name: vi_[`sas.promotion.recon.column.${name}` as keyof typeof vi_] })).toBeTruthy();
    const line = document.querySelector('[data-table-name="allocation_line"]') as HTMLElement;
    expect(line.querySelector('[data-rows]')?.textContent).toBe('2 → 2');
    expect(line.querySelector('[data-money-column="amount_vnd"]')?.textContent).toContain('300000000000000000000 → 300000000000000000000');
    expect(within(line.querySelector('[data-result]') as HTMLElement).getByText(vi_['sas.promotion.recon.ok'])).toBeTruthy();
    expect(document.querySelector('[data-table-name="contract_revision"] [data-rows]')?.textContent).toBe('10 → 10');
    // An empty table is not listed until the filter is lifted.
    expect(document.querySelector('[data-table-name="organization_unit"]')).toBeNull();
    fireEvent.click(screen.getByLabelText(vi_['sas.promotion.recon.filter.label']));
    expect(document.querySelector('[data-table-name="organization_unit"] [data-rows]')?.textContent).toBe('0 → 0');
    expect(document.querySelector('[data-total-rows]')?.textContent).toBe('12 → 12');
    expect(document.querySelector('[data-total-column="amount_vnd"]')?.textContent).toContain('300000000000000000012 → 300000000000000000012');
    expect(document.querySelector('[data-unreadable]')?.textContent).toContain('tenant_theme_draft');
  });

  it('AC-ST-SAS-018-3 UI-SAS-23: shows a table that differs in red words, with the sums on both sides, and says how many tables do not agree', async () => {
    const off = table('allocation_line', 2, '300', { target_rows: 2, money: [{ column: 'amount_vnd', source: '300', target: '301', match: false }], money_match: false, match: false });
    open(ADMIN, { detail: { migration: migrationRow({ checksum_match: false }), reconciliation: reconciliation([off, table('contract_revision', 1, '5')]) } });
    await screen.findByText(vi_['sas.promotion.detail.title']);
    expect(field('result').textContent).toContain('1');
    expect(field('result').textContent).toContain('Chưa khớp');
    const row = document.querySelector('[data-table-name="allocation_line"]') as HTMLElement;
    expect(row.getAttribute('data-match')).toBe('false');
    expect(within(row).getByText(vi_['sas.promotion.recon.differs'])).toBeTruthy();
    expect(row.querySelector('[data-money-column="amount_vnd"]')?.textContent).toContain('300 → 301');
    expect(row.querySelector('[data-money-column="amount_vnd"]')?.getAttribute('data-money-match')).toBe('false');
  });

  it('shows the steps of the way, the one it is at, and a note when no comparison was made', async () => {
    open(ADMIN, { detail: { migration: migrationRow({ status: 'Copying', checksum_match: null, verified_at: null, verification_report_ref: null }), reconciliation: null } });
    await screen.findByText(vi_['sas.promotion.detail.title']);
    const steps = [...document.querySelectorAll('[data-step]')].map((node) => [node.getAttribute('data-step'), node.getAttribute('data-state')]);
    expect(steps).toEqual([['Planned', 'done'], ['Copying', 'current'], ['Verifying', 'todo'], ['AwaitingCutover', 'todo'], ['CutoverFrozen', 'todo'], ['Switched', 'todo'], ['Completed', 'todo']]);
    expect(field('result').textContent).toContain(vi_['sas.promotion.result.none']);
    expect(screen.getByText(vi_['sas.promotion.recon.none'])).toBeTruthy();
  });

  it('shows the failure the worker met, by its class only', async () => {
    open(ADMIN, { detail: { migration: migrationRow({ status: 'Copying', last_error_code: 'PLACEMENT_MOVER_UNAVAILABLE' }), reconciliation: null } });
    await screen.findByText(vi_['sas.promotion.detail.title']);
    expect(document.querySelector('[data-last-error]')?.textContent).toContain('PLACEMENT_MOVER_UNAVAILABLE');
  });

  it('counts the freeze down from the instant until which writes are refused, and draws it again as time passes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: new Date('2026-11-03T03:10:00Z') });
    open(ADMIN, { detail: { migration: migrationRow({ status: 'CutoverFrozen', cutover_approved_by: ME, write_freeze_started_at: '2026-11-03T03:10:00Z', write_frozen_until: '2026-11-03T03:40:00Z' }), reconciliation: reconciliation(GOOD) } });
    // `vi.waitFor` would move the faked clock at each poll and stops after one second whatever the machine does; the timer is awaited without touching the clock.
    await screen.findByRole('timer', undefined, { timeout: 15_000 });
    const seconds = (): number => {
      const [minutes, rest] = (document.querySelector('[data-countdown]')?.textContent?.match(/(\d\d):(\d\d)/)?.slice(1) ?? ['99', '99']).map(Number);
      return (minutes as number) * 60 + (rest as number);
    };
    const before = seconds();
    // The clock is fixed at the instant the freeze started, so thirty minutes are left to the second.
    expect(before).toBe(30 * 60);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(seconds()).toBe(before - 5);
    // The words say writes are frozen, and an abort is offered with what it does.
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.abort.action'] }));
    expect(screen.getByText(vi_['sas.promotion.abort.rule.frozen'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['sas.promotion.approve.action'] })).toBeNull();
  });

  describe('approving the cutover', () => {
    it('sends the words on the version it saw, and says the cutover was approved', async () => {
      const { h } = open(ADMIN, {}, () => ({ status: 'CUTOVER_FROZEN' }));
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.approve.action'] }));
      expect(screen.getByText(/đóng băng tối đa 30 phút/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.approve.confirm.action'] }));
      expect(await screen.findByText(vi_['sas.promotion.act.reason.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.act.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.approve.confirm.action'] }));
      expect(await screen.findByText(vi_['sas.promotion.done.approved'])).toBeTruthy();
      const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
      expect(operation).toBe('approvePlacementCutover');
      expect(input.path).toEqual({ migrationId: 'migration-1' });
      expect(input.body).toEqual({ reason });
      expect(input.ifMatchVersion).toBe(4);
    });

    it('AC-ST-SAS-018-1 UAT-AC150: says why a copy that differs is refused, naming the tables and the reference, outside the form, and keeps the words typed', async () => {
      open(ADMIN, {}, () => problem('MIGRATION_VERIFICATION_FAILED', 422, { reason: 'MISMATCH', tables: ['allocation_line', 'contract_revision'] }));
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.approve.action'] }));
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.act.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.approve.confirm.action'] }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('allocation_line, contract_revision');
      expect(alert.textContent).toContain('corr-7');
      expect(alert.closest('form')).toBeNull();
      expect((screen.getByLabelText(vi_['sas.promotion.act.reason.label']) as HTMLTextAreaElement).value).toBe(reason);
    });

    it('AC-ST-SAS-018-1 UAT-AC150: says the one who started cannot approve (403 SELF_APPROVAL_DENIED), and tells the one who started so before they try', async () => {
      open(ADMIN, { migrations: [migrationRow({ requested_by: ME })] }, () => problem('SELF_APPROVAL_DENIED', 403));
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.approve.action'] }));
      expect(screen.getByText(vi_['sas.promotion.approve.self'])).toBeTruthy();
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.act.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.approve.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(vi_['sas.promotion.problem.selfApproval']);
    });

    it('says the other refusals in words: no comparison, an old one, a version that moved, a migration that is not waiting', async () => {
      for (const [error, message] of [
        [problem('MIGRATION_VERIFICATION_FAILED', 422, { reason: 'NOT_VERIFIED', tables: [] }), vi_['sas.promotion.problem.notVerified']],
        [problem('MIGRATION_VERIFICATION_FAILED', 422, { reason: 'STALE', tables: [] }), vi_['sas.promotion.problem.stale']],
        [problem('VERSION_CONFLICT'), vi_['sas.promotion.problem.conflict']],
        [problem('MIGRATION_STATE_INVALID'), vi_['sas.promotion.problem.stateInvalid']],
        [problem('TENANT_STATE_INVALID'), vi_['sas.promotion.problem.tenantState']],
      ] as const) {
        open(ADMIN, {}, () => error);
        fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.approve.action'] }));
        fireEvent.change(screen.getByLabelText(vi_['sas.promotion.act.reason.label']), { target: { value: reason } });
        fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.approve.confirm.action'] }));
        expect((await screen.findByRole('alert')).textContent).toContain(message);
        cleanup();
      }
    });

    it('reads everything again after a refusal, because the version may have moved', async () => {
      const { h } = open(ADMIN, {}, () => problem('VERSION_CONFLICT'));
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.approve.action'] }));
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.act.reason.label']), { target: { value: reason } });
      const reads = h.read.mock.calls.filter(([operation]) => operation === 'getPlacementMigration').length;
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.approve.confirm.action'] }));
      await screen.findByRole('alert');
      await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getPlacementMigration').length).toBeGreaterThan(reads));
    });

    it('offers no approval for a migration that does not wait for it', async () => {
      open(ADMIN, { migrations: [migrationRow({ status: 'Verifying' })] });
      await screen.findByText(vi_['sas.promotion.detail.title']);
      expect(screen.queryByRole('button', { name: vi_['sas.promotion.approve.action'] })).toBeNull();
      expect(screen.getByRole('button', { name: vi_['sas.promotion.abort.action'] })).toBeTruthy();
    });
  });

  describe('aborting', () => {
    it('AC-ST-SAS-018-2 UAT-AC151: aborts a migration after a reason, on the version it saw, and says writes work again and the old routing is kept', async () => {
      const { h } = open(ADMIN, { migrations: [migrationRow({ status: 'CutoverFrozen', cutover_approved_by: ME, write_freeze_started_at: '2026-11-03T03:10:00Z', write_frozen_until: '2999-01-01T00:00:00Z' })] }, () => ({ status: 'ROLLED_BACK' }));
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.abort.action'] }));
      expect(screen.getByText(vi_['sas.promotion.abort.rule.frozen'])).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.abort.confirm.action'] }));
      expect(await screen.findByText(vi_['sas.promotion.act.reason.tooShort'])).toBeTruthy();
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.act.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.abort.confirm.action'] }));
      expect(await screen.findByText(vi_['sas.promotion.done.aborted'])).toBeTruthy();
      const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
      expect(operation).toBe('abortPlacementMigration');
      expect(input.path).toEqual({ migrationId: 'migration-1' });
      expect(input.body).toEqual({ reason });
      expect(input.ifMatchVersion).toBe(4);
    });

    it('says what an abort does at each point: before the cutover, and after the switch', async () => {
      open(ADMIN);
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.abort.action'] }));
      expect(screen.getByText(vi_['sas.promotion.abort.rule.before'])).toBeTruthy();
      cleanup();
      open(ADMIN, { migrations: [migrationRow({ status: 'Switched', switched_at: '2026-11-03T03:20:00Z', observation_ends_at: '2026-11-04T03:20:00Z', cutover_approved_by: ME })] });
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.abort.action'] }));
      expect(screen.getByText(vi_['sas.promotion.abort.rule.switched'])).toBeTruthy();
      expect(field('observation')).not.toBeNull();
    });

    it('says the silo took new data since the switch when the rollback is refused', async () => {
      open(ADMIN, { migrations: [migrationRow({ status: 'Switched', switched_at: '2026-11-03T03:20:00Z', cutover_approved_by: ME })] }, () => problem('MIGRATION_STATE_INVALID', 409, {}, 'TARGET_CHANGED'));
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.abort.action'] }));
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.act.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.abort.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(vi_['sas.promotion.problem.targetChanged']);
    });

    it('offers nothing for a migration that is over, and shows how it ended', async () => {
      open(ADMIN, { migrations: [migrationRow({ status: 'RolledBack', ended_at: '2026-11-03T03:50:00Z', ended_by: null, end_reason: 'FREEZE_EXPIRED' })] });
      await screen.findByText(vi_['sas.promotion.detail.title']);
      expect(screen.queryByRole('button', { name: vi_['sas.promotion.abort.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['sas.promotion.approve.action'] })).toBeNull();
      expect(field('ended').textContent).toContain('FREEZE_EXPIRED');
      expect(field('status').textContent).toContain(vi_['sas.promotion.status.rolledBack']);
    });
  });

  describe('planning a promotion', () => {
    const none = { migrations: [] as Array<Record<string, unknown>>, detail: { migration: migrationRow(), reconciliation: null } };

    it('refuses what the contract refuses, and sends nothing', async () => {
      const { h } = open(ADMIN, none);
      await screen.findByRole('form', { name: vi_['sas.promotion.start.aria'] });
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.start.minutes.label']), { target: { value: '3' } });
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.start.window.label']), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.start.submit.action'] }));
      expect(await screen.findByText(/Nhập số phút nguyên từ 5 đến 240/)).toBeTruthy();
      expect(screen.getByText(vi_['sas.promotion.start.window.invalid'])).toBeTruthy();
      expect(screen.getByText(vi_['sas.promotion.start.reason.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('plans the promotion for a free silo: the silo, the minutes, the window as an instant and the reason', async () => {
      const { h } = open(ADMIN, none, () => ({ status: 'PLANNED' }));
      await screen.findByRole('form', { name: vi_['sas.promotion.start.aria'] });
      const select = (await screen.findByLabelText(vi_['sas.promotion.start.placement.label'])) as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBe(1));
      expect(select.options[0]?.textContent).toContain('vn-north');
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.start.minutes.label']), { target: { value: '45' } });
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.start.window.label']), { target: { value: '2026-11-04T10:30' } });
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.start.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.start.submit.action'] }));
      expect(await screen.findByText(vi_['sas.promotion.done.started'])).toBeTruthy();
      const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: Record<string, unknown> }];
      expect(operation).toBe('startSiloPromotion');
      expect(input.path).toEqual({ tenantId: TENANT });
      expect(input.body).toEqual({ to_placement_id: SILO, write_freeze_max_minutes: 45, planned_window_start: new Date('2026-11-04T10:30').toISOString(), reason });
      expect((screen.getByLabelText(vi_['sas.promotion.start.reason.label']) as HTMLTextAreaElement).value).toBe('');
    });

    it('says in words that there is no free silo, and does not offer the pool', async () => {
      open(ADMIN, { ...none, placements: [SILOS[1] as Record<string, unknown>] });
      expect(await screen.findByText(vi_['sas.promotion.start.placement.none'])).toBeTruthy();
      expect((screen.getByLabelText(vi_['sas.promotion.start.placement.label']) as HTMLSelectElement).options.length).toBe(0);
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.start.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.start.submit.action'] }));
      expect(await screen.findByText(vi_['sas.promotion.start.placement.invalid'])).toBeTruthy();
    });

    it('says why a promotion was refused: another one is open, the silo is not usable', async () => {
      for (const [error, message] of [
        [problem('MIGRATION_ALREADY_OPEN'), vi_['sas.promotion.problem.alreadyOpen']],
        [problem('PLACEMENT_UNAVAILABLE', 422, { reason: 'NO_ROOM' }), vi_['sas.promotion.problem.placement.noRoom']],
        [problem('PLACEMENT_UNAVAILABLE', 422, { reason: 'OTHER_REGION' }), vi_['sas.promotion.problem.placement.otherRegion']],
        [problem('PLACEMENT_UNAVAILABLE', 422, { reason: 'NOT_ACTIVE' }), vi_['sas.promotion.problem.placement.notActive']],
        [problem('PLACEMENT_UNAVAILABLE', 422, { reason: 'NOT_SILO' }), vi_['sas.promotion.problem.placement.notSilo']],
        [problem('PLACEMENT_UNAVAILABLE', 422, { reason: 'SAME_PLACEMENT' }), vi_['sas.promotion.problem.placement.same']],
        [problem('PLACEMENT_UNAVAILABLE', 422, { reason: 'NOT_FOUND' }), vi_['sas.promotion.problem.placement.other']],
        [problem('VALIDATION_FAILED', 422, {}, 'reason'), 'reason'],
      ] as const) {
        open(ADMIN, none, () => error);
        await waitFor(() => expect((screen.getByLabelText(vi_['sas.promotion.start.placement.label']) as HTMLSelectElement).options.length).toBe(1));
        fireEvent.change(screen.getByLabelText(vi_['sas.promotion.start.reason.label']), { target: { value: reason } });
        fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.start.submit.action'] }));
        expect((await screen.findByRole('alert')).textContent).toContain(message);
        // The words typed stay for the next try.
        expect((screen.getByLabelText(vi_['sas.promotion.start.reason.label']) as HTMLTextAreaElement).value).toBe(reason);
        cleanup();
      }
    });

    it('does not offer a second promotion while one is open', async () => {
      open(ADMIN);
      await screen.findByText(vi_['sas.promotion.detail.title']);
      expect(document.querySelector('[data-open-migration]')).not.toBeNull();
      expect(screen.queryByRole('form', { name: vi_['sas.promotion.start.aria'] })).toBeNull();
    });
  });

  describe('what the screen asks of the platform', () => {
    it('asks for nothing about a tenant before one is chosen', async () => {
      const h = harness((operation) => (operation === 'listSystemTenants' ? { items: [], next_cursor: null } : operation === 'listPlacements' ? { items: SILOS } : new Error('no tenant, no read')));
      mount(<PromotionScreen route={ROUTE} />, h, ADMIN, '/sas/sas-23');
      await waitFor(() => expect(h.read.mock.calls.some(([operation]) => operation === 'listPlacements')).toBe(true));
      expect(h.read.mock.calls.some(([operation]) => operation === 'listPlacementMigrations')).toBe(false);
    });

    it('reads the placements again after a promotion is planned, because the silo it took is no longer free', async () => {
      const { h } = open(ADMIN, { migrations: [], detail: { migration: migrationRow(), reconciliation: null } }, () => ({ status: 'PLANNED' }));
      const select = (await screen.findByLabelText(vi_['sas.promotion.start.placement.label'])) as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBe(1));
      const reads = () => h.read.mock.calls.filter(([operation]) => operation === 'listPlacements').length;
      const before = reads();
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.start.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.start.submit.action'] }));
      await screen.findByText(vi_['sas.promotion.done.started']);
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
    });

    const approveOnce = async () => {
      fireEvent.change(await screen.findByLabelText(vi_['sas.promotion.act.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.approve.confirm.action'] }));
      await screen.findByRole('alert');
    };

    it('sends the same request again, with the same idempotency attempt, after an answer that was lost', async () => {
      const { h } = open(ADMIN, {}, () => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }));
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.approve.action'] }));
      await approveOnce();
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.approve.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const [first, second] = h.command.mock.calls.map(([, input]) => (input as { attempt: unknown }).attempt);
      expect(second).toBe(first);
    });

    it('sends a new idempotency attempt after the platform refused the request for good', async () => {
      const { h } = open(ADMIN, {}, () => problem('SELF_APPROVAL_DENIED', 403));
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.approve.action'] }));
      await approveOnce();
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.promotion.approve.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const [first, second] = h.command.mock.calls.map(([, input]) => (input as { attempt: unknown }).attempt);
      expect(second).not.toBe(first);
    });
  });

  describe('who sees what', () => {
    it('shows the registry reader the promotion and the comparison, with no way to write', async () => {
      open(READER);
      await screen.findByText(vi_['sas.promotion.detail.title']);
      expect(screen.queryByRole('form', { name: vi_['sas.promotion.start.aria'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['sas.promotion.approve.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['sas.promotion.abort.action'] })).toBeNull();
      expect(document.querySelector('[data-tables]')).not.toBeNull();
    });

    it('shows the registry reader no form to plan a promotion either, when the tenant has none', async () => {
      open(READER, { migrations: [], detail: { migration: migrationRow(), reconciliation: null } });
      await screen.findByText(vi_['sas.promotion.list.none']);
      expect(screen.queryByRole('form', { name: vi_['sas.promotion.start.aria'] })).toBeNull();
      expect(screen.queryByText(vi_['sas.promotion.start.title'])).toBeNull();
    });

    it('shows nothing of the tenants to someone who may not read the registry', () => {
      const { h } = open([], {});
      expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
    });

    it('keeps what was prepared for a tenant from reaching another: choosing another tenant drops the confirmation and the notice', async () => {
      const other = '00000000-0000-4000-8000-0000000000a2';
      const h = harness((operation) => {
        if (operation === 'listSystemTenants') return { items: [{ id: TENANT, code: 'minh-ha', name: 'Minh Hà' }, { id: other, code: 'cao-bang', name: 'Cao Bằng' }], next_cursor: null };
        if (operation === 'listPlacements') return { items: SILOS };
        if (operation === 'getPlacementMigration') return { migration: migrationRow(), reconciliation: reconciliation(GOOD) };
        return { items: [migrationRow()], next_cursor: null };
      });
      mount(<PromotionScreen route={ROUTE} />, h, ADMIN, '/sas/sas-23');
      fireEvent.click(await screen.findByRole('button', { name: vi_['sas.promotion.abort.action'] }));
      expect(screen.getByRole('form', { name: vi_['sas.promotion.act.aria'] })).toBeTruthy();
      fireEvent.change(screen.getByLabelText(vi_['sas.promotion.tenant.label']), { target: { value: other } });
      await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.promotion.act.aria'] })).toBeNull());
      expect(h.command).not.toHaveBeenCalled();
    });

    it('opens another promotion of the tenant from the list', async () => {
      const older = migrationRow({ id: 'migration-0', status: 'Aborted', ended_at: '2026-10-01T00:00:00Z', end_reason: 'The customer asked to stop.', created_at: '2026-10-01T00:00:00Z', version: 2 });
      const { h } = open(ADMIN, { migrations: [migrationRow(), older] });
      await screen.findByText(vi_['sas.promotion.detail.title']);
      const row = document.querySelector('[data-migration-id="migration-0"]') as HTMLElement;
      fireEvent.click(within(row).getByRole('button', { name: vi_['sas.promotion.list.open.action'] }));
      await waitFor(() => expect(h.read.mock.calls.some(([operation, input]) => operation === 'getPlacementMigration' && (input as { path: { migrationId: string } }).path.migrationId === 'migration-0')).toBe(true));
    });
  });
});

describe('the seven states of SAS-23 (AC-ST-SAS-018-3, UI-SAS-23)', () => {
  const failing = (error: ApiError) => open(ADMIN, { migrations: error });

  it('AC-ST-SAS-018-3 UI-SAS-23: shows a loading state first, then the denied, signed-out, offline and error states', async () => {
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
  });

  it('AC-ST-SAS-018-3 UI-SAS-23: waits with a status while the list is read, and says in words that the tenant was never promoted', async () => {
    open(ADMIN, { migrations: [] });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(await screen.findByText(vi_['sas.promotion.list.none'])).toBeTruthy();
  });

  it('AC-ST-SAS-018-3 UI-SAS-23: says the detail could not be read, and reads it again on request, without taking the list away', async () => {
    open(ADMIN, { detail: new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) });
    expect(await screen.findByText(vi_['sas.promotion.detail.error'])).toBeTruthy();
    expect(document.querySelector('[data-migrations]')).not.toBeNull();
    expect(screen.getByRole('button', { name: vi_['sas.promotion.detail.retry.action'] })).toBeTruthy();
  });
});
