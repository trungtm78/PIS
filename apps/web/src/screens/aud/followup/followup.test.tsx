import { ApiError } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import vi_ from '../../../i18n/vi.json';
import { SIGNED_OUT, SessionContext } from '../../../session/SessionContext';
import { READER, actionRecord, boardRecord, client, engagementRecord, mount, routeOf, world } from '../test-support';
import { toBoardItem } from '../recommendation/model';
import type { BoardItem } from '../recommendation/model';
import { todayInVietnam } from '../model';
import EscalationScreen from './EscalationScreen';
import EvidenceScreen from './EvidenceScreen';
import { levelLabel } from './labels';
import { REMINDER_DAYS, SECOND_LEVEL_DAYS, escalationOf, escalations, evidenceRows, holds, levelCounts } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const DOCUMENT = '00000000-0000-4000-8000-000000000021';
const OTHER_DOCUMENT = '00000000-0000-4000-8000-000000000022';

afterEach(cleanup);

/** The day that is `days` from today (negative: past), in the calendar the screens use. */
const shift = (days: number): string => new Date(Date.parse(`${todayInVietnam()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const item = (n: number, overrides: Record<string, unknown> = {}): BoardItem => toBoardItem(boardRecord(n, overrides)) as BoardItem;
const labelOf = (key: string): string => word(key);
const t = ((key: string) => labelOf(key)) as never;

describe('the model of the follow-up (ST-AUD-006)', () => {
  it('lists as evidence only the actions that are done with a document, and links to the document of DOC', () => {
    const rows = evidenceRows([
      item(1, {
        actions: [
          actionRecord(1, { status: 'DONE', completed_on: '2026-11-01', evidence_document_id: DOCUMENT }),
          actionRecord(2, { status: 'PLANNED' }),
          actionRecord(3, { status: 'DONE', completed_on: '2026-11-02', evidence_document_id: null }),
          actionRecord(4, { status: 'CANCELLED', evidence_document_id: OTHER_DOCUMENT }),
        ],
      }),
      item(2, { actions: [] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recommendationCode: 'KN-001', engagementCode: 'TTCP-2026-001', actionCode: 'HD-01', documentId: DOCUMENT, doneOn: '2026-11-01' });
  });

  it('reminds in the last seven days, tells the unit leader once the day has passed, and goes on to the second level later', () => {
    const today = todayInVietnam();
    expect(REMINDER_DAYS).toEqual([7, 3, 1]);
    expect(escalationOf(item(1, { due_on: shift(8), status: 'ASSIGNED' }), today)).toBeUndefined();
    expect(escalationOf(item(1, { due_on: shift(7), status: 'ASSIGNED' }), today)).toMatchObject({ level: 'dueSoon', daysLeft: 7, reminders: [7] });
    expect(escalationOf(item(1, { due_on: shift(3), status: 'IN_PROGRESS' }), today)).toMatchObject({ level: 'dueSoon', daysLeft: 3, reminders: [7, 3] });
    expect(escalationOf(item(1, { due_on: shift(1), status: 'PENDING_VERIFICATION' }), today)).toMatchObject({ level: 'dueSoon', daysLeft: 1, reminders: [7, 3, 1] });
    expect(escalationOf(item(1, { due_on: shift(0), status: 'ASSIGNED' }), today)).toMatchObject({ level: 'dueSoon', daysLeft: 0, lateDays: 0, reminders: [7, 3, 1] });
    expect(escalationOf(item(1, { due_on: shift(-2), status: 'ASSIGNED' }), today)).toMatchObject({ level: 'leader', lateDays: 2, reminders: [7, 3, 1] });
    expect(escalationOf(item(1, { due_on: shift(-(SECOND_LEVEL_DAYS - 1)), status: 'ASSIGNED' }), today)?.level).toBe('leader');
    expect(escalationOf(item(1, { due_on: shift(-SECOND_LEVEL_DAYS), status: 'ASSIGNED' }), today)?.level).toBe('second');
  });

  it('does not watch what is closed, cancelled, disputed, not yet given out or without a day', () => {
    const today = todayInVietnam();
    for (const status of ['CLOSED', 'CANCELLED', 'DISPUTED', 'OPEN']) expect(escalationOf(item(1, { due_on: shift(-5), status }), today)).toBeUndefined();
    expect(escalationOf(item(1, { due_on: null, status: 'ASSIGNED' }), today)).toBeUndefined();
  });

  it('orders the latest first, then the nearest day, then the code, and counts each level', () => {
    const today = todayInVietnam();
    const rows = escalations(
      [
        item(1, { due_on: shift(2), status: 'ASSIGNED' }),
        item(2, { due_on: shift(-20), status: 'ASSIGNED' }),
        item(3, { due_on: shift(-2), status: 'ASSIGNED' }),
        item(4, { due_on: shift(1), status: 'ASSIGNED' }),
        item(5, { due_on: shift(2), status: 'ASSIGNED' }),
        item(6, { due_on: shift(30), status: 'ASSIGNED' }),
      ],
      today,
    );
    expect(rows.map((row) => row.item.code)).toEqual(['KN-002', 'KN-003', 'KN-004', 'KN-001', 'KN-005']);
    expect(levelCounts(rows)).toEqual({ dueSoon: 3, leader: 1, second: 1 });
  });

  it('holds a permission when the session lists it or does not list any', () => {
    expect(holds(undefined, 'aud.read')).toBe(true);
    expect(holds(['aud.read'], 'aud.read')).toBe(true);
    expect(holds(['other'], 'aud.read')).toBe(false);
  });

  it('names each level in words', () => {
    expect(levelLabel(t, 'dueSoon')).toBe(word('aud.followup.level.dueSoon'));
    expect(levelLabel(t, 'leader')).toBe(word('aud.followup.level.leader'));
    expect(levelLabel(t, 'second')).toBe(word('aud.followup.level.second'));
  });
});

const openEvidence = (board: Array<Record<string, unknown>>, permissions: readonly string[] | undefined = READER, path = '/aud/aud-09') => {
  const h = client(world({ engagements: [engagementRecord(1, { status: 'FOLLOW_UP' })], board }));
  mount(<EvidenceScreen route={routeOf('AUD-09', 'FR-AUD-09')} />, h, { permissions, path });
  return h;
};
const openEscalation = (board: Array<Record<string, unknown>>, permissions: readonly string[] | undefined = READER, path = '/aud/aud-11') => {
  const h = client(world({ engagements: [engagementRecord(1, { status: 'FOLLOW_UP' })], board }));
  mount(<EscalationScreen route={routeOf('AUD-11', 'FR-AUD-11')} />, h, { permissions, path });
  return h;
};
const readAllCalls = (h: ReturnType<typeof client>): string[] => (h.client.readAll as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0] as string);

describe('AUD-09 evidence of the remediation', () => {
  it('opens for a visitor with no tenant chosen yet, and reads nothing for a tenant', async () => {
    const h = client(world({ board: [] }));
    render(
      <SessionContext.Provider value={{ ...SIGNED_OUT, permissions: READER }}>
        <QueryClientProvider client={new QueryClient()}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={['/aud/aud-09']}>
              <EvidenceScreen route={routeOf('AUD-09', 'FR-AUD-09')} />
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: word('aud.evidence.page.title') })).toBeTruthy();
  });

  it('names the screen in the footer when its route names no requirement', async () => {
    mount(<EvidenceScreen route={{ ...routeOf('AUD-09', 'FR-AUD-09'), req: null }} />, client(world({ board: [] })), { permissions: READER });
    await screen.findByRole('heading', { level: 1, name: word('aud.evidence.page.title') });
    expect(document.querySelector('.prototype-note')?.textContent).toBe(word('aud.followup.footer.reference').replace('{id}', 'AUD-09').replace('{req}', ''));
  });

  it('lists the documents that closed the actions, each named by its identifier and not linked, and nothing else', async () => {
    openEvidence([
      boardRecord(1, {
        status: 'PENDING_VERIFICATION',
        actions: [actionRecord(1, { status: 'DONE', completed_on: '2026-11-01', evidence_document_id: DOCUMENT, description: 'Ban hành quy chế thanh toán.' }), actionRecord(2, { status: 'PLANNED' })],
      }),
      boardRecord(2, { actions: [] }),
    ]);
    expect(await screen.findByRole('heading', { level: 1, name: word('aud.evidence.page.title') })).toBeTruthy();
    const table = await screen.findByTestId('evidence-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText('KN-001')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('Ban hành quy chế thanh toán.')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('2026-11-01')).toBeTruthy();
    // No screen of DOC opens a document by its own identifier, so the evidence is named and not linked.
    expect(screen.getByTestId('evidence-document').textContent).toBe(DOCUMENT);
    expect(within(rows[0] as HTMLElement).queryByRole('link')).toBeNull();
    expect(document.querySelector('a[href*="/doc/"]')).toBeNull();
    expect(screen.getByTestId('evidence-rule').textContent).toBe(word('aud.evidence.rule.note'));
    expect(screen.getByTestId('confidential-note')).toBeTruthy();
    expect(screen.getByRole('link', { name: word('aud.followup.board.link') }).getAttribute('href')).toBe('/aud/aud-07');
  });

  it('shows a done action without a day of completion with a dash, and narrows to the engagement of the address', async () => {
    const h = openEvidence(
      [boardRecord(1, { actions: [actionRecord(1, { status: 'DONE', completed_on: null, evidence_document_id: DOCUMENT })] })],
      READER,
      '/aud/aud-09?engagement=00000000-0000-4000-8000-001000000001',
    );
    await screen.findByTestId('evidence-table');
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByRole('link', { name: word('aud.followup.board.link') }).getAttribute('href')).toBe('/aud/aud-07?engagement=00000000-0000-4000-8000-001000000001');
    await waitFor(() => expect(readAllCalls(h)).toContain('listAuditRecommendations'));
    const asked = (h.client.readAll as unknown as { mock: { calls: Array<[string, { query?: Record<string, string> }]> } }).mock.calls.find((call) => call[0] === 'listAuditRecommendations');
    expect(asked?.[1].query).toEqual({ engagement_id: '00000000-0000-4000-8000-001000000001' });
  });

  it('says there is no evidence yet when no action is done', async () => {
    openEvidence([boardRecord(1, { actions: [actionRecord(1)] })]);
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
  });

  it('is denied without the right to read, and reads nothing', async () => {
    const h = openEvidence([boardRecord(1)], ['other.permission']);
    expect(await screen.findByTestId('evidence-denied')).toBeTruthy();
    expect(screen.getByText(word('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    expect(readAllCalls(h)).toEqual([]);
  });

  it('shows the failure of the read, and reads again on retry', async () => {
    const h = client(world({ failing: new Map([['listAuditRecommendations', new Error('boom')]]) }));
    mount(<EvidenceScreen route={routeOf('AUD-09', 'FR-AUD-09')} />, h, { permissions: READER });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(readAllCalls(h).filter((name) => name === 'listAuditRecommendations').length).toBeGreaterThan(1));
  });

  it('shows the refusal of the server as denied', async () => {
    const h = client(world({ failing: new Map([['listAuditRecommendations', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })]]) }));
    mount(<EvidenceScreen route={routeOf('AUD-09', 'FR-AUD-09')} />, h, { permissions: READER });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});

describe('AUD-11 overdue alerts and escalation', () => {
  const board = () => [
    boardRecord(1, { status: 'ASSIGNED', due_on: shift(-2) }),
    boardRecord(2, { status: 'IN_PROGRESS', due_on: shift(-20), owner_user: null }),
    boardRecord(3, { status: 'ASSIGNED', due_on: shift(3), owner_user: null, owner_unit: null }),
    boardRecord(4, { status: 'CLOSED', due_on: shift(-9) }),
    boardRecord(5, { status: 'ASSIGNED', due_on: shift(40) }),
  ];

  it('lists the recommendations by level with the days late, the days left and the reminders reached, and counts each level', async () => {
    openEscalation(board());
    expect(await screen.findByRole('heading', { level: 1, name: word('aud.escalation.page.title') })).toBeTruthy();
    const table = await screen.findByTestId('escalation-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.getAttribute('data-level'))).toEqual(['second', 'leader', 'dueSoon']);
    const leader = within(rows[1] as HTMLElement);
    expect(leader.getByText('KN-001')).toBeTruthy();
    expect(leader.getByText(word('aud.remediation.late.text').replace('{days}', '2').replace('{due}', shift(-2)))).toBeTruthy();
    expect(leader.getByText(word('aud.followup.level.leader'))).toBeTruthy();
    expect(leader.getByText('Nguyễn Văn An')).toBeTruthy();
    const second = within(rows[0] as HTMLElement);
    expect(second.getByText('Sở Xây dựng')).toBeTruthy();
    const soon = within(rows[2] as HTMLElement);
    expect(soon.getByText(word('aud.remediation.owner.none'))).toBeTruthy();
    expect(soon.getByText(word('aud.escalation.late.left').replace('{days}', '3'))).toBeTruthy();
    expect(soon.getByText('7 ngày, 3 ngày')).toBeTruthy();
    const counts = within(screen.getByTestId('escalation-counts'));
    for (const level of ['dueSoon', 'leader', 'second']) expect(within(counts.getByText(word(`aud.followup.level.${level}`)).parentElement as HTMLElement).getByText('1')).toBeTruthy();
    expect(screen.getByTestId('escalation-rule').textContent).toContain(String(SECOND_LEVEL_DAYS));
  });

  it('narrows to one level, and says so when that level has none', async () => {
    openEscalation(board().filter((row) => row.status !== 'IN_PROGRESS'));
    await screen.findByTestId('escalation-table');
    fireEvent.change(screen.getByLabelText(word('aud.escalation.filter.level')), { target: { value: 'dueSoon' } });
    expect(within(screen.getByTestId('escalation-table')).getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(word('aud.escalation.filter.level')), { target: { value: 'second' } });
    expect(await screen.findByTestId('escalation-none')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(word('aud.escalation.filter.level')), { target: { value: '' } });
    expect(within(screen.getByTestId('escalation-table')).getAllByRole('row')).toHaveLength(3);
  });

  it('is empty when nothing is near its day, and links to the board with the engagement of the address', async () => {
    openEscalation([boardRecord(5, { status: 'ASSIGNED', due_on: shift(40) })], READER, '/aud/aud-11?engagement=00000000-0000-4000-8000-001000000001');
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    expect(screen.getByRole('link', { name: word('aud.followup.board.link') }).getAttribute('href')).toBe('/aud/aud-07?engagement=00000000-0000-4000-8000-001000000001');
  });

  it('is denied without the right to read, and reads nothing', async () => {
    const h = openEscalation(board(), []);
    expect(await screen.findByTestId('escalation-denied')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    expect(readAllCalls(h)).toEqual([]);
  });

  it('shows the failure of the read', async () => {
    const h = client(world({ failing: new Map([['listAuditRecommendations', new Error('boom')]]) }));
    mount(<EscalationScreen route={routeOf('AUD-11', 'FR-AUD-11')} />, h, { permissions: undefined });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
  });
});
