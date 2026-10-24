import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { routeOf } from '../doc/test-support';
import { catalogueRoute, entryRoute, groupsOf, mayOpenCatalogues, nameOf, validityOf, versionOf } from './catalogues/model';
import { toRecord } from '../mdm/model';
import type { RecordView } from '../mdm/model';
import SharedCatalogueScreen from './SharedCatalogueScreen';
import { harness, mountInSession } from './security/test-support';

const ROUTE = routeOf('ADM-05', 'FR-ADM-05');
const READER = ['master.read'];

const raw = (id: string, masterType: string, key: string, overrides: Record<string, unknown> = {}) => ({
  id,
  namespace: 'TENANT',
  master_type: masterType,
  business_key: key,
  status: 'EFFECTIVE',
  label: `Label ${key}`,
  valid_from: '2026-01-01',
  valid_until: null,
  version_id: `v-${id}`,
  open_change_request_id: null,
  version: 2,
  revision: 3,
  parent_record_id: null,
  legal_basis: null,
  attributes: {},
  ...overrides,
});
const RECORDS = [
  raw('r1', 'DOCUMENT_TYPE', 'QD', { label: 'Quyết định' }),
  raw('r2', 'DOCUMENT_TYPE', 'CV', { label: 'Công văn', status: 'RETIRED', valid_until: '2026-06-30' }),
  raw('r3', 'FUND_SOURCE', 'NSTW', { label: 'Ngân sách trung ương', namespace: 'PLATFORM', alias_label: 'Vốn TW', revision: null }),
  raw('r4', 'ZZ_NO_SCREEN', 'P1', { label: 'Khẩn cấp' }),
];

afterEach(cleanup);

const mount = (records: unknown[] = RECORDS, permissions: readonly string[] | undefined = READER, failure?: Error) => {
  const h = harness(() => new Error('no read'));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    expect(operation).toBe('searchMasterRecords');
    return failure === undefined ? Promise.resolve(records) : Promise.reject(failure);
  });
  mountInSession(<SharedCatalogueScreen route={ROUTE} />, h, { permissions });
  return h;
};
const ready = () => waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
const bodyRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tbody tr'));

describe('SharedCatalogueScreen (ADM-05): the shared catalogues, linked to master data by permission', () => {
  it('lists the entries with type, code, name, validity, namespace and version, and writes nothing (AC-ST-ADM-019-1)', async () => {
    mount();
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.catalogues.page.title']);
    expect(bodyRows()).toHaveLength(4);
    const first = bodyRows()[0] as HTMLElement;
    expect(first.querySelectorAll('td')[0]?.textContent).toBe('DOCUMENT_TYPE');
    expect(first.querySelectorAll('td')[1]?.textContent).toBe('QD');
    expect(first.querySelectorAll('td')[2]?.textContent).toContain('Quyết định');
    expect(first.querySelectorAll('td')[3]?.textContent).toBe('2026-01-01 → ');
    expect(first.querySelectorAll('td')[4]?.textContent).toBe(vi_['adm.catalogues.namespace.tenant.label']);
    expect(first.querySelectorAll('td')[5]?.textContent).toBe('v3');
    // The alias the tenant set is the name it sees; the namespace of the platform and an entry without a revision are shown as they are.
    const platform = document.querySelector('[data-record-id="r3"]') as HTMLElement;
    expect(platform.textContent).toContain('Vốn TW');
    expect(platform.querySelector('[data-namespace="PLATFORM"]')?.textContent).toBe(vi_['adm.catalogues.namespace.platform.label']);
    expect(platform.querySelectorAll('td')[5]?.textContent).toBe('');
    expect(document.querySelectorAll('button[type="submit"], form')).toHaveLength(0);
  });

  it('links each catalogue to its master data screen, the types without a screen to the hub, and each entry to its detail', async () => {
    mount();
    await ready();
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-type-card]'));
    expect(cards.map((card) => card.getAttribute('data-type-card'))).toEqual(['DOCUMENT_TYPE', 'FUND_SOURCE', 'ZZ_NO_SCREEN']);
    expect(within(cards[0] as HTMLElement).getByTestId('open-catalogue').getAttribute('href')).toBe('/mdm/mdm-13');
    expect(within(cards[0] as HTMLElement).getByText('2 mục, 1 đang hiệu lực')).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByTestId('open-catalogue').getAttribute('href')).toBe('/mdm/mdm-04');
    expect(within(cards[2] as HTMLElement).getByTestId('open-catalogue').getAttribute('href')).toBe('/mdm/mdm-01?type=ZZ_NO_SCREEN');
    expect(screen.getByTestId('hub-link').getAttribute('href')).toBe('/mdm/mdm-01');
    const detail = within(document.querySelector('[data-record-id="r3"]') as HTMLElement).getByTestId('open-entry').getAttribute('href') as string;
    expect(detail).toBe('/mdm/mdm-27?type=FUND_SOURCE&key=NSTW&ns=PLATFORM');
  });

  it('narrows the table to one type', async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['adm.catalogues.type.label']), { target: { value: 'DOCUMENT_TYPE' } });
    expect(bodyRows().map((row) => row.getAttribute('data-record-id'))).toEqual(['r1', 'r2']);
    fireEvent.change(screen.getByLabelText(vi_['adm.catalogues.type.label']), { target: { value: '' } });
    expect(bodyRows()).toHaveLength(4);
  });

  it('is denied, and asks the API for nothing, to those who may not read master data', async () => {
    const h = mount(RECORDS, ['adm.integration.read']);
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    expect(screen.queryByRole('table')).toBeNull();
    expect(h.client.readAll).not.toHaveBeenCalled();
  });

  it('shows the empty state for a tenant without entries and the denied or error state when the read fails', async () => {
    mount([]);
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
    cleanup();
    mount(RECORDS, READER, new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }));
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    cleanup();
    mount(RECORDS, READER, new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c', extensions: {} }));
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });
});

describe('the model of the catalogue hub', () => {
  const record = (overrides: Record<string, unknown> = {}): RecordView => toRecord(raw('x', 'PRIORITY', 'P1', overrides)) as RecordView;

  it('points a type to the screen that holds it, or to the hub filtered on it', () => {
    expect(catalogueRoute('DOCUMENT_TYPE')).toBe('/mdm/mdm-13');
    expect(catalogueRoute('PRIORITY')).toBe('/mdm/mdm-18');
    expect(catalogueRoute('ZZ_NO_SCREEN')).toBe('/mdm/mdm-01?type=ZZ_NO_SCREEN');
    expect(catalogueRoute('A B&C')).toBe('/mdm/mdm-01?type=A%20B%26C');
    expect(entryRoute(record())).toBe('/mdm/mdm-27?type=PRIORITY&key=P1');
  });

  it('counts the entries and those in force, by type', () => {
    const records = RECORDS.map((item) => toRecord(item) as RecordView);
    expect(groupsOf(records)).toEqual([
      { masterType: 'DOCUMENT_TYPE', total: 2, inForce: 1 },
      { masterType: 'FUND_SOURCE', total: 1, inForce: 1 },
      { masterType: 'ZZ_NO_SCREEN', total: 1, inForce: 1 },
    ]);
    expect(groupsOf([])).toEqual([]);
  });

  it('shows the alias, else the label, else nothing; the validity and the version as the catalogues write them', () => {
    expect(nameOf(record({ alias_label: 'Alias' }))).toBe('Alias');
    expect(nameOf(record())).toBe('Label P1');
    expect(nameOf(record({ label: null }))).toBe('');
    expect(validityOf(record({ valid_until: '2027-12-31' }))).toBe('2026-01-01 → 2027-12-31');
    expect(validityOf(record({ valid_from: null }))).toBe('');
    expect(versionOf(record())).toBe('v3');
    expect(versionOf(record({ revision: null }))).toBe('');
  });

  it('opens the master data routes with the permission to read it, and with a session that lists none', () => {
    expect(mayOpenCatalogues(['master.read'])).toBe(true);
    expect(mayOpenCatalogues(undefined)).toBe(true);
    expect(mayOpenCatalogues(['master.propose'])).toBe(false);
  });
});
