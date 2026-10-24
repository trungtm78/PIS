import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterHistoryScreen from './MasterHistoryScreen';
import { OTHER, READER, change, client, mount, record, routeOf, version, world } from './test-support';

const ROUTE = routeOf('MDM-28', 'FR-MDM-28');
const AT = '/mdm/mdm-28?type=SECTOR&key=GT-1';
const fill = (template: string, params: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));

afterEach(cleanup);

const ready = () => waitFor(() => expect(document.querySelector('[data-revision]')).not.toBeNull());

const TWO_VERSIONS = [
  version(1, 1, { valid_until: '2025-06-01' }),
  { ...version(1, 2, { label: 'Giao thông vận tải', attributes: { group: 'transport' }, valid_from: '2025-06-01', legal_basis: 'Decision 12' }), id: '00000000-0000-4000-8000-00000000b099' },
];

describe('MasterHistoryScreen (MDM-28)', () => {
  it('shows each version with what it changed against the one before, the approver and the period', async () => {
    mount(<MasterHistoryScreen route={ROUTE} />, client(world({ versions: TWO_VERSIONS })), READER, AT);
    await ready();
    const first = within(document.querySelector('[data-revision="1"]') as HTMLElement);
    expect(first.getByText(vi_['mdm.history.created.text'])).toBeTruthy();
    expect(first.getByText(OTHER)).toBeTruthy();
    expect(first.getAllByText('2024-01-01 → 2025-06-01')).toHaveLength(2);
    const second = document.querySelector('[data-revision="2"]') as HTMLElement;
    const label = second.querySelector('[data-field="label"]') as HTMLElement;
    expect(label.querySelector('[data-side="before"]')?.textContent).toBe('Giao thông 1');
    expect(label.querySelector('[data-side="after"]')?.textContent).toBe('Giao thông vận tải');
    expect(second.querySelector('[data-field="attributes"] [data-side="after"]')?.textContent).toBe('{"group":"transport"}');
    expect(second.querySelector('[data-field="legalBasis"] [data-side="after"]')?.textContent).toBe('Decision 12');
    expect(second.querySelector('[data-field="parent"]')).toBeNull();
    expect(within(second).getByText(`2025-06-01 → ${vi_['mdm.detail.validity.open']}`)).toBeTruthy();
  });

  it('shows the versions oldest first, and a version that changed nothing says so', async () => {
    const same = [version(1, 1), { ...version(1, 2), id: '00000000-0000-4000-8000-00000000b098' }];
    mount(<MasterHistoryScreen route={ROUTE} />, client(world({ versions: [...same].reverse() })), READER, AT);
    await ready();
    expect([...document.querySelectorAll('[data-revision]')].map((row) => row.getAttribute('data-revision'))).toEqual(['1', '2']);
    expect(within(document.querySelector('[data-revision="2"]') as HTMLElement).getByText(vi_['mdm.history.unchanged.text'])).toBeTruthy();
  });

  it('shows the request that is waiting, with its kind, status and date', async () => {
    const state = world({ versions: TWO_VERSIONS, records: [record(1, { open_change_request_id: change(1).id })], changes: [change(1)] });
    mount(<MasterHistoryScreen route={ROUTE} />, client(state), READER, AT);
    await ready();
    await waitFor(() =>
      expect(screen.getByTestId('pending').textContent).toContain(fill(vi_['mdm.history.pending.notice'], { kind: vi_['mdm.kind.change.update'], status: vi_['mdm.status.change.inReview'], from: '2025-06-01' })),
    );
  });

  it('says so when there is no version, when the history cannot be read, and when no entry is chosen', async () => {
    mount(<MasterHistoryScreen route={ROUTE} />, client(world({ versions: [] })), READER, AT);
    expect(await screen.findByText(vi_['mdm.history.empty.text'])).toBeTruthy();
    cleanup();
    mount(<MasterHistoryScreen route={ROUTE} />, client(world({ failing: new Set(['get_resources_master_record_version']) })), READER, AT);
    expect((await screen.findByText(vi_['mdm.history.error.text'])).closest('[role="alert"]')).not.toBeNull();
    cleanup();
    mount(<MasterHistoryScreen route={ROUTE} />, client(world()), READER, '/mdm/mdm-28');
    expect(await screen.findByTestId('no-record')).toBeTruthy();
  });
});
