import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mountInSession } from '../../doc/test-support';
import type { Harness } from '../../doc/test-support';
import type { StructureView } from '../../mdm/succession-model';
import { toStructure } from '../../mdm/succession-model';
import { toProjectView } from '../../prj/model';
import { routeOf as baseRoute } from '../../sas/test-support';
import MapScreen from './MapScreen';
import { MAX_PROJECTS, OUTSIDE, clustersOf, filterProjects, sectorsOf, toMapProject, validDate } from './model';

const word = (key: string, params: Record<string, string | number> = {}): string =>
  ((vi_ as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
const ROUTE = { ...baseRoute('HOME-05', 'FR-HOME-05'), module: 'HOME', path: '/home/home-05' };
const ALL = ['home.read', 'project.read', 'master_record_version.read', 'master.read'];
const uuid = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const AREA_A = { record: uuid('0a01', 1), version: uuid('0b01', 1), key: 'XA-A', label: 'Xã A' };
const AREA_Y = { record: uuid('0a01', 2), version: uuid('0b01', 2), key: 'XA-Y', label: 'Xã Y' };
const AREA_Z = { record: uuid('0a01', 3), version: uuid('0b01', 3), key: 'XA-Z', label: 'Xã Z' };
const AREA_OLD = { record: uuid('0a01', 4), version: uuid('0b01', 4), key: 'XA-OLD', label: 'Xã cũ' };
type Area = typeof AREA_A;

const line = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid('0c01', n),
  code: `P-A-${String(n).padStart(3, '0')}`,
  name: `Dự án ${n}`,
  status: 'IMPLEMENTATION',
  version: 1,
  ...extra,
});
const detail = (n: number, area: Area, extra: Record<string, unknown> = {}) => ({
  ...line(n),
  area: { version_id: area.version, business_key: area.key, label: area.label },
  sector: { version_id: uuid('0d01', 1), business_key: 'GIAO-THONG', label: 'Giao thông' },
  total_investment_vnd: '1000000000',
  classification: 'INTERNAL',
  ...extra,
});
const version = (area: Area, from: string) => ({ id: area.version, revision: 1, label: area.label, valid_from: from, valid_until: null, parent_record_id: null });
const reading = (area: Area, asOf: string, extra: Record<string, unknown> = {}) => ({
  master_record_id: area.record,
  master_type: 'AREA',
  business_key: area.key,
  as_of: asOf,
  state: 'IN_FORCE',
  structure_date: '2020-01-01',
  version: version(area, '2020-01-01'),
  predecessors: [],
  successors: [],
  targets: [
    { record_id: area.record, master_type: 'AREA', business_key: area.key, succession_kind: null, effective_date: null, share_pct: '100.00', in_force: true, version: version(area, '2020-01-01') },
  ],
  ...extra,
});
const mergedInto = (from: Area, into: Area, asOf: string) =>
  reading(from, asOf, {
    state: 'SUCCEEDED',
    structure_date: '2025-07-01',
    version: null,
    targets: [
      {
        record_id: into.record,
        master_type: 'AREA',
        business_key: into.key,
        succession_kind: 'MERGE',
        effective_date: '2025-07-01',
        share_pct: '100.00',
        in_force: true,
        version: version(into, '2025-07-01'),
      },
    ],
  });

interface World {
  lines: Array<Record<string, unknown>>;
  details: Record<string, Record<string, unknown>>;
  /** The reading of an entry for a date: by `${record}:${date}`, or by record for any date. */
  readings: (record: string, date: string) => Record<string, unknown> | undefined;
  recordOfVersion: Record<string, string | null>;
  failing: string | undefined;
  networkDown: boolean;
}

const AREAS = [AREA_A, AREA_Y, AREA_Z, AREA_OLD];

function world(overrides: Partial<World> = {}): World {
  return {
    lines: [line(1)],
    details: { [uuid('0c01', 1)]: detail(1, AREA_A) },
    readings: (record, date) => {
      const area = AREAS.find((candidate) => candidate.record === record);
      if (area === undefined) return undefined;
      return area === AREA_A && date >= '2025-07-01' ? mergedInto(AREA_A, AREA_Y, date) : reading(area, date);
    },
    recordOfVersion: Object.fromEntries(AREAS.map((area) => [area.version, area.record])),
    failing: undefined,
    networkDown: false,
    ...overrides,
  };
}

function open(state: World, options: { permissions?: readonly string[] | undefined; path?: string } = {}): Harness {
  const h = harness((operation, input) => {
    if (state.failing === operation) return state.networkDown ? new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c-0' }) : new Error(`${operation} failed`);
    const request = input as { path?: { id: string }; query?: { date: string } };
    switch (operation) {
      case 'get_resources_project_id':
        return state.details[request.path?.id ?? ''] ?? new Error('no such project');
      case 'get_resources_master_record_version_id': {
        const record = state.recordOfVersion[request.path?.id ?? ''];
        return record === undefined ? new Error('no such version') : { id: request.path?.id, master_record_id: record };
      }
      case 'getMasterRecordAsOf':
        return state.readings(request.path?.id ?? '', request.query?.date ?? '') ?? new Error('no such entry');
      default:
        return new Error(`unexpected read ${operation}`);
    }
  });
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) =>
    operation === 'get_resources_project'
      ? state.failing === operation
        ? Promise.reject(new Error('x'))
        : Promise.resolve(state.lines)
      : Promise.reject(new Error(`unexpected readAll ${operation}`)),
  );
  mountInSession(<MapScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : ALL }, options.path ?? '/home/home-05');
  return h;
}

const asOfReads = (h: Harness): string[] => h.read.mock.calls.filter((call) => call[0] === 'getMasterRecordAsOf').map((call) => (call[1] as { query: { date: string } }).query.date);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2025-11-03T05:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const structureOf = (area: Area, asOf: string): StructureView => toStructure(world().readings(area.record, asOf)) as StructureView;
const project = (n: number, area: Area, extra: Record<string, unknown> = {}) => toMapProject(toProjectView(detail(n, area, extra)) as NonNullable<ReturnType<typeof toProjectView>>, area.record);

describe('the placing of projects on a structure (ST-HOME-006)', () => {
  it('takes the area entry and the sector of a project from its workspace', () => {
    expect(project(1, AREA_A)).toEqual({
      id: uuid('0c01', 1),
      code: 'P-A-001',
      name: 'Dự án 1',
      status: 'IMPLEMENTATION',
      sectorKey: 'GIAO-THONG',
      sectorLabel: 'Giao thông',
      areaRecordId: AREA_A.record,
    });
    expect(project(1, AREA_A, { sector: null })).toMatchObject({ sectorKey: null, sectorLabel: null });
  });

  it('puts a project under the area it stood in before a merge and under the area it became after (UAT-AC277)', () => {
    const before = clustersOf([project(1, AREA_A)], { [AREA_A.record]: structureOf(AREA_A, '2025-06-30') });
    expect(before).toEqual([
      {
        key: AREA_A.record,
        label: 'Xã A',
        structureDate: '2020-01-01',
        inForce: true,
        projects: [{ id: uuid('0c01', 1), code: 'P-A-001', name: 'Dự án 1', status: 'IMPLEMENTATION', sharePct: '100.00' }],
      },
    ]);
    const after = clustersOf([project(1, AREA_A)], { [AREA_A.record]: structureOf(AREA_A, '2025-08-01') });
    expect(after).toMatchObject([{ key: AREA_Y.record, label: 'Xã Y', structureDate: '2025-07-01', inForce: true }]);
  });

  it('puts a project under each area its own was split into, with the part that went there', () => {
    const split = toStructure(
      reading(AREA_A, '2025-08-01', {
        state: 'SUCCEEDED',
        structure_date: '2025-07-01',
        version: null,
        targets: [
          {
            record_id: AREA_Y.record,
            master_type: 'AREA',
            business_key: AREA_Y.key,
            succession_kind: 'SPLIT',
            effective_date: '2025-07-01',
            share_pct: '60.00',
            in_force: true,
            version: version(AREA_Y, '2025-07-01'),
          },
          { record_id: AREA_Z.record, master_type: 'AREA', business_key: AREA_Z.key, succession_kind: 'SPLIT', effective_date: '2025-07-01', share_pct: '40.00', in_force: false, version: null },
        ],
      }),
    ) as StructureView;
    const clusters = clustersOf([project(1, AREA_A)], { [AREA_A.record]: split });
    expect(clusters.map((cluster) => [cluster.label, cluster.projects[0]?.sharePct, cluster.inForce])).toEqual([
      ['Xã Y', '60.00', true],
      ['XA-Z', '40.00', false],
    ]);
  });

  it('keeps a project whose area is in no structure on the date apart, last, and orders areas and projects', () => {
    const none = toStructure(reading(AREA_OLD, '1999-01-01', { state: 'NOT_STARTED', version: null, targets: [] })) as StructureView;
    const clusters = clustersOf([project(3, AREA_Y), project(2, AREA_OLD), project(1, AREA_Y), project(4, AREA_Z)], {
      [AREA_Y.record]: structureOf(AREA_Y, '2025-08-01'),
      [AREA_OLD.record]: none,
    });
    expect(clusters.map((cluster) => cluster.key)).toEqual([AREA_Y.record, OUTSIDE]);
    expect(clusters[0]?.projects.map((entry) => entry.code)).toEqual(['P-A-001', 'P-A-003']);
    // AREA_Z has no reading at all: it is outside too, in the same group.
    expect(clusters[1]?.projects.map((entry) => entry.code)).toEqual(['P-A-002', 'P-A-004']);
    const reversed = clustersOf([project(2, AREA_OLD), project(1, AREA_Y)], { [AREA_Y.record]: structureOf(AREA_Y, '2025-08-01'), [AREA_OLD.record]: none });
    expect(reversed.map((cluster) => cluster.key)).toEqual([AREA_Y.record, OUTSIDE]);
    const alphabetical = clustersOf([project(1, AREA_Z), project(2, AREA_A)], { [AREA_Z.record]: structureOf(AREA_Z, '2025-08-01'), [AREA_A.record]: structureOf(AREA_A, '2025-08-01') });
    expect(alphabetical.map((cluster) => cluster.label)).toEqual(['Xã Y', 'Xã Z']);
  });

  it('narrows by status and sector, lists the sectors once and accepts only a real date', () => {
    const projects = [
      project(1, AREA_A),
      project(2, AREA_A, { status: 'CLOSED', sector: { version_id: uuid('0d01', 2), business_key: 'NONG-NGHIEP', label: 'Nông nghiệp' } }),
      project(3, AREA_A, { sector: null }),
    ];
    expect(filterProjects(projects, { status: 'CLOSED', sector: '' })).toHaveLength(1);
    expect(filterProjects(projects, { status: '', sector: 'GIAO-THONG' })).toHaveLength(1);
    expect(filterProjects(projects, { status: '', sector: '' })).toHaveLength(3);
    expect(sectorsOf(projects)).toEqual([
      { key: 'GIAO-THONG', label: 'Giao thông' },
      { key: 'NONG-NGHIEP', label: 'Nông nghiệp' },
    ]);
    expect(validDate('2025-07-01')).toBe('2025-07-01');
    expect(validDate('2025-02-30')).toBeUndefined();
    expect(validDate('x')).toBeUndefined();
    expect(validDate(null)).toBeUndefined();
  });
});

describe('HOME-05: the project map (ST-HOME-006, UI-HOME-05)', () => {
  it('places the project under the area of the structure before the merge, with the date of the structure (UAT-AC277)', async () => {
    const h = open(world(), { path: '/home/home-05?as_of=2025-06-30' });
    const areas = await screen.findByTestId('map-areas');
    expect(areas.querySelector(`[data-area="${AREA_A.record}"]`)?.textContent).toContain('Xã A');
    expect(areas.querySelector(`[data-area="${AREA_Y.record}"]`)).toBeNull();
    expect(screen.getByTestId('map-asof').textContent).toBe(word('home.map.asof.text', { date: '2025-06-30' }));
    expect(areas.textContent).toContain(word('home.map.structure.text', { date: '2020-01-01' }));
    expect(asOfReads(h)).toEqual(['2025-06-30']);
  });

  it('places the same project under the area it became after the merge, with the date of that structure (UAT-AC277)', async () => {
    open(world(), { path: '/home/home-05?as_of=2025-08-01' });
    const areas = await screen.findByTestId('map-areas');
    expect(areas.querySelector(`[data-area="${AREA_Y.record}"]`)?.textContent).toContain('Xã Y');
    expect(areas.querySelector(`[data-area="${AREA_A.record}"]`)).toBeNull();
    expect(areas.textContent).toContain(word('home.map.structure.text', { date: '2025-07-01' }));
  });

  it('lists every project without coordinates apart, as a link, and never places one at the centre of a province (UI-HOME-05)', async () => {
    open(world(), { path: '/home/home-05?as_of=2025-08-01' });
    const list = await screen.findByTestId('map-nocoords');
    const link = within(list).getByRole('link', { name: 'P-A-001 · Dự án 1' });
    expect(link.getAttribute('href')).toBe(`/prj/prj-03?id=${uuid('0c01', 1)}`);
    expect(list.textContent).toContain(word('home.map.nocoords.note'));
    expect(screen.getByTestId('map-tiles').textContent).toBe(word('home.map.tiles.note'));
    expect(document.querySelector('[data-testid="map-areas"] a')).toBeTruthy();
  });

  it('opens on today, in Vietnam time, when the address names no date', async () => {
    const h = open(world());
    await screen.findByTestId('map-areas');
    expect(asOfReads(h)).toEqual(['2025-11-03']);
    expect((screen.getByLabelText(word('home.map.date.label')) as HTMLInputElement).value).toBe('2025-11-03');
  });

  it('reads each distinct area once however many projects sit in it', async () => {
    const h = open(world({ lines: [line(1), line(2), line(3)], details: { [uuid('0c01', 1)]: detail(1, AREA_A), [uuid('0c01', 2)]: detail(2, AREA_A), [uuid('0c01', 3)]: detail(3, AREA_Y) } }), {
      path: '/home/home-05?as_of=2025-08-01',
    });
    await screen.findByTestId('map-areas');
    expect(h.read.mock.calls.filter((call) => call[0] === 'getMasterRecordAsOf')).toHaveLength(2);
    expect(h.read.mock.calls.filter((call) => call[0] === 'get_resources_master_record_version_id')).toHaveLength(2);
    const y = document.querySelector(`[data-area="${AREA_Y.record}"]`) as HTMLElement;
    expect(within(y).getAllByRole('row')).toHaveLength(4);
  });

  it('shows a split project in each area with the part that went there', async () => {
    const targets = [
      {
        record_id: AREA_Y.record,
        master_type: 'AREA',
        business_key: 'XA-Y',
        succession_kind: 'SPLIT',
        effective_date: '2025-07-01',
        share_pct: '60.00',
        in_force: true,
        version: version(AREA_Y, '2025-07-01'),
      },
      { record_id: AREA_Z.record, master_type: 'AREA', business_key: 'XA-Z', succession_kind: 'SPLIT', effective_date: '2025-07-01', share_pct: '40.00', in_force: false, version: null },
    ];
    open(world({ readings: (record, date) => (record === AREA_A.record ? reading(AREA_A, date, { state: 'SUCCEEDED', structure_date: '2025-07-01', version: null, targets }) : undefined) }), {
      path: '/home/home-05?as_of=2025-08-01',
    });
    await screen.findByTestId('map-areas');
    expect((document.querySelector(`[data-area="${AREA_Y.record}"]`) as HTMLElement).textContent).toContain(word('home.map.share.value', { share: '60.00' }));
    const z = document.querySelector(`[data-area="${AREA_Z.record}"]`) as HTMLElement;
    expect(z.textContent).toContain('XA-Z');
    expect(z.textContent).toContain(word('home.map.notinforce.note'));
  });

  it('keeps a project whose area is in no structure on the date in a group of its own', async () => {
    open(world({ readings: (record, date) => (record === AREA_A.record ? reading(AREA_A, date, { state: 'NOT_STARTED', version: null, targets: [] }) : undefined) }), {
      path: '/home/home-05?as_of=1999-01-01',
    });
    await screen.findByTestId('map-areas');
    const outside = document.querySelector('[data-area=""]') as HTMLElement;
    expect(outside.textContent).toContain(word('home.map.outside.title'));
    expect(outside.textContent).toContain(word('home.map.outside.note'));
  });

  it('drops a project whose area cannot be tied to an entry rather than placing it wrongly', async () => {
    open(world({ recordOfVersion: Object.fromEntries(AREAS.map((area) => [area.version, null])) }), { path: '/home/home-05?as_of=2025-08-01' });
    await screen.findByText(word('states.empty.title'));
  });

  it('leaves out an entry the API gave no structure for, and puts its projects outside', async () => {
    open(world({ readings: () => ({ nonsense: true }) }), { path: '/home/home-05?as_of=2025-08-01' });
    await screen.findByTestId('map-areas');
    expect(document.querySelector('[data-area=""]')).toBeTruthy();
  });

  it('narrows by status and sector, keeping the choice in the address', async () => {
    open(
      world({
        lines: [line(1), line(2, { status: 'CLOSED' })],
        details: {
          [uuid('0c01', 1)]: detail(1, AREA_A),
          [uuid('0c01', 2)]: detail(2, AREA_A, { status: 'CLOSED', sector: { version_id: uuid('0d01', 2), business_key: 'NONG-NGHIEP', label: 'Nông nghiệp' } }),
        },
      }),
      { path: '/home/home-05?as_of=2025-08-01' },
    );
    await screen.findByTestId('map-areas');
    expect(within(screen.getByTestId('map-nocoords')).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(word('home.map.status.label')), { target: { value: 'CLOSED' } });
    await waitFor(() => expect(within(screen.getByTestId('map-nocoords')).getAllByRole('listitem')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(word('home.map.status.label')), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(word('home.map.sector.label')), { target: { value: 'NONG-NGHIEP' } });
    await waitFor(() => expect(within(screen.getByTestId('map-nocoords')).getAllByRole('listitem')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(word('home.map.status.label')), { target: { value: 'CONCEPT' } });
    expect(screen.getByTestId('map-nomatch').textContent).toBe(word('home.map.nomatch.notice'));
    expect(screen.queryByTestId('map-nocoords')).toBeNull();
    // One button of the filter panel takes both narrowings away and the placing is whole again.
    fireEvent.click(screen.getByRole('button', { name: 'Xóa bộ lọc' }));
    await waitFor(() => expect(within(screen.getByTestId('map-nocoords')).getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Xóa bộ lọc' })).toBeNull();
  });

  it('places the projects on another day when the date is changed, and tells a date that is not one', async () => {
    const h = open(world(), { path: '/home/home-05?as_of=2025-06-30' });
    await screen.findByTestId('map-areas');
    fireEvent.change(screen.getByLabelText(word('home.map.date.label')), { target: { value: '2025-08-01' } });
    await waitFor(() => expect(document.querySelector(`[data-area="${AREA_Y.record}"]`)).toBeTruthy());
    expect(asOfReads(h)).toEqual(['2025-06-30', '2025-08-01']);
    fireEvent.change(screen.getByLabelText(word('home.map.date.label')), { target: { value: '' } });
    await waitFor(() => expect((screen.getByLabelText(word('home.map.date.label')) as HTMLInputElement).value).toBe('2025-11-03'));
    cleanup();
    open(world(), { path: '/home/home-05?as_of=2025-02-30' });
    expect((await screen.findByRole('alert')).textContent).toBe(word('home.map.date.invalid'));
  });

  it('reads no more than the limit of projects and says there are more', async () => {
    const lines = Array.from({ length: MAX_PROJECTS + 1 }, (_, index) => line(index + 1));
    const details = Object.fromEntries(lines.map((row, index) => [row.id as string, detail(index + 1, AREA_Y)]));
    const h = open(world({ lines, details }), { path: '/home/home-05?as_of=2025-08-01' });
    await screen.findByTestId('map-truncated');
    expect(h.read.mock.calls.filter((call) => call[0] === 'get_resources_project_id')).toHaveLength(MAX_PROJECTS);
    expect(screen.getByTestId('map-truncated').textContent).toBe(word('home.map.truncated.notice'));
  });

  it('shows the empty state for a register without projects', async () => {
    open(world({ lines: [], details: {} }));
    await screen.findByText(word('states.empty.title'));
    const date = screen.getByLabelText(word('home.map.date.label')) as HTMLInputElement;
    fireEvent.change(date, { target: { value: '2025-08-01' } });
    expect((screen.getByLabelText(word('home.map.date.label')) as HTMLInputElement).value).toBe('2025-08-01');
    expect(screen.getByLabelText(word('home.map.status.label'))).toBeTruthy();
  });

  it('shows the denied state and reads nothing when a permission the placing needs is missing', () => {
    const h = open(world(), { permissions: ['home.read', 'project.read'] });
    expect(screen.getByTestId('map-denied')).toBeTruthy();
    expect(screen.getByText(word('states.denied.title'))).toBeTruthy();
    expect(h.client.readAll).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('reads when the permissions are not known; a failure is the error state and a refusal of the API the denied state', async () => {
    const h = open(world({ failing: 'getMasterRecordAsOf' }), { permissions: undefined });
    await screen.findByText(word('states.error.title'));
    expect(h.client.readAll).toHaveBeenCalled();
    cleanup();
    const refused = harness(() => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c-1' }));
    (refused.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c-1' })));
    mountInSession(<MapScreen route={ROUTE} />, refused, { permissions: undefined }, '/home/home-05');
    await screen.findByText(word('states.denied.title'));
  });

  it('shows the offline state when the network fails', async () => {
    open(world({ failing: 'getMasterRecordAsOf', networkDown: true }));
    await screen.findByText(word('states.offline.title'));
  });

  it('shows the error state when a read fails, and reads again on retry', async () => {
    const state = world({ failing: 'get_resources_project_id' });
    const h = open(state);
    await screen.findByText(word('states.error.title'));
    state.failing = undefined;
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('map-areas');
    expect(h.read.mock.calls.filter((call) => call[0] === 'get_resources_project_id')).toHaveLength(2);
  });

  it('shows the loading state while the projects are read', () => {
    const h = harness(() => new Error('x'));
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mountInSession(<MapScreen route={{ ...ROUTE, req: null }} />, h, { permissions: ALL }, '/home/home-05');
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });
});
