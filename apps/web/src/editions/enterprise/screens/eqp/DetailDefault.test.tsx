import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import viJson from '../../../../i18n/vi.json';
import { harness, mountInSession } from '../../../../screens/adm/security/test-support';
import EquipmentDetailScreen from './DetailScreen';

const vi_ = viJson as Record<string, string>;
const word = (key: string): string => vi_[key] ?? key;
const ROUTE = { id: 'EQP-02', req: 'FR-EQP', title: 'x', path: '/eqp/eqp-02', kind: 'table', area: 'insights', module: 'EQP', group: 'g', role: 'workspace', parent: null } as never;
const FIRST = '00000000-0000-4000-8000-0000000000b1';
const SECOND = '00000000-0000-4000-8000-0000000000b2';
const NAMED = '00000000-0000-4000-8000-0000000000b3';

// Which address the screen is opened on is chosen by each test (the session harness mounts a router at the root).
const address = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('react-router-dom', async (original: () => Promise<Record<string, unknown>>) => ({ ...(await original()), useSearchParams: () => [address.params] }));

afterEach(() => {
  cleanup();
  address.params = new URLSearchParams();
});

const line = (id: string, code: string) => ({
  id,
  code,
  name: `Thiết bị ${code}`,
  plan_ref: null,
  status: 'ACTIVE',
  source: 'MANUAL',
  stage: 'PLANNED',
  project: { id: '00000000-0000-4000-8000-0000000000c1', code: 'DA-01', name: 'Nhà máy' },
  owner_unit: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Ban Thương mại' },
  planned_value_vnd: '1000000000',
  package: null,
  selection: null,
  contract: null,
  contract_value_vnd: null,
  plan_variance_vnd: null,
  paid_vnd: null,
  disbursement_percent: null,
  masked: [],
  external_link: null,
  version: 1,
});
const guide = { state: 'NEVER_IMPORTED', age_hours: null, layout_version: 'WORKING-ASSUMPTION-2026.2', acceptance: 'PENDING_EXTERNAL', steps: ['DOWNLOAD', 'UPLOAD', 'DRY_RUN', 'APPLY', 'LINK'] };
const client = (items: unknown[]) =>
  harness((operation, input) => {
    if (operation === 'listEquipmentProcurement') return { items, data_guide: guide, as_of: '2026-11-10T00:00:00.000Z' };
    if (operation === 'getEquipmentProcurement') {
      const id = (input as { path: { id: string } }).path.id;
      const found = items.find((item) => (item as { id: string }).id === id) ?? line(id, 'NAMED');
      return { line: found, data_guide: guide };
    }
    return new Error(`unexpected read ${operation}`);
  });

describe('EQP-02 opened without a line in the address', () => {
  it('shows the first line of the list and says so', async () => {
    const h = client([line(FIRST, 'TB-01'), line(SECOND, 'TB-02')]);
    mountInSession(<EquipmentDetailScreen route={ROUTE} />, h, { permissions: ['bid.read'] });
    expect(await screen.findByText('TB-01 · Thiết bị TB-01')).toBeTruthy();
    expect(screen.getByTestId('default-line').textContent).toBe(word('eqp.detail.default'));
    expect(h.read).toHaveBeenCalledWith('getEquipmentProcurement', { path: { id: FIRST } });
  });

  it('keeps the standard empty state when there is no line at all', async () => {
    mountInSession(<EquipmentDetailScreen route={ROUTE} />, client([]), { permissions: ['bid.read'] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    expect(screen.queryByTestId('default-line')).toBeNull();
  });

  it('reads the named line and does not read the list at all', async () => {
    address.params = new URLSearchParams({ line: NAMED });
    const h = client([line(FIRST, 'TB-01')]);
    mountInSession(<EquipmentDetailScreen route={ROUTE} />, h, { permissions: ['bid.read'] });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getEquipmentProcurement', { path: { id: NAMED } }));
    expect(h.read.mock.calls.some((call) => call[0] === 'listEquipmentProcurement')).toBe(false);
    expect(screen.queryByTestId('default-line')).toBeNull();
  });
});
