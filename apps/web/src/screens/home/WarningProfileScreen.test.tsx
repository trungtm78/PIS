import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import WarningProfileScreen from './WarningProfileScreen';
import { warningBody } from './WarningsScreen.test';

const ROUTE = routeOf('HOME-06', 'FR-HOME-06');
const W1 = '00000000-0000-4000-8000-000000000a01';
const P1 = '00000000-0000-4000-8000-000000000b01';
const LEADER = '00000000-0000-4000-8000-000000000001';
const S40 = '00000000-0000-4000-8000-0000000000f2';
const ALL = ['home.read', 'explanation.request', 'warning.handle'];
const OPEN = `/?warning=${W1}`;

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const OK = { operation_id: '00000000-0000-4000-8000-0000000000aa', status: 'ok', resource_version: 4, resource_id: W1 };

const profile = (overrides: Record<string, unknown> = {}) =>
  warningBody(W1, {
    status: 'EXPLANATION_REQUESTED',
    explanation: { id: 'e1', status: 'ACCEPTED', due_at: '2027-10-09T00:00:00.000Z', is_late: false },
    evidence: {
      snapshot_id: S40,
      as_of_date: '2027-10-12',
      cells: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', plan_pm_assigned_vnd: '1000000000000', plan_local_added_vnd: '0', disbursed_treasury_vnd: '220000000000', rate_pm_pct: '22.0000', rate_total_pct: '22.0000', rate_null_reason: null, treasury_coverage: 'COMPLETE' }],
    },
    history: [
      { event: 'OPENED', at: '2027-10-02T03:00:00.000Z', by: null, note: null },
      { event: 'ACKNOWLEDGED', at: '2027-10-03T03:00:00.000Z', by: 'm', note: 'The unit is on it.' },
      { event: 'EXPLANATION_REQUESTED', at: '2027-10-03T05:00:00.000Z', by: 'm', note: null },
      { event: 'EXPLANATION_RESPONDED', at: '2027-10-05T03:00:00.000Z', by: null, note: null },
    ],
    ...overrides,
  });
const page = (item: unknown) => ({ items: [item], next_cursor: null, as_of: '2027-10-15T03:00:00Z' });

function client(read: () => unknown, command: (operation: string, input: unknown) => unknown = () => OK): Harness {
  return harness((operation) => (operation === 'getHomeWarnings' ? read() : new Error(`unexpected read ${operation}`)), command);
}
const commands = (h: Harness): Array<[string, Record<string, unknown>]> => h.command.mock.calls.map((call) => [call[0] as string, call[1] as Record<string, unknown>]);

afterEach(cleanup);

describe('HOME-06 warning profile (ST-HOME-003, HOME 3 F4)', () => {
  it('AC-ST-HOME-003-2: UAT-AC271 shows the cause (the rule, the threshold, the 22% against the 45%), the evidence in the snapshot, the leader, the explanation and the history', async () => {
    mount(<WarningProfileScreen route={ROUTE} />, client(() => page(profile())), { permissions: ALL }, OPEN);
    const cause = await screen.findByTestId('profile-cause');
    expect(within(cause).getByTestId('profile-rule').textContent).toBe('EW-01 Tỷ lệ giải ngân thấp hơn kỳ vọng');
    expect(within(cause).getByTestId('profile-project').textContent).toBe('P-A-002 Cầu Bến Lức');
    expect(within(cause).getByTestId('profile-observed').textContent).toBe(fill(vi_['home.warnings.observed.text'], { observed: '22', expected: '45' }));
    expect(within(cause).getByTestId('profile-gap').textContent).toBe(fill(vi_['home.profile.cause.gap.value'], { gap: '23' }));
    expect(within(cause).getByTestId('profile-threshold').textContent).toContain('points 10');
    expect(within(cause).getByTestId('profile-threshold').getAttribute('title')).toContain('CXN-03');
    const evidence = screen.getByTestId('profile-evidence');
    expect(within(evidence).getByTestId('evidence-context').textContent).toBe(fill(vi_['home.profile.evidence.context'], { id: '00000000…00f2', date: '2027-10-12' }));
    expect(evidence.textContent).toContain('1.000.000.000.000');
    expect(evidence.textContent).toContain('22.0000%');
    expect(screen.getByTestId('profile-leader').textContent).toContain('Nguyễn Văn A');
    expect(screen.getByTestId('profile-explanation').textContent).toContain(fill(vi_['home.profile.explanation.status'], { status: vi_['home.explanation.status.accepted'], due: '2027-10-09' }));
    const history = within(screen.getByTestId('profile-history'));
    expect(history.getAllByRole('listitem').map((item) => item.getAttribute('data-event'))).toEqual(['OPENED', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'EXPLANATION_RESPONDED']);
    expect(history.getByText(/The unit is on it\./)).toBeTruthy();
  });

  it('asks for the explanation of the leader in charge through the command of PRJ, with the question and the day, and says it was sent', async () => {
    const user = userEvent.setup();
    const h = client(() => page(warningBody(W1, { status: 'OPEN' })));
    mount(<WarningProfileScreen route={ROUTE} />, h, { permissions: ALL }, OPEN);
    await user.click(await screen.findByRole('button', { name: vi_['home.profile.action.explain'] }));
    const confirm = screen.getByRole('button', { name: vi_['home.profile.confirm'] });
    // Not enough yet: a question of ten characters and a day are asked for.
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(vi_['home.profile.explain.question.label']), 'Why is it slow?');
    await user.type(screen.getByLabelText(vi_['home.profile.explain.due.label']), '2999-12-31');
    await user.click(confirm);
    await waitFor(() => expect(commands(h)).toHaveLength(1));
    expect(commands(h)[0]?.[0]).toBe('requestExplanation');
    expect(commands(h)[0]?.[1].body).toEqual({ subject_kind: 'PROJECT', project_id: P1, warning_id: W1, period_id: '00000000-0000-4000-8000-000000000c01', trigger_code: 'EW-01', question: 'Why is it slow?', requested_from_membership_id: LEADER, due_at: '2999-12-31T16:59:59.000Z' });
    expect((await screen.findByTestId('profile-done')).textContent).toBe(vi_['home.profile.done.explain']);
  });

  it('acknowledges and dismisses through the commands of DIS under the version the screen showed, with a reason of five characters at least', async () => {
    const user = userEvent.setup();
    const h = client(() => page(warningBody(W1, { status: 'OPEN', version: 7 })));
    mount(<WarningProfileScreen route={ROUTE} />, h, { permissions: ALL }, OPEN);
    await user.click(await screen.findByRole('button', { name: vi_['home.profile.action.acknowledge'] }));
    await user.type(screen.getByLabelText(vi_['home.profile.reason.label']), 'ok');
    expect((screen.getByRole('button', { name: vi_['home.profile.confirm'] }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(vi_['home.profile.reason.label']), ' the unit is on it');
    await user.click(screen.getByRole('button', { name: vi_['home.profile.confirm'] }));
    await waitFor(() => expect(commands(h)).toHaveLength(1));
    expect(commands(h)[0]).toEqual([expect.stringMatching('acknowledgeEarlyWarning'), expect.objectContaining({ path: { id: W1 }, body: { reason: 'ok the unit is on it' }, ifMatchVersion: 7 })]);
    expect((await screen.findByTestId('profile-done')).textContent).toBe(vi_['home.profile.done.acknowledge']);
    await user.click(screen.getByRole('button', { name: vi_['home.profile.action.dismiss'] }));
    await user.type(screen.getByLabelText(vi_['home.profile.reason.label']), 'not a slow project');
    await user.click(screen.getByRole('button', { name: vi_['home.profile.confirm'] }));
    await waitFor(() => expect(commands(h)).toHaveLength(2));
    expect(commands(h)[1]?.[0]).toBe('dismissEarlyWarning');
  });

  it('offers only what the reader holds the right for, and what the warning is in the state for', async () => {
    const readOnly = client(() => page(warningBody(W1, { status: 'OPEN' })));
    mount(<WarningProfileScreen route={ROUTE} />, readOnly, { permissions: ['home.read'] }, OPEN);
    await screen.findByTestId('warning-profile');
    expect(within(screen.getByTestId('profile-actions')).queryAllByRole('button')).toHaveLength(0);
    cleanup();
    // The right to handle warnings, not to ask for explanations.
    mount(<WarningProfileScreen route={ROUTE} />, client(() => page(warningBody(W1, { status: 'ACKNOWLEDGED' }))), { permissions: ['home.read', 'warning.handle'] }, OPEN);
    await screen.findByTestId('warning-profile');
    const names = within(screen.getByTestId('profile-actions')).getAllByRole('button').map((button) => button.textContent);
    expect(names).toEqual([vi_['home.profile.action.dismiss']]);
    cleanup();
    // A warning that was closed is not acted on again, and a read-only system takes nothing.
    mount(<WarningProfileScreen route={ROUTE} />, client(() => page(warningBody(W1, { status: 'RESOLVED' }))), { permissions: ALL }, OPEN);
    await screen.findByTestId('warning-profile');
    expect(within(screen.getByTestId('profile-actions')).queryAllByRole('button')).toHaveLength(0);
    cleanup();
    mount(<WarningProfileScreen route={ROUTE} />, client(() => page(warningBody(W1, { status: 'OPEN' }))), { permissions: ALL, mode: 'READ_ONLY' }, OPEN);
    await screen.findByTestId('warning-profile');
    expect(within(screen.getByTestId('profile-actions')).queryAllByRole('button')).toHaveLength(0);
  });

  it('says an explanation cannot be asked for when the project has no leader in charge, and does not offer the button', async () => {
    mount(<WarningProfileScreen route={ROUTE} />, client(() => page(warningBody(W1, { status: 'OPEN', leader: null }))), { permissions: ALL }, OPEN);
    await screen.findByTestId('warning-profile');
    expect(screen.getByText(vi_['home.profile.explain.noLeader'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['home.profile.action.explain'] })).toBeNull();
  });

  it('says the warning moved when its version is not the one the screen showed (409), reads it again, and keeps what was typed to try again', async () => {
    const user = userEvent.setup();
    let version = 3;
    const h = client(
      () => page(warningBody(W1, { status: 'OPEN', version })),
      () => {
        throw failure(409, 'VERSION_CONFLICT');
      },
    );
    h.command.mockImplementation(() => {
      version = 4;
      return Promise.reject(failure(409, 'VERSION_CONFLICT'));
    });
    mount(<WarningProfileScreen route={ROUTE} />, h, { permissions: ALL }, OPEN);
    await user.click(await screen.findByRole('button', { name: vi_['home.profile.action.acknowledge'] }));
    await user.type(screen.getByLabelText(vi_['home.profile.reason.label']), 'the unit is on it');
    await user.click(screen.getByRole('button', { name: vi_['home.profile.confirm'] }));
    expect((await screen.findByTestId('profile-problem')).textContent).toBe(vi_['home.profile.problem.conflict']);
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(1));
  });

  it('says what a refusal of the command was: the right, a state, a request that is not good', async () => {
    const user = userEvent.setup();
    for (const [error, text] of [
      [failure(403, 'SCOPE_DENIED'), vi_['home.profile.problem.denied']],
      [failure(409, 'WARNING_STATE_INVALID'), vi_['home.profile.problem.state']],
      [failure(422, 'VALIDATION_FAILED'), vi_['home.profile.problem.validation']],
      [failure(500, 'INTERNAL_ERROR'), vi_['home.profile.problem.general']],
    ] as const) {
      const h = client(() => page(warningBody(W1, { status: 'OPEN' })));
      h.command.mockImplementation(() => Promise.reject(error));
      mount(<WarningProfileScreen route={ROUTE} />, h, { permissions: ALL }, OPEN);
      await user.click(await screen.findByRole('button', { name: vi_['home.profile.action.dismiss'] }));
      await user.type(screen.getByLabelText(vi_['home.profile.reason.label']), 'not a slow project');
      await user.click(screen.getByRole('button', { name: vi_['home.profile.confirm'] }));
      expect((await screen.findByTestId('profile-problem')).textContent).toBe(text);
      cleanup();
    }
  });

  it('says there is no such warning in the scope (404) and shows nothing of it, and says nothing was chosen when the address names none', async () => {
    mount(<WarningProfileScreen route={ROUTE} />, client(() => failure(404, 'RESOURCE_NOT_FOUND')), { permissions: ALL }, OPEN);
    expect(await screen.findByTestId('profile-not-found')).toBeTruthy();
    expect(screen.queryByTestId('warning-profile')).toBeNull();
    cleanup();
    const h = client(() => page(profile()));
    mount(<WarningProfileScreen route={ROUTE} />, h, { permissions: ALL });
    expect(screen.getByTestId('profile-no-id')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  describe('the seven standard states', () => {
    it.each([
      ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
      ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
    ])('UI-HOME-06 shows the %s state', async (_name, error, title) => {
      mount(<WarningProfileScreen route={ROUTE} />, client(() => error), { permissions: ALL }, OPEN);
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-HOME-06 shows the loading state first, names the page, and retries after an error', async () => {
      mount(<WarningProfileScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: ALL }, OPEN);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['home.profile.page.title'] })).toBeTruthy();
      cleanup();
      let failing = true;
      mount(<WarningProfileScreen route={ROUTE} />, client(() => (failing ? failure(500, 'INTERNAL_ERROR') : page(profile()))), { permissions: ALL }, OPEN);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('warning-profile')).toBeTruthy();
    });
  });
});
