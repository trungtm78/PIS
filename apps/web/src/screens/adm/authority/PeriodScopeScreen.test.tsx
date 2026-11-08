import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import PeriodScopeScreen from './PeriodScopeScreen';
import { commandsCalled, open, problem, routeFor, uuid } from './test-support';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const ROUTE = routeFor('ADM-27', 'FR-ADM-27');
const ALL = ['role_grant.read', 'iam.role.grant'];

const scope = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  role_grant_id: uuid(300 + n),
  member: { id: uuid(601), name: 'Nina Receiver' },
  role_code: 'REPORTER',
  period_codes: ['2026-Q3', '2026-Q4'],
  reason: 'The reporter covers the second half only.',
  status: 'Active',
  set_by: uuid(500),
  set_at: '2026-11-09T01:00:00.000000Z',
  lifted_by: null,
  lifted_at: null,
  lift_reason: null,
  version: 2,
  actions: { lift: true },
  ...extra,
});
const GRANTS = [
  { id: uuid(301), membership_id: uuid(601), role_code: 'REPORTER', status: 'Active' },
  { id: uuid(302), membership_id: uuid(602), role_code: 'OLD', status: 'Revoked' },
];

function mount(answers: Parameters<typeof open>[1], options: { permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  return open(<PeriodScopeScreen route={ROUTE} />, { get_resources_role_grant: GRANTS, ...answers }, { path: '/adm/adm-27', permissions: 'permissions' in options ? options.permissions : ALL, ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.command === undefined ? {} : { command: options.command }) });
}
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const dialog = (): HTMLElement => screen.getByRole('dialog');

afterEach(() => cleanup());

describe('PeriodScopeScreen (ADM-27): the limit of a role grant to report periods', () => {
  it('lists the limits with the holder, the role, the periods as chips, the reason and the state, with a lift on the ones in force', async () => {
    const h = mount({ get_resources_period_scope: [scope(1), scope(2, { period_codes: ['2026'], actions: { lift: false } })] });
    await screen.findByTestId('scopes');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('adm.authority.scopes.title'));
    const row = (n: number) => document.querySelector(`[data-scope="${uuid(n)}"]`) as HTMLElement;
    expect(row(1).textContent).toContain('Nina Receiver');
    expect(row(1).textContent).toContain('REPORTER');
    expect(Array.from(row(1).querySelectorAll('.authority-chip')).map((chip) => chip.textContent)).toEqual(['2026-Q3', '2026-Q4']);
    expect(within(row(1)).getByTestId('status').textContent).toBe(word('adm.authority.scopes.status.active'));
    expect(row(1).querySelector('[data-action="lift"]')).not.toBeNull();
    expect(row(2).querySelector('[data-action="lift"]')).toBeNull();
    expect(screen.getByTestId('scopes-note').textContent).toBe(word('adm.authority.scopes.note'));
    expect(h.calls.get_resources_period_scope?.[0]).toEqual({ status: 'Active' });
  });

  it('shows the lifted limits in the other tab, with the reason they were lifted', async () => {
    const h = mount({ get_resources_period_scope: [scope(1)] });
    await screen.findByTestId('scopes');
    h.answers.get_resources_period_scope = [scope(3, { status: 'Lifted', lifted_at: '2026-11-10T01:00:00.000000Z', lift_reason: 'The reporter covers every period again.', actions: { lift: false } })];
    fireEvent.click(document.querySelector('[data-tab="Lifted"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector(`[data-scope="${uuid(3)}"]`)).not.toBeNull());
    const row = document.querySelector(`[data-scope="${uuid(3)}"]`) as HTMLElement;
    expect(row.textContent).toContain('The reporter covers every period again.');
    expect(row.querySelector('button')).toBeNull();
    expect(h.calls.get_resources_period_scope?.[1]).toEqual({ status: 'Lifted' });
  });

  it('the states: an empty list says so, a failure is shown, a person without the right to read is told so, and read-only mode offers no action', async () => {
    mount({ get_resources_period_scope: [] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    mount({ get_resources_period_scope: new Error('down') });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    mount({ get_resources_period_scope: [] }, { permissions: [] });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    mount({ get_resources_period_scope: [scope(1)] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('scopes');
    expect(document.querySelector('[data-action="new"]')).toBeNull();
    expect(document.querySelector('[data-action="lift"]')).toBeNull();
  });

  it('sets a limit on an active grant: periods that are malformed or inside another are told apart, and the body carries the sorted periods', async () => {
    const h = mount({ get_resources_period_scope: [scope(1)] }, { command: () => ({ resource_id: uuid(50), resource_version: 1 }) });
    await screen.findByTestId('scopes');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: /Nina Receiver - REPORTER/ })).toBeTruthy());
    // A revoked grant is not offered.
    expect(within(dialog()).queryByRole('option', { name: /OLD/ })).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.scopes.new.submit') }));
    for (const key of ['grant', 'period.required', 'reason']) expect(within(dialog()).getByText(word(`adm.authority.problem.${key}`))).toBeTruthy();
    type('scope-grant', uuid(301));
    type('scope-reason', 'The reporter covers the second half only.');
    type('scope-periods', 'Q3-2026');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.scopes.new.submit') }));
    expect(within(dialog()).getByText(word('adm.authority.problem.period.malformed'))).toBeTruthy();
    type('scope-periods', '2026 2026-Q3');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.scopes.new.submit') }));
    expect(within(dialog()).getByText(word('adm.authority.problem.period.overlap'))).toBeTruthy();
    expect(commandsCalled(h, 'createPeriodScope')).toHaveLength(0);
    type('scope-periods', '2026-Q4, 2026-Q3');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.scopes.new.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'createPeriodScope')[0]?.body).toEqual({ role_grant_id: uuid(301), period_codes: ['2026-Q3', '2026-Q4'], reason: 'The reporter covers the second half only.' });
  });

  it('says why the server refused: a limit already in force, the holder themselves, and the defects', async () => {
    let answer: unknown = problem('PERIOD_SCOPE_STATE_INVALID', 409);
    mount({ get_resources_period_scope: [scope(1)] }, { command: () => answer });
    await screen.findByTestId('scopes');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: /Nina Receiver - REPORTER/ })).toBeTruthy());
    type('scope-grant', uuid(301));
    type('scope-periods', '2026-Q3');
    type('scope-reason', 'The reporter covers the third quarter only.');
    const send = (): void => {
      fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.scopes.new.submit') }));
    };
    send();
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.authority.error.periodState'));
    answer = problem('SELF_GRANT_DENIED', 403);
    send();
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('adm.authority.error.self')));
    answer = problem('PERIOD_SCOPE_INVALID', 422, { defects: [{ field: 'period_codes[0]', code: 'OVERLAP' }] });
    send();
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('adm.authority.error.periodInvalid')));
    expect(within(screen.getByTestId('defects')).getByText(word('adm.authority.defect.overlap'))).toBeTruthy();
  });

  it('lifts a limit with a reason and the version of the row, and says that it widens authority', async () => {
    const h = mount({ get_resources_period_scope: [scope(1)] }, { command: () => ({}) });
    await screen.findByTestId('scopes');
    fireEvent.click(document.querySelector('[data-action="lift"]') as HTMLElement);
    expect(within(dialog()).getByText(word('adm.authority.scopes.lift.text').replace('{name}', 'Nina Receiver').replace('{role}', 'REPORTER'))).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.scopes.lift.submit') }));
    expect(within(dialog()).getByText(word('adm.authority.problem.reasonMin').replace('{min}', '10'))).toBeTruthy();
    expect(commandsCalled(h, 'liftPeriodScope')).toHaveLength(0);
    type('authority-reason', 'The reporter covers every period again.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.authority.scopes.lift.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'liftPeriodScope')[0]).toMatchObject({ path: { scopeId: uuid(1) }, body: { reason: 'The reporter covers every period again.' }, ifMatchVersion: 2 });
  });
});
