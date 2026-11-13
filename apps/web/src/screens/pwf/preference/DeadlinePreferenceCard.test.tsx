import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { ALL_PERMISSIONS, READ_ONLY, refusal, serve, text } from '../test/fixtures';
import type { Answer } from '../test/fixtures';
import { mountAs } from '../templates/test/mount';
import { DeadlinePreferenceCard } from './DeadlinePreferenceCard';
import { personalPreview, preferenceBody, savedBody } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Setup {
  permissions?: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  preference?: Answer;
  commands?: Record<string, Answer>;
  fullLink?: string;
}

const open = (setup: Setup = {}) => {
  const h = serve({ getDeadlinePreference: setup.preference ?? preferenceBody(), previewDeadlineBand: personalPreview() }, { setDeadlinePreference: { operation_id: 'op', status: 'Updated', resource_version: 4 }, ...setup.commands });
  const view = mountAs(<DeadlinePreferenceCard {...(setup.fullLink === undefined ? {} : { fullLink: setup.fullLink })} />, h, { permissions: 'permissions' in setup ? setup.permissions : ALL_PERMISSIONS, ...(setup.mode === undefined ? {} : { mode: setup.mode }), path: '/m/settings' });
  return { h, view };
};

const field = (path: string) => screen.getByTestId(`field-${path}`) as HTMLInputElement;
const change = (path: string, value: string) => fireEvent.change(field(path), { target: { value } });

describe('the personal reminders card', () => {
  it('shows the levels with the official one beside each and the owner sentence, with no preview table and no list of tasks', async () => {
    const { h } = open({ preference: savedBody() });
    await screen.findByTestId('deadline-form');
    expect(screen.getByText(text('pwf.pref.card.title'))).toBeTruthy();
    expect(field('green_days').value).toBe('7');
    expect(screen.getByTestId('hint-green_days').textContent).toBe('chính thức: 5');
    expect(screen.getByTestId('sentence-personal').textContent).toBe('Còn 7 ngày làm việc: xanh, còn 3 ngày làm việc: vàng, dưới 2 ngày làm việc: đỏ');
    expect(screen.queryByTestId('preview')).toBeNull();
    expect(screen.queryByTestId('my-tasks')).toBeNull();
    expect(h.read.mock.calls.map((call) => call[0])).toEqual(['getDeadlinePreference']);
    expect(screen.queryByTestId('link-full')).toBeNull();
  });

  it('is touch friendly: the buttons are 44 pixel targets', async () => {
    open();
    await screen.findByTestId('deadline-form');
    expect(screen.getByRole('button', { name: text('pwf.pref.save.action') }).className).toContain('pwa-touch');
    expect(screen.getByRole('button', { name: text('pwf.pref.clear.action') }).className).toContain('pwa-touch');
  });

  it('links to the full screen when it is given the address', async () => {
    open({ fullLink: '/pwf/pwf-15' });
    await screen.findByTestId('deadline-form');
    expect(screen.getByTestId('link-full').getAttribute('href')).toBe('/pwf/pwf-15');
  });

  it('checks a level before saving, then saves under the version it read and says so', async () => {
    const { h } = open({ preference: savedBody() });
    await screen.findByTestId('deadline-form');
    change('yellow_days', '1');
    expect(screen.getByTestId('error-yellow_days').textContent).toContain('chính thức');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    expect(h.command).not.toHaveBeenCalled();
    change('yellow_days', '4');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 3, body: { green_days: 7, yellow_days: 4, red_days: 1, reminder_days: [7, 3, 1] } });
    expect((await screen.findByTestId('notice')).textContent).toBe(text('pwf.pref.saved.text'));
  });

  it('goes back to the official levels with one button', async () => {
    const { h } = open({ preference: savedBody() });
    await screen.findByTestId('deadline-form');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.clear.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 3, body: { green_days: null, yellow_days: null, red_days: null, reminder_days: [] } });
  });

  it('says somebody changed it first and offers the newer version', async () => {
    open({ preference: savedBody(), commands: { setDeadlinePreference: refusal('VERSION_CONFLICT', 409) } });
    await screen.findByTestId('deadline-form');
    change('green_days', '9');
    fireEvent.click(screen.getByRole('button', { name: text('pwf.pref.save.action') }));
    expect((await screen.findByTestId('refusal')).dataset.kind).toBe('conflict');
    expect(screen.getByRole('button', { name: text('pwf.pref.reload.action') })).toBeTruthy();
  });

  it('says a level was raised to the official level, and says nothing was set for a person who set nothing', async () => {
    open({ preference: savedBody({ clamped: ['green_days'] }) });
    await screen.findByTestId('clamped');
    cleanup();
    open();
    expect(await screen.findByTestId('no-setting')).toBeTruthy();
  });

  it('shows the setting but changes nothing in a read-only session', async () => {
    open({ mode: 'READ_ONLY', preference: savedBody() });
    await screen.findByTestId('read-only');
    expect(field('green_days').disabled).toBe(true);
    expect((screen.getByRole('button', { name: text('pwf.pref.save.action') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a loading state, then a failure with a retry that reads again', async () => {
    let calls = 0;
    const { h } = open({ preference: () => (calls++ === 0 ? refusal('INTERNAL_ERROR', 500) : preferenceBody()) });
    expect(screen.getByTestId('card-loading')).toBeTruthy();
    expect(await screen.findByTestId('card-failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    await screen.findByTestId('deadline-form');
    expect(h.read.mock.calls.filter((call) => call[0] === 'getDeadlinePreference')).toHaveLength(2);
  });

  it('shows nothing, and reads nothing, to a person who may not set reminders of their own', () => {
    const { h, view } = open({ permissions: READ_ONLY });
    expect(view.container.textContent).toBe('');
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows nothing when the server refuses the read for the scope', async () => {
    const { h, view } = open({ preference: refusal('SCOPE_DENIED', 403) });
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    await waitFor(() => expect(view.container.textContent).toBe(''));
  });

  it('shows the card when the session does not say what is held (the server decides)', async () => {
    open({ permissions: undefined });
    await screen.findByTestId('deadline-form');
  });
});

describe('the personal reminders card: accessibility (WCAG 2.2 AA)', () => {
  it('has no serious violation loading, set, with a problem, read-only and failed', async () => {
    const loading = open();
    expect(describeViolations(await seriousViolations(loading.view.container))).toEqual([]);
    await screen.findByTestId('deadline-form');
    change('yellow_days', '1');
    expect(describeViolations(await seriousViolations(loading.view.container))).toEqual([]);
    cleanup();
    const readOnly = open({ mode: 'READ_ONLY', preference: savedBody({ clamped: ['red_days'] }) });
    await screen.findByTestId('read-only');
    expect(describeViolations(await seriousViolations(readOnly.view.container))).toEqual([]);
    cleanup();
    const failed = open({ preference: refusal('INTERNAL_ERROR', 500) });
    await screen.findByTestId('card-failed');
    expect(describeViolations(await seriousViolations(failed.view.container))).toEqual([]);
  });
});
