import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PERIOD, PERIOD_LOCKED, SNAPSHOTTER, SNAPSHOT_READER, client, mount, routeOf, world } from '../report/test-support';
import SnapshotScreen from './SnapshotScreen';

const ROUTE = routeOf('DIS-21', 'FR-DIS-21');
const FROZEN = '00000000-0000-4000-8000-0000000000d1';
const BUILDING = '00000000-0000-4000-8000-0000000000d2';
const LINE = (n: number) => `00000000-0000-4000-8000-00000000e${String(n).padStart(3, '0')}`;
const HASH = 'ab12cd34'.repeat(8);

afterEach(cleanup);

const snapshotRecord = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  period_id: PERIOD_LOCKED,
  snapshot_kind: 'PERIOD_CLOSE',
  as_of_at: '2027-01-12T03:00:00.000Z',
  as_of_date: '2027-01-17',
  treasury_cutoff_date: '2027-01-17',
  status: 'FROZEN',
  metric_set_version: 'DIS-METRICS-R1-PROPOSED',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  row_count: 12,
  payload_sha256: HASH,
  frozen_by: '00000000-0000-4000-8000-000000000001',
  frozen_at: '2027-01-12T03:00:00.000Z',
  supersedes_id: null,
  created_at: '2027-01-12T02:00:00.000Z',
  created_by: '00000000-0000-4000-8000-000000000001',
  version: 2,
  ...over,
});
const buildingRecord = (over: Record<string, unknown> = {}) => snapshotRecord(BUILDING, { status: 'BUILDING', payload_sha256: null, frozen_by: null, frozen_at: null, version: 1, treasury_cutoff_date: '2027-01-18', ...over });
const listOf = (items: Array<Record<string, unknown>>, pending: Array<Record<string, unknown>> = []) => ({ items, next_cursor: null, pending_reports: pending });

const lineRecord = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: LINE(n),
  project_id: '00000000-0000-4000-8000-000000000041',
  project_code: `DA-2027-00${n}`,
  unit_id: '00000000-0000-4000-8000-000000000051',
  fund_source_version_id: null,
  bucket: 'CURRENT_YEAR',
  budget_level: 'CENTRAL',
  plan_pm_assigned_vnd: '500000000',
  plan_local_added_vnd: '300000000',
  plan_total_vnd: '800000000',
  disbursed_treasury_vnd: '250000000',
  disbursed_reported_vnd: '100000000',
  period_delta_vnd: '-20000000',
  registered_month_vnd: null,
  forecast_eac_vnd: null,
  ctmtqg_subset_vnd: null,
  rate_pm_pct: '50.0000',
  rate_total_pct: '31.2500',
  rate_null_reason: null,
  treasury_coverage: 'PARTIAL',
  report_revision_id: null,
  plan_version_id: null,
  ...over,
});

const open = (
  options: { snapshots?: Record<string, unknown>; lines?: Record<string, Record<string, Record<string, unknown>>>; permissions?: readonly string[] | undefined; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {},
) => {
  const h = client(
    world({ snapshots: { [PERIOD_LOCKED]: (options.snapshots ?? listOf([])) as Record<string, unknown> }, snapshotLines: options.lines ?? {} }),
    options.command ?? (() => ({ status: 'BUILDING', resource_version: 1, resource_id: BUILDING })),
  );
  mount(<SnapshotScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : SNAPSHOTTER, path: '/dis/dis-21', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
};
const choosePeriod = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.selectOptions(await screen.findByLabelText(vi_['dis.snapshot.year.label']), '2027');
  await user.selectOptions(screen.getByLabelText(vi_['dis.snapshot.period.label']), PERIOD_LOCKED);
};
const sent = (h: { command: { mock: { calls: unknown[][] } } }, call = 0) => h.command.mock.calls[call] as [string, { body?: Record<string, unknown>; path?: { id: string }; ifMatchVersion?: number }];

describe('DIS-21 close and freeze the figures of a period', () => {
  it('asks for a period first, and sends nothing before one is chosen', async () => {
    const h = open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.snapshot.page.title'] })).toBeTruthy();
    expect((await screen.findByTestId('snapshot-choose')).textContent).toBe(vi_['dis.snapshot.choose.text']);
    expect(screen.queryByTestId('snapshot-build')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-DIS-009-7 / UI-DIS-21: lists the snapshots with status, cutoff and short hash, and says the formulas await the sign-off of D03 until they are signed', async () => {
    const user = userEvent.setup();
    open({ snapshots: listOf([snapshotRecord(FROZEN), buildingRecord({ definition_status: 'SIGNED' })]) });
    await choosePeriod(user);
    const table = await screen.findByTestId('snapshots');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const frozen = rows.find((row) => row.getAttribute('data-snapshot') === FROZEN) as HTMLElement;
    expect(within(frozen).getByText(vi_['dis.snapshot.status.frozen'])).toBeTruthy();
    expect(within(frozen).getByText('2027-01-17')).toBeTruthy();
    expect(within(frozen).getByText('ab12cd34').getAttribute('class')).toBeNull();
    expect(within(frozen).getByText('ab12cd34').closest('td')?.getAttribute('title')).toBe(HASH);
    expect(within(frozen).getByTestId('definition-pending').textContent).toBe(vi_['dis.snapshot.definition.pending']);
    expect(vi_['dis.snapshot.definition.pending']).toBe('CHỜ KÝ D03');
    const building = rows.find((row) => row.getAttribute('data-snapshot') === BUILDING) as HTMLElement;
    expect(within(building).getByTestId('definition-signed').textContent).toBe(vi_['dis.snapshot.definition.signed']);
    // A snapshot that was not frozen has no hash to show.
    expect(within(building).queryByText('ab12cd34')).toBeNull();
  });

  it('says there is nothing built for the period, and shows the reports that were handed in and are not accepted apart', async () => {
    const user = userEvent.setup();
    open({ snapshots: listOf([], [{ report_id: '00000000-0000-4000-8000-0000000000f1', project_id: 'p', project_code: 'DA-2027-007', revision: 2, status: 'SUBMITTED' }]) });
    await choosePeriod(user);
    expect((await screen.findByTestId('snapshot-none')).textContent).toBe(vi_['dis.snapshot.list.empty.text']);
    expect(screen.getByTestId('pending').textContent).toBe('DA-2027-007: bản 2 chờ duyệt');
    expect(screen.getByText(vi_['dis.snapshot.pending.hint'])).toBeTruthy();
  });

  it('builds the figures of the period for a kind and the cutoff, which starts at the last day of the period, and opens the lines of what was built', async () => {
    const user = userEvent.setup();
    const h = open({ lines: { [BUILDING]: { '': { snapshot: buildingRecord(), items: [lineRecord(1)], next_cursor: null } } } });
    await choosePeriod(user);
    const cutoff = (await screen.findByLabelText(vi_['dis.snapshot.cutoff.label'])) as HTMLInputElement;
    expect(cutoff.value).toBe('2027-01-10');
    await user.clear(cutoff);
    await user.click(screen.getByRole('button', { name: vi_['dis.snapshot.build.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getByText(vi_['dis.snapshot.cutoff.required.error'])).toBeTruthy();
    await user.type(cutoff, '2027-01-18');
    await user.selectOptions(screen.getByLabelText(vi_['dis.snapshot.kind.label']), 'ADHOC');
    await user.click(screen.getByRole('button', { name: vi_['dis.snapshot.build.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)).toEqual(['buildPeriodSnapshot', expect.objectContaining({ body: { period_id: PERIOD_LOCKED, snapshot_kind: 'ADHOC', treasury_cutoff_date: '2027-01-18' } })]);
    expect((await screen.findByTestId('lines')).querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('AC-ST-DIS-009-4: freezes only after a confirmation that says what the freeze does, under the version the list showed, and never offers it for what is frozen already', async () => {
    const user = userEvent.setup();
    const h = open({ snapshots: listOf([snapshotRecord(FROZEN), buildingRecord()]), command: () => ({ status: 'FROZEN', resource_version: 2, resource_id: BUILDING }) });
    await choosePeriod(user);
    const table = await screen.findByTestId('snapshots');
    const rowOf = (id: string) => table.querySelector(`tr[data-snapshot="${id}"]`) as HTMLElement;
    expect(within(rowOf(FROZEN)).queryByRole('button', { name: vi_['dis.snapshot.freeze.action'] })).toBeNull();
    await user.click(within(rowOf(BUILDING)).getByRole('button', { name: vi_['dis.snapshot.freeze.action'] }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(vi_['dis.snapshot.freeze.dialog.body'])).toBeTruthy();
    expect(within(dialog).getByTestId('freeze-definition-note').textContent).toBe(vi_['dis.snapshot.freeze.dialog.definition']);
    // Cancelling sends nothing.
    await user.click(within(dialog).getByRole('button', { name: vi_['dis.snapshot.dialog.cancel.action'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
    await user.click(within(rowOf(BUILDING)).getByRole('button', { name: vi_['dis.snapshot.freeze.action'] }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: vi_['dis.snapshot.freeze.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)).toEqual(['freezePeriodSnapshot', expect.objectContaining({ path: { id: BUILDING }, ifMatchVersion: 1 })]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('AC-ST-DIS-009-4: tells in words that the figures are frozen already, that they moved, and that the period is not closed, and keeps the dialog open for the first two', async () => {
    const user = userEvent.setup();
    let failure = new ApiError({ status: 409, code: 'SNAPSHOT_FROZEN', correlationId: 'c' });
    open({ snapshots: listOf([buildingRecord()]), command: () => failure });
    await choosePeriod(user);
    await user.click(await screen.findByRole('button', { name: vi_['dis.snapshot.freeze.action'] }));
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: vi_['dis.snapshot.freeze.confirm.action'] });
    for (const [code, status, key] of [
      ['SNAPSHOT_FROZEN', 409, 'frozen'],
      ['VERSION_CONFLICT', 409, 'versionConflict'],
      ['SNAPSHOT_NOT_BUILT', 409, 'notBuilt'],
    ] as const) {
      failure = new ApiError({ status, code, correlationId: 'c' });
      await user.click(confirm);
      await waitFor(() => expect(screen.getByTestId('freeze-refusal').textContent).toBe(vi_[`dis.snapshot.problem.${key}`]));
    }
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('tells in words why a build was refused: the period is open, someone else is building, the person sees a part of the projects, the cutoff is wrong', async () => {
    const user = userEvent.setup();
    let failure = new ApiError({ status: 409, code: 'PERIOD_STATE_INVALID', correlationId: 'c' });
    open({ command: () => failure });
    await choosePeriod(user);
    const build = await screen.findByRole('button', { name: vi_['dis.snapshot.build.action'] });
    for (const [code, status, key] of [
      ['PERIOD_STATE_INVALID', 409, 'periodOpen'],
      ['SNAPSHOT_BUILD_IN_PROGRESS', 409, 'inProgress'],
      ['SCOPE_DENIED', 403, 'scopeDenied'],
      ['VALIDATION_FAILED', 422, 'validation'],
    ] as const) {
      failure = new ApiError({ status, code, correlationId: 'c' });
      await user.click(build);
      await waitFor(() => expect(screen.getByTestId('build-refusal').textContent).toBe(vi_[`dis.snapshot.problem.${key}`]));
    }
  });

  it('FX-DIS-004: shows both rates side by side for every line, a figure nobody has as a dash with its reason, and the change of the period with its sign', async () => {
    const user = userEvent.setup();
    const none = lineRecord(2, { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', disbursed_treasury_vnd: null, disbursed_reported_vnd: null, period_delta_vnd: null, rate_pm_pct: null, rate_total_pct: null, rate_null_reason: 'TREASURY_COVERAGE_NONE', treasury_coverage: 'NONE' });
    const rise = lineRecord(3, { period_delta_vnd: '50000000', bucket: 'CARRYOVER', rate_pm_pct: null, rate_total_pct: '10.0000', rate_null_reason: 'ZERO_DENOMINATOR' });
    open({ snapshots: listOf([snapshotRecord(FROZEN)]), lines: { [FROZEN]: { '': { snapshot: snapshotRecord(FROZEN), items: [lineRecord(1), none, rise], next_cursor: null } } } });
    await choosePeriod(user);
    await user.click(await screen.findByRole('button', { name: /Xem dòng số liệu/ }));
    const table = await screen.findByTestId('lines');
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const cells = (row: Element) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells(rows[0] as Element)).toEqual(['DA-2027-001', 'Kế hoạch năm · Trung ương', '500.000.000', '300.000.000', '250.000.000', '100.000.000', '-20.000.000', '50.0000%', '31.2500%', 'Một phần']);
    expect(cells(rows[1] as Element)).toEqual(['DA-2027-002', 'Kế hoạch năm · Địa phương', '500.000.000', '300.000.000', '—', '—', '—', '—', '—', 'Chưa có']);
    expect((rows[1] as Element).querySelector('[data-rate="pm"]')?.getAttribute('title')).toBe(vi_['dis.snapshot.reason.noTreasury']);
    expect(cells(rows[2] as Element)[6]).toBe('+50.000.000');
    expect((rows[2] as Element).querySelector('[data-rate="pm"]')?.textContent).toBe('—');
    expect((rows[2] as Element).querySelector('[data-rate="total"]')?.textContent).toBe('10.0000%');
    // The two rates have a header each: never a single rate.
    expect(within(table).getByRole('columnheader', { name: vi_['dis.snapshot.line.ratePm'] })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: vi_['dis.snapshot.line.rateTotal'] })).toBeTruthy();
  });

  it('loads the next page of lines on request and stops offering it at the last page', async () => {
    const user = userEvent.setup();
    open({
      snapshots: listOf([snapshotRecord(FROZEN)]),
      lines: { [FROZEN]: { '': { snapshot: snapshotRecord(FROZEN), items: [lineRecord(1)], next_cursor: 'next' }, next: { snapshot: snapshotRecord(FROZEN), items: [lineRecord(2)], next_cursor: null } } },
    });
    await choosePeriod(user);
    await user.click(await screen.findByRole('button', { name: /Xem dòng số liệu/ }));
    const more = await screen.findByRole('button', { name: vi_['dis.snapshot.lines.more.action'] });
    await user.click(more);
    await waitFor(() => expect(screen.getByTestId('lines').querySelectorAll('tbody tr')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: vi_['dis.snapshot.lines.more.action'] })).toBeNull();
  });

  it('shows the figures to a person who may only read them: no build form to use and no freeze button', async () => {
    const user = userEvent.setup();
    const h = open({ snapshots: listOf([buildingRecord()]), permissions: SNAPSHOT_READER });
    await choosePeriod(user);
    expect((await screen.findByTestId('build-denied')).textContent).toBe(vi_['dis.snapshot.build.denied.note']);
    expect((screen.getByRole('button', { name: vi_['dis.snapshot.build.action'] }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['dis.snapshot.freeze.action'] })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the figures but offers no change in the read-only mode of a session', async () => {
    const user = userEvent.setup();
    open({ snapshots: listOf([buildingRecord()]), mode: 'READ_ONLY' });
    await choosePeriod(user);
    expect(await screen.findByTestId('build-denied')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['dis.snapshot.freeze.action'] })).toBeNull();
  });

  it('leads a locked period to the reopening with a reason, and an open one does not', async () => {
    const user = userEvent.setup();
    open({ snapshots: listOf([snapshotRecord(FROZEN)]) });
    await choosePeriod(user);
    expect((await screen.findByRole('link', { name: vi_['dis.snapshot.reopen.link'] })).getAttribute('href')).toBe('/dis/dis-22');
    await user.selectOptions(screen.getByLabelText(vi_['dis.snapshot.period.label']), PERIOD);
    await waitFor(() => expect(screen.queryByRole('link', { name: vi_['dis.snapshot.reopen.link'] })).toBeNull());
  });
});
