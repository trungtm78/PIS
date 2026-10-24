import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import StructureScreen from './StructureScreen';
import { COMMUNE_A, COMMUNE_B, DISTRICT, MERGED, PROVINCE, conversion, edge, outside, structure, target } from './succession-test-support';
import { READER, client, mount, record, routeOf, world } from './test-support';
import type { World } from './test-support';

const AREAS = routeOf('MDM-02', 'FR-MDM-02');
const AGENCIES = routeOf('MDM-03', 'FR-MDM-03');

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-record-id]'));
const keys = (): string[] => rows().map((row) => row.getAttribute('data-key') ?? '');
const cell = (key: string, column: string): string => document.querySelector(`tr[data-key="${key}"] td[data-column="${column}"]`)?.textContent ?? '';
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const setDate = (value: string): void => {
  fireEvent.change(screen.getByLabelText(vi_['mdm.structure.date.label']), { target: { value } });
};

const ended = (entry: Record<string, unknown>) => ({ ...outside(entry), status: 'RETIRED' });

/** The areas of FX-MDM-001 as they stand after the reform: the district and the two communes are succeeded, the merged commune stands. */
function after(overrides: Partial<World> = {}): World {
  const merge1 = edge(1, COMMUNE_A, MERGED);
  const merge2 = edge(2, COMMUNE_B, MERGED);
  const abolish = edge(3, DISTRICT, PROVINCE, { succession_kind: 'ABOLISH_LEVEL' });
  return world({
    records: [ended(DISTRICT), PROVINCE, ended(COMMUNE_A), ended(COMMUNE_B), MERGED],
    successors: {
      [DISTRICT.id]: conversion(DISTRICT, '2026-10-24', [abolish], [target(PROVINCE, { succession_kind: 'ABOLISH_LEVEL', effective_date: '2025-07-01' })]),
      [COMMUNE_A.id]: conversion(COMMUNE_A, '2026-10-24', [merge1], [target(MERGED, { succession_kind: 'MERGE', effective_date: '2025-07-01' })]),
      [COMMUNE_B.id]: conversion(COMMUNE_B, '2026-10-24', [merge2], [target(MERGED, { succession_kind: 'MERGE', effective_date: '2025-07-01' })]),
    },
    ...overrides,
  });
}

describe('StructureScreen (MDM-02): the areas and their history of mergers', () => {
  it('lists each area with its successor, the kind and the legal basis of the succession, and who it inherited from (AC-ST-MDM-009-1)', async () => {
    mount(<StructureScreen route={AREAS} />, client(after()), READER, '/mdm/mdm-02');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.area.page.title']);
    // The tree: each commune under the entry that heads it, as far as the date allows it to be known.
    expect(keys().sort()).toEqual(['HUYEN-X', 'TINH-X', 'XA-A', 'XA-B', 'XA-Y']);
    await waitFor(() => expect(cell('XA-A', 'successor')).toBe('XA-Y'));
    expect(cell('XA-A', 'successionKind')).toBe(vi_['mdm.value.successionKind.merge']);
    expect(cell('XA-A', 'reformBasis')).toContain('CXN-34');
    expect(cell('HUYEN-X', 'successor')).toBe('TINH-X');
    expect(cell('HUYEN-X', 'successionKind')).toBe(vi_['mdm.value.successionKind.abolishLevel']);
    expect(cell('XA-Y', 'inherited')).toBe('XA-A, XA-B');
    expect(cell('XA-Y', 'successor')).toBe('');
    // An entry that is not in force on the date keeps its name, taken from the succession that handed it over.
    expect(cell('XA-A', 'name')).toBe('Xã A');
    expect(document.querySelector('tr[data-key="XA-A"]')?.getAttribute('data-state')).toBe('SUCCEEDED');
    expect(document.querySelector('tr[data-key="XA-Y"]')?.getAttribute('data-state')).toBe('IN_FORCE');
    expect(screen.getByTestId('count').textContent).toBe(vi_['mdm.structure.count.text'].replace('{count}', '5'));
  });

  it('reads the structure of the chosen date, and lists only the entries in force when asked', async () => {
    const before = world({ records: [DISTRICT, PROVINCE, COMMUNE_A, COMMUNE_B, outside(MERGED)], successors: {} });
    const state = after({ recordsOn: { '2025-06-30': before.records } });
    // On the day before the reform the merged commune is not in force yet: nothing has been handed over to it.
    state.successors = { ...state.successors, [MERGED.id]: conversion(MERGED, '2025-06-30', [], [target(MERGED)]) };
    const h = client(state);
    mount(<StructureScreen route={AREAS} />, h, READER, '/mdm/mdm-02');
    await ready();
    setDate('2025-06-30');
    await waitFor(() => expect(document.querySelector('tr[data-key="XA-A"]')?.getAttribute('data-state')).toBe('IN_FORCE'));
    expect(cell('XA-A', 'successor')).toBe('');
    expect(cell('XA-A', 'validity')).toContain('2025-07-01');
    expect(document.querySelector('tr[data-key="XA-Y"]')?.getAttribute('data-state')).toBe('NOT_IN_FORCE');
    const searched = (h.client.readAll as unknown as { mock: { calls: Array<[string, { query?: Record<string, string> }]> } }).mock.calls.map(([, input]) => input.query?.as_of);
    expect(searched).toContain('2025-06-30');
    fireEvent.click(screen.getByLabelText(vi_['mdm.structure.onlyInForce.label']));
    expect(keys().sort()).toEqual(['HUYEN-X', 'TINH-X', 'XA-A', 'XA-B']);
  });

  it('refuses a date that is not a date and keeps reading today', async () => {
    mount(<StructureScreen route={AREAS} />, client(after()), READER, '/mdm/mdm-02');
    await ready();
    setDate('2025-02-30');
    expect(screen.getByText(vi_['mdm.field.invalidDate.error'])).toBeTruthy();
    expect(keys()).toHaveLength(5);
  });

  it('opens the structure of one entry on the date: its state, the date of its structure and the entries it converts to', async () => {
    const state = after({
      asOf: {
        [COMMUNE_A.id]: structure(COMMUNE_A, '2026-10-24', {
          state: 'SUCCEEDED',
          version: null,
          structure_date: '2025-07-01',
          successors: [edge(1, COMMUNE_A, MERGED)],
          targets: [target(MERGED, { succession_kind: 'MERGE', effective_date: '2025-07-01', share_pct: '100.00' })],
        }),
      },
    });
    mount(<StructureScreen route={AREAS} />, client(state), READER, '/mdm/mdm-02');
    await ready();
    await userEvent.setup().click(within(document.querySelector('tr[data-key="XA-A"]') as HTMLElement).getByRole('button', { name: vi_['mdm.structure.inspect.action'] }));
    const panel = await screen.findByTestId('inspection');
    expect(await within(panel).findByTestId('inspect-state')).toBeTruthy();
    expect(within(panel).getByTestId('inspect-state').textContent).toBe(vi_['mdm.structure.state.succeeded']);
    expect(within(panel).getByTestId('inspect-structure-date').textContent).toBe('2025-07-01');
    const converted = within(panel).getByTestId('inspect-targets');
    expect(converted.textContent).toContain('XA-Y');
    expect(converted.textContent).toContain('MERGE');
    // A second click closes the panel.
    await userEvent.setup().click(within(document.querySelector('tr[data-key="XA-A"]') as HTMLElement).getByRole('button', { name: vi_['mdm.structure.inspect.action'] }));
    expect(screen.queryByTestId('inspection')).toBeNull();
  });

  it('says that the structure of an entry could not be read', async () => {
    mount(<StructureScreen route={AREAS} />, client(after()), READER, '/mdm/mdm-02');
    await ready();
    await userEvent.setup().click(within(document.querySelector('tr[data-key="XA-Y"]') as HTMLElement).getByRole('button', { name: vi_['mdm.structure.inspect.action'] }));
    expect((await screen.findByText(vi_['mdm.structure.inspect.error'])).getAttribute('role')).toBe('alert');
  });

  it('says that the entries could not be read, with a retry, and when there are none', async () => {
    const failing = after({ failing: new Set(['searchMasterRecords']) });
    mount(<StructureScreen route={AREAS} />, client(failing), READER, '/mdm/mdm-02');
    expect(await screen.findByRole('alert')).toBeTruthy();
    failing.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    cleanup();
    mount(<StructureScreen route={AREAS} />, client(world({ records: [] })), READER, '/mdm/mdm-02');
    expect((await screen.findByTestId('empty-structure')).textContent).toBe(vi_['mdm.structure.empty.text']);
  });
});

describe('StructureScreen (MDM-03): the agencies and investors', () => {
  const ministry = record(21, { master_type: 'AGENCY', business_key: 'SO-KHDT', label: 'Sở Kế hoạch và Đầu tư', valid_until: '2025-07-01', status: 'RETIRED', attributes: { kind: 'PROVINCIAL_DEPARTMENT' } });
  const finance = record(22, { master_type: 'AGENCY', business_key: 'SO-TC', label: 'Sở Tài chính', attributes: { kind: 'PROVINCIAL_DEPARTMENT' }, parent_record_id: null });
  const unit = record(23, { master_type: 'AGENCY', business_key: 'BQLDA-1', label: 'Ban QLDA 1', attributes: { kind: 'PMU' }, parent_record_id: finance.id });

  it('lists each agency with its type, parent, validity, successor and the date it ends (AC-ST-MDM-009-1)', async () => {
    const state = world({
      records: [ended(ministry), finance, unit],
      successors: { [ministry.id]: conversion(ministry, '2026-10-24', [edge(9, ministry, finance, { master_type: 'AGENCY' })], [target(finance, { succession_kind: 'MERGE', effective_date: '2025-07-01' })]) },
    });
    mount(<StructureScreen route={AGENCIES} />, client(state), READER, '/mdm/mdm-03');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.agency.page.title']);
    expect(keys()).toEqual(['BQLDA-1', 'SO-KHDT', 'SO-TC']);
    expect(cell('BQLDA-1', 'agencyKind')).toBe('PMU');
    expect(cell('BQLDA-1', 'parent')).toBe('SO-TC');
    await waitFor(() => expect(cell('SO-KHDT', 'successor')).toBe('SO-TC'));
    expect(cell('SO-KHDT', 'legalName')).toBe('Sở Kế hoạch và Đầu tư');
    expect(screen.getByRole('columnheader', { name: vi_['mdm.structure.validUntil.column'] })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: vi_['mdm.structure.legalName.column'] })).toBeTruthy();
  });
});
