import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import viJson from '../../../../i18n/vi.json';
import { harness, mountInSession } from '../../../../screens/adm/security/test-support';
import type { Harness } from '../../../../screens/adm/security/test-support';
import EquipmentDetailScreen from './DetailScreen';
import EquipmentListScreen from './ListScreen';
import { toList, validateCreate, validateLink } from './model';

const vi_ = viJson as Record<string, string>;
const ROUTE = (id: string) => ({ id, req: 'FR-EQP', title: 'x', path: '/eqp', kind: 'table', area: 'insights', module: 'EQP', group: 'g', role: 'workspace', parent: null }) as never;
const LINE_ID = '00000000-0000-4000-8000-0000000000b1';
const PACKAGE_ID = '00000000-0000-4000-8000-0000000000e1';
const READER = ['bid.read'];
const MANAGER = ['bid.read', 'bid.plan.manage'];

// The screens read the line from the address (`?line=`); the session harness mounts a router at the root, so the reading of the address is fixed here.
vi.mock('react-router-dom', async (original: () => Promise<Record<string, unknown>>) => ({ ...(await original()), useSearchParams: () => [new URLSearchParams({ line: '00000000-0000-4000-8000-0000000000b1' })] }));

afterEach(cleanup);

const line = (overrides: Record<string, unknown> = {}) => ({
  id: LINE_ID,
  code: 'TB-01',
  name: 'Gas turbine spare',
  plan_ref: null,
  status: 'ACTIVE',
  source: 'MANUAL',
  stage: 'DISBURSING',
  project: { id: '00000000-0000-4000-8000-0000000000c1', code: 'DA-01', name: 'Plant' },
  owner_unit: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Ban Thuong mai' },
  planned_value_vnd: '1000000000',
  package: { id: PACKAGE_ID, code: 'GT-01', title: 'Turbine', status: 'APPROVED', external_code: 'EG-1' },
  selection: { outcome: 'AWARDED', status: 'APPROVED', award_price_vnd: '900000000', winner_name: 'Contractor A' },
  contract: { id: '00000000-0000-4000-8000-0000000000f1', code: 'HD-01', status: 'ACTIVE' },
  contract_value_vnd: '900000000',
  plan_variance_vnd: '-100000000',
  paid_vnd: '300000000',
  disbursement_percent: '33.3',
  masked: [],
  external_link: { external_code: 'EG-1', diff_status: 'IN_SYNC' },
  version: 4,
  ...overrides,
});
const guide = (overrides: Record<string, unknown> = {}) => ({ state: 'NEVER_IMPORTED', age_hours: null, layout_version: 'WORKING-ASSUMPTION-2026.2', acceptance: 'PENDING_EXTERNAL', steps: ['DOWNLOAD', 'UPLOAD', 'DRY_RUN', 'APPLY', 'LINK'], ...overrides });
const list = (items: unknown[]) => ({ items, data_guide: guide(), as_of: '2026-11-09T00:00:00.000Z' });

describe('the equipment model', () => {
  it('reads lines and drops a line with an unknown stage', () => {
    const read = toList(list([line(), line({ stage: 'ODD' })]));
    expect(read.items.map((item) => item.code)).toEqual(['TB-01']);
    expect(read.guide.steps).toHaveLength(5);
  });

  it('judges the forms', () => {
    expect(validateCreate({ projectId: '', code: '', name: 'a', plannedValueVnd: '0', planRef: '' })).toEqual({ projectId: 'required', code: 'required', name: 'required', plannedValueVnd: 'format' });
    const read = toList(list([line({ package: null, contract: null })])).items[0];
    if (read === undefined) throw new Error('the line was not read');
    expect(validateLink({ packageId: '', contractId: '' }, read)).toBe('nothing');
    expect(validateLink({ packageId: 'zzz', contractId: '' }, read)).toBe('format');
    expect(validateLink({ packageId: PACKAGE_ID, contractId: '' }, read)).toBeUndefined();
  });
});

describe('EquipmentListScreen (EQP-01)', () => {
  it('shows each line with its stage and the block how to get data with the pending-external word', async () => {
    mountInSession(<EquipmentListScreen route={ROUTE('EQP-01')} />, harness(() => list([line()])), { permissions: READER });
    const table = await screen.findByTestId('lines');
    expect(table.querySelector('tr[data-stage="DISBURSING"]')).toBeTruthy();
    expect(screen.getByTestId('data-guide').getAttribute('data-state')).toBe('NEVER_IMPORTED');
    expect(screen.getByTestId('pending-external')).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['eqp.form.aria'] })).toBeNull();
  });

  it('says no access for money the caller may not read, never zero', async () => {
    const hidden = line({ masked: ['CONTRACT', 'PAYMENT'], contract_value_vnd: null, paid_vnd: null, disbursement_percent: null });
    mountInSession(<EquipmentListScreen route={ROUTE('EQP-01')} />, harness(() => list([hidden])), { permissions: READER });
    const table = await screen.findByTestId('lines');
    expect(within(table).getAllByText(vi_['eqp.list.masked'] ?? '')).toHaveLength(2);
  });

  it('says there is nothing in the scope, and offers the form to a planner', async () => {
    mountInSession(<EquipmentListScreen route={ROUTE('EQP-01')} />, harness((operation) => (operation === 'listEquipmentProcurement' ? list([]) : [])), { permissions: MANAGER });
    expect((await screen.findByTestId('empty-lines')).textContent).toBe(vi_['eqp.list.empty']);
    expect(screen.getByRole('form', { name: vi_['eqp.form.aria'] })).toBeTruthy();
  });
});

describe('EquipmentDetailScreen (EQP-02)', () => {
  const mountDetail = (item: Record<string, unknown>, permissions: readonly string[]): Harness => {
    const h = harness(() => ({ line: item, data_guide: guide({ state: 'FRESH', age_hours: 5, steps: ['LINK'] }), as_of: 'x' }), () => ({ resource_id: 'x' }));
    mountInSession(<EquipmentDetailScreen route={ROUTE('EQP-02')} />, h, { permissions });
    return h;
  };

  it('shows the plan, the result, the contract and the payments of one line', async () => {
    mountDetail(line(), READER);
    expect((await screen.findByTestId('fact-winner')).textContent).toContain('Contractor A');
    expect(screen.getByTestId('fact-contract').textContent).toContain('HD-01');
    expect(screen.getByTestId('fact-paid').textContent).toContain('33.3%');
  });

  it('cancels a line only with a reason, and sends the version the person saw', async () => {
    const h = mountDetail(line(), MANAGER);
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['eqp.manage.aria'] });
    await user.click(within(form).getByRole('button', { name: vi_['eqp.manage.cancel'] }));
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['eqp.manage.reason'] ?? ''), 'dropped from the plan');
    await user.click(within(form).getByRole('button', { name: vi_['eqp.manage.cancel'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('updateEquipmentProcurementItem');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 4, body: { cancel_reason: 'dropped from the plan' } });
  });

  it('offers no form to a reader and none for a cancelled line', async () => {
    mountDetail(line(), READER);
    await screen.findByTestId('fact-winner');
    expect(screen.queryByRole('form', { name: vi_['eqp.manage.aria'] })).toBeNull();
    cleanup();
    mountDetail(line({ status: 'CANCELLED', stage: 'CANCELLED' }), MANAGER);
    await screen.findByTestId('fact-winner');
    expect(screen.queryByRole('form', { name: vi_['eqp.manage.aria'] })).toBeNull();
  });
});
