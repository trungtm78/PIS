import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import OutgoingListScreen from './OutgoingListScreen';
import { SECOND_TENANT, TENANT, harness, mount, mountInSession, routeOf } from './test-support';

const ROUTE = routeOf('DOC-03', 'FR-DOC-03');
const READ = 'doc.outgoing.read';
const CREATE = 'doc.outgoing.create';
const EDIT = 'doc.outgoing.edit';
const REVIEW = 'doc.outgoing.review';
const ALL = [READ, CREATE, EDIT, REVIEW];

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`,
  document_id: `00000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`,
  title: `Decision ${n}`,
  doc_type_code: 'QD',
  status: 'DRAFT',
  effect_status: 'PENDING',
  urgency: 'NORMAL',
  drafting_unit_id: '00000000-0000-4000-8000-000000000f01',
  drafter_user_id: '00000000-0000-4000-8000-0000000000a1',
  signer_user_id: '00000000-0000-4000-8000-0000000000b2',
  signing_mode: 'DIRECT',
  document_number: null,
  symbol: null,
  issued_on: null,
  source_module: null,
  created_at: '2026-10-23T03:00:00.000Z',
  version: 1,
  ...overrides,
});

const ROWS = [
  row(1),
  row(2, { status: 'IN_REVIEW', version: 2 }),
  row(3, { status: 'SUBMITTED', version: 3 }),
  row(4, { status: 'SIGNED', version: 4 }),
  row(5, { status: 'ISSUED', effect_status: 'EFFECTIVE', symbol: '05/QD-UBND', document_number: 5, issued_on: '2026-10-23', source_module: 'MNE', version: 8 }),
  row(6, { status: 'RECALLED', effect_status: 'RECALLED', symbol: '06/QD-UBND', document_number: 6, issued_on: '2026-10-20', version: 10 }),
  row(7, { status: 'CANCELLED', effect_status: 'EXPIRED', version: 4 }),
];

function answer(operation: string): unknown {
  if (operation === 'listOutgoingDocuments') return { items: ROWS, next_cursor: null };
  return new Error('unexpected read');
}

const rowOf = (title: string): HTMLElement => screen.getByText(title).closest('tr') as HTMLElement;

afterEach(cleanup);

describe('OutgoingListScreen (DOC-03)', () => {
  it('lists the documents with the number, the status in words and a mark, the effect and the source', async () => {
    const h = harness(answer);
    mount(<OutgoingListScreen route={ROUTE} />, h, ALL);
    expect(await screen.findByText('Decision 1')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.list.page.title']);
    expect(h.read).toHaveBeenCalledWith('listOutgoingDocuments', { query: { limit: 50 } });

    const draft = rowOf('Decision 1');
    expect(within(draft).getByText(vi_['doc.list.number.pending'])).toBeTruthy();
    expect(within(draft).getByText(vi_['doc.draft.status.draft'])).toBeTruthy();
    const issued = rowOf('Decision 5');
    expect(within(issued).getByText('05/QD-UBND')).toBeTruthy();
    expect(within(issued).getByText(vi_['doc.draft.status.issued'])).toBeTruthy();
    expect(within(issued).getByText(vi_['doc.draft.effect.effective'])).toBeTruthy();
    expect(within(issued).getByText('MNE')).toBeTruthy();
    expect(within(issued).getByText('2026-10-23')).toBeTruthy();
    // A recalled document says so in words, not by colour alone.
    expect(within(rowOf('Decision 6')).getAllByText(vi_['doc.draft.effect.recalled']).length).toBeGreaterThan(0);
    expect(within(rowOf('Decision 7')).getByText(vi_['doc.draft.effect.expired'])).toBeTruthy();
    expect(screen.getByText(fill(vi_['doc.list.count.text'], { count: 7 }))).toBeTruthy();
  });

  it('sends the work on to the screen of its state when the caller may do it, and shows the document otherwise', async () => {
    mount(<OutgoingListScreen route={ROUTE} />, harness(answer), ALL);
    await screen.findByText('Decision 1');
    const link = (title: string): HTMLAnchorElement => within(rowOf(title)).getByRole('link') as HTMLAnchorElement;
    expect(link('Decision 1').getAttribute('href')).toBe('/doc/doc-02?doc=00000000-0000-4000-8000-000000000201');
    expect(link('Decision 1').textContent).toBe(vi_['doc.list.open.edit']);
    expect(link('Decision 2').getAttribute('href')).toBe('/doc/doc-04?doc=00000000-0000-4000-8000-000000000202');
    expect(link('Decision 2').textContent).toBe(vi_['doc.list.open.review']);
    expect(link('Decision 3').getAttribute('href')).toContain('/doc/doc-05?doc=');
    expect(link('Decision 4').getAttribute('href')).toContain('/doc/doc-06?doc=');
    expect(link('Decision 5').getAttribute('href')).toContain('/doc/doc-02?doc=');
    expect(link('Decision 5').textContent).toBe(vi_['doc.list.open.view']);
    cleanup();
    mount(<OutgoingListScreen route={ROUTE} />, harness(answer), [READ]);
    await screen.findByText('Decision 1');
    expect(within(rowOf('Decision 1')).getByRole('link').textContent).toBe(vi_['doc.list.open.view']);
    expect(within(rowOf('Decision 2')).getByRole('link').textContent).toBe(vi_['doc.list.open.view']);
  });

  it('offers the composing of a new document only to the holder of the permission', async () => {
    mount(<OutgoingListScreen route={ROUTE} />, harness(answer), ALL);
    await screen.findByText('Decision 1');
    expect((screen.getByRole('link', { name: vi_['doc.list.create.action'] }) as HTMLAnchorElement).getAttribute('href')).toBe('/doc/doc-02');
    cleanup();
    mount(<OutgoingListScreen route={ROUTE} />, harness(answer), [READ]);
    await screen.findByText('Decision 1');
    expect(screen.queryByRole('link', { name: vi_['doc.list.create.action'] })).toBeNull();
    cleanup();
    // Grants that are not known yet leave the decision to the server.
    mountInSession(<OutgoingListScreen route={ROUTE} />, harness(answer), { permissions: undefined });
    await screen.findByText('Decision 1');
    expect(screen.getByRole('link', { name: vi_['doc.list.create.action'] })).toBeTruthy();
  });

  it('asks the server for the status, the document type and the year of the filter', async () => {
    const h = harness(answer);
    mount(<OutgoingListScreen route={ROUTE} />, h, ALL);
    await screen.findByText('Decision 1');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['doc.list.status.label']), 'IN_REVIEW');
    await user.type(screen.getByLabelText(vi_['doc.list.type.label']), ' QD ');
    await user.selectOptions(screen.getByLabelText(vi_['doc.list.year.label']), String(new Date().getFullYear()));
    await user.click(screen.getByRole('button', { name: vi_['doc.list.filter.action'] }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listOutgoingDocuments', { query: { limit: 50, status: 'IN_REVIEW', doc_type_code: 'QD', year: String(new Date().getFullYear()) } }));
  });

  it('loads the next page on request', async () => {
    const h = harness((operation, input) => {
      if (operation !== 'listOutgoingDocuments') return answer(operation);
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === undefined ? { items: [ROWS[0]], next_cursor: 'p2' } : { items: [ROWS[4]], next_cursor: null };
    });
    mount(<OutgoingListScreen route={ROUTE} />, h, ALL);
    await screen.findByText('Decision 1');
    expect(screen.queryByText('Decision 5')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['doc.list.more.action'] }));
    expect(await screen.findByText('Decision 5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['doc.list.more.action'] })).toBeNull();
    expect(h.read).toHaveBeenLastCalledWith('listOutgoingDocuments', { query: { limit: 50, cursor: 'p2' } });
  });

  it('says that the tenant is suspended and offers nothing to change', async () => {
    mountInSession(<OutgoingListScreen route={ROUTE} />, harness(answer), { permissions: ALL, mode: 'READ_ONLY' });
    await screen.findByText('Decision 1');
    expect(screen.getByText(vi_['doc.list.frozen.notice'])).toBeTruthy();
    expect(screen.queryByRole('link', { name: vi_['doc.list.create.action'] })).toBeNull();
    expect(within(rowOf('Decision 1')).getByRole('link').textContent).toBe(vi_['doc.list.open.view']);
  });

  it('starts over when the tenant changes: the filter of the first tenant never reaches the second', async () => {
    const h = harness(answer);
    const view = mountInSession(<OutgoingListScreen route={ROUTE} />, h, { permissions: ALL, tenant: TENANT });
    await screen.findByText('Decision 1');
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['doc.list.status.label']), 'DRAFT');
    view.rerenderWith({ permissions: ALL, tenant: SECOND_TENANT });
    await waitFor(() => expect((screen.getByLabelText(vi_['doc.list.status.label']) as HTMLSelectElement).value).toBe(''));
  });

  describe('UI-DOC-03: the standard states', () => {
    it.each([
      ['empty', { items: [], next_cursor: null }, vi_['states.empty.title']],
      ['denied', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
      ['signed out', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
    ])('UI-DOC-03: shows the %s state', async (_name, reply, title) => {
      mount(<OutgoingListScreen route={ROUTE} />, harness((operation) => (operation === 'listOutgoingDocuments' ? reply : new Error('unexpected read'))), ALL);
      expect(await screen.findByText(title)).toBeTruthy();
      // The filters stay, so a filter that finds nothing can still be changed.
      expect(screen.getByLabelText(vi_['doc.list.status.label'])).toBeTruthy();
    });

    it('UI-DOC-03: shows the loading state first and names the page for assistive technology', async () => {
      mount(<OutgoingListScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), ALL);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['doc.list.page.title'] })).toBeTruthy();
    });

    it('UI-DOC-03: gives every field, column and action of the loaded screen an accessible name', async () => {
      mount(<OutgoingListScreen route={ROUTE} />, harness(answer), ALL);
      await screen.findByText('Decision 1');
      for (const control of [screen.getByRole('searchbox'), ...screen.getAllByRole('combobox')]) expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
      for (const action of screen.getAllByRole('button')) expect((action.getAttribute('aria-label') ?? action.textContent ?? '').trim().length).toBeGreaterThan(0);
      for (const link of within(rowOf('Decision 1')).getAllByRole('link')) expect((link.getAttribute('aria-label') ?? link.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(screen.getAllByRole('columnheader').length).toBeGreaterThanOrEqual(8);
    });

    it('UI-DOC-03: retries the list after an error', async () => {
      let failing = true;
      const h = harness((operation) => {
        if (operation !== 'listOutgoingDocuments') return new Error('unexpected read');
        return failing ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : { items: ROWS, next_cursor: null };
      });
      mount(<OutgoingListScreen route={ROUTE} />, h, ALL);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByText('Decision 1')).toBeTruthy();
    });
  });
});
