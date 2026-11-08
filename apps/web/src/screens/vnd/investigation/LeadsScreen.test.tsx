import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import LeadsScreen from './LeadsScreen';
import { AUDITOR, CONTRACTOR, LEAD_READER, client, investigationFigures, leadLine, leadPage, mount, routeOf, uuid } from './test/investigation-fixtures';
import type { World } from './test/investigation-fixtures';
import { problem, text, word } from './test/helpers';

const route = routeOf('VND-13', 'FR-VND-13');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  failing?: World['failing'];
  figures?: unknown;
}

function open(items: Array<Record<string, unknown>> = [leadLine(1), leadLine(2, { kind: 'COVER_BID', rank: 62, status: 'IN_REVIEW', reviewer_name: 'Lê Thị Hoa', reopened_count: 2 })], options: Options = {}, page: Record<string, unknown> = {}) {
  const world: World = { answers: { listVendorLeads: leadPage(items, page), getVendorInvestigationFigures: options.figures ?? investigationFigures() }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<LeadsScreen route={route} />, h, { permissions: options.permissions ?? AUDITOR, path: '/vnd/vnd-13', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-lead-id]'));
const loaded = async (): Promise<void> => {
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
};

describe('LeadsScreen (VND-13): the leads of the investigation', () => {
  it('lists the leads ranked, with the kind, the contractors linked to their profile, the packages, the status and the reviewer', async () => {
    open();
    await loaded();
    const [first, second] = rows();
    expect(within(first as HTMLElement).getByTestId(`rank-${uuid('0100', 1)}`).textContent).toBe('85');
    expect(first?.textContent).toContain(word('vnd3.leadKind.linkCluster.name'));
    expect(first?.textContent).toContain(text('vnd3.leads.evidence.text', { count: 2 }));
    expect(within(first as HTMLElement).getByRole('link', { name: word('vnd3.leadKind.linkCluster.name') }).getAttribute('href')).toBe(`/vnd/vnd-14?lead=${uuid('0100', 1)}`);
    expect(within(first as HTMLElement).getByRole('link', { name: 'Công ty nhà thầu 1' }).getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${CONTRACTOR}`);
    expect(first?.textContent).toContain('GT-2026-01');
    expect(first?.textContent).toContain(word('vnd3.leadStatus.new.name'));
    expect(second?.textContent).toContain(word('vnd3.leadKind.coverBid.name'));
    expect(second?.textContent).toContain(word('vnd3.leadStatus.inReview.name'));
    expect(second?.textContent).toContain('Lê Thị Hoa');
    expect(second?.textContent).toContain(text('vnd3.leads.reopened.text', { count: 2 }));
  });

  it('says in words, on the page, that a lead is a signal for review and not a conclusion', async () => {
    open();
    await loaded();
    expect(screen.getByTestId('signal-notice').textContent).toBe(word('vnd3.leads.notice.text'));
  });

  it('counts the leads by status and gives the rule with its "i" and the flag that it is not verified', async () => {
    open();
    await loaded();
    expect(screen.getByTestId('count-NEW').textContent).toBe('2');
    expect(screen.getByTestId('count-IN_REVIEW').textContent).toBe('1');
    expect(screen.getByTestId('count-DISMISSED').textContent).toBe('3');
    expect(screen.getByTestId('count-REFERRED').textContent).toBe('0');
    const counts = screen.getByTestId('lead-counts');
    fireEvent.click(within(counts).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd3.leads.rule.name') }) }));
    expect(screen.getByText('Formula of VENDOR_INVESTIGATION')).toBeTruthy();
  });

  it('shows the strip of figures with the "i" of each: open leads, precision, the traces recorded, the last scan', async () => {
    open();
    await loaded();
    await screen.findByTestId('figure-open');
    expect(screen.getByTestId('figure-open').textContent).toContain(text('vnd3.leads.figure.open.sub', { new: 2 }));
    expect(screen.getByTestId('figure-precision').textContent).toContain(text('vnd3.leads.figure.precision.sub', { right: 2, decided: 4 }));
    expect(screen.getByTestId('figure-trace').textContent).toContain(text('vnd3.leads.figure.trace.sub', { origin: 5, files: 8, bids: 20 }));
    expect(screen.getByTestId('figure-scan').textContent).toContain(text('vnd3.leads.figure.scan.sub', { links: 6, clusters: 2, fresh: 1 }));
    // The definition of an indicator comes from the register when the answer carries it.
    fireEvent.click(within(screen.getByTestId('figure-open')).getByRole('button'));
    expect(screen.getByText('Formula VENDOR_LEADS_OPEN')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('figure-trace')).getByRole('button'));
    expect(screen.getByText(word('vnd3.leads.figure.trace.formula'))).toBeTruthy();
  });

  it('says "never scanned" and that no leads is not no signals, and shows no precision before a decision', async () => {
    open([], { figures: investigationFigures({ last_scan: { id: null, finished_at: null, parties: 0, links: 0, clusters: 0, packages: 0, leads_new: 0 }, leads: { open: 0, new: 0, confirmed: 0, referred: 0, dismissed: 0, precision_pct: null }, trace: { bids: 0, with_origin: 0, with_files: 0 } }) });
    await screen.findByTestId('figure-scan');
    expect(screen.getByTestId('figure-scan').textContent).toContain(word('vnd3.leads.figure.scan.neverSub'));
    expect(screen.getByText(word('vnd3.leads.figure.scan.never'))).toBeTruthy();
    expect(screen.getByTestId('figure-precision')).toBeTruthy();
    expect(screen.getAllByText('–').length).toBeGreaterThan(0);
  });

  it('starts a scan with the right and says what it did; refuses to offer it without the right or in a read-only workspace', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(screen.getByTestId('run-scan'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('runVendorLinkScan', { body: {}, attempt: { key: expect.any(String) } }));
    expect((await screen.findByTestId('receipt')).textContent).toContain('Đã quét lúc');
    cleanup();
    open(undefined, { permissions: LEAD_READER });
    await loaded();
    expect(screen.queryByTestId('run-scan')).toBeNull();
    cleanup();
    open(undefined, { mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByTestId('run-scan')).toBeNull();
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
  });

  it('says a refused scan in place', async () => {
    open(undefined, { command: () => Promise.reject(problem(403, 'SCOPE_DENIED')) });
    await loaded();
    fireEvent.click(screen.getByTestId('run-scan'));
    expect((await screen.findByTestId('scan-error')).textContent).toBe(word('vnd.error.forbidden.text'));
  });

  it('filters by status and kind and asks the server with them; a contractor id that is not an id is not sent', async () => {
    const { h } = open();
    await loaded();
    fireEvent.change(screen.getByLabelText(word('vnd3.leads.filter.status.label')), { target: { value: 'IN_REVIEW' } });
    fireEvent.change(screen.getByLabelText(word('vnd3.leads.filter.kind.label')), { target: { value: 'COVER_BID' } });
    fireEvent.click(screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorLeads', { query: { status: 'IN_REVIEW', kind: 'COVER_BID', limit: 25 } }));
    fireEvent.change(screen.getByLabelText(word('vnd3.leads.filter.contractor.label')), { target: { value: 'not-an-id' } });
    expect((screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(word('vnd3.leads.filter.contractor.label')), { target: { value: CONTRACTOR } });
    fireEvent.click(screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorLeads', { query: { status: 'IN_REVIEW', kind: 'COVER_BID', contractor_id: CONTRACTOR, limit: 25 } }));
  });

  it('goes to the next page by the cursor the server gave', async () => {
    const { h } = open([leadLine(1)], {}, { next_cursor: 'next-1' });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: word('vnd.pager.next.action') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorLeads', { query: { cursor: 'next-1', limit: 25 } }));
  });

  describe('states', () => {
    it('EMPTY: says there is no lead, and when a filter found nothing offers to clear it', async () => {
      open([]);
      expect(await screen.findByText(word('ui.dataTable.emptyNone'))).toBeTruthy();
      cleanup();
      const { h } = open([]);
      await screen.findByText(word('ui.dataTable.emptyNone'));
      fireEvent.change(screen.getByLabelText(word('vnd3.leads.filter.status.label')), { target: { value: 'DISMISSED' } });
      fireEvent.click(screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }));
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorLeads', { query: { status: 'DISMISSED', limit: 25 } }));
    });

    it('LOADING, then ERROR with a retry', async () => {
      const pending = client({ answers: {} });
      pending.read.mockImplementation(() => new Promise(() => undefined));
      mount(<LeadsScreen route={route} />, pending, { permissions: AUDITOR, path: '/vnd/vnd-13' });
      expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
      cleanup();
      open(undefined, { failing: { listVendorLeads: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await loaded();
    });

    it('HIDDEN: says the scope is hidden and names nothing when the server answers 403 or 404', async () => {
      open(undefined, { failing: { listVendorLeads: { error: problem(404, 'RESOURCE_NOT_FOUND'), times: 9 } } });
      expect((await screen.findByTestId('leads-hidden')).textContent).toBe(word('vnd3.leads.hidden.text'));
      expect(screen.queryByTestId('lead-counts')).toBeNull();
      expect(rows()).toHaveLength(0);
      cleanup();
      open(undefined, { failing: { listVendorLeads: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
      expect(await screen.findByTestId('leads-hidden')).toBeTruthy();
    });

    it('PARTIAL: a failing strip of figures does not hide the list and offers a retry', async () => {
      open(undefined, { failing: { getVendorInvestigationFigures: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      await loaded();
      expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
      fireEvent.click(screen.getAllByRole('button', { name: word('ui.common.retry') })[0] as HTMLElement);
      await screen.findByTestId('figure-open');
      expect(rows()).toHaveLength(2);
    });

    it('STALE: keeps the last list when a refresh fails', async () => {
      let calls = 0;
      const world: World = { answers: { listVendorLeads: () => (++calls === 1 ? leadPage([leadLine(1)]) : problem(500, 'INTERNAL_ERROR')), getVendorInvestigationFigures: investigationFigures() } };
      const mounted = mount(<LeadsScreen route={route} />, client(world), { permissions: AUDITOR, path: '/vnd/vnd-13' });
      await loaded();
      await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
      expect(await screen.findByTestId('stale-notice')).toBeTruthy();
      expect(rows()).toHaveLength(1);
    });
  });

  it('speaks English when the language is English', async () => {
    translator.setLocale('en');
    open();
    expect(await screen.findAllByText('Cluster of linked contractors')).toBeTruthy();
    expect(screen.getByTestId('signal-notice').textContent).toContain('not a conclusion');
  });
});
