import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { FIRST_TENANT, SECOND_TENANT, mountInSession } from '../adm/security/test-support';
import CatalogScreen from './CatalogScreen';
import { MANAGER, READER, client, dataset, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('DGV-04', 'FR-DGV-04');

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-dataset-id]'));
const codes = (): string[] => rows().map((row) => row.getAttribute('data-dataset-code') ?? '');
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));

const DATASETS = [
  dataset(1, { dataset_code: 'DS-DISB', title: 'Disbursement', domain: 'TREASURY', classification: 'INTERNAL', contract_revision: 3, quality_badge: 'PASSED', status: 'ACTIVE' }),
  dataset(2, { dataset_code: 'DS-LAND', title: 'Land parcels', domain: 'LAND', classification: 'PERSONAL', grain: 'one row per parcel', quality_badge: 'STALE', freshness_slo_seconds: 7_200 }),
  dataset(3, { dataset_code: 'DS-AI-USAGE', title: 'AI usage', domain: 'AI', classification: 'PUBLIC', owner_name: null, steward_name: null }),
];

describe('CatalogScreen (DGV-04): the data catalogue (UI-DGV-04)', () => {
  it('lists each dataset with its grain, source, classification, freshness, contract, people and badge', async () => {
    mount(<CatalogScreen route={ROUTE} />, client(world({ datasets: DATASETS })), READER, '/dgv/dgv-04');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['dgv.catalog.page.title']);
    expect(codes()).toEqual(['DS-DISB', 'DS-LAND', 'DS-AI-USAGE']);
    const cells = (code: string) => Array.from(document.querySelectorAll(`tr[data-dataset-code="${code}"] td`)).map((cell) => cell.textContent);
    expect(cells('DS-DISB')).toEqual([
      'DisbursementDS-DISB',
      'one row per payment order',
      'PAY',
      vi_['dgv.classification.internal.text'],
      '1 ngày',
      vi_['dgv.catalog.contract.revision'].replace('{revision}', '3'),
      'Nguyen Van An / Tran Thi Binh',
      vi_['dgv.badge.passed.text'],
    ]);
    expect(cells('DS-LAND').slice(3, 8)).toEqual([vi_['dgv.classification.personal.text'], '2 giờ', vi_['dgv.catalog.contract.none'], 'Nguyen Van An / Tran Thi Binh', vi_['dgv.badge.stale.text']]);
    expect(cells('DS-AI-USAGE')[6]).toBe(`${vi_['dgv.catalog.person.unknown']} / ${vi_['dgv.catalog.person.unknown']}`);
    expect(screen.getByTestId('count').textContent).toBe(vi_['dgv.catalog.count.text'].replace('{count}', '3'));
    expect(screen.getByRole('table', { name: vi_['dgv.catalog.table.aria'] })).toBeTruthy();
  });

  it('marks the entry a link from another screen names (BI-07), and no other', async () => {
    mount(<CatalogScreen route={ROUTE} />, client(world({ datasets: DATASETS })), READER, `/dgv/dgv-04?dataset=${DATASETS[1]?.id as string}`);
    await ready();
    const current = rows().filter((row) => row.getAttribute('aria-current') === 'true');
    expect(current.map((row) => row.getAttribute('data-dataset-code'))).toEqual(['DS-LAND']);
    cleanup();
    mount(<CatalogScreen route={ROUTE} />, client(world({ datasets: DATASETS })), READER, '/dgv/dgv-04?dataset=00000000-0000-4000-8000-0000000000ee');
    await ready();
    expect(rows().filter((row) => row.hasAttribute('aria-current'))).toEqual([]);
  });

  it('shows a dataset that was never assessed with the neutral badge "not assessed", not as passed or failed', async () => {
    mount(<CatalogScreen route={ROUTE} />, client(world({ datasets: [dataset(1)] })), READER, '/dgv/dgv-04');
    await ready();
    const pill = document.querySelector('[data-badge]') as HTMLElement;
    expect([pill.getAttribute('data-badge'), pill.textContent, pill.className]).toEqual(['NOT_ASSESSED', vi_['dgv.badge.notAssessed.text'], 'pill gray']);
  });

  it('shows no result and a zero count when nothing is visible, without telling that something is hidden (AC-ST-DGV-001-2)', async () => {
    mount(<CatalogScreen route={ROUTE} />, client(world({ datasets: [] })), READER, '/dgv/dgv-04');
    expect((await screen.findByTestId('empty-catalog')).textContent).toBe(vi_['dgv.catalog.empty.text']);
    expect(rows()).toEqual([]);
    expect(screen.getByTestId('count').textContent).toBe(vi_['dgv.catalog.count.text'].replace('{count}', '0'));
    expect(screen.getByText(vi_['dgv.catalog.visibility.note'])).toBeTruthy();
  });

  it('searches on the server with the text, the domain and the classification, and clears the filters', async () => {
    const h = client(world({ datasets: DATASETS }));
    mount(<CatalogScreen route={ROUTE} />, h, READER, '/dgv/dgv-04');
    await ready();
    const user = userEvent.setup();
    const readAll = (h.client as unknown as { readAll: ReturnType<typeof vi.fn> }).readAll;
    fireEvent.change(screen.getByLabelText(vi_['dgv.catalog.filter.text.label']), { target: { value: ' land ' } });
    fireEvent.change(screen.getByLabelText(vi_['dgv.catalog.filter.domain.label']), { target: { value: 'LAND' } });
    fireEvent.change(screen.getByLabelText(vi_['dgv.catalog.filter.classification.label']), { target: { value: 'PERSONAL' } });
    await user.click(screen.getByRole('button', { name: vi_['dgv.catalog.filter.apply.action'] }));
    await waitFor(() => expect(codes()).toEqual(['DS-LAND']));
    expect(readAll).toHaveBeenLastCalledWith('searchCatalog', { query: { q: 'land', domain: 'LAND', classification: 'PERSONAL' } });

    fireEvent.change(screen.getByLabelText(vi_['dgv.catalog.filter.text.label']), { target: { value: 'nothing at all' } });
    await user.click(screen.getByRole('button', { name: vi_['dgv.catalog.filter.apply.action'] }));
    expect((await screen.findByTestId('empty-catalog')).textContent).toBe(vi_['dgv.catalog.noMatch.text']);

    await user.click(screen.getByRole('button', { name: vi_['dgv.catalog.filter.clear.action'] }));
    await waitFor(() => expect(codes().length).toBe(3));
    expect((screen.getByLabelText(vi_['dgv.catalog.filter.text.label']) as HTMLInputElement).value).toBe('');
    expect(readAll).toHaveBeenLastCalledWith('searchCatalog', { query: {} });
  });

  it('links to the registration screen only for a person who manages the catalogue', async () => {
    mount(<CatalogScreen route={ROUTE} />, client(world({ datasets: DATASETS })), MANAGER, '/dgv/dgv-04');
    await ready();
    expect(screen.getByRole('link', { name: vi_['dgv.catalog.manage.link'] }).getAttribute('href')).toBe('/dgv/dgv-03');
    cleanup();
    mount(<CatalogScreen route={ROUTE} />, client(world({ datasets: DATASETS })), READER, '/dgv/dgv-04');
    await ready();
    expect(screen.queryByRole('link', { name: vi_['dgv.catalog.manage.link'] })).toBeNull();
  });

  it('says that the catalogue could not be read, with a retry', async () => {
    const state = world({ datasets: DATASETS, failing: new Set(['searchCatalog']) });
    mount(<CatalogScreen route={ROUTE} />, client(state), READER, '/dgv/dgv-04');
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(codes().length).toBe(3);
  });

  it('shows the standard card of a refusal when the person has no right to the catalogue', async () => {
    const h = client(world());
    (h.client as unknown as { readAll: () => Promise<never> }).readAll = () => Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} }));
    mount(<CatalogScreen route={ROUTE} />, h, READER, '/dgv/dgv-04');
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['states.denied.title']);
  });

  it('shows the loading state while the catalogue is read', () => {
    mount(<CatalogScreen route={ROUTE} />, client(world({ datasets: DATASETS })), READER, '/dgv/dgv-04');
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('starts over when the person switches tenant: the filter of the first tenant does not follow', async () => {
    const h = client(world({ datasets: DATASETS }));
    const view = mountInSession(<CatalogScreen route={ROUTE} />, h, { permissions: READER });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['dgv.catalog.filter.text.label']), { target: { value: 'land' } });
    expect(FIRST_TENANT.id).not.toBe(SECOND_TENANT.id);
    view.rerenderWith({ permissions: READER, tenant: SECOND_TENANT });
    await ready();
    expect((screen.getByLabelText(vi_['dgv.catalog.filter.text.label']) as HTMLInputElement).value).toBe('');
    expect(within(screen.getByRole('search')).getByRole('button', { name: vi_['dgv.catalog.filter.apply.action'] })).toBeTruthy();
  });

  it('tells the screen it belongs to in a footer', async () => {
    mount(<CatalogScreen route={ROUTE} />, client(world({ datasets: DATASETS })), READER, '/dgv/dgv-04');
    await ready();
    expect(document.querySelector('[data-screen-id="DGV-04"]')).not.toBeNull();
    expect(screen.getByText(vi_['dgv.catalog.footer.reference'].replace('{id}', 'DGV-04').replace('{req}', 'FR-DGV-04'))).toBeTruthy();
  });
});
