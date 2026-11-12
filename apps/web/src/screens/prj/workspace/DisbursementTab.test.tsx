import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lineRow } from '../../cap/forecast/test-support';
import { payment } from '../../pay/payment/test-support';
import { client, mount, word, world } from '../test-support';
import type { ProjectView } from '../model';
import DisbursementTab from './DisbursementTab';

afterEach(cleanup);

const PROJECT_ID = '00000000-0000-4000-8000-000000000e01';
const OTHER_ID = '00000000-0000-4000-8000-000000000e02';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000f01';
const project = { id: PROJECT_ID, code: 'DA-2026-001', name: 'Dự án số 1' } as unknown as ProjectView;

const money = (code: string, value: string | null, classCode: string | null = null) => ({ code, class_code: classCode, measure: 'DISBURSED', value_vnd: value });
const rate = (pct: string | null, num: string, den: string) => ({ code: 'RATE_YEAR_IN_FORCE', class_code: null, measure: 'DISBURSED', numerator_term: 'CUMULATIVE_YTD', denominator_term: 'PLAN_IN_FORCE', basis: 'OFFICIAL', numerator_vnd: num, denominator_vnd: den, rate_pct: pct, null_reason: null, as_of: '2026-11-10', pack_code: 'ENTERPRISE' });
const cell = (classCode: string, plan: string | null, ytd: string | null) => ({ class_code: classCode, tier_code: 'ALL', plan_in_force_vnd: plan, cumulative_ytd_vnd: ytd, cumulative_since_start_vnd: ytd });

const leader = {
  snapshot_id: SNAPSHOT_ID,
  as_of_date: '2026-11-10',
  revision: 1,
  company: { level: 'COMPANY', projects: 2, plan_vnd: '700000000000', disbursed_vnd: '300000000000', rate_pct: '42.8571' },
  units: [],
  projects: [
    { level: 'PROJECT', id: PROJECT_ID, code: 'DA-2026-001', projects: 1, plan_vnd: '339000000000', disbursed_vnd: '209997000000', rate_pct: '61.9460' },
    { level: 'PROJECT', id: OTHER_ID, code: 'DA-2026-002', projects: 1, plan_vnd: '361000000000', disbursed_vnd: '90003000000', rate_pct: '24.9319' },
  ],
  as_of: '2026-11-10T05:00:00.000Z',
};

const snapshot = {
  snapshot: { id: SNAPSHOT_ID, period_id: 'p', period_code: 'ENT-M2026-10', status: 'FROZEN', revision: 1, version: 2, payload_sha256: null, taxonomy_pack: 'ENTERPRISE', row_count: 1 },
  period: { grain: 'MONTH', plan_year: 2026, ordinal: 10, start: '2026-10-01', end: '2026-10-31', code: 'ENT-M2026-10' },
  pack: { code: 'ENTERPRISE', label: 'Enterprise', version: 1, measures: ['EXECUTED', 'DISBURSED'], classes: [{ code: 'EQUITY', label: 'Vốn chủ sở hữu', additive: true }, { code: 'LOAN', label: 'Vốn vay', additive: true }] },
  measure: 'DISBURSED',
  partial: false,
  totals: { money: [], by_class: [], rates: [], total_investment_vnd: null, rate_since_start: { ratePct: null, nullReason: null } },
  by_unit: [],
  projects: [
    {
      project_id: PROJECT_ID,
      project_code: 'DA-2026-001',
      project_name: 'Dự án số 1',
      unit_id: 'u',
      unit_code: 'U1',
      tmdt_in_force_vnd: null,
      cells: [cell('EQUITY', '170000000000', '76494000000'), cell('LOAN', '169000000000', '133503000000'), cell('OTHER', null, null)],
      money: [money('PLAN_IN_FORCE', '339000000000'), money('CUMULATIVE_YTD', '209997000000'), money('CUMULATIVE_SINCE_START', '209997000000')],
      rates: [rate('61.9460', '209997000000', '339000000000')],
    },
  ],
  indicators: [],
  lineage: [],
  hash_verified: true,
  actions: { build: false, freeze: false },
  as_of: '2026-11-10T05:00:00.000Z',
};

interface Reads {
  leader?: unknown | Error;
  snapshot?: unknown | Error;
  schedules?: unknown[] | Error;
  payments?: unknown[] | Error;
}

function harness(reads: Reads) {
  const h = client(world());
  h.read.mockImplementation((operation: string) => {
    if (operation === 'getLeaderRates') return reads.leader instanceof Error ? Promise.reject(reads.leader) : Promise.resolve(reads.leader);
    if (operation === 'getEnterpriseSnapshot') return reads.snapshot instanceof Error ? Promise.reject(reads.snapshot) : Promise.resolve(reads.snapshot);
    return Promise.reject(new Error(`unexpected read ${operation}`));
  });
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    const value = operation === 'listDisbursementSchedules' ? reads.schedules : operation === 'get_resources_payment_request' ? reads.payments : new Error(`unexpected readAll ${operation}`);
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []);
  });
  return h;
}

describe('DisbursementTab (PRJ-03, tab Disbursement): plan against disbursed, monthly estimates and payments of one project', () => {
  it('shows the figures of the project from the snapshot the leader read names, by source, with the same headline as HOME-09', async () => {
    const h = harness({ leader, snapshot });
    mount(<DisbursementTab project={project} />, h, { permissions: undefined });
    const figures = await screen.findByTestId('dis-figures');
    await waitFor(() => expect(within(figures).getByText('Vốn vay')).toBeTruthy());
    expect(within(figures).getByText('Tổng các nguồn')).toBeTruthy();
    expect(within(figures).getByText('Vốn chủ sở hữu')).toBeTruthy();
    // The class of no figure is not drawn; the figures of the other project are not shown.
    expect(within(figures).queryByText('OTHER')).toBeNull();
    expect(within(figures).getAllByText('133.503.000.000').length).toBeGreaterThan(0);
    expect(within(figures).getAllByText(/61,95%/).length).toBeGreaterThan(0);
    expect(within(figures).queryByText(/24,93%/)).toBeNull();
    // The detail is asked for the measure of the leader read, not for the default of DIS-33.
    const detail = h.read.mock.calls.find(([operation]) => operation === 'getEnterpriseSnapshot');
    expect(detail?.[1]).toMatchObject({ path: { id: SNAPSHOT_ID }, query: { measure: 'DISBURSED' } });
    expect(screen.getByTestId('dis-figures-link').getAttribute('href')).toBe(`/dis/dis-33?snapshot=${SNAPSHOT_ID}`);
  });

  it('shows the months with a figure and only the payments of the project', async () => {
    const h = harness({
      leader,
      snapshot,
      schedules: [lineRow(11, 'FORECAST', 'CURRENT_YEAR', '50850000000'), lineRow(12, 'REGISTERED', 'CURRENT_YEAR', '3200000000')],
      payments: [payment(1, { project_id: PROJECT_ID, status: 'SENT_TREASURY' }), payment(2, { project_id: OTHER_ID, request_no: 'DNTT-OTHER' })],
    });
    mount(<DisbursementTab project={project} />, h, { permissions: undefined });
    const months = await screen.findByTestId('dis-months');
    await waitFor(() => expect(within(months).getByText('Tháng 11')).toBeTruthy());
    expect(within(months).getByText('Tháng 12')).toBeTruthy();
    const payments = await screen.findByTestId('dis-payments');
    await waitFor(() => expect(within(payments).getByText('DNTT-001')).toBeTruthy());
    expect(within(payments).queryByText('DNTT-OTHER')).toBeNull();
    // Enterprise wording: the status is not the one with the Treasury in it.
    expect(within(payments).getByText(word('prj.wsTab.dis.status.sent'))).toBeTruthy();
  });

  it('says in words that nothing is frozen, nothing is registered and nothing is paid, with the links to the detailed screens kept', async () => {
    mount(<DisbursementTab project={project} />, harness({ leader: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) }), { permissions: undefined });
    expect(await screen.findByText(word('prj.wsTab.dis.figures.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.dis.months.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.dis.payments.empty'))).toBeTruthy();
    expect(screen.getByTestId('dis-figures-link').getAttribute('href')).toBe('/home/home-09');
    expect(screen.getByTestId('dis-payments-link').getAttribute('href')).toBe('/pay/pay-01');
  });

  it('says so when the snapshot holds no line for the project, and keeps the headline out', async () => {
    mount(<DisbursementTab project={{ ...project, id: '00000000-0000-4000-8000-000000000e09' } as ProjectView} />, harness({ leader, snapshot }), { permissions: undefined });
    expect(await screen.findByTestId('dis-no-line')).toBeTruthy();
  });

  it('shows the denied state in the section whose read is refused and keeps the others', async () => {
    const refused = new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c', extensions: {} });
    mount(<DisbursementTab project={project} />, harness({ leader: refused, schedules: [lineRow(11, 'FORECAST', 'CURRENT_YEAR', '50850000000')], payments: new Error('boom') }), { permissions: undefined });
    const figures = await screen.findByTestId('dis-figures');
    await waitFor(() => expect(within(figures).getByText(word('states.denied.title'))).toBeTruthy());
    expect(await within(await screen.findByTestId('dis-months')).findByText('Tháng 11')).toBeTruthy();
    const payments = await screen.findByTestId('dis-payments');
    await waitFor(() => expect(within(payments).getByText(word('states.error.title'))).toBeTruthy());
  });

  it('keeps the headline and says the detail by source could not be read when the snapshot detail fails', async () => {
    mount(<DisbursementTab project={project} />, harness({ leader, snapshot: new Error('boom') }), { permissions: undefined });
    expect(await screen.findByTestId('dis-no-detail')).toBeTruthy();
    expect(screen.getByTestId('dis-asof')).toBeTruthy();
  });
});
