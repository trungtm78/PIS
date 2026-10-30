import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../not/delivery/test-support';
import RoutingPolicyScreen from './RoutingPolicyScreen';
import { describeProblem, policyBody, policyProblems, reasonProblem, toPolicy, toPolicyPage, toUnit } from './policy/model';

const SUPERVISOR = ['omni.policy.manage'];
const NOBODY = ['notification.self'];
const reason = 'The policy of the month was agreed with the supervisors.';
const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail });

const policy = (overrides: Record<string, unknown> = {}) => ({
  id: 'policy-1',
  revision: 2,
  status: 'Published',
  rules: [{ channels: ['WHATSAPP'], keywords: ['khieu nai'], queue_unit_id: 'unit-1', priority: 'HIGH' }, { queue_unit_id: 'unit-2' }],
  calendar_code: 'VN-STD',
  first_response_minutes: 30,
  resolution_hours: 24,
  published_at: '2026-10-30T03:00:00Z',
  version: 2,
  ...overrides,
});
const UNITS = [{ id: 'unit-1', name: 'Phòng Tiếp dân' }, { id: 'unit-2', name: 'Phòng Dự án' }];
const page = (items: unknown[], next: string | null = null, units: unknown[] = UNITS) => ({ items, next_cursor: next, units, as_of: '2026-10-30T03:00:00Z' });

afterEach(cleanup);

interface Answers {
  list?: (input: unknown) => unknown;
  command?: (operation: string, input: unknown) => unknown;
  mode?: 'READ_ONLY';
}

function open(permissions: readonly string[], answers: Answers = {}) {
  const h = harness((operation, input) => (operation === 'listRoutingPolicies' ? (answers.list ?? (() => page([policy(), policy({ id: 'policy-0', revision: 1, status: 'Superseded', version: 3 }), policy({ id: 'policy-3', revision: 3, status: 'Draft', rules: [], version: 1 })])))(input) : new Error(`unexpected read ${operation}`)), answers.command ?? (() => ({})));
  return { h, ...mount(<RoutingPolicyScreen route={routeOf('OMNI-07', 'FR-OMNI-07')} />, h, { permissions, ...(answers.mode === undefined ? {} : { mode: answers.mode }) }) };
}
const row = async (id: string): Promise<HTMLElement> =>
  (await waitFor(() => {
    const found = document.querySelector(`[data-policy-id="${id}"]`) as HTMLElement | null;
    if (found === null) throw new Error('not yet');
    return found;
  })) as HTMLElement;

describe('OMNI-07 assignment and SLA (UI-OMNI-07)', () => {
  it('AC-ST-OMNI-006-2 UI-OMNI-07: shows each version with its state, rules, minutes of the first answer, hours of the resolution and calendar', async () => {
    const { h } = open(SUPERVISOR);
    const published = await row('policy-1');
    expect(published.querySelector('[data-policy-status]')?.textContent).toBe(vi_['omni.policy.status.published']);
    expect(published.querySelector('[data-first]')?.textContent).toBe('30');
    expect(published.querySelector('[data-resolution]')?.textContent).toBe('24');
    expect(published.textContent).toContain('VN-STD');
    const rules = [...published.querySelectorAll('[data-rule]')].map((item) => item.textContent);
    // The units are shown by name, the priority in words, and a rule without a channel is for any.
    await waitFor(() => expect(published.querySelectorAll('[data-rule]')[0]?.textContent).toContain('Phòng Tiếp dân'));
    expect(published.querySelectorAll('[data-rule]')[0]?.textContent).toContain(`${vi_['omni.policy.channel.whatsapp']} · khieu nai`);
    // The queues are named by the units that came with the policies, with no other read.
    expect(h.read.mock.calls.every((call) => call[0] === 'listRoutingPolicies')).toBe(true);
    expect(published.querySelectorAll('[data-rule]')[0]?.textContent).toContain(vi_['omni.policy.priority.high']);
    expect(published.querySelectorAll('[data-rule]')[1]?.textContent).toContain(vi_['omni.policy.rule.anyChannel']);
    expect(rules).toHaveLength(2);
    expect((await row('policy-3')).textContent).toContain(vi_['omni.policy.rules.none']);
    expect((await row('policy-0')).getAttribute('data-status')).toBe('Superseded');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['omni.policy.page.title']);
    // Only a draft can be published.
    expect(within(published).queryByRole('button')).toBeNull();
    expect(within(await row('policy-3')).getByRole('button', { name: vi_['omni.policy.publish.aria'].replace('{revision}', '3') })).toBeTruthy();
  });

  it('shows the seven states: loading, denied, signed out, offline, error and empty', async () => {
    const loading = open(SUPERVISOR);
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    for (const [error, title] of [
      [problem('SCOPE_DENIED', 403), vi_['states.denied.title']],
      [problem('SESSION_EXPIRED', 401), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [problem('INTERNAL_ERROR', 500), vi_['states.error.title']],
    ] as const) {
      open(SUPERVISOR, { list: () => error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const { h } = open(NOBODY);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open(SUPERVISOR, { list: () => page([]) });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('reads the next page of the versions with the cursor of the last one, and the units are those of the first page', async () => {
    const { h } = open(SUPERVISOR, { list: (input) => ((input as { query: { cursor?: string } }).query.cursor === undefined ? page([policy()], 'next-1') : page([policy({ id: 'policy-9', revision: 1, status: 'Superseded' })], null, [])) });
    await row('policy-1');
    fireEvent.click(await screen.findByRole('button', { name: vi_['omni.policy.more.action'] }));
    await row('policy-9');
    expect(h.read.mock.calls.at(-1)).toEqual(['listRoutingPolicies', { query: { cursor: 'next-1' } }]);
    expect(screen.queryByRole('button', { name: vi_['omni.policy.more.action'] })).toBeNull();
    // The rule of the first page still shows the name of its unit.
    await waitFor(() => expect(document.querySelector('[data-policy-id="policy-1"] [data-rule]')?.textContent).toContain('Phòng Tiếp dân'));
  });

  it('publishes a draft with a reason, at the version read, asking for the reason before it sends anything', async () => {
    const { h } = open(SUPERVISOR, { command: () => ({ operation_id: 'o', status: 'PUBLISHED', resource_version: 2, resource_id: 'policy-3' }) });
    fireEvent.click(within(await row('policy-3')).getByRole('button', { name: vi_['omni.policy.publish.aria'].replace('{revision}', '3') }));
    const form = (await screen.findByRole('form', { name: vi_['omni.policy.publish.form.aria'].replace('{revision}', '3') })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.policy.publish.confirm.action'] }));
    expect(within(form).getByText(vi_['omni.policy.publish.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.policy.publish.reason.label']), { target: { value: `  ${reason}  ` } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.policy.publish.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['publishRoutingPolicy', expect.objectContaining({ path: { policyId: 'policy-3' }, body: { reason }, ifMatchVersion: 1 })]);
    expect(await screen.findByText(vi_['omni.policy.done.published'].replace('{revision}', '3'))).toBeTruthy();
  });

  it('says in words why the publication was refused: calendar, state, conflict, denied, gone, and keeps the reason typed', async () => {
    for (const [error, key] of [
      [problem('POLICY_INVALID', 422, 'calendar_code'), 'omni.policy.problem.calendar'],
      [problem('POLICY_STATE_INVALID', 409), 'omni.policy.problem.state'],
      [problem('VERSION_CONFLICT', 409), 'omni.policy.problem.conflict'],
      [problem('SCOPE_DENIED', 403), 'omni.policy.problem.denied'],
      [problem('RESOURCE_NOT_FOUND', 404), 'omni.policy.problem.notFound'],
      [problem('SESSION_EXPIRED', 401), 'omni.policy.problem.session'],
      [problem('POLICY_INVALID', 422, 'rules'), 'omni.policy.problem.invalid'],
      [problem('INTERNAL_ERROR', 500), 'omni.policy.problem.general'],
    ] as const) {
      open(SUPERVISOR, { command: () => error });
      fireEvent.click(within(await row('policy-3')).getByRole('button', { name: vi_['omni.policy.publish.aria'].replace('{revision}', '3') }));
      const form = (await screen.findByRole('form', { name: vi_['omni.policy.publish.form.aria'].replace('{revision}', '3') })) as HTMLElement;
      fireEvent.change(within(form).getByLabelText(vi_['omni.policy.publish.reason.label']), { target: { value: reason } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['omni.policy.publish.confirm.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      expect((within(form).getByLabelText(vi_['omni.policy.publish.reason.label']) as HTMLTextAreaElement).value).toBe(reason);
      cleanup();
    }
  });

  it('writes a draft: the calendar, the minutes, the hours and rules with a channel, words, a unit and a priority', async () => {
    const { h } = open(SUPERVISOR, { command: () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'policy-9' }) });
    const form = (await screen.findByRole('form', { name: vi_['omni.policy.form.aria'] })) as HTMLElement;
    await waitFor(() => expect(within(form).queryByText('Phòng Tiếp dân')).toBeNull());
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.policy.rule.add.action'] }));
    const rule = await waitFor(() => {
      const found = form.querySelector('[data-rule-form="0"]') as HTMLElement | null;
      if (found === null) throw new Error('not yet');
      return found;
    });
    await waitFor(() => expect((within(rule).getByLabelText(vi_['omni.policy.rule.unit.label']) as HTMLSelectElement).options.length).toBe(3));
    // Nothing is sent while a rule has no unit and the calendar is not named.
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.policy.form.submit.action'] }));
    for (const message of [vi_['omni.policy.form.calendar.invalid'], vi_['omni.policy.rule.unit.invalid']]) expect(within(form).getByText(message)).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.policy.form.calendar.label']), { target: { value: ' VN-STD ' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.policy.form.first.label']), { target: { value: '45' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.policy.form.resolution.label']), { target: { value: '48' } });
    fireEvent.change(within(rule).getByLabelText(vi_['omni.policy.rule.channel.label']), { target: { value: 'WHATSAPP' } });
    fireEvent.change(within(rule).getByLabelText(vi_['omni.policy.rule.words.label']), { target: { value: 'khiếu nại, tố cáo ,' } });
    fireEvent.change(within(rule).getByLabelText(vi_['omni.policy.rule.unit.label']), { target: { value: 'unit-1' } });
    fireEvent.change(within(rule).getByLabelText(vi_['omni.policy.rule.priority.label']), { target: { value: 'HIGH' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.policy.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual([
      'createRoutingPolicyVersion',
      expect.objectContaining({ body: { rules: [{ channels: ['WHATSAPP'], keywords: ['khiếu nại', 'tố cáo'], queue_unit_id: 'unit-1', priority: 'HIGH' }], calendar_code: 'VN-STD', first_response_minutes: 45, resolution_hours: 48 } }),
    ]);
    expect(await screen.findByText(vi_['omni.policy.done.created'])).toBeTruthy();
    expect(form.querySelector('[data-rule-form]')).toBeNull();
  });

  it('removes a rule, refuses minutes and hours out of range before sending, and tells what the server refused', async () => {
    const { h } = open(SUPERVISOR, { command: () => problem('POLICY_INVALID', 422, 'rules') });
    const form = (await screen.findByRole('form', { name: vi_['omni.policy.form.aria'] })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.policy.rule.add.action'] }));
    fireEvent.click(await within(form).findByRole('button', { name: vi_['omni.policy.rule.remove.action'] }));
    expect(form.querySelector('[data-rule-form]')).toBeNull();
    fireEvent.change(within(form).getByLabelText(vi_['omni.policy.form.calendar.label']), { target: { value: 'VN-STD' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.policy.form.first.label']), { target: { value: '0' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.policy.form.resolution.label']), { target: { value: '2401' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.policy.form.submit.action'] }));
    expect(within(form).getByText(vi_['omni.policy.form.first.invalid'])).toBeTruthy();
    expect(within(form).getByText(vi_['omni.policy.form.resolution.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.policy.form.first.label']), { target: { value: '30' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.policy.form.resolution.label']), { target: { value: '24' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.policy.form.submit.action'] }));
    expect(await screen.findByText(vi_['omni.policy.problem.invalid'])).toBeTruthy();
  });

  it('offers nothing to write to one who may not manage, and nothing in a suspended tenant', async () => {
    open(SUPERVISOR, { mode: 'READ_ONLY' });
    await row('policy-3');
    expect(screen.queryByRole('form', { name: vi_['omni.policy.form.aria'] })).toBeNull();
    expect(within(await row('policy-3')).queryByRole('button')).toBeNull();
  });

  describe('the rules of the model', () => {
    it('reads a policy and a unit, and nothing from a record that is not one', () => {
      expect(toPolicy(policy({ published_at: null }))).toMatchObject({ id: 'policy-1', revision: 2, status: 'Published', calendarCode: 'VN-STD', firstResponseMinutes: 30, resolutionHours: 24, publishedAt: undefined, version: 2 });
      expect(toPolicy(policy())?.rules[1]).toEqual({ channels: [], keywords: [], queueUnitId: 'unit-2', priority: 'NORMAL' });
      expect(toPolicy(policy({ rules: [null, { queue_unit_id: 3 }, { queue_unit_id: 'u', priority: 'URGENT', channels: ['EMAIL', 3] }] }))?.rules).toEqual([{ channels: ['EMAIL'], keywords: [], queueUnitId: 'u', priority: 'NORMAL' }]);
      expect(toPolicy(policy({ rules: 'x' }))?.rules).toEqual([]);
      expect(toPolicy({ id: 'x', status: 'Weird' })).toBeUndefined();
      expect(toPolicy(null)).toBeUndefined();
      expect(toPolicy({ id: 'x', status: 'Draft' })).toMatchObject({ revision: 0, calendarCode: '', version: 0 });
      expect(toPolicyPage(page([policy(), { id: 'bad' }], 'n'))).toMatchObject({ items: [{ id: 'policy-1' }], nextCursor: 'n', units: UNITS });
      expect(toPolicyPage(page([], ''))).toMatchObject({ nextCursor: undefined });
      expect(toPolicyPage(page([], null, [{ id: 3 }, { id: 'u' }]))).toMatchObject({ units: [{ id: 'u', name: 'u' }] });
      expect(toPolicyPage(undefined)).toEqual({ items: [], nextCursor: undefined, units: [] });
      expect(toUnit({ id: 'u', name: 'Phòng' })).toEqual({ id: 'u', name: 'Phòng' });
      expect(toUnit({ id: 'u' })).toEqual({ id: 'u', name: 'u' });
      expect(toUnit({ name: 'x' })).toBeUndefined();
    });

    it('judges the form as the server does, builds the body and maps the refusals', () => {
      const good = { rules: [], calendarCode: 'VN-STD', firstResponseMinutes: '30', resolutionHours: '24' };
      expect(policyProblems(good)).toEqual([]);
      expect(policyProblems({ ...good, calendarCode: 'a b', firstResponseMinutes: '10081', resolutionHours: '0', rules: [{ channel: '', keywords: '', queueUnitId: '', priority: 'LOW' }] })).toEqual(['calendar', 'firstResponse', 'resolution', 'ruleUnit']);
      expect(policyProblems({ ...good, firstResponseMinutes: '1.5', resolutionHours: 'x' })).toEqual(['firstResponse', 'resolution']);
      expect(policyBody({ ...good, rules: [{ channel: '', keywords: ' ', queueUnitId: 'u', priority: 'LOW' }] })).toEqual({ rules: [{ queue_unit_id: 'u', priority: 'LOW' }], calendar_code: 'VN-STD', first_response_minutes: 30, resolution_hours: 24 });
      expect(reasonProblem('short')).toBe(true);
      expect(reasonProblem(reason)).toBe(false);
      expect(describeProblem(problem('POLICY_INVALID', 422, 'calendar_code'))).toEqual({ reason: 'calendar', field: 'calendar_code' });
      expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
      expect(describeProblem(problem('SOMETHING_NEW'))).toEqual({ reason: 'general', field: undefined });
    });
  });
});
