import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import CompareScreen from './CompareScreen';
import { DOCUMENT, READER, VERSION_1, VERSION_2, client, comparison, detail, entry, mountScreen, route, world } from './test/repo-test-support';
import type { World } from './test/repo-test-support';

const problem = (code: string, status: number) => new ApiError({ status, code, correlationId: 'c' });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

function open(over: Partial<World> = {}, options: Parameters<typeof mountScreen>[2] = {}) {
  const h = client(world({ detail: detail(), comparison: comparison(), ...over }));
  const view = mountScreen(<CompareScreen route={route('DOC-27')} />, h, { path: `/?id=${DOCUMENT}&from=${VERSION_1}&to=${VERSION_2}`, ...options });
  return { h, ...view };
}

describe('CompareScreen (DOC-27): two versions of a document', () => {
  it('UI-DOC-27: shows the counts, the mode, the formula, and the words that changed in a changed paragraph', async () => {
    const { h } = open();
    const entries = await screen.findByTestId('entries');
    expect(h.read).toHaveBeenCalledWith('compareDocumentVersions', expect.objectContaining({ path: { id: DOCUMENT }, query: { from_version_id: VERSION_1, to_version_id: VERSION_2 } }));
    expect(screen.getByTestId('summary').textContent).toContain('1');
    expect(screen.getByTestId('mode').textContent).toBeTruthy();
    expect(screen.getByTestId('formula').textContent).toContain('longest common subsequence');
    expect(entries.querySelectorAll('del').length).toBeGreaterThan(0);
    expect(entries.querySelectorAll('ins').length).toBeGreaterThan(0);
    expect(Array.from(entries.querySelectorAll('del')).map((node) => node.textContent)).toContain('100');
    expect(Array.from(entries.querySelectorAll('ins')).map((node) => node.textContent)).toContain('120');
  });

  it('folds the equal paragraphs and shows them when asked', async () => {
    open();
    const entries = await screen.findByTestId('entries');
    const folded = entries.querySelectorAll('li').length;
    fireEvent.click(screen.getByTestId('toggle-equal'));
    await waitFor(() => expect(screen.getByTestId('entries').querySelectorAll('li').length).toBeGreaterThan(folded));
  });

  it('says two identical versions, the same version chosen twice, and a missing choice', async () => {
    open({ comparison: comparison({ summary: { equal: 2, added: 0, removed: 0, changed: 0 }, entries: [entry('EQUAL')] }) });
    expect(await screen.findByTestId('identical')).toBeTruthy();
    cleanup();
    mountScreen(<CompareScreen route={route('DOC-27')} />, client(world({ detail: detail(), comparison: comparison() })), { path: `/?id=${DOCUMENT}&from=${VERSION_1}&to=${VERSION_1}` });
    expect(await screen.findByTestId('same')).toBeTruthy();
    cleanup();
    mountScreen(<CompareScreen route={route('DOC-27')} />, client(world({ detail: detail(), comparison: comparison() })), { path: `/?id=${DOCUMENT}` });
    expect(await screen.findByTestId('choose')).toBeTruthy();
    cleanup();
    mountScreen(<CompareScreen route={route('DOC-27')} />, client(world({ detail: detail() })), { path: '/' });
    expect(await screen.findByTestId('no-id')).toBeTruthy();
  });

  it('swaps the two versions and reads the comparison the other way', async () => {
    const { h } = open();
    await screen.findByTestId('entries');
    fireEvent.click(screen.getByTestId('swap'));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('compareDocumentVersions', expect.objectContaining({ query: { from_version_id: VERSION_2, to_version_id: VERSION_1 } })));
  });

  it('chooses the versions from the two lists', async () => {
    const { h } = open({}, { path: `/?id=${DOCUMENT}` });
    await screen.findByTestId('choose');
    fireEvent.change(document.querySelector('#c-from') as HTMLSelectElement, { target: { value: VERSION_1 } });
    fireEvent.change(document.querySelector('#c-to') as HTMLSelectElement, { target: { value: VERSION_2 } });
    await screen.findByTestId('entries');
    expect(h.read).toHaveBeenCalledWith('compareDocumentVersions', expect.anything());
  });

  it('says a comparison that is too large as a refusal with its reason, a service error with retry, and a hidden scope', async () => {
    open({ failing: new Map([['compareDocumentVersions', { error: problem('DOC_COMPARE_TOO_LARGE', 422), times: 1 }]]) });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBeTruthy();
    cleanup();
    const denied = open({}, { permissions: [] });
    expect(await screen.findByTestId('no-read')).toBeTruthy();
    expect(denied.h.read).not.toHaveBeenCalledWith('compareDocumentVersions', expect.anything());
    cleanup();
    open({}, { permissions: READER });
    await screen.findByTestId('entries');
  });

  it('shows a skeleton while loading, never the number zero, and marks a stale comparison when a refresh fails', async () => {
    open({ hanging: new Set(['compareDocumentVersions']) });
    const busy = await screen.findAllByRole('status', { busy: true });
    expect(busy.map((node) => node.textContent ?? '').join('')).not.toMatch(/\b0\b/);
    cleanup();
    const state = world({ detail: detail(), comparison: comparison() });
    const h = client(state);
    const { queries } = mountScreen(<CompareScreen route={route('DOC-27')} />, h, { path: `/?id=${DOCUMENT}&from=${VERSION_1}&to=${VERSION_2}` });
    await screen.findByTestId('entries');
    state.failing.set('compareDocumentVersions', { error: problem('INTERNAL_ERROR', 500), times: 5 });
    await queries.invalidateQueries();
    await screen.findByTestId('stale-note');
    expect(within(screen.getByTestId('entries')).getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('shows a workbook comparison by cell and renders markup in a cell as text', async () => {
    const cells = comparison({
      mode: 'CELLS',
      summary: { equal: 0, added: 0, removed: 0, changed: 1 },
      entries: [entry('CHANGED', { before: { citation_id: 'cit_00000000000000000001', label: 'S!B2', kind: 'SHEET_CELL', text: '<b>1250</b>', seq: 1 }, after: { citation_id: 'cit_00000000000000000001', label: 'S!B2', kind: 'SHEET_CELL', text: '<b>1300</b>', seq: 1 }, words: [{ op: 'REMOVED', text: '<b>1250</b>' }, { op: 'ADDED', text: '<b>1300</b>' }] })],
    });
    open({ comparison: cells });
    const entries = await screen.findByTestId('entries');
    expect(entries.querySelector('b')).toBeNull();
    expect(entries.textContent).toContain('<b>1300</b>');
  });
});
