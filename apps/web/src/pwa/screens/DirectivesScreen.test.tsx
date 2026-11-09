import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { toDirectiveDetail } from '../../screens/dir/model';
import { POLICY, directive, overdueDirective, page, summary, uuid } from '../../screens/dir/test-support';
import { describeViolations, seriousViolations } from '../../test/axe';
import DirectiveDetailScreen, { latestProgress } from './DirectiveDetailScreen';
import DirectivesScreen from './DirectivesScreen';
import { mountPwa, pwaClient, word } from './test-support';

const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const UNIT = { id: uuid(101), code: 'BQL1', name: 'Ban quản lý 1', status: 'ACTIVE' };

interface World {
  list?: (query: Record<string, unknown>) => unknown;
  summary?: unknown;
  detail?: unknown;
}

function client(world: World) {
  return pwaClient({
    read: (operation, input) => {
      const query = (input as { query?: Record<string, unknown> } | undefined)?.query ?? {};
      if (operation === 'listDirectives') return world.list?.(query) ?? page([directive(1), overdueDirective(2)]);
      if (operation === 'getDirectiveSummary') return world.summary ?? summary;
      if (operation === 'getDirective') return world.detail ?? new Error('no detail');
      return new Error(`unexpected read ${operation}`);
    },
    readAll: (operation) => (operation === 'get_resources_organization_unit' ? [UNIT] : new Error(`unexpected ${operation}`)),
  });
}

function openList(world: World = {}) {
  const h = client(world);
  mountPwa(<DirectivesScreen />, h, { path: '/m/directives' });
  return h;
}

const cards = (): string[] => Array.from(document.querySelectorAll('[data-directive]')).map((card) => card.getAttribute('data-directive') as string);

afterEach(cleanup);

describe('DirectivesScreen (PWA-04): the directive tracking over the real operations', () => {
  it('lists the directives of the scope with the unit, the due day and the clock as the server counts it', async () => {
    const h = openList();
    await screen.findByLabelText(word('pwa.directives.list.aria'));
    expect(cards()).toEqual([uuid(201), uuid(202)]);
    const late = document.querySelector(`[data-directive="${uuid(202)}"]`) as HTMLElement;
    expect(late.getAttribute('data-overdue')).toBe('yes');
    expect(late.textContent).toContain('Ban quản lý 1');
    expect(late.textContent).toContain('03/11/2026');
    expect(late.textContent).toContain('Quá hạn 5 ngày');
    expect(late.textContent).toContain('Nguyễn Văn A');
    expect(h.read).toHaveBeenCalledWith('listDirectives', { query: { limit: 20 } });
    expect(h.read).toHaveBeenCalledWith('getDirectiveSummary', { query: {} });
    expect(document.querySelector('a[data-action="open"]')?.getAttribute('href')).toBe(`/m/directives/${uuid(201)}`);
  });

  it('shows the counts of the scope with how they are made, and flags the unconfirmed thresholds', async () => {
    openList();
    const tiles = await screen.findByTestId('summary');
    expect(tiles.querySelector('[data-tile="overdue"]')?.textContent).toContain('2');
    expect(tiles.querySelector('[data-tile="dueSoon"]')?.textContent).toContain('2');
    expect(tiles.querySelector('[data-tile="open"]')?.textContent).toContain('5');
    expect(screen.getByTestId('policy-unverified')).toBeInTheDocument();
    expect(tiles.textContent).toContain('Chỉ đạo chưa xong có hạn trong 3 ngày.');
  });

  it('filters by status, overdue and unit through the server query (AC-ST-PWA-003-1)', async () => {
    const h = openList();
    await screen.findByLabelText(word('pwa.directives.list.aria'));
    fireEvent.change(screen.getByLabelText(word('pwa.directives.filter.status')), { target: { value: 'OVERDUE' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listDirectives', { query: { limit: 20, status: 'OVERDUE' } }));
    fireEvent.click(screen.getByLabelText(word('pwa2.directives.filter.overdue')));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listDirectives', { query: { limit: 20, status: 'OVERDUE', overdue: true } }));
    await waitFor(() => expect(screen.getByLabelText(word('pwa2.directives.filter.unit')).querySelectorAll('option').length).toBe(2));
    fireEvent.change(screen.getByLabelText(word('pwa2.directives.filter.unit')), { target: { value: UNIT.id } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listDirectives', { query: { limit: 20, status: 'OVERDUE', unit_id: UNIT.id, overdue: true } }));
    expect(h.read).toHaveBeenCalledWith('getDirectiveSummary', { query: { unit_id: UNIT.id } });
  });

  it('has two empty states: none in the scope, and the filter found nothing with the way to clear it', async () => {
    openList({ list: () => page([]) });
    const none = await screen.findByTestId('empty');
    expect(none.getAttribute('data-kind')).toBe('none');
    expect(none.textContent).toContain(word('pwa.directives.empty.none.title'));
    fireEvent.change(screen.getByLabelText(word('pwa.directives.filter.status')), { target: { value: 'DONE' } });
    await waitFor(() => expect(screen.getByTestId('empty').getAttribute('data-kind')).toBe('filtered'));
    fireEvent.click(screen.getByRole('button', { name: word('pwa.directives.empty.filtered.clear') }));
    await waitFor(() => expect(screen.getByTestId('empty').getAttribute('data-kind')).toBe('none'));
  });

  it('reads the next page on request', async () => {
    const h = openList({ list: (query) => (query.cursor === undefined ? page([directive(1)], 'next-1') : page([directive(2)])) });
    await screen.findByLabelText(word('pwa.directives.list.aria'));
    expect(cards()).toEqual([uuid(201)]);
    fireEvent.click(screen.getByRole('button', { name: word('pwa2.directives.more.action') }));
    await waitFor(() => expect(cards()).toEqual([uuid(201), uuid(202)]));
    expect(h.read).toHaveBeenCalledWith('listDirectives', { query: { limit: 20, cursor: 'next-1' } });
    expect(screen.queryByRole('button', { name: word('pwa2.directives.more.action') })).toBeNull();
  });

  it('says the counts are missing when only they fail, and keeps the list; never shows them as 0', async () => {
    openList({ summary: failure(500, 'INTERNAL') });
    await screen.findByLabelText(word('pwa.directives.list.aria'));
    expect((await screen.findByTestId('summary-failed')).textContent).toContain(word('pwa2.directives.summary.failed'));
    expect(screen.queryByTestId('summary')).toBeNull();
  });

  it('shows a skeleton while loading, and the standard states for failures', async () => {
    const waiting = pwaClient({ read: () => new Promise(() => undefined), readAll: () => [] });
    mountPwa(<DirectivesScreen />, waiting, { path: '/m/directives' });
    expect((await screen.findByRole('status', { name: word('states.loading.label') })).getAttribute('aria-busy')).toBe('true');
    cleanup();
    openList({ list: () => failure(0, NETWORK_ERROR_CODE) });
    expect(await screen.findByText(word('states.offline.title'))).toBeInTheDocument();
    cleanup();
    openList({ list: () => failure(403, 'SCOPE_DENIED') });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    cleanup();
    openList({ list: () => failure(500, 'INTERNAL') });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
  });

  it('has no serious accessibility violation and the controls are touch targets', async () => {
    openList();
    await screen.findByTestId('summary');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    for (const control of document.querySelectorAll('a[data-action="open"], [data-testid="pwa-back"]')) expect(control.className).toContain('pwa-touch');
  });
});

const person = { membership_id: uuid(121), display_name: 'Nguyễn Văn A' };
const event = (n: number, type: string, extra: Record<string, unknown> = {}) => ({ id: uuid(500 + n), type, actor: person, occurred_at: `2026-11-0${n}T03:00:00.000Z`, note: null, progress_pct: null, ...extra });
const detailBody = (extra: Record<string, unknown> = {}) => ({
  directive: directive(1),
  timeline: [event(1, 'CREATED'), event(2, 'PROGRESS', { progress_pct: 30, note: 'Đã khảo sát' }), event(3, 'PROGRESS', { progress_pct: 60 }), event(4, 'EXTENSION_REQUESTED', { to_due_on: '2026-12-01', from_due_on: '2026-11-20' })],
  extensions: [{ id: uuid(600), from_due_on: '2026-11-20', proposed_due_on: '2026-12-01', reason: 'Chờ thẩm định', status: 'REQUESTED', requested_by: person, requested_at: '2026-11-04T03:00:00.000Z', version: 1 }],
  evidence: [{ id: uuid(700), document_version_id: uuid(701), title: 'Biên bản khảo sát', added_by: person, added_at: '2026-11-03T03:00:00.000Z' }],
  policy: POLICY,
  actions: {},
  as_of: '2026-11-08T03:00:00.000Z',
  ...extra,
});

function openDetail(world: World, id = uuid(201)) {
  const h = client(world);
  mountPwa(
    <Routes>
      <Route path="/m/directives/:id" element={<DirectiveDetailScreen />} />
    </Routes>,
    h,
    { path: `/m/directives/${id}` },
  );
  return h;
}

describe('DirectiveDetailScreen (PWA-06)', () => {
  it('shows the directive, the latest progress, the timeline newest first, the extension and the evidence (AC-ST-PWA-003-2)', async () => {
    const h = openDetail({ detail: detailBody() });
    await screen.findByTestId('directive-summary');
    expect(h.read).toHaveBeenCalledWith('getDirective', { path: { id: uuid(201) } });
    expect(screen.getByTestId('directive-summary').textContent).toContain('GB-2026-001/CD-01');
    expect(screen.getByTestId('directive-summary').textContent).toContain('Giao ban tuần 40');
    expect(screen.getByTestId('progress').textContent).toContain('60%');
    const events = within(screen.getByTestId('timeline')).getAllByRole('listitem').map((item) => item.getAttribute('data-event'));
    expect(events).toEqual(['EXTENSION_REQUESTED', 'PROGRESS', 'PROGRESS', 'CREATED']);
    expect(screen.getByTestId('timeline').textContent).toContain('Đã khảo sát');
    expect(screen.getByTestId('extensions').textContent).toContain('Chờ thẩm định');
    expect(screen.getByTestId('evidence').textContent).toContain('Biên bản khảo sát');
  });

  it('says nothing was reported rather than 0%, and says a missing directive is not there', async () => {
    openDetail({ detail: detailBody({ timeline: [event(1, 'CREATED')], extensions: [], evidence: [] }) });
    expect(await screen.findByTestId('progress-none')).toBeInTheDocument();
    expect(screen.getByText(word('pwa2.directiveDetail.evidence.none'))).toBeInTheDocument();
    cleanup();
    openDetail({ detail: failure(404, 'RESOURCE_NOT_FOUND') });
    expect((await screen.findByTestId('not-found')).textContent).toContain(word('pwa2.directiveDetail.notFound.title'));
  });

  it('picks the newest progress with a percentage and none when there is none', () => {
    expect(latestProgress([])).toBeNull();
    const timeline = toDirectiveDetail(detailBody())!.timeline;
    expect(latestProgress(timeline)).toEqual({ percent: 60, at: '2026-11-03T03:00:00.000Z' });
    expect(latestProgress(timeline.filter((item) => item.type !== 'PROGRESS'))).toBeNull();
  });
});
