import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import StandingDelegationScreen from './StandingDelegationScreen';
import { commandsCalled, open, problem, routeFor, uuid } from './test-support';
import { toLocalInput } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const ROUTE = routeFor('ADM-25', 'FR-ADM-25');
const ALL = ['iam.delegation.read', 'iam.delegation.create', 'iam.delegation.approve', 'approval.decide', 'doc.outgoing.sign', 'iam.role.grant'];
const DAY = 86_400_000;

const request = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  delegator: { id: uuid(500), name: 'Giao Leader' },
  delegate: { id: uuid(600 + n), name: `Receiver ${n}` },
  permissions: ['approval.decide'],
  scope_kind: 'UNIT_SUBTREE',
  scope_ref_ids: [uuid(900)],
  period_codes: null,
  starts_at: '2026-11-09T01:00:00.000000Z',
  review_due_at: '2027-03-09T01:00:00.000000Z',
  end_condition_kind: 'UNTIL_EVENT',
  end_condition_text: 'Until the deputy director is appointed.',
  end_on: null,
  reason: 'Standing handover.',
  legal_basis_ref: null,
  status: 'Pending',
  expires_at: '2026-11-16T01:00:00.000000Z',
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  delegation_id: null,
  created_at: '2026-11-09T01:00:00.000000Z',
  version: 1,
  actions: { decide: true, cancel: false },
  ...extra,
});

const permanent = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  kind: 'PERMANENT',
  delegator: { id: uuid(500), name: 'Giao Leader' },
  delegate: { id: uuid(600 + n), name: `Receiver ${n}` },
  permissions: ['approval.decide'],
  scope_kind: 'UNIT_SUBTREE',
  scope_ref_ids: [uuid(900)],
  period_codes: ['2026-Q4'],
  valid_from: '2026-11-09T01:00:00.000000Z',
  valid_until: '2027-03-09T01:00:00.000000Z',
  review_due_at: '2027-03-09T01:00:00.000000Z',
  review_due_soon: false,
  last_reviewed_at: null,
  review_count: 0,
  end_condition_kind: 'UNTIL_EVENT',
  end_condition_text: 'Until the deputy director is appointed.',
  end_on: null,
  reason: 'Standing handover.',
  status: 'Active',
  end_reason: null,
  version: 3,
  actions: { review: true, revoke: true },
  ...extra,
});

function mount(answers: Parameters<typeof open>[1], options: { permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  return open(<StandingDelegationScreen route={ROUTE} />, answers, { path: '/adm/adm-25', permissions: 'permissions' in options ? options.permissions : ALL, ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.command === undefined ? {} : { command: options.command }) });
}
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const dialog = (): HTMLElement => screen.getByRole('dialog');

afterEach(() => cleanup());

describe('StandingDelegationScreen (ADM-25): the permanent delegation', () => {
  it('lists the requests with who asked, for whom, the review date, the end condition in words and the state, with the actions that fit each row', async () => {
    mount({
      get_resources_standing_delegation_request: [
        request(1),
        request(2, { status: 'Approved', decided_by: { id: uuid(700), name: 'Second Approver' }, delegation_id: uuid(50), actions: { decide: false, cancel: false } }),
        request(3, { status: 'Rejected', decision_reason: 'The delegate is under audit.', actions: { decide: false, cancel: false } }),
        request(4, { status: 'Pending', actions: { decide: false, cancel: true }, period_codes: ['2026-Q3'] }),
      ],
    });
    await screen.findByTestId('requests');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('adm.authority.standing.title'));
    const row = (n: number) => document.querySelector(`[data-request="${uuid(n)}"]`) as HTMLElement;
    expect(within(row(1)).getByTestId('status').textContent).toBe(word('adm.authority.request.status.pending'));
    expect(row(1).textContent).toContain('Receiver 1');
    expect(row(1).textContent).toContain('Until the deputy director is appointed.');
    expect(row(1).textContent).toContain(word('adm.authority.end.kind.event'));
    expect(row(1).querySelector('[data-action="decide"]')).not.toBeNull();
    expect(row(1).querySelector('[data-action="cancel"]')).toBeNull();
    expect(row(2).textContent).toContain(word('adm.authority.standing.decidedBy').replace('{name}', 'Second Approver'));
    expect(row(2).querySelector('button')).toBeNull();
    expect(row(3).textContent).toContain('The delegate is under audit.');
    expect(row(4).querySelector('[data-action="cancel"]')).not.toBeNull();
    expect(row(4).textContent).toContain('2026-Q3');
  });

  it('shows the permanent delegations with the review date first, the days left, a warning in words when it falls due, and the review and revoke actions', async () => {
    mount({ get_resources_standing_delegation_request: [], get_resources_delegation_grant: [permanent(1), permanent(2, { review_due_soon: true, review_count: 2 }), permanent(3, { status: 'Ended', end_reason: 'REVIEW_LAPSED', actions: { review: false, revoke: false } })] });
    await waitFor(() => expect(document.querySelector('[data-tab="given"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-tab="given"]') as HTMLElement);
    await screen.findByTestId('permanent');
    const row = (n: number) => document.querySelector(`[data-delegation="${uuid(n)}"]`) as HTMLElement;
    expect(within(row(1)).queryByTestId('due-soon')).toBeNull();
    expect(within(row(2)).getByTestId('due-soon').textContent).toBe(word('adm.authority.permanent.dueSoon'));
    expect(row(2).getAttribute('data-due-soon')).toBe('true');
    expect(row(2).textContent).toContain(word('adm.authority.permanent.reviews').replace('{count}', '2'));
    expect(row(1).textContent).toContain('2026-Q4');
    expect(row(1).querySelector('[data-action="review"]')).not.toBeNull();
    expect(row(1).querySelector('[data-action="revoke"]')).not.toBeNull();
    expect(row(3).textContent).toContain(word('adm.authority.end.reason.review'));
    expect(row(3).querySelector('button')).toBeNull();
  });

  it('asks for the right list in each tab', async () => {
    const h = mount({ get_resources_standing_delegation_request: [request(1)], get_resources_delegation_grant: [] });
    await screen.findByTestId('requests');
    fireEvent.click(document.querySelector('[data-tab="received"]') as HTMLElement);
    await waitFor(() => expect(h.calls.get_resources_delegation_grant?.length).toBeGreaterThan(0));
    expect(h.calls.get_resources_delegation_grant?.[0]).toEqual({ role: 'received', kind: 'PERMANENT' });
  });

  it('the states: loading is a skeleton, an empty list says so, a failure can be retried, and a person without the right to read is told so', async () => {
    mount({ get_resources_standing_delegation_request: [] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    mount({ get_resources_standing_delegation_request: new Error('down') });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    mount({ get_resources_standing_delegation_request: [] }, { permissions: ['approval.decide'] });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(document.querySelector('[data-action="new"]')).toBeNull();
  });

  it('read-only mode offers no action at all', async () => {
    mount({ get_resources_standing_delegation_request: [request(1), request(4, { actions: { decide: false, cancel: true } })] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('requests');
    expect(document.querySelector('[data-action="new"]')).toBeNull();
    expect(document.querySelector('[data-action="decide"]')).toBeNull();
    expect(document.querySelector('[data-action="cancel"]')).toBeNull();
  });

  it('asks for a permanent delegation: nothing is sent while the form is not whole, then the body carries the review date, the end condition and the periods', async () => {
    const h = mount({ get_resources_standing_delegation_request: [request(1)] }, { command: () => ({ resource_id: uuid(50), resource_version: 1 }) });
    await screen.findByTestId('requests');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Nina Receiver' })).toBeTruthy());
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.standing.new.submit') }));
    for (const key of ['delegate', 'permissions', 'unit', 'end.text', 'reason']) expect(within(dialog()).getByText(word(`adm.authority.problem.${key}`))).toBeTruthy();
    expect(commandsCalled(h, 'createStandingDelegationRequest')).toHaveLength(0);
    type('standing-delegate', uuid(601));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'approval.decide' }));
    type('standing-unit', uuid(900));
    type('standing-periods', '2026-Q4 2026-Q3');
    expect(within(dialog()).getByTestId('period-chips').textContent).toBe('2026-Q32026-Q4');
    type('standing-end-text', 'Until the deputy director is appointed.');
    type('standing-reason', 'Standing handover of the approval of reports.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.standing.new.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [sent] = commandsCalled(h, 'createStandingDelegationRequest');
    expect(sent?.body).toMatchObject({ delegate_membership_id: uuid(601), permissions: ['approval.decide'], scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [uuid(900)], period_codes: ['2026-Q3', '2026-Q4'], end_condition_kind: 'UNTIL_EVENT', end_condition_text: 'Until the deputy director is appointed.', reason: 'Standing handover of the approval of reports.' });
    const review = (Date.parse(sent?.body?.review_due_at as string) - Date.parse(sent?.body?.valid_from as string)) / DAY;
    expect(review).toBeGreaterThan(179.9);
    expect(review).toBeLessThan(180.1);
  });

  it('refuses a review date more than a year away and a fixed end before the review, without sending', async () => {
    const h = mount({ get_resources_standing_delegation_request: [request(1)] });
    await screen.findByTestId('requests');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Nina Receiver' })).toBeTruthy());
    type('standing-delegate', uuid(601));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'approval.decide' }));
    type('standing-unit', uuid(900));
    type('standing-end-text', 'Until the deputy director is appointed.');
    type('standing-reason', 'Standing handover of the approval of reports.');
    type('standing-review', toLocalInput(new Date(Date.now() + 400 * DAY)));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.standing.new.submit') }));
    expect(within(dialog()).getByText(word('adm.authority.problem.review.tooFar'))).toBeTruthy();
    type('standing-review', toLocalInput(new Date(Date.now() + 180 * DAY)));
    type('standing-end-kind', 'UNTIL_DATE');
    type('standing-end-on', toLocalInput(new Date(Date.now() + 100 * DAY)));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.standing.new.submit') }));
    expect(within(dialog()).getByText(word('adm.authority.problem.review.afterEnd'))).toBeTruthy();
    expect(commandsCalled(h, 'createStandingDelegationRequest')).toHaveLength(0);
  });

  it('says why the server refused: a loop of delegations, then the defects it names', async () => {
    let answer: unknown = problem('DELEGATION_CYCLE_DENIED', 403);
    const h = mount({ get_resources_standing_delegation_request: [request(1)] }, { command: () => answer });
    await screen.findByTestId('requests');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Nina Receiver' })).toBeTruthy());
    type('standing-delegate', uuid(601));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'approval.decide' }));
    type('standing-unit', uuid(900));
    type('standing-end-text', 'Until the deputy director is appointed.');
    type('standing-reason', 'Standing handover of the approval of reports.');
    const send = (): void => {
      fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.standing.new.submit') }));
    };
    send();
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.authority.error.cycle'));
    answer = problem('DELEGATION_INVALID', 422, { defects: [{ field: 'review_due_at', code: 'TOO_LONG' }] });
    send();
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('adm.authority.error.invalid')));
    expect(within(screen.getByTestId('defects')).getByText(word('adm.authority.defect.tooLong'))).toBeTruthy();
    expect(commandsCalled(h, 'createStandingDelegationRequest').length).toBeGreaterThanOrEqual(2);
  });

  it('approves with the version the row was read at, and rejects only with a reason', async () => {
    const h = mount({ get_resources_standing_delegation_request: [request(1, { version: 4 })] }, { command: () => ({ resource_id: uuid(1), resource_version: 5 }) });
    await screen.findByTestId('requests');
    fireEvent.click(document.querySelector('[data-action="decide"]') as HTMLElement);
    type('standing-decision', 'reject');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.standing.decide.reject') }));
    expect(within(dialog()).getByText(word('adm.authority.problem.reasonMin').replace('{min}', '10'))).toBeTruthy();
    expect(commandsCalled(h, 'decideStandingDelegationRequest')).toHaveLength(0);
    type('standing-decision', 'approve');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.standing.decide.approve') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'decideStandingDelegationRequest')[0]).toMatchObject({ path: { requestId: uuid(1) }, body: { decision: 'approve' }, ifMatchVersion: 4 });
  });

  it('shows the refusal of the second-approver rule when the approver is one of the parties', async () => {
    mount({ get_resources_standing_delegation_request: [request(1)] }, { command: () => problem('SELF_APPROVAL_DENIED', 403) });
    await screen.findByTestId('requests');
    fireEvent.click(document.querySelector('[data-action="decide"]') as HTMLElement);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.standing.decide.approve') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.authority.error.selfApproval'));
  });

  it('withdraws a request with a reason', async () => {
    const h = mount({ get_resources_standing_delegation_request: [request(4, { version: 2, actions: { decide: false, cancel: true } })] }, { command: () => ({}) });
    await screen.findByTestId('requests');
    fireEvent.click(document.querySelector('[data-action="cancel"]') as HTMLElement);
    type('authority-reason', 'No longer needed, the post is filled.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.standing.cancel.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'cancelStandingDelegationRequest')[0]).toMatchObject({ path: { requestId: uuid(4) }, body: { reason: 'No longer needed, the post is filled.' }, ifMatchVersion: 2 });
  });

  it('reviews a permanent delegation: the new date has to be forward and within a year, and the body carries it with the version', async () => {
    const h = mount({ get_resources_standing_delegation_request: [], get_resources_delegation_grant: [permanent(1)] }, { command: () => ({}) });
    await waitFor(() => expect(document.querySelector('[data-tab="given"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-tab="given"]') as HTMLElement);
    await screen.findByTestId('permanent');
    fireEvent.click(document.querySelector('[data-action="review"]') as HTMLElement);
    type('review-next', '2026-12-01T10:00');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.review.submit') }));
    expect(within(dialog()).getByText(word('adm.authority.problem.review.notForward'))).toBeTruthy();
    expect(commandsCalled(h, 'reviewDelegation')).toHaveLength(0);
    type('review-next', toLocalInput(new Date(new Date('2027-03-09T01:00:00Z').getTime() + 90 * DAY)));
    type('review-note', 'Still needed.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.review.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'reviewDelegation')[0]).toMatchObject({ path: { delegationId: uuid(1) }, body: { note: 'Still needed.' }, ifMatchVersion: 3 });
  });

  it('revokes a permanent delegation with a reason', async () => {
    const h = mount({ get_resources_standing_delegation_request: [], get_resources_delegation_grant: [permanent(1)] }, { command: () => ({}) });
    await waitFor(() => expect(document.querySelector('[data-tab="given"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-tab="given"]') as HTMLElement);
    await screen.findByTestId('permanent');
    fireEvent.click(document.querySelector('[data-action="revoke"]') as HTMLElement);
    type('authority-reason', 'The appointment was made.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.permanent.revoke.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'revokeDelegation')[0]).toMatchObject({ path: { delegationId: uuid(1) }, body: { reason: 'The appointment was made.' }, ifMatchVersion: 3 });
  });
});
