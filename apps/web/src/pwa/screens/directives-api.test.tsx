import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import DirectiveDetailScreen from './DirectiveDetailScreen';
import DirectivesScreen from './DirectivesScreen';
import { toDirectiveItem } from './directives-api-source';
import { useApiDirectives } from './directives-api-source';
import { DirectivesSourceContext } from './directives-source';
import { mountPwa, pwaClient, word } from './test-support';
import { toDirective } from '../../screens/dir/model';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = { membership_id: uuid(900), display_name: 'Nguyễn Văn A' };
const unit = (n: number, name: string) => ({ id: uuid(n), code: `U${n}`, name });

const rawDirective = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  code: `CD-${n}`,
  seq: n,
  meeting: { id: uuid(500), code: 'GB-2027-014', meeting_date: '2027-10-04', title: 'Giao ban đầu tư tuần 40' },
  scope_kind: 'UNIT',
  project: null,
  scope_unit: unit(1, 'Ban KHĐT'),
  text: `Hoàn thành báo cáo số ${n}`,
  assignee_unit: unit(2, 'Ban Kỹ thuật'),
  assignee: null,
  original_due_on: '2027-10-20',
  due_on: '2027-10-20',
  extension_count: 0,
  status: 'IN_PROGRESS',
  stored_status: 'IN_PROGRESS',
  phase: 'DUE_SOON',
  days_to_due: 5,
  overdue_days: null,
  reminder_today: false,
  escalates_on: null,
  closed_at: null,
  evidence_count: 0,
  progress_percent: null,
  progress_reported_at: null,
  open_extension: null,
  created_by: person,
  created_at: '2027-10-04T03:00:00.000Z',
  version: 1,
  ...over,
});

const detail = (n: number) => ({
  directive: rawDirective(n, { extension_count: 1, original_due_on: '2027-10-10' }),
  timeline: [
    { id: 'e1', type: 'CREATED', actor: person, occurred_at: '2027-10-04T03:00:00.000Z', note: null, progress_pct: null },
    { id: 'e2', type: 'PROGRESS', actor: person, occurred_at: '2027-10-08T03:00:00.000Z', note: 'Đã gửi dự thảo', progress_pct: 60 },
  ],
  extensions: [],
  evidence: [],
  policy: {},
  actions: {},
  as_of: '2027-10-12T03:00:00.000Z',
});

function openList(answers: Parameters<typeof pwaClient>[0]) {
  const h = pwaClient(answers);
  return { h, ...mountPwa(<DirectivesSourceContext.Provider value={useApiDirectives}><DirectivesScreen /></DirectivesSourceContext.Provider>, h, { path: '/m/directives' }) };
}

afterEach(cleanup);

describe('PWA-04 over the directive module: list, status, overdue, detail', () => {
  it('maps a directive of the API to the card: who gave it, the unit, the deadline and the status, and never claims 0% progress', () => {
    const line = toDirective(rawDirective(1, { status: 'OVERDUE', overdue_days: 9 }));
    expect(line).toBeDefined();
    expect(toDirectiveItem(line as NonNullable<typeof line>)).toEqual({
      id: uuid(1),
      title: 'Hoàn thành báo cáo số 1',
      issuedBy: 'GB-2027-014 · Giao ban đầu tư tuần 40',
      issuedOn: '2027-10-04',
      dueOn: '2027-10-20',
      status: 'OVERDUE',
      assigneeUnit: 'Ban Kỹ thuật',
      progressPercent: null,
      lastUpdateAt: null,
      overdueDays: 9,
    });
  });

  it('carries the progress the list of the API reports, and a list line without one is "not reported", never 0%', () => {
    const worked = toDirective(rawDirective(2, { progress_percent: 80, progress_reported_at: '2027-10-08T03:00:00.000Z' }));
    expect(toDirectiveItem(worked as NonNullable<typeof worked>)).toMatchObject({ progressPercent: 80, lastUpdateAt: '2027-10-08T03:00:00.000Z' });
    const quiet = toDirective(rawDirective(3));
    const item = toDirectiveItem(quiet as NonNullable<typeof quiet>);
    expect(item.progressPercent).toBeNull();
    expect(item.progressKnown).not.toBe(false);
  });

  it('lists the directives of the scope, sends the status filter to the server, and links each card to its detail', async () => {
    const { h } = openList({ read: (operation) => (operation === 'listDirectives' ? { items: [rawDirective(1), rawDirective(2, { status: 'OVERDUE', overdue_days: 3, progress_percent: 80, progress_reported_at: '2027-10-08T03:00:00.000Z' })], next_cursor: null, as_of: '2027-10-12T03:00:00.000Z' } : undefined) });
    const first = await waitFor(() => {
      const found = document.querySelector(`[data-directive="${uuid(1)}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(first.textContent).toContain('Hoàn thành báo cáo số 1');
    expect(first.textContent).toContain('GB-2027-014');
    expect(first.textContent).toContain('Ban Kỹ thuật');
    expect(first.querySelector('[data-testid="progress-detail"]')).toBeNull();
    expect(first.querySelector('[data-testid="progress-none"]')?.textContent).toBe(word('pwa.directives.progress.none'));
    const second = document.querySelector(`[data-directive="${uuid(2)}"]`) as HTMLElement;
    expect(second.querySelector('progress')?.getAttribute('value')).toBe('80');
    expect(first.querySelector('[data-testid="open-detail"]')?.getAttribute('href')).toBe(`/m/directives/${uuid(1)}`);
    fireEvent.change(screen.getByLabelText(word('pwa.directives.filter.status')), { target: { value: 'OVERDUE' } });
    await waitFor(() => expect(h.read.mock.calls.some(([operation, input]) => operation === 'listDirectives' && (input as { query: Record<string, unknown> }).query.status === 'OVERDUE')).toBe(true));
  });

  it('asks the next page with the cursor of the server when "more" is pressed', async () => {
    const { h } = openList({
      read: (_operation, input) => {
        const cursor = (input as { query: Record<string, unknown> }).query.cursor;
        return cursor === undefined
          ? { items: [rawDirective(1)], next_cursor: 'CUR2', as_of: '2027-10-12T03:00:00.000Z' }
          : { items: [rawDirective(2)], next_cursor: null, as_of: '2027-10-12T03:00:00.000Z' };
      },
    });
    fireEvent.click(await screen.findByTestId('more'));
    await waitFor(() => expect(document.querySelector(`[data-directive="${uuid(2)}"]`)).not.toBeNull());
    expect(h.read.mock.calls.some(([, input]) => (input as { query: Record<string, unknown> }).query.cursor === 'CUR2')).toBe(true);
    expect(screen.queryByTestId('more')).toBeNull();
  });

  it('says the list could not be read, with a retry, and keeps a list already read as stale when a refresh fails', async () => {
    let calls = 0;
    openList({ read: () => (calls++ === 0 ? new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }) : { items: [rawDirective(1)], next_cursor: null, as_of: '2027-10-12T03:00:00.000Z' }) });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(document.querySelector(`[data-directive="${uuid(1)}"]`)).not.toBeNull());
  });

  it('says an empty scope is an empty scope, not a module that is not built', async () => {
    openList({ read: () => ({ items: [], next_cursor: null, as_of: '2027-10-12T03:00:00.000Z' }) });
    const empty = await screen.findByTestId('empty');
    expect(empty.getAttribute('data-kind')).toBe('none');
  });

  it('opens one directive read only: who gave it, the extensions, the latest progress and the timeline (AC-ST-PWA-003-2)', async () => {
    const h = pwaClient({ read: (operation) => (operation === 'getDirective' ? detail(1) : undefined) });
    mountPwa(
      <Routes>
        <Route path="/m/directives/:id" element={<DirectiveDetailScreen />} />
      </Routes>,
      h,
      { path: `/m/directives/${uuid(1)}` },
    );
    await screen.findByTestId('pwa-back');
    await waitFor(() => expect(document.querySelector(`[data-directive="${uuid(1)}"]`)).not.toBeNull());
    const card = document.querySelector(`[data-directive="${uuid(1)}"]`) as HTMLElement;
    expect(card.textContent).toContain('Hoàn thành báo cáo số 1');
    expect(card.textContent).toContain(word('pwa.directives.progress.value', { percent: 60 }));
    expect(card.textContent).toContain(word('pwa.directives.detail.extensions.value', { count: 1, original: '2027-10-10' }));
    expect(card.querySelectorAll('[data-event]')).toHaveLength(2);
    expect(card.textContent).toContain('Đã gửi dự thảo');
    expect(card.querySelector('button')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says a directive outside the scope, or in another tenant, does not exist', async () => {
    const h = pwaClient({ read: () => new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }) });
    mountPwa(
      <Routes>
        <Route path="/m/directives/:id" element={<DirectiveDetailScreen />} />
      </Routes>,
      h,
      { path: `/m/directives/${uuid(7)}` },
    );
    expect((await screen.findByTestId('not-found')).textContent).toContain(word('pwa.directives.detail.notFound.title'));
  });
});
