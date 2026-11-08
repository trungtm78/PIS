import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContainerScreen from './doc/ContainerScreen';
import { AS_OF, harness, mount, never, problem, routeOf, sha, uuid, word } from './test/docaud';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const READER = ['doc.transmittal.read'];
const route = routeOf('DOC-28', 'DOC', 'FR-DOC-28');
const container = (n: number, over: Record<string, unknown> = {}) => ({ id: uuid(n), project_id: uuid(900), document_id: uuid(800 + n), document_kind: 'DOCUMENT', revision_label: 'A', title: `Design report ${n}`, content_sha256: sha('c'), state: 'SHARED', author_id: uuid(701), state_changed_at: '2027-03-09T01:00:00.000Z', version: 3, ...over });
const detail = (n: number, over: Record<string, unknown> = {}) => ({
  ...container(n),
  as_of: '2027-03-10T03:00:00.000Z',
  moves: [
    { id: uuid(60), from_state: null, to_state: 'WIP', actor_id: uuid(701), transmittal_id: null, reason: null, at: '2027-03-01T01:00:00.000Z' },
    { id: uuid(61), from_state: 'WIP', to_state: 'SHARED', actor_id: uuid(702), transmittal_id: uuid(500), reason: 'Sent for review', at: '2027-03-09T01:00:00.000Z' },
  ],
  latest_review: { required: 3, answered: 2, approved: 1, rejected: 1, overdue: 1, all_required_answered: false },
  ...over,
});
const open = (read: (operation: string) => unknown) => {
  const h = harness((operation) => {
    if (operation === 'listDocContainers') return { as_of: AS_OF, items: [container(1)], has_more: false };
    if (operation === 'listDocTransmittals') return { as_of: AS_OF, items: [], has_more: false };
    return read(operation);
  });
  mount(<ContainerScreen route={route} />, h, READER);
  return h;
};

describe('DOC-28 the detail of a container (getDocContainer)', () => {
  it('opens on request, shows the review figures with their "i" and the moves with who and why, and closes', async () => {
    const h = open(() => detail(1));
    const button = await screen.findByTestId(`detail-${uuid(1)}`);
    expect(h.read).not.toHaveBeenCalledWith('getDocContainer', expect.anything());
    fireEvent.click(button);
    const panel = await screen.findByTestId('container-detail');
    await screen.findByTestId('review-required');
    expect(h.read).toHaveBeenCalledWith('getDocContainer', { path: { id: uuid(1) } });
    expect(within(panel).getByTestId('review-required').textContent).toBe('3');
    expect(within(panel).getByTestId('review-overdue').textContent).toBe('1');
    expect(within(panel).getAllByRole('button', { name: new RegExp(word('gov12da.info.label.open').split('{')[0] ?? '') }).length).toBeGreaterThan(3);
    expect(within(panel).getByTestId('review-ready').textContent).toBe(word('gov12da.doc28.detail.waiting'));
    expect(within(panel).getByTestId(`move-row-${uuid(61)}`).textContent).toContain('Sent for review');
    expect(within(panel).getByTestId(`move-row-${uuid(60)}`).textContent).toContain(word('gov12da.doc28.detail.registered'));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(panel).getByTestId('container-detail-close'));
    expect(screen.queryByTestId('container-detail')).toBeNull();
  });

  it('says a container that never went to review has no review, and one without moves has none', async () => {
    open(() => detail(1, { latest_review: null, moves: [] }));
    fireEvent.click(await screen.findByTestId(`detail-${uuid(1)}`));
    expect(await screen.findByTestId('container-no-review')).toBeTruthy();
    expect(screen.getByTestId('container-no-moves')).toBeTruthy();
  });

  it('shows a loading note, then an error with a retry that reads again', async () => {
    let calls = 0;
    const h = open(() => (calls++ === 0 ? problem('INTERNAL', 500) : detail(1)));
    fireEvent.click(await screen.findByTestId(`detail-${uuid(1)}`));
    const error = await screen.findByTestId('container-detail-error');
    fireEvent.click(within(error).getByRole('button', { name: word('gov12da.doc28.detail.retry') }));
    expect(await screen.findByTestId('container-review')).toBeTruthy();
    expect(h.read.mock.calls.filter((call) => call[0] === 'getDocContainer')).toHaveLength(2);
    cleanup();
    open(() => never());
    fireEvent.click(await screen.findByTestId(`detail-${uuid(1)}`));
    expect(await screen.findByTestId('container-detail-loading')).toBeTruthy();
  });
});
