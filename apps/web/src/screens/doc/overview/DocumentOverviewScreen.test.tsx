import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mountInSession, routeOf } from '../test-support';
import DocumentOverviewScreen from './DocumentOverviewScreen';
import OutgoingListScreen from '../OutgoingListScreen';
import IncomingLedgerScreen from '../incoming/IncomingLedgerScreen';
import { TILE_KEYS, tileLink, toOverview } from './model';
import { tileLabel } from './labels';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const AS_OF = '2026-10-28T04:00:00.000Z';

const answer = (counts: Partial<Record<(typeof TILE_KEYS)[number], number | null>> = {}) => ({
  as_of: AS_OF,
  tiles: TILE_KEYS.map((key) => ({ key, count: key in counts ? counts[key] : key === 'interop_errors' ? 0 : 1 })),
});

function open(read: () => unknown) {
  const h = harness(
    (operation) => (operation === 'getDocumentOverview' ? (read() as never) : new Error(`unexpected read ${operation}`)),
    () => ({}),
  );
  mountInSession(<DocumentOverviewScreen route={routeOf('DOC-01', 'FR-DOC-01')} />, h, { permissions: ['doc.overview.read'] }, '/doc/doc-01');
  return h;
}

afterEach(() => cleanup());

describe('DocumentOverviewScreen (DOC-01): the component kit', () => {
  it('names the scope in the context bar and lays the tiles out as a figure strip, a queue with errors being told by its number as well as its tint', async () => {
    open(() => answer({ interop_errors: 3, overdue_incoming: 2, awaiting_seal: null }));
    await screen.findByTestId('tiles');
    expect(within(screen.getByRole('group', { name: word('ui.contextBar.label') })).getByText('Phạm vi')).toBeTruthy();
    expect(screen.getByTestId('tile-interop_errors').className).toContain('ui-tone-danger');
    expect(within(screen.getByTestId('tile-interop_errors')).getByTestId('count').textContent).toBe('3');
    expect(screen.getByTestId('tile-overdue_incoming').className).toContain('ui-tone-warning');
    // A queue the viewer may not count is never tinted and never shows a number.
    expect(screen.getByTestId('tile-awaiting_seal').className).toContain('ui-tone-default');
    expect(within(screen.getByTestId('tile-awaiting_seal')).getByTestId('count').textContent).toBe(word('doc.overview.notPermitted'));
  });
});

describe('DocumentOverviewScreen (DOC-01): the overview of the documents', () => {
  it('UI-DOC-01 AC-ST-DOC-014-1: UAT-AC400 shows a tile for each queue with the number the server counted and the moment it was counted', async () => {
    open(() => answer({ drafts_in_review: 4, awaiting_leader_signature: 2, awaiting_number: 0, awaiting_seal: 7, overdue_incoming: 3, templates_pending_confirmation: 5 }));
    await screen.findByTestId('tiles');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('doc.overview.title'));
    const counts = Object.fromEntries(TILE_KEYS.map((key) => [key, within(screen.getByTestId(`tile-${key}`)).getByTestId('count').textContent]));
    expect(counts).toEqual({ drafts_in_review: '4', awaiting_leader_signature: '2', awaiting_number: '0', awaiting_seal: '7', overdue_incoming: '3', interop_errors: '0', templates_pending_confirmation: '5' });
    expect(Array.from(document.querySelectorAll('[data-tile]')).map((tile) => tile.getAttribute('data-tile'))).toEqual([...TILE_KEYS]);
    expect(screen.getByTestId('as-of').textContent).toContain('28/10/26');
    expect(screen.getByText(word('doc.overview.footer.reference').replace('{id}', 'DOC-01').replace('{req}', 'FR-DOC-01'))).toBeTruthy();
  });

  it('AC-ST-DOC-014-2: UAT-AC419 leads the overdue tile to the ledger filtered on overdue and the template tile to DOC-14 with the legal confirmation label', async () => {
    open(() => answer({ overdue_incoming: 2, templates_pending_confirmation: 1 }));
    await screen.findByTestId('tiles');
    const overdue = screen.getByTestId('tile-overdue_incoming');
    expect(
      within(overdue)
        .getByRole('link', { name: word('doc.overview.open') })
        .getAttribute('href'),
    ).toBe('/doc/doc-12?overdue=true');
    const templates = screen.getByTestId('tile-templates_pending_confirmation');
    expect(
      within(templates)
        .getByRole('link', { name: word('doc.overview.open') })
        .getAttribute('href'),
    ).toBe('/doc/doc-14');
    expect(templates.textContent).toContain('[CXN-DOC-01]');
    expect(within(screen.getByTestId('tile-awaiting_number')).getByRole('link').getAttribute('href')).toBe('/doc/doc-03?status=SIGNED');
    // The interoperability leads to its monitor and says what it counts.
    const interop = screen.getByTestId('tile-interop_errors');
    expect(within(interop).getByRole('link', { name: word('doc.overview.open') }).getAttribute('href')).toBe('/doc/doc-20');
    expect(interop.textContent).toContain(word('doc.overview.interop.note'));
  });

  it('says that a kind of document may not be seen, and never shows 0 for it nor a link', async () => {
    open(() => answer({ drafts_in_review: null, awaiting_leader_signature: null, awaiting_number: null, awaiting_seal: null, templates_pending_confirmation: null, overdue_incoming: 0 }));
    await screen.findByTestId('tiles');
    for (const key of ['drafts_in_review', 'templates_pending_confirmation'] as const) {
      const tile = screen.getByTestId(`tile-${key}`);
      expect(within(tile).getByTestId('count').textContent).toBe(word('doc.overview.notPermitted'));
      expect(within(tile).queryByRole('link')).toBeNull();
    }
    expect(within(screen.getByTestId('tile-overdue_incoming')).getByTestId('count').textContent).toBe('0');
  });

  it('shows the empty, the failed and the loading states, and reads again on request', async () => {
    let calls = 0;
    let next: () => unknown = () => ({ as_of: AS_OF, tiles: [] });
    const h = open(() => {
      calls += 1;
      return next();
    });
    await waitFor(() => expect(calls).toBe(1));
    expect(screen.queryByTestId('tiles')).toBeNull();
    next = () => answer({ drafts_in_review: 9 });
    // The button is held while the figures are on their way.
    await waitFor(() => expect((screen.getByRole('button', { name: word('doc.overview.refresh') }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: word('doc.overview.refresh') }));
    await waitFor(() => expect(within(screen.getByTestId('tile-drafts_in_review')).getByTestId('count').textContent).toBe('9'));
    expect(h.read.mock.calls.filter((call) => call[0] === 'getDocumentOverview').length).toBe(calls);
    cleanup();
    let failing = true;
    open(() => (failing ? new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c', extensions: {} }) : answer()));
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    failing = false;
    fireEvent.click(retry);
    await screen.findByTestId('tiles');
  });
});

describe('the model of the overview', () => {
  it('keeps the tiles it knows, in the order of the screen, and drops what is not a count', () => {
    const overview = toOverview({
      as_of: AS_OF,
      tiles: [{ key: 'awaiting_seal', count: 2 }, { key: 'drafts_in_review', count: -1 }, { key: 'awaiting_number', count: 1.5 }, { key: 'overdue_incoming', count: null }, { key: 'nonsense', count: 4 }, { key: 'awaiting_leader_signature', count: '3' }, null, { key: 'interop_errors', count: 0 }],
    });
    expect(overview).toEqual({
      asOf: AS_OF,
      tiles: [
        { key: 'awaiting_seal', count: 2 },
        { key: 'overdue_incoming', count: null },
        { key: 'interop_errors', count: 0 },
      ],
    });
    expect(toOverview(undefined)).toEqual({ asOf: '', tiles: [] });
    expect(toOverview({ tiles: 'x' })).toEqual({ asOf: '', tiles: [] });
  });

  it('has a word and a link for every tile', () => {
    const t = ((key: string) => (vi_ as Record<string, string>)[key] ?? `MISSING:${key}`) as never;
    expect(TILE_KEYS.map((key) => tileLabel(t, key)).filter((label) => label.startsWith('MISSING:'))).toEqual([]);
    expect(TILE_KEYS.filter((key) => tileLink(key) === undefined)).toEqual([]);
  });
});

describe('the lists the tiles lead to open on the queue', () => {
  it('opens the outgoing list on the state named in the link, and ignores one that is not a state', async () => {
    const seen: unknown[] = [];
    const h = harness(
      (operation, input) => {
        if (operation === 'listOutgoingDocuments') {
          seen.push((input as { query?: unknown } | undefined)?.query);
          return { items: [], as_of: AS_OF } as never;
        }
        return new Error(`unexpected read ${operation}`);
      },
      () => ({}),
    );
    mountInSession(<OutgoingListScreen route={routeOf('DOC-03', 'FR-DOC-03')} />, h, { permissions: ['doc.outgoing.read'] }, '/doc/doc-03?status=SIGNED');
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect((document.getElementById('draft-status') as HTMLSelectElement).value).toBe('SIGNED');
    expect(seen[0]).toMatchObject({ status: 'SIGNED' });
    cleanup();
    mountInSession(<OutgoingListScreen route={routeOf('DOC-03', 'FR-DOC-03')} />, h, { permissions: ['doc.outgoing.read'] }, '/doc/doc-03?status=NOPE');
    await waitFor(() => expect((document.getElementById('draft-status') as HTMLSelectElement | null)?.value).toBe(''));
  });

  it('opens the ledger of the incoming letters on the overdue ones', async () => {
    const seen: unknown[] = [];
    const h = harness(
      (operation, input) => {
        if (operation === 'listIncomingDocuments') {
          seen.push((input as { query?: unknown } | undefined)?.query);
          return { items: [], as_of: AS_OF } as never;
        }
        return new Error(`unexpected read ${operation}`);
      },
      () => ({}),
    );
    mountInSession(<IncomingLedgerScreen route={routeOf('DOC-12', 'FR-DOC-12')} />, h, { permissions: ['doc.incoming.read'] }, '/doc/doc-12?overdue=true');
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]).toMatchObject({ overdue: 'true' });
    expect((document.getElementById('incoming-filter-overdue') as HTMLInputElement).checked).toBe(true);
  });
});
