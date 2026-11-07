import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import vi_ from '../../i18n/vi.json';
import IssueListScreen from './IssueListScreen';
import { READER, REPORTER, client, issue, mountIssue, person, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('ISS-01', 'FR-ISS-01');

afterEach(cleanup);

/** One row of the table per issue; the first link of a row is the code of the issue. */
const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tbody tr.ui-table__row')).filter((row) => row.querySelector('a') !== null);
const ready = () => waitFor(() => expect(cards().length).toBeGreaterThan(0));
const rowOf = (code: string): HTMLElement => screen.getByRole('link', { name: code }).closest('tr') as HTMLElement;
const show = (overrides: Partial<World> = {}, permissions: readonly string[] | undefined = READER) =>
  mountIssue(<IssueListScreen route={ROUTE} />, client(world(overrides)), { permissions, path: '/iss/iss-01' });

const ISSUES = [
  issue(1),
  issue(2, { status: 'ASSIGNED', assignee: person(2), severity: 'CRITICAL', title: 'Giấy phép xây dựng hết hạn', source_module: 'PMT' }),
  issue(3, { status: 'IN_PROGRESS', assignee: person(1), overdue_since: '2026-10-01T02:00:00.000Z', overdue_days: 3, due_at: '2026-10-02T02:00:00.000Z', escalation_level: 2 }),
];

describe('IssueListScreen (ISS-01): the issues in the scope of the signed-in member', () => {
  it('shows a row for every issue, in the order of the states, with the fields of the screen (UI-ISS-01)', async () => {
    show({ issues: ISSUES });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['iss.list.page.title']);
    expect(cards().map((row) => within(row).getAllByRole('link')[0]?.textContent)).toEqual(['VM-2026-000001', 'VM-2026-000002', 'VM-2026-000003']);
    expect(cards().map((row) => within(row).getByTestId('status').getAttribute('data-status'))).toEqual(['OPEN', 'ASSIGNED', 'IN_PROGRESS']);
    const assigned = within(rowOf('VM-2026-000002'));
    expect(assigned.getByRole('link', { name: 'VM-2026-000002' }).getAttribute('href')).toBe('/iss/iss-03?id=00000000-0000-4000-8000-a20000000002');
    expect(assigned.getByText('Giấy phép xây dựng hết hạn')).toBeTruthy();
    expect(assigned.getByTestId('severity').textContent).toBe(vi_['iss.severity.critical.text']);
    expect(assigned.getByText(/Nguyễn Văn B/)).toBeTruthy();
    expect(assigned.getByText(vi_['iss.list.card.source'].replace('{source}', vi_['iss.source.pmt.text']), { exact: false })).toBeTruthy();
    expect(within(rowOf('VM-2026-000001')).getByText(vi_['iss.list.card.unassigned'], { exact: false })).toBeTruthy();
    expect(screen.getByTestId('count').textContent).toBe(vi_['iss.list.count.text'].replace('{count}', '3'));
  });

  it('tells the deadline in words, keeps the days overdue and the level of escalation, and marks an issue that is overdue or escalated with the stripe', async () => {
    show({ issues: ISSUES });
    await ready();
    const late = within(rowOf('VM-2026-000003'));
    expect(late.getByTestId('due-state').textContent).toBe(`${vi_['iss.due.overdue.badge']} · ${vi_['iss.due.overdueDays.text'].replace('{count}', '3')}`);
    expect(late.getByText(vi_['iss.escalation.level.text'].replace('{level}', '2'), { exact: false })).toBeTruthy();
    expect(late.getByText(vi_['alerts.deadline.late'].replace('{days}', '3'))).toBeTruthy();
    expect(within(rowOf('VM-2026-000001')).getByTestId('due-state').textContent).toBe(vi_['iss.due.onTrack.badge']);
    expect(rowOf('VM-2026-000003').getAttribute('data-severity')).toBe('ACTION');
    expect(rowOf('VM-2026-000001').getAttribute('data-severity')).toBeNull();
    expect(within(rowOf('VM-2026-000003')).getByText(vi_['ui.dataTable.severityPrefix'].replace('{label}', vi_['ui.dataTable.severity.action']), { exact: false })).toBeTruthy();
  });

  it('counts the open, the overdue and the escalated issues of the scope above the table', async () => {
    show({ issues: ISSUES });
    await ready();
    const strip = within(screen.getByRole('group', { name: t('w2iss.list.kpi.label') }));
    expect(strip.getByText(t('w2iss.list.kpi.open')).closest('div')?.textContent).toContain('3');
    expect(strip.getByText(t('w2iss.list.kpi.overdue')).closest('div')?.textContent).toContain('1');
    expect(strip.getByText(t('w2iss.list.kpi.escalated')).closest('div')?.textContent).toContain('1');
  });

  it('pages the rows, and goes back to the first page when a filter narrows the list', async () => {
    const many = Array.from({ length: 25 }, (_, n) => issue(n + 10, { title: `Vướng mắc số ${n + 10}` }));
    show({ issues: many });
    await ready();
    const user = userEvent.setup();
    expect(cards()).toHaveLength(20);
    expect(screen.getByText(vi_['ui.tablePager.range'].replace('{from}', '1').replace('{to}', '20').replace('{total}', '25'))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: vi_['ui.tablePager.next'] }));
    expect(cards()).toHaveLength(5);
    fireEvent.change(screen.getByLabelText(vi_['iss.list.query.label']), { target: { value: 'số 10' } });
    expect(cards()).toHaveLength(1);
    expect(screen.getByText(vi_['ui.tablePager.range'].replace('{from}', '1').replace('{to}', '1').replace('{total}', '1'))).toBeTruthy();
  });

  it('filters by status, severity, the person it is given to, the overdue ones and a search text', async () => {
    show({ issues: ISSUES });
    await ready();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['iss.list.status.label']), 'ASSIGNED');
    expect(cards().map((card) => card.getAttribute('data-issue-id'))).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText(vi_['iss.list.status.label']), '');
    await user.selectOptions(screen.getByLabelText(vi_['iss.list.severity.label']), 'CRITICAL');
    expect(cards()).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText(vi_['iss.list.severity.label']), '');
    await user.click(screen.getByLabelText(vi_['iss.list.mine.label']));
    expect(within(cards()[0] as HTMLElement).getByRole('link').textContent).toBe('VM-2026-000003');
    expect(cards()).toHaveLength(1);
    await user.click(screen.getByLabelText(vi_['iss.list.mine.label']));
    await user.click(screen.getByLabelText(vi_['iss.list.overdue.label']));
    expect(cards()).toHaveLength(1);
    await user.click(screen.getByLabelText(vi_['iss.list.overdue.label']));
    fireEvent.change(screen.getByLabelText(vi_['iss.list.query.label']), { target: { value: 'giay phep' } });
    expect(cards()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(vi_['iss.list.query.label']), { target: { value: 'không có gì khớp' } });
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['iss.list.noMatch.notice']);
    expect(screen.getByTestId('count').textContent).toBe(vi_['iss.list.count.text'].replace('{count}', '0'));
  });

  it('says when there is no issue in the scope, and when the read fails offers to try again', async () => {
    show({ issues: [] });
    expect((await screen.findByTestId('empty-issues')).textContent).toBe(vi_['iss.list.empty.text']);
    cleanup();
    const state = world({ issues: ISSUES, failing: new Set(['get_resources_issue']) });
    mountIssue(<IssueListScreen route={ROUTE} />, client(state), { permissions: READER, path: '/iss/iss-01' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(cards()).toHaveLength(3);
  });

  it('offers to report an issue only to those who may, and not while the system is read-only', async () => {
    show({ issues: ISSUES }, REPORTER);
    await ready();
    expect(screen.getByRole('link', { name: vi_['iss.list.create.action'] }).getAttribute('href')).toBe('/iss/iss-02');
    cleanup();
    show({ issues: ISSUES }, READER);
    await ready();
    expect(screen.queryByRole('link', { name: vi_['iss.list.create.action'] })).toBeNull();
    cleanup();
    mountIssue(<IssueListScreen route={ROUTE} />, client(world({ issues: ISSUES })), { permissions: REPORTER, mode: 'READ_ONLY', path: '/iss/iss-01' });
    await ready();
    expect(screen.queryByRole('link', { name: vi_['iss.list.create.action'] })).toBeNull();
  });
});
