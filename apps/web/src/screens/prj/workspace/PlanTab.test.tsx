import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { MAKER, client, detail, mount, word, world } from '../test-support';
import { toProjectView } from '../model';
import type { ProjectView } from '../model';
import PlanTab from './PlanTab';
import { inForce } from './plan-hooks';

afterEach(cleanup);

const PROJECT = detail(1);
const OTHER = '00000000-0000-4000-8000-0000000000ff';
const view = toProjectView(PROJECT) as ProjectView;

const plan = (id: string, kind: string, status: string, overrides: Record<string, unknown> = {}) => ({
  id,
  plan_code: `KHV-${id}`,
  plan_kind: kind,
  plan_year: kind === 'ANNUAL' ? 2026 : null,
  period_from_year: 2026,
  period_to_year: kind === 'ANNUAL' ? 2026 : 2030,
  scope_unit: { id: 'u', name: 'Unit' },
  revision: 1,
  status,
  version: 1,
  ...overrides,
});
const capitalLine = (id: string, projectId: string, label: string, bucket: string, amount: string) => ({
  id,
  project: { id: projectId, code: 'DA', name: 'Dự án' },
  fund_source: { version_id: `v-${id}`, business_key: label, label },
  bucket,
  source_year: 2026,
  amount_vnd: amount,
  ctmtqg_subset_vnd: '0',
  disbursed_vnd: '1000',
  version: 1,
});
const milestone = (id: string, delayed: boolean) => ({
  id,
  code: `M${id}`,
  name: `Moc ${id}`,
  baseline_date: '2026-07-13',
  planned_date: '2026-09-13',
  actual_date: null,
  status: delayed ? 'DELAYED' : 'PLANNED',
  delay_days: delayed ? 62 : 0,
  delayed,
  version: 1,
});
const pack = (id: string, projectId: string) => ({
  id,
  code: `GT-${id}`,
  title: `Goi ${id}`,
  project: { id: projectId, code: 'DA', name: 'Dự án', status: 'IMPLEMENTATION' },
  budget_vnd: '5000000000',
  method: 'OPEN_BIDDING',
  status: 'AWARDED',
});
const contract = (id: string, projectId: string) => ({
  id,
  code: `HD-${id}`,
  title: `Hop dong ${id}`,
  status: 'ACTIVE',
  type: 'LUMP_SUM',
  project_id: projectId,
  project_code: 'DA',
  project_name: 'Dự án',
  package_id: 'p',
  contractor_id: 'c',
  contractor_name: 'Nha thau A',
  contract_value_vnd: '4000000000',
  version: 1,
});

interface Data {
  milestones: unknown[];
  components: Record<string, unknown>;
  plans: unknown[];
  lines: Record<string, unknown[]>;
  packages: unknown[];
  contracts: unknown[];
  failing?: Record<string, Error>;
}

const EMPTY: Data = { milestones: [], components: { items: [], wbs_total_vnd: '0', project_total_vnd: '0', exceeds_total: false }, plans: [], lines: {}, packages: [], contracts: [] };

function harnessOf(data: Data) {
  const h = client(world());
  const fail = (operation: string): Error | undefined => data.failing?.[operation];
  h.read.mockImplementation((operation: string, input?: unknown) => {
    const failure = fail(operation);
    if (failure !== undefined) return Promise.reject(failure);
    if (operation === 'listProjectMilestones') return Promise.resolve({ items: data.milestones });
    if (operation === 'listProjectComponents') return Promise.resolve(data.components);
    if (operation === 'listCapitalPlanLines') {
      const id = (input as { path: { id: string } }).path.id;
      const planRow = data.plans.find((item) => (item as { id: string }).id === id);
      return Promise.resolve({ plan: planRow, items: data.lines[id] ?? [], totals: {}, next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected read ${operation}`));
  });
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    const failure = fail(operation);
    if (failure !== undefined) return Promise.reject(failure);
    switch (operation) {
      case 'get_resources_plan_version':
        return Promise.resolve(data.plans);
      case 'get_resources_procurement_package':
        return Promise.resolve(data.packages);
      case 'get_resources_contract':
        return Promise.resolve(data.contracts);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

const show = (data: Data) => mount(<PlanTab project={view} />, harnessOf(data), { permissions: MAKER });

describe('PlanTab (PRJ-03, tab Plan)', () => {
  it('shows the milestones with the delay, the components, the capital lines of the project from the revision in force, its packages and contracts', async () => {
    show({
      milestones: [milestone('1', true), milestone('2', false)],
      components: { items: [{ id: 'c1', parent_component_id: null, code: 'CP1', name: 'Xay lap', planned_value_vnd: '1000000000', valid_from: '2026-01-01', depth: 1 }], wbs_total_vnd: '1000000000', project_total_vnd: '500000000000', exceeds_total: false },
      plans: [plan('a1', 'ANNUAL', 'PUBLISHED', { revision: 2 }), plan('a0', 'ANNUAL', 'SUPERSEDED'), plan('m1', 'MEDIUM_TERM', 'DRAFT')],
      lines: {
        a1: [capitalLine('l1', PROJECT.id as string, 'Von chu so huu', 'EQUITY', '160000000000'), capitalLine('l2', PROJECT.id as string, 'Von vay', 'LOAN', '159000000000'), capitalLine('l3', OTHER, 'Khac', 'EQUITY', '1')],
        a0: [capitalLine('l9', PROJECT.id as string, 'Cu', 'EQUITY', '7')],
      },
      packages: [pack('1', PROJECT.id as string), pack('2', OTHER)],
      contracts: [contract('1', PROJECT.id as string), contract('2', OTHER)],
    });
    const milestones = await screen.findByTestId('ws-milestones');
    await waitFor(() => expect(within(milestones).getByText('Moc 1', { exact: false })).toBeTruthy());
    expect(within(milestones).getByTestId('delay').textContent).toBe(vi_['prj.mile.delay.pill'].replace('{days}', '62'));
    expect(within(milestones).getByText(vi_['prj.mile.status.delayed'])).toBeTruthy();
    expect(within(await screen.findByTestId('ws-components')).getByText('CP1')).toBeTruthy();
    expect(screen.getByTestId('ws-wbs-total').textContent).toContain('500.000.000.000');
    const capital = await screen.findByTestId('ws-capital');
    await waitFor(() => expect(within(capital).getAllByTestId('ws-capital-plan')).toHaveLength(1));
    expect(within(capital).getByText('Von chu so huu')).toBeTruthy();
    expect(within(capital).getByText('Von vay')).toBeTruthy();
    expect(within(capital).queryByText('Khac')).toBeNull();
    expect(within(capital).queryByText('Cu')).toBeNull();
    expect(within(capital).getByTestId('ws-capital-total').textContent).toContain('319.000.000.000');
    const packages = await screen.findByTestId('ws-packages');
    await waitFor(() => expect(within(packages).getByText('GT-1')).toBeTruthy());
    expect(within(packages).queryByText('GT-2')).toBeNull();
    expect(within(packages).getByText(word('prj.wsTab.plan.pkgStatus.awarded'))).toBeTruthy();
    const contracts = await screen.findByTestId('ws-contracts');
    await waitFor(() => expect(within(contracts).getByText('HD-1')).toBeTruthy());
    expect(within(contracts).queryByText('HD-2')).toBeNull();
    expect(within(contracts).getByText(vi_['ctr.status.active.label'])).toBeTruthy();
    expect(screen.getByTestId('ws-packages-link').getAttribute('href')).toBe('/bid/bid-03');
    expect(screen.getByTestId('ws-contracts-link').getAttribute('href')).toBe('/ctr/ctr-01');
    expect(screen.getByTestId('ws-milestones-link').getAttribute('href')).toBe(`/prj/prj-07?id=${PROJECT.id as string}`);
  });

  it('reads the capital lines of the project only, from the revision in force', async () => {
    const h = harnessOf({ ...EMPTY, plans: [plan('a1', 'ANNUAL', 'PUBLISHED')] });
    mount(<PlanTab project={view} />, h, { permissions: MAKER });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listCapitalPlanLines', { path: { id: 'a1' }, query: { project_id: PROJECT.id as string, limit: 200 } }));
  });

  it('says in words that there is nothing yet, per section, for a project with no data', async () => {
    show({ ...EMPTY, plans: [plan('a1', 'ANNUAL', 'PUBLISHED')] });
    await waitFor(() => expect(screen.getByText(word('prj.wsTab.plan.milestones.empty'))).toBeTruthy());
    expect(await screen.findByText(word('prj.wsTab.plan.components.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.plan.capital.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.plan.packages.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.plan.contracts.empty'))).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the standard denied state in the section that is refused and keeps the others', async () => {
    const denied = new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c', extensions: {} });
    show({ ...EMPTY, contracts: [], failing: { get_resources_contract: denied } });
    const contracts = await screen.findByTestId('ws-contracts');
    await waitFor(() => expect(within(contracts).getByText(vi_['states.denied.title'])).toBeTruthy());
    expect(await screen.findByText(word('prj.wsTab.plan.packages.empty'))).toBeTruthy();
    expect(await screen.findByText(word('prj.wsTab.plan.milestones.empty'))).toBeTruthy();
  });

  it('keeps the tab standing when a read fails for another reason', async () => {
    show({ ...EMPTY, failing: { listProjectMilestones: new Error('boom') } });
    const milestones = await screen.findByTestId('ws-milestones');
    await waitFor(() => expect(within(milestones).getByText(vi_['states.error.title'])).toBeTruthy());
    expect(await screen.findByText(word('prj.wsTab.plan.contracts.empty'))).toBeTruthy();
  });
});

describe('inForce', () => {
  it('chooses the latest published revision of one kind and nothing when none is published', () => {
    const rows = ['a1', 'a2'].map((id, index) => ({ id, planKind: 'ANNUAL', status: 'PUBLISHED', periodFromYear: 2026, periodToYear: 2026, revision: index + 1 }));
    const plans = [...rows, { id: 'a3', planKind: 'ANNUAL', status: 'DRAFT', periodFromYear: 2026, periodToYear: 2026, revision: 3 }] as never[];
    expect(inForce(plans, 'ANNUAL')?.id).toBe('a2');
    expect(inForce(plans, 'MEDIUM_TERM')).toBeUndefined();
  });
});
