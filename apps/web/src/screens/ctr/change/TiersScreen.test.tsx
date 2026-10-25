import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import TiersScreen from './TiersScreen';
import { PROJECT, SECOND_PROJECT, chain, client, config, mount, requestId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-20', 'FR-CTR-20');
const PATH = `/ctr/ctr-20?project=${PROJECT}`;
const OK = { operation_id: 'o', status: 'CONFIGURED', resource_version: 1, resource_id: requestId(9) };
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<TiersScreen route={ROUTE} />, h, { permissions: ['change.read'], path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const choose = (count: number): void => {
  fireEvent.click(document.querySelector(`input[data-tiers="${count}"]`) as HTMLElement);
};
const radios = (): Array<{ count: string; checked: boolean; disabled: boolean }> =>
  Array.from(document.querySelectorAll('input[name="tier-count"]')).map((input) => ({ count: input.getAttribute('data-tiers') as string, checked: (input as HTMLInputElement).checked, disabled: (input as HTMLInputElement).closest('fieldset')?.disabled === true }));
const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['ctr.change.tiers.submit'] }));
};

describe('TiersScreen (CTR-20): the number of tiers of the chain of a project', () => {
  it('asks for a project when the address names none', async () => {
    const h = open(world(), { path: '/ctr/ctr-20' });
    await screen.findByRole('heading', { level: 2, name: vi_['ctr.change.pick.project.title'] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.change.tiers.page.title']);
    fireEvent.change(document.getElementById('change-project') as HTMLElement, { target: { value: SECOND_PROJECT } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getChangeChain', { path: { id: SECOND_PROJECT } }));
  });

  it('AC-ST-CTR-006-1, UAT-AC307: sets the tiers of a project that has none, as often as the owner likes before the first request', async () => {
    const state = world({ chain: chain({ config: undefined }) });
    const h = open(state);
    await screen.findByLabelText(vi_['ctr.change.tiers.form.title']);
    expect(radios()).toEqual([
      { count: '1', checked: false, disabled: false },
      { count: '2', checked: false, disabled: false },
      { count: '3', checked: false, disabled: false },
    ]);
    expect(screen.getByText(text('ctr.change.tiers.option', { count: 3, stages: 'ChangeEvent → PCO → CO' }))).toBeTruthy();
    expect(screen.getByText(text('ctr.change.tiers.option', { count: 1, stages: 'CO' }))).toBeTruthy();
    save();
    expect(screen.getByText(vi_['ctr.change.problem.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    choose(2);
    save();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('setChangeChainTiers', expect.objectContaining({ path: { id: PROJECT }, body: { tier_count: 2 } }));
    expect((await screen.findByTestId('done')).textContent).toBe(vi_['ctr.change.tiers.done.notice']);
    expect(screen.getByTestId('board-link').getAttribute('href')).toBe(`/ctr/ctr-19?project=${PROJECT}`);
  });

  it('starts from the tiers already set, and may set them again while they are not locked', async () => {
    const h = open(world({ chain: chain({ config: config({ tier_count: 3 }) }) }));
    await screen.findByLabelText(vi_['ctr.change.tiers.form.title']);
    expect(radios().find((radio) => radio.checked)?.count).toBe('3');
    expect(screen.queryByTestId('locked-notice')).toBeNull();
    choose(1);
    save();
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('setChangeChainTiers', expect.objectContaining({ body: { tier_count: 1 } })));
  });

  it('AC-ST-CTR-006-1, UAT-AC307: shows the tiers locked by the first request and offers no way to change them', async () => {
    const h = open(world({ chain: chain({ config: config({ tier_count: 3, locked: true, locked_at: '2026-10-24T01:00:00.000Z', locked_by_change: { id: requestId(1), code: 'CE-001' } }) }) }));
    await screen.findByLabelText(vi_['ctr.change.tiers.form.title']);
    expect((await screen.findByTestId('locked-notice')).textContent).toBe(text('ctr.change.tiers.locked.notice', { count: 3, code: 'CE-001' }));
    expect(radios()).toEqual([
      { count: '1', checked: false, disabled: true },
      { count: '2', checked: false, disabled: true },
      { count: '3', checked: true, disabled: true },
    ]);
    expect(screen.queryByRole('button', { name: vi_['ctr.change.tiers.submit'] })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('names the locking request by its id when it has no code, and by a dash when the lock names none', async () => {
    open(world({ chain: chain({ config: config({ locked: true, locked_by_change: { id: requestId(1), code: null } }) }) }));
    expect((await screen.findByTestId('locked-notice')).textContent).toBe(text('ctr.change.tiers.locked.notice', { count: 3, code: requestId(1) }));
    cleanup();
    open(world({ chain: chain({ config: config({ locked: true, locked_by_change: null }) }) }));
    expect((await screen.findByTestId('locked-notice')).textContent).toBe(text('ctr.change.tiers.locked.notice', { count: 3, code: vi_['ctr.change.none.text'] }));
  });

  it('shows the policy to someone who may only read it, and in a read-only session', async () => {
    open(world({ chain: chain({ actions: { configure: false, open: false } }) }));
    expect((await screen.findByTestId('no-command')).textContent).toBe(vi_['ctr.change.tiers.readOnly.notice']);
    expect(radios().every((radio) => radio.disabled)).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['ctr.change.tiers.submit'] })).toBeNull();
    cleanup();
    open(world(), { mode: 'READ_ONLY' });
    await screen.findByLabelText(vi_['ctr.change.tiers.form.title']);
    expect(radios().every((radio) => radio.disabled)).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['ctr.change.tiers.submit'] })).toBeNull();
  });

  it('shows the refusal of the server in words', async () => {
    for (const [error, expected] of [
      [problem('CHANGE_TIERS_LOCKED', 409, { tier_count: 3 }), vi_['ctr.change.error.tiersLocked']],
      [problem('VALIDATION_FAILED', 422), vi_['ctr.change.error.validation']],
      [problem('SCOPE_DENIED', 403), vi_['ctr.change.error.denied']],
      [problem('RESOURCE_NOT_FOUND', 404), vi_['ctr.change.error.notFound']],
    ] as const) {
      open(world({ chain: chain({ config: undefined }) }), { command: () => error });
      await screen.findByLabelText(vi_['ctr.change.tiers.form.title']);
      choose(3);
      save();
      expect((await screen.findByTestId('refusal')).textContent).toBe(expected);
      expect(screen.queryByTestId('done')).toBeNull();
      cleanup();
    }
  });

  it('answers a failed read with the error state', async () => {
    open(world({ failing: new Set(['getChangeChain']) }));
    expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
  });
});
