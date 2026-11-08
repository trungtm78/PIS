import { ApiError } from '@machvon/api-client';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as translate } from '../../i18n';
import ProfileScreen from './ProfileScreen';
import { READER, client, digestDto, failing, mount, profileDto, route, world } from './test-support';
import type { World } from './test-support';

const ROUTE = route('NOT-18', 'FR-NOT-18', 'NOT');
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, permissions: readonly string[] | undefined = READER) {
  const h = client(state);
  const view = mount(<ProfileScreen route={ROUTE} />, h, { permissions, path: '/not/not-18' });
  return { h, ...view };
}

const ownProfile = () =>
  profileDto({
    profile: { channels: { URGENT: ['IN_APP', 'PUSH', 'SMS'], ACTION: ['IN_APP', 'PUSH'], WATCH: ['IN_APP'] }, quiet: { from: '22:00', to: '06:00', weekends: false, time_zone: 'Asia/Ho_Chi_Minh' }, digest_enabled: true, digest_at: '08:00', push_min_severity: 'URGENT', push_cap_per_day: 3, group_same_root: false },
    effective: {
      channels: { URGENT: ['IN_APP', 'PUSH', 'SMS'], ACTION: ['IN_APP', 'PUSH'], WATCH: ['IN_APP'] },
      quiet: { from: '22:00', to: '06:00', weekends: false, time_zone: 'Asia/Ho_Chi_Minh' },
      digest_enabled: true,
      digest_at: '08:00',
      push_min_severity: 'URGENT',
      push_cap_per_day: 3,
      group_same_root: false,
      own: { channels: true, quiet: true, digest_at: true, push_min_severity: true, push_cap_per_day: true, group_same_root: true },
    },
    version: 4,
  });

describe('ProfileScreen (NOT-18): how I am reached about alerts', () => {
  it('shows a skeleton while it loads, then the form with the values of the policy for a person who saved none', async () => {
    const { h } = open(world());
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeInTheDocument();
    await screen.findByTestId('profile-form');
    expect(h.read).toHaveBeenCalledWith('getMyAlertProfile', {});
    expect(screen.getByTestId('channels-policy')).toBeChecked();
    expect(screen.getByTestId('quiet-policy')).toBeChecked();
    expect(screen.getByTestId('quiet-from')).toBeDisabled();
    expect(screen.getByTestId('cap')).toHaveValue(null);
    const effective = screen.getByRole('table', { name: text('alertgov.profile.effective.caption') });
    const whose = within(effective).getAllByText(text('alertgov.profile.whose.policy'));
    expect(whose.length).toBe(within(effective).getAllByRole('row').length - 1);
    expect(effective.textContent).toContain(text('alertgov.profile.effective.quiet.value', { from: '21:00', to: '06:30', zone: 'Asia/Ho_Chi_Minh' }));
  });

  it('shows what the person set as theirs and the rest as the policy\'s', async () => {
    open(world({ profile: ownProfile() }));
    await screen.findByTestId('profile-form');
    expect(screen.getByTestId('channels-policy')).not.toBeChecked();
    expect(screen.getByTestId('quiet-from')).toHaveValue('22:00');
    expect(screen.getByTestId('digest-at')).toHaveValue('08:00');
    expect(screen.getByTestId('push-min')).toHaveValue('URGENT');
    expect(screen.getByTestId('cap')).toHaveValue(3);
    expect(screen.getByTestId('group')).toHaveValue('false');
    expect(screen.getByTestId('channel-URGENT-SMS')).toBeChecked();
    const effective = screen.getByRole('table', { name: text('alertgov.profile.effective.caption') });
    expect(within(effective).getAllByText(text('alertgov.profile.whose.own')).length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the bell on and locked, and keeps push, SMS and Zalo off an item to be watched', async () => {
    open(world());
    await screen.findByTestId('profile-form');
    for (const severity of ['URGENT', 'ACTION', 'WATCH']) {
      expect(screen.getByTestId(`bell-${severity}`)).toBeChecked();
      expect(screen.getByTestId(`bell-${severity}`)).toBeDisabled();
    }
    for (const channel of ['PUSH', 'SMS', 'ZALO']) expect(screen.getByTestId(`channel-WATCH-${channel}`)).toBeDisabled();
    expect(screen.getByTestId('channel-WATCH-EMAIL')).not.toBeDisabled();
    expect(screen.getByTestId('channel-URGENT-ZALO')).not.toBeDisabled();
  });

  it('shows the numbers of the policy with its version and the label of a default nobody confirmed, and an "i" with the source', async () => {
    open(world());
    const numbers = await screen.findByTestId('policy-numbers');
    expect(numbers.textContent).toContain(text('alertgov.profile.policy.quiet', { from: '21:00', to: '06:30' }));
    expect(numbers.textContent).toContain(text('alertgov.profile.policy.cap', { count: 5 }));
    expect(numbers.textContent).toContain(text('alertgov.profile.policy.digest', { at: '07:30' }));
    expect(screen.getByTestId('rule-note').textContent).toContain(text('alertgov.rule.unverified.label'));
    await userEvent.click(screen.getByRole('button', { name: text('alertgov.info.open.label', { name: text('alertgov.profile.policy.title') }) }));
    expect((await screen.findByRole('dialog')).textContent).toContain('Research of the roadmap.');
  });

  it('previews the digest: each line with its consequence and where to act, what is stood in for, and says how many did not fit', async () => {
    open(world({ digest: digestDto({ omitted: 2 }) }));
    const card = await screen.findByTestId('digest');
    const overdue = within(card).getByTestId('section-OVERDUE');
    expect(overdue.textContent).toContain('The package cannot open the bidding.');
    expect(within(overdue).getByRole('link', { name: text('alertgov.profile.digest.act') })).toBeInTheDocument();
    const behalf = within(card).getByTestId('section-ON_BEHALF');
    expect(behalf.textContent).toContain(text('alertgov.profile.digest.onBehalf', { name: 'Le Thi Other' }));
    expect(behalf.textContent).toContain(text('alertgov.profile.digest.noConsequence'));
    expect(within(card).queryByTestId('section-DUE_SOON')).toBeNull();
    expect(card.textContent).toContain(text('alertgov.profile.digest.omitted', { count: 2 }));
  });

  it('says the digest is empty, partial when a source could not be read, and keeps the form when the digest fails', async () => {
    open(world({ digest: digestDto({ total: 0, sections: [], unavailable_sources: ['ISSUE'] }) }));
    expect(await screen.findByTestId('digest-empty')).toBeInTheDocument();
    expect(screen.getByTestId('digest-partial').textContent).toContain('ISSUE');
    cleanup();
    const broken = world({ failing: failing('getMyAlertDigest', new Error('boom')) });
    open(broken);
    await screen.findByTestId('profile-form');
    const retry = await screen.findByRole('button', { name: text('states.retry.action') });
    broken.failing.clear();
    await userEvent.click(retry);
    expect(await screen.findByTestId('digest')).toBeInTheDocument();
  });

  it('sends what is left on the policy as null, with the version that was read', async () => {
    const { h } = open(world());
    await screen.findByTestId('profile-form');
    await userEvent.selectOptions(screen.getByTestId('push-min'), 'URGENT');
    await userEvent.type(screen.getByTestId('cap'), '3');
    await userEvent.click(screen.getByTestId('save'));
    expect(await screen.findByTestId('saved')).toBeInTheDocument();
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown>; ifMatchVersion: number }];
    expect(operation).toBe('updateMyAlertProfile');
    expect(input.ifMatchVersion).toBe(0);
    expect(input.body).toEqual({ channels: null, quiet: null, digest_enabled: true, digest_at: null, push_min_severity: 'URGENT', push_cap_per_day: 3, group_same_root: null });
  });

  it('sends the chosen channels with the bell always in them, the quiet hours and the digest hour', async () => {
    const { h } = open(world());
    await screen.findByTestId('profile-form');
    await userEvent.click(screen.getByTestId('channel-URGENT-SMS'));
    expect(screen.getByTestId('channels-policy')).not.toBeChecked();
    await userEvent.click(screen.getByTestId('quiet-policy'));
    await userEvent.clear(screen.getByTestId('quiet-from'));
    await userEvent.type(screen.getByTestId('quiet-from'), '22:00');
    await userEvent.click(screen.getByTestId('quiet-weekends'));
    await userEvent.type(screen.getByTestId('digest-at'), '08:00');
    await userEvent.selectOptions(screen.getByTestId('group'), 'false');
    await userEvent.click(screen.getByTestId('save'));
    await screen.findByTestId('saved');
    const body = (h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body;
    expect(body.channels).toEqual({ URGENT: ['IN_APP', 'PUSH', 'SMS'], ACTION: ['IN_APP', 'PUSH'], WATCH: ['IN_APP'] });
    expect(body.quiet).toEqual({ from: '22:00', to: '06:30', weekends: false, time_zone: 'Asia/Ho_Chi_Minh' });
    expect(body.digest_at).toBe('08:00');
    expect(body.group_same_root).toBe(false);
  });

  it('does not send a cap above the policy or one that is not a number, and says the limit', async () => {
    const { h } = open(world());
    await screen.findByTestId('profile-form');
    await userEvent.type(screen.getByTestId('cap'), '9');
    await userEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('cap-error')).textContent).toBe(text('alertgov.profile.push.capError', { max: 5 }));
    expect(h.command).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByTestId('cap'));
    await userEvent.type(screen.getByTestId('cap'), '5');
    await userEvent.click(screen.getByTestId('save'));
    await screen.findByTestId('saved');
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('locks the save button while the command runs', async () => {
    const { h } = open(world());
    await screen.findByTestId('profile-form');
    let release: (value: unknown) => void = () => undefined;
    h.command.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await userEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(screen.getByTestId('save')).toBeDisabled());
    expect(screen.getByTestId('save').textContent).toBe(text('alertgov.profile.save.pending'));
    await userEvent.click(screen.getByTestId('save'));
    expect(h.command).toHaveBeenCalledTimes(1);
    await act(async () => release({ operation_id: 'o', status: 'Updated', resource_version: 1 }));
    expect(await screen.findByTestId('saved')).toBeInTheDocument();
  });

  it('names each field a refusal (422) is about, and offers to reload after a conflict (409)', async () => {
    const { h } = open(world());
    await screen.findByTestId('profile-form');
    h.command.mockRejectedValueOnce(
      new ApiError({ status: 422, code: 'ALERT_PROFILE_INVALID', correlationId: 'c', extensions: { defects: [{ field: 'push_cap_per_day', code: 'ABOVE_POLICY' }, { field: 'quiet.to', code: 'SAME_TIME' }] } }),
    );
    await userEvent.click(screen.getByTestId('save'));
    const error = await screen.findByTestId('save-error');
    expect(error.textContent).toContain(text('alertgov.problem.invalid.text'));
    const defects = within(error).getByTestId('defects');
    expect(defects.textContent).toContain('push_cap_per_day');
    expect(defects.textContent).toContain(text('alertgov.defect.abovePolicy'));
    expect(defects.textContent).toContain(text('alertgov.defect.sameTime'));
    h.command.mockRejectedValueOnce(new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }));
    await userEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain(text('alertgov.problem.conflict.text')));
    const before = h.read.mock.calls.filter(([operation]) => operation === 'getMyAlertProfile').length;
    await userEvent.click(screen.getByTestId('reload'));
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getMyAlertProfile').length).toBe(before + 1));
  });

  it('shows an error with a retry, keeps the last profile when a refresh fails, and is denied without the right to read', async () => {
    const broken = world({ failing: failing('getMyAlertProfile', new Error('boom')) });
    open(broken);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    broken.failing.clear();
    await userEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    await screen.findByTestId('profile-form');
    cleanup();
    const state = world();
    const { queries } = open(state);
    await screen.findByTestId('profile-form');
    state.failing = failing('getMyAlertProfile', new Error('boom'));
    await queries.refetchQueries();
    expect(await screen.findByTestId('stale')).toBeInTheDocument();
    expect(screen.getByTestId('profile-form')).toBeInTheDocument();
    cleanup();
    const { h } = open(world(), []);
    expect(await screen.findByText(text('states.denied.title'))).toBeInTheDocument();
    expect(h.read).not.toHaveBeenCalled();
  });
});
