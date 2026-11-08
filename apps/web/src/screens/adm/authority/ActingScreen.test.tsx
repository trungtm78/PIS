import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ActingScreen from './ActingScreen';
import { commandsCalled, open, problem, routeFor, uuid } from './test-support';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const ROUTE = routeFor('ADM-26', 'FR-ADM-26');
const ALL = ['iam.acting.read', 'iam.acting.request', 'iam.acting.approve', 'iam.acting.revoke'];

const grant = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  requester: { id: uuid(500), name: 'Admin Quan' },
  subject: { id: uuid(600 + n), name: `Person ${n}` },
  permissions: ['dis.report.submit'],
  period_codes: null,
  hours: 4,
  reason: 'The reporter is in hospital and the report is due.',
  status: 'Pending',
  phase: 'PENDING',
  requested_at: '2026-11-09T01:00:00.000000Z',
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  window_start: null,
  window_end: null,
  revoked_at: null,
  revoke_reason: null,
  version: 1,
  actions: { decide: true, cancel: false, revoke: false },
  ...extra,
});

function mount(answers: Parameters<typeof open>[1], options: { permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  return open(<ActingScreen route={ROUTE} />, answers, { path: '/adm/adm-26', permissions: 'permissions' in options ? options.permissions : ALL, ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.command === undefined ? {} : { command: options.command }) });
}
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const dialog = (): HTMLElement => screen.getByRole('dialog');

afterEach(() => cleanup());

describe('ActingScreen (ADM-26): an administrator acting on behalf of a person', () => {
  it('lists the sessions with the person, who asked, the permissions, the window and the phase, and the actions that fit each row', async () => {
    mount({
      get_resources_acting_grant: [
        grant(1),
        grant(2, { status: 'Approved', phase: 'ACTIVE', decided_by: { id: uuid(700), name: 'Second Approver' }, window_start: '2026-11-09T02:00:00.000000Z', window_end: new Date(Date.now() + 90 * 60_000).toISOString(), actions: { decide: false, cancel: false, revoke: true } }),
        grant(3, { status: 'Revoked', phase: 'REVOKED', revoke_reason: 'The reporter is back at work.', actions: { decide: false, cancel: false, revoke: false } }),
        grant(4, { actions: { decide: false, cancel: true, revoke: false }, period_codes: ['2026-Q3'] }),
      ],
    });
    await screen.findByTestId('acting');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('adm.authority.acting.title'));
    const row = (n: number) => document.querySelector(`[data-grant="${uuid(n)}"]`) as HTMLElement;
    expect(within(row(1)).getByTestId('status').textContent).toBe(word('adm.authority.acting.phase.pending'));
    expect(within(row(2)).getByTestId('status').textContent).toBe(word('adm.authority.acting.phase.active'));
    expect(row(1).textContent).toContain('dis.report.submit');
    expect(row(1).querySelector('[data-action="decide"]')).not.toBeNull();
    expect(row(2).querySelector('[data-action="revoke"]')).not.toBeNull();
    expect(row(2).textContent).toContain(word('adm.authority.acting.approvedBy').replace('{name}', 'Second Approver'));
    expect(row(3).textContent).toContain('The reporter is back at work.');
    expect(row(3).querySelector('button')).toBeNull();
    expect(row(4).querySelector('[data-action="cancel"]')).not.toBeNull();
    expect(row(4).textContent).toContain('2026-Q3');
  });

  it('says out loud that a session is in force, for whom, and how many minutes are left, and says what acting is not for', async () => {
    mount({ get_resources_acting_grant: [grant(2, { status: 'Approved', phase: 'ACTIVE', window_start: '2026-11-09T02:00:00.000000Z', window_end: new Date(Date.now() + 90 * 60_000).toISOString(), actions: { decide: false, cancel: false, revoke: true } }), grant(1)] });
    await screen.findByTestId('acting');
    const banners = screen.getAllByTestId('acting-banner');
    expect(banners).toHaveLength(1);
    expect(banners[0]?.textContent).toMatch(/Person 2/);
    expect(banners[0]?.textContent).toMatch(/8\d|9\d/);
    expect(screen.getByTestId('acting-note').textContent).toBe(word('adm.authority.acting.note'));
  });

  it('the states: an empty list says so, a failure is shown, a person without the right to read is told so, and read-only mode offers no action', async () => {
    mount({ get_resources_acting_grant: [] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    mount({ get_resources_acting_grant: new Error('down') });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    mount({ get_resources_acting_grant: [] }, { permissions: [] });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    mount({ get_resources_acting_grant: [grant(1), grant(4, { actions: { decide: false, cancel: true, revoke: false } })] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('acting');
    expect(document.querySelector('[data-action="new"]')).toBeNull();
    expect(document.querySelector('[data-action="decide"]')).toBeNull();
    expect(document.querySelector('[data-action="cancel"]')).toBeNull();
  });

  it('asks to act for a person: the permissions that decide, sign or administer are refused in the form, by name, and nothing is sent', async () => {
    const h = mount({ get_resources_acting_grant: [grant(1)] }, { command: () => ({ resource_id: uuid(50), resource_version: 1 }) });
    await screen.findByTestId('acting');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Nina Receiver' })).toBeTruthy());
    type('acting-subject', uuid(601));
    type('acting-permissions', 'dis.report.submit\napproval.decide, iam.role.grant dis.*');
    type('acting-reason', 'The reporter is in hospital and the weekly report is due today.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.acting.new.submit') }));
    const refused = within(dialog()).getByTestId('refused');
    expect(refused.querySelector('[data-permission="approval.decide"]')?.textContent).toContain(word('adm.authority.refused.decision'));
    expect(refused.querySelector('[data-permission="iam.role.grant"]')?.textContent).toContain(word('adm.authority.refused.administrative'));
    expect(refused.querySelector('[data-permission="dis.*"]')?.textContent).toContain(word('adm.authority.refused.wildcard'));
    expect(commandsCalled(h, 'requestActing')).toHaveLength(0);
  });

  it('sends the person, the permissions as a list, the hours as a number and the reason, then closes', async () => {
    const h = mount({ get_resources_acting_grant: [grant(1)] }, { command: () => ({ resource_id: uuid(50), resource_version: 1 }) });
    await screen.findByTestId('acting');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Nina Receiver' })).toBeTruthy());
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.acting.new.submit') }));
    for (const key of ['subject', 'permissions', 'actingReason']) expect(within(dialog()).getByText(word(`adm.authority.problem.${key}`))).toBeTruthy();
    type('acting-subject', uuid(601));
    type('acting-permissions', 'dis.report.submit, dis.report.edit');
    type('acting-hours', '6');
    type('acting-periods', '2026-Q3');
    type('acting-reason', 'The reporter is in hospital and the weekly report is due today.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.acting.new.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'requestActing')[0]?.body).toEqual({ subject_membership_id: uuid(601), permissions: ['dis.report.submit', 'dis.report.edit'], hours: 6, reason: 'The reporter is in hospital and the weekly report is due today.', period_codes: ['2026-Q3'] });
  });

  it('says why the server refused: acting for oneself, a permission the person does not hold, and the defects', async () => {
    let answer: unknown = problem('ACTING_SELF_DENIED', 403);
    mount({ get_resources_acting_grant: [grant(1)] }, { command: () => answer });
    await screen.findByTestId('acting');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Nina Receiver' })).toBeTruthy());
    type('acting-subject', uuid(601));
    type('acting-permissions', 'dis.report.submit');
    type('acting-reason', 'The reporter is in hospital and the weekly report is due today.');
    const send = (): void => {
      fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.acting.new.submit') }));
    };
    send();
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.authority.error.actingSelf'));
    answer = problem('ACTING_INVALID', 422, { defects: [{ field: 'permissions[0]', code: 'DECISION' }] });
    send();
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('adm.authority.error.actingInvalid')));
    expect(within(screen.getByTestId('defects')).getByText(word('adm.authority.defect.decision'))).toBeTruthy();
  });

  it('decides: shows what is asked, approves with the version of the row, and rejects only with a reason', async () => {
    const h = mount({ get_resources_acting_grant: [grant(1, { version: 3, permissions: ['dis.report.submit', 'dis.report.edit'] })] }, { command: () => ({}) });
    await screen.findByTestId('acting');
    fireEvent.click(document.querySelector('[data-action="decide"]') as HTMLElement);
    expect(within(dialog()).getByTestId('decide-permissions').textContent).toBe('dis.report.submit, dis.report.edit');
    type('acting-decision', 'reject');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.acting.decide.reject') }));
    expect(within(dialog()).getByText(word('adm.authority.problem.reasonMin').replace('{min}', '10'))).toBeTruthy();
    expect(commandsCalled(h, 'decideActingRequest')).toHaveLength(0);
    type('acting-decision', 'approve');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.acting.decide.approve') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'decideActingRequest')[0]).toMatchObject({ path: { actingId: uuid(1) }, body: { decision: 'approve' }, ifMatchVersion: 3 });
  });

  it('shows the refusal of the second-approver rule', async () => {
    mount({ get_resources_acting_grant: [grant(1)] }, { command: () => problem('SELF_APPROVAL_DENIED', 403) });
    await screen.findByTestId('acting');
    fireEvent.click(document.querySelector('[data-action="decide"]') as HTMLElement);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.acting.decide.approve') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.authority.error.selfApproval'));
  });

  it('withdraws a request and revokes a session, each with a reason and the version of the row', async () => {
    const h = mount(
      { get_resources_acting_grant: [grant(4, { version: 2, actions: { decide: false, cancel: true, revoke: false } }), grant(2, { version: 5, status: 'Approved', phase: 'ACTIVE', window_start: '2026-11-09T02:00:00.000000Z', window_end: new Date(Date.now() + 3_600_000).toISOString(), actions: { decide: false, cancel: false, revoke: true } })] },
      { command: () => ({}) },
    );
    await screen.findByTestId('acting');
    fireEvent.click(document.querySelector('[data-action="cancel"]') as HTMLElement);
    type('authority-reason', 'The report was filed already.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.acting.cancel.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'cancelActingRequest')[0]).toMatchObject({ path: { actingId: uuid(4) }, body: { reason: 'The report was filed already.' }, ifMatchVersion: 2 });
    fireEvent.click(document.querySelector('[data-action="revoke"]') as HTMLElement);
    type('authority-reason', 'The reporter is back at work.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.acting.revoke.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'revokeActing')[0]).toMatchObject({ path: { actingId: uuid(2) }, body: { reason: 'The reporter is back at work.' }, ifMatchVersion: 5 });
  });
});
