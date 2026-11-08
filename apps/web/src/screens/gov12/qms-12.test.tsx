import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import PhotoFindingScreen from './qms/PhotoFindingScreen';
import { AS_OF, harness, mount, never, problem, routeOf, uuid, word, rx } from './test/docaud';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const route = routeOf('QMS-12', 'QMS', 'FR-QMS-12');
const ALL = ['photo.finding.read', 'photo.finding.scan', 'photo.finding.review'];
const READ = ['photo.finding.read'];
const rule = { version: 0, unverified: true, place_metres: 30, moment_minutes: 10 };
const ID = uuid(21);

const finding = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(20 + n),
  kind: 'SAME_PLACE_AND_MOMENT_OTHER_PROJECT',
  first_photo_id: uuid(30 + n),
  second_photo_id: uuid(40 + n),
  first_project_id: uuid(900),
  second_project_id: uuid(901),
  metres: 8,
  minutes: 4,
  status: 'OPEN',
  reviewer_id: null,
  reason: null,
  first_flagged_at: '2027-03-09T01:00:00.000Z',
  rule_version: 0,
  is_conclusion: false,
  version: 1,
  ...over,
});

function open(answer: (op: string, input: unknown) => unknown, command?: (op: string, input: unknown) => unknown, permissions: readonly string[] = ALL, path = '/') {
  const h = harness(answer, command);
  mount(<PhotoFindingScreen route={route} />, h, permissions, path);
  return h;
}
const listWorld = (items: unknown[]) => (op: string): unknown => (op === 'listPhotoFindings' ? { as_of: AS_OF, items, has_more: false, rule } : {});

describe('QMS-12, site photos to explain across projects', () => {
  it('UI-QMS-12: lists the pairs as signals with the measures and their "i", and never says a photo is fake', async () => {
    open(listWorld([finding(1), finding(2, { kind: 'SAME_FILE_OTHER_PROJECT', metres: null, minutes: null })]));
    expect(await screen.findByTestId(`measure-${uuid(21)}`)).toBeTruthy();
    expect(screen.getByTestId(`measure-${uuid(21)}`).textContent).toContain('8 m');
    expect(screen.getByTestId(`measure-${uuid(22)}`).textContent).toContain('–');
    expect(screen.getByTestId('signal-note').textContent).toBe(word('gov12da.qms12.note.signal'));
    expect(screen.getAllByText(word('gov12da.qms12.signal.text')).length).toBe(2);
    expect(document.body.textContent?.toLowerCase()).not.toContain('giả mạo');
    expect(screen.getByTestId('figure-place').textContent).toBe('30 m');
    fireEvent.click(screen.getByRole('button', { name: rx(word('gov12da.qms12.figure.place')) }));
    const panel = await screen.findByRole('dialog', { name: word('gov12da.qms12.figure.place') });
    expect(within(panel).getByText(word('gov12da.info.label.unverified'))).toBeTruthy();
  });

  it('scans on demand for a person who may, and offers neither scan nor review to a reader', async () => {
    const h = open(listWorld([finding(1)]), () => ({ operation_id: 'x', status: 'FINISHED', resource_version: 1, resource_id: uuid(5) }));
    fireEvent.click(await screen.findByTestId('scan'));
    expect((await screen.findByTestId('notice')).textContent).toBe(word('gov12da.qms12.scan.done'));
    expect(h.command).toHaveBeenCalledWith('scanPhotoFindings', expect.objectContaining({ body: {} }));
    cleanup();
    open(listWorld([finding(1)]), undefined, READ);
    await screen.findByTestId(`measure-${uuid(21)}`);
    expect(screen.queryByTestId('scan')).toBeNull();
    expect(screen.queryByTestId(`move-${uuid(21)}`)).toBeNull();
  });

  it('takes a pair, then asks a reason of ten characters to explain it, and says in words when the uploader tries it', async () => {
    let calls = 0;
    const h = open(listWorld([finding(1, { status: 'IN_REVIEW', version: 2 })]), () => {
      calls += 1;
      return calls === 1 ? problem('SELF_APPROVAL_DENIED', 403) : { operation_id: 'x', status: 'EXPLAINED', resource_version: 3, resource_id: ID };
    });
    fireEvent.click(await screen.findByTestId(`move-${ID}`));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(word('gov12da.qms12.move.choice')) as HTMLSelectElement).value).toBe('EXPLAIN');
    const confirm = within(dialog).getByRole('button', { name: word('gov12da.qms12.move.confirm') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(rx(word('gov12da.common.reason.label'))), { target: { value: 'The same vehicle was photographed at both sites' } });
    fireEvent.click(confirm);
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.error.selfApproval.text'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.qms12.move.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command).toHaveBeenLastCalledWith('movePhotoFinding', expect.objectContaining({ path: { id: ID }, ifMatchVersion: 2, body: { move: 'EXPLAIN', reason: 'The same vehicle was photographed at both sites' } }));
  });

  it('taking a pair needs no reason', async () => {
    const h = open(listWorld([finding(1)]), () => ({ operation_id: 'x', status: 'IN_REVIEW', resource_version: 2, resource_id: ID }));
    fireEvent.click(await screen.findByTestId(`move-${ID}`));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(rx(word('gov12da.common.reason.label')))).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: word('gov12da.qms12.move.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('movePhotoFinding', expect.objectContaining({ ifMatchVersion: 1, body: { move: 'TAKE' } })));
  });

  it('opens one finding with its reason and its history', async () => {
    open(
      (op) =>
        op === 'getPhotoFinding'
          ? { ...finding(1, { status: 'EXPLAINED', reason: 'The same vehicle was photographed at both sites' }), as_of: AS_OF, history: [{ id: uuid(61), move: 'FLAGGED', to_status: 'OPEN', actor_id: null, reason: null, at: '2027-03-09T01:00:00.000Z' }, { id: uuid(62), move: 'EXPLAIN', to_status: 'EXPLAINED', actor_id: uuid(33), reason: 'The same vehicle', at: '2027-03-10T01:00:00.000Z' }] }
          : {},
      undefined,
      ALL,
      `/?finding=${ID}`,
    );
    expect((await screen.findByTestId('detail-reason')).textContent).toContain('same vehicle');
    const history = screen.getByTestId('history');
    expect(within(history).getByText(rx(word('gov12da.qms.move.flagged')))).toBeTruthy();
    expect(within(history).getByText(rx(word('gov12da.qms.move.explain')))).toBeTruthy();
  });

  it('shows the loading, empty, error and denied states', async () => {
    open(() => never());
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open(listWorld([]));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open(() => problem('INTERNAL_ERROR', 500));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    open(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});
