import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@machvon/api-client';
import { harness, mount, routeOf as baseRoute } from '../../sas/test-support';
import BuildScreen from './BuildScreen';
import DetailScreen from './DetailScreen';

const routeOf = (id: string, req: string) => ({ ...baseRoute(id, req), module: 'DIS', path: `/dis/${id.toLowerCase()}` });
const PERIOD = '00000000-0000-4000-8000-0000000000b1';
const SNAP = '00000000-0000-4000-8000-0000000000a1';
const BUILDER = ['funding.snapshot.build', 'funding.snapshot.read'];
const FREEZER = ['funding.snapshot.freeze', 'funding.snapshot.read'];

afterEach(cleanup);

const period = { id: PERIOD, code: 'ENT-2026-03', calendar_code: 'ENTERPRISE', period_type: 'MONTH', fiscal_year: 2026, start_date: '2026-03-01', end_date: '2026-03-31', deadline_at: '2026-04-03T00:00:00Z', calendar_version: 1, status: 'LOCKED', version: 3 };
const readiness = (over: Record<string, unknown> = {}) => ({
  period: { id: PERIOD, code: 'ENT-2026-03', status: 'LOCKED', grain: 'MONTH', plan_year: 2026, ordinal: 3 },
  pack: { code: 'ENTERPRISE', version: 0, unverified: true },
  complete: false,
  planned_cells: 2,
  projects: 2,
  missing_units: [{ unit_id: 'u2', unit_code: 'U2', projects: [{ project_id: 'p2', project_code: 'ENT-B', cells: [{ class_code: 'EQUITY', tier_code: 'ALL', measure: 'DISBURSED', months: [2, 3] }] }] }],
  waiting_batches: [],
  frozen: null,
  rebuild_allowed: true,
  actions: { build: true },
  ...over,
});

describe('DIS-32: build the enterprise period snapshot', () => {
  const open = (ready: Record<string, unknown>) => {
    const h = harness((operation) => {
      if (operation === 'get_resources_reporting_period') return [];
      if (operation === 'getEnterpriseSnapshotReadiness') return ready;
      if (operation === 'listEnterpriseSnapshots') return { items: [], next_cursor: null };
      return {};
    });
    (h.client.readAll as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue([period]);
    mount(<BuildScreen route={routeOf('DIS-32', 'DL.03')} />, h, BUILDER, `/dis/dis-32?period=${PERIOD}`);
    return h;
  };

  it('lists the units, projects, cells and months that are missing, and does not offer to build while incomplete', async () => {
    open(readiness());
    const missing = await screen.findByTestId('missing-units');
    expect(missing.textContent).toContain('U2');
    expect(missing.textContent).toContain('ENT-B');
    expect(missing.textContent).toContain('2, 3');
    expect((screen.getByRole('button', { name: 'Dựng bản chốt' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('builds after a confirmation when the period is complete', async () => {
    const h = open(readiness({ complete: true, missing_units: [] }));
    const button = (await screen.findByRole('button', { name: 'Dựng bản chốt' })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    const confirmButtons = await screen.findAllByRole('button', { name: 'Dựng bản chốt' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('buildEnterpriseSnapshot', expect.objectContaining({ body: { period_id: PERIOD } })));
  });

  it('says a frozen period needs a reopening before it is rebuilt, and shows the hash', async () => {
    open(readiness({ complete: true, missing_units: [], frozen: { id: SNAP, revision: 1, payload_sha256: 'a'.repeat(64) }, rebuild_allowed: false }));
    expect(await screen.findByTestId('rebuild-needs-reopen')).toBeTruthy();
    expect(screen.getByTestId('frozen').textContent).toContain('a'.repeat(64));
  });

  it('shows a refusal of the build with the units it names', async () => {
    const h = harness(
      (operation) => (operation === 'getEnterpriseSnapshotReadiness' ? readiness({ complete: true, missing_units: [] }) : operation === 'listEnterpriseSnapshots' ? { items: [], next_cursor: null } : []),
      () => new ApiError({ status: 422, code: 'ENTERPRISE_SNAPSHOT_INCOMPLETE', correlationId: 'c-1', extensions: { missing_units: readiness().missing_units } }),
    );
    (h.client.readAll as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue([period]);
    mount(<BuildScreen route={routeOf('DIS-32', 'DL.03')} />, h, BUILDER, `/dis/dis-32?period=${PERIOD}`);
    const button = (await screen.findByRole('button', { name: 'Dựng bản chốt' })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    const buttons = await screen.findAllByRole('button', { name: 'Dựng bản chốt' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect((await screen.findAllByText(/còn đơn vị chưa nộp số thực/)).length).toBeGreaterThan(0);
  });
});

const detail = (over: Record<string, unknown> = {}, snapshot: Record<string, unknown> = {}) => ({
  snapshot: { id: SNAP, period_id: PERIOD, period_code: 'ENT-2026-03', status: 'BUILDING', revision: 1, version: 1, payload_sha256: null, taxonomy_pack: 'ENTERPRISE', definition_status: 'PROPOSED_PENDING_SIGNOFF', row_count: 10, figure_count: 9, indicator_count: 1, ...snapshot },
  period: { grain: 'MONTH', plan_year: 2026, ordinal: 3, start: '2026-03-01', end: '2026-03-31', code: 'ENT-2026-03' },
  pack: { code: 'ENTERPRISE', label: 'Doanh nghiệp', version: 0, measures: ['EXECUTED', 'DISBURSED'], classes: [] },
  measure: 'DISBURSED',
  partial: false,
  totals: {
    money: [
      { code: 'PLAN_IN_FORCE', class_code: null, value_vnd: '4000' },
      { code: 'CUMULATIVE_YTD', class_code: null, value_vnd: '1000' },
    ],
    by_class: [],
    rates: [{ code: 'RATE_YEAR_IN_FORCE', class_code: null, numerator_vnd: '1000', denominator_vnd: '4000', rate_pct: '25.0000', null_reason: null }],
    total_investment_vnd: null,
    rate_since_start: { ratePct: null, nullReason: 'ZERO_DENOMINATOR' },
  },
  by_unit: [],
  projects: [],
  indicators: [],
  lineage: [],
  hash_verified: null,
  actions: { build: false, freeze: true },
  as_of: '2026-04-05',
  ...over,
});

describe('DIS-33: one enterprise period snapshot', () => {
  const open = (body: Record<string, unknown>, permissions = FREEZER) => {
    const h = harness((operation) => (operation === 'getEnterpriseSnapshot' ? body : {}));
    mount(<DetailScreen route={routeOf('DIS-33', 'BC.01')} />, h, permissions, `/dis/dis-33?snapshot=${SNAP}`);
    return h;
  };

  it('shows the totals with the year rate over its plan, a dash for what nobody has, and freezes after a confirmation with the version it saw', async () => {
    const h = open(detail());
    expect((await screen.findByTestId('total-plan')).textContent).toBe('4.000');
    expect(screen.getByTestId('total-ytd').textContent).toBe('1.000');
    expect(screen.getByTestId('hash').textContent).toBe('–');
    fireEvent.click(screen.getByRole('button', { name: 'Chốt bản này' }));
    const buttons = await screen.findAllByRole('button', { name: 'Chốt bản này' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('freezeEnterpriseSnapshot', expect.objectContaining({ path: { id: SNAP }, ifMatchVersion: 1 })));
  });

  it('offers no freeze to the person who built it and says so', async () => {
    open(detail({ actions: { build: true, freeze: false } }), BUILDER);
    expect(await screen.findByTestId('cannot-freeze')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Chốt bản này' })).toBeNull();
  });

  it('shows a frozen snapshot with its verified hash and no freeze action', async () => {
    open(detail({ hash_verified: true, actions: { build: false, freeze: false } }, { status: 'FROZEN', payload_sha256: 'b'.repeat(64) }));
    expect((await screen.findByTestId('hash')).textContent).toBe('b'.repeat(64));
    expect(screen.getByTestId('hash-check').textContent).toContain('Khớp');
    expect(screen.queryByRole('button', { name: 'Chốt bản này' })).toBeNull();
  });

  it('says when the reader sees only part of the projects', async () => {
    open(detail({ partial: true }));
    expect(await screen.findByTestId('partial')).toBeTruthy();
  });
});
